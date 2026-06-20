# 別イベントの発話間に少し間を開ける

## 目的・背景

ダッシュボードの順次再生 (server モードのボイス UI) では、1 イベント (状態遷移) が
2〜4 発話の会話台本になり、同一 `groupId` でまとまって配信される。
現状は発話を全てキューで連続再生するため、**別イベント** の会話が前のイベントに
切れ目なく続いてしまい、どこで話題が切り替わったか聞き取りづらい。

→ 連続する発話の `groupId` が変わったとき (= 別イベント) だけ、短い無音を挟む。

## 対応方針

`ai-monitor/src/views.ts` の `DASHBOARD_VOICE_SCRIPT` (クライアント側順次再生) を変更する。

- `GROUP_GAP_MS` (既定 700ms) 定数を追加。
- 直近に再生した発話の groupId を `lastGroupId` で保持。
- `pump()` で次の発話を取り出したとき、`lastGroupId` が設定済みかつ groupId が
  異なる場合は `setTimeout` で `GROUP_GAP_MS` だけ待ってから `play()` する
  (待機中も `playing = true` にして二重 pump を防ぐ。タイマは `gapTimer` で保持)。
- `play()` で `lastGroupId` を更新。
- `done()` でキューが空になった (= 一区切り) ら `lastGroupId` を null に戻し、
  無音明けの最初の発話は待たせない (= イベントが連続するときだけ間が入る)。
- OFF トグル / 履歴の即時再生 (`playNow`) では `gapTimer` を破棄する
  (無効化後に遅延再生が走らないように)。

`groupId` 未設定の発話は `id` 単体を 1 グループ扱いにする。

## 影響範囲

- `ai-monitor/src/views.ts` の `DASHBOARD_VOICE_SCRIPT` のみ (クライアント JS)。
- サーバ/ストア/配信メタは変更なし (`UtteranceMeta.groupId` は既に配信済み)。

## テスト方針

- `npm run build` が通ること。
- 既存テストへの影響なし (クライアント文字列のため `views.test.ts` で
  該当ロジックの存在を軽く確認できれば追加するが、純粋な再生タイミングは
  ヘッドレスでは検証しづらいため最小限)。
