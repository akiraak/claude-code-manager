# `/clear` 等のスラッシュコマンドの XML 包みを画面表示時に剥がす

## 目的・背景

ダッシュボードのカード (`renderCard` @ `ai-monitor/src/views.ts`) は jsonl の最新 user-text を `lastUserText` として表示している。ユーザが `/clear` / `/init` / `/review` のような Claude Code のスラッシュコマンドを叩くと、jsonl 側の `message.content` は次のような XML 風文字列で書き出される。

```
<command-name>/clear</command-name>
            <command-message>clear</command-message>
            <command-args></command-args>
```

`! コマンド` (シェル実行) の場合は `<local-command-stdout>...</local-command-stdout>` だけが user メッセージとして書かれることがある。これをそのままダッシュボードに出すと「ターミナル風ブロック内に XML タグが見える」状態になり、何を実行したのか直感的に読めない。

## 方針

`transcript.ts` の `readTailEvents` で user-text を組み立てる箇所と、`type === 'system'` の content を組み立てる箇所で、XML 風包みを検出して**表示用テキスト**に整形する小さなヘルパー `formatUserMessageForDisplay(raw)` を入れる。

整形ルール:

| 入力                                                              | 出力                |
| ----------------------------------------------------------------- | ------------------- |
| `<command-name>/clear</command-name>...<command-args></command-args>` | `/clear`           |
| `<command-name>/foo</command-name>...<command-args>bar baz</command-args>` | `/foo bar baz`     |
| `<local-command-stdout>...</local-command-stdout>` (単独)         | 中身の文字列 (trim) |
| `<local-command-stdout></local-command-stdout>` (空)              | `(出力なし)`        |
| 上記以外                                                          | 入力そのまま        |

検出は寛容に正規表現で行う (`[\s\S]*?`)。前後の空白や改行・タグの順序は揺れる可能性があるので順序固定にしない。

## 影響範囲

### 変更ファイル

- `ai-monitor/src/transcript.ts`
  - ファイル末尾に `formatUserMessageForDisplay(raw: string): string` を追加
  - `readTailEvents` の以下 3 箇所で適用:
    - `type === 'user'` の `content` が string のとき
    - `type === 'user'` の `content` が配列で `it.type === 'text'` のとき
    - `type === 'system'` の `obj.content` が string のとき (local-command-stdout の単独 system event)

### 変更しないファイル

- `views.ts` / `state.ts` / `server.ts` / `summarize.ts`
  - 表示側は `text` をそのまま使う設計のままで OK
  - 要約 (`summarize.ts`) も `text` フィールドを読むので副作用で要約品質も上がる

### 互換性 / 副作用

- 整形は表示用文字列のみに作用。`endsWithInteractiveToolUse` などの state 判定は kind / toolName に基づくので影響なし
- 既存テストは無いので手動検証

## テスト方針

1. `(cd ai-monitor && npm run build)` で型エラーが出ないこと
2. `./run-ai-monitor.sh` 再起動後、ブラウザでダッシュボードを開き、直近に `/clear` を叩いたカードのユーザー欄が `/clear` と表示されていること
3. 通常のテキスト入力カードに対する回帰がないこと (本文がそのまま出る)
4. プロセス詳細ページの user-text / system イベントの表示が崩れていないこと

## オープン項目

- `<local-command-stdout>` が空のときの placeholder 文言は最初 `(出力なし)` で出して、見て気に入らなければ後で調整
