# ダッシュボード更新時のちらつき修正

対象 TODO: `ダッシュボード更新時に画面がちらつくのを修正`

## 目的・背景

AI Monitor のダッシュボード (`/view?item=dashboard` を customTab iframe で表示) は、
セッション状態が変化するたびにカード一覧が更新される。
現状の更新フローは以下のとおりで、毎回 iframe を丸ごと再ロードしているため
白フラッシュ → 再レイアウトの「ちらつき」が発生する。

```
ai-monitor /api/watch  ──(SSE: item-changed { id: 'dashboard' })─▶
  vibeboard app.js                ───── customTabState.iframe.src = '.../view?item=dashboard&_t=…' ─▶
    iframe                        ───── 旧 document 破棄 → 白画面 → HTML 取得 → 再描画
```

具体的に問題が見える場面:

1. プロセスが AI 処理中で 2 秒ごとに SSE が飛び、そのたびにカードが瞬間白くなる
2. 権限プロンプト marker が変化した直後（入力待ち ↔ 待機中）に同様のちらつき
3. 要約完了通知 (`item-changed { id: 'dashboard' }`) でも丸ごと再ロード
4. バッジの `@keyframes badge-pulse` がリロードのたびに先頭から再生し、脈動が不自然になる

要するに**「再ロードする必要がない部分まで再ロードしている」**のが原因。
ダッシュボード本体の `<style>` / `<h1>` / グリッド枠は変わらず、
本当に差し替えたいのは個々のカードの中身だけ。

## 対応方針

iframe 丸ごと再ロードをやめ、**カード単位の DOM 差分更新**に切り替える。
ダッシュボード側 (`ai-monitor`) と vibeboard 側の両方に手を入れる。

### 全体像

```
ai-monitor /api/watch  ──(SSE: item-changed)─▶
  iframe 内 inline script (新規)             ───── fetch /api/dashboard.json
                                              └─── DOM を card 単位で patch (新規/更新/削除)
  vibeboard app.js                            ───── dashboard 宛の item-changed は無視 (iframe.src 触らない)
```

ポイント:

- iframe は ai-monitor (`127.0.0.1:8181`) と同一オリジンなので、iframe 内から直接 `/api/watch` `/api/dashboard.json` を叩ける（CORS 不要）
- 初回表示は従来どおりサーバ側でカード HTML を埋め込む（FOUC 防止）
- 各カードに `data-card-id="proc:<id>"` を付け、差分更新時のキーにする
- バッジ脈動アニメも、`badge-` クラスを使い回せば再生位置がリセットされない

### Phase 分割

1 つの大きな変更ではなく、レビュー単位で分けやすいよう Phase を切る。

#### Phase 1: ダッシュボード JSON API を切り出す

新エンドポイント `/api/dashboard.json` を ai-monitor に追加する。

- `ai-monitor/src/server.ts`
  - 既存の `buildEntries({ summarizer })` をそのまま使う
  - レスポンスは `renderDashboard` が必要としているフィールドのみを返す軽量 JSON
  - 例:
    ```json
    {
      "renderedAt": "2026-05-13T08:00:00.000Z",
      "entries": [
        {
          "id": "abc...",
          "cwd": "/home/.../foo",
          "cwdShort": "foo",
          "state": "ai-processing",
          "pid": 12345,
          "lastActivityAt": "...",
          "lastActivityRel": "3s ago",
          "tail": {
            "lastUserText": "...",
            "lastUserAt": "...",
            "lastAssistantText": "...",
            "lastAssistantAt": "..."
          },
          "summary": { "state": "ok", "text": "..." }
        }
      ]
    }
    ```
- `ai-monitor/src/views.ts`
  - サーバ側初回描画でも JSON 化と同じ整形ロジックを使うよう、
    `entryToDashboardCardData(entry)` のような純関数に切り出す
  - `previewText` / `fmtClockTime` / `fmtRelativeTime` などのフォーマットは
    サーバ側で済ませて JSON に入れてしまう (クライアント側に重複ロジックを置かない)

#### Phase 2: ダッシュボード iframe を自己更新型にする

`renderDashboard` の出力に、自己更新スクリプトと差分パッチ関数を足す。

- 各カードに `data-card-id="proc:<id>"` を付与
- バッジ要素にも `data-badge` 属性を持たせ、`badge-<state>` クラスだけ差し替えできるようにする
- inline script でやること:
  1. `new EventSource('/api/watch')` を開く
  2. `event: item-changed` を受けたら `fetch('/api/dashboard.json')` を呼ぶ (debounce 100ms 程度)
  3. 取得した entries と現在の DOM を `data-card-id` でつき合わせて:
     - **新規 ID**: カードを末尾に追加
     - **消えた ID**: カード DOM を削除
     - **既存 ID**: 個別フィールドだけ書き換え
       - `.card` の `card-state-*` クラス
       - `.badge` の `badge-*` クラスと textContent
       - `.card-cwd` / `.card-meta` の textContent
       - `.term-time` / `.term-body` の textContent
       - `.card-summary` 部分は要約状態ごとに DOM が変わるので innerHTML 再構築でも OK
         (要約の進捗中に他フィールドだけ更新する場合は触らない、というガードも入れる)
  4. 並び順がサーバ側で変わった場合に追随する (insertBefore で並べ替え)
- 初回描画はサーバ側 `renderDashboard` の HTML をそのまま使うので、
  JS が無効でも・SSE が繋がる前でもとりあえずカードは見える

カードクリック時の親遷移 (`postMessage('vb-nav')`) など既存スクリプトはそのまま生かす。

#### Phase 3: vibeboard 側で dashboard だけ iframe reload を抑止する

- `vibeboard/src/web/app.js` の `item-changed` ハンドラ (1621-1634)
  - `payload.id === 'dashboard'` のときは `customTabState.iframe.src = ...` を呼ばない
  - 他の `proc:*` id については現状どおり再ロード (Phase 4 で扱う)
- もしくは、より一般化するなら「iframe 内から `parent.postMessage({type:'vb-self-update', id})` で
  ‘自分で更新するから親はリロードしないで’ を伝える」設計も可能だが、
  当面は dashboard 専用の if 一行で十分

#### Phase 4 (任意 / 後追い): プロセス詳細 (`proc:*`) も同様に自己更新化

- 詳細ビュー (`renderProcessView`) は jsonl の末尾 200 イベントを描画する
- ここも iframe 再ロードで都度全体を再描画している → 長い jsonl では割と重い
- 同じ JSON API + 差分更新パターンに置き換える
- ただしダッシュボードほど更新頻度が高くないので、優先度は下げる

## 影響範囲

- `ai-monitor/src/server.ts` — 新エンドポイント追加
- `ai-monitor/src/views.ts` — `renderDashboard` 改修、`data-card-id` 等の追加、整形ロジックの関数化
- `ai-monitor/src/state.ts` / `transcript.ts` / `summarize.ts` — **触らない想定** (データソースは現状のまま)
- `vibeboard/src/web/app.js` — `item-changed` ハンドラに dashboard skip を追加
- `vibeboard/src/web/style.css` — 触らない (見た目は変えない)

## テスト方針

自動テストは現状ほぼ無いので手動確認中心。`ai-monitor/src/state.test.ts` 相当の単体テストは
Phase 1 で `entryToDashboardCardData` の純関数に対して 1〜2 ケース足す程度。

手動確認シナリオ:

1. **基本動作**: `./run-ai-monitor.sh` → ブラウザで AI Monitor タブを開く → カードが出る
2. **ちらつき消失**: 別ターミナルで `claude` を 1 つ動かし、AI 処理中状態を作る
   - 2 秒ごとに SSE が飛ぶが、カードがちらつかないことを目視
   - バッジの脈動アニメが滑らかに継続する (毎回先頭からやり直しにならない)
3. **状態遷移**: Yes/No プロンプトを出して入力待ち ↔ 待機中を行き来 → バッジが在席で切り替わる
4. **追加・削除**: 新しい `claude` を起動 → カードが末尾に追加される (リロードなし)
   - 24 時間経過した停止カードが消えるとき DOM が剥がれる
5. **要約**: 要約ボタンを押して `要約中…` → 完了後にテキストが入る (リロードなし)
6. **クリック遷移**: カードをクリックして詳細ビューに飛べる (既存 postMessage 経路)
7. **SSE 切断耐性**: ai-monitor を再起動 → EventSource が再接続し、カードが追従する
8. **JS 無効環境**: noscript で初回 HTML だけ見える (退行確認)

## やらないこと (スコープ外)

- ダッシュボードのレイアウト変更 / 見た目変更
- 状態判定ロジック (`classifyV2`) や jsonl パーサの変更
- WebSocket への移行 (SSE のままで十分)
- プロセス詳細ビューの自己更新化 (Phase 4 として別 PR / 別タスク扱い)
