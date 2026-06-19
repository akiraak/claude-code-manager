# Phase 4: クライアント — uplink エージェント

親プラン: [claude-progress-voice.md](claude-progress-voice.md) / 前フェーズ: [claude-progress-voice-phase3.md](claude-progress-voice-phase3.md)

Phase 2/3 で「push を受けて貯めてミラー配信する」公開サーバ (`--mode server`) を作った。
本フェーズはその **送信側 (`--mode client`)** を実装する。各端末で既存検出
(`LocalEntrySource` = `buildEntries`/`readTailEvents`/`classifyV2`) を再利用し、
**スナップショット** (ミラー用) と **状態遷移イベント** (発話の素) を公開サーバへ push する。

## 目的・背景

- 公開サーバはリモート端末のローカル FS を読めない。各端末がローカルで状態を算出し push する (pull→push の設計転換)。
- `--mode client` は「ローカル FS pull + loopback 配信 (= local モードそのまま)」に加えて **公開サーバへ uplink** する。
  ローカルダッシュボード (8181) は従来どおり動く。
- 既存検出ロジックは無改造で再利用する (`EntrySource` 抽象の `LocalEntrySource`)。

## 対応方針

### 1) 設定 — `loadClientConfig(env, hostname)` (uplink.ts, 純関数)

env から `ClientConfig` を組み立てる。`CCM_DRYRUN` 以外は本番送信に必須。

| env | 既定 | 意味 |
|---|---|---|
| `CCM_SERVER_URL` | — | `https://ccm.chobi.me` 等。末尾 `/` は除去。非 dryrun では `http(s)://` 必須 |
| `CCM_CLIENT_TOKEN` | — | 端末別 Bearer。非 dryrun では 16 文字以上必須 (server の token ポリシーと同じ) |
| `CCM_CLIENT_LABEL` | `os.hostname()` | clientId。集約ストアの突き合わせキー |
| `CCM_MIRROR_PROJECTS` | 未設定=全件 | カンマ区切り allowlist。cwd basename / projectDir / cwd 完全一致で限定 |
| `CCM_DRYRUN` | false | `1`/`true`/`yes` で送信せずログのみ。url/token 未設定でも起動可 |
| `CCM_CLIENT_INTERVAL_MS` | 4000 | snapshot tick 間隔 (下限 1000) |
| `CCM_PROGRESS_AFTER_MS` | 120000 | ai-processing 継続がこの時間を超えたら最初の progress 発話 |
| `CCM_PROGRESS_EVERY_MS` | 120000 | 以降 progress を出す間隔 |

非 dryrun で url/token が無い・token が短い → `throw` (cli.ts が catch → exit 1。photorans 流儀)。

### 2) allowlist — `isProjectMirrored(entry, allowlist)` (純関数)
- `null` (未設定) → 全件 true。
- 設定時: `basename(cwd)` / `projectDir` / `cwd` のいずれか一致で true。
- snapshot と voice の **両方** に適用 (プライバシー: 対象外プロジェクトの本文を送らない)。

### 3) シリアライズ — `buildSnapshotPayload(clientId, entry, events, opts)` (純関数)
`MonitorEntry` → ワイヤ形式 `SnapshotPayload` (Phase 2 の `validateSnapshot` が通る形)。
- `process` は `{ pid }` のみ (cwd は entry.cwd を使うので落とす)。
- `transcript` は `jsonlPath` を **送らない** (絶対パスは無意味 + 情報漏れ。RemoteEntrySource も空で扱う)。
- 本文は送信前 redaction (`sanitizeText`)。
  - event.text: `sanitizeText(text, 1200)`、件数は `SNAPSHOT_MAX_EVENTS=150` で末尾優先トリム (512kb 上限対策)。
  - tail.lastUserText / lastAssistantText: `sanitizeText(text, 2000)`。
- `state` / flags / `lastActivityAt` は透過。

### 4) 状態遷移検出 — `VoiceEventDetector` (純粋・時刻注入)
projectDir 単位で前回 state を覚え、tick ごとに遷移から発話イベントを 0..N 件出す。
- **初回観測 = baseline (発話しない)**。monitor 再起動で全 awaiting を再発話する事故を防ぐ。
- 遷移 → kind:
  - `* → awaiting-user` → **awaiting** (承認待ち、detail = lastAssistantText)
  - `* → ai-processing` → **started** (開始、detail = lastUserText。timer 起動用。発話するかは server/UI 判断)
  - `ai-processing → waiting` → **completed** (ターン完了、detail = lastAssistantText)
  - `ai-processing → stopped` → 発話しない (/exit と完了を区別できないため)
  - その他 (waiting→stopped 等) → 発話しない
- **progress**: ai-processing が `progressAfterMs` を超えて継続したら 1 回、以降 `progressEveryMs` ごと (detail = lastAssistantText)。
- セッション消滅 (一覧から消えた projectDir) は state を破棄 (再登場は baseline 扱い)。

### 5) HTTP 送信 — `createHttpPoster` / dryrun poster + `VoiceEventQueue`
- `Poster = (pathSuffix, body) => Promise<PostOutcome>`。`createHttpPoster({serverUrl, token, fetchImpl, timeoutMs})`:
  - `POST ${serverUrl}/api/ingest${pathSuffix}`、`Authorization: Bearer`、`AbortController` で timeout (既定 8s)。
  - 2xx → ok / 4xx(400/401/403/413)・429 → not-retryable (drop) / 408・5xx・例外 → retryable。
  - 429 は server の cooldown/ratelimit = 意図的拒否なので drop。
  - dryrun: `createDryRunPoster(log)` が compact ログを出して ok を返す (token は出さない)。
- **voice-event はバッファ + バックオフで落とさない** (発話が本機能の主目的):
  - `VoiceEventQueue({poster, clientId, maxSize=100, baseBackoffMs, maxBackoffMs, now})`。
  - enqueue (満杯なら最古を捨ててログ) → `flush()` で順序保持ドレイン。retryable は head に残しバックオフ、not-retryable は drop。
- **snapshot は latest-wins** (バッファ不要)。失敗時は次 tick が最新状態を再 push して自己回復 (親プランの保持方針)。連続失敗時は `snapshotNextAttemptAt` でバックオフし server を叩き続けない。

### 6) ランナー — `startUplink(config, deps?)`
- source = `LocalEntrySource` (要約なし。要約は server 側)。poster = dryrun ? dryrunPoster : httpPoster。
- `tick()` (リエントラントガード):
  1. `entries = source.buildEntries()` → allowlist で絞る。
  2. 各 entry: `events = source.readEvents(entry, 150)` → `buildSnapshotPayload` → `/snapshot` (snapshot backoff 配慮)。
  3. voice 入力 (sanitized lastUserText/lastAssistantText・projectName=basename(cwd)) → `detector.observe` → enqueue。
  4. `queue.flush()`。
- `setInterval(tick, intervalMs)` + 起動時即 tick。**marker watch** (`watchAwaitingInputMarkers`) で awaiting を低レイテンシ検出 (即 tick)。
- `stop()` で interval + marker watch を閉じる。テスト用に `tickOnce()` を公開。
- 起動ログに mode/server host (token は出さない)/label/allowlist/dryrun/interval。

### 7) processes.ts のプラットフォーム分岐 (Mac は後追い)
- `listClaudeProcesses()` を `process.platform` で分岐。Linux/WSL2 経路 (`pgrep -af` + `/proc`) は **完全に不変** (既存実装を `listClaudeProcessesLinux` に改名して委譲するだけ)。
- darwin 経路は **スキャフォルドのみ** (`ps`+`lsof` ベースの実装は別タスク)。現状は空配列 + 1 回だけ warn を返し、クラッシュさせない (Mac では jsonl 由来の stopped カードのみ表示)。
- ユーザー確定 (2026-06-18): 今は WSL2 中心、Mac 実機検出は後追い。

### 8) cli.ts 配線
- client 分岐: `loadClientConfig(process.env, os.hostname())` (throw は外側 catch) → `startServer(opts)` (ローカルダッシュボード不変) → `startUplink(config)`。
- local/server 分岐は不変。

## 影響範囲
- 新規: `uplink.ts` + `uplink.test.ts`。
- 変更: `cli.ts` (client 分岐)、`processes.ts` (platform 分岐 + darwin スキャフォルド。Linux 不変)。
- server.ts / store.ts / ingest.ts / views.ts は **不変** (Phase 2/3 の受け口をそのまま使う)。
- 依存追加なし (fetch は Node18+ グローバル、os/path/crypto は標準)。
- local / server モードの挙動・テストは不変。

## テスト方針 (`node --test` + ts-node)
- `loadClientConfig`: dryrun は url/token 無しで可 / 非 dryrun で url・token 欠落・短 token を throw / label 既定 hostname / mirror 分割 / 末尾 `/` 除去 / interval 既定・上書き。
- `isProjectMirrored`: null=全件 / basename・projectDir 一致 / 非一致除外。
- `buildSnapshotPayload`: jsonlPath を落とす / process を {pid} に / event・tail を redact / 件数上限 / **出力が `validateSnapshot` を通る** (クロスチェック)。
- `VoiceEventDetector`: baseline 無発話 / awaiting / started / completed / progress (初回 + 周期) / →stopped 無発話 / 消滅クリーンアップ。
- `VoiceEventQueue`: 成功ドレイン (順序・clientId 付与) / retryable はバックオフで残す / not-retryable drop / maxSize で最古 drop。
- `createHttpPoster`: fake fetch で status→outcome 分類 (2xx/4xx/429/5xx/例外)。
- ランナー: fake EntrySource + 記録 poster + 固定時計で `tickOnce` が snapshot を送り、2 tick 目で遷移 voice を送る。
- HTTP は実ソケットを使わず純ユニット + dryrun 実走で担保 (新規依存なし)。

## Step 分解
- [x] Step 1: 設定 + allowlist + シリアライズ + 状態遷移検出 (純粋部) + test
- [x] Step 2: HTTP poster + voice queue + ランナー `startUplink` + test
- [x] Step 3: `processes.ts` platform 分岐 + darwin スキャフォルド / `cli.ts` client 配線
- [x] Step 4: `npm run build` + `npm test` 緑 / dryrun 実走ログ / プラン更新

## 完了条件
- [x] 上記 Step 1〜4
- [x] `npm run build` 通過 / `npm test` 緑 (既存 + 新規)
- [x] dryrun 実走で snapshot / voice-event の送信内容が確認できる
- [x] local / server モードが従来どおり動く (回帰なし)

## 実走ログ

### 2026-06-18 Phase 4 (uplink クライアント)
- 追加: `src/uplink.ts` — `loadClientConfig` (env→`ClientConfig`・非 dryrun で url/token fail-fast) /
  `isProjectMirrored` (allowlist) / `buildSnapshotPayload` (jsonlPath を落とす・process→{pid}・redaction・件数上限) /
  `VoiceEventDetector` (baseline 無発話・started/awaiting/completed/progress・時刻注入) /
  `classifyStatus` + `createHttpPoster` (Bearer・AbortController timeout・2xx/4xx/429/5xx/例外分類) + `createDryRunPoster` /
  `VoiceEventQueue` (バッファ + バックオフ・順序保持ドレイン・not-retryable drop・満杯で最古破棄) /
  `createUplinkRunner`/`startUplink` (snapshot latest-wins + backoff・marker watch で awaiting 低レイテンシ tick)。
- 追加: `src/uplink.test.ts` (19 ケース)。
- 変更: `src/processes.ts` (`listClaudeProcesses` を `process.platform` 分岐。Linux 経路は `listClaudeProcessesLinux` に改名して**不変**。
  darwin は空配列 + 1 回 warn のスキャフォルド)、`src/cli.ts` (client 分岐で `loadClientConfig` → `startServer` (ローカル) + `startUplink`)。
- server.ts / store.ts / ingest.ts / views.ts は不変。依存追加なし (fetch は Node18+ グローバル)。
- 結果: `npm run build` 通過 / `npm test` = **91 tests, 91 pass, 0 fail** (Phase 3 の 72 から +19)。
- dryrun 実走 (`--mode client --port 18896`, `CCM_DRYRUN=1 CCM_CLIENT_LABEL=wsl2-test CCM_CLIENT_INTERVAL_MS=2000`):
  - `mode: client` 起動 → ローカルダッシュボード (`running at http://127.0.0.1:18896`) と uplink が**併走**。
  - `[uplink] 起動: server=(dryrun) label=wsl2-test interval=2000ms mirror=全件`。
  - snapshot dryrun POST が 2 秒ごと。生存セッションは `process:{pid:467546}` (既存 `/proc` 検出を再利用)、停止セッションは `process:null`。
  - `entry.transcript` に **jsonlPath が無い** (projectDir/cwd/mtimeMs/sessionId のみ) ことを確認 = 漏洩源を送らない。
  - 状態遷移なしの定常状態では voice-event が **0 件** (baseline + 無遷移 = 誤発話しない) を確認。
- 注: macOS の process 検出 (`ps`+`lsof`) は後追い (ユーザー確定)。darwin は現状スキャフォルド。

### 2026-06-18 Phase 4 追補 (snapshot レート制限 starvation 修正)
- 指摘 (Codex stop-time review): 旧実装は **毎 tick 全 project の snapshot を送る** ため、サーバの per-client
  レート制限 (`RateLimiter` 30/10s・dedup されたリクエストもカウント) を踏み、`classifyStatus(429)` が
  `retryable:false` で旧ループが break もバックオフもせず素通り。`buildEntries` の cwd ソート順が固定なので
  末尾の project が毎ウィンドウ 429 され **ミラーから恒久的に欠落 (starve)** していた。
- 修正 (`uplink.ts` の `sendSnapshots`):
  - **変化検出**: `entrySnapshotFingerprint(entry)` (= サーバ dedup 指紋と同じ `cwd|pid|mtimeMs|state`) が
    変わった project だけ送る。定常状態の送信量がほぼゼロになりレート制限を踏まない。
  - **heartbeat**: 変化が無くても `SNAPSHOT_HEARTBEAT_MS` (30s) ごとに 1 回再送し TTL/lastSeen を維持。
  - **公平性**: 送信対象を「最後に送った時刻が古い順 (未送信=最古)」に並べ、429 を受けたら今 tick を打ち切って
    短時間クールダウン。未送信分は lastSent を据え置くので次 tick で先頭に来る → 恒久 starve しない。
  - 429 は drop ではなく「次 tick で再送」、5xx/network/その他 4xx は従来どおり指数バックオフに整理。
- テスト追加 (2): 変化なし snapshot は再送せず heartbeat 時のみ再送 / 429 でも全 project が最終的に送られる。
- 結果: `npm run build` 通過 / `npm test` = **93 tests, 93 pass, 0 fail**。

## 申し送り (Phase 5 以降)
- Phase 5: server が受けた voice-event → ペルソナ短文 (Haiku) → Gemini TTS → utterance ストア → `/api/voice/audio/:id`。
- macOS 実機の process 検出 (`ps`+`lsof`) は別タスク。本フェーズの darwin スキャフォルドに実装を埋める。
- 端末別トークン配布運用 (`openssl rand -base64 32` を server の `CCM_CLIENT_TOKENS` と各端末の `CCM_CLIENT_TOKEN` に設定) は Phase 7 デプロイで文書化。
