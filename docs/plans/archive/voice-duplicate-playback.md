# 同じ会話が２回流れるバグ — 調査 & 対応プラン

## 目的・背景

AI Monitor (server モード) のダッシュボードで、**同じ会話 (1 つの voice-event から生成された 2 人会話) が 2 回読み上げられる**ことがある。
本プランでは原因を切り分けたうえで、再発しないよう多層で防ぐ。

調査は読み取り専用で実施済み。以下は根拠 (`file:line`) つきの事実と、そこから絞り込んだ発火経路。

## 調査結果（根拠つき）

### 全体フロー（client → server → ブラウザ）

1. client (`--mode client`) が状態遷移を検出して voice-event を生成
   - `VoiceEventDetector.observe()` (`ai-monitor/src/uplink.ts:339`) が遷移から `VoiceEventOut[]` を出す
   - `VoiceEventQueue.enqueue()` (`uplink.ts:583`) に積み、`flush()` (`uplink.ts:592`) が `POST /api/ingest/voice-event` で送る
2. server が受信 → utterance 群を生成
   - `ingest.ts` のエンドポイント (`ingest.ts:247` 付近) が `store.recordVoiceEvent()` (`store.ts:176`) と `onVoiceEvent(v)` を呼ぶ
   - `onVoiceEvent` (`server.ts:197`) が `pipeline.enqueue(v)` を呼ぶ
   - `VoicePipeline.handle()` (`voice-pipeline.ts:95`) が Haiku で会話を生成、`groupId = crypto.randomBytes(8)` (`voice-pipeline.ts:120`) を**新規採番**し、各発話を `voiceStore.put()` (`voice-store.ts:110`) に格納、`onUtterance(utt)` で SSE listener へ配信
3. ブラウザが SSE `voice-utterance` を受けて順次再生
   - 専用 EventSource (`views.ts:1308`) → `onUtterance(meta)` → `enqueue(meta)` (`views.ts:1229`,`1134` 付近) → `pump()`

### 確認できたギャップ 1 — server 側に voice-event の冪等性が無い

- **snapshot には fingerprint dedup がある** (`store.ts:142`〜: `cwd|pid|mtimeMs|state` が同じなら `changed:false`)。
- **voice-event には dedup が一切無い**。`recordVoiceEvent()` (`store.ts:176`) は無条件に buffer へ push、`onVoiceEvent` → `pipeline.enqueue` (`server.ts:197`) もそのまま処理する。
- client の `VoiceEventQueue.flush()` (`uplink.ts:592`) は **200 を受けたときだけ** `q.shift()` する。retryable 失敗 (timeout/5xx) では同じオブジェクトを **新しい `sentAt` で再送**する (`uplink.ts:596-619`)。payload に安定した識別子が無い。
- → **server が処理に成功したのに 200 応答が失われた**場合、client が再送し、server が**もう一度会話を生成**する。2 つの群は **別 `groupId`** になるため、クライアント側の groupId ベース重複排除では捕まえられない。

### 確認できたギャップ 2 — client 再生キューに seen-id 重複排除が無い

- `enqueue()` (`views.ts:1134` 付近) は受け取った meta を**無条件に** `queue.push` する。再生済み / キュー投入済みの `id` を覚える `Set` が無い (`seenClients` は端末ドロップダウン用で別物)。
- → SSE 経由で**同じ utterance (同一 `id`) が 2 回届けば**そのまま 2 回再生される。
- 各 utterance の `id` は `put()` ごとに `crypto.randomBytes(16)` で必ずユニーク (`voice-store.ts:112,166`)。つまり「同一 id が 2 回届く」のは**配信が二重**のときだけ。

### 否定した仮説 — 「SSE 再接続で旧 utterance が再送される」は**無い**

- `/api/watch` (`server.ts:375`) は接続時に過去 utterance を replay しない。`onVoice` listener は**新規生成時にだけ**発火する (`server.ts:439-446`)。`Last-Event-ID` も未処理。
- 切断時は `req.on('close')` (`server.ts:479-486`) で listener を解除するので、再接続での二重登録も起きない。
- → 再接続由来の重複は本バグの原因ではない（初期調査の一次仮説を棄却）。

### 二重化の発火経路（どちらも「再生キューに dedup が無い」=ギャップ 2 が下地）

- **T1（別 groupId・server 二重生成）**: 同一 voice-event が server に 2 回 ingest される。原因候補:
  - lost-ack 再送（ギャップ 1。Cloudflare Tunnel 経由など遅延・切断のある経路で起きやすい）
  - 同一 PC で client を二重起動 / 旧 `local` モード併存 → 同じ projectDir を 2 プロセスが観測
  - → **別 groupId** なので、client 側 id/group dedup では消せない。**server 冪等化が必須。**
- **T2（同一 id・client 二重配信）**: 同じ utterance を client が 2 回ハンドルする。原因候補:
  - ダッシュボードを 2 タブ / iframe + 直開きで開いている（利用者起因）
  - voice スクリプト IIFE (`views.ts:1308`) または EventSource が二重初期化され、`voice-utterance` listener が 2 つになる
  - → **同一 id** なので、client 側 seen-id `Set` で消せる。

## 対応方針（多層防御）

T1 と T2 は独立した穴で、**片方だけでは塞ぎきれない**（T1 は別 groupId のため client dedup では無理、T2 は別タブのため server dedup では無理）。両方塞ぐ。

### Phase 0 — 再現と主因の特定（コード変更なし）

- ローカルで `run-ai-monitor.sh` + `run-ai-monitor-client.sh` を起動し、二重読み上げを再現する。
- server の voice ログ (`[ai-monitor] voice ▶ ...` / `server.ts:152-163`) で、重複時に
  - **`groupId` が異なる** → T1 主因（server 二重生成）
  - **同一 utterance が 2 回 SSE 配信されている / listener が 2 つ** → T2 主因（client 二重配信）
  を判定する。`/api/ingest/voice-event` の到達回数（ingest 側に一時ログ）も確認する。
- 併せて client プロセス数・開いているダッシュボードのタブ/iframe 数を確認（運用起因の切り分け）。

### Phase 1 — server 冪等化（T1 を塞ぐ・主対策）

- `VoiceEventOut` (`uplink.ts:260`) に `eventId?: string` を追加し、**enqueue 直前に 1 回だけ採番**する（`observe()` は純粋関数なので、その外＝`queue.enqueue(ev)` を呼ぶ tick 側 `uplink.ts:796` 付近で `randomUUID()` を `ev` に載せる）。`flush()` は同一 `ev` を再送するので **eventId は再送をまたいで不変**（lost-ack 再送を同一イベントと判定できる）。
- `VoiceEventPayload` (`store.ts:48`) に `eventId?` を追加。`validateVoiceEvent()` (`ingest.ts:97` 付近) で型・長さ検証、`redaction` 通過は素通し（秘匿情報ではない）。
- server: `pipeline.enqueue` 手前（`server.ts:197`）または `VoicePipeline` 内で、**処理済み eventId の LRU/TTL セット**を持ち、既知なら生成をスキップする。`eventId` 欠落（旧 client）時は **dedup せず従来動作**（イベントを落とすより重複許容が安全、という既存方針 `uplink.ts:311-312` に合わせる）。
- 注意: `progress` は周期通知で内容が繰り返されるが、eventId は**発話ごとにユニーク**なので誤って抑制されない。

### Phase 2 — client 再生の二重防御（T2 を塞ぐ + 全経路の保険）

- 再生キューに **seen-id `Set`** を導入。`enqueue()`（`views.ts:1134` 付近）と `playNow()` 経由で、`meta.id` を既見なら投入しない（履歴 `addHistory` は従来どおり記録、再生だけ抑止）。`Set` は件数上限つきで肥大を防ぐ。
- voice スクリプト / EventSource (`views.ts:1308`) の **二重初期化ガード**（`window` フラグ等で IIFE 再実行・EventSource 重複生成を防止）。Phase 0 で二重初期化が確認できた場合に実施。
- 別タブ/iframe による多重再生は仕様上の利用者起因なので本プランの対象外（必要なら別タスク）。

## 影響範囲

- `ai-monitor/src/uplink.ts`（`VoiceEventOut` 拡張・eventId 採番・enqueue）
- `ai-monitor/src/store.ts`（`VoiceEventPayload` 拡張）
- `ai-monitor/src/ingest.ts`（検証）
- `ai-monitor/src/server.ts` または `ai-monitor/src/voice-pipeline.ts`（eventId LRU/TTL dedup）
- `ai-monitor/src/views.ts`（seen-id Set・初期化ガード）
- 後方互換: eventId 欠落の旧 client は従来どおり（dedup せず）動く。

## テスト方針

- `uplink.test.ts`: enqueue→flush の lost-ack 再送で **eventId が不変**であること。
- `voice-pipeline.test.ts`（または ingest/server）: 同一 eventId を 2 回投入しても utterance 群が **1 回だけ**生成されること。eventId 欠落時は従来どおり生成されること。
- `ingest.test.ts`: `eventId` の型/長さ検証。
- `voice-store.test.ts` は不変（id 採番は従来どおり）。
- 既存テスト一式を緑に保つ。

## 未確定事項 / リスク

- 主因が T1 か T2 かは Phase 0 で確定させる（両 Phase 実施が前提だが、優先順位を決める）。
- server 冪等セットの保持件数 / TTL は voice-event の流量から決める（暫定: 直近 500 件 or 10 分 TTL）。
- 別タブ/iframe 多重再生は対象外。問題が残るなら別タスク化。
