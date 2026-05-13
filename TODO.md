# TODO

## ダッシュボード
- [ ] 権限プロンプト (Bash/Edit/Write 等の Yes/No) 表示中も「入力待ち」として検知 [plan](docs/plans/awaiting-input-via-hook.md)
  - [ ] Phase 1: `~/.claude/hooks/ccm-awaiting-marker.py` 追加 + global settings.json に PermissionRequest / PostToolUse / Stop hook 登録
  - [ ] Phase 2: `ai-monitor/src/awaiting-input.ts` 追加 + `classifyV2` に marker 判定を組み込み
  - [ ] Phase 3: marker ディレクトリを fs.watch して SSE で push (ダッシュボード自動更新)
  - [ ] Phase 4: CLAUDE.md / README の状態バッジ説明を更新
- [ ] /clear などコマンド入力直後にダッシュボードが「AI処理中」になる (jsonl mtime 更新で `classifyV2` が ai-processing に判定する。実際は AI 処理は走っていないので「待機中」が妥当)
- [ ] カードをタップするとdashboaerdが全体表示される。プロセスごとの詳細ページに飛ばして

- [ ] プロセスの表示はtool_useとtool_resultがほとんどなので、それはグループ化する。ユーザー入力と最終的な出力が見やすくなるようにする