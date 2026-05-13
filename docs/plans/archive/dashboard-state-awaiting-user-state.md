# 「入力待ち」state を追加 (2026-05-12)

## 目的・背景

TODO:

> Yes/No 待ちの時は待機中とは別にできる？ユーザーが知りたいのは次へのアクションなので、こちらから入力するタイミングが一番知りたい。

複数 CLI を並行運転する目的でダッシュボードを使う場合、ユーザーが本当に欲しい情報は「**今どのセッションが自分の入力を待っているか**」。
現状の `待機中` は「AI 処理が終わって user 入力を待っている状態」と「単にアイドル」を同じバッジで出してしまっていて、優先度の判断が付かない。

ユーザーの選択 (`AskUserQuestion` 経由):
1. **対象範囲**: 「AI 処理が終わって user 入力を待っている状態すべて」
2. **ラベル**: `入力待ち`
3. **色 / 装飾**: オレンジ + 脈動 (AI処理中 の脈動緑と対をなす「あなたの番」シグナル)

## 対応方針

### state 設計 (5 種類に拡張)

| state | バッジ | 色 | 装飾 | 意味 |
|---|---|---|---|---|
| `ai-processing` | AI処理中 | 緑 | 脈動 | AI が応答生成中 / ツール実行中 |
| `awaiting-user` | **入力待ち** *(NEW)* | オレンジ | 脈動 | AI 処理が終わって user の入力を待っている (Yes/No / 通常ターン両方) |
| `waiting` | 待機中 | 黄 | 静止 | 「入力待ち」が長引いた / アイドル化したセッション |
| `stopped` | 停止 | 灰 | 静止 | プロセス消滅 + 正常 |
| `error` | エラー | 赤 | 静止 | プロセス消滅 + 末尾未一致 tool_use |

### 判定ロジックの作り直し

現行は `hasProcess && mtime < 30s → ai-processing` と「mtime のみ」で AI処理中 を決めていたが、これだと AI がターンを終えた直後 30 秒は AI処理中 が出てしまう。
ユーザー指摘の通り「**イベント内容ベース**」に作り直す。

`classifyV2` (process 生存時) の新規則:

```
let ageMs = now - lastActivityAt
let stale = ageMs > STALE_AWAITING_MS  // 30 分

if endsWithInteractiveToolUse:
  → stale ? waiting : awaiting-user

if lastEventKind == 'tool-use' && unmatched:
  → ai-processing            // 非対話ツール実行中

if lastEventKind == 'assistant-text':
  → stale ? waiting : awaiting-user   // AI が話し終えた = ユーザーの番

if lastEventKind in ('user-text', 'tool-result'):
  → ageMs < AI_PROCESSING_FRESH_MS ? ai-processing : (stale ? waiting : awaiting-user)
   // ターン途中で AI が次を書き始める寸前

else (system / 無し):
  → stale ? waiting : awaiting-user  // CLI 起動直後など、初回入力待ち
```

定数:
- `AI_PROCESSING_FRESH_MS = 30_000` (既存)
- `STALE_AWAITING_MS = 30 * 60 * 1000` (新規)

「入力待ち」と「待機中」の区別 = 経過時間。`入力待ち` が 30 分続いたら自動で `待機中` に冷却する。

### バッジの色

- `awaiting-user`: 背景 `#ffe0b2` / 文字 `#bf360c` / ドット脈動 (`badge-pulse` 流用)
- 既存色は据え置き

### tooltip

- 入力待ち: `あなたの入力を待っています (AI のターンは終了)`
- 待機中: `入力待ちのままアイドル化 (30 分以上動きなし)` に変える

## 影響範囲

- `ai-monitor/src/state.ts`
  - `ActivityState` に `'awaiting-user'` 追加
  - `STALE_AWAITING_MS` 追加
  - `classifyV2` を書き直し、`ClassifyInput` に `lastEventKind?: EventKind` を追加
  - `buildEntries` で `lastEventKind` を渡す
- `ai-monitor/src/views.ts`
  - `STATE_LABEL_JA` / `STATE_TOOLTIP_JA` に `awaiting-user` を追加、`waiting` の tooltip 文言更新
  - CSS に `.badge-awaiting-user` を追加 (オレンジ + 脈動)
- `ai-monitor/src/server.ts`
  - `STATE_MARK` / `STATE_SUB_JA` に `awaiting-user` を追加 (サイドバー用)
- `README.md` / `CLAUDE.md` の state 定義表を 5 行に更新
- `TODO.md` の親「ダッシュボード」セクションに本タスクを追加 (子なし)

## テスト方針

- ユニットテスト相当: 既存と同じく Node 直叩きで `summarizeTail` + `classifyV2` を 7-8 ケース流し、想定の state に落ちることを確認
- 手動: `run-ai-monitor.sh` で再起動 → ダッシュボードでこのセッションが期待通りのバッジになっているか確認
- 動作確認の終わりに parent task を `DONE.md`、プランを `archive/` に移動

## 実装完了 (2026-05-12)

### 動作確認

`node` で 9 ケース実行、全て期待通り:

| ケース | 結果 |
|---|---|
| AskUserQuestion pending (fresh) | awaiting-user ✅ |
| Bash tool_use pending (fresh, 非対話) | ai-processing ✅ |
| assistant-text 末尾 (fresh) | awaiting-user ✅ |
| assistant-text 末尾 (>30min) | waiting ✅ |
| user-text 末尾 (fresh) | ai-processing ✅ |
| tool-result 末尾 (fresh) | ai-processing ✅ |
| 末尾無し (no events) | waiting ✅ (lastActivityAt 無し = stale 扱い) |
| assistant-text + process 消滅 | stopped ✅ |
| Bash tool_use + process 消滅 | error ✅ |

`run-ai-monitor.sh` 再起動後、3 つの実セッションでそれぞれ別の state が出ていることを目視確認:
- ai-twitch-cast → 待機中 (黄, 静止)
- claude-code-manager → AI処理中 (緑, 脈動)
- voice-changer-lab → 入力待ち (オレンジ, 脈動) ← 新 state が実セッションで初描画

### 変更点まとめ

- `ai-monitor/src/state.ts`:
  - `ActivityState` に `'awaiting-user'` を追加 (5 種類)
  - `STALE_AWAITING_MS = 30 * 60 * 1000` を新設
  - `classifyV2` をイベント内容ベースに書き直し (last event kind + age を組み合わせ)
  - `ClassifyInput.lastEventKind?: EventKind` を追加、`buildEntries` で渡す
- `ai-monitor/src/views.ts`:
  - `STATE_LABEL_JA` / `STATE_TOOLTIP_JA` に `awaiting-user` を追加。tooltip 文言を「あなたの入力を待っています…」に
  - `.badge-awaiting-user` を新設 (背景 `#ffe0b2` / 文字 `#bf360c` / `badge-pulse` 流用)
- `ai-monitor/src/server.ts`:
  - `STATE_MARK` (サイドバー記号) / `STATE_SUB_JA` に `awaiting-user` を追加 (`◆` / `入力待ち`)
- `README.md` / `CLAUDE.md`: state 定義表を 5 行に拡張、緑/オレンジ脈動 = アクティブ / 黄灰赤 = 静止 の意味を明示

## 再調整 (2026-05-12 同日)

実セッションで動かしたところ、複数 CLI を並行運転する運用では「AI ターンが終わって放置中」のセッションが大半となり、それらが全部オレンジ脈動になることで **入力待ち の "act now" シグナルが薄まる** という UX 問題が出た (例: voice-changer-lab が コミット終了して放置中なのに 入力待ち で出ていた)。

ユーザー判断: **入力待ち は `AskUserQuestion` / `ExitPlanMode` の未一致 `tool_use` だけ** に限定。通常の AI ターン終了は 待機中 に倒す。

### 変更点 (再調整)

- `ai-monitor/src/state.ts`:
  - `STALE_AWAITING_MS` を削除 (不要になった)
  - `ClassifyInput.lastEventKind` を削除 (不要になった)
  - `classifyV2` を簡素化: `endsWithInteractiveToolUse → awaiting-user` / `mtime <30s → ai-processing` / それ以外 → `waiting`
- `ai-monitor/src/views.ts`: tooltip を簡素な条件文に戻す
- `README.md` / `CLAUDE.md`: state 定義表を簡素な条件に戻し、「入力待ちはブロッカー限定」の意図を明記

### 動作確認 (再調整後)

`node` で 8 ケース実行、全て期待通り:

| ケース | 結果 |
|---|---|
| AskUserQuestion pending (fresh) | awaiting-user ✅ |
| ExitPlanMode pending (fresh) | awaiting-user ✅ |
| Bash pending (fresh) | ai-processing ✅ |
| assistant-text 末尾 (fresh) | ai-processing ✅ (mtime <30s だから) |
| assistant-text 末尾 (>1h) | waiting ✅ |
| AskUserQuestion pending (1h old) | awaiting-user ✅ (cooldown 無し) |
| assistant-text + process 消滅 | stopped ✅ |
| Bash tool_use + process 消滅 | error ✅ |

ダッシュボード再起動後、voice-changer-lab は 入力待ち → 待機中 に正しく遷移。
