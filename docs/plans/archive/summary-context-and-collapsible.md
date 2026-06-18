# 要約の文脈拡張 + カード上での折りたたみ展開

対象 TODO:

- `要約が直近すぎるのでいくつか前のものも含める。とくに直前のユーザー入力の内容は入れる`
- `要約の先頭の一部しか表示されない。最初は折りたたみで展開できるようにする。最初の一部表示も文字数を増やす`

2 つは「ダッシュボードカードの AI 要約」に対する改善要望で密接に関連しているので、1 プランにまとめて扱う。

## 目的・背景

ダッシュボードカード右下に出ている AI 要約 (`ai-monitor/src/summarize.ts` で Claude Haiku 4.5 を呼び出して生成) について、現状は次の 2 つの不満がある。

### 不満 1: 要約に「直前のユーザー入力」が反映されないことがある

- `Summarizer.getOrCompute` に渡される events は `readTailEvents(jsonlPath, 50)` の末尾 50 件のみ
- それを `renderEventsForPrompt(events, PROMPT_MAX_CHARS=4000)` が 1 行 400 文字でトリム後、末尾から詰めて 4000 文字で切る (= 古い方から落ちる)
- ツール往復が続くセッション (1 ターン = 大量の `tool_use` + `tool_result`) では、`[user] …` の行が窓の外 or `PROMPT_MAX_CHARS` の外に押し出され、要約が「直前のユーザー意図」を反映しなくなる
- 既に `findLastUserText` (jsonl 全体を遡って最後の user-text を探す) は実装済みで、ダッシュボードカードの user ブロックは正しい入力を出している。しかし**要約プロンプト側ではこのフォールバックを使っていない**
- 結果として「カード上の user ブロックには直近の入力が出ているのに、要約だけは ツール往復の話だけになって意図不明」という乖離が起きる

### 不満 2: 要約が 3 行しか見えない / 全文を読む手段がない

- `views.ts:151-158` `.card-summary-text` は `-webkit-line-clamp: 3` で 3 行までしか表示しない
- API 側は `RESPONSE_MAX_TOKENS = 200` + 「日本語 1〜2 行で要約」というシステムプロンプトなので、もともと短めだが、それでも 3 行を超えるケースで本文の途中が切れたまま読めない
- 3 行で十分なケース (要約が短い) もあるので「**デフォルトは折りたたみ、クリックで展開**」が望ましい
- 折りたたみ時の表示文字数 (= 行数 / line-clamp) も少し増やしたい

## ゴール

- 要約プロンプトに **「直前のユーザー入力 (full)」+ 「いくつか前のユーザー入力 (短縮可)」+ 直近イベント** の 3 層を入れる。tool 往復で押し出されても直近入力は必ず混ぜる
- ダッシュボードカードの要約はデフォルト「折りたたみ (= 数行表示)」、クリックで全文展開、もう一度クリックで折りたたむ
- 折りたたみ時の表示量も少し広げる (3 行 → 6 行程度)
- SSE 経由の DOM パッチが走っても、ユーザーが手動展開した状態は維持する (同じ要約テキストである限り)
- 既存の要約キャッシュ `(jsonlPath, mtimeMs)` 単位の挙動は壊さない (古い要約は次回 mtime 変化まで残る)

## 非ゴール

- 要約の品質チューニング (システムプロンプト言い回しの精緻化)。最低限「直前のユーザー入力を踏まえて」と書く程度に留める
- 要約モデルの変更 (Haiku 4.5 据え置き)
- 「要約」ボタンの強制再生成 (現状の挙動どおり mtime 単位キャッシュのまま)
- プロセス詳細ビュー側の要約表示 (今は無いので議論しない)
- 折りたたみ状態のサーバ側永続化 (リロードで初期化されてよい)

## 対応方針

### Phase 1: 要約プロンプトに「直前ユーザー入力」を確実に含める

`ai-monitor/src/summarize.ts` の `compute` / `renderEventsForPrompt` を拡張する。

#### 1-A. 入力 events の窓を拡げる

- `server.ts:214` の `readTailEvents(entry.transcript.jsonlPath, 50)` と、`state.ts:162` の `readTailEvents(ts.jsonlPath, 50)` の責務を再確認:
  - **`state.ts:162` の 50 件** は state 判定 / カード表示 (`summarizeTail`) 用 → **据え置く**
  - **`server.ts:214` の 50 件** は要約用 → **150 件に増やす** (要約には文脈が必要)
- 副作用: jsonl I/O が増えるが、要約は `(jsonlPath, mtimeMs)` キャッシュで 1 回しか走らないので軽い

#### 1-B. `Summarizer.getOrCompute` の引数に「直前 user-text」を別経路で渡す

`Summarizer.getOrCompute` のシグネチャを拡張する案:

```ts
interface SummarizeInput {
  events: NormalizedEvent[];
  /** 末尾窓外まで遡って取った最後のユーザー入力 (`findLastUserText` の結果)。
   *  events 配列の中に既に同じものがあっても問題ない (重複表示はプロンプト側で握りつぶす) */
  recentUserText?: { text: string; at: string };
}

getOrCompute(jsonlPath: string, mtimeMs: number, input: SummarizeInput): SummaryResult
```

旧 API (`events: NormalizedEvent[]`) はテストが多いので、`SummarizeInput | NormalizedEvent[]` を受ける後方互換にするか、内部ヘルパに切り出して `getOrCompute` 自体は新形式にし、`wait` も合わせる方針 (テスト書き換えコストは数行)。

呼び出し側 (`server.ts:215` および `state.ts:readSummaryStatus` 経由):

```ts
const events = readTailEvents(entry.transcript.jsonlPath, 150);
const recalled = findLastUserText(entry.transcript.jsonlPath, entry.transcript.mtimeMs);
summarizer.getOrCompute(jsonlPath, mtimeMs, {
  events,
  recentUserText: recalled ?? undefined,
});
```

`state.ts:readSummaryStatus` は `peek` / `isInflight` しか叩かないので、引数を増やす必要は無い。**実際に計算を走らせるのは `server.ts` の `/api/summarize` だけ** (`getOrCompute` で初めて compute が起きる)。

- 補足: `buildEntries` 側で要約を自動 kick したいかは別議論。現状は「要約」ボタン押下で初めて compute が走る挙動なので、まずは触らない。

#### 1-C. プロンプトの組み立てを「ユーザー入力ピン留め」型にする

`renderEventsForPrompt` を「末尾から詰めて切る」だけでなく、以下の構造で組み立てる:

```
[最新のユーザー入力]
<recentUserText.text を 1200 文字までトリムして全文>

[直近のやり取り (古い順)]
[user] …
[tool_use:Bash] …
[tool_result] …
...
[assistant] …
```

- 上半分 (ピン留めセクション): `recentUserText` が無ければスキップ。あれば最大 1200 文字でトリム
- 下半分 (直近やり取り): 従来の `renderEventsForPrompt` をベースに、1 行最大 400 文字 / 全体最大 6000 文字で末尾から詰める (`PROMPT_MAX_CHARS` を 4000 → 6000 に引き上げ)
  - 下半分の末尾イベントが上半分と同一 user-text (timestamp + text が一致) なら下半分から除外して重複を避ける
- それぞれの先頭にセクション見出しを入れて LLM がどちらを参照すべきか分かるようにする

ユーザー向け prompt 例:

```
以下は Claude Code CLI のセッションのスナップショットです。
このセッションが「今何をしていて、どこまで進んでいるか」を 2〜3 行で要約してください。
冗長な前置きや「要約します」のような枕は付けないでください。
ユーザーが最後に何を依頼したかを必ず踏まえてください。

# 最新のユーザー入力
<ピン留め全文>

# 直近のやり取り (古い順)
[user] ...
[assistant] ...
...
```

「2〜3 行」に揃えるため `SYSTEM_PROMPT` も「1〜2 行」→「2〜3 行 (合計 200 文字程度)」に微調整し、`RESPONSE_MAX_TOKENS` を 200 → 360 に上げる。

#### 1-D. キャッシュ無効化はしない

要約は `(jsonlPath, mtimeMs)` キャッシュ。プロンプト変更後も既存キャッシュエントリは残るが、それは「過去の mtime に対する過去のスナップショット」なので意味的に正しい。`jsonl` が次に変化した瞬間 (= 普通に CLI を使えば数十秒以内) に新プロンプトで再要約される。

### Phase 2: ダッシュボードカードで要約を折りたたみ展開できるようにする

`ai-monitor/src/views.ts` の `renderSummaryFromData` / CSS / クライアント JS を拡張。

#### 2-A. CSS と DOM 構造

```html
<div class="card-summary" data-collapsible>
  <span class="card-summary-icon">📝</span>
  <div class="card-summary-content">
    <span class="card-summary-text">要約: {{ TEXT }}</span>
    <button type="button" class="card-summary-toggle" data-summary-toggle>展開</button>
  </div>
</div>
```

- `.card-summary-text` の `-webkit-line-clamp: 3` → `6` に変更
- 既定状態は折りたたみ。`.card-summary[data-collapsible].expanded` が付いたら line-clamp を解除して全文表示
- 短い要約 (line-clamp に達しない) の場合、トグルボタンは無意味なので非表示にする
  - 折りたたみが本当に効いているかは `scrollHeight > clientHeight` で判定し、JS で `.card-summary-toggle` を hidden する
  - 判定は表示直後 + リサイズ + 要約テキスト更新時にもう一度行う
- ボタンのラベル: 折りたたみ時「展開」/ 展開時「折りたたむ」

#### 2-B. クリックハンドラ

`DASHBOARD_SCRIPT` に既存の click delegation があるので、その中に `.card-summary-toggle` のハンドラを追加:

```js
var toggle = t.closest ? t.closest('[data-summary-toggle]') : null;
if (toggle) {
  ev.preventDefault();
  ev.stopPropagation();
  var wrap = toggle.closest('.card-summary');
  if (!wrap) return;
  wrap.classList.toggle('expanded');
  toggle.textContent = wrap.classList.contains('expanded') ? '折りたたむ' : '展開';
  return;
}
```

カードリンクの `<a class="card-link">` の中にトグルがあると navigateTopHash が誤発火するので、トグルは `<a>` の **外側** (= `.card-summary` 直下) に置く。現状の DOM 構造を確認すると、`.card-summary` は既に `<a class="card-link">` の外なのでこの懸念はクリア。

#### 2-C. SSE パッチでの状態保持

`DASHBOARD_LIVE_SCRIPT` の `updateCard` で、`renderSummary(data)` の文字列を既存 outerHTML と比較して差分があれば全置換している。今回トグル展開状態 (`.expanded` クラス) は **DOM 側だけにある情報** なので、置換時に失われる。

対策:

1. `updateCard` 内で patch 前に `wasExpanded = oldSummary?.classList.contains('expanded')` を取る
2. `renderSummary(data)` の比較は「expanded クラスを除いた状態」で行う (= 比較前に `.expanded` を一旦剥がす、または outerHTML 比較に正規化を入れる)
3. 比較で差分なしと判明したら触らない。差分ありで置換した場合は、新要約の text が「展開前と完全に同じ text なら」 expanded を復元する。違うテキストになっていたら復元しない (新要約は折りたたみから読み直す)

シンプルにする案: **DOM 側で `data-summary-key` (要約テキストの先頭 64 文字ハッシュ) を保持** しておき、置換後も同じキーなら expanded を再付与する。テキストが変わった場合は自然に折りたたみに戻る。サーバ側 `renderSummaryFromData` でこの data 属性を出す。

#### 2-D. 折りたたみ時の表示量

- `-webkit-line-clamp: 3` → `6`
- 6 行は body 13px / line-height 1.5 ≒ 117px 程度。カード高さは伸びるが、グリッド `minmax(360px, 1fr)` なので隣のカードに影響なし

#### 2-E. 表示エッジケース

- `state === 'pending'` の「要約中…」では当然トグル不要 → `data-collapsible` を付けない
- `state === 'unavailable'` (API キー未設定) や `error` も同様
- `state === 'idle'` (「要約」ボタン) も同様
- = `state === 'ok'` のときだけトグル付きの構造を出す

### Phase 3: 手動確認

`./run-ai-monitor.sh` でサーバ起動後:

1. `.env` に `ANTHROPIC_API_KEY` を入れる
2. 別ターミナルで `claude` を立ち上げ、長尺タスク (例: 「foo.md を 50 ヶ所書き換えて」) を投げる
3. ツール往復が 30 回以上回ったところでダッシュボードを開き、要約「要約」ボタンを押下 → 要約に直近のユーザー依頼が反映されていることを確認
4. 要約が 3 行を超える長さで返ってきたら「展開」をクリック → 全文表示
5. 「折りたたむ」をクリック → 元に戻る
6. ツール実行が継続して SSE で他のフィールドが更新されても、展開状態が保たれていることを確認
7. ツールが終わり jsonl mtime が変化 → 要約が再計算 (pending → ok) されると展開状態は折りたたみに戻ることを確認
8. 短い要約 (3 行以内) で「展開」ボタンが出ていないことを確認

## 影響範囲

- `ai-monitor/src/summarize.ts`
  - `SummarizeInput` 型を追加し `getOrCompute` / `wait` のシグネチャ拡張
  - `renderEventsForPrompt` を「ピン留め + 直近」の 2 セクション構築に変更
  - `PROMPT_MAX_CHARS` 4000 → 6000、`RESPONSE_MAX_TOKENS` 200 → 360
  - `SYSTEM_PROMPT` の「1〜2 行」→「2〜3 行」
- `ai-monitor/src/server.ts`
  - `/api/summarize` で `readTailEvents` 50 → 150 + `findLastUserText` を呼ぶ
- `ai-monitor/src/views.ts`
  - `renderSummaryFromData` の HTML 構造拡張 (トグルボタン + data 属性)
  - CSS: line-clamp 3 → 6、`.card-summary.expanded` 用ルール追加、トグルボタンのスタイル
  - `DASHBOARD_SCRIPT` にトグルクリックハンドラ追加
  - `DASHBOARD_LIVE_SCRIPT` の `updateCard` に「展開状態の保持」ロジック追加
- `ai-monitor/src/state.ts`
  - 触らない (`readSummaryStatus` は `peek` だけ、引数追加不要)
- テスト:
  - `ai-monitor/src/views.test.ts`: `renderSummaryFromData` の OK ケースで data-summary-key と data-collapsible 属性が出ることを確認
  - 既存 summarize の単体テストがあれば、新シグネチャに合わせて修正 (要確認)

## Phase / Step 分割

### Phase 1: 要約プロンプトの改善 (TODO 1)

- [ ] 1-A. `server.ts` の要約用 `readTailEvents` を 50 → 150 に増やす
- [ ] 1-B. `Summarizer.getOrCompute` / `wait` に `SummarizeInput` 形式の引数を導入し、`recentUserText` を受けられるようにする。既存テストを新形式に追随
- [ ] 1-C. `renderEventsForPrompt` を「ピン留め + 直近」の 2 セクション構築に変更。`PROMPT_MAX_CHARS` 6000 / 1 行 400 文字 / ピン留め 1200 文字 / 重複排除
- [ ] 1-D. `SYSTEM_PROMPT` を「2〜3 行 / 200 文字程度」に調整し、`RESPONSE_MAX_TOKENS` を 360 に
- [ ] 1-E. `/api/summarize` で `findLastUserText` の結果を `recentUserText` として渡す

### Phase 2: 要約表示の折りたたみ展開 (TODO 2)

- [ ] 2-A. CSS: `.card-summary-text` の line-clamp 3 → 6、`.card-summary.expanded .card-summary-text` で clamp 解除、トグルボタンスタイル追加
- [ ] 2-B. `renderSummaryFromData` の OK ブランチで `data-collapsible` + `data-summary-key` + `<button data-summary-toggle>` を出すよう改修
- [ ] 2-C. `DASHBOARD_SCRIPT` にトグルクリックハンドラ + 短い要約時にボタンを hidden する初期判定を追加
- [ ] 2-D. `DASHBOARD_LIVE_SCRIPT` の `updateCard` で展開状態を保持 (`data-summary-key` 一致時のみ復元)。短い要約判定もパッチ後に再実行
- [ ] 2-E. `views.test.ts` に renderSummaryFromData の OK ケースで `data-summary-key` / `data-collapsible` / トグルボタンが出ることを確認するテストを追加

### Phase 3: 手動確認

- [ ] 「対応方針 - Phase 3: 手動確認」の手順 1〜8 を実施

## やらないこと (スコープ外)

- 要約のシステムプロンプトを大幅に書き換える (専用評価セットが無いので最小限の変更のみ)
- 「要約」ボタンによる強制再生成 / mtime キャッシュの bust
- 折りたたみ状態をサーバ側 or localStorage に保持する (リロード初期化でよい)
- プロセス詳細ビュー (`renderProcessView`) への要約追加
- 要約モデル変更や Anthropic SDK のプロンプトキャッシュ調整 (既に `cache_control: ephemeral` 済み)
- グローバルな「全部展開」ボタン
