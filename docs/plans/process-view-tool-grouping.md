# プロセス詳細ビューの tool_use / tool_result グループ化

対象 TODO:

- `プロセスの表示はtool_useとtool_resultがほとんどなのでそれはグループ化する。ユーザー入力と最終的な出力が見やすくなるようになるようなデザインや機能を入れる`

## 目的・背景

プロセス詳細ビュー (`ai-monitor/src/views.ts` の `renderProcessView`) は、jsonl 末尾 200 件 (`readTailEvents`) を時系列で 1 件 1 枚の `<div class="event">` カードとして並べる構造になっている (`renderEvent`)。

実際の Claude Code セッションでは 1 ターンあたり tool_use / tool_result が大量に並ぶ (例: 「ファイルを 20 ヶ所書き換えて」と頼むと Bash → Read → Edit が連続で数十件)。結果として:

- カード一覧の 8〜9 割が tool 関連カードで埋まり、「ユーザーが何を頼んで」「Claude が何と答えたか」が ぱっと見では掴めない
- 縦スクロールが長大になり、最終 assistant-text を探すのが面倒
- 個々の tool_use / tool_result は、流し読みする分には「実行された / 戻った」だけ分かれば十分なケースが多い

要約 (ダッシュボードカード) は別経路で存在するが、プロセス詳細ビューは「生ログを精読するためのビュー」であり、構造的な改善はこちら側で行う必要がある。

## ゴール

- プロセス詳細ビューを **「ターン単位」** で再構成する。1 ターン = ある user-text から、次の user-text の直前までの一連のイベント (CLAUDE.md の用語定義に準拠)
- 各ターンで:
  - **ユーザー入力 (user-text)** を見出しとして大きく表示
  - **ツール実行 (tool_use + tool_result)** は折りたたみ式に集約。サマリ行 (件数 / ツール内訳) を見せて、クリックで展開すると今までどおり 1 件ずつ見える。**全ターン デフォルト折りたたみ**
  - **Claude の最終応答 (= ターン内で最後の assistant-text)** を強調表示
  - **中間 assistant-text (ツール実行の合間に Claude が喋っているもの)** は別の `<details>` で「途中メッセージ N 件」として展開可能にする
- 既存の SSE 差分パッチ (`PROCESS_VIEW_LIVE_SCRIPT`) が動き続ける。ターン単位のキーで diff し、変化した最終ターンだけ再描画
- スクロール末尾追従は維持
- `<details>` の open/closed 状態が SSE 再描画で勝手にリセットされない

## 非ゴール

- ダッシュボードカード側 (`renderDashboard`) の構造変更
- tool_use の入力 / tool_result の出力に対する AI 要約 (見た目を整えるだけ)
- 個別ツール (Bash / Read / Edit 等) ごとのリッチ表示 (例: diff レンダリング)
- 検索 / フィルタ機能 (ツール名で絞り込み等)
- 折りたたみ状態の永続化 (リロードで初期状態に戻る)
- 過去ターンの省略 / 仮想スクロール
- 全展開 / 全折りたたみ ボタン (実装後の触感を見てから別 TODO 化を判断)

## 用語

- **ターン**: ユーザー入力 1 回と、それに対する AI の応答 (ツール呼び出し含む) の往復 (CLAUDE.md 定義)
- **アクティブターン**: 現在進行中 (= まだ次の user-text が来ていない) 最後尾ターン
- **完了ターン**: その後ろにもう user-text が来ているターン
- **孤児ターン**: jsonl 末尾 200 件の窓よりも前で始まったため `user-text` が欠落しているターン

## 対応方針

### Phase 1: イベント配列をターンにグルーピングする

新規 `ai-monitor/src/turns.ts` に `groupEventsIntoTurns(events: NormalizedEvent[]): Turn[]` を追加。`transcript.ts` は jsonl パースに専念させ、ターン化は別ファイルに切り出す。

```ts
export interface Turn {
  /** ターンを開始させた user-text。jsonl が途中から始まると null (孤児ターン) */
  userInput: NormalizedEvent | null;
  /** ツール往復 (tool-use + tool-result を交互含む。順序保持) */
  toolEvents: NormalizedEvent[];
  /** ターン内の assistant-text すべて (順序保持) */
  assistantTexts: NormalizedEvent[];
  /** 最後の assistant-text。見出しとして昇格させる。なければ null */
  finalAssistant: NormalizedEvent | null;
  /** finalAssistant を除いた中間 assistant-text */
  intermediateAssistants: NormalizedEvent[];
  /** system イベント (例: /clear)。ターン内の発生順を保つ */
  systemEvents: NormalizedEvent[];
  startedAt: string;
  endedAt: string;
}
```

グルーピングルール:

- イベントを時系列で走査
- `kind === 'user-text' && !isMeta` を見つけたら新しいターンを開始
- meta-user / tool-use / tool-result / assistant-text / system は現ターンに積む
- 最初の user-text より前に何かイベントがあれば `userInput: null` の孤児ターンを束ねる
- `finalAssistant` = `assistantTexts` 配列の最後の要素 (なければ null)
- `intermediateAssistants` = `finalAssistant` を除いた残り
- `startedAt` / `endedAt` は最初 / 最後の event timestamp

### Phase 2: 1 ターン分の HTML を組み立てる `renderTurn`

`views.ts` に `renderTurn(turn: Turn, index: number): { key: string; html: string }` を追加。既存 `renderEvent` は内部の tool 一覧と中間メッセージ表示でだけ再利用する。

DOM 構造案:

```html
<section class="turn" data-turn-key="...">
  <!-- 1. ユーザー入力 (孤児ターンでは「セッション開始時点」プレースホルダ) -->
  <header class="turn-header turn-user">
    <span class="turn-role">▶ ユーザー</span>
    <time class="turn-time">HH:MM:SS</time>
    <div class="turn-user-body">{{ user-text }}</div>
  </header>

  <!-- 2. ツール往復 (件数 0 のときは要素ごと出さない) -->
  <details class="turn-tools" data-detail-id="turn-{idx}-tools">
    <summary>
      🛠 <strong>ツール実行 {{ N }} 回</strong>
      <span class="turn-tools-breakdown">Bash×3, Read×2, Edit×1</span>
    </summary>
    <div class="turn-tools-body">
      <!-- 個別 tool_use / tool_result を従来の renderEvent で 1 件ずつ -->
    </div>
  </details>

  <!-- 3. 中間 assistant-text (0 件なら出さない) -->
  <details class="turn-intermediate" data-detail-id="turn-{idx}-intermediate">
    <summary>途中の Claude メッセージ {{ M }} 件</summary>
    <div class="turn-intermediate-body">
      <!-- renderEvent を中間 assistant-text に対して -->
    </div>
  </details>

  <!-- 4. system 系 (/clear などがあれば。0 件なら出さない) -->
  <div class="turn-system">
    <!-- renderEvent を system に対して -->
  </div>

  <!-- 5. 最終 assistant-text (なければ「(応答待ち / 進行中)」プレースホルダ) -->
  <section class="turn-final">
    <div class="turn-final-head">
      <span class="turn-role">✓ Claude</span>
      <time>HH:MM:SS</time>
    </div>
    <div class="turn-final-body">{{ final-assistant }}</div>
  </section>
</section>
```

レンダリングルール:

- `userInput === null` の孤児ターンでは `<header class="turn-user">` の body を `(セッション開始時点 — 直近 200 件の範囲外で開始したターン)` に差し替える
- `toolEvents.length === 0` のときは `<details class="turn-tools">` を出さない
- `intermediateAssistants.length === 0` のときは `<details class="turn-intermediate">` を出さない
- `finalAssistant === null` のとき (= ツール実行中で応答未完) は `<section class="turn-final">` の body を `(応答待ち / 進行中)` に置き換える (薄字 / italic)
- 既存 `renderEvent` の長文折りたたみ (`MAX_INLINE_LEN = 800` 超え時の `<details>全文を表示</details>`) は内部で使うのでそのまま
- `<details>` の open/closed は HTML 標準なのでクリック開閉に JS は不要 (open 状態保持だけ JS で扱う; Phase 4)

ツール内訳の組み立て:

- `toolEvents.filter(e => e.kind === 'tool-use')` を `toolName` で集計
- 件数降順で上位 3 件を `Bash×3, Read×2, Edit×1` のように
- 残りは `, +N 種` でまとめる
- 全件 0 のときは出さない (そもそも tools セクション自体出ない)

### Phase 3: `ProcessViewData` の events を turns に置き換える

`ai-monitor/src/views.ts`:

- `ProcessViewData.events: Array<{ key; html }>` を **`turns: Array<{ key; html }>`** に変更 (型変更を伴う非互換)
- `buildProcessViewData` は `readTailEvents` → `groupEventsIntoTurns` → `renderTurn.map(...)` の順で組む
- `renderProcessView` の events 表示部のコンテナ属性を `data-events` → **`data-turns`** に改名し、turns を `.map(t => t.html).join('\n')` で吐く
- 空のとき (turns.length === 0) は従来どおり「表示できるイベントがありません」プレースホルダ
- **`turnKey` の決定計算**: ターン内全 event の timestamps の最初 / 最後 + 件数 + 末尾 event の kind + 末尾テキスト先頭 64 文字を FNV-1a 32bit でハッシュ。アクティブターンに新 tool が積まれるたびに key が変わるので、SSE diff で「最後のターンだけ全置換」になる
- 完了ターンは key 不変なので DOM に触らない (アニメーション / open 状態リセットなし)

### Phase 4: クライアント差分パッチ (`PROCESS_VIEW_LIVE_SCRIPT`) をターン単位に書き換え

- 旧 selector `[data-event-key]` → **`[data-turn-key]`**
- 旧コンテナ属性 `[data-events]` → **`[data-turns]`**
- 並列走査 → 最初の不一致 index から先を削除 → 末尾追記、というアルゴリズム自体は そのまま (粒度がイベント → ターンに変わるだけ)
- `payload.events` → `payload.turns` のレスポンス形に合わせる (`/api/process.json` 側で `buildProcessViewData` の戻り値そのままを JSON 化しているはずなので、`buildProcessViewData` 側のキー名変更が伝播するだけ)
- 「near-bottom なら scrollToBottom」はそのまま維持
- **`<details>` の open 状態保持**: パッチ前に `document.querySelectorAll('[data-detail-id]')` を走査して `Map<id, open>` を構築 → ターン置換後に同 id の `<details>` を引き当てて `open` 属性を復元する
  - 復元対象は `data-detail-id` 一致のみ。turn が新規追加されたケース (新 id) では復元対象なし → デフォルト closed のままで OK

### Phase 5: テスト

`ai-monitor/src/turns.test.ts` (新規) と `ai-monitor/src/views.test.ts` (改修):

- `groupEventsIntoTurns`: 5 件くらいの jsonl パターンで Turn 配列の境界 / 孤児ターン / `finalAssistant` 抽出 / system イベントの所属 / meta-user が新ターンを切らないこと
- `renderTurn`: 各 section の出し分け (tools 0 件、intermediate 0 件、finalAssistant null、孤児ターン)、`data-turn-key` の決定性 (同じ Turn → 同じ key)
- `buildProcessViewData`: 戻り値が `turns` 形式になっていることと、ターン数の妥当性
- 既存 `renderProcessView` の `data-events` 参照テストがあれば `data-turns` に書き換え
- `views.test.ts` 既存の `data-event-key` を期待しているスナップショット系テストの修正

### Phase 6: 手動確認

`./run-ai-monitor.sh` で起動 → `claude` で 30 ターン超のセッションを動かし、

1. ツール往復が多いターンで `<details>` がデフォルト折りたたまれていること
2. ユーザー入力 / 最終応答が常に視認できていること
3. `<details>` クリックでツール一覧が展開され、再クリックで畳めること
4. アクティブターンが SSE で更新されるとき、開いていた `<details>` の open 状態が維持されること (`data-detail-id` 一致)
5. 完了ターン (= 次の user-text が来た後のターン) は DOM が触られず、ツールリストの open 状態がそのまま保たれること
6. スクロール末尾追従が以前と同じく機能すること
7. `/clear` `! ls` 等のローカルコマンド系で、その場で新ターンが切られず system セクションに収まること
8. 孤児ターン (= jsonl 200 件窓よりも前で始まったターン) で「セッション開始時点」プレースホルダが出ること

## 影響範囲

- 新規 `ai-monitor/src/turns.ts`
  - `Turn` 型 + `groupEventsIntoTurns` を追加
- `ai-monitor/src/views.ts`
  - `ProcessViewData.events` → `turns` に置き換え (型変更を伴う非互換)
  - `renderTurn` 新規。`renderEvent` は tool 一覧 / 中間メッセージ / system のレンダリングで再利用
  - CSS: `.turn`, `.turn-user`, `.turn-tools`, `.turn-tools summary`, `.turn-intermediate`, `.turn-final` 等を追加
  - `PROCESS_VIEW_LIVE_SCRIPT` をターン単位に書き換え (selector / コンテナ属性 / payload キー / `<details>` open 維持)
- `ai-monitor/src/server.ts`
  - `/api/process.json` は `buildProcessViewData` の戻り値をそのまま返している想定。型変更が透過的に伝播する。明示的な手当てが必要なら server.ts 側も合わせる
- テスト
  - 新規 `ai-monitor/src/turns.test.ts`
  - `ai-monitor/src/views.test.ts` 既存ケースの改修 + 新規ケース

## Phase / Step 分割

### Phase 1: ターンへのグルーピング

- [ ] 1-A. `ai-monitor/src/turns.ts` 新規 + `Turn` 型 + `groupEventsIntoTurns(events)` 実装
- [ ] 1-B. `turns.test.ts` で境界 / 孤児ターン / `finalAssistant` 抽出 / `intermediateAssistants` 分離 / meta-user が新ターンを切らないこと / system イベントの所属を確認

### Phase 2: ターン単位レンダリング

- [ ] 2-A. `views.ts` CSS に `.turn` 系セクションを追加 (ユーザー / ツール / 中間 / 最終)
- [ ] 2-B. `renderTurn(turn, index): { key, html }` 実装。tool 内訳サマリ (Bash×3, Read×2 等) 生成も含む
- [ ] 2-C. `buildProcessViewData` を `events → turns` に変更 (戻り値型も変更)
- [ ] 2-D. `renderProcessView` を `data-events → data-turns` に改名し turns を吐く

### Phase 3: SSE 差分パッチをターン単位に

- [ ] 3-A. `PROCESS_VIEW_LIVE_SCRIPT` の selector / コンテナ / payload キーを turn 用に書き換え
- [ ] 3-B. `<details>` の open 状態保持 (`data-detail-id` ベースで集めて復元)
- [ ] 3-C. 末尾スクロール追従 / 完了ターン非更新 が壊れないことを手動確認

### Phase 4: テスト

- [ ] 4-A. `views.test.ts` で `data-turn-key` / `data-turns` / 各セクションの出し分けが期待どおり出ることを確認
- [ ] 4-B. 既存スナップショット系テストの `data-event-key` 参照を `data-turn-key` に更新

### Phase 5: 手動確認

- [ ] 「対応方針 Phase 6」の手順 1〜8 を実施

## やらないこと (スコープ外)

- tool_use / tool_result の中身を AI で要約する (見た目を整えるだけ)
- ツール別のリッチ表示 (Edit の diff レンダリング等)
- ターンに対する検索 / フィルタ
- 折りたたみ状態の永続化 (リロード / SSE 再描画で初期化されてよい。ただし SSE 中の open は保持する)
- ダッシュボードカード側の構造変更
- 仮想スクロール / 過去ターンの遅延ロード
- 全展開 / 全折りたたみ ボタン (実装後の触感を見てから別 TODO 化を判断)
