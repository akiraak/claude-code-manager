# TODO

## AI Monitor

- [ ] ./run-ai-monitor.sh に run-voice-server.sh の機能を入れる [plan](docs/plans/run-ai-monitor-merge-voice-server.md)
  - [ ] Phase 1: run-ai-monitor.sh を server + client 起動へ改修 (config 解決 / token・URL 注入 / stop_existing スコープ / 3 プロセス管理 / ログ)
  - [ ] Phase 2: run-voice-server.sh を削除し参照を整理
  - [ ] Phase 3: CLAUDE.md ほかドキュメント更新
  - [ ] Phase 4: 動作検証 (キー有無 / トークン一致 / 別端末 client の隔離 / 旧 local 解放)

- [ ] なるこにボケとダジャレ要素を入れる