# 読み上げ頻度の調整 — 調査プラン

## 目的・背景

AI Monitor (server モード) の進捗読み上げが**頻度が高すぎる**。
作業中ずっと喋り続ける状態になっており、通知としての価値が下がっている。

本プランは「どこで・どの種別が・どれくらいの頻度で発火しているか」を実測で特定し、
**どのレバーをどの閾値で調整すべきか**を結論づける調査フェーズ。
実装は本調査の結論を受けて別プラン (`docs/plans/voice-frequency-tuning.md` 予定) に切り出す。

## 現状の発火経路（コード調査済み）

読み上げは client (`--mode client`) の検出 → server (`--mode server`) の台本生成 → TTS で行われる。

### client 側: `ai-monitor/src/uplink.ts` `VoiceEventDetector.observe`
projectDir 単位で前回 state を覚え、遷移から voice-event を出す。

| 種別 (`kind`) | 発火条件 | server で読む？ |
|---|---|---|
| `completed` | `ai-processing → waiting`（= **毎ターン終了**） | ✅ 読む |
| `awaiting`  | `* → awaiting-user`（権限プロンプト / 質問 / ExitPlan 毎） | ✅ 読む |
| `progress`  | `ai-processing` 継続が `progressAfterMs` 超、以降 `progressEveryMs` ごと | ✅ 読む |
| `started`   | `* → ai-processing`（指示受信相当） | ❌ 除外 |

- 除外は server 側 `voice-pipeline.ts:21` `SPOKEN_KINDS = ['awaiting','completed','progress']`。
- 既定間隔: `DEFAULT_PROGRESS_AFTER_MS = 120_000` / `DEFAULT_PROGRESS_EVERY_MS = 120_000`
  （env `CCM_PROGRESS_AFTER_MS` / `CCM_PROGRESS_EVERY_MS` で上書き可）。

### 既存の抑制機構（= これしか無い）
- `spokenTransitionSig` … **同一ターンの再発火のみ** dedup（`lastAssistantAt` で判定）。別ターンは抑制しない。
- `VoiceEventQueue` … `maxSize = 100` の満杯破棄（頻度制御ではなく送信バッファ）。
- `VoicePipeline.enqueue` … utterance を**直列化**（混線防止であって間引きではない）。

### 主因の仮説
- **`completed` が毎ターン発火**するため、短い往復（即答 Q&A・`/clear` 後など）でも 2〜4 発話の会話が生成される。
- 複数ターミナル同時稼働で件数が線形に増える。
- **per-session cooldown / 作業量ゲート / グローバルレート制限は一切無い** → これが頻度過多の構造的原因。

## 調査項目（Phase / Step）

### Phase 1: 実測 — どの kind が何回出ているか
- [x] **1-1** 計測源を特定。**ground truth = `logs/voice-server.log`**（server が実際に喋った utterance を 1 行 1 発話で記録: `[ai-monitor] voice ▶ HH:MM:SS [kind] <端末> 🔊 話者: 本文`）。client 側遷移は `logs/voice-client.log`（`formatTransitionLine`、**ただし時刻印字なし** → 所要時間の算出には使えない）。
- [x] **1-2** kind 別発火回数を採取（下記 実測結果）。
- [x] **1-3** 複数端末（hp / mac の 2 本）合計の発話レートを採取（下記 実測結果）。

### Phase 2: 主因の切り分け
- [x] **2-1** `completed` が支配的か → **発話の 80% が completed**。仮説どおり最大ノイズ源。
- [x] **2-2** 「短い/軽いターン」の割合 → 直接の所要時間計測は client ログに時刻が無く不可。**proxy: progress は 2 分超のターンだけに出る**。completed イベント ≈ 150 に対し progress イベント ≈ 25 → **大半（おおよそ 8 割超）のターンは 2 分未満の短いターンなのに毎回完了発話している**。
- [x] **2-3** `awaiting` 7% / `progress` 13%。awaiting は最小だが**最重要信号**（人間の応答待ち）。

## 実測結果（2 端末・発話のあった 193 分ぶん / `logs/voice-server.log`）

| 指標 | 値 |
|---|---|
| 総発話数 (utterance) | **543** |
| kind 別 | **completed 433 (80%)** / progress 73 (13%) / awaiting 37 (7%) |
| 端末別 | hp 267 / mac 234（ほぼ均等・線形に増える） |
| アクティブ時平均 | **2.8 発話/分** |
| ピーク | **14 発話/分（≈ 4 秒に 1 発話）**。4 発話/分以上の「うるさい」分が 56 分 |
| 1 イベント当たり | 2〜4 発話の会話（ちょビ⇄なるこ）。completed 433 発話 ≈ **約 150 会話** |

### 結論（主因）
1. **`completed`（毎ターン終了発話）が全発話の 80% = 構造的な最大ノイズ源。** 短い往復でも 2〜4 発話を生成する。
2. **`progress`（2 分周期）が 13%。** 長時間ターン中に積み上がる第 2 のノイズ。
3. **`awaiting` は 7% だが最重要**（人間の応答が要る）→ **間引かない**。
4. client ログで started 68 > completed 44 = **状態フラッピング（ai-processing⇄waiting の往復）** で completed が論理ターン数以上に出ている兆候あり。cooldown / 最小発話間隔で吸収できる。

### Phase 3: 調整レバーの評価
各候補の**効果**（実測値に対してどれだけ減るか）と**副作用**を評価した。

| # | レバー | 効く対象 | 推定削減 | 副作用 | 実装位置 |
|---|---|---|---|---|---|
| 3-1 | **完了を作業量でゲート**（`elapsedMin` or `actions` 数が下限未満なら completed を喋らない） | completed 80% | **大**（短い往復＝大半を消せる） | 軽い作業の完了が無音に（許容範囲。重要なのは承認待ち） | **client**（`extractWorkContext` の結果が手元にある。検出時に落とすのが素直） |
| 3-2 | **セッション毎クールダウン**（直近 N 秒に喋ったセッションは completed/progress を抑制） | completed + フラッピング | 中（バースト・往復を吸収） | クールダウン中の完了を取りこぼす | **server**（端末横断・時刻注入済みで載せやすい） or client |
| 3-3 | サーバ全体レート制限（全端末合計で N 秒 1 会話） | 全 kind の総量 | 中〜大（ピーク 14/分 を平準化） | awaiting まで遅延・欠落しうる（最重要信号を削るのは危険） | server |
| 3-4 | **`progress` 間隔の延長**（既定 2 分 → 例 5 分） | progress 13% | 中（73→約30 発話相当） | 長時間ターンの「生存通知」が減る（許容） | client（`CCM_PROGRESS_EVERY_MS` 既定変更） |
| 3-5 | awaiting は**間引かない**で確定 | — | — | （守るべき信号） | — |

#### 推奨（実装プランへ）
- **3-1（作業量ゲート）を主軸**にする。80% の塊に最も直接効き、副作用が「軽作業の完了が無音」だけで小さい。
- **3-4（progress 間隔延長）を併用**して 2 番手のノイズを削る。
- **3-2（セッション cooldown）を補助**でフラッピング由来の重複を吸収。
- **3-3（全体レート制限）は見送り寄り** — awaiting（最重要）まで削るリスクがあるため、3-1/3-4/3-2 で足りなければ最後に検討。
- 閾値は **env 可変**（例 `CCM_VOICE_MIN_ACTIONS` / `CCM_VOICE_MIN_ELAPSED_SEC` / `CCM_VOICE_SESSION_COOLDOWN_SEC` / 既定 `CCM_PROGRESS_EVERY_MS`）にして調整を後追い可能にする。
- [x] 3-1〜3-5 評価済み（上表）。実装位置・閾値の最終確定は実装プランで行う。

### Phase 4: 結論 → 実装プラン化
- [ ] **4-1** 推奨レバーの組合せと既定閾値を決定（env で調整可能にする方針を含む）。
- [ ] **4-2** 実装プラン `docs/plans/voice-frequency-tuning.md` を起こし、本調査プランは `docs/plans/archive/` へ移動。

## 影響範囲（調査フェーズ）

- 原則**コード変更なし**。Phase 1 の計測で一時的な集計ログを足す可能性があるが、調査後に戻す。
- 調査で参照する主なファイル:
  - `ai-monitor/src/uplink.ts`（`VoiceEventDetector` / 既定間隔 / queue）
  - `ai-monitor/src/voice-pipeline.ts`（`SPOKEN_KINDS` / 直列化）
  - `ai-monitor/src/voice-store.ts`（utterance 集計）
  - `ai-monitor/src/server.ts`（`onVoiceEvent` 受け口・端末横断の状態が見える層）
  - `ai-monitor/src/transcript.ts`（`extractWorkContext` = 作業量の素データ）

## テスト方針

- 調査フェーズはコード変更最小のため自動テストは原則不要。Phase 1 で計測補助を足す場合も一時的なログに留める。
- 実装フェーズ（別プラン）で、選定したレバーの判定ロジックに unit test を追加する
  （例: 作業量ゲートの境界、cooldown の時刻注入テスト、レート制限のバースト挙動）。既存の `uplink.test.ts` / `voice-pipeline.test.ts` の時刻注入パターンに合わせる。

## 未決事項（実装プランへ持ち越し）

- どのレバーを採用するか（単独 or 組合せ）。
- 各閾値の既定値（作業量ゲートの秒数/アクション数、cooldown 秒、全体レート、progress 間隔）。
- 調整値を env で可変にするか固定にするか。
