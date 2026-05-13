# ダッシュボード調整 (2026-05-12)

## 目的・背景

ダッシュボードカードの表示が冗長 / 順序が分かりにくい、また Claude API 要約が常時走るためコストが気になる。
TODO.md の以下 4 項目をまとめて実装する。

- プロセスのディレクトリ名が冗長。一番下だけでいい（例: `claude-code-manager`）
- 要約は要約ボタンで行うようにする。リアルタイムは削除
- 要約は「要約」と先頭に付ける
- 要素の並びは「ユーザー」「claude」「要約」

## 対応方針

### 1. ディレクトリ名は basename のみ

- `views.ts` の `renderCard` で `<span class="card-cwd">` に `path.basename(entry.cwd)` を出す
- `views.ts` の `renderProcessView` で `<h1>` を basename にして、フルパスは meta 行に置く
- `server.ts` の `buildSidebarItems` で `label: e.cwd` → basename にする (sub に残らない場合は cwd を別途出さない)

### 2. 要約はボタン起動 (リアルタイム削除)

- `state.ts buildEntries` から `summarizer.getOrCompute` の呼び出しを削除。代わりに以下のいずれかを `summary` にセット:
  - API キー無し: `{ state: 'unavailable' }`
  - キャッシュ有り: そのまま
  - inflight 中: `{ state: 'pending' }`
  - それ以外: `{ state: 'idle' }` (新規ステート: 「要約」ボタンを出す用)
- `summarize.ts` に `isInflight(jsonlPath, mtimeMs)` を追加 (`peek` は既存)
- `summarize.ts` の `SummaryState` に `'idle'` を追加
- `server.ts` に `POST /api/summarize?id=...` エンドポイントを追加。リクエストを受けて `summarizer.getOrCompute` を呼び、即座に状態 JSON を返す。完了は既存 `onUpdate → SSE item-changed` 経由で UI に反映される
- 既存 SSE 自動更新 (要約完了 → 全 listener 通知 → iframe 再読み込み) はそのまま使う

### 3. 要約の先頭に「要約: 」を付ける

- `views.ts renderSummary` の `state === 'ok'` 分岐で本文の先頭に `要約: ` を付与
- 既存の「(要約: API キー未設定)」は仕様通りなのでそのまま

### 4. カード内要素順を ユーザー → Claude → 要約 に

- `views.ts renderCardBody` で `${renderSummary(...)}` を user / assistant のあとに移動
- 区切り線 (`border-top`) は user / assistant と統一する

## 影響範囲

- `ai-monitor/src/views.ts` (カード描画 / 要約描画 / 小さなクライアント JS 追加)
- `ai-monitor/src/state.ts` (`buildEntries` での summary セット方針変更)
- `ai-monitor/src/summarize.ts` (`isInflight` 追加 / `SummaryState` に `'idle'`)
- `ai-monitor/src/server.ts` (`POST /api/summarize` 追加 / `buildSidebarItems` の label を basename に)
- 既存の SSE / `onUpdate` の仕組みはそのまま使う

vibeboard 側 (`app.js`) は SSE `item-changed` で iframe を reload するだけなので変更不要。

## テスト方針

- `npm run build` で TypeScript 通る
- 手動: `./run-ai-monitor.sh` 起動 → ダッシュボード表示
  - カードの cwd 表示が basename のみになっているか
  - サイドバーの label が basename になっているか
  - 初期表示で要約は出ず「要約」ボタンが表示されるか
  - ボタンを押すと「要約中…」になり、完了後に「要約: ...」と表示されるか
  - 表示順が ユーザー → Claude → 要約 になっているか
  - API キー未設定環境でも「(要約: API キー未設定)」が同じ位置に出るか
