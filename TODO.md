# TODO

## ダッシュボード
- [ ] 要約が直近すぎるのでいくつか前のものも含める。とくに直前のユーザー入力の内容は入れる [plan](docs/plans/summary-context-and-collapsible.md)
  - [x] Phase 1-A: `server.ts` の要約用 `readTailEvents` を 50 → 150 に増やす
  - [x] Phase 1-B: `Summarizer.getOrCompute` / `wait` に `SummarizeInput` 形式の引数を導入し `recentUserText` を渡せるようにする (テスト追随)
  - [x] Phase 1-C: `renderEventsForPrompt` を「ピン留め + 直近」の 2 セクション構築に変更 (`PROMPT_MAX_CHARS` 6000 / ピン留め 1200 文字 / 重複排除)
  - [x] Phase 1-D: `SYSTEM_PROMPT` を「2〜3 行 / 200 文字程度」に調整し `RESPONSE_MAX_TOKENS` を 360 に
  - [x] Phase 1-E: `/api/summarize` で `findLastUserText` の結果を `recentUserText` として渡す
  - [x] Phase 1-F: `renderEventsForPrompt` で `tool-use` / `tool-result` を除外 + `readTailEvents` の窓を 150 → 300 (会話ターンが多く拾えるように)
- [ ] 要約の先頭の一部しか表示されない。最初は折りたたみで展開できるようにする。最初の一部表示も文字数を増やす [plan](docs/plans/summary-context-and-collapsible.md)
  - [x] Phase 2-A: CSS: `.card-summary-text` の line-clamp 3 → 6、`.card-summary.expanded` で clamp 解除、トグルボタンスタイル
  - [x] Phase 2-B: `renderSummaryFromData` の OK ブランチに `data-collapsible` + `data-summary-key` + `<button data-summary-toggle>` を出す
  - [x] Phase 2-C: `DASHBOARD_SCRIPT` にトグルクリックハンドラ + 短い要約時にボタンを hidden する初期判定を追加
  - [x] Phase 2-D: `DASHBOARD_LIVE_SCRIPT` の `updateCard` で `data-summary-key` 一致時のみ展開状態を復元
  - [x] Phase 2-E: `views.test.ts` に新 OK ブランチの DOM 構造テストを追加
- [ ] (上記 2 タスク共通) Phase 3 手動確認: ツール往復 30 回以上のセッションで要約に直近ユーザー入力が反映されること / 展開 / 折りたたみ / SSE 中の状態保持 / 短い要約でトグル非表示

- [ ] Claude Code 作業でサーバが止まっている場合がある。原因を調べて
ubuntu@Sx360:~/claude-code-manager$ ./run-ai-monitor.sh
[build] vibeboard: npm run build

> vibeboard@0.1.0 build
> tsc

[build] ai-monitor: npm run build

> ai-monitor@0.1.0 build
> tsc

[stop] vibeboard を停止: 1383950
[start] ai-monitor pid=1385679 port=8181
[start] vibeboard  pid=1385680 port=8180
[vibeboard] running at http://127.0.0.1:8180
[vibeboard] root: /home/ubuntu/claude-code-manager
[vibeboard] title: claude-code-manager
[vibeboard] categories: plans, specs
[vibeboard] editable: TODO.md, DONE.md
[vibeboard] customTabs: ai-monitor→http://127.0.0.1:8181
[ai-monitor] ANTHROPIC_API_KEY: 検出 (要約機能 有効)
[ai-monitor] running at http://127.0.0.1:8181
[ai-monitor] projects dir: /home/ubuntu/.claude/projects
[ai-monitor] endpoints: /api/sidebar, /api/dashboard.json, /api/process.json, /view?item=..., /api/watch
ubuntu@Sx360:~/claude-code-manager$


- [ ] プロセスの表示はtool_useとtool_resultがほとんどなのでそれはグループ化する。
      ユーザー入力と最終的な出力が見やすくなるようになるようなデザインや機能を入れる [plan](docs/plans/process-view-tool-grouping.md)
  - [ ] Phase 1-A: `ai-monitor/src/turns.ts` 新規 + `Turn` 型 + `groupEventsIntoTurns(events)` 実装
  - [ ] Phase 1-B: `turns.test.ts` で境界 / 孤児ターン / `finalAssistant` 抽出 / meta-user / system イベントの所属を確認
  - [ ] Phase 2-A: `views.ts` CSS に `.turn` 系セクションを追加 (ユーザー / ツール / 中間 / 最終)
  - [ ] Phase 2-B: `renderTurn(turn, index): { key, html }` 実装 (tool 内訳サマリ含む)
  - [ ] Phase 2-C: `buildProcessViewData` を `events → turns` に変更 (戻り値型も変更)
  - [ ] Phase 2-D: `renderProcessView` を `data-events → data-turns` に改名し turns を吐く
  - [ ] Phase 3-A: `PROCESS_VIEW_LIVE_SCRIPT` の selector / コンテナ / payload キーを turn 用に書き換え
  - [ ] Phase 3-B: `<details>` の open 状態保持 (`data-detail-id` ベースで集めて復元)
  - [ ] Phase 3-C: 末尾スクロール追従 / 完了ターン非更新 が壊れないことを手動確認
  - [ ] Phase 4-A: `views.test.ts` で `data-turn-key` / `data-turns` / 各セクションの出し分けを確認
  - [ ] Phase 4-B: 既存スナップショット系テストの `data-event-key` 参照を `data-turn-key` に更新
  - [ ] Phase 5: 手動確認 (プランの「対応方針 Phase 6」手順 1〜8)