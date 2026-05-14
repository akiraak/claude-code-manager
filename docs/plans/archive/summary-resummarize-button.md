# 要約済みカードでも「再要約」ボタンを出す

## 目的・背景

要約結果がキャッシュされている (= state が `ok`) カードでも、ユーザーが任意のタイミングで
再要約をかけられるようにしたい。

現状、`Summarizer.getOrCompute` は `jsonlPath` 単位のキャッシュにヒットすると
無条件で旧結果を返すため、jsonl が動かない限り「古い」要約が貼り付いたままになる。
UI 側にも再要約のトリガが無い (`idle` 状態でしか 要約 ボタンが出ない)。

## 対応方針

### バックエンド

- `Summarizer.getOrCompute` / `wait` に `opts: { force?: boolean }` を追加。
  `force` 時はキャッシュチェックをスキップして必ず `startCompute` (もしくは inflight 共有)。
- `/api/summarize` で `?force=1` を受け取り `getOrCompute` に伝搬。

### UI

- `renderSummaryFromData` の `ok` ブランチに「再要約」ボタンを追加。
  既存「展開」トグルと並べるため `.card-summary-actions` ラッパで横並びにする。
- スタイルは新クラス `.summarize-btn-link` を追加 (`.card-summary-toggle` と同じ
  テキストリンク調)。idle 状態の大ボタン `.summarize-btn` とはサイズが違うので別クラス。
- クリックハンドラを `.summarize-btn` と `.summarize-btn-link` の両方に対応させ、
  `data-force="1"` があれば `&force=1` を付ける。`wrap` は `.closest('.card-summary')`
  で辿る (OK ブランチではボタンが `.card-summary-content` の中なので親と異なる)。
- 同じ DOM 構造を `DASHBOARD_LIVE_SCRIPT.renderSummary` 側にも反映 (SSE 再描画後にも
  再要約ボタンが残るようにする)。

## 影響範囲

- `ai-monitor/src/summarize.ts` — `getOrCompute` / `wait` シグネチャに `opts` 引数追加 (後方互換)
- `ai-monitor/src/server.ts` — `/api/summarize` で `?force=1` を解釈
- `ai-monitor/src/views.ts` — CSS + OK ブランチ HTML + SSE 側 renderSummary + クリックハンドラ
- `ai-monitor/src/views.test.ts` — OK ブランチに 再要約 ボタンが出ることを 1 assert で追加

## テスト方針

- 既存 28 ケースが通ること (主に既存 OK ブランチ assert が新構造でも壊れないこと)
- OK ブランチに `summarize-btn-link` + `data-force="1"` ボタンが含まれるアサート追加
- 手動: vibeboard 側でカードの再要約ボタンを押下 → 「要約中…」表示 → 新要約に置換、を確認
