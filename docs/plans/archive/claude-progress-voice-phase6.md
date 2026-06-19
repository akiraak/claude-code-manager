# Phase 6: Web UI 再生 + ミラー表示

親プラン: [claude-progress-voice.md](claude-progress-voice.md)
前フェーズ: [phase5](claude-progress-voice-phase5.md)（ペルソナ文生成 + TTS）

Phase 6 のゴールは「`--mode server` のダッシュボード（ミラー）に **ボイスコントロール UI** を載せ、
SSE `voice-utterance` を受けて **順次再生**し、**履歴 + 再再生**を提供する」までを実装すること。

## 目的・背景

Phase 2〜5 でサーバ側が揃った:
- 集約ストア + ミラー配信（Phase 3, `RemoteEntrySource` → `renderDashboard`）
- voice-event → ペルソナ短文 → Gemini TTS → utterance ストア（Phase 5）
- 配信口: SSE `event: voice-utterance`（メタのみ）/ `GET /api/voice/audio/:id`（bytes）/ `GET /api/voice/recent.json`（履歴メタ）

残るはブラウザ側だけ。本フェーズは `views.ts` のダッシュボードに UI とクライアント JS を足す。

### 「ログイン UI」はスコープ外（再確認）
TODO 行に「ログインUI」とあるが、親プラン確定どおり **UI 認証は Cloudflare Access（email OTP, Phase 7）** に委譲する。
アプリ層でホームグロウンの password/session は作らない（Phase 3 の注記と同方針）。本フェーズは UI 認証を扱わない。

### 「ミラー表示」も大半は実装済み
ダッシュボードのミラー（カード描画 + 自己更新）は Phase 3 で server モードでも動く。
本フェーズの「ミラー表示」差分は **voice パネルを server モードのダッシュボードにだけ載せる**こと。

## 対応方針 / 設計判断

### 配置（`views.ts` の `renderDashboard` を拡張）
- `renderDashboard(entries, opts?: { voice?: boolean })` に変更。`opts.voice` のときだけ:
  - `VOICE_STYLE`（voice パネル専用 CSS）を `<style>` に追加
  - meta 行直下に **voice バー**（トグル/音量/種別フィルタ/端末フィルタ/履歴トグル/再生中表示）を出す
  - 末尾に `DASHBOARD_VOICE_SCRIPT`（再生 + フィルタ + 履歴）を出す
- 既定 `voice:false` で **local/client モードは現行どおり**（パネルもスクリプトも出ない＝後方互換）。
- `server.ts` の `/view` dashboard 分岐で `renderDashboard(entries, { voice: mode === 'server' })` を渡す。

### SSE は専用 EventSource を張る
既存 `DASHBOARD_LIVE_SCRIPT` の EventSource は再利用せず、voice 用に **独立した `EventSource('/api/watch')`** を張る。
- 理由: voice は server モード限定の独立機能。再接続は EventSource ネイティブに任せられ、live script との結合（再接続時のリスナ喪失）を避けられる。サーバの `voiceListeners` は Set なので複数購読 OK。
- コスト: server モードで 1 タブあたり `/api/watch` がもう 1 本増える。server モードの tick は集約ストア（メモリ）読みで安価なので許容。

### 再生（順次・autoplay 解除・古いものスキップ）
- 単一 `HTMLAudioElement` + キュー。同時再生しない。
- **🔊 トグル ON が autoplay 解除のユーザージェスチャ**を兼ねる（ブラウザの自動再生ブロック対策）。OFF なら再生しない（履歴には残す）。
- フィルタ通過（種別 + 端末）& `hasAudio` のものだけキュー投入。
- キューから取り出す時点で **古すぎる発話（既定 60 秒超）はスキップ**（溜まった分を一気に喋らない）。
- 音声取得は `fetch('/api/voice/audio/:id', { credentials: 'include' })` ではなく `audio.src` 直指定（同一オリジン + Cloudflare Access の cookie は自動付与される）。失敗（404/期限切れ）は握りつぶして次へ。

### コントロール（localStorage 永続）
- `ccm-voice-enabled`（'1'/'0', 既定 0=OFF。autoplay 都合で初期は OFF）
- `ccm-voice-volume`（0..100, 既定 80）
- `ccm-voice-kinds`（JSON 配列, 既定 `['completed','awaiting','progress']`）
- `ccm-voice-client`（clientId or '' =すべて, 既定 ''）
- 端末フィルタの選択肢は動的（utterance / recent.json で見た clientId を `<select>` に足す）。

### 履歴（再再生）
- 起動時に `GET /api/voice/recent.json` で初期化（新しい順メタ）。以降は SSE で先頭に push（上限 50 件・古いものを捨てる）。
- 行: 時刻（createdAtMs を client で整形）/ 種別ラベル / projectName / text /（hasAudio なら）「再生」ボタン。
- 「再生」は **明示的ユーザー操作なので OFF でも鳴らす**。現在のキュー再生を止めてその id を即再生。

### 整形の例外
カードは「client 側で再整形しない」方針だが、voice 履歴は SSR 等価物が無い client 専用 UI なので時刻整形は client 側 `toLocaleTimeString` で行う（パリティ対象外）。

## 影響範囲
- 変更: `views.ts`（`VOICE_STYLE` / `DASHBOARD_VOICE_SCRIPT` 追加・`renderDashboard` に `opts.voice`・voice パネル HTML）/ `server.ts`（`/view` dashboard 分岐で voice フラグを渡す）。
- 依存追加なし（ブラウザ標準 `EventSource` / `Audio` / `fetch` / `localStorage`）。
- local/client モード無改変（`voice:false` で従来出力）。
- 既存テストへの影響: `renderDashboard(entries)` 呼び出しは引数追加が optional なので不変。

## テスト方針
- `views.test.ts` 追加:
  - `renderDashboard(entries, { voice: true })` で voice パネルのフック（`data-voice-bar` / `data-voice-toggle` / `data-voice-volume` / `data-voice-kind` / `data-voice-client` / `data-voice-history` / `DASHBOARD_VOICE_SCRIPT` 由来の `/api/voice/audio/` 参照）が出る。
  - 既定（`voice` 無し）では voice パネルもスクリプトも **出ない**（後方互換）。
  - voice:true でも従来のカード/差分パッチ用フックは維持される。
- 再生ロジック（キュー/フィルタ/古いスキップ）はブラウザ JS（文字列）なので単体テスト対象外。文字列に必要な分岐が含まれることを軽く assert する程度に留め、実挙動は手動スモークで確認。

## Step 分解
- [x] Step 1: `views.ts` — `VOICE_STYLE` + voice パネル HTML + `DASHBOARD_VOICE_SCRIPT` + `renderDashboard` の `opts.voice` 化 + `views.test.ts`
- [x] Step 2: `server.ts` — `/view` dashboard 分岐で `{ voice: mode === 'server' }` を渡す
- [x] Step 3: `npm run build` + `npm test` 緑 / server モード実走スモーク（SSE→再生 UI の目視確認手順）/ プラン・TODO 更新

## 実装メモ（確定）
- `renderDashboard(entries, opts?: { voice?: boolean })`。既定 `voice:false` で local/client は素の出力（後方互換）。`server.ts` の `/view` dashboard 分岐だけ `mode === 'server'` を渡す。
- voice パネルと `DASHBOARD_VOICE_SCRIPT`・`VOICE_STYLE` は `voice:true` のときだけ HTML に含める。
- SSE は voice 専用の独立 `EventSource('/api/watch')`（live script とは別）。再接続は EventSource ネイティブ任せ。
- 単一 `Audio` + キューで順次再生。`audio.onended` / `audio.onerror`（addEventListener ではなく単一スロット）で「再生中の途中差し替え（履歴の再生ボタン）」でもリスナが多重化しない。
- 種別チェックボックスの SSR 初期値は全 ON。JS 起動時に localStorage で上書き（JS なしでも崩れない）。
- 履歴時刻は client 側 `toLocaleTimeString`（SSR 等価物の無い client 専用 UI なのでパリティ対象外）。

## 実走ログ

### 2026-06-18 実装 + テスト
- 変更: `views.ts`（`VOICE_STYLE` / `renderVoiceBar` / `DASHBOARD_VOICE_SCRIPT` 追加・`renderDashboard` に `opts.voice`）/ `server.ts`（`/view` dashboard で `{ voice: mode === 'server' }`）。
- 追加テスト: `views.test.ts` に voice パネルのフック有無（voice:true/false/未指定）+ 従来フック維持の 4 ケース。
- 結果: `npm run build` 通過 / `npm test` = **136 tests, 136 pass, 0 fail**（Phase 5 の 132 → +4）。

### 2026-06-18 server モード実走スモーク（TTS off・persona は .env の Haiku）
- `--mode server --port 8193`、`CCM_VOICE_TTS_PROVIDER=none`（音声課金なし・`hasAudio:false`）。
- `GET /view?item=dashboard` → `data-voice-bar` / `data-voice-toggle` / `.voice-bar` / `EventSource('/api/watch')` / `/api/voice/recent.json` を確認（= server モードで voice パネル + 再生スクリプトが載る）。
- SSE 購読中に `POST /api/ingest/voice-event {completed,foo}` → 200 → SSE `event: voice-utterance` で `{id,text:"fooが完成したんですね。お疲れさま。",kind:completed,clientId:smoke-host,projectName:foo,createdAtMs,hasAudio:false}` を受信。
- `GET /api/voice/recent.json` に同 utterance 1 件。
- 残: ブラウザ実機での「トグル ON → 順次再生 → 音量 → フィルタ → 履歴再生」の目視と、Gemini 実音での再生確認は Phase 7/8 の E2E（Cloudflare Access 越し）に委ねる。

## 残課題（Phase 7/8）
- 実 E2E（Cloudflare Tunnel + Access 越し）= Phase 7/8。
- WAV24k のまま配信。帯域/iOS 互換で mp3/opus 変換が要れば後追い。
- iOS Safari の autoplay/サイレントスイッチ挙動の実機確認 = Phase 8。
