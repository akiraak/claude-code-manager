# TODO
- [ ] ダッシュボード カード化 + AI 要約 [plan](docs/plans/dashboard-cards-and-summary.md)
  - [x] Phase 1: カード化 + 状態バッジ刷新 (AI処理中 / 待機中 / 停止 / エラー) + 停止 CLI を 10 分保持
  - [ ] Phase 2: AI 要約バックエンド (.env / dotenv / @anthropic-ai/sdk / キャッシュ)
  - [ ] Phase 3: UI と要約の接続 / SSE 経由の自動更新
  - [ ] Phase 4: README / CLAUDE.md 追記、DONE.md 移動、プラン archive
- [ ] プロセスの表示はtool_useとtool_resultがほとんどなので、それはグループ化する。ユーザー入力と最終的な出力が見やすくなるようにする