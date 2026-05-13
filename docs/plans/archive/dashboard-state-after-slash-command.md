# ダッシュボードがスラッシュコマンド直後に「AI処理中」になる問題の修正

## 目的・背景

`/clear` や `! ls` のように **AI 呼び出しを伴わないユーザー操作** を行った直後、ダッシュボードのカードが「AI処理中」(緑・脈動) として表示される。実際には CLI は何も処理しておらず、本来は「待機中」(黄) が妥当。

ユーザー体験上「複数 CLI のうちどれが本当に動いているか」を一目で判別するのがダッシュボードの主目的なので、偽の「処理中」表示はノイズになる。

## 現状の挙動

`ai-monitor/src/state.ts:106-112` の `classifyV2`:

```ts
if (!opts.hasProcess) return 'stopped';
if (opts.endsWithInteractiveToolUse || opts.hasAwaitingMarker) return 'awaiting-user';
const t = opts.lastActivityAt ? Date.parse(opts.lastActivityAt) : NaN;
if (Number.isFinite(t) && Date.now() - t <= AI_PROCESSING_FRESH_MS) return 'ai-processing';
return 'waiting';
```

判定は `mtime が直近 30 秒以内 → ai-processing` のみで、jsonl 末尾に何が書かれたかは見ていない。`/clear` を打つと jsonl には以下が追記される:

```
1. user (caveat, isMeta)        ← <local-command-caveat>...
2. user (command-name)          ← <command-name>/clear</command-name>
3. system (subtype=local_command) ← <local-command-stdout></local-command-stdout>
4. file-history-snapshot
```

assistant メッセージは追記されないので、AI は起動していない。にも関わらず mtime は更新されるため、30 秒間 ai-processing と誤判定される。

## 根本原因

`mtime の新しさ ≒ AI 処理中` という近似が破綻するケース:

- スラッシュコマンドのうち AI を呼ばないもの (`/clear`, `/help`, `/config`, `/exit`, `/login` など): user-text と system local_command stdout だけが書かれる
- `! ...` のシェル実行: 同じく system local_command stdout で終わる
- `/init`, `/review`, `/security-review` のような **AI を呼ぶスラッシュコマンド** は最後に assistant message が書かれるので別物として扱える

つまり jsonl の **末尾イベントが `system` subtype `local_command`** であれば AI は介在していない、という判別が可能。

## 方針

末尾イベントの種別を見て、AI を呼ばないローカルコマンドで終わっているセッションは `waiting` に倒す。

### 変更点

1. **`NormalizedEvent` に `systemSubtype?: string` を足す** (`ai-monitor/src/transcript.ts`)
   - `readTailEvents` の `type === 'system'` 分岐 (l.297-302) で `obj.subtype` を読み取り、`system` イベントに保持する
   - 既存の `kind: 'system'` 描画には影響しない

2. **`TailSummary` に `endsWithLocalCommand: boolean` を足す**
   - `summarizeTail` の末尾判定 (l.375-386) で「最終イベントが `kind: 'system'` かつ `systemSubtype === 'local_command'`」のとき `true`
   - 既存の `endsWithInteractiveToolUse` と並列に持つ

3. **`classifyV2` で `endsWithLocalCommand` をチェック**
   - `awaiting-user` 判定の後に「`endsWithLocalCommand` が true なら mtime に関わらず `waiting`」を入れる
   - 入力シグネチャ (`ClassifyInput`) に `endsWithLocalCommand: boolean` を追加

4. **`buildEntries` から `endsWithLocalCommand` を渡す**
   - プロセス起点ループ (l.169-174) と stopped 候補ループ (l.198-203) の `classifyV2` 呼び出し両方を更新

### 判定順 (更新後)

```
1. hasProcess=false                                   → stopped
2. endsWithInteractiveToolUse || hasAwaitingMarker    → awaiting-user
3. endsWithLocalCommand                               → waiting  ★ 追加
4. mtime <= 30s                                       → ai-processing
5. それ以外                                            → waiting
```

### 補足: AI を呼ぶスラッシュコマンドへの影響

`/init`, `/review` 等は最後に assistant text / tool_use が書かれるため、tail の末尾は `assistant-text` か `tool-use`。`endsWithLocalCommand` は false のまま → これまで通り ai-processing と判定される (正しい)。

### 不採用案: Stop hook + marker

[[awaiting-input-via-hook]] と同じ流儀で Stop / UserPromptSubmit hook を新設し、AI 処理中フラグを `/tmp/claude-code-manager/...` に置く方法も考えられる。しかし:

- グローバル hook の追加デプロイが必要 (ユーザー操作が増える)
- jsonl だけで判別できる情報を hook 経由にするのは複雑度が増す
- 一方の利点は「mtime に依存しないので 30 秒のグレーゾーンを正確化できる」だが、今回直したい症状はその外側の話

ので、本タスクでは jsonl 末尾シグナル方式 (上記方針) を採る。

## 影響範囲

- `ai-monitor/src/transcript.ts`
  - `NormalizedEvent` (`systemSubtype` 追加)
  - `readTailEvents` (system 分岐で subtype を保持)
  - `TailSummary` (`endsWithLocalCommand` 追加)
  - `summarizeTail` (末尾判定)
- `ai-monitor/src/state.ts`
  - `ClassifyInput` (`endsWithLocalCommand` 追加)
  - `classifyV2` (判定ロジック)
  - `buildEntries` (2 箇所の `classifyV2` 呼び出し)
- vibeboard プラグイン側 (`ai-monitor/src/server.ts`) は state 文字列を消費するだけなので **変更不要**
- 既存 4 状態 (`ai-processing` / `awaiting-user` / `waiting` / `stopped`) は維持。新規 state は増やさない
- `CLAUDE.md` の状態バッジ表の `待機中` 行に「ローカルコマンド直後を含む」旨を追記

## テスト方針

`ai-monitor` には現状自動テスト基盤が無いので、手動 + ユニットテスト追加で確認する。

### Step 1: ユニットテスト (新規)

`ai-monitor/src/state.test.ts` か `transcript.test.ts` (新規) で `classifyV2` の判定ケースを表現:

- mtime 直近 + endsWithLocalCommand=true → `waiting`
- mtime 直近 + endsWithLocalCommand=false → `ai-processing`
- mtime 直近 + endsWithInteractiveToolUse=true + endsWithLocalCommand=true → `awaiting-user` (interactive を優先)
- hasProcess=false + endsWithLocalCommand=true → `stopped`

(テスト基盤未整備なら最小限の node:test ベースで追加する)

### Step 2: 手動確認

1. `./run-ai-monitor.sh` で起動
2. 別ターミナルで `claude` を起動して `/clear` を打つ
3. ダッシュボードのカードが「待機中」になることを確認 (黄バッジ / 静止)
4. 続けて普通のプロンプトを送信し、「AI処理中」(緑脈動) に切り替わることを確認
5. `! ls` を打って system local_command で終わる状態を作り、「待機中」になることを確認
6. `/init` のような AI 起動スラッシュコマンドを試し、「AI処理中」のままになることを確認

## Phase / Step

- [ ] Step 1: `NormalizedEvent` / `readTailEvents` に `systemSubtype` を持たせる
- [ ] Step 2: `TailSummary` / `summarizeTail` に `endsWithLocalCommand` を実装
- [ ] Step 3: `ClassifyInput` / `classifyV2` / `buildEntries` で `endsWithLocalCommand` を利用
- [ ] Step 4: ユニットテストを追加して 4 つの判定ケースをカバー
- [ ] Step 5: `CLAUDE.md` の状態バッジ表に注釈を追記
- [ ] Step 6: 手動確認 (`/clear` / `! ls` / 普通プロンプト / AI 起動スラッシュコマンド)
