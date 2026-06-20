# WebUI 音量スライダーと実際の音量を一致させる

## 目的・背景

AI Monitor (server モード) のボイス UI にある音量スライダー (0–100%) を動かしても、
「表示している % と実際に聞こえる音量が違う」という問題がある。

原因はスライダー値を `audio.volume = volume / 100` と **線形** にゲインへ渡していること。
`HTMLAudioElement.volume` は **振幅 (リニアゲイン)** だが、人間の音量知覚は **対数的** なので、
線形マッピングだと中間域が体感上ずっと大きく聞こえる
(例: スライダー 50% → 振幅 0.5 = 約 -6dB ≒ 体感「半分よりかなり大きい」)。
結果としてスライダー位置と聞こえ方が一致しない。

## 対応方針

スライダー位置 (0–100%) を「知覚音量を線形に表すもの」とみなし、
知覚カーブに通して振幅へ変換する。表示する数値はスライダー % のまま (ユーザーの意図する音量) で、
内部の `audio.volume` だけを知覚カーブ経由の振幅にする。

カーブは exp ベースの定番マッピングを採用:

```
gain(x) = (exp(x) - 1) / (e - 1)   (x = pct/100, x<=0 は 0)
```

- x=1.0 → 1.0 (フル)
- x=0.0 → 0.0 (無音)
- x=0.5 → 約 0.38 (≈ -8dB ≒ 体感ほぼ半分)

線形 (`x`) より低〜中域を絞るので、スライダー % と体感が揃う。

## 影響範囲

- `ai-monitor/src/views.ts` の `DASHBOARD_VOICE_SCRIPT` 内
  - `applyVolume()` を `perceptualGain(volume)` 経由に変更
  - `perceptualGain()` を追加
- 数値表示 (`applyVolumeNum` / `data-voice-volume-value`) は変更なし (スライダー % のまま)
- localStorage キー `ccm-voice-volume` も従来どおりスライダー % を保存 (互換維持)
- サーバ側 (tts.ts / voice-pipeline.ts) に音量処理は無いので変更なし

## テスト方針

- `ai-monitor/src/views.test.ts` に、生成スクリプトが知覚カーブ
  (`perceptualGain` / `Math.exp`) を含み、素の `volume / 100` をオーディオ音量に
  使っていないことを確認するアサーションを追加
- `npm test` (ai-monitor) が通ること
- 手元のダッシュボードでスライダーを動かし体感が滑らかになることを確認
