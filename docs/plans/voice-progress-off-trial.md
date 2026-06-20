# 試験運用①: progress（2 分間隔の途中経過発話）を 0% にして運用してみる

## 目的・背景

調査（[voice-frequency-investigation](voice-frequency-investigation.md)）で、読み上げ発話の内訳は
**completed 80% / progress 13% / awaiting 7%**（実測 543 発話 / 193 分）と判明した。

いきなり主因の completed（80%）に手を入れる前に、**最小・低リスクのレバーから運用で試す**。
第 1 弾として **`progress`（ai-processing が 2 分超続いたとき & 以降 2 分ごとの途中経過発話・実測 73 発話 = 13%）を 0%（＝読み上げ OFF）** にして数時間運用し、体感がどれだけ静かになるかを確かめる。

- `completed`（80%）/ `awaiting`（7%・人間の応答待ち＝最重要）は **今回は触らない**。
- これは恒久仕様の確定ではなく**運用テスト**。結果次第で「progress OFF を恒久化」or「次は completed の作業量ゲートを試す」を決める。

## 方針：どこで切るか

**server 側で「読み上げる kind」を env で可変にする**のを採用する。

理由:
- server は全端末の voice-event を集約する**アグリゲータ**。env 1 つ（server のみ）で**全端末を一括 OFF** にできる → 各 client を再設定せず試せる。運用テスト向き。
- ロールバックは env を戻して server 再起動するだけ。コードは後方互換（既定は現行どおり 3 種）。

不採用案（メモ）:
- **client 側で progress 生成を止める**（例 `CCM_VOICE_PROGRESS=off` で `VoiceEventDetector` が progress を出さない）: client→server の送信も減る利点はあるが、**全 client で個別に env 設定**が要る。一括試験には不向きなので今回は見送り（将来、帯域も削りたくなったら検討）。
- **progress 間隔を延ばすだけ**（`CCM_PROGRESS_EVERY_MS` を 5 分等に）: 「0% にしたい」という要望には合わないので今回は対象外（ただし env で可能なので、OFF が静かすぎたらこちらに切替できる）。

## 変更内容（最小）

1. `ai-monitor/src/voice-pipeline.ts`
   - モジュール定数 `SPOKEN_KINDS` を **`VoicePipeline` のコンストラクタ option `spokenKinds?: VoiceEventKind[]`** にする（既定 = 現行 `['awaiting','completed','progress']`）。
   - `handle()` の `if (!SPOKEN_KINDS.includes(event.kind)) return []` をインスタンスの集合参照に変更。
   - 既存の `export const SPOKEN_KINDS`（既定値）は残し、`started` 除外などの後方互換テストを壊さない。
2. `ai-monitor/src/server.ts`
   - env **`CCM_VOICE_SPOKEN_KINDS`**（csv・既定 `completed,awaiting,progress`）をパースし、`new VoicePipeline({ ..., spokenKinds })` に渡す。
   - 不正/未知の kind は無視、空なら既定にフォールバック（fail-safe）。
   - 起動ログ（`[ai-monitor] voice: ...` の行）に **`spoken=<kinds>`** を併記し、どの設定で動いているか分かるようにする。
3. ドキュメント / env
   - `.env`（実運用）に `CCM_VOICE_SPOKEN_KINDS=completed,awaiting` を設定（= progress 0%）。
   - `.env.example` と `CLAUDE.md` の server env 一覧に `CCM_VOICE_SPOKEN_KINDS` を追記。

## 影響範囲

- `ai-monitor/src/voice-pipeline.ts`（spokenKinds の option 化）
- `ai-monitor/src/server.ts`（env パース + VoicePipeline へ注入 + 起動ログ）
- `ai-monitor/src/voice-pipeline.test.ts`（テスト追加・下記）
- `.env` / `.env.example` / `CLAUDE.md`（env ドキュメント）
- client 側・state 判定・TTS・ストアは**変更なし**。

## テスト方針

### 自動テスト（unit）
- `spokenKinds: ['completed','awaiting']` の `VoicePipeline` に `progress` イベントを流すと **utterance 0 件**（`onUtterance` 未呼び出し）。
- 同設定で `completed` / `awaiting` は従来どおり生成される。
- **既定（option 未指定）では現行どおり 3 種**（`awaiting`/`completed`/`progress`）を読む（後方互換）。
- `started` は設定に関わらず読まれない（既存挙動の維持）。

### 運用テスト（本命）
1. `.env` に `CCM_VOICE_SPOKEN_KINDS=completed,awaiting` を入れて `./run-ai-monitor.sh` で server 再起動。
2. 起動ログに `spoken=completed,awaiting` が出ることを確認。
3. 数時間、通常どおり複数端末で運用。
4. 検証指標（`logs/voice-server.log`）:
   - `grep -c '\[progress\]' logs/voice-server.log` が運用区間で **0 件**。
   - `[completed]` / `[awaiting]` は従来どおり出る。
   - 総発話が**おおよそ 13% 減**（実測ベースの見込み）。
5. 体感評価: 残る completed/awaiting の頻度が許容できるか。
6. 判断:
   - 十分静か → progress OFF を恒久設定として残す（or 必要なら間隔延長に切替）。
   - まだ多い → 次の試験（**completed の作業量ゲート** = 投資プランの推奨 3-1）へ進む。

## ロールバック

- `.env` から `CCM_VOICE_SPOKEN_KINDS` を削除（or `completed,awaiting,progress` に戻す）→ server 再起動で現行に復帰。コードは既定が後方互換なので影響なし。

## TODO 反映

- 親タスク「読み上げの頻度が高すぎるので調整する」の配下に試験運用①として追加（本プランへリンク）。
