# TODO

- [ ] vibeboard を clone する方法に変更する ([plan](docs/plans/vibeboard-customtabs-upstream-and-clone.md))
  - 方針: customTabs を upstream vibeboard にクリーン実装 → CCM を適合 → vendored をやめて clone 取得へ
  - **残: Phase 2 の upstream push (★ユーザー) → push 後に CCM ブランチ `feat/vibeboard-clone` をマージ + 実機 clone 検証**
  - [x] Phase 0: customTabs プラグイン契約・並び順/自動選択の仕様・リリース方針を確定 (契約は upstream README に明文化。並び順=他タブの左・自動選択=先頭 item は固定仕様 + 文書化。`item-changed` に `reload` フラグを追加して CCM 依存を除去)
  - [x] Phase 1: vibeboard (upstream) に汎用 customTabs を実装 (脱 CCM・サンプル/README 整備) — 別クローン `~/vibeboard-upstream` の `feat/custom-tabs`→`main` に実装・build・sample で動作確認済み
  - [ ] Phase 2: upstream をリリース (バージョン上げ + タグ) ★ユーザー確認/担当 — **ローカルで commit `fc8c675` + tag `v0.2.0` 準備済み。push は未実施 (ユーザー実行)**
  - [x] Phase 3: CCM の AI Monitor を新 customTabs 契約に適合 — `item-changed` に `reload:false` を付与 (dashboard/proc:*。旧 vibeboard でも無害)。build + test 通過
  - [x] Phase 4: run-ai-monitor.sh を clone 取得へ切替・vendored vibeboard を追跡削除 + gitignore — clone 機構はローカルミラー (v0.2.0) で検証済み。実リモート clone は push 後に確認
  - [x] Phase 5: CLAUDE.md / 起動手順のドキュメント更新