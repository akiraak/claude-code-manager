# Phase 3: サーバ — ダッシュボードミラー配信

親プラン: [claude-progress-voice.md](claude-progress-voice.md) / 前フェーズ: [claude-progress-voice-phase2.md](claude-progress-voice-phase2.md)

Phase 2 で作った「push を安全に受けて貯める」集約ストアを、**ダッシュボード描画 (`views.ts`) に接続**して
ミラー配信する。具体的には `--mode server` のとき `LocalEntrySource` (ローカル FS pull) の代わりに
**`RemoteEntrySource` (集約ストア read)** を使い、`/view` `/api/dashboard.json` `/api/process.json`
`/api/summarize` `/api/sidebar` `/api/watch` を集約ストア由来のデータで動かす。SSE は ingest 到着で
**push 駆動**にする (2 秒ポーリングはフォールバックとして残す)。

## スコープの注記 (ログインページについて)

TODO 行の括弧書きには「ログインページ」とあるが、親プランの確定事項では **UI 認証 = Cloudflare Access (email OTP)**
で行い、**アプリ側のホームグロウンなログイン画面は作らない** (親プラン「コンポーネント詳細 C」「セキュリティ」節)。
Cloudflare Access は **インフラ層 (Phase 7)** で `ccm.chobi.me` に掛ける。したがって本フェーズでは
ログインページは実装しない (TODO の括弧書きは設計確定前の名残)。アプリ側の任意ヘッダ検証 (`CF_ACCESS_*`) も
将来 opt-in で、本フェーズ対象外。

## 目的・背景

- 公開サーバ (g3plus 上のコンテナ) はリモート端末のローカル FS を読めない。Phase 2 で受け口 (ingest + 集約ストア) を作った。
- 本フェーズで「集約ストア → `views.ts` 描画」を繋ぎ、**どこからでもブラウザでミラーを見られる**状態にする。
- local モードの挙動は完全に不変に保つ (`LocalEntrySource` 経路は無改造)。

## 設計上の要点

### マルチクライアントの id 衝突を避ける (合成 id)
現行 `MonitorEntry.id = encodeId(projectDir)`。複数端末が同じ `projectDir` (例 `-home-ubuntu-foo`) を
push すると id が衝突する。集約の主目的に反するため、**remote の id は `(clientId, projectDir)` 合成**にする。

- `remoteEntryId(clientId, projectDir) = encodeId(`${clientId.length}:${clientId}:${projectDir}`)` (store の `sessionKey` と同じ衝突しない接頭辞方式)。
- `parseRemoteEntryId(id)` で `(clientId, projectDir)` を**ステートレスに復元**できる (詳細ビュー / 要約で store を引くため)。
- `decodeId` は base64url として有効なので server.ts の妥当性ゲートはそのまま通る。

### データソース抽象化の拡張 (`EntrySource`)
`buildProcessViewData` / `/api/summarize` はローカルでは jsonl を読む。remote は store を読む。
この差を `EntrySource` の 2 メソッドに閉じ込める (描画系は無改造)。

```ts
interface EntrySource {
  buildEntries(opts?): Promise<MonitorEntry[]>;
  // 詳細ビュー用イベント列。local=readTailEvents(jsonl), remote=store
  readEvents(entry, limit): NormalizedEvent[];
  // /api/summarize 用。Summarizer キャッシュキー・対象 mtime・計算入力。要約不可なら null
  // local key=jsonlPath, remote key=`remote:clientId|projectDir|sessionId`
  summaryTargetOf(entry): { key; mtimeMs; input } | null;
}
```

- `buildProcessViewData(entry, events?)` に events 引数を追加 (未指定なら従来どおり jsonl 読み = 後方互換)。
- `renderProcessView(entry, events?)` も同様にパススルー。
- `readSummaryStatus` (state.ts の private) を export し、RemoteEntrySource が **合成キー**で再利用 (passive peek)。
- Summarizer はキー文字列を opaque に扱うだけ (jsonl を読まない) なので**改造不要**。合成キーを渡すだけで動く。

### 集約ストアの read API (session-keyed)
単一クライアント前提の `getEvents(id)` / `listEntries()` を、clientId を含む **session-keyed** に置き換える。

- `listSessions(nowMs): { clientId, projectDir, entry }[]` — TTL 内・entry 有りのみ。
- `getEventsBySession(clientId, projectDir, nowMs): NormalizedEvent[]`。
- `upsertSnapshot` / `recordVoiceEvent` / `recentVoiceEvents` / `prune` / `size` は不変。

### SSE push 駆動化
- `IngestDeps` に `onChange?()` を追加。snapshot は `changed:true` のときのみ、voice-event は記録後に発火。
- server.ts は接続ごとの `triggerTick` を `watchTriggers` 集合に登録し、`onChange` で一斉に叩く。
- 2 秒ポーリングはフォールバックとして残す (store read は in-memory で安価)。
- PermissionRequest marker watch はローカル専用なので **server モードでは張らない** (server モードは onChange が駆動)。

### server.ts / cli.ts 配線
- cli.ts server 分岐で `AggregateStore` を生成し、`RemoteEntrySource(store)` と `opts.store` の**両方に同一インスタンス**を渡す (ingest と source が同じストアを共有)。
- server.ts のプロセス系ハンドラ (`/view` proc, `/api/process.json`, `/api/summarize`) の entry 探索を
  「decodeId→projectDir 一致」から **「id 一致」**に変更 (local/remote 共通・合成 id 対応)。`decodeId` は妥当性ゲートとして残す。
- 詳細系は `source.readEvents(entry, 200)` を `buildProcessViewData` / `renderProcessView` に渡す。
- `/api/summarize` は `source.summaryTargetOf(entry)` を使い、local/remote 非依存にする。

## 影響範囲

- 変更: `store.ts` (read API 差し替え)・`entry-source.ts` (interface 拡張 + RemoteEntrySource 追加)・
  `views.ts` (buildProcessViewData/renderProcessView の events 引数)・`state.ts` (readSummaryStatus export)・
  `ingest.ts` (onChange)・`server.ts` (配線)・`cli.ts` (store + source 生成)。
- テスト: `store.test.ts` (新 read API へ更新)・`entry-source.test.ts` (RemoteEntrySource 追加)・
  `views.test.ts` (events 引数は後方互換なので既存維持)。
- local モードの挙動・テストは不変。依存追加なし。

## Step 分解

- [x] Step 1: store read API (`listSessions`/`getEventsBySession`) + 合成 id ヘルパ + test 更新
- [x] Step 2: `EntrySource` 拡張 (`readEvents`/`summaryTargetOf`) + `RemoteEntrySource` + `buildProcessViewData(events?)` + `readSummaryStatus` export + test
- [x] Step 3: `ingest.ts` onChange + `server.ts`/`cli.ts` 配線 (RemoteEntrySource・id 探索・SSE push・marker watch ゲート)
- [x] Step 4: `npm run build` + `npm test` 緑 / server モード実走ログ

## テスト方針 (`node --test` + ts-node)
- `store.test.ts`: `listSessions` が clientId 付きで返す / 別 client 同 projectDir が 2 レコードで衝突しない / `getEventsBySession`。
- `entry-source.test.ts`: `RemoteEntrySource.buildEntries` が SnapshotEntry→MonitorEntry 変換 (合成 id・process.cwd 補完・state/tail 透過) / `readEvents` が store から返る / `summaryTargetOf` のキー形 / 合成 id round-trip。
- HTTP は Phase 2 同様、純ユニット + 手動実走で担保 (新規依存なし)。

## 完了条件
- [x] 上記 Step 1〜4
- [x] `npm run build` 通過 / `npm test` 緑 (既存 + 新規)
- [x] server モード実走で `/api/dashboard.json` が push したスナップショットをミラーする / SSE が push で即時更新

## 実走ログ

### 2026-06-18 Phase 3 (ダッシュボードミラー配信)
- 変更: `store.ts` (`listEntries`/`getEvents(id)` → `listSessions`/`getEventsBySession` の session-keyed read API + `RemoteSession` 型)、
  `state.ts` (`readSummaryStatus` を export)、
  `views.ts` (`buildProcessViewData(entry, events?)` / `renderProcessView(entry, events?)` に events 引数)、
  `entry-source.ts` (`EntrySource` に `readEvents`/`summaryTargetOf` 追加・`LocalEntrySource` 実装・`RemoteEntrySource` + 合成 id ヘルパ `remoteEntryId`/`parseRemoteEntryId` 新規)、
  `ingest.ts` (`IngestDeps.onChange` 追加・changed snapshot / voice-event で発火)、
  `server.ts` (`watchTriggers`/`notifyWatchers` で SSE push 駆動・ingest に `onChange` 配線・proc 系 3 ハンドラを id 一致探索 + `source.readEvents`/`source.summaryTargetOf` に統一・marker watch は非 server 限定)、
  `cli.ts` (server 分岐で `AggregateStore` 生成 → ingest と `RemoteEntrySource` で共有)。
- テスト: `store.test.ts` 更新 (新 read API・別 client 同 projectDir 衝突しない)、`entry-source.test.ts` 追加 (合成 id round-trip / SnapshotEntry→MonitorEntry 変換 / マルチクライアント分離 / readEvents / summaryTargetOf)、`ingest.test.ts` 追加 (onChange は changed/voice のみ発火・dedup では発火しない)。
- 結果: `npm run build` 通過 / `npm test` = **72 tests, 72 pass, 0 fail** (Phase 2 の 66 から +6)。
- 手動 E2E (server モード, `--port 18894/18895`):
  - 認証なし ingest = **401**。
  - 2 端末 (`wsl2-akira` / `mac-akira`) が同一 `projectDir` を push → `/api/dashboard.json` が **2 カードに分離** (合成 id で衝突せず)。cwd / state / tail.lastUserText がミラーされる。
  - `/api/sidebar` も 2 件、`proc:<合成id>`。`/api/process.json?id=proc:<id>` が pid / sessionId / events (ストア由来 2 件) を返す。`/view?item=dashboard` は HTML。
  - SSE: 購読中に snapshot push → **+0.018s** で `event: sidebar` を受信 (2 秒ポーリングより速い = push 駆動を確認)。
  - local モード起動も従来どおり (`mode: local`・CORS ヘッダ無し・dashboard.json が実 CLI を返す)。

## 申し送り (Phase 4 以降)
- Phase 4: `--mode client` の uplink を実装し、本フェーズの ingest にスナップショット + voice-event を送る。
- Phase 5: `summaryTargetOf` の remote 経路と同じ合成キーで voice-event → ペルソナ短文 → TTS。
- マルチクライアントの **client ラベル**をカード/サイドバーに出すのは Web UI 整備 (Phase 6) で行う (本フェーズは id 衝突回避まで)。
