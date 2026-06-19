# Phase 5: ペルソナ文生成 + TTS

親プラン: [claude-progress-voice.md](claude-progress-voice.md)
前フェーズ: [phase4](claude-progress-voice-phase4.md)（uplink クライアント）

Phase 5 のゴールは「`--mode server` が受け取った voice-event を、ちょビ口調の短文 → 音声バイトに変換し、
utterance ストアに積んで `GET /api/voice/audio/:id` で配信・SSE `voice-utterance` で push する」までを実装すること。
ブラウザ側の再生 UI（ON/OFF・音量・履歴・順次再生）は Phase 6。

## 目的・背景

Phase 2〜4 で「端末 → 公開サーバへ snapshot / voice-event を push する経路」と「集約ストア + ミラー配信」が揃った。
本フェーズはサーバ側に **音声生成パイプライン** を足す。流れは:

```
POST /api/ingest/voice-event  (Phase 2/4)
  → AggregateStore.recordVoiceEvent (既存)
  → VoicePipeline.handle(event)        ← 本フェーズ (fire-and-forget)
       1. PersonaGenerator: event → ちょビ口調の短文 (Anthropic Haiku, 純関数プロンプト, キャッシュ)
       2. TtsProvider.synthesize: 短文 → WAV24k バイト (Gemini 既定, 抽象 + キャッシュ)
       3. VoiceStore.put: utterance(id, text, audio, meta) を TTL 付きで保持 (乱数 id)
       4. onUtterance: SSE listeners へ voice-utterance を push (メタのみ。bytes は別 fetch)
  → GET /api/voice/audio/:id           ← 本フェーズ (bytes 配信。乱数 id = capability)
```

## 対応方針 / 設計判断

### 発話対象の限定
要件 #3「指示受信では発話しない（タイマー起動のみ）」に従い、`started` は **音声化しない**。
`SPOKEN_KINDS = ['awaiting', 'completed', 'progress']` のみパイプラインを通す（`started` は store 記録のみ）。

### ペルソナ（`persona.ts` + `voice-persona.json`）
- `voice-persona.json`（`ai-monitor/` 直下・編集可能・gitignore しない）に ai-twitch-cast の「ちょビ」を移植:
  `name` / `ttsVoice`(Leda) / `ttsStyle` / `systemPrompt` / `rules`。
- `loadPersona(path?)`: JSON を読み、欠落フィールドは `DEFAULT_PERSONA` で補完。ファイル不在/壊れていても落ちず既定。
- `buildPersonaPrompt(persona, input)`: **純関数**。system（ちょビ性格 + 「進捗を1文・最大50字程度・記号/絵文字なし・
  『コメントありがとう』で始めない・感嘆符1文1個」+ rules）と user（種別/プロジェクト名/詳細）を組み立てる。
- `PersonaGenerator`: `summarize.ts` の Anthropic 利用パターン踏襲。`hash(kind|detail|projectName)` でメモリキャッシュ。
  - API キー未設定 or 失敗時は **テンプレ fallback**（`fallbackLine`）にフォールバックして必ずテキストを返す
    （Gemini キーだけでも音声が出る）。テスト用に `generate` 関数を注入可能。

### TTS（`tts.ts`）
- `interface TtsProvider { readonly tag: string; isEnabled(): boolean; synthesize(text): Promise<TtsResult|null> }`。
  `TtsResult = { bytes: Buffer; mime: string }`。
- `GeminiTtsProvider`: Phase 1 PoC（`poc/voice/tts-poc.mjs`）の HTTP 直叩きを移植。
  `gemini-2.5-flash-preview-tts`（既定・`GEMINI_TTS_MODEL` で上書き）/ voice `Leda` / style 前置 → PCM s16le 24k →
  `pcmToWav` で WAV ラップ → `{bytes, mime:'audio/wav'}`。`fetchImpl` 注入でテスト可能。
- `NullTtsProvider`: キー未設定時。`isEnabled()=false`・`synthesize()=null`。
- `CachingTtsProvider`: 任意の provider をラップし `sha256(tag + '\n' + text)` でバイトをキャッシュ（`hash(text+voice)` 相当）。
- `pcmToWav`: PoC 同等（44byte RIFF/PCM・1ch・16bit・24kHz）。
- `selectTtsProvider(env, persona)`: `CCM_VOICE_TTS_PROVIDER`（既定 gemini / none）で選択し Caching でラップ。

### utterance ストア（`voice-store.ts`）
- `Utterance = { id, text, kind, clientId, projectDir, projectName?, createdAtMs, audio?: {bytes, mime} }`。
- `put` は **`crypto.randomBytes(16).toString('base64url')`** で **推測困難 id** を採番（= capability。「認証付き」の app 層の実体）。
- TTL（既定 1h）+ 件数上限（既定 200・古い順退避）でメモリを制限。`now` 注入でテスト可能。
- `get(id)` は prune 後に返す。`recent(limit)` は bytes 抜きメタを新しい順（Phase 6 履歴 UI 用に用意）。

### オーケストレーション（`voice-pipeline.ts`）
- `VoicePipeline.handle(event)`: 上記 1〜4。`try/catch` で **絶対に throw しない**（ingest を巻き込まない）。
- `started` と空テキストはスキップ。`onUtterance(u)` で SSE push。

### 配線（`ingest.ts` / `server.ts` / `cli.ts`）
- `IngestDeps` に `onVoiceEvent?(v)` を追加。`recordVoiceEvent` 後に呼ぶ。server が `v => void pipeline.handle(v)` を渡す（非同期・即 200）。
- server モードのみ: persona/tts/voiceStore/pipeline を構築。`voiceListeners` セットを用意し pipeline の `onUtterance` で発火。
- `/api/watch` に voice listener を登録し `event: voice-utterance\ndata: {id,text,kind,clientId,projectName,createdAt}\n\n` を書く（bytes は載せない）。
- `GET /api/voice/audio/:id`（**server モードのみマウント**）: id 検証 → utterance 取得 → `audio` あれば mime + bytes 配信、無ければ 404。`Cache-Control: no-store`。
- 「認証付き」= 乱数 id（capability）+ server モード限定マウント + 本番は Cloudflare Access 配下（Phase 7 インフラ）。app 層でホームグロウン認証は作らない（親プラン方針）。

## 影響範囲

- 新規: `persona.ts` / `tts.ts` / `voice-store.ts` / `voice-pipeline.ts` / `voice-persona.json` + 各 `*.test.ts`。
- 変更: `ingest.ts`（`onVoiceEvent` 追加・後方互換）/ `server.ts`（server モードで pipeline 構築 + audio エンドポイント + SSE voice-utterance）/ `cli.ts`（起動ログに TTS/persona 状態）。
- 依存追加なし（global `fetch` で Gemini を直叩き。`crypto` は標準）。
- local/client モードは無改変（pipeline も audio エンドポイントもマウントしない）。

## テスト方針

- `persona.test.ts`: `buildPersonaPrompt` の純関数（rules/種別ラベル反映）・`fallbackLine`・`PersonaGenerator` キャッシュ（`generate` 注入）・キー未設定 fallback。
- `tts.test.ts`: `pcmToWav` ヘッダ正当性・`GeminiTtsProvider` の fetch 注入で base64→WAV・`CachingTtsProvider` がキャッシュヒットで再 synth しない・`NullTtsProvider`。
- `voice-store.test.ts`: put/get・乱数 id ユニーク・TTL prune・件数上限退避・recent はメタのみ。
- `voice-pipeline.test.ts`: `started` スキップ・正常系（fake persona+tts → utterance + onUtterance）・TTS 無効時は audio なしで utterance を作る・例外時に throw しない。
- 既存 `ingest.test.ts` に `onVoiceEvent` 呼び出しの確認を 1 ケース追加。

## Step 分解

- [x] Step 1: `persona.ts` + `voice-persona.json` + test
- [x] Step 2: `tts.ts`（GeminiTtsProvider / Caching / Null / pcmToWav）+ test
- [x] Step 3: `voice-store.ts` + test
- [x] Step 4: `voice-pipeline.ts` + test
- [x] Step 5: `ingest.ts`/`server.ts` 配線（onVoiceEvent・SSE voice-utterance・`GET /api/voice/audio/:id` + `recent.json`）
- [x] Step 6: `npm run build` + `npm test` 緑 / server モード実走ログ（Gemini 実走込み）/ プラン更新

## 残課題（Phase 6 以降）

- ブラウザ再生 UI（ON/OFF・音量・端末/種別フィルタ・履歴 + 再再生・SSE 順次再生）= Phase 6。
- WAV24k のままか mp3/opus 変換するか（帯域・iOS 互換）= Phase 6 で再評価。
- 実 E2E（Cloudflare Tunnel 越し）= Phase 7/8。

## 実装メモ（確定）

- `cli.ts` は無改変で済んだ（既存の server モード分岐内で `startServer` が pipeline を構築するため）。配線は `ingest.ts` / `server.ts` のみ。
- voice 関連モジュールは flat 配置（`voice-store.ts` / `voice-pipeline.ts`）。トップレベルに既存 `store.ts` があるため `voice/` サブディレクトリは作らず命名で分離。
- `voice-persona.json` は `ai-monitor/` 直下。`loadPersona` が `__dirname/../voice-persona.json`（src/ でも dist/ でも同じ実ファイル）を読む。
- `started` は読み上げない（`SPOKEN_KINDS = ['awaiting','completed','progress']`）。
- TTS は `selectTtsProvider`（既定 gemini / `CCM_VOICE_TTS_PROVIDER=none`）。キー未設定は `NullTtsProvider` に落として **テキストのみ utterance** を作り、サーバは落とさない。
- 追加で `GET /api/voice/recent.json`（bytes 抜きメタ）も生やした（Phase 6 履歴 UI 用の先取り・低コスト）。

## 実走ログ

### 2026-06-18 実装 + テスト
- 追加: `persona.ts` / `tts.ts` / `voice-store.ts` / `voice-pipeline.ts` / `voice-persona.json` + 各 `*.test.ts`。
- 変更: `ingest.ts`（`IngestDeps.onVoiceEvent` 追加・後方互換）/ `server.ts`（server モードで pipeline 構築・`onVoiceEvent` 配線・`/api/voice/audio/:id`・`/api/voice/recent.json`・SSE `voice-utterance`）。
- 結果: `npm run build` 通過 / `npm test` = **132 tests, 132 pass, 0 fail**（Phase 4 時点の 110 → +22）。

### 2026-06-18 配線スモーク（TTS off）
- `--mode server --port 8191`、`CCM_VOICE_TTS_PROVIDER=none`・`ANTHROPIC_API_KEY=`（persona fallback）。
- `POST /api/ingest/voice-event {kind:completed, projectName:foo}` → 200。
- pipeline 非同期完了 → SSE `voice-utterance` 受信: `text="fooの作業、おわったよ。"` / `hasAudio:false`（fallback テンプレ + TTS 無効）。
- `GET /api/voice/audio/:id` → 404（音声なし・期待どおり）。`recent.json` に 1 件。

### 2026-06-18 Gemini ライブ実走（ユーザー承認済み・外部 API 課金 1〜2 回）
- `--mode server --port 8192`、`GEMINI_API_KEY`=（`~/ai-twitch-cast/.env` 流用）、persona は fallback で固定（Anthropic 呼び出しを避け Gemini 経路だけ検証）。
- 起動ログ: `voice: persona=fallback (ちょビ), tts=gemini|gemini-2.5-flash-preview-tts|Leda`。
- `POST voice-event {completed,foo}` → SSE `voice-utterance` で `hasAudio:true, mime:audio/wav`。`GET /api/voice/audio/:id` → **200 audio/wav, 94,650 bytes**。
- 別イベント `{awaiting,bar}` の WAV を保存して検証: `file` → `RIFF (little-endian) WAVE audio, Microsoft PCM, 16 bit, mono 24000 Hz`（113,850 bytes）。ヘッダも RIFF/WAVE/fmt /PCM(1)/1ch/24000Hz/16bit/data を確認。
- 結論: voice-event → persona → Gemini TTS → PCM→WAV → utterance(乱数id) → SSE → `GET /api/voice/audio/:id` の経路が実バイトで成立。残るブラウザ再生 UI は Phase 6。
