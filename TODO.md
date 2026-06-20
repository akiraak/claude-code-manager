# TODO

- [ ] vibeboard を clone する方法に変更する ([plan](docs/plans/vibeboard-customtabs-upstream-and-clone.md))
  - 方針: customTabs を upstream vibeboard にクリーン実装 → CCM を適合 → vendored をやめて clone 取得へ
  - [ ] Phase 0: customTabs プラグイン契約・並び順/自動選択の仕様・リリース方針を確定
  - [ ] Phase 1: vibeboard (upstream) に汎用 customTabs を実装 (脱 CCM・サンプル/README 整備)
  - [ ] Phase 2: upstream をリリース (バージョン上げ + タグ) ★ユーザー確認/担当
  - [ ] Phase 3: CCM の AI Monitor を新 customTabs 契約に適合
  - [ ] Phase 4: run-ai-monitor.sh を clone 取得へ切替・vendored vibeboard を追跡削除 + gitignore
  - [ ] Phase 5: CLAUDE.md / 起動手順のドキュメント更新