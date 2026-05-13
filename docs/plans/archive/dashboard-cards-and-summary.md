# Dashboard カード化 + AI 要約

## 目的・背景

現状の AI Monitor ダッシュボードは「cwd / PID / state / 最終活動 / 直近イベント (80 文字)」の表形式。
情報は揃っているが、複数 CLI を眺めて「今これは何をやっていて、どこまで進んだのか」が把握しづらい。

本タスクでは以下を達成する。

- **カード化**: CLI 1 件 = 1 枚のカードで、最後のユーザー入力と最後の AI 返信を本文プレビュー付きで一目で見える形に再構成する
- **AI 要約**: セッション全体の進捗を 1〜2 行に要約する Claude API 呼び出しを ai-monitor サーバに組み込み、カード上部に表示する
- **状態バッジの再設計**: 現在の active/recent/idle 三状態を「AI処理中 / 待機中 / 停止 / エラー」へ置き換える
- **停止 CLI の保持**: プロセスが消えた直後 (= 直近 N 分以内に停止) のものは「停止」バッジ付きでカードに残す

非ゴール:

- プロセス詳細ビューの再設計 (TODO の 3 つ目「tool_use/tool_result グループ化」は別タスク)
- 要約の品質チューニング / プロンプトテンプレートの精緻化 (MVP は素朴な単発プロンプト)
- 過去セッション (停止 N 分以降の `jsonl` のみ残っている session) の探索 UI

## 方針

### カード UI

ダッシュボードの `<table>` を `<div class="card">` のグリッドに置き換える。1 枚のカードは縦に次のセクションを持つ。

```
┌─────────────────────────────────────┐
│ [● AI処理中]  /home/ubuntu/foo  PID 12345  3s ago │  ← ヘッダ (state badge / cwd / PID / last activity)
├─────────────────────────────────────┤
│ 📝 要約: ... (Claude API 1〜2 行)    │  ← AI 要約 (Phase 2 で挿入。Phase 1 は placeholder)
├─────────────────────────────────────┤
│ 👤 ユーザー (3 分前)                  │
│   最後のユーザー入力の本文プレビュー... │  ← 2〜3 行 (max 240 文字程度) + 末尾 …
├─────────────────────────────────────┤
│ 🤖 Claude (1 分前)                   │
│   最後の AI 返信の本文プレビュー...    │  ← 同上
└─────────────────────────────────────┘
```

クリックでプロセス詳細ビュー (既存 `#ai-monitor/proc:<id>`) に遷移。

### state バッジの再設計

`MonitorEntry.state` の型を以下に変える。

| state          | 判定条件                                                                                          | バッジ色 |
| -------------- | ------------------------------------------------------------------------------------------------- | -------- |
| `ai-processing`| プロセス生存 かつ jsonl mtime が 30 秒以内 (= ターンが進行中で頻繁に書き出されている)             | 緑       |
| `waiting`      | プロセス生存 かつ jsonl mtime が 30 秒超 (ユーザー入力待ち、または長時間動いていないがプロセスあり) | 青       |
| `stopped`      | プロセス消滅 かつ jsonl mtime が `STOPPED_RETENTION_SEC` (= 600s = 10 分) 以内                    | 灰       |
| `error`        | プロセス消滅 かつ 末尾イベントが `tool_use` のままで `tool_result` が無い (= ターン途中で死んだ)   | 赤       |

**Why:** ユーザーが見たいのは「これは今 AI が考えているのか、こっちからの入力待ちなのか、もう死んでいるのか」の区別。現状の active/recent/idle は時間軸でしか分けていないため「待機中なのか処理中なのか」が分からない。

判定はサーバ側 (`state.ts` / `transcript.ts`) で行い、フロントは表示のみ。

**Why `ai-processing` を「最近 jsonl が更新された」で判定するか:**
- 進行中ターンの本文は jsonl に出ないが、ターン内の tool_use/tool_result はその場で追記される (現行の挙動)
- なので「直近 30 秒で jsonl が動いた」≒「AI がツールを使って動き続けている」と近似できる
- 完全な精度は要らない。ユーザーが「今そっとしておくべきか」を判断できれば十分

### 停止 CLI の保持

`buildEntries` を「現在のプロセス起点」から「現在のプロセス ∪ 直近 10 分以内に jsonl が更新された CLI」へ拡張する。

実装:

1. `listClaudeProcesses()` の結果 + `listTranscripts()` の結果 をマージ
2. プロセスが居ない transcript は「停止 or エラー」候補
3. jsonl mtime が `STOPPED_RETENTION_SEC` 超のものは除外 (ダッシュボードから消える)

これで「さっきまで動いていた CLI」もカードに残り、停止バッジ + 最後の AI 返信を確認できる。

### AI 要約

- **対象**: セッション末尾 N 件 (N=40 程度) のイベントから、現在のタスクの「概要 + 進捗」を 1〜2 行 (200 文字以内程度)
- **タイミング**: jsonl 更新時に自動 (現行 SSE のポーリング 2 秒間隔で、新しい mtime を検出した時)
- **モデル**: `claude-haiku-4-5-20251001` (要約はコスト感度高い、Haiku 4.5 で十分)
- **キャッシュ**:
  - キー: `${jsonlPath}@${mtimeMs}`
  - 値: `{ summary: string, generatedAt: number }`
  - メモリ内 `Map`。サーバ再起動で消えてよい (永続化しない)
  - 同じキーで重複呼び出しを抑止 (in-flight Promise も保持)
- **API キー**: `.env` (claude-code-manager 直下) に `ANTHROPIC_API_KEY=...` を置き、`dotenv` で `ai-monitor` 起動時に読む。`.env` は `.gitignore` 済みを確認、無ければ追加
- **キー無し時の振る舞い**: 要約機能を黙って無効化。カードの要約スロットは「(要約: API キー未設定)」と薄色で表示。ログには起動時に 1 度 warn を出す
- **プロンプト雛形** (Phase 2 で確定。MVP 版):

  ```
  System: あなたは Claude Code CLI のセッションログを読み、現在のタスクの概要と進捗を日本語 1〜2 行で要約するアシスタントです。冗長な前置きや「要約します」のような枕は付けないでください。

  User: 以下は Claude Code CLI のセッション末尾です。最初のユーザー入力と直近のやりとりから「今このセッションは何をしていて、どこまで進んだか」を 1〜2 行で要約してください。

  ---
  {末尾 N イベントを user/assistant/tool それぞれ短くしてテキスト化、合計 4000 文字以内に収めて投入}
  ---
  ```

- **エラー時**: 4xx (キー不正等) はキャッシュに「unavailable」を入れて沈黙。5xx / ネットワークエラーは 60 秒後にリトライ可能とする
- **コスト感**: Haiku 4.5 / 入力 ~2000 token / 出力 ~80 token / セッション 1 件あたり jsonl 更新ごと。10 CLI × 1 分に 1 回更新で 600 リクエスト/h 程度を上限と想定。問題があれば「最低更新間隔 (= 1 分) を入れる」までスロットリングを追加

### 影響範囲

- `ai-monitor/src/state.ts`: `ActivityState` 型再定義、`buildEntries` の停止 CLI 保持と新しい判定ロジック
- `ai-monitor/src/transcript.ts`: 末尾イベントから「最後の user-text」「最後の assistant-text」「末尾が tool_use のまま (error 判定用)」を取り出すヘルパ追加
- `ai-monitor/src/views.ts`: ダッシュボード描画をテーブル→カードへ書き換え、新しいバッジクラス
- `ai-monitor/src/summarize.ts` (新規): Anthropic SDK 経由の要約クライアント + キャッシュ
- `ai-monitor/src/cli.ts` or `server.ts`: `dotenv` 読み込み、API キーの起動時チェック、要約クライアントの DI
- `ai-monitor/package.json`: `@anthropic-ai/sdk` と `dotenv` を追加
- `ai-monitor/src/server.ts`: `/api/sidebar` / dashboard ビューに要約を流し込む。SSE 側で要約完了時にも `item-changed` (dashboard) を push
- ルート `.gitignore`: `.env` の ignore を確認

## Phase / Step 構成

### Phase 1 — カード化 + 状態バッジ刷新 (要約抜き)

要約機能と独立して進められる UI 改修。Phase 2 と分離してマージ可能な状態で完了させる。

- **Step 1.1**: `state.ts`
  - `ActivityState` を `'ai-processing' | 'waiting' | 'stopped' | 'error'` へ変更
  - 新ヘルパ `classifyV2(opts: { hasProcess, lastActivityAt, lastEventKind })`
  - `buildEntries` を改修: プロセスが居ない transcript も `STOPPED_RETENTION_SEC` 以内なら entry として返す。`process` フィールドは optional のまま
- **Step 1.2**: `transcript.ts`
  - `summarizeTail(events): { lastUserText, lastUserAt, lastAssistantText, lastAssistantAt, lastEventKind }` を追加
  - 既存 `summarizeLastEvent` は views から消すか、deprecated として残す
  - `tool_use` が末尾でその後 `tool_result` が無いかどうかも返す (error 判定用)
- **Step 1.3**: `views.ts`
  - `renderDashboard` をカード描画へ置き換え。CSS に `.card`, `.card-header`, `.card-summary`, `.card-user`, `.card-assistant`, `.badge-ai-processing` 等を追加
  - クリック領域はカード全体に拡張 (`<a class="card">` で囲む or `cursor: pointer` + `onclick`)
  - サイドバー側 (`server.ts: buildSidebarItems`) のバッジ文字 (`●◐○`) も新 state に対応させる (`●` = active 系, `□` = stopped 系, など簡単な記号)
- **Step 1.4**: 検証
  - `claude` を 2 つ立ち上げてカードが 2 枚並ぶこと
  - 片方を `Ctrl+C` で止め、10 分以内なら「停止」カードとして残ること、10 分後に消えること
  - state バッジが意図通り切り替わること (ai-processing/waiting/stopped/error)

### Phase 2 — AI 要約バックエンド

要約クライアント単体で動くようにし、API キー無しでもサーバが起動できることを保証する。

- **Step 2.1**: 依存追加
  - `ai-monitor/package.json` に `@anthropic-ai/sdk` `^0.x` (Claude Opus 4.7 / Haiku 4.5 を呼べる版) と `dotenv` を追加
  - `npm install` を回す
- **Step 2.2**: `.env` 取り込み
  - `ai-monitor/src/cli.ts` (もしくは `server.ts` 冒頭) で `dotenv.config({ path: <repo root>/.env })` を呼ぶ
  - 解決先は ai-monitor から 1 階層上 (`path.resolve(__dirname, '../../.env')`)
  - 起動時に `ANTHROPIC_API_KEY` の有無を 1 行ログ
- **Step 2.3**: `summarize.ts` 実装
  - 公開 API: `class Summarizer { async getOrCompute(jsonlPath: string, mtimeMs: number, events: NormalizedEvent[]): Promise<SummaryResult> }`
  - `SummaryResult = { state: 'ok'|'pending'|'unavailable'|'error', text?: string, generatedAt?: number }`
  - キャッシュ Map と in-flight Promise Map を内部に持つ
  - API キー未設定なら常に `{ state: 'unavailable' }` を即返す
  - プロンプトは「方針」節の雛形どおり。`messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, ... })`
  - prompt caching: system プロンプトに `cache_control: { type: 'ephemeral' }` を付けてキャッシュヒットを狙う
- **Step 2.4**: 単体検証
  - 最小サンプル jsonl を 1 本ハードコード入力にして `node -e "..."` で `Summarizer.getOrCompute` を呼び、1〜2 行の要約が返ること、2 回目が即時 (キャッシュヒット) なこと
  - API キー未設定環境で `unavailable` が返ること

### Phase 3 — UI と要約の接続 / SSE

要約結果をカードに流し込み、jsonl 更新 → 要約再計算 → SSE で push の流れを完成させる。

- **Step 3.1**: `state.ts` の `MonitorEntry` に `summary?: SummaryResult` を追加。`buildEntries` から `Summarizer.getOrCompute` を呼ぶ (await はせず、キャッシュにあれば使う / 無ければバックグラウンドで生成し `pending` を返す方針でも可)
- **Step 3.2**: `views.ts` のカードに要約スロットを実装。`state` ごとに表示を分ける:
  - `ok`: 要約テキスト
  - `pending`: 「要約中…」 + 小さなスピナー (CSS のみ)
  - `unavailable`: 「(要約: API キー未設定)」を薄色で
  - `error`: 「(要約失敗)」 + 詳細はサーバログ
- **Step 3.3**: SSE 連携
  - `server.ts: /api/watch` のポーリングで「mtime 変化を検知したら `Summarizer.getOrCompute` を fire-and-forget で呼ぶ」処理を追加
  - 要約完了をトリガに `event: item-changed { id: 'dashboard' }` を push する仕組みを入れる (Summarizer 側に「完了時コールバック」を持たせ、`/api/watch` のハンドラがそれを購読)
- **Step 3.4**: 結合検証
  - `claude` 2 本立ち上げ → ダッシュボードのカードに要約が出る
  - 片方で何か追加プロンプトを投げて jsonl 更新 → 「要約中…」→ 数秒後に新しい要約が出る
  - API キーを外して起動 → 「(要約: API キー未設定)」が出る、サーバは落ちない

### Phase 4 — 後片付け

- **Step 4.1**: `README.md` / `CLAUDE.md` の AI Monitor セクションに「`.env` に `ANTHROPIC_API_KEY` を入れる」「要約機能はオプション」を追記
- **Step 4.2**: `TODO.md` の対応項目 (カード化 / AI 要約) を `DONE.md` へ移動
- **Step 4.3**: 本プランを `docs/plans/archive/` へ移動

## テスト方針

- **カード描画**: `claude` プロセス 0/1/3 件のそれぞれで `/view?item=dashboard` を curl し、HTML が崩れていないこと
- **停止 CLI 保持**: プロセスを kill した直後・5 分後・10 分超のそれぞれでダッシュボードに残る/消える挙動を目視確認
- **状態バッジ**: 4 状態それぞれを意図的に作って (`ai-processing` は重い tool_use を走らせる、`waiting` は assistant 返信直後、`stopped` は kill、`error` は tool_use の途中で kill) バッジ表示を確認
- **要約**:
  - API キー有り環境で 1 セッションを動かし、要約が出ること、jsonl 更新で再生成されること
  - API キー無し環境でサーバが落ちず、`unavailable` 表示になること
  - 同じ mtime で 10 回続けて curl してもキャッシュヒットで 1 回しか API が叩かれないこと (Anthropic のダッシュボードか、内部のリクエストカウンタで確認)
- **既存ビューの非破壊**: プロセス詳細ビュー (`/view?item=proc:<id>`) は触らない。Phase 1/3 完了後も従来どおり動くこと

## 確定事項 / 検討メモ

- **API キー管理**: `.env` ファイルで管理 (ユーザー確認済み)。`dotenv` を ai-monitor 起動時に読む
- **要約モデル**: `claude-haiku-4-5-20251001` で開始。重い場合 Sonnet 4.6 への切り替えは Phase 5 以降
- **状態の集合**: AI処理中 / 待機中 / 停止 / エラーの 4 種 (ユーザー確認済み)
- **停止 CLI の保持時間**: 10 分。設定値化は将来必要になったら検討
- **Phase 1 と Phase 2-3 は独立してマージ可能**: Phase 1 だけ先に出してもダッシュボードはカード化された状態で機能する。要約が無いだけ
