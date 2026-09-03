# YouTube 美容トレンドリサーチツール — 仕様の要約

美容領域で「いま伸びている YouTube 動画」を毎日集めて静的ページで見せるツール。
利用者は美容サロンのオーナー（非エンジニア）。発信とスクール集客の参考にするのが目的。

参考にした先行実装は `../threads-trend-collector`（Threads 版）。
設計思想（定期収集 → JSON をコミット → 静的HTMLで表示）を踏襲している。

## 変更してはいけない前提

- 収集は Python 3.11 + `google-api-python-client` + YouTube Data API v3
- 実行は GitHub Actions（cron、1日1回 JST 6:00）
- 表示は静的 HTML / CSS / Vanilla JS。ビルド不要、フレームワーク不使用
- 外部 CDN への依存はゼロ（Webフォントも読まない。フォントは端末のものを使う）
- サーバー・DB・有料サービスは使わない
- API キーは GitHub Secrets（`YOUTUBE_API_KEY`）。コード・コミット・ログに絶対に出さない
- 動画の説明文本文・コメント本文は保存しない（タイトル・統計値・メタ情報のみ）
- コメントとコミットメッセージは日本語

## ディレクトリ

```
.github/workflows/collect.yml  cron + 自動コミット
collector/collect.py           収集本体（--mock でAPIキー無しでも動く）
collector/keywords.yml         キーワード辞書（genres / modifiers の2部構成）
collector/scoring.py           スコア計算
docs/                          GitHub Pages の公開ディレクトリ
docs/data/videos.json          最新の一覧（フロントが fetch する）
docs/data/history/*.json       日次スナップショット（30日で自動削除）
tests/verify_collector.py      収集側の自動テスト
tests/verify_app.mjs           フロントの自動テスト（jsdom）
```

**`data/` を `docs/` の下に置いている理由**：GitHub Pages を「docs フォルダ」で
公開すると配信対象は `docs/` の中身だけになる。リポジトリ直下の `data/` は
配信されず、フロントから fetch できない。元の仕様案では直下 `data/` だったが、
そのままだと本番で必ず壊れるため変更した。移す場合は `collect.py` の `DATA_DIR` と
`app.js` の fetch 先を揃えて直すこと。

## 収集

### キーワード辞書（Threads / Instagram 版と同一構成）

`collector/keywords.yml` は2部構成。**この構成は3ツールで揃えること。**

- `genres`（主ジャンル12）… 単独で検索して意味が通る語。1ジャンル1語。
  ヘッドスパ / アートメイク / パーマネントジュエリー / リンパ / セラピスト /
  エステティシャン / 美容サロン / オンライン秘書 / 更年期ケア / ピラティス / 鍼灸 / 育毛
- `modifiers`（掛け合わせ6）… 単独では検索しない語。
  経営 / メニュー / 高単価 / 単価UP / スクール / 手技

**掛け合わせ語を単独で検索してはいけない。** 「経営」「メニュー」を単独で投げると
飲食店や一般ビジネスの動画を大量に拾う（Threads版の実測で31件中23件＝74%が無関係）。
`modifiers` に並べた主ジャンルと組ませた語（例:「エステティシャン 経営」）だけを検索する。
YouTube の検索は空白がANDなので、組ませるだけで絞れる。

組み合わせの正解は `../threads-trend-collector/config/keywords.json` の
`modifiers.combine_with`。`tests/verify_collector.py` がこのファイルと直接照合するので、
片方だけ変えるとテストが落ちる。

`build_search_plan()` が投げる検索の一覧を作る。並びは「主ジャンル全部 → 掛け合わせ全部」で、
ローテーションで途中までしか回らない日でも主ジャンルが先に埋まるようにしてある。

### API 呼び出し

- `search.list`: `type=video`, `regionCode=JP`, `relevanceLanguage=ja`,
  `order=viewCount`, `publishedAfter=現在-90日`, `maxResults=50`、1語1ページ
- `videos.list`（`snippet,statistics,contentDetails`）で50件ずつ詳細取得
- `channels.list`（`statistics`）で登録者数。同一チャンネルは1回だけ
- 重複 videoId は統合し、ヒットした主ジャンル・掛け合わせ語・検索語を配列で保持

### クォータ（必須の制約）

- 1日上限 10,000ユニット。`search.list` は1回100ユニット
- `MAX_SEARCH_CALLS = 60`（6,000ユニット）を超えないこと。
  超える場合は日付ベースで日替わりローテーションし、翌日以降に回す
- 実行ログに消費ユニット概算を必ず出す
- **現在53語（主ジャンル12 + 掛け合わせ41）= 最悪 5,406ユニット/日**
  （search 5,300 + videos.list 53 + channels.list 53）。60語以下なのでローテーションは発動しない
- 語を足すときは必ず先に試算する。60語を超えると、超えた分はその日集まらない
- `HttpError 403 quotaExceeded` が出ても既存 `videos.json` を壊さない。
  部分的に取れた場合は既存データとマージして保存し、0件なら既存を残して終了する

### ふるい分け（必須。これが無いと使い物にならない）

`relevanceLanguage=ja` は**ヒントでしかない**。日本語の動画が少ない語では海外の動画が
そのまま返る。初回の実測では1,246件中193件（15%）が海外・無関係だった。
`apply_filters()` で収集の最後に3段のふるいをかける。順番も意味を持つ（除外語を先に見ることで
落とした理由が正しくログに出る）。

| 順 | 関数 | 落とすもの | 初回実測 |
|---|---|---|---|
| 1 | `is_japanese()` | 日本語でない動画 | 157件 |
| 2 | `excluded_word()` | `exclude` の語を含む動画 | 6件 |
| 3 | `is_relevant()` | `required_any` の語を1つも含まない動画 | 30件 |

`is_japanese()` は2段構え。`snippet.defaultAudioLanguage` / `defaultLanguage` の申告が
あればそれを信じ（`ja` で始まれば残す、それ以外の言語なら落とす）、申告が無いときだけ
タイトル＋チャンネル名の文字種で判断する。申告は `videos.list` の snippet に元から入って
いるので**追加のクォータはかからない**。判定根拠は `audioLanguage` として保存する。

`required_any` は Threads 版の `genres[].required_any` と同じ内容。テストで直接照合している。

**`exclude` に語を足すときは部分一致の巻き込みを必ず実データで確認すること。**
`コント` は「脊柱コントロール」を巻き込む。`ASMR`（benio店長など本物のヘッドスパ47件）と
`vlog`（現役エステティシャンの発信）は、あえて入れていない。

`--refilter` は API を呼ばずに既存 `videos.json` へふるいだけ掛け直す。
キーワード調整の効果をクォータ0で確かめるためのもの。`generatedAt` と `quotaUsed` は変えない。

### 実測値（2026-09-03 初回収集）

- 53語で **5,337ユニット**消費（試算の最悪5,406以内）
- 1,246件取得 → ふるい分け後 **1,053件**
- `パーマネントジュエリー` は**日本語の動画がほぼ無く0件**。検索すると YouTube が
  英語の "permanent jewelry" を返す（50件中ほぼ全部が海外チャンネル）。
  キーワードの問題ではなく供給の問題なので、語を変えるなら
  「パーマネントジュエリー 施術」のように日本語の文脈語を足す方向で試すこと。

### 辞書を変えたときの古いカテゴリ名

キーワード辞書を書き換えると、前回まで付いていたカテゴリ名が辞書から消える。方針は次のとおり。

- 収集が正常終了すれば `videos.json` は毎回作り直されるので、古い名前は自動的に消える
- クォータ切れで前回分を持ち越すときは `drop_unknown_labels()` が辞書に無い名前を落とす。
  主ジャンルが1つも残らない動画は持ち越さない（掛け合わせ語だけ消えた動画は残す）
- `history/` は videoId と再生数の突き合わせにしか使わないので、古い名前は画面に出ない

## スコア（`scoring.py`）

| 指標 | 計算 | 備考 |
|---|---|---|
| `velocity` | 再生数 ÷ max(公開からの経過日数, 1) | |
| `acceleration` | (今回 − 前回の再生数) ÷ 前回からの経過日数 | 前回データが無ければ `null`。`history/` の直近ファイルを参照 |
| `subRatio` | 再生数 ÷ max(登録者数, 100) | |

登録者100万人超のような外れ値は**除外しない**。UI 側の登録者数フィルタで対応する。

`isShort` は `durationSec <= 60`。YouTube は2024年10月からショートを最長3分まで
許しているが、API に判定用の項目が無い。3分で切ると普通の短い動画までショート扱いに
なるため、確実な60秒で線を引いている（`SHORT_MAX_SEC` で変えられる）。

## フロント（`docs/`）

- スマホ・PC 両対応。並び替え・期間・**主ジャンル・掛け合わせ語**（どちらも複数選択）・
  形式・登録者数上限・フリーワード検索・CSVダウンロード・最終更新日時の表示
- **カテゴリの絞り込みは2段構え。**上段が主ジャンル、下段が掛け合わせ語。
  - 段をまたぐと **AND**（「エステティシャン」かつ「経営」）
  - 同じ段の中は **OR**（複数選ぶと候補が広がる）
  - Threads / Instagram 版と同じ挙動。`../threads-trend-collector/scripts/build_html.py` が原型
- 0件のチップは消さず `pending` にして選べないことを見た目で示す。
  消すと扱う範囲が狭まったように見えるため
- 「伸び」は日本語で出す（例：「1日あたり 12,300 再生」）
- `videos.json` は**相対パス**で fetch する（`/リポジトリ名/` 配下で動かすため）
- 動画タイトル・チャンネル名は外部由来の文字列。`innerHTML` に入れず
  `textContent` で入れること（HTMLとして解釈させない）

## 日本語コピーの改行ルール

親の `../CLAUDE.md` のルールに従う。要点だけ再掲する。

- 単語の途中で改行しない。行頭に助詞を置かない
- 自分で書くUIラベルは `.nb`（`white-space: nowrap`）で文節ごとに括る。
  見出しやカテゴリ名は `word-break: keep-all` を併用する
- 動画タイトルなど外部由来の文字列は制御できないので、
  `word-break: normal` + `overflow-wrap: break-word` + `line-break: strict` で扱う
- 納品前に実際のレンダリングで改行位置を目視確認する

## 確認方法

```bash
python3 collector/collect.py --mock   # サンプルデータ生成
python3 tests/verify_collector.py     # 収集側 85項目
node tests/verify_app.mjs             # 画面側 65項目
python3 -m http.server 8000 --directory docs   # 目視確認
```

`--mock` は履歴が空のとき3日前のスナップショットも作る。
そうしないと加速度が全件 `null` になり、並び替えの確認ができないため。
