# ダッシュボードのユーザ入力 / AI 返信をターミナル風デザインにする

## 目的・背景

ダッシュボードのカード (`renderCard` @ `ai-monitor/src/views.ts:266`) は、`👤 ユーザー` / `🤖 Claude` の 2 ブロックで最新ターンを表示している。現状は白背景 + 行頭絵文字 + 灰色メタ + 黒本文という汎用 UI 寄りの見た目で、複数 CLI を並べたときに「いま何のやり取りが進んでいるか」が一目で頭に入って来づらい。

ターミナルログ風 (iTerm / VS Code Terminal の落ち着いたダーク配色) に寄せることで、

- 一覧したときに「会話ログ」であることが視覚的に直感できる
- 等幅 + ダーク背景でコード / コマンド出力が読みやすくなる
- 他の白背景な vibeboard タブとも視覚的に区別できる

を狙う。

## 適用範囲

- **対象**: ダッシュボードのカード内 `card-user` / `card-assistant` ブロックのみ
- **対象外**:
  - カードヘッダー (バッジ / cwd / PID / mtime) は現状の白背景レイアウトを維持
  - カード下部の `card-summary` (AI 要約) も現状維持
  - プロセス詳細ページ (`renderProcessView`) は今回は触らない
- スコープを敢えて絞る理由: 「会話ログ」部分だけターミナル風にし、メタ情報帯は今までの見やすい配色を残すことで、視線誘導 (メタ → 会話) がブレないようにする

## 対応方針

### 1. カード内に「ターミナル枠」を入れる

`card-user` + `card-assistant` をひとまとめにする `card-terminal` ラッパー `<div>` を追加し、その内側だけダーク + 等幅にする。カード全体は今のまま白背景で、ターミナル枠だけが浮いて見えるレイアウト。

```
┌─ card (白) ─────────────────────────────┐
│ [badge] cwd                  PID · 5m ago│
│ ┌─ card-terminal (#1e1e1e) ────────────┐ │
│ │ ▶ user                      10:42:13 │ │
│ │   TODO の確認をして                  │ │
│ │                                       │ │
│ │ ▶ claude                    10:42:15 │ │
│ │   docs/plans/ にプランファイルを     │ │
│ │   作成します...                      │ │
│ └───────────────────────────────────────┘ │
│ 📝 要約: ...                             │
└──────────────────────────────────────────┘
```

### 2. 配色 / タイポ

VS Code Dark+ ベースを参考にする。

| 要素                  | 値                                  |
| --------------------- | ----------------------------------- |
| 背景                  | `#1e1e1e`                           |
| 標準テキスト          | `#d4d4d4`                           |
| `▶ user` ヘッダ       | `#4ec9b0` (ティール / 緑系)         |
| `▶ claude` ヘッダ     | `#dcdcaa` (淡い黄 / マゼンタでも可) |
| 時刻 (右寄せ)         | `#808080`                           |
| 本文                  | `#d4d4d4`                           |
| 空ブロック注釈        | `#6a6a6a` italic                    |
| フォント (枠内のみ)   | `ui-monospace, SFMono-Regular, Menlo, monospace` |
| 行高                  | `1.5`                               |
| パディング            | `10px 12px`                         |
| 角丸                  | `6px`                               |

`▶` (BLACK RIGHT-POINTING POINTER, U+25B6) を使う。絵文字ではないのでフォントメトリクスが揺れにくい。

### 3. ヘッダ行の構造

```html
<div class="term-line term-user">
  <span class="term-marker">▶</span>
  <span class="term-role">user</span>
  <span class="term-time">10:42:13</span>
</div>
<div class="term-body">TODO の確認をして</div>
```

- `term-time` は `display: inline-block; float/auto-margin` で右寄せ。`fmtRelativeTime` は使わず、`HH:MM:SS` を出す (ターミナル感を強める)。
  - `lastUserAt` / `lastAssistantAt` の ISO 文字列から `new Date(...).toLocaleTimeString('ja-JP', { hour12: false })` で時刻だけ切り出す薄いヘルパー `fmtClockTime` を `views.ts` に追加
  - `fmtRelativeTime` 自体はカードヘッダ (`card-meta`) でまだ使うので残す
- 本文 (`term-body`) は `white-space: pre-wrap` + 等幅 + `-webkit-line-clamp: 3` を維持
- 空のとき: `(まだユーザー入力がありません)` / `(まだ Claude の返信がありません)` を `term-body term-empty` で薄く出す

### 4. 「処理中」を表現するアクセント (任意)

`entry.state === 'ai-processing'` のときだけ、`▶ claude` の `term-marker` を `▶█` (カーソル風) に切り替え、`badge-pulse` と同じ脈動アニメーションを当てる。

- 必須ではない。最初の PR では入れず、見た目を見てから判断する
- 入れる場合は `.term-marker.pulse` クラスを別途追加するだけで済む

## 影響範囲

### 変更ファイル

- `ai-monitor/src/views.ts`
  - `COMMON_STYLE` に `.card-terminal` / `.term-line` / `.term-role` / `.term-time` / `.term-body` / `.term-empty` の CSS を追加
  - 既存の `.card-user` / `.card-assistant` / `.card-line-head` / `.card-line-body` 関連 CSS は **プロセス詳細ページでは引き続き使わない** ので、ダッシュボード専用なら削除可。詳細ページに副作用しないことを確認した上で削る (現状 `renderProcessView` 側からは使われていない)
  - `renderCard` の `card-user` / `card-assistant` を生成しているブロックを、新しい `card-terminal` 構造に書き換え
  - `fmtClockTime(iso): string` を `views.ts` 内に追加 (`fmtRelativeTime` の隣)
- (UI 確認後) `CLAUDE.md` の「ダッシュボードの状態バッジ」セクションは触らず、別途「カードのレイアウト」みたいな節を作るかどうかは実装後に判断
- ai-monitor のビルド: `(cd ai-monitor && npm run build)` で再生成

### 変更しないファイル

- `state.ts` / `transcript.ts` / `server.ts` / `processes.ts` / `summarize.ts`
- `renderProcessView` (詳細ページ) 関連の CSS
- vibeboard 側 (iframe で読み込むだけなので影響なし)

### 互換性

- DOM 構造は変わるが、カード DOM を参照しているクライアントスクリプトは `summarize-btn` のクリックハンドラ (`DASHBOARD_SCRIPT`) だけ。これは `card-summary` 配下なので影響なし
- カードへのリンク (`<a class="card-link" href="#ai-monitor/proc:...">`) は維持。会話ブロックを `<a>` 内に含めるかは、現状通り **含める** で OK (カード全体クリック可能を維持)

## テスト方針

単体テストは無いので手動検証。

1. ai-monitor を `npm run build` → `./run-ai-monitor.sh` で再起動
2. ブラウザで vibeboard の AI Monitor タブを開き、カードの会話ブロックがダーク + 等幅で出ること、`▶ user` / `▶ claude` / 時刻表示 / インデント本文が意図通りに崩れていないことを目視
3. 以下のケースを確認:
   - 通常のターン (ユーザー入力 + Claude 返信あり)
   - ユーザー入力だけで Claude 未応答
   - 空セッション (両方なし → 空メッセージが薄色で出る)
   - 長文 (line-clamp で 3 行に切られる)
   - 多バイト / 改行混じり / コードフェンスを含む本文
   - state がそれぞれ AI処理中 / 入力待ち / 待機中 / 停止 のカード
4. 詳細ページ (`#ai-monitor/proc:...`) のレイアウトが回帰していないことを確認 (今回触らない範囲)
5. AI 要約ボタン / 要約中スピナー / 要約済み表示が今まで通り動くことを確認 (`DASHBOARD_SCRIPT` に手は入れない)

## オープン項目 (実装時に判断)

- 角丸 / シャドウの強さ: 「枠だけ浮く」感を強めるか、フラットに収めるか。最初はフラット寄り (`box-shadow` なし) で出して様子見
- カーソル風アニメーション (4.) を初手で入れるか保留するか
- 等幅フォントに日本語が無い環境で和文が CJK fallback されたときの行高ズレ。`line-height: 1.6` まで上げるかは見てから
- 本文 line-clamp の段数 (現状 3 行)。ターミナル感を出すなら 4〜5 行に増やしても良いかは実機を見て判断
