# DONE

- 2026-05-12: ダッシュボード カード化 + AI 要約 ([plan](docs/plans/archive/dashboard-cards-and-summary.md))
    - Phase 1: カード化 + 状態バッジ刷新 (AI処理中 / 待機中 / 停止 / エラー) + 停止 CLI を 10 分保持
    - Phase 2: AI 要約バックエンド (.env / dotenv / @anthropic-ai/sdk / キャッシュ)
    - Phase 3: UI と要約の接続 / SSE 経由の自動更新
    - Phase 4: README / CLAUDE.md 追記、DONE.md 移動、プラン archive
- 2026-05-12: AI Monitor タブを vibeboard メニューの一番左に配置
- 2026-05-12: 現在動いているclaude code cliの状況をvibeboardに表示 ([plan](docs/plans/archive/ai-monitor.md))
    - Phase 1: vibeboard 拡張機構 (customTabs)
    - Phase 2: AI Monitor サーバ実装
    - Phase 3: AI Monitor フロント (Dashboard / Process 詳細)
    - Phase 4: 起動・運用 (run-ai-monitor.sh / README)
    - Phase 5 (AI 要約) は将来課題として保留。着手時は別プラン (`docs/plans/ai-monitor-summarize.md`) に切り出す
