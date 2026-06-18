# TODO

- [ ] claudeの進捗状況を音声でしゃべる機能を入れる [plan](docs/plans/claude-progress-voice.md)
      ~/ai-twitch-cast に Claude Code の hook と、それを Windows アプリで音声を生成する機能があるのでそれを改善したものを作る
      構成: 各端末(WSL2/Mac)が状態を push → 公開サーバ(ai-monitor server モード)で集約+AI音声生成 → ブラウザでミラー表示+再生
      公開前提: Cloudflare Tunnel(TLS) / 端末別トークン+UIログイン / ダッシュボードもミラー / キャラ口調 / 発話: 完了・承認待ち・途中経過
  - [ ] Phase 1: 設計確定 & 基盤 PoC [plan](docs/plans/claude-progress-voice-phase1.md)
    - [x] Part 1: データソース抽象化 (EntrySource 導入・設計確定 + 安全リファクタ)
    - [ ] Part 2: g3plus + Cloudflare Tunnel `ccm.chobi.me` 疎通 PoC ※別作業 (g3plus/Cloudflare 側)
    - [x] Part 3: Gemini TTS → ブラウザ再生 PoC (HTTP 直叩き + 再生ページ + 実走)
    - [x] Part 4: redaction/保持方針の確定 (redaction.ts PoC + テスト)
  - [x] Phase 2: サーバ — 認証 + Ingestion 基盤 (Bearer/UIセッション・CORS限定・`/api/ingest/*`・集約ストア・dedup/レート制限) [plan](docs/plans/claude-progress-voice-phase2.md)
    - [x] Step 1: 認証 `auth.ts` (Bearer パース/fail-fast/ミドルウェア) + test
    - [x] Step 2: 集約ストア `store.ts` (upsert/list/getEvents/prune/voice・TTL・dedup) + test
    - [x] Step 3: Ingestion `ingest.ts` (validateSnapshot/voiceEvent・RateLimiter/Cooldown・ルータ工場) + test
    - [x] Step 4: 配線 `cli.ts`/`server.ts` (`--mode`・server 限定で auth+ingest+CORS限定・local 不変)
    - [x] Step 5: `npm run build` + `npm test` 緑 / プラン実走ログ更新
  - [x] Phase 3: サーバ — ダッシュボードミラー配信 (集約ストア→views.ts描画・SSE push駆動化) [plan](docs/plans/claude-progress-voice-phase3.md)
    - [x] Step 1: store read API (`listSessions`/`getEventsBySession`) + 合成 id ヘルパ + test 更新
    - [x] Step 2: `EntrySource` 拡張 (`readEvents`/`summaryTargetOf`) + `RemoteEntrySource` + `buildProcessViewData(events?)` + test
    - [x] Step 3: `ingest.ts` onChange + `server.ts`/`cli.ts` 配線 (RemoteEntrySource・id 探索・SSE push・marker watch ゲート)
    - [x] Step 4: `npm run build` + `npm test` 緑 / server モード実走ログ
    - 注: 「ログインページ」は親プラン確定どおり Cloudflare Access (Phase 7) に委譲 (本フェーズ対象外)
  - [x] Phase 4: クライアント — uplink エージェント (`--mode client`・既存検出再利用・push・リトライ/バッファ・WSL2/Mac両対応) [plan](docs/plans/claude-progress-voice-phase4.md)
    - [x] Step 1: 設定 + allowlist + シリアライズ + 状態遷移検出 (純粋部) + test
    - [x] Step 2: HTTP poster + voice queue + ランナー `startUplink` + test
    - [x] Step 3: `processes.ts` platform 分岐 + darwin スキャフォルド / `cli.ts` client 配線
    - [x] Step 4: `npm run build` + `npm test` 緑 / dryrun 実走ログ / プラン更新
    - 注: macOS の process 検出 (`ps`+`lsof`) は後追い。`processes.ts` の darwin はスキャフォルド (空配列)
  - [ ] Phase 5: ペルソナ文生成 + TTS (Haikuでキャラ口調短文・TTS抽象化+キャッシュ・`/api/voice/audio/:id`認証付き)
  - [ ] Phase 6: Web UI 再生 + ミラー表示 (ログインUI・ON/OFF/音量/フィルタ/履歴・SSE順次再生)
  - [ ] Phase 7: デプロイ & 公開 (g3plus に Docker compose 追加・Cloudflare Tunnel `ccm.chobi.me`・Access ポリシー)
  - [ ] Phase 8: 仕上げ (redaction/保持調整・CLAUDE.md/README更新・E2E・TODO/DONE整理)