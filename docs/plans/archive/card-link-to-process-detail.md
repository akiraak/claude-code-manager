# Dashboard カード → プロセス詳細ページ遷移

## 目的・背景

vibeboard 上の AI Monitor ダッシュボードでカードをクリックすると、
本来は該当プロセスの詳細ページ (`renderProcessView`) が iframe 内に表示されてほしいが、
現状は **ダッシュボード全体が vibeboard の枠を破って全画面表示** されてしまう。

### 原因

`renderCard` の `<a class="card-link" href="#ai-monitor/proc:<id>" target="_top">` は
フラグメント URL を **iframe 側ドキュメント (`http://127.0.0.1:8181/view?item=dashboard`)
を基準に解決** してから top window に適用する。結果、top window が
`http://127.0.0.1:8181/view?item=dashboard#ai-monitor/proc:<id>` に navigate してしまい、
vibeboard (8180) の枠を抜けて ai-monitor のダッシュボード HTML が単独で全画面表示される。

## 対応方針

cross-origin (127.0.0.1:8180 ↔ 8181) で確実に動くよう **postMessage 経由** で
親 vibeboard に遷移を依頼する。

### Phase 1: ai-monitor 側 (`ai-monitor/src/views.ts`)

- `renderCard` の `<a>` から `target="_top"` を外し、`data-hash` に
  `ai-monitor/<encodeURIComponent('proc:' + id)>` を埋め込む
- `DASHBOARD_SCRIPT` に `.card-link` クリック handler を追加:
  - `ev.preventDefault()`
  - `parent.postMessage({ type: 'vb-nav', hash: <data-hash> }, '*')`
  - parent が居ない (= iframe 外で直接開いた) 場合は `window.location.hash` で fallback

### Phase 2: vibeboard 側 (`vibeboard/src/web/app.js`)

- `window.addEventListener('message', ...)` を 1 個追加
- `data.type === 'vb-nav'` かつ `data.hash` が文字列なら `location.hash = data.hash`
- 既存の `hashchange` → `handleRoute()` がそのまま発火し、対応する customTab item の
  iframe (詳細ページ) に切り替わる

## 影響範囲

- `ai-monitor/src/views.ts` (renderCard + DASHBOARD_SCRIPT)
- `vibeboard/src/web/app.js` (init 付近に message listener 追加)
- vibeboard customTab 全般で使える汎用の仕組みになるので、将来別 customTab でも再利用可

## テスト方針

- `./run-ai-monitor.sh` で立ち上げ、ダッシュボードのカードをクリック
  - top window の URL が `http://localhost:8180/#ai-monitor/proc%3A...` になる
  - vibeboard 内で AI Monitor タブが選択されたまま、iframe が詳細ページに切り替わる
  - サイドバーの該当 item がハイライトされる
- ブラウザの戻る/進むで dashboard ↔ 詳細ページが行き来できることを確認
- 既存の「要約」ボタンがカード遷移の影響を受けないことを確認 (sibling の `<a>` 外要素)
