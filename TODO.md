# TODO

- [ ] claudeの進捗状況を音声でしゃべる機能を入れる [plan](docs/plans/claude-progress-voice.md)
      ~/ai-twitch-cast に Claude Code の hook と、それを Windows アプリで音声を生成する機能があるのでそれを改善したものを作る
      構成: 各端末(WSL2/Mac)が状態を push → 公開サーバ(ai-monitor server モード)で集約+AI音声生成 → ブラウザでミラー表示+再生
      公開前提: Cloudflare Tunnel(TLS) / 端末別トークン+UIログイン / ダッシュボードもミラー / キャラ口調 / 発話: 完了・承認待ち・途中経過
  - [ ] Phase 1: 設計確定 & 基盤 PoC (データソース抽象化・Cloudflare Tunnel PoC・TTS選定+ブラウザ再生PoC・redaction/保持方針)
  - [ ] Phase 2: サーバ — 認証 + Ingestion 基盤 (Bearer/UIセッション・CORS限定・`/api/ingest/*`・集約ストア・dedup/レート制限)
  - [ ] Phase 3: サーバ — ダッシュボードミラー配信 (集約ストア→views.ts描画・SSE push駆動化・ログインページ)
  - [ ] Phase 4: クライアント — uplink エージェント (`--mode client`・既存検出再利用・push・リトライ/バッファ・WSL2/Mac両対応)
  - [ ] Phase 5: ペルソナ文生成 + TTS (Haikuでキャラ口調短文・TTS抽象化+キャッシュ・`/api/voice/audio/:id`認証付き)
  - [ ] Phase 6: Web UI 再生 + ミラー表示 (ログインUI・ON/OFF/音量/フィルタ/履歴・SSE順次再生)
  - [ ] Phase 7: デプロイ & 公開 (g3plus に Docker compose 追加・Cloudflare Tunnel `ccm.chobi.me`・Access ポリシー)
  - [ ] Phase 8: 仕上げ (redaction/保持調整・CLAUDE.md/README更新・E2E・TODO/DONE整理)