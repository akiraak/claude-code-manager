# TODO

- [x] vibeboard を clone する方法に変更する ([plan](docs/plans/vibeboard-customtabs-upstream-and-clone.md)) — **完了**（DONE.md への移動のみ保留: voice タスクの DONE.md 未コミット編集と衝突するため、そのコミット後に移す）
  - 方針: customTabs を upstream vibeboard にクリーン実装 → CCM を適合 → vendored をやめて clone 取得へ
  - 完了: upstream `v0.2.0` を **push 済み** (origin/main `fc8c675` + tag `v0.2.0`)。CCM `feat/vibeboard-clone` を **main へ ff マージ済み**。実リモート (HTTPS) からの clone+build を検証済み。
  - [x] Phase 0: customTabs プラグイン契約・並び順/自動選択の仕様・リリース方針を確定 (契約は upstream README に明文化。並び順=他タブの左・自動選択=先頭 item は固定仕様 + 文書化。`item-changed` に `reload` フラグを追加して CCM 依存を除去)
  - [x] Phase 1: vibeboard (upstream) に汎用 customTabs を実装 (脱 CCM・サンプル/README 整備) — `~/vibeboard-upstream` で実装・build・sample で動作確認済み
  - [x] Phase 2: upstream をリリース (バージョン上げ + タグ) — origin/main `fc8c675` + tag `v0.2.0` を push 済み
  - [x] Phase 3: CCM の AI Monitor を新 customTabs 契約に適合 — `item-changed` に `reload:false` を付与 (dashboard/proc:*。旧 vibeboard でも無害)。build + test 通過
  - [x] Phase 4: run-ai-monitor.sh を clone 取得へ切替・vendored vibeboard を追跡削除 + gitignore — HTTPS 既定・ref 存在の pre-flight チェック・一時 dir clone で既存消失防止。実リモートで bootstrap 検証済み
  - [x] Phase 5: CLAUDE.md / 起動手順のドキュメント更新