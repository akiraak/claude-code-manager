# ダッシュボードカードで直近のユーザー入力を保持する

対象 TODO: `入力待ちのあとYes/Noを選択したあとはuserが「まだ入力がありません」になってしまう。直近にユーザーが入力した内容を表示したい`

## 目的・背景

AI Monitor のダッシュボードカードはターミナル風 UI で「直近の user 発言」と「直近の assistant 発言」を 1 ブロックずつ表示している。
ところが、ユーザーが 1 回プロンプトを打ったあと Bash/Edit/Write などの権限プロンプトに Yes/No を連打したり、ツール往復が長く続いた長いターンに入ると、カードの user 欄が `(まだユーザー入力がありません)` に化けてしまう。

### 再現

1. `claude` を立ち上げ、何かしらユーザー入力を打つ (例: `dashboard のテストをして`)
2. その応答として AI が Bash や Edit を 30〜50 回程度走らせる (各回 Yes/No 承認するか自動承認される)
3. ダッシュボードカードの user ブロックが空表示 `(まだユーザー入力がありません)` に変わる
4. 同セッションの assistant ブロックは新しい応答で更新され続ける

### 原因 (確認済み)

- `ai-monitor/src/state.ts:161` `readTailEvents(ts.jsonlPath, 50)` で末尾 **50 イベント** しか読まない
- `ai-monitor/src/transcript.ts:369` `summarizeTail` はその 50 件の中だけを走査して `lastUserText` / `lastUserAt` を抽出する
- 1 ツール往復で `tool_use` + `tool_result` の 2 イベントが書かれるので、**およそ 25 ツール以上連続する**と直近の `user-text` イベントは 50 件枠から押し出される
- 結果として `summarizeTail` の戻り値 `lastUserText` が undefined → `views.ts:367` で `(まだユーザー入力がありません)` を出す

「Yes/No 選択そのものが user-text に書かれていない」ことが直接の原因ではなく (Yes/No は jsonl 上では `tool_result` として現れる)、**直前の user-text が tail 窓から落ちる** ことが本質。

### ゴール

- セッションが続いている限り、ダッシュボードカードの user ブロックには「直近にユーザーが実際に打った内容」を出し続ける
- ツール往復が何百回続いても消えない
- 表示フォーマットは現状の `formatUserMessageForDisplay` を踏襲する (`/clear` などの XML 包みは剥がす、`! ls` 出力はそのまま、通常のテキストは生のまま)
- 状態判定 (`classifyV2`) には**手を入れない**。state は末尾イベントの kind と marker で決まるので、user-text の遡及探索は無関係。

## 対応方針

「state 判定用の tail 窓」と「カード表示用の直近 user 入力」を関心ごと分離する。

`transcript.ts` に新ユーティリティ `findLastUserText(jsonlPath, mtimeMs)` を追加し、`buildEntries` で `summarizeTail` の `lastUserText` が undefined のときだけフォールバックで呼ぶ。state 判定で使う `summarizeTail` (および `readTailEvents(50)`) はそのまま据え置く。

### `findLastUserText` の挙動

シグネチャ案:

```ts
export interface LastUserTextRef {
  text: string;
  at: string; // ISO timestamp
}

export function findLastUserText(jsonlPath: string, mtimeMs: number): LastUserTextRef | null;
```

実装方針:

1. **メモリキャッシュ**: `Map<jsonlPath, { mtimeMs, value: LastUserTextRef | null }>` を `transcript.ts` 内 module スコープに 1 つ持つ
   - キャッシュキー: `jsonlPath`、突き合わせは `mtimeMs` 完全一致
   - `mtimeMs` が一致していれば即返す (jsonl は append-only なので mtime 変化なし = ログも変化なし)
   - サーバ再起動でクリアされる前提 (`summarize.ts` のメモ Map と同じ揮発戦略)
2. **キャッシュミス時のスキャン**: 末尾バイトを読み広げながら user-text を探す
   - 初手で **256KB** をフッタから読む。`readTailBytes` を流用
   - 行を末尾から逆順に走査し、行を `JSON.parse` → `type === 'user'` の `message.content` から `formatUserMessageForDisplay` を通してテキストを取り出す
     - `content` が `string`: そのまま採用
     - `content` が `Array<{type:'text',text}>`: `type === 'text'` の最後の要素を採用
     - `content` が `Array<{type:'tool_result', ...}>`: スキップ (Yes/No 承認は捨てる)
   - `isMeta === true` の user 行はスキップ
   - 最初に 1 件採れたら、それを `{ text, at: timestamp }` として返してキャッシュ
3. **窓の段階拡張**: 採れなければ 256KB → 1MB → 4MB → 16MB と倍々に広げる
   - 16MB まで読んでも user-text が無いセッションは「本当に入力なし」とみなして `null` でキャッシュ
   - 上限は安全弁。実セッションは数 MB に収まるはずなので通常は 256KB で当たる
4. **行頭欠けの考慮**: `readTailBytes` の挙動どおり、tail バッファの先頭 1 行は中途半端な可能性があるため捨てる。倒順走査でも同じく先頭行は飛ばす。

### `buildEntries` への組み込み

`ai-monitor/src/state.ts:155-185` 周辺で、tail 取得後にフォールバックを噛ませる:

```ts
const events = ts ? readTailEvents(ts.jsonlPath, 50) : [];
let tail = ts ? summarizeTail(events) : undefined;
if (ts && tail && !tail.lastUserText) {
  const recalled = findLastUserText(ts.jsonlPath, ts.mtimeMs);
  if (recalled) {
    tail = { ...tail, lastUserText: recalled.text, lastUserAt: recalled.at };
  }
}
```

プロセス未生存側 (`stopped` カード) でも同じフォールバックを適用する。停止カードは 24h 残るので、停止時点の直前ユーザー入力が見えていてほしい。

### 「Yes/No 自体を表示したい」拡張は今回はやらない

TODO 文面の素直な解釈は「直前にユーザーが**打った**内容を表示したい」なので、tool_result に書かれる Yes/No 文字列は採用しない。仮に Yes/No を出しても情報量が乏しいため、後続の TODO「要約が直近すぎる…」の領分とみなす。

## 影響範囲

- `ai-monitor/src/transcript.ts`
  - `findLastUserText` を新規追加 (module-scope cache 含む)
  - 既存 `summarizeTail` / `readTailEvents` は触らない (互換維持)
- `ai-monitor/src/state.ts`
  - `buildEntries` のプロセス生存ループと停止ループで `findLastUserText` フォールバックを噛ませる
- `ai-monitor/src/views.ts`
  - 触らない (`lastUserText` が埋まるだけで表示パスは現状どおり)
- `ai-monitor/src/summarize.ts` / `server.ts` / `awaiting-input.ts`
  - 触らない

## Phase / Step 分割

### Phase 1: `findLastUserText` を `transcript.ts` に追加

- 関数本体 + module-scope の `Map` キャッシュ
- 256KB → 1MB → 4MB → 16MB の段階拡張ロジック
- `formatUserMessageForDisplay` を共有する (現状のフォーマット規約を踏襲)
- 既存パーサに重複コードを増やさないよう、`readTailEvents` の user 分岐を切り出した小ヘルパ `parseUserTextFromLine(raw): {text, at}|null` を内部実装として置く案 (任意)
- ユニットテストはこの Phase ではまだ書かない (Phase 3 で実 jsonl を組んで検証)

### Phase 2: `buildEntries` でフォールバックを呼ぶ

- プロセス生存ループ・停止ループの両方でフォールバック
- `tail` が `undefined` のとき (jsonl 自体無し) は呼ばない
- 既に `lastUserText` が埋まっている場合も呼ばない (キャッシュヒット時のコストは無視できるが無駄打ち回避)

### Phase 3: テスト追加

- `ai-monitor/src/transcript.test.ts` を新規追加 or 既存 `state.test.ts` / `views.test.ts` に追記
  - **ケース A**: jsonl に `user-text → assistant-text → tool_use/tool_result を 60 セット` 並べたファイルを `tmpdir` に書き、`findLastUserText` で最初の user-text が返ることを確認
  - **ケース B**: jsonl に `user-text` が一切ない場合 (新規セッションで Yes/No だけ) → `null` を返す
  - **ケース C**: `<command-name>/clear</command-name>...` 形式の user 行が直近のとき → `formatUserMessageForDisplay` を通って `/clear` が返る
  - **ケース D**: mtime キャッシュが効くこと (同じ mtime で 2 回呼んで 2 回目はファイル I/O ゼロを spy で確認、または最低でも結果が等価なことを確認)

### Phase 4: 手動確認

`./run-ai-monitor.sh` でサーバを起動した上で:

1. 別ターミナルで `claude` を起動して `dashboard カードの test 用に echo を 50 回繰り返して` のような長尺タスクを投げる
2. ダッシュボードカードの user ブロックが**最初の入力**のまま消えないことを目視
3. 続けて新しいユーザー入力を打つ → user ブロックがその新入力に更新されること
4. `/clear` を入力したあとも user ブロックが `/clear` と表示されること (XML 包みが剥がれる)
5. プロセスを `Ctrl+C` して停止カードに落ちたあとも、最後に打ったユーザー入力が残っていること

## やらないこと (スコープ外)

- Yes/No 承認の表示 / 「Yes」を user メッセージとして並べる
- カードに過去ターンの user 入力を複数並べる (TODO 上では別項目: `要約が直近すぎる…`)
- プロセス詳細ビュー (`renderProcessView`) の遡及。詳細ビューは別途 200 イベント読んでいるので影響は別問題
- `readTailEvents` の limit 引き上げ。tail 窓は state 判定に最適化されているので変えない方針
- jsonl の forward-only インクリメンタル読み出し (差分のみ追加読み)。MVP では mtime キャッシュ + 全体 backward scan で十分
