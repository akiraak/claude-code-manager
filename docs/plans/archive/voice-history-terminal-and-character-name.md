# Dashboard 履歴に端末表示 + ログ/読み上げにキャラ名

## 目的・背景

2 人会話化（`voice-content-align-ai-twitch-cast`）後の細かな見やすさ改善。2 件まとめて対応する。

1. **Dashboard の履歴にも端末を表示する**: ダッシュボードのカード（ミラー）には送信元端末ラベル（clientId）が出るが、ボイス履歴（`vh-row`）には出ていない。どの端末の発話かを履歴でも分かるようにする。
2. **ログと Dashboard の読み上げにキャラ名を含める**: サーバのボイスログ行（`[ai-monitor] voice ▶ …`）に話者キャラ名（ちょビ/なるこ）が無い。ログにキャラ名を足す。Dashboard 側（履歴の speaker チップ + 再生中表示）は Phase 5 で既にキャラ名を出しているので、ログ側を揃える。

## 対応方針

- **影響範囲は表示・ログのみ**。発話生成・データモデル（`Utterance` は既に `speaker` を持つ）・送信経路は変更しない。
- キャラ名は `speaker`（`teacher`/`student`）→ persona の名前で解決する。
  - サーバ: `characterFor(persona, u.speaker).name`。
  - ブラウザ: 既存の `SPEAKER_LABEL = { teacher:'ちょビ', student:'なるこ' }`。

## 変更点

- `ai-monitor/src/views.ts`
  - 履歴行 `renderHistory()` に端末 `m.clientId` の `vh-client` スパンを追加（+ CSS）。
- `ai-monitor/src/server.ts`
  - `onUtterance` のログ行に話者キャラ名を追加（`<clientId> 🔊 ちょビ: <text>` の形）。`characterFor` を import。

## テスト方針

- `views.test.ts`: `renderDashboard(voice:true)` の出力に `vh-client` / `SPEAKER_LABEL` が含まれることを assert（履歴行はブラウザ描画なのでスクリプト文字列の存在で担保）。
- ログ行はサーバ起動時の副作用なので手動目視（`run-voice-server.sh`）。
- 既存 159 テストを壊さない（`npm test`）。

## 後片付け

- 両 TODO を `DONE.md` へ。本プランを `docs/plans/archive/` へ。
