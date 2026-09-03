#!/usr/bin/env python3
"""
動画の「伸び」を表す3つの指標を計算する。

3つを分けているのは、見たいものが違うため:
  velocity     … 公開からならしてどれくらい回っているか（定番の強い動画が上位）
  acceleration … 前回の収集から今回までにどれだけ増えたか（今まさに伸びている動画）
  subRatio     … 登録者数に対して何倍回ったか（小さいチャンネルの跳ねた動画）
"""

from datetime import datetime, timedelta, timezone

JST = timezone(timedelta(hours=9))

# 公開直後の動画で velocity が跳ね上がるのを防ぐ下限。
# 公開1時間の動画を「経過0日」で割ると値が無限に大きくなり、
# 中身に関係なく新しい動画だけが並んでしまう。
MIN_AGE_DAYS = 1.0

# acceleration の分母の下限。同じ日に2回走らせたときに
# ごく短い間隔で割って値が暴れるのを防ぐ。
MIN_INTERVAL_DAYS = 0.5

# subRatio の分母の下限。登録者数を非公開にしているチャンネルは 0 で返るため、
# そのまま割るとゼロ除算になる。
MIN_SUBSCRIBERS = 100


def parse_iso8601(value):
    """ISO8601 の文字列を datetime にする。読めなければ None。"""
    if not value:
        return None
    text = str(value).strip()
    # YouTube API は末尾 Z で返す。Python の fromisoformat は Z を解釈しないので置き換える。
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    # タイムゾーンが無い文字列は JST として扱う（このツールの時刻は全て JST 基準）
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=JST)
    return parsed


def velocity(view_count, published_at, now=None):
    """伸びの速さ ＝ 再生数 ÷ 公開からの経過日数。1日あたり何回再生されたか。"""
    now = now or datetime.now(JST)
    published = parse_iso8601(published_at)
    if published is None:
        return 0.0
    age_days = (now - published).total_seconds() / 86400.0
    return round(view_count / max(age_days, MIN_AGE_DAYS), 2)


def acceleration(view_count, previous_view_count, previous_collected_at, now=None):
    """
    加速度 ＝ (今回の再生数 − 前回の再生数) ÷ 前回からの経過日数。

    前回のデータが無い動画は None を返す（0 にすると「伸びていない」と
    区別が付かなくなり、並び替えで新着動画が最下位に沈んでしまう）。
    """
    if previous_view_count is None:
        return None
    previous_time = parse_iso8601(previous_collected_at)
    if previous_time is None:
        return None

    now = now or datetime.now(JST)
    interval_days = (now - previous_time).total_seconds() / 86400.0
    if interval_days <= 0:
        return None
    return round((view_count - previous_view_count) / max(interval_days, MIN_INTERVAL_DAYS), 2)


def sub_ratio(view_count, subscriber_count):
    """登録者比 ＝ 再生数 ÷ 登録者数。登録者の何倍に届いたか。"""
    subscribers = subscriber_count if isinstance(subscriber_count, int) else 0
    return round(view_count / max(subscribers, MIN_SUBSCRIBERS), 2)


def build_score(video, previous=None, now=None):
    """1件分の score オブジェクトを組み立てる。previous は前回スナップショットの同じ動画。"""
    now = now or datetime.now(JST)
    view_count = video.get("viewCount") or 0

    previous_views = None
    previous_time = None
    if previous:
        previous_views = previous.get("viewCount")
        previous_time = previous.get("collectedAt")

    return {
        "velocity": velocity(view_count, video.get("publishedAt"), now),
        "acceleration": acceleration(view_count, previous_views, previous_time, now),
        "subRatio": sub_ratio(view_count, video.get("subscriberCount")),
    }
