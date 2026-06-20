# TODO

## AI Monitor

- [ ] 読み上げ内容を ai-twitch-cast に合わせる（モデルは Haiku 維持）[plan](docs/plans/voice-content-align-ai-twitch-cast.md)
  - [x] Phase 1: 2 キャラ persona 設定 + ちょビ/なるこ移植（voice-persona.json / persona.ts）
  - [x] Phase 2: コンテキスト拡張（client アクション抽出 / store・uplink・ingest・redaction）
  - [x] Phase 3: 対話生成（Haiku → JSON 配列 / 反復防止 / ハード切り詰め廃止＝途切れ解消）
  - [x] Phase 4: マルチ発話パイプライン + 2 声 TTS（voice-pipeline / voice-store / tts）
  - [x] Phase 5: UI 会話表示 + emotion/SE 配線（views.ts）
  - [ ] Phase 6: 記憶層（Persona/Self-Note 自動更新）— 段階導入可（未着手・任意）
  - [x] Phase 7a: テスト（159 pass）+ ドキュメント（CLAUDE.md）
  - [ ] Phase 7b: 手動 E2E（実 client→server→ブラウザで 2 人会話の順次再生・要 API キー）+ プラン archive

- [ ] ./run-ai-monitor.sh に run-voice-server.sh の機能を入れる
- [ ] クライアントプロセスのターミナルへの表示を増やす。案を出す
- [ ] 端末ごとの会話が混じっているように聞こえる。調査して