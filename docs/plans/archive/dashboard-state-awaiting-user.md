# Yes/No 選択待ちが「AI処理中」になる問題の修正 (2026-05-12)

## 目的・背景

TODO:

> Yes / No の選択肢が出てるのでステータスは「AI処理中」になってる

ダッシュボードカードで、Claude が `AskUserQuestion` / `ExitPlanMode` などのユーザー応答待ちツールを呼んだ直後、CLI 自体は何も処理していない (純粋にユーザーの選択待ち) のに **AI処理中** バッジが出る。

理由: `classifyV2` の判定が「プロセス生存 + 直近 30 秒以内に jsonl 更新あり」だけを見ているため、AskUserQuestion の tool_use が jsonl に書き込まれた瞬間 (mtime 更新) から 30 秒間は AI処理中 になってしまう。

期待値: 「実質的にユーザー入力待ち」と分かるシグナルがあるなら **待機中** にしたい。

## 対応方針

`tail` から「末尾が未一致 (= tool_result の無い) tool_use で、かつそのツール名がユーザー応答を要する種類」かを判定するフラグを足し、`classifyV2` で **プロセス生存 && そのフラグ true → waiting** と分岐させる。

ユーザー応答待ちと見なすツール: `AskUserQuestion`, `ExitPlanMode`
(ほかの Bash 等は「ツール実行中」なので AI処理中 のままで良い)

## 影響範囲

- `ai-monitor/src/transcript.ts`
  - `TailSummary` に `endsWithInteractiveToolUse: boolean` を追加
  - `summarizeTail` で「末尾が未一致 tool_use && toolName が許可リスト」のとき true
- `ai-monitor/src/state.ts`
  - `ClassifyInput` に `endsWithInteractiveToolUse` を追加
  - `classifyV2`: プロセス生存 && `endsWithInteractiveToolUse` のとき `waiting` に強制
  - `buildEntries` で渡す
- バッジ自体は既存の `waiting` を流用 (新規 state は追加しない)
- README / CLAUDE.md の state 定義表の `待機中` 説明に「ユーザー応答待ちツール (AskUserQuestion 等) 実行中」も含む旨を一文追記

## テスト方針

- 動作確認: 本タスク自体が AskUserQuestion を含むやり取りで進むため、再現環境を別途用意する必要なし
  - ai-monitor を再起動した状態で、別の Claude セッションが AskUserQuestion を呼んでいる間にダッシュボードを開いて「待機中」と出ることを目視確認
  - その後の通常 Bash 実行中は引き続き AI処理中 のまま遷移することを確認 (誤検知が増えていない)
- 単体テストは導入していないので追加しない

## 実装完了 (2026-05-12)

### 変更点

- `ai-monitor/src/transcript.ts`:
  - `INTERACTIVE_TOOL_NAMES = { AskUserQuestion, ExitPlanMode }` を新設
  - `TailSummary.endsWithInteractiveToolUse: boolean` を追加。`summarizeTail` で末尾が未一致 tool_use かつツール名が許可リストにあるとき true
- `ai-monitor/src/state.ts`:
  - `ClassifyInput.endsWithInteractiveToolUse` を追加し `buildEntries` で渡す
  - `classifyV2`: プロセス生存 && interactive tool 未応答 → mtime 関係なく `waiting`
- `ai-monitor/src/views.ts`: 待機中の tooltip を「Yes/No 等のユーザー応答待ちも含む」に更新
- `README.md` / `CLAUDE.md` の state 定義表で待機中の条件を追記

### 動作確認

`node -e` で `summarizeTail` + `classifyV2` を直接叩いて 3 ケースを検証:

| 入力 | classify 結果 |
|---|---|
| AskUserQuestion pending (mtime fresh) | **waiting** ✅ |
| Bash pending (mtime fresh) | ai-processing (誤検知なし) ✅ |
| ExitPlanMode pending (mtime fresh) | **waiting** ✅ |

`run-ai-monitor.sh` で再起動し、ダッシュボードに新しい tooltip 文言が表示されていることも確認。
