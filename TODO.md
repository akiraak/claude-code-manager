# TODO

## AI Monitor

- [ ] 新しいクライアント環境でhookなどの初期設定を行う
  - グローバル hook `~/.claude/hooks/ccm-awaiting-marker.py`（権限プロンプト承認待ち検出用）はリポ未管理で各端末に手動配置が必要。Mac には未配置。
  - `~/.claude/settings.json` の `PermissionRequest` 登録も含め、新規端末セットアップ手順 / スクリプトとして整備する。

- [ ] 読み上げが途中で途切れる。文字数制限はAIでのテキスト生成で行い、読み上げは全てのテキストを読む
- [ ] 読み上げの内容が ai-twitch-cast と違う。まずは違う箇所を調査