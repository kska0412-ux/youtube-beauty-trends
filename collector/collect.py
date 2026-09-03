#!/usr/bin/env python3
"""
YouTube Data API v3 で美容系の「伸びている動画」を集め、docs/data/videos.json に書き出す。

使い方:
  python3 collector/collect.py              # 本番。環境変数 YOUTUBE_API_KEY が要る
  python3 collector/collect.py --mock       # APIキー無しでサンプルデータを生成（画面確認用）
  python3 collector/collect.py --limit 3    # 最初の3キーワードだけ試す（クォータ節約）

保存先を docs/ の下にしている理由:
  GitHub Pages を「docs フォルダ」で公開すると、配信されるのは docs/ の中身だけになる。
  リポジトリ直下の data/ に置くと画面から fetch できないので、docs/data/ に置く。

クォータ:
  1日10,000ユニット。search.list が1回100ユニットで、ここが支配的。
  検索は1日 MAX_SEARCH_CALLS 回までに抑え、超える語は翌日以降に回す。
"""

import argparse
import json
import os
import random
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from scoring import build_score  # noqa: E402

JST = timezone(timedelta(hours=9))

BASE_DIR = Path(__file__).resolve().parent.parent
KEYWORDS_FILE = BASE_DIR / "collector" / "keywords.yml"
DATA_DIR = BASE_DIR / "docs" / "data"
VIDEOS_FILE = DATA_DIR / "videos.json"
HISTORY_DIR = DATA_DIR / "history"

# 検索対象にする公開日の範囲。これより古い動画は「今のトレンド」ではないので拾わない。
PUBLISHED_WITHIN_DAYS = 90

# 1日に投げる search.list の上限。100ユニット × 60回 = 6,000ユニットで、
# 1日上限10,000に対して余裕を残す。
MAX_SEARCH_CALLS = 60

# API の消費ユニット（公式の定義値）
UNIT_SEARCH = 100
UNIT_LIST = 1

# 1回の検索で受け取る件数の上限（API の最大値）
SEARCH_PAGE_SIZE = 50

# 検索結果の並べ方。
#
# 当初は viewCount（再生数順）にしていたが、実測で問題が出た。
# 再生数順だと、世界共通の言葉のジャンルで英語圏の巨大チャンネルが50枠を
# 占め切ってしまう。2026-09-03 の実測では「ピラティス」の50件中、日本語は
# たった3件で、打ち切り位置が21.7万回だった（日本語の動画は大量にあるのに
# 再生数で負けて1本も届かない）。100ユニット払って3件しか使えていない状態。
#
# relevance（関連度順）にすると、再生数ではなく語との関連で選ばれるので、
# 日本語の動画が届きやすくなる。「伸びている動画」の判定は取得後に
# velocity / acceleration で行うので、取得段階を再生数順にする必要はない。
SEARCH_ORDER = "relevance"

# videos.list / channels.list は1回に50件までまとめられる
BATCH_SIZE = 50

# この秒数以下の動画はショートとみなして収集しない。
#
# YouTube API に「これはショート」という項目は無いので、長さで推定するしかない。
# YouTube は2024年10月からショートを最長3分まで許しているため、60秒で切っても
# 61〜180秒のショートは残る。ただし実測（2026-09-03・1,053件）では、その帯に
# 「白髪手術」などの本物のサロンワーク動画も入っていた。普通の動画を誤って
# 捨てる方が損なので、確実にショートと言える60秒で線を引いている。
#
# もっと厳しく落としたいときは 180 にする。実測での残り件数は次のとおり。
#   60秒で切る … 1,053件 → 604件
#   180秒で切る … 1,053件 → 359件
SHORT_MAX_SEC = 60

# history/ を残す日数。YouTube API の利用規約はデータの長期保持を制限しているため、
# 30日を超えたスナップショットは収集のたびに削除する。
HISTORY_KEEP_DAYS = 30


# --------------------------------------------------------------------------
# キーワード辞書の読み込み
# --------------------------------------------------------------------------

def load_keywords(path=KEYWORDS_FILE):
    """
    keywords.yml を読み、4つをまとめて返す。並びは YAML のとおり。

      genres       … {ジャンル名: [検索語, ...]}
      modifiers    … {掛け合わせ語: [組ませる主ジャンル名, ...]}
      required_any … {ジャンル名: [関連語, ...]}  … 1語も含まない動画は捨てる
      exclude      … [除外語, ...]                … 含んでいたら捨てる

    PyYAML が入っていればそれを使う。入っていない環境でも --mock を動かせるように、
    この辞書の形に限った簡易読み取りをフォールバックとして持っている。
    """
    text = path.read_text(encoding="utf-8")
    try:
        import yaml  # noqa: PLC0415
        raw = yaml.safe_load(text) or {}
    except ImportError:
        raw = _parse_simple_yaml(text)

    def section(name):
        result = {}
        for key, values in (raw.get(name) or {}).items():
            items = [str(v).strip() for v in (values or []) if str(v).strip()]
            if items:
                result[str(key)] = items
        return result

    # exclude は分類ごとに分けて書いてあるが、判定では一列にして使う
    excludes = [w for words in section("exclude").values() for w in words]
    return section("genres"), section("modifiers"), section("required_any"), excludes


def _parse_simple_yaml(text):
    """
    keywords.yml の形だけを読む簡易パーサ。PyYAML が無い環境用。

    読めるのは「トップレベルのキー → 2段目のキー → 箇条書き」の3階層だけ。
    インデントは半角空白2つ刻みを前提にする。
    """
    result = {}
    top = None
    second = None
    for line in text.splitlines():
        # 行内コメントを落とす（「#」の前に文字があってもコメントとして扱う）
        line = line.split("#", 1)[0].rstrip()
        if not line.strip():
            continue

        indent = len(line) - len(line.lstrip(" "))
        body = line.strip()

        if indent == 0 and body.endswith(":"):
            top = body[:-1].strip()
            result.setdefault(top, {})
            second = None
        elif indent == 2 and body.endswith(":") and top is not None:
            second = body[:-1].strip()
            result[top].setdefault(second, [])
        elif body.startswith("- ") and top is not None and second is not None:
            result[top][second].append(body[2:].strip())
    return result


def build_search_plan(genres, modifiers):
    """
    実際に投げる検索の一覧を作る。1件が1回の search.list に対応する。

    並びは「主ジャンルを全部 → 掛け合わせを全部」。ローテーションで
    途中までしか回らない日でも、主ジャンルが先に埋まるようにするため。

    掛け合わせは主ジャンルの1語目と組ませる（例:「エステティシャン 経営」）。
    単独で「経営」を検索すると飲食店や一般ビジネスの動画を拾うため、
    掛け合わせ語だけの検索は作らない。
    """
    plan = []
    for genre, words in genres.items():
        for word in words:
            plan.append({"genre": genre, "modifier": None, "query": word})

    for modifier, targets in modifiers.items():
        for genre in targets:
            if genre not in genres:
                # 辞書の書き間違い。黙って無視すると気付けないので知らせる
                print(f"警告: 掛け合わせ「{modifier}」が知らない主ジャンル「{genre}」を指しています")
                continue
            plan.append({
                "genre": genre,
                "modifier": modifier,
                "query": f"{genres[genre][0]} {modifier}",
            })
    return plan


def select_keywords(plan, max_calls=MAX_SEARCH_CALLS, now=None):
    """
    その日に検索する分を選ぶ。

    件数が上限以下ならそのまま全部。超える場合は、日付をもとに開始位置をずらして
    先頭から max_calls 件を取る。翌日は続きから始まるので、何日かかけて一周する。
    """
    total = len(plan)
    if total <= max_calls:
        return list(plan)

    now = now or datetime.now(JST)
    day_index = (now.date() - datetime(1970, 1, 1, tzinfo=JST).date()).days
    start = (day_index * max_calls) % total
    # 末尾を超えた分は先頭に回り込む
    return [plan[(start + i) % total] for i in range(max_calls)]


# --------------------------------------------------------------------------
# クォータ集計
# --------------------------------------------------------------------------

class QuotaTracker:
    """消費ユニットを数える。実行ログに出すのが目的。"""

    def __init__(self):
        self.units = 0
        self.search_calls = 0
        self.list_calls = 0

    def add_search(self):
        self.units += UNIT_SEARCH
        self.search_calls += 1

    def add_list(self):
        self.units += UNIT_LIST
        self.list_calls += 1

    def summary(self):
        return (
            f"消費ユニット概算: {self.units}  "
            f"(search.list {self.search_calls}回 × {UNIT_SEARCH} + "
            f"videos/channels.list {self.list_calls}回 × {UNIT_LIST})"
        )


class QuotaExceeded(Exception):
    """クォータを使い切ったときに投げる。集めた分は捨てずに保存する。"""


# --------------------------------------------------------------------------
# API 呼び出し
# --------------------------------------------------------------------------

def build_client(api_key):
    """YouTube API のクライアントを作る。--mock では呼ばれないので import もここで行う。"""
    from googleapiclient.discovery import build  # noqa: PLC0415
    return build("youtube", "v3", developerKey=api_key, cache_discovery=False)


_HTTP_ERROR = None


def http_error_class():
    """
    googleapiclient の HttpError を返す。

    本番では必ずライブラリが入っているので実物が返る。入っていない環境
    （テストでAPIを差し替えて流すとき）では、決して送出されないダミーの
    例外クラスを返して except 節だけを成立させる。
    """
    global _HTTP_ERROR
    if _HTTP_ERROR is None:
        try:
            from googleapiclient.errors import HttpError  # noqa: PLC0415
            _HTTP_ERROR = HttpError
        except ImportError:
            class _NeverRaised(Exception):
                pass
            _HTTP_ERROR = _NeverRaised
    return _HTTP_ERROR


def _is_quota_error(error):
    """HttpError がクォータ超過かどうか。403 かつ理由が quotaExceeded 系のもの。"""
    status = getattr(getattr(error, "resp", None), "status", None)
    if status != 403:
        return False
    body = getattr(error, "content", b"") or b""
    if isinstance(body, bytes):
        body = body.decode("utf-8", "replace")
    return "quotaExceeded" in body or "dailyLimitExceeded" in body


def search_video_ids(youtube, keyword, published_after, tracker):
    """1キーワードで検索し、videoId の一覧を返す。1キーワードにつき1ページだけ。"""
    HttpError = http_error_class()

    try:
        response = youtube.search().list(
            q=keyword,
            part="id",
            type="video",
            regionCode="JP",
            relevanceLanguage="ja",
            order=SEARCH_ORDER,
            publishedAfter=published_after,
            maxResults=SEARCH_PAGE_SIZE,
        ).execute()
    except HttpError as error:
        if _is_quota_error(error):
            raise QuotaExceeded(f"検索中にクォータ超過: {keyword}") from error
        raise
    finally:
        # 失敗した呼び出しもユニットを消費するので、例外の有無に関わらず数える
        tracker.add_search()

    ids = []
    for item in response.get("items", []):
        video_id = (item.get("id") or {}).get("videoId")
        if video_id:
            ids.append(video_id)
    return ids


def fetch_videos(youtube, video_ids, tracker):
    """videoId をまとめて詳細取得する。返り値は videoId をキーにした辞書。"""
    HttpError = http_error_class()

    result = {}
    for chunk in _chunks(video_ids, BATCH_SIZE):
        try:
            response = youtube.videos().list(
                part="snippet,statistics,contentDetails",
                id=",".join(chunk),
                maxResults=BATCH_SIZE,
            ).execute()
        except HttpError as error:
            if _is_quota_error(error):
                raise QuotaExceeded("動画詳細の取得中にクォータ超過") from error
            raise
        finally:
            tracker.add_list()

        for item in response.get("items", []):
            result[item["id"]] = item
    return result


def fetch_channels(youtube, channel_ids, tracker):
    """チャンネルの登録者数をまとめて取得する。同じチャンネルは1回しか問い合わせない。"""
    HttpError = http_error_class()

    result = {}
    for chunk in _chunks(sorted(set(channel_ids)), BATCH_SIZE):
        try:
            response = youtube.channels().list(
                part="statistics",
                id=",".join(chunk),
                maxResults=BATCH_SIZE,
            ).execute()
        except HttpError as error:
            if _is_quota_error(error):
                raise QuotaExceeded("チャンネル情報の取得中にクォータ超過") from error
            raise
        finally:
            tracker.add_list()

        for item in response.get("items", []):
            stats = item.get("statistics") or {}
            # 登録者数を非公開にしているチャンネルは値が返らない。0 として扱う。
            result[item["id"]] = _to_int(stats.get("subscriberCount"))
    return result


def _chunks(items, size):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _to_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


# --------------------------------------------------------------------------
# 変換
# --------------------------------------------------------------------------

DURATION_PATTERN = re.compile(
    r"^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$"
)


def parse_duration(value):
    """ISO8601 の長さ（PT1M30S など）を秒にする。読めなければ 0。"""
    if not value:
        return 0
    match = DURATION_PATTERN.match(str(value).strip())
    if not match:
        return 0
    days, hours, minutes, seconds = (int(g or 0) for g in match.groups())
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def build_record(video_id, item, subscriber_count, categories, modifiers, keywords,
                 collected_at):
    """API のレスポンス1件を videos.json の1件に変換する。"""
    snippet = item.get("snippet") or {}
    stats = item.get("statistics") or {}
    details = item.get("contentDetails") or {}

    duration_sec = parse_duration(details.get("duration"))
    thumbnails = snippet.get("thumbnails") or {}
    # 大きい順に、あるものを使う。medium は必ず返るが念のため段階を踏む。
    thumb = ""
    for key in ("medium", "high", "standard", "default"):
        if thumbnails.get(key, {}).get("url"):
            thumb = thumbnails[key]["url"]
            break

    return {
        "videoId": video_id,
        "title": snippet.get("title") or "",
        "channelId": snippet.get("channelId") or "",
        "channelTitle": snippet.get("channelTitle") or "",
        "subscriberCount": subscriber_count,
        "publishedAt": snippet.get("publishedAt") or "",
        # 言語の申告。ふるい分けに使うだけなので保存後は画面では使わない。
        "audioLanguage": snippet.get("defaultAudioLanguage")
        or snippet.get("defaultLanguage") or "",
        "durationSec": duration_sec,
        "thumbnail": thumb,
        "viewCount": _to_int(stats.get("viewCount")),
        "likeCount": _to_int(stats.get("likeCount")),
        "commentCount": _to_int(stats.get("commentCount")),
        "categories": sorted(categories),
        "modifiers": sorted(modifiers),
        "matchedKeywords": sorted(keywords),
        # score は前回スナップショットと突き合わせてから入れる
        "score": {"velocity": 0.0, "acceleration": None, "subRatio": 0.0},
        "collectedAt": collected_at,
    }


# --------------------------------------------------------------------------
# ふるい分け（海外・無関係の動画を落とす）
# --------------------------------------------------------------------------

# ひらがな・カタカナ・漢字。1文字でもあれば日本語の動画とみなす。
_JA_CHARS = re.compile(r"[ぁ-んァ-ヶー一-龯]")


def is_japanese(record):
    """
    日本語の動画かどうか。

    YouTube の relevanceLanguage=ja は「日本語を優先する」ヒントでしかなく、
    日本語の動画が少ない語では海外の動画がそのまま返ってくる。
    実測では拾った1,246件のうち157件（13%）が海外の動画だった。

    判定は2段構え。API が言語を申告していればそれを信じ、
    申告が無いときだけタイトルとチャンネル名の文字種で見る。
    """
    lang = (record.get("audioLanguage") or "").lower()
    if lang.startswith("ja"):
        return True
    if lang:
        # 日本語以外だと明示されている
        return False
    return bool(_JA_CHARS.search(record["title"] + record["channelTitle"]))


def is_relevant(record, required_any):
    """
    そのジャンルの語がタイトルかチャンネル名に1つでも入っているか。

    キーワードで引っかかっても中身が別物のことがあるため、関連語で裏を取る。
    required_any を持たないジャンルは素通しする。
    """
    haystack = record["title"] + " " + record["channelTitle"]
    for category in record["categories"]:
        words = required_any.get(category)
        if not words:
            return True
        if any(word in haystack for word in words):
            return True
    return False


def excluded_word(record, exclude):
    """除外語に当たっていればその語を返す。当たっていなければ None。"""
    haystack = record["title"] + " " + record["channelTitle"]
    for word in exclude:
        if word in haystack:
            return word
    return None


def is_short(record):
    """ショート動画とみなすか。長さでしか判定できない（SHORT_MAX_SEC の説明を参照）。"""
    duration = record.get("durationSec") or 0
    return 0 < duration <= SHORT_MAX_SEC


def apply_filters(videos, required_any, exclude):
    """ふるいをかけ、(残った動画, 落とした理由ごとの件数, 落とした例) を返す。"""
    kept = []
    dropped = {"ショート": 0, "海外": 0, "無関係": 0, "除外語": 0}
    examples = {"ショート": [], "海外": [], "無関係": [], "除外語": []}

    def note(reason, record, detail=""):
        dropped[reason] += 1
        if len(examples[reason]) < 5:
            examples[reason].append(f"{record['title'][:44]} | @{record['channelTitle'][:16]}{detail}")

    for record in videos:
        # ショートは最初に落とす。以降の判定を通す意味が無いので。
        if is_short(record):
            note("ショート", record, f" ←{record.get('durationSec')}秒")
            continue
        if not is_japanese(record):
            note("海外", record)
            continue
        word = excluded_word(record, exclude)
        if word:
            note("除外語", record, f" ←「{word}」")
            continue
        if not is_relevant(record, required_any):
            note("無関係", record)
            continue
        kept.append(record)
    return kept, dropped, examples


# --------------------------------------------------------------------------
# 履歴（前回値の参照・保存・掃除）
# --------------------------------------------------------------------------

def load_previous_snapshot(today_name):
    """
    直近の履歴ファイルから、videoId → 前回の再生数と収集時刻 を作る。

    今日の分は「前回」ではないので除く。履歴が無ければ空の辞書。
    """
    if not HISTORY_DIR.exists():
        return {}

    candidates = sorted(
        (p for p in HISTORY_DIR.glob("*.json") if p.name != today_name),
        reverse=True,
    )
    for path in candidates:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            # 壊れたファイルは飛ばして、その1つ前を見る
            continue
        previous = {}
        for video in payload.get("videos", []):
            video_id = video.get("videoId")
            if video_id:
                previous[video_id] = {
                    "viewCount": video.get("viewCount"),
                    "collectedAt": video.get("collectedAt") or payload.get("generatedAt"),
                }
        if previous:
            print(f"前回値の参照元: {path.name}（{len(previous)}件）")
            return previous
    return {}


def prune_history(now):
    """30日より古いスナップショットを消す。"""
    if not HISTORY_DIR.exists():
        return 0
    cutoff = (now - timedelta(days=HISTORY_KEEP_DAYS)).date()
    removed = 0
    for path in HISTORY_DIR.glob("*.json"):
        try:
            file_date = datetime.strptime(path.stem, "%Y-%m-%d").date()
        except ValueError:
            # 日付でない名前のファイルには触らない
            continue
        if file_date < cutoff:
            path.unlink()
            removed += 1
    return removed


def load_existing_videos():
    """既存の videos.json を読む。無い・壊れている場合は空。"""
    if not VIDEOS_FILE.exists():
        return []
    try:
        payload = json.loads(VIDEOS_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    return payload.get("videos", [])


def save(videos, categories, modifiers, tracker, now, is_mock=False):
    """videos.json と当日分の履歴を書き出す。"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)

    payload = {
        "generatedAt": now.isoformat(),
        "videoCount": len(videos),
        "quotaUsed": tracker.units,
        # サンプルデータを本物と取り違えないよう印を付ける。画面に注意書きが出る。
        "isMock": is_mock,
        "categories": categories,
        "modifiers": modifiers,
        "videos": videos,
    }
    text = json.dumps(payload, ensure_ascii=False, indent=1)
    VIDEOS_FILE.write_text(text + "\n", encoding="utf-8")
    (HISTORY_DIR / f"{now.date().isoformat()}.json").write_text(text + "\n", encoding="utf-8")


# --------------------------------------------------------------------------
# モックデータ
# --------------------------------------------------------------------------

MOCK_CHANNELS = [
    ("UCmock0000000000000001", "サロンオーナー美咲", 3200),
    ("UCmock0000000000000002", "エステ開業ラボ", 18400),
    ("UCmock0000000000000003", "美容クリニック公式", 412000),
    ("UCmock0000000000000004", "ネイリスト日記", 940),
    ("UCmock0000000000000005", "肌質改善チャンネル", 76500),
    ("UCmock0000000000000006", "全国ニュースネット", 1840000),
    ("UCmock0000000000000007", "まつげパーマ研究所", 5100),
    ("UCmock0000000000000008", "ヘッドスパ職人", 23800),
]

MOCK_TITLE_PARTS = [
    "初心者がやりがちな失敗3つ",
    "実際の施術を全部見せます",
    "開業1年目のリアルな売上",
    "自宅でできるセルフケア",
    "プロが使う道具を紹介",
    "お客様が離れる本当の理由",
    "料金設定の決め方",
    "予約が埋まらないときの打ち手",
]


def generate_mock(plan, now, seed=20260903):
    """
    APIキー無しで画面を確認するためのサンプルデータを作る。

    前回値が無いと加速度の列が全て空欄になり、並び替えの確認ができないので、
    履歴が1つも無い場合だけ3日前のスナップショットも一緒に作る。
    """
    rng = random.Random(seed)
    by_id = {}

    for index, entry in enumerate(plan):
        category, modifier, keyword = entry["genre"], entry["modifier"], entry["query"]
        for n in range(rng.randint(3, 6)):
            video_id = f"mock{index:02d}{n:02d}xxxx"
            channel_id, channel_title, subscribers = rng.choice(MOCK_CHANNELS)
            # 本番の検索は「90日以内に公開」で絞るので、モックも同じ範囲に収める
            age_days = rng.uniform(0.5, PUBLISHED_WITHIN_DAYS - 0.5)
            published = now - timedelta(days=age_days)
            # ショートは収集しないので、モックも61秒以上だけ作る
            duration = rng.choice([94, 132, 214, 486, 733, 1180])
            views = rng.randint(500, 400000)

            by_id[video_id] = {
                "videoId": video_id,
                "title": f"【{keyword}】{rng.choice(MOCK_TITLE_PARTS)}",
                "channelId": channel_id,
                "channelTitle": channel_title,
                "subscriberCount": subscribers,
                "publishedAt": published.isoformat(),
                "durationSec": duration,
                # 外部への通信を増やさないよう、サムネイルは空にしてダミー枠を出す
                "thumbnail": "",
                "viewCount": views,
                "likeCount": int(views * rng.uniform(0.01, 0.06)),
                "commentCount": int(views * rng.uniform(0.0005, 0.004)),
                "categories": [category],
                "modifiers": [modifier] if modifier else [],
                "matchedKeywords": [keyword],
                "score": {"velocity": 0.0, "acceleration": None, "subRatio": 0.0},
                "collectedAt": now.isoformat(),
            }

    # 同じ動画が複数の主ジャンル・掛け合わせで当たる状況も作っておく
    # （2段フィルタのANDが効いているか画面で確認するため）
    ids = sorted(by_id)
    for video_id in rng.sample(ids, k=min(20, len(ids))):
        extra = rng.choice(plan)
        record = by_id[video_id]
        record["categories"] = sorted(set(record["categories"]) | {extra["genre"]})
        record["matchedKeywords"] = sorted(set(record["matchedKeywords"]) | {extra["query"]})
        if extra["modifier"]:
            record["modifiers"] = sorted(set(record["modifiers"]) | {extra["modifier"]})

    videos = list(by_id.values())
    _seed_mock_history(videos, now, rng)
    return videos


def _seed_mock_history(videos, now, rng):
    """履歴が空のときだけ、3日前のスナップショットを作る（加速度の確認用）。"""
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    if any(HISTORY_DIR.glob("*.json")):
        return

    past = now - timedelta(days=3)
    past_videos = []
    for video in videos:
        # 3日前は今より再生数が少ない。伸び方に差を付けて加速度に幅を出す。
        past_views = int(video["viewCount"] * rng.uniform(0.35, 0.98))
        past_videos.append({
            "videoId": video["videoId"],
            "viewCount": past_views,
            "collectedAt": past.isoformat(),
        })

    payload = {
        "generatedAt": past.isoformat(),
        "videoCount": len(past_videos),
        "quotaUsed": 0,
        "categories": [],
        "videos": past_videos,
    }
    path = HISTORY_DIR / f"{past.date().isoformat()}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"モック用の前回スナップショットを作成: {path.name}")


# --------------------------------------------------------------------------
# 収集本体
# --------------------------------------------------------------------------

def collect(youtube, selected, now, tracker):
    """検索 → 詳細取得 → 登録者数取得 まで。途中でクォータが尽きたら集めた分を返す。"""
    published_after = (now - timedelta(days=PUBLISHED_WITHIN_DAYS)).astimezone(
        timezone.utc
    ).strftime("%Y-%m-%dT%H:%M:%SZ")

    # videoId → ヒットした主ジャンル・掛け合わせ語・検索語
    hits = {}
    # 検索語 → 返ってきた件数。0件の語を切り分けるために残す
    per_query = {}
    quota_hit = False

    for entry_plan in selected:
        query = entry_plan["query"]
        try:
            ids = search_video_ids(youtube, query, published_after, tracker)
        except QuotaExceeded as error:
            print(f"警告: {error}。ここまでの結果で保存します。")
            quota_hit = True
            break

        for video_id in ids:
            entry = hits.setdefault(
                video_id, {"categories": set(), "modifiers": set(), "keywords": set()})
            entry["categories"].add(entry_plan["genre"])
            entry["keywords"].add(query)
            if entry_plan["modifier"]:
                entry["modifiers"].add(entry_plan["modifier"])
        per_query[query] = len(ids)
        print(f"  {query}: {len(ids)}件" + ("   ← 0件" if not ids else ""))

    if not hits:
        return [], quota_hit, per_query

    collected_at = now.isoformat()
    try:
        details = fetch_videos(youtube, sorted(hits), tracker)
    except QuotaExceeded as error:
        print(f"警告: {error}。動画詳細が取れなかったため今回は保存を見送ります。")
        return [], True, per_query

    channel_ids = [
        (item.get("snippet") or {}).get("channelId", "") for item in details.values()
    ]
    try:
        subscribers = fetch_channels(youtube, [c for c in channel_ids if c], tracker)
    except QuotaExceeded as error:
        # 登録者数だけ欠けても他の指標は使えるので、0 埋めで続ける
        print(f"警告: {error}。登録者数は0として扱います。")
        subscribers = {}
        quota_hit = True

    videos = []
    for video_id, item in details.items():
        entry = hits[video_id]
        channel_id = (item.get("snippet") or {}).get("channelId", "")
        videos.append(build_record(
            video_id, item, subscribers.get(channel_id, 0),
            entry["categories"], entry["modifiers"], entry["keywords"], collected_at,
        ))
    return videos, quota_hit, per_query


def apply_scores(videos, previous, now):
    for video in videos:
        video["score"] = build_score(video, previous.get(video["videoId"]), now)


def report_coverage(videos, categories, modifier_names, per_query, plan):
    """
    カテゴリ別の件数と、0件だった検索語を出す。

    0件の原因を切り分けられるように、2つの見方を並べて出している。
      - 検索そのものが0件 … YouTube にその語の動画が（90日以内に）ほぼ無い
      - 検索は当たったのにカテゴリが0件 … 他の語と重複して吸収された等、辞書側の問題
    """
    counts = {name: 0 for name in categories}
    mod_counts = {name: 0 for name in modifier_names}
    for video in videos:
        for name in video.get("categories", []):
            if name in counts:
                counts[name] += 1
        for name in video.get("modifiers", []):
            if name in mod_counts:
                mod_counts[name] += 1

    print("\n主ジャンル別の件数:")
    for name, count in counts.items():
        print(f"  {name}: {count}件" + ("   ← 0件" if count == 0 else ""))
    print("掛け合わせ別の件数:")
    for name, count in mod_counts.items():
        print(f"  {name}: {count}件" + ("   ← 0件" if count == 0 else ""))

    # 検索した語のうち、1件も返らなかったもの
    searched = {e["query"] for e in plan}
    zero_queries = sorted(q for q in searched if per_query.get(q, 0) == 0)
    if zero_queries:
        print(f"\n検索して0件だった語（{len(zero_queries)}件）:")
        for query in zero_queries:
            print(f"  {query}")
        print("  → YouTube に該当する動画が90日以内にほぼ無い、"
              "または語が実際の言い回しと合っていない可能性がある")

    empty_cats = [n for n, c in counts.items() if c == 0]
    if empty_cats:
        # そのジャンルの検索は当たったのに、集計が0件になっているものを見分ける
        hit_but_empty = []
        for name in empty_cats:
            queries = [e["query"] for e in plan if e["genre"] == name]
            if any(per_query.get(q, 0) > 0 for q in queries):
                hit_but_empty.append(name)
        if hit_but_empty:
            print(f"\n注意: 検索は当たったのに0件のジャンル: {', '.join(hit_but_empty)}")
            print("  → 集計かカテゴリ付与の不具合を疑うこと")


def drop_unknown_labels(videos, genres, modifiers):
    """
    辞書に無くなった主ジャンル・掛け合わせ語を、持ち越したデータから取り除く。

    キーワード辞書を書き換えると、前回まで付いていたカテゴリ名が辞書から消える。
    そのまま残すと、画面のチップには無いタグがカードにだけ出て、押しても
    絞り込めない迷子のタグになる。そこで持ち越すデータからは古い名前を落とす。

    主ジャンルが1つも残らなかった動画は、いまの関心から外れた動画なので丸ごと捨てる。
    掛け合わせ語だけが消えた動画は、主ジャンルで拾えるので残す。
    """
    kept = []
    for video in videos:
        current = [c for c in video.get("categories", []) if c in genres]
        if not current:
            continue
        video["categories"] = current
        video["modifiers"] = [m for m in video.get("modifiers", []) if m in modifiers]
        kept.append(video)
    return kept


def merge_with_existing(videos, existing, genres, modifiers):
    """
    クォータ切れで一部しか取れなかったとき、既存の動画を失わないように混ぜる。

    今回取れた分を優先し、今回取れなかった既存の動画はそのまま残す。
    ただし持ち越す側は、辞書から消えたカテゴリ名を落としてから混ぜる。
    """
    carried = drop_unknown_labels(
        [v for v in existing if v.get("videoId")], genres, modifiers)
    by_id = {v["videoId"]: v for v in carried}
    for video in videos:
        by_id[video["videoId"]] = video
    return list(by_id.values())


def report_language(videos_before, videos_after, plan):
    """
    検索語ごとに「返ってきた件数」と「日本語だった件数」を出す。

    order（検索結果の並べ方）を変えたときの効果を測るためのもの。
    日本語率が低い語は、その100ユニットがほぼ無駄になっている。
    """
    by_query = {}
    for record in videos_before:
        japanese = is_japanese(record)
        for query in record.get("matchedKeywords", []):
            slot = by_query.setdefault(query, [0, 0])
            slot[0] += 1
            if japanese:
                slot[1] += 1

    print(f"\n検索語ごとの日本語率（order={SEARCH_ORDER}）:")
    total, total_ja = 0, 0
    for entry in plan:
        query = entry["query"]
        got, japanese = by_query.get(query, (0, 0))
        total += got
        total_ja += japanese
        rate = f"{japanese / got * 100:>3.0f}%" if got else "  -"
        flag = "   ← 日本語が少ない" if got >= 10 and japanese / got < 0.5 else ""
        print(f"  {query:<28} {got:>3}件中 日本語 {japanese:>3}件 ({rate}){flag}")
    if total:
        print(f"  合計: {total}件中 日本語 {total_ja}件 ({total_ja / total * 100:.0f}%)")
    print(f"  ふるい分け後に残った動画: {len(videos_after)}件")


def refilter(genres, modifiers, required_any, exclude):
    """
    APIを呼ばずに、既存の videos.json へふるい分けだけを掛け直す。

    keywords.yml の required_any / exclude を調整したときに、クォータを
    1ユニットも使わずに効果を確かめられるようにするためのもの。
    収集した日時（generatedAt）と消費ユニットは元のまま残す。
    """
    if not VIDEOS_FILE.exists():
        print(f"エラー: {VIDEOS_FILE} がありません。先に収集を実行してください。", file=sys.stderr)
        return 1

    payload = json.loads(VIDEOS_FILE.read_text(encoding="utf-8"))
    videos = payload.get("videos", [])
    if not videos:
        print("エラー: videos.json に動画が入っていません。", file=sys.stderr)
        return 1

    # 辞書から消えたカテゴリ名もこの機会に落とす
    videos = drop_unknown_labels(videos, genres, modifiers)
    # 収集をやめた項目が古いデータに残っていたら消す（ショートは収集しなくなった）
    for record in videos:
        record.pop("isShort", None)
    before = len(payload["videos"])
    videos, dropped, examples = apply_filters(videos, required_any, exclude)

    print(f"ふるい分け: {before}件 → {len(videos)}件")
    for reason, count in dropped.items():
        if count:
            print(f"  {reason}で除外: {count}件")
            for line in examples[reason]:
                print(f"      {line}")

    if not videos:
        print("エラー: ふるい分けで全件が消えました。videos.json は書き換えていません。",
              file=sys.stderr)
        return 1

    videos.sort(key=lambda v: v["score"]["velocity"], reverse=True)
    payload["videos"] = videos
    payload["videoCount"] = len(videos)
    payload["categories"] = list(genres)
    payload["modifiers"] = list(modifiers)
    # generatedAt と quotaUsed は「いつ収集したか」を示す値なので触らない
    VIDEOS_FILE.write_text(
        json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"保存: {VIDEOS_FILE.relative_to(BASE_DIR)}（{len(videos)}件）"
          f" ※収集日時とクォータ消費は元のまま")

    report_coverage(videos, list(genres), list(modifiers), {}, [])
    return 0


def main():
    parser = argparse.ArgumentParser(description="YouTube 美容トレンド収集")
    parser.add_argument("--mock", action="store_true",
                        help="APIを呼ばずサンプルデータを生成する（APIキー不要）")
    parser.add_argument("--limit", type=int, default=None,
                        help="検索するキーワード数の上限（試運転用）")
    parser.add_argument("--dry-run", action="store_true",
                        help="収集して結果を表示するだけで保存しない"
                             "（クォータは消費する。検索条件を変えた効果を測るとき用）")
    parser.add_argument("--refilter", action="store_true",
                        help="APIを呼ばず、既存の videos.json にふるい分けだけ掛け直す"
                             "（クォータを消費しない。キーワードを調整したときに使う）")
    args = parser.parse_args()

    now = datetime.now(JST)
    tracker = QuotaTracker()

    genres, modifiers, required_any, exclude = load_keywords()
    if not genres:
        print("エラー: keywords.yml から主ジャンルを読み取れませんでした。", file=sys.stderr)
        return 1

    if args.refilter:
        return refilter(genres, modifiers, required_any, exclude)
    plan = build_search_plan(genres, modifiers)
    categories = list(genres)
    modifier_names = list(modifiers)

    selected = select_keywords(plan, MAX_SEARCH_CALLS, now)
    if args.limit is not None:
        selected = selected[:args.limit]

    combined = sum(1 for e in plan if e["modifier"])
    print(f"辞書: 主ジャンル {len(categories)} / 掛け合わせ {len(modifier_names)}")
    print(f"検索する語: 単独 {len(plan) - combined} + 掛け合わせ {combined} = {len(plan)}")
    print(f"今回検索する語: {len(selected)}（最大 {len(selected) * UNIT_SEARCH} ユニット）")
    if len(plan) > MAX_SEARCH_CALLS:
        print(f"（1日{MAX_SEARCH_CALLS}語の上限を超えているため、日替わりで回しています）")

    today_name = f"{now.date().isoformat()}.json"

    if args.mock:
        videos = generate_mock(selected, now)
        quota_hit = False
        per_query = {e["query"]: 1 for e in selected}
    else:
        api_key = os.environ.get("YOUTUBE_API_KEY", "").strip()
        if not api_key:
            print("エラー: 環境変数 YOUTUBE_API_KEY が設定されていません。", file=sys.stderr)
            print("       画面の確認だけなら --mock を付けて実行してください。", file=sys.stderr)
            return 1
        youtube = build_client(api_key)
        videos, quota_hit, per_query = collect(youtube, selected, now, tracker)

    if not videos:
        print(tracker.summary())
        print("今回は0件でした。既存の videos.json はそのまま残します。")
        # クォータ超過は想定内なので失敗扱いにしない。
        # それ以外で0件なら、検索条件かキーが怪しいので失敗にして通知を出す。
        return 0 if quota_hit else 1

    # ふるい分け。海外の動画と、キーワードには当たったが中身が別物の動画を落とす。
    if not args.mock:
        before = len(videos)
        raw_videos = list(videos)
        videos, dropped, examples = apply_filters(videos, required_any, exclude)
        print(f"\nふるい分け: {before}件 → {len(videos)}件")
        for reason, count in dropped.items():
            if count:
                print(f"  {reason}で除外: {count}件")
                for line in examples[reason]:
                    print(f"      {line}")
        if args.dry_run:
            report_language(raw_videos, videos, selected)
            print(tracker.summary())
            print("\n--dry-run のため保存していません。"
                  "既存の videos.json はそのままです。")
            return 0

        if not videos:
            print("エラー: ふるい分けで全件が消えました。"
                  "keywords.yml の required_any / exclude を見直してください。", file=sys.stderr)
            return 1

    # 前回値は今日の分を書き出す前に読む（--mock は直前に履歴を作ることがあるのでここで読む）
    previous = load_previous_snapshot(today_name)
    apply_scores(videos, previous, now)

    if quota_hit:
        videos = merge_with_existing(
            videos, load_existing_videos(), genres, modifiers)
        apply_scores(videos, previous, now)

    videos.sort(key=lambda v: v["score"]["velocity"], reverse=True)
    save(videos, categories, modifier_names, tracker, now, is_mock=args.mock)

    # どのカテゴリが0件だったかは、キーワードを見直す手がかりになるので必ず出す
    report_coverage(videos, categories, modifier_names, per_query, selected)

    removed = prune_history(now)
    print(tracker.summary())
    print(f"保存: {VIDEOS_FILE.relative_to(BASE_DIR)}（{len(videos)}件）")
    if removed:
        print(f"{HISTORY_KEEP_DAYS}日より古い履歴を{removed}件削除しました。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
