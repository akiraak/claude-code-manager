# Phase 2: サーバ — 認証 + Ingestion 基盤

親プラン: [claude-progress-voice.md](claude-progress-voice.md) / 前フェーズ: [claude-progress-voice-phase1.md](claude-progress-voice-phase1.md)

Phase 2 のゴールは「公開サーバ (`--mode server`) の **受け口** を作る」こと。具体的には
**認証 (端末別 Bearer) + Ingestion エンドポイント + 集約ストア (メモリ TTL)** を実装する。
ダッシュボードのミラー配信 (集約ストア → `views.ts`) は **Phase 3**、uplink クライアントは **Phase 4** なので、
本フェーズは「push を安全に受けて貯める」ところまで。

## 目的・背景

- 現行 ai-monitor は `--mode local` 相当 (ローカル FS pull + loopback + CORS `*` + 書き込み API なし)。
- 公開サーバはリモート端末の push を受ける必要があるため、**書き込み API + 認証 + 集約ストア**を足す。
- **local モードの挙動は完全に不変**に保つ (既存テスト緑・CORS `*`・ingest なし)。サーバ専用処理は `mode === 'server'` でのみ有効化する。

## 対応方針

### 1) モード化 (後方互換)
- `cli.ts`: `--mode local|client|server` を追加 (既定 `local`)。不正値は起動拒否。
- `client` は Phase 4 で uplink を実装するまで **local と同挙動** (フラグだけ受理)。
- `startServer(opts, source)` の `opts` に `mode` と server 設定を追加。**シグネチャは後方互換** (既定 `local`)。

### 2) 認証 — `ai-monitor/src/auth.ts` (新規)
- `parseClientTokens(raw)`: `CCM_CLIENT_TOKENS` をカンマ区切り → trim → 空要素除去。
- `assertServerAuthConfigured(tokens)`: server モード起動時に **fail-fast**。
  - トークン 0 個 → 起動拒否。
  - 16 文字未満のトークンが混じる → 起動拒否 (photorans `URL_SECRET` 流儀)。
- `bearerAuth(tokens)`: express ミドルウェア。`Authorization: Bearer <token>` を検証。
  - ヘッダ欠落 / 形式不正 / 不一致 → `401`。
  - 照合は `crypto.timingSafeEqual` ベース (長さ不一致は即不一致、タイミング差を抑える)。
  - 認証はあくまで「ingest を許可するか」。`clientId` は payload 側から取る (Phase 2 ではトークン→ラベル対応は持たない)。
- UI 側の Cloudflare Access (email OTP) は **インフラ層** (Phase 7) で掛けるため、アプリ側は本フェーズでは扱わない
  (任意の `CF_ACCESS_*` ヘッダ検証は将来 opt-in)。

### 3) 集約ストア — `ai-monitor/src/store.ts` (新規)
- キー: clientId (長さ接頭辞付き) + projectDir で 1 端末の 1 セッションを一意化する (区切り文字に依存せず、どんな文字でも衝突しない。ソースにバイナリを埋め込まない)。
- `AggregateStore`:
  - `upsertSnapshot(payload, nowMs): { changed }` — `entry` + `events` + `lastSeenMs` + `fingerprint` を保存。
    指紋 (`cwd|pid|mtimeMs|state`) が前回と同一なら `lastSeenMs` だけ更新し `changed:false` (dedup)。
  - `recordVoiceEvent(payload, nowMs)` — セッションのリングバッファ (上限 20) に追記。
  - `listEntries(nowMs): SnapshotEntry[]` — TTL 内のレコードを返す (Phase 3 の `RemoteEntrySource` が `MonitorEntry` へ変換して使う。下の「型の申し送り」参照)。
  - `getEvents(id, nowMs): NormalizedEvent[]` — entry id でイベント列を返す (Phase 3 のプロセス詳細用)。
  - `recentVoiceEvents(nowMs)` — 直近の音声イベント (Phase 5/6 用)。
  - `prune(nowMs)` — `lastSeenMs` が `STOPPED_RETENTION_SEC` (24h, 既存定数を流用) より古いレコードを退避。
- 時刻は **引数で注入** (`nowMs`) してテスト可能にする (`Date.now()` を内部で呼ばない)。
- `summary` は payload に含めない。Phase 3/5 でサーバ側 Summarizer が埋める。

### 4) Ingestion — `ai-monitor/src/ingest.ts` (新規)
- バリデータ (純関数, テスト主対象):
  - `validateSnapshot(body)`: `clientId` (非空・長さ上限)、`entry` (id/projectDir/cwd/state 必須・state は 4 値)、
    `events` (配列・上限 `MAX_EVENTS=200`) を検証。余剰・型不正・超過は `{ ok:false, error }`。
  - `validateVoiceEvent(body)`: `clientId` / `projectDir` / `kind` (`started|awaiting|completed|progress`) /
    `detail` (≤ 既定上限) を検証。
- レート制限 / クールダウン (小クラス, 時刻注入):
  - `RateLimiter({ windowMs, max })` — snapshot 用。`clientId` 単位で固定窓カウント。超過 → `429`。
  - `Cooldown({ ms })` — voice-event 用。`clientId|projectDir|kind` 単位。クールダウン中の同種は `429` (= 種別別クールダウン / dedup)。
- ルータ工場 `createIngestRouter({ store, snapshotLimiter, voiceCooldown, now })`:
  - `POST /snapshot` → 検証 → レート制限 → `store.upsertSnapshot` → `200 { ok, changed }`。
  - `POST /voice-event` → 検証 → クールダウン → `store.recordVoiceEvent` → `200 { ok }`。
  - 検証 NG → `400`、レート/クールダウン超過 → `429`。
- payload 全体サイズは `express.json({ limit: '512kb' })` で制限 (超過は 413)。

### 5) server.ts 配線 (`mode === 'server'` のみ)
- 起動時に `parseClientTokens` → `assertServerAuthConfigured` (fail-fast。NG は `cli.ts` が catch → exit 1)。
- `AggregateStore` を生成 (未注入時)。
- CORS を **オリジン限定**: `CCM_CORS_ORIGIN` (カンマ区切り) に含まれる `Origin` のみ反映。未設定なら CORS ヘッダを付けない。
  - local モードは従来どおり `*` (不変)。
- `/api/ingest` に `bearerAuth(tokens)` を噛ませて `createIngestRouter(...)` をマウント。
- ダッシュボード系 (`/view` 等) は **本フェーズではローカル source のまま** (空でも可)。Phase 3 で `RemoteEntrySource(store)` に差し替える。

## 影響範囲

- 新規: `auth.ts` / `store.ts` / `ingest.ts` + 各 `*.test.ts`。
- 変更: `cli.ts` (`--mode` 追加)、`server.ts` (`mode` 受け取り + server 専用配線。local 経路は不変)。
- 依存追加なし (express / crypto / 既存型のみ)。
- local モードのテスト・挙動は不変 (server 専用処理は分岐の内側)。

## テスト方針 (`node --test` + ts-node, 既存 `src/**/*.test.ts` 形式)
- `auth.test.ts`: token パース / fail-fast (0個・短い) / Bearer 受理・401 (欠落・形式不正・不一致)。
- `store.test.ts`: upsert→list、dedup (同指紋 changed:false)、TTL 退避 (prune)、voice リングバッファ上限、getEvents。
- `ingest.test.ts`: validateSnapshot/voiceEvent の OK/NG ケース、RateLimiter 窓超過、Cooldown 種別別。
- HTTP は supertest 等の新規依存を足さず、バリデータ / ストア / リミッタの **純粋ユニット**で担保する
  (ルータは薄いので E2E は Phase 4 の手動確認に委ねる)。

## 完了条件
- [x] `auth.ts` + test
- [x] `store.ts` + test
- [x] `ingest.ts` + test
- [x] `cli.ts` / `server.ts` 配線 (server モード限定・local 不変)
- [x] `npm run build` 通過 / `npm test` 緑 (既存 + 新規)

## 申し送り (Phase 3 以降)
- Phase 3: `RemoteEntrySource(store)` を実装し `startServer` に渡す。`getEvents(id)` を `buildProcessViewData` 経路へ。
  Summarizer を合成キー (`clientId|projectDir|sessionId`) 対応にする。SSE を push 駆動化 (ingest 到着でリスナ通知)。
- Phase 5: voice-event → ペルソナ短文 (Haiku) → TTS → utterance ストア → `/api/voice/audio/:id`。
- **型の申し送り**: `AggregateStore.listEntries` は `MonitorEntry[]` ではなく `SnapshotEntry[]` を返す。
  `MonitorEntry.transcript` は `jsonlPath` 必須・`process` は `ClaudeProcess` (cwd 必須) だが、リモートはどちらも欠くため。
  Phase 3 の `RemoteEntrySource` で `SnapshotEntry → MonitorEntry` 変換 (process.cwd を entry.cwd で補完、
  jsonlPath 非依存の経路) を行う。jsonlPath 依存の `readTailEvents`/`Summarizer` は `getEvents` + 合成キーで置換する。

## 実走ログ

### 2026-06-18 Phase 2 (auth + ingest + store)
- 追加: `src/auth.ts` (`parseClientTokens`/`assertServerAuthConfigured`/`bearerAuth` ほか) + `auth.test.ts`
- 追加: `src/store.ts` (`AggregateStore`: upsert/dedup/list/getEvents/recentVoiceEvents/prune・TTL) + `store.test.ts`
- 追加: `src/ingest.ts` (`validateSnapshot`/`validateVoiceEvent`・`RateLimiter`/`Cooldown`・`createIngestRouter`) + `ingest.test.ts`
- 変更: `src/cli.ts` (`--mode local|client|server`・server で fail-fast 検証して startServer へ)、
  `src/server.ts` (`mode`/`clientTokens`/`corsOrigins`/`store` を受け取り、server 限定で CORS オリジン限定 +
  `/api/ingest` に `bearerAuth` + `express.json({limit:'512kb'})` + ルータをマウント。local 経路は不変)。
- 結果: `npm run build` 通過 / `npm test` = **66 tests, 66 pass, 0 fail**。
- 手動 E2E (server モード実走, `--port 18893`): token 無し ingest=**401** / 正規 token=**200 changed:true** /
  同一再送=**200 changed:false** (dedup) / voice-event=**200 ok:true** / 不正 body=**400**。
  起動ログに `mode: server (ingest tokens: 1, CORS origins: 1)` を確認。local モード起動も従来どおり (`mode: local`)。
- 注: ルータ統合テストは `app.listen(0)` + `fetch` で実 HTTP を叩く形にした (supertest 等の新規依存なし)。
  `*.test.ts` は `tsc` の exclude 対象だが ts-node は strict で型検査するため、`fetch().json()` の `unknown` は明示キャストが必要。
