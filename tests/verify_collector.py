#!/usr/bin/env python3
"""
collect.py / scoring.py のうち、--mock では通らない部分を確認する。

API を呼ぶ部分は本物のキーが要るので、ここではレスポンスを差し替えて
「返ってきた値をどう変換するか」だけを見ている。

実行:
  python3 tests/verify_collector.py
"""

import json
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE / "collector"))

import collect  # noqa: E402
import scoring  # noqa: E402

JST = timezone(timedelta(hours=9))

# 揃える先。Threads / Instagram 版と同じ構成であることを直接突き合わせる。
THREADS_CONFIG = Path("/Users/kameda/Projects/threads-trend-collector/config/keywords.json")

# Threads 版にはあるが YouTube 版では意図的に外したジャンル。
# パーマネントジュエリー: 2026-09-03 の実測で90日以内の日本語動画が0件だった。
#   単独検索50件は全て英語圏で、掛け合わせ2種は YouTube が1本も返さなかった。
#   YouTube にまだ日本語の供給が無いため外している（keywords.yml に理由を記載）。
INTENTIONALLY_DROPPED = {"パーマネントジュエリー"}

checks = 0
failures = 0


def check(name, actual, expected):
    global checks, failures
    checks += 1
    ok = expected(actual) if callable(expected) else actual == expected
    if ok:
        print(f"  OK  {name}  → {actual!r}")
    else:
        failures += 1
        print(f"  NG  {name}\n        期待: {expected!r}\n        実際: {actual!r}")


# --- 1. 動画の長さの解釈 --------------------------------------------------

print("\n[1] ISO8601の長さを秒にする")
check("PT45S", collect.parse_duration("PT45S"), 45)
check("PT1M30S", collect.parse_duration("PT1M30S"), 90)
check("PT1H2M3S", collect.parse_duration("PT1H2M3S"), 3723)
check("PT2H（分秒なし）", collect.parse_duration("PT2H"), 7200)
check("P1DT2H（日をまたぐ配信）", collect.parse_duration("P1DT2H"), 93600)
check("空文字", collect.parse_duration(""), 0)
check("None", collect.parse_duration(None), 0)
check("壊れた値", collect.parse_duration("ZZZ"), 0)

print("\n[2] ショート判定（60秒以下）")
check("60秒はショート", 0 < collect.parse_duration("PT1M") <= collect.SHORT_MAX_SEC, True)
check("61秒はショートでない", 0 < collect.parse_duration("PT1M1S") <= collect.SHORT_MAX_SEC, False)

# --- 3. キーワード辞書 ----------------------------------------------------

print("\n[3] keywords.yml の読み取り")
genres, modifiers, required_any, exclude = collect.load_keywords()
check("主ジャンル数", len(genres), 11)
check("掛け合わせ語数", len(modifiers), 6)
check("主ジャンルは1ジャンル1語", [len(v) for v in genres.values()], lambda v: set(v) == {1})
check("主ジャンルの並び順", list(genres), [
    "ヘッドスパ", "アートメイク", "リンパ",
    "セラピスト", "エステティシャン", "美容サロン", "オンライン秘書",
    "更年期ケア", "ピラティス", "鍼灸", "育毛"])
check("意図的に外したジャンルは入っていない",
      [g for g in INTENTIONALLY_DROPPED if g in genres], [])
check("掛け合わせの並び順", list(modifiers),
      ["経営", "メニュー", "高単価", "単価UP", "スクール", "手技"])

# 簡易パーサ（PyYAML が無い環境用）が同じ結果になるか
raw = collect._parse_simple_yaml((BASE / "collector" / "keywords.yml").read_text(encoding="utf-8"))
check("簡易パーサでも主ジャンルが一致", {k: v for k, v in raw["genres"].items()},
      {k: v for k, v in genres.items()})
check("簡易パーサでも掛け合わせが一致", {k: v for k, v in raw["modifiers"].items()},
      {k: v for k, v in modifiers.items()})
check("簡易パーサはコメント行を読まない", raw["genres"], lambda g: "#" not in "".join(g))
check("関連度フィルタが全ジャンル分ある", sorted(required_any), sorted(genres))
check("除外語が読める", exclude, lambda e: "クレヨンしんちゃん" in e and len(e) >= 5)
check("あえて入れない語は入っていない", exclude,
      lambda e: not any(w in e for w in ["ASMR", "vlog", "コント"]))

# --- 4. Threads 版と同じ構成か --------------------------------------------

print("\n[4] Threads 版と同じ構成に揃っているか")
if THREADS_CONFIG.exists():
    threads = json.loads(THREADS_CONFIG.read_text(encoding="utf-8"))
    expected_genres = [g for g in threads["genres"] if g not in INTENTIONALLY_DROPPED]
    check("主ジャンルが一致（意図的に外した分を除く・並び順まで）",
          list(genres), expected_genres)
    check("掛け合わせ語が一致（並び順まで）", list(modifiers), list(threads["modifiers"]))
    for name, spec in threads["modifiers"].items():
        expected = [g for g in spec["combine_with"] if g not in INTENTIONALLY_DROPPED]
        check(f"combine_with が一致: {name}", modifiers.get(name), expected)
    for name, spec in threads["genres"].items():
        if name in INTENTIONALLY_DROPPED:
            check(f"外したジャンルの required_any も消えている: {name}",
                  name in required_any, False)
            continue
        check(f"required_any が一致: {name}", required_any.get(name), spec["required_any"])
else:
    print(f"  -- Threads 版の設定が見つからないので照合を飛ばす: {THREADS_CONFIG}")

# --- 5. 検索プラン --------------------------------------------------------

print("\n[5] 検索プランの組み立て")
plan = collect.build_search_plan(genres, modifiers)
combined = [e for e in plan if e["modifier"]]
solo = [e for e in plan if not e["modifier"]]
check("単独検索は主ジャンルの数だけ", len(solo), 11)
check("掛け合わせ検索は combine_with の合計", len(combined),
      sum(len(v) for v in modifiers.values()))
check("検索回数の合計", len(plan), 49)
check("主ジャンルが先、掛け合わせが後",
      [bool(e["modifier"]) for e in plan],
      lambda flags: flags == sorted(flags))
check("掛け合わせは主ジャンルと組んだ語になる",
      next(e["query"] for e in combined if e["genre"] == "エステティシャン" and e["modifier"] == "経営"),
      "エステティシャン 経営")
check("掛け合わせ語だけの検索は作らない",
      [e["query"] for e in plan], lambda qs: not any(q in modifiers for q in qs))
check("単独検索の語はジャンル名そのもの",
      [e["query"] for e in solo], list(genres))

# 辞書の書き間違いを黙って飲み込まない
bad_plan = collect.build_search_plan({"ヘッドスパ": ["ヘッドスパ"]}, {"経営": ["存在しないジャンル"]})
check("知らないジャンルを指す掛け合わせは無視する", len(bad_plan), 1)

# 検索結果の並べ方（再生数順だと英語圏の巨大チャンネルに枠を奪われる）
check("検索は関連度順にする", collect.SEARCH_ORDER, "relevance")

# --- 6. 日替わりローテーション --------------------------------------------

print("\n[6] ローテーションが要るかどうか")
check("49件は上限60以下なので1日で全部回る",
      len(collect.select_keywords(plan, collect.MAX_SEARCH_CALLS, datetime.now(JST))), 49)
check("ローテーションは発動しない",
      len(plan) <= collect.MAX_SEARCH_CALLS, True)

many = [{"genre": "c", "modifier": None, "query": f"語{i:03d}"} for i in range(130)]
day1 = datetime(2026, 9, 3, 6, 0, tzinfo=JST)
sel1 = collect.select_keywords(many, 60, day1)
sel2 = collect.select_keywords(many, 60, day1 + timedelta(days=1))
sel3 = collect.select_keywords(many, 60, day1 + timedelta(days=2))
q = lambda sel: [e["query"] for e in sel]  # noqa: E731
check("上限を超えたら1日あたり上限ちょうど", len(sel1), 60)
check("翌日は別の語になる", q(sel1) == q(sel2), False)
check("3日で全語を一周する", len(set(q(sel1)) | set(q(sel2)) | set(q(sel3))), 130)
check("同じ日なら同じ結果（再実行しても崩れない）",
      q(collect.select_keywords(many, 60, day1 + timedelta(hours=5))), q(sel1))

# --- 7. クォータ集計 ------------------------------------------------------

print("\n[7] クォータの数え方（最悪ケース）")
tracker = collect.QuotaTracker()
for _ in range(len(plan)):
    tracker.add_search()
# 49回の検索 × 50件 = 2,450件。videos.list も channels.list も50件ずつなので49回ずつ。
worst_list_calls = 2 * -(-len(plan) * collect.SEARCH_PAGE_SIZE // collect.BATCH_SIZE)
for _ in range(worst_list_calls):
    tracker.add_list()
check("検索の消費", len(plan) * collect.UNIT_SEARCH, 4900)
check("詳細＋チャンネルの最悪回数", worst_list_calls, 98)
check("1日の最悪消費ユニット", tracker.units, 4998)
check("1日上限10,000に収まる", tracker.units, lambda u: u < 10000)
check("ログに概算が出る", tracker.summary(), lambda s: "4998" in s)

# --- 8. APIレスポンスの変換 -----------------------------------------------

print("\n[8] APIレスポンスを1件のデータに変換する")
item = {
    "id": "abc12345678",
    "snippet": {
        "title": "ヘッドスパの単価の上げ方",
        "channelId": "UC999",
        "channelTitle": "ヘッドスパ職人",
        "publishedAt": "2026-08-20T10:00:00Z",
        "thumbnails": {
            "default": {"url": "https://i.ytimg.com/vi/abc/default.jpg"},
            "medium": {"url": "https://i.ytimg.com/vi/abc/mqdefault.jpg"},
        },
    },
    "statistics": {"viewCount": "120000", "likeCount": "3400", "commentCount": "210"},
    "contentDetails": {"duration": "PT58S"},
}
record = collect.build_record(
    "abc12345678", item, 4200, {"ヘッドスパ", "セラピスト"}, {"経営", "高単価"},
    {"ヘッドスパ 経営"}, "2026-09-03T06:00:00+09:00")

check("スキーマの項目が揃っている", sorted(record.keys()), sorted([
    "videoId", "title", "channelId", "channelTitle", "subscriberCount", "publishedAt",
    "durationSec", "isShort", "thumbnail", "viewCount", "likeCount", "commentCount",
    "categories", "modifiers", "matchedKeywords", "score", "collectedAt",
    # ふるい分けの判定根拠。あとで「なぜ残った/落ちた」を追えるように保存する
    "audioLanguage"]))
check("言語の申告を拾う", record["audioLanguage"], "")
check("再生数が数値になる", record["viewCount"], 120000)
check("58秒はショート", record["isShort"], True)
check("サムネイルは medium を使う", record["thumbnail"], "https://i.ytimg.com/vi/abc/mqdefault.jpg")
check("主ジャンルは配列でソート済み", record["categories"], ["セラピスト", "ヘッドスパ"])
check("掛け合わせも配列で持つ", record["modifiers"], ["経営", "高単価"])
check("登録者数が入る", record["subscriberCount"], 4200)

hidden = {"id": "x", "snippet": {"publishedAt": "2026-08-20T10:00:00Z"},
          "statistics": {"viewCount": "50"}, "contentDetails": {"duration": "PT10M"}}
record2 = collect.build_record("x", hidden, 0, {"育毛"}, set(), {"育毛"},
                               "2026-09-03T06:00:00+09:00")
check("いいね非公開でも落ちない", record2["likeCount"], 0)
check("サムネイル無しでも空文字で通る", record2["thumbnail"], "")
check("単独検索でヒットした動画は掛け合わせが空", record2["modifiers"], [])

# --- 9. スコア -------------------------------------------------------------

print("\n[9] スコア計算")
now = datetime(2026, 9, 3, 6, 0, tzinfo=JST)
check("velocity＝再生数÷経過日数",
      scoring.velocity(100000, (now - timedelta(days=10)).isoformat(), now), 10000.0)
check("公開当日でも0除算しない（最低1日で割る）",
      scoring.velocity(5000, now.isoformat(), now), 5000.0)
check("acceleration＝増分÷経過日数",
      scoring.acceleration(120000, 90000, (now - timedelta(days=3)).isoformat(), now), 10000.0)
check("前回データが無ければ None", scoring.acceleration(120000, None, None, now), None)
check("再生数が減っても計算はする（マイナス）",
      scoring.acceleration(90000, 100000, (now - timedelta(days=2)).isoformat(), now), -5000.0)
check("subRatio＝再生数÷登録者数", scoring.sub_ratio(84000, 4200), 20.0)
check("登録者0でも0除算しない（100で割る）", scoring.sub_ratio(5000, 0), 50.0)
check("登録者非公開(None)でも落ちない", scoring.sub_ratio(5000, None), 50.0)
check("末尾Zの時刻を読める", scoring.velocity(1000, "2026-09-01T06:00:00Z", now), lambda v: v > 0)
check("公開日が壊れていても落ちない", scoring.velocity(1000, "こわれた", now), 0.0)

# --- 10. 履歴の掃除と保存 --------------------------------------------------

print("\n[10] 履歴の保存・参照・掃除")
tmp = Path(tempfile.mkdtemp())
orig_data, orig_hist, orig_videos = collect.DATA_DIR, collect.HISTORY_DIR, collect.VIDEOS_FILE
try:
    collect.DATA_DIR = tmp
    collect.HISTORY_DIR = tmp / "history"
    collect.VIDEOS_FILE = tmp / "videos.json"
    collect.HISTORY_DIR.mkdir(parents=True)

    def write_history(date, videos):
        (collect.HISTORY_DIR / f"{date.isoformat()}.json").write_text(
            json.dumps({"generatedAt": date.isoformat(), "videos": videos},
                       ensure_ascii=False), encoding="utf-8")

    old = (now - timedelta(days=45)).date()
    recent = (now - timedelta(days=2)).date()
    write_history(old, [{"videoId": "a", "viewCount": 1, "collectedAt": "2026-07-20T06:00:00+09:00"}])
    write_history(recent, [{"videoId": "a", "viewCount": 90000,
                            "collectedAt": (now - timedelta(days=2)).isoformat()}])
    (collect.HISTORY_DIR / "メモ.txt").write_text("消さないこと", encoding="utf-8")

    prev = collect.load_previous_snapshot(f"{now.date().isoformat()}.json")
    check("直近の履歴から前回値を引く", prev["a"]["viewCount"], 90000)

    removed = collect.prune_history(now)
    names = sorted(p.name for p in collect.HISTORY_DIR.iterdir())
    check("30日より古い履歴を消す", removed, 1)
    check("新しい履歴と日付以外のファイルは残る", names, [f"{recent.isoformat()}.json", "メモ.txt"])

    collect.save([record], list(genres), list(modifiers), tracker, now)
    saved = json.loads(collect.VIDEOS_FILE.read_text(encoding="utf-8"))
    check("先頭にメタ情報が入る", [k for k in saved if k != "videos"],
          ["generatedAt", "videoCount", "quotaUsed", "isMock", "categories", "modifiers"])
    check("メタの主ジャンルは辞書順のまま", saved["categories"], list(genres))
    check("メタの掛け合わせも持つ", saved["modifiers"], list(modifiers))
    check("videoCount が件数と一致", saved["videoCount"], 1)
    check("本番実行にはモック印が付かない", saved["isMock"], False)
    check("同じ内容が当日の履歴にも残る",
          (collect.HISTORY_DIR / f"{now.date().isoformat()}.json").exists(), True)

    (collect.HISTORY_DIR / f"{(now - timedelta(days=1)).date().isoformat()}.json").write_text(
        "{壊れたJSON", encoding="utf-8")
    prev2 = collect.load_previous_snapshot(f"{now.date().isoformat()}.json")
    check("壊れた履歴は飛ばして1つ前を見る", prev2["a"]["viewCount"], 90000)
finally:
    collect.DATA_DIR, collect.HISTORY_DIR, collect.VIDEOS_FILE = orig_data, orig_hist, orig_videos
    shutil.rmtree(tmp, ignore_errors=True)

# --- 11. 辞書を変えたときに古いカテゴリ名をどう扱うか ----------------------

print("\n[11] 辞書から消えたカテゴリ名の扱い")
legacy = [
    {"videoId": "old1", "categories": ["脱毛", "フェイシャル"], "modifiers": []},
    {"videoId": "mix1", "categories": ["脱毛", "ヘッドスパ"], "modifiers": ["経営", "旧掛け合わせ"]},
    {"videoId": "now1", "categories": ["育毛"], "modifiers": ["手技"]},
]
kept = collect.drop_unknown_labels([dict(v) for v in legacy], genres, modifiers)
by_id = {v["videoId"]: v for v in kept}
check("今の辞書に無いジャンルだけの動画は捨てる", sorted(by_id), ["mix1", "now1"])
check("残る動画から古いジャンル名を落とす", by_id["mix1"]["categories"], ["ヘッドスパ"])
check("残る動画から古い掛け合わせ語も落とす", by_id["mix1"]["modifiers"], ["経営"])
check("今の辞書にある動画はそのまま", by_id["now1"]["categories"], ["育毛"])

# --- 12. クォータ超過時にデータを壊さない ---------------------------------

print("\n[12] クォータ超過時の扱い")
existing = [
    {"videoId": "keep1", "title": "前回だけ取れた動画", "viewCount": 100,
     "categories": ["ヘッドスパ"], "modifiers": []},
    {"videoId": "both", "title": "古い方", "viewCount": 100,
     "categories": ["育毛"], "modifiers": []},
    {"videoId": "stale", "title": "旧辞書のみの動画", "viewCount": 100,
     "categories": ["脱毛"], "modifiers": []},
]
fresh = [{"videoId": "both", "title": "新しい方", "viewCount": 500,
          "categories": ["育毛"], "modifiers": ["メニュー"]},
         {"videoId": "new1", "title": "今回だけ", "viewCount": 10,
          "categories": ["鍼灸"], "modifiers": []}]
merged = collect.merge_with_existing(fresh, existing, genres, modifiers)
by_id = {v["videoId"]: v for v in merged}
check("既存の動画を失わない", sorted(by_id), ["both", "keep1", "new1"])
check("重複は今回の値で上書きする", by_id["both"]["title"], "新しい方")
check("旧辞書だけの動画は持ち越さない", "stale" in by_id, False)


class FakeResp:
    status = 403


class FakeHttpError(Exception):
    def __init__(self, content):
        self.resp = FakeResp()
        self.content = content


check("quotaExceeded を見分ける",
      collect._is_quota_error(FakeHttpError(b'{"error":{"errors":[{"reason":"quotaExceeded"}]}}')), True)
check("dailyLimitExceeded も見分ける",
      collect._is_quota_error(FakeHttpError(b'{"reason":"dailyLimitExceeded"}')), True)
check("別の403（キー不正など）はクォータ扱いにしない",
      collect._is_quota_error(FakeHttpError(b'{"reason":"forbidden"}')), False)

# --- 13. 収集の流れ全体（APIを差し替えて通す）------------------------------

print("\n[13] 収集の流れ（APIレスポンスを差し替えて確認）")


class FakeRequest:
    def __init__(self, payload):
        self._payload = payload

    def execute(self):
        return self._payload


class FakeSearch:
    """検索語ごとに返す videoId を決め打ちしたモック。"""

    def __init__(self, table, log):
        self.table = table
        self.log = log

    def list(self, **kwargs):
        query = kwargs["q"]
        self.log.append(query)
        ids = self.table.get(query, [])
        return FakeRequest({"items": [{"id": {"videoId": i}} for i in ids]})


class FakeVideos:
    def __init__(self, log):
        self.log = log

    def list(self, **kwargs):
        ids = kwargs["id"].split(",")
        self.log.append(ids)
        items = []
        for video_id in ids:
            items.append({
                "id": video_id,
                "snippet": {
                    "title": f"動画 {video_id}",
                    "channelId": "UC_" + video_id[:3],
                    "channelTitle": "テストch",
                    "publishedAt": "2026-08-20T10:00:00Z",
                    "thumbnails": {"medium": {"url": f"https://i.ytimg.com/{video_id}.jpg"}},
                },
                "statistics": {"viewCount": "1000", "likeCount": "10", "commentCount": "1"},
                "contentDetails": {"duration": "PT2M"},
            })
        return FakeRequest({"items": items})


class FakeChannels:
    def __init__(self, log):
        self.log = log

    def list(self, **kwargs):
        ids = kwargs["id"].split(",")
        self.log.append(ids)
        return FakeRequest({"items": [
            {"id": c, "statistics": {"subscriberCount": "5000"}} for c in ids]})


class FakeYouTube:
    def __init__(self, table):
        self.search_log = []
        self.videos_log = []
        self.channels_log = []
        self._search = FakeSearch(table, self.search_log)
        self._videos = FakeVideos(self.videos_log)
        self._channels = FakeChannels(self.channels_log)

    def search(self):
        return self._search

    def videos(self):
        return self._videos

    def channels(self):
        return self._channels


# 「ヘッドスパ」と「ヘッドスパ 経営」の両方に出る動画を1つ混ぜる
table = {
    "ヘッドスパ": ["vid_aaa", "vid_bbb"],
    "ヘッドスパ 経営": ["vid_aaa"],
    "育毛": ["vid_ccc"],
    "育毛 メニュー": [],          # 検索して0件になる語
}
small_plan = [
    {"genre": "ヘッドスパ", "modifier": None, "query": "ヘッドスパ"},
    {"genre": "育毛", "modifier": None, "query": "育毛"},
    {"genre": "ヘッドスパ", "modifier": "経営", "query": "ヘッドスパ 経営"},
    {"genre": "育毛", "modifier": "メニュー", "query": "育毛 メニュー"},
]

fake = FakeYouTube(table)
run_tracker = collect.QuotaTracker()
collected, quota_hit, per_query = collect.collect(fake, small_plan, now, run_tracker)
by_id = {v["videoId"]: v for v in collected}

check("検索は語の数だけ investigated", len(fake.search_log), 4)
check("重複した videoId は1件にまとめる", sorted(by_id), ["vid_aaa", "vid_bbb", "vid_ccc"])
check("複数の語で当たった動画に掛け合わせが付く", by_id["vid_aaa"]["modifiers"], ["経営"])
check("単独検索だけの動画は掛け合わせが空", by_id["vid_bbb"]["modifiers"], [])
check("主ジャンルが正しく付く", by_id["vid_ccc"]["categories"], ["育毛"])
check("ヒットした検索語を両方持つ", by_id["vid_aaa"]["matchedKeywords"],
      ["ヘッドスパ", "ヘッドスパ 経営"])
check("0件だった語も記録される", per_query["育毛 メニュー"], 0)
check("件数が返った語も記録される", per_query["ヘッドスパ"], 2)
check("クォータ超過は起きていない", quota_hit, False)
check("動画詳細は1回にまとめて取る", len(fake.videos_log), 1)
check("チャンネルは重複を除いて1回で取る", len(fake.channels_log), 1)
check("同じチャンネルを二重に問い合わせない",
      len(fake.channels_log[0]), len(set(fake.channels_log[0])))
check("登録者数が入る", by_id["vid_aaa"]["subscriberCount"], 5000)
check("消費ユニット（検索4 + 詳細1 + チャンネル1）", run_tracker.units, 4 * 100 + 2)

# --- 14. ふるい分け（海外・無関係の動画を落とす）---------------------------

print("\n[14] ふるい分け")


def rec(title, channel="ch", cats=("ヘッドスパ",), lang=""):
    return {"title": title, "channelTitle": channel,
            "categories": list(cats), "audioLanguage": lang}


# 言語の判定
check("日本語のタイトルは残す", collect.is_japanese(rec("極上ヘッドスパの施術")), True)
check("英語だけのタイトルは落とす",
      collect.is_japanese(rec("The Craziest Hair Appointment", "Hoodlum Boys")), False)
check("チャンネル名だけ日本語でも残す",
      collect.is_japanese(rec("Esthetic Massage", "エステレポートチャンネル")), True)
check("漢字だけのタイトルも残す", collect.is_japanese(rec("腰痛", "WIZ鍼灸整骨院")), True)
check("APIがjaと申告していれば英語表記でも残す",
      collect.is_japanese(rec("HEAD SPA ASMR", "benio", lang="ja")), True)
check("APIがenと申告していれば日本語が混じっても落とす",
      collect.is_japanese(rec("Pilates ピラティス", "Mark", lang="en-US")), False)
check("ja-JP のような表記も日本語として扱う",
      collect.is_japanese(rec("Head Spa", "x", lang="ja-JP")), True)

# 関連度の判定
check("ジャンルの語が入っていれば残す",
      collect.is_relevant(rec("ヘッドスパで頭皮を整える"), required_any), True)
check("ジャンルの語が1つも無ければ落とす",
      collect.is_relevant(rec("オカン、子なし韓国で大暴れ", cats=("アートメイク",)), required_any), False)
check("複数ジャンルはどれか1つ当たれば残す",
      collect.is_relevant(rec("鍼灸院のツボ講座", cats=("ヘッドスパ", "鍼灸")), required_any), True)
check("required_any が無いジャンルは素通しする",
      collect.is_relevant(rec("なんでも", cats=("未知ジャンル",)), required_any), True)

# 除外語
check("除外語に当たれば語を返す",
      collect.excluded_word(rec("育毛剤 #クレヨンしんちゃん"), exclude), "クレヨンしんちゃん")
check("除外語に当たらなければ None",
      collect.excluded_word(rec("ヘッドスパの施術"), exclude), None)
check("「コント」を除外語に入れていないので巻き込まない",
      collect.excluded_word(rec("脊柱コントロールとピラティス"), exclude), None)
check("ASMR は除外しない（本物のヘッドスパ動画のため）",
      collect.excluded_word(rec("【ASMR】極上ヘッドスパ"), exclude), None)

# まとめて適用したとき
mixed = [
    rec("ヘッドスパで頭皮を整える"),                                    # 残る
    rec("The Craziest Hair Appointment", "Hoodlum Boys", ("美容サロン",)),  # 海外
    rec("育毛剤 #クレヨンしんちゃん", "クレしん日記", ("育毛",)),          # 除外語
    rec("オカン、子なし韓国で大暴れ", "古川優香", ("アートメイク",)),      # 無関係
]
kept, dropped, examples = collect.apply_filters(mixed, required_any, exclude)
check("残るのは1件", len(kept), 1)
check("残った動画", kept[0]["title"], "ヘッドスパで頭皮を整える")
check("落とした理由の内訳", dropped, {"海外": 1, "無関係": 1, "除外語": 1})
check("落とした例に除外語が添えられる", examples["除外語"][0], lambda t: "クレヨンしんちゃん" in t)
check("除外語は無関係より先に判定する（理由が正しく出る）",
      collect.apply_filters([rec("育毛剤 #クレヨンしんちゃん", "x", ("育毛",))],
                            required_any, exclude)[1]["除外語"], 1)

# --- まとめ ---------------------------------------------------------------

print(f"\n{checks - failures}/{checks} 件が期待どおり")
if failures:
    print(f"{failures} 件が失敗")
    sys.exit(1)
print("すべて期待どおりです")
