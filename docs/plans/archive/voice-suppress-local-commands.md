# コマンド（/clear 等）を発話しないようにして問題ないか — 調査プラン

## 目的・背景

`/clear` `/help` `! ls` のような **AI 呼び出しを伴わないローカルコマンド** を叩いたときに
進捗読み上げが発火することがある。これを「発話しない」ようにして実害が無いかを確認する調査。

結論を先に書くと、**ローカルコマンド終端のセッションは読み上げを抑制してよい**（むしろ抑制すべき）。
本調査でその根拠・発火経路・副次バグ・推奨実装をまとめる。実装は本調査の結論を受けて行う。

## 調査結論（先出し）

1. **ローカルコマンドが発話を起こすのは 1 ケースだけ**: AI がターンを終えてから 30 秒
   (`AI_PROCESSING_FRESH_MS`) 以内にローカルコマンドを叩いた場合。state が
   `ai-processing → waiting` に倒れて **`completed`（読み上げ対象）が前倒しで発火**する。
   - 30 秒の窓を過ぎた完全アイドル時に叩いた `! ls` 等は `waiting → waiting` で **遷移なし＝無音**（既に問題なし）。
   - ローカルコマンドは `started` / `awaiting` を起こさない（state を ai-processing / awaiting-user に倒さないため。`started` はそもそも無音）。
2. **抑制して問題ない**。消えるのは「30 秒窓内の前倒し completed」だけで、ローカルコマンドを
   叩いている＝そのセッションのキーボードの前に居る＝完了は既に分かっている。音声の価値は
   「見ていない別端末」なので、手元のコマンドに反応した発話は不要。検出は projectDir 単位なので
   当該セッションの completed を抑えても**他端末の完了発話には一切影響しない**。
3. **副次バグも発見**: 前倒し completed の発話 context (`userPrompt`) に**コマンド文字列やシェル
   出力が混入**する（`extractWorkContext` のコマンド除外ガードが効いていない）。発話台本が
   「ユーザーの指示: /clear」のような無意味な内容になる。抑制（結論 2）で発火自体が消えるが、
   ガード自体も独立に直す価値がある。

## 現状の発火経路（コード調査済み）

読み上げ = client (`--mode client`) の遷移検出 → server (`--mode server`) の台本生成 → TTS。

### state 判定: `ai-monitor/src/state.ts` `classifyV2`
ローカルコマンド終端 (`endsWithLocalCommand`) は **`waiting`** に分類される（state.ts:130）。
`endsWithLocalCommand` は末尾が `system` kind の `local_command` subtype のとき true（transcript.ts:397）。

### client 遷移検出: `ai-monitor/src/uplink.ts` `VoiceEventDetector` / `transitionEvent`
- **`state` だけを見て遷移イベントを出す**。`endsWithLocalCommand` を一切参照しない
  （`VoiceSessionInput` にそのフィールドが無い。voice 経路を grep してもヒット 0）。
- `transitionEvent`（uplink.ts:406）:
  - `* → awaiting-user` → `awaiting`
  - `* → ai-processing` → `started`（server で無音）
  - `ai-processing → waiting` → **`completed`**
- server 側 `voice-pipeline.ts:21` `SPOKEN_KINDS = ['awaiting','completed','progress']` で読み上げ対象を決定（`started` 除外）。

### なぜ 30 秒窓内のコマンドが completed を起こすか
`classifyV2` はターン終了後も jsonl mtime が新しい 30 秒間は `ai-processing` のまま
（completed は本来この窓が切れた時点で発火する）。その窓内にローカルコマンドを叩くと
`endsWithLocalCommand=true` で即 `waiting` に倒れ、`ai-processing → waiting` 遷移として
**completed が前倒し発火**する。detail は直前ターンの `lastAssistantText`（＝正規の完了内容）。

## 具体シナリオ

| タイミング | prev state | コマンド後 state | 遷移 | 発話 |
|---|---|---|---|---|
| ターン完了 5 秒後に `/clear` | ai-processing（窓内） | waiting | ai-processing→waiting | **completed（前倒し・読み上げ）** |
| 完全アイドル時に `! ls` | waiting | waiting | なし | 無音 |
| 完了 40 秒後（completed 発火済み）に `/clear` | waiting | waiting | なし | 無音 |

→ 問題になるのは 1 行目だけ。`voice-frequency-investigation.md` の所見
（「`/clear` 後など短い往復」「ai-processing⇄waiting フラッピングで completed が過剰」）とも一致する。

## 副次バグ: 発話 context へのコマンド混入

`transcript.ts:474-477` `extractWorkContext` は user-text のうち
`t.startsWith('<command-name>')` / `<local-command` を除外して `userPrompt` を作る意図だが、
**`readTailEvents` → `formatUserMessageForDisplay` が先に `<command-name>/clear</command-name>` を
`/clear` へ整形済み**なので、このガードは恒常的に空振りする。結果:
- `/clear` → `userPrompt = "/clear"`
- `! ls` → `userPrompt = (ls の標準出力)`（`<local-command-stdout>` も剥がれているため）

これが前倒し completed の context に乗り、`persona.ts:321`（`ユーザーの指示: ${userPrompt}`）で
そのまま発話台本に入る。

## 推奨実装（実装フェーズで対応）

- **対応 A（主軸・推奨）**: ローカルコマンド終端のセッションは遷移イベントを emit しない。
  - `TailSummary.endsWithLocalCommand`（既存）を `VoiceSessionInput` に通す（uplink.ts の `inputs` 組み立て）。
  - `transitionEvent` / `observe` で `endsWithLocalCommand` のときは emit せず **state 記録だけ更新**
    （既存の同一ターン dedup と同じく state machine は壊さない書き方にする）。
  - 効果: 「30 秒窓内コマンドの前倒し completed」を消す。副作用は「コマンドを叩いたセッションの
    完了が無音」だけ（結論 2 のとおり許容）。
- **対応 B（独立の堅牢化・任意）**: `extractWorkContext` のコマンド除外を整形後の形に合わせて修正。
  - 整形でコマンド痕跡が消えるので、user-text 側で別フラグ（例: `readTailEvents` で
    `isLocalCommand` を立てる）を持たせて除外する、等。A を入れれば前倒し発火自体は消えるが、
    context 品質の保険として価値がある。

A だけで本タスクの症状（コマンドで喋る）は解消する。B は defense-in-depth。

## 影響範囲

- 調査フェーズはコード変更なし。
- 実装フェーズ（A）の変更想定: `ai-monitor/src/uplink.ts`（`VoiceSessionInput` / `transitionEvent` / `observe` / `tickOnce` の inputs 組み立て）。
- 実装フェーズ（B）の変更想定: `ai-monitor/src/transcript.ts`（`readTailEvents` / `extractWorkContext`）。
- server 側 (`voice-pipeline.ts` / `persona.ts`) は変更不要。

## テスト方針

- 調査フェーズは自動テスト不要。
- 実装フェーズ（A）: `uplink.test.ts` の時刻注入パターンに合わせ、
  「ai-processing → waiting だが `endsWithLocalCommand=true` のとき completed を emit しない」
  「ローカルコマンドでない通常完了は従来どおり completed を emit する」の 2 ケースを追加。
- 実装フェーズ（B）: `transcript.test.ts`（既に command 系のテストあり）に
  「`/clear` / `! ls` 終端で `userPrompt` が undefined になる」ケースを追加。

## 未決事項（実装フェーズへ持ち越し）

- 対応 A のみにするか、B も併せて入れるか。
- 抑制を env で ON/OFF 可能にするか（既定は抑制で十分そう。`CCM_VOICE_SPOKEN_KINDS` のような
  既存の可変化方針と整合させるかは実装時に判断）。

## 実装結果（2026-06-20・A + B 実装済み）

ユーザー判断で **対応 A + B の両方** を実装した。env での ON/OFF は付けず、ローカルコマンドは
常に抑制する（既定で十分・コマンドは手元操作なので無音が望ましい）。

- **対応 A**（`ai-monitor/src/uplink.ts`）:
  - `VoiceSessionInput` に `endsWithLocalCommand?: boolean` を追加。
  - `tickOnce` の inputs 組み立てで `e.tail?.endsWithLocalCommand` を載せる（送信はしない・client 内抑制のみ）。
  - `VoiceEventDetector.observe` の state-changed 分岐で、`endsWithLocalCommand` のときは
    `transitionEvent` を呼ばず（`ev = null`）emit しない。state 記録は従来どおり行い machine は前進させる
    （窓が切れた後の正規遷移は壊れない）。
- **対応 B**（`ai-monitor/src/transcript.ts`）:
  - `NormalizedEvent` に `isLocalCommand?: boolean` を追加。
  - `isLocalCommandRaw(raw)` を新設し、`readTailEvents` の user-text 生成 2 箇所（string / array-text）で
    **整形前 raw** から判定してフラグを立てる。
  - `extractWorkContext` のコマンド除外を、空振りしていた `startsWith` から `!ev.isLocalCommand` に置換。
- **テスト**:
  - `uplink.test.ts`: 「ローカルコマンド終端は completed を発話しない（+ 次の正規ターンは started から始まる）」
    「通常完了は従来どおり completed」を追加。
  - `transcript.test.ts`: 既存 `extractWorkContext` テストを新フラグ前提に作り替え（/clear を末尾に置いても
    userPrompt を上書きしないことを確認）、`readTailEvents` の isLocalCommand 付与テストを追加。
- **検証**: `npx tsc --noEmit` 緑 / `npm test` 175 件すべて pass。
