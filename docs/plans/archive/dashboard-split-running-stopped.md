# ダッシュボードを「起動中」と「停止」で分けて表示する

対象 TODO: `プロセス起動中と停止中で分けて表示する`

## 目的・背景

現状のダッシュボード (`/view?item=dashboard`) は `buildEntries` の結果をそのまま 1
つのグリッドに `cwd` アルファベット順で並べているため、

- **生きている CLI** (`ai-processing` / `awaiting-user` / `waiting`)
- **24 時間 retention 中の停止 CLI** (`stopped`)

が混在する。停止カードは [[stopped-process-visibility]] で 24h 残るようになったので
枚数が増えやすく、稼働中の CLI を一目で把握しづらい。

ユーザーは UI で **「起動中」セクションと「停止」セクションに視覚的に分割**したい
(セクション分割案を選択。`docs/plans/archive/dashboard-split-running-stopped-decision.md`
ではなく本ドキュメント内に決定を残す)。

## 仕様

```
Dashboard
表示中 CLI: 8 件 · 取得時刻: …

起動中 (3)
┌─────┐ ┌─────┐ ┌─────┐
│card │ │card │ │card │   ← ai-processing / awaiting-user / waiting
└─────┘ └─────┘ └─────┘

停止 (5)
┌─────┐ ┌─────┐ ┌─────┐
│card │ │card │ │card │   ← stopped (24h retention 内)
└─────┘ └─────┘ └─────┘
┌─────┐ ┌─────┐
│card │ │card │
└─────┘ └─────┘
```

- セクション見出しは `起動中 (n)` `停止 (n)` の文字列。`n` は各セクションのカード数
- 並び順: **両セクションとも cwd アルファベット順** (現状維持)
- 起動中セクションが空のときは「稼働中の Claude Code CLI が見つかりません」を表示
  (現在の `[data-empty]` メッセージを流用)
- 停止セクションが空のときはセクション見出しごと非表示にする
- 折りたたみは **付けない** (今回スコープ外)。停止が多すぎて困ったらフォローアップで検討

## 対応方針

サーバ側 (`renderDashboard`) と、iframe 内自己更新スクリプト
(`DASHBOARD_LIVE_SCRIPT`) の両方を「2 グリッド構成」に揃える。`/api/dashboard.json`
の JSON フォーマット (entries フラット配列) は変えず、**振り分けはクライアント /
サーバ render 双方が `entry.state === 'stopped'` で判定**する。

### 影響ファイル

| ファイル | 変更内容 |
|---|---|
| `ai-monitor/src/views.ts` | `renderDashboard` を 2 セクション構成に変更。`DASHBOARD_LIVE_SCRIPT` の `applyPatch` を 2 コンテナ対応に変更。CSS にセクション見出し用スタイル追加 |
| `ai-monitor/src/views.test.ts` | 起動中/停止が混在する MonitorEntry 配列で `renderDashboard` のスナップショットを取り、両セクションの見出し + カード件数が出ることを assert |
| `ai-monitor/src/server.ts` | **変更なし**。`/api/dashboard.json` は entries フラット配列のまま (state でクライアントが振り分ける) |
| `ai-monitor/src/state.ts` | **変更なし**。`buildEntries` のソートは現状の cwd 順を維持 |

### `renderDashboard` の改修

```ts
const running = entries.filter(e => e.state !== 'stopped');
const stopped = entries.filter(e => e.state === 'stopped');
const isAllEmpty = entries.length === 0;

// セクションごとに <h2> + <div class="cards" data-cards-running> を生成
// 停止セクションは stopped.length === 0 なら丸ごと非表示 (hidden 属性)
```

データ属性:

- 起動中グリッド: `<div class="cards" data-cards-running>...</div>`
- 停止グリッド: `<div class="cards" data-cards-stopped>...</div>`
- セクション見出し: `<h2 class="section-title" data-section="running">起動中 <span data-count>3</span></h2>`
- 全体が空のメッセージ: 既存の `[data-empty]` をそのまま流用

### `DASHBOARD_LIVE_SCRIPT` の改修

`applyPatch` の責務を変える:

1. payload.entries を `state === 'stopped'` で 2 グループに分ける
2. 起動中グループを `[data-cards-running]` に、停止グループを `[data-cards-stopped]` に
   それぞれ独立に diff-patch (既存 `existing[itemId]` index 化ロジックを 2 回使う)
3. セクション見出しの件数 `[data-section="running"] [data-count]` /
   `[data-section="stopped"] [data-count]` を更新
4. 停止セクション全体 (`[data-section="stopped"]` と `[data-cards-stopped]`) を
   `stopped.length === 0` なら `hidden` で消す
5. 全体空メッセージ `[data-empty]` の表示判定は `entries.length === 0`

DOM 差分パッチの中核 (既存 `cards.querySelectorAll('.card[data-card-id]')` 周り) は
共通関数に切り出して 2 コンテナで使い回す:

```js
function patchContainer(container, entries) {
  // 既存の applyPatch のループ部分をそのまま移植
}
```

### CSS 追加

```css
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: #555;
  margin: 16px 0 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid #e5e5e5;
}
.section-title:first-of-type { margin-top: 0; }
.section-title [data-count] { color: #999; font-weight: 400; }
```

## テスト方針

### 自動テスト

`ai-monitor/src/views.test.ts` に追加:

- 起動中 2 件 + 停止 1 件の MonitorEntry を渡したとき、`renderDashboard` の出力に
  - `data-cards-running` が 1 つ存在し、その中に `data-card-id` が 2 つある
  - `data-cards-stopped` が 1 つ存在し、その中に `data-card-id` が 1 つある
  - 見出しの `[data-count]` がそれぞれ `2` `3` になっている (文字数だけ)
  ことを確認
- 全件停止のケース: 起動中セクションは `hidden` または見出しなし、停止セクションのみ表示
- 全件起動中のケース: 停止セクションが `hidden`、見出しも出ない
- 全件 0: `[data-empty]` だけ表示

### 手動確認

- `./run-ai-monitor.sh` で再起動 → `http://localhost:8180` の AI Monitor タブで
  - 稼働中 CLI 1 本 + 直近で `/exit` した CLI 1 本がある状態で 2 セクションに分かれて
    描画されることを目視
  - 稼働中 CLI で 1 ターン回し、SSE で起動中セクションだけが diff-patch され、停止
    セクションが触られない (バッジ脈動が乱れない) ことを目視
  - 稼働中 CLI を `/exit` で止めた直後に、その カードが起動中 → 停止セクションに
    SSE 経由で移動することを確認 (state が変わると container 移動が発生する)

## 想定リスク

1. **同じカードが 2 セクション間で diff-patch 中に一瞬消える / ちらつく**
   - 起動中 → 停止 (CLI 死亡) のとき、片方の container から削除 → もう片方に新規作成
     される。要素自体は別物になるためフェード等は出ない
   - 「移動」を一切ちらつかせないなら DOM ノードを `appendChild` で物理移動する設計に
     する手もあるが、Phase 2 の差分パッチ実装と整合させるのが面倒なので **やらない**
     (停止遷移は頻度が低い)
2. **空セクションの hidden 切り替えで `:first-of-type` セレクタが効かなくなる**
   - 起動中が空で停止だけのとき、`section-title` の `margin-top: 0` を出すために
     `:first-of-type` ではなく `data-section` 属性ベースのセレクタで CSS を書く

## 完了条件

- `views.test.ts` の追加テストが通る
- 手動確認 3 ケースで期待通り描画される
- `TODO.md` の項目を `DONE.md` に移動 (今日の日付付き)
- 本プランファイルを `docs/plans/archive/` に移動
