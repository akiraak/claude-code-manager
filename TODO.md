# TODO

- [ ] 読み上げの頻度が高すぎるので調整する [plan](docs/plans/voice-frequency-investigation.md)
  - [x] Phase 1: 実測（completed 80% / progress 13% / awaiting 7%・ピーク 14 発話/分）
  - [x] Phase 2: 主因の切り分け（completed＝毎ターン完了が支配・大半は 2 分未満の短ターン）
  - [x] Phase 3: 調整レバーの評価（作業量ゲート主軸＋progress 延長＋cooldown 補助）
  - [ ] 試験運用①: progress（2 分間隔の発話）を 0% にして運用 [plan](docs/plans/voice-progress-off-trial.md)
    - [x] server に `CCM_VOICE_SPOKEN_KINDS`（読み上げ kind を env 可変化）を実装
    - [ ] `CCM_VOICE_SPOKEN_KINDS=completed,awaiting` で運用し体感を評価（`.env` 設定済み・server 再起動が必要）
  - [ ] Phase 4: 結論 → 実装プラン化（`docs/plans/voice-frequency-tuning.md`）

- [ ] イベントが別の音声の場合は間を少し開ける