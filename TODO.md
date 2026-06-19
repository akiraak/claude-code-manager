# TODO

## AI Monitor

- [ ] macOS (darwin) の claude プロセス検出を実装する（Mac で進捗音声が喋らない原因）[plan](docs/plans/darwin-process-detection.md)
  - [x] Phase 1: 純関数パーサ + 単体テスト（`parsePsClaudePids` / `parseLsofCwd`）
  - [x] Phase 2: darwin 検出のワイヤリング（`listClaudeProcessesDarwin` を ps+lsof 実装に）
  - [ ] Phase 3: Mac 実機検証（ユーザー担当。AI処理中/完了/承認待ち と発話を確認）
    - Mac 単体での自律検証は完了: ①`listClaudeProcesses()` が稼働中 2 セッションを cwd 付きで検出 ②`buildEntries()` が両者を `ai-processing`（stopped ではない）に分類 ③`--mode client` dryrun で `process:{pid}` 付き snapshot を push。
    - 残り（ユーザー担当）: 実際の `--mode client` → WSL2 サーバで、完了/承認待ち遷移時にミラーが更新され**音声が鳴る**ことの確認のみ（voice-event は状態遷移時のみ発火するため、ターン完了を伴う実走で確認）。

- [ ] 新しいクライアント環境でhookなどの初期設定を行う
  - グローバル hook `~/.claude/hooks/ccm-awaiting-marker.py`（権限プロンプト承認待ち検出用）はリポ未管理で各端末に手動配置が必要。Mac には未配置。
  - `~/.claude/settings.json` の `PermissionRequest` 登録も含め、新規端末セットアップ手順 / スクリプトとして整備する。

- [ ] 読み上げが途中で途切れる。文字数制限はAIでのテキスト生成で行い、読み上げは全てのテキストを読む
- [ ] 読み上げの内容が ai-twitch-cast と違う。まずは違う箇所を調査