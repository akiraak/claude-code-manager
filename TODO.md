# TODO

## AI Monitor

- [ ] macOS (darwin) の claude プロセス検出を実装する（Mac で進捗音声が喋らない原因）[plan](docs/plans/darwin-process-detection.md)
  - [ ] Phase 1: 純関数パーサ + 単体テスト（`parsePsClaudePids` / `parseLsofCwd`）
  - [ ] Phase 2: darwin 検出のワイヤリング（`listClaudeProcessesDarwin` を ps+lsof 実装に）
  - [ ] Phase 3: Mac 実機検証（ユーザー担当。AI処理中/完了/承認待ち と発話を確認）
