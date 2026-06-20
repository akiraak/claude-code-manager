# TODO

## AI Monitor

- [ ] 新しいクライアント環境でhookなどの初期設定を行う [plan](docs/plans/new-client-setup.md)
  - グローバル hook `~/.claude/hooks/ccm-awaiting-marker.py`（権限プロンプト承認待ち検出用）はリポ未管理で各端末に手動配置が必要。Mac には未配置。
  - `~/.claude/settings.json` の `PermissionRequest` 登録も含め、新規端末セットアップ手順 / スクリプトとして整備する。
  - hook あり/なし比較: hook が足すのは Bash/Edit/Write 権限プロンプトの「入力待ち」検出のみ。完了/途中経過/対話ツールの承認待ち音声は hook 非依存（＝今 hook 無しでも音声は鳴る）。
  - [x] Phase 1: hook を `ai-monitor/hooks/ccm-awaiting-marker.py` としてリポに vendor
  - [x] Phase 2: `scripts/setup-client.sh`（hook 配置 + settings.json 冪等マージ + .env 雛形）
  - [ ] Phase 3: macOS 固有確認（python3 所在 / プロセス検出は実装済み）
  - [ ] Phase 4: `CLAUDE.md` / `README.md` に手順 + 比較表を追記

- [ ] 読み上げが途中で途切れる。文字数制限はAIでのテキスト生成で行い、読み上げは全てのテキストを読む
- [ ] 読み上げの内容が ai-twitch-cast と違う。まずは違う箇所を調査と整理