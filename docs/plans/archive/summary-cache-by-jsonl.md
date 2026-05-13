# 要約キャッシュを jsonl 単位に変更する

## 目的・背景

ダッシュボードのカードに出る AI 要約が、jsonl が更新されるたびに「表示済みのテキスト → 要約ボタン」に戻ってしまう問題を直す。

現在の `Summarizer` は `(jsonlPath, mtimeMs)` 複合キーでキャッシュしている。`readSummaryStatus` は `peek(jsonlPath, mtimeMs)` を呼んでおり、Claude Code CLI が jsonl を 1 行でも追記して mtime が変わると peek が miss し、`idle` に巻き戻る。結果として:

1. ユーザーが「要約」ボタンを押す
2. 要約が表示される
3. CLI が動いて jsonl が更新される
4. `mtimeMs` が変わる → peek miss → カード上の要約テキストが消えて「要約」ボタンに戻る
5. ユーザーがまた押す

の繰り返しになる。

要約はあくまで「今までの会話の要約」なので、jsonl が 1 行追記された程度で消す必要はない。最後に成功した要約を `peek` 経由で「古いけど表示し続ける」ようにし、UI 側で「(古い)」とだけ示せば十分。

## 対応方針

### `Summarizer` (`ai-monitor/src/summarize.ts`)

- `cache` を `Map<jsonlPath, { result: SummaryResult; mtimeMs: number }>` に変更
- `inflight` のキーも `jsonlPath` 単体に変更 (mtime 抜き)
- `SummaryResult` に `stale?: boolean` を追加 (生成時 false / 省略、`readSummaryStatus` 側で立てる)
- `peek(jsonlPath)` → `{ result, mtimeMs } | undefined` を返す
- `isInflight(jsonlPath)` → mtime なし
- `getOrCompute(jsonlPath, mtimeMs, input)`:
  - `cached?.mtimeMs === mtimeMs` のときだけキャッシュをそのまま返す
  - ずれていれば再計算を開始 (inflight なら再起動しない)、戻り値は `pending`
  - 旧結果は `peek` 経由で表示され続ける (cache 上書きは新結果完了時)
- `startCompute(jsonlPath, mtimeMs, input)`: 完了時にキャッシュへ `{ result, mtimeMs }` を書く
- `onUpdate(key, result)` の `key` セマンティクスは `jsonlPath` に変わる (server.ts は dashboard 再取得のみ呼んでいるので影響なし)

### `state.ts` の `readSummaryStatus`

- `peek(jsonlPath)` の戻り `cached` を見る
- `cached` あり: `result` を返し、`cached.mtimeMs !== mtimeMs` なら `stale: true` を付ける
  - inflight 中でも `cached` があれば古いまま表示する (= 再計算中に空白にしない)
- `cached` なし & `isInflight` → `pending`
- それ以外 → `idle`

### UI (`views.ts`)

- CSS: `.card-summary-stale` を追加。色を `#888` 程度に落とす
- `renderSummaryFromData` (サーバ) と `DASHBOARD_LIVE_SCRIPT` 内の `renderSummary` (クライアント) を両方更新
  - `state === 'ok' && stale` のとき本文ラベルを「要約 (古い)」にし、ラッパに `card-summary-stale` クラスを足す
  - `data-summary-key` は本文 hash のままにする → 同じテキストなら展開状態が保持される

## 影響範囲

- `ai-monitor/src/summarize.ts`: 内部実装 + 公開 API のシグネチャ
- `ai-monitor/src/state.ts`: `readSummaryStatus` のみ
- `ai-monitor/src/views.ts`: CSS + `renderSummaryFromData` + クライアント `renderSummary`
- `ai-monitor/src/views.test.ts`: stale 表示のテストを追加

`server.ts` 側の呼び出し (`getOrCompute` / `onUpdate`) はシグネチャ的にそのまま (引数は変わらず、key の意味が変わるだけ)。

## テスト方針

- `views.test.ts` で `summary: { state: 'ok', text: '…', stale: true }` のレンダリング結果に `card-summary-stale` と「(古い)」が出ることを確認
- 既存テストは変更なしで通る (state: 'ok' (stale 省略) のときは既存挙動と同じ)
- 手動確認: 要約済みカードで CLI が次のターンを走らせ、jsonl mtime が変わったときに
  - カード上の要約テキストが消えないこと
  - 表示が薄くなって「(古い)」が出ること
  - もう一度「要約」ボタンを押すと再計算が走り、古い表示 → 新しい表示 に切り替わること
