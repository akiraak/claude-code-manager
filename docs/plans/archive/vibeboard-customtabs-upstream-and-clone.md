# vibeboard を clone する方式に変更する (customTabs のクリーン upstream 化 + CCM 適合)

## 目的

CCM は現在 vibeboard のソースを**リポジトリに丸ごと同梱 (vendor)** している (`./vibeboard/` に 27 ファイルをコミット)。
これを **起動/セットアップ時に upstream から `git clone` して取得する方式**へ変更し、CCM リポから vibeboard ソースを切り離す。

ただし単純な clone への置換は不可能であることが調査で判明した (後述)。本タスクの本質は次の 2 段構えになる。

1. **vibeboard 側**: customTabs を「CCM 実装に依存しない、汎用で使いやすいクリーンな機能」として **upstream (`akiraak/vibeboard`) に正式実装**する。
2. **CCM 側**: その新しいクリーンな customTabs に適合する形で現状の AI Monitor 連携を作り直し、**vendored をやめて upstream を clone** する方式へ移行する。

## 背景・調査結果 (現状把握)

### 現状: vibeboard は vendor されている
- `./vibeboard/` に 27 ファイルがコミット済み (`node_modules/`・`dist/` のみ gitignore)。
- `run-ai-monitor.sh` が `vibeboard/` を `npm install` + `npm run build` し、`node vibeboard/dist/cli.js --root . --port …` で起動する。
- `vibeboard.config.json` の `customTabs` で AI Monitor (`baseUrl: http://127.0.0.1:8190`) をタブ登録している。

### 核心的発見: upstream と双方向に乖離している → 単純 clone は不可
- ローカルに **5 コミットの fork 改修**があり、その中核が **customTabs 拡張機構** (AI Monitor タブ連携の土台)。
  - `2fe56fd` customTabs 拡張機構を追加し fork として取り込み
  - `ec74144` customTabs を topbar 左端へ (= AI Monitor を最左タブに)
  - `be901d3` AI Monitor タブ初期表示で Dashboard を自動選択
  - `05f8af8` ダッシュボード/プロセス詳細を自己更新化 (Phase 3-4)
  - `c911331` サイドバーに折りたたみトグルを追加
- **upstream `akiraak/vibeboard` (main @ `bd5c168`) には customTabs が一切無い** (`sample-custom-tab/` 不在、`config.ts`/`server.ts`/`web/*` が相違)。
- 乖離規模 (fork vs upstream main): `app.js` ~510 行 / `server.ts` ~165 / `style.css` ~109 / `config.ts` ~73 + `sample-custom-tab/` 114 行 + README ~20。
- **upstream は fork 後に独自前進**している (HEAD = "Make Root the default editable tab")。両 repo は version `0.1.0` のまま。
- 結論: `git clone upstream` に置換すると AI Monitor が依存する ~970 行の customTabs を失う。**「fork の正本をどこに置くか」を先に決めないと clone 化は成立しない。**

### 方針決定 (ユーザー判断)
- customTabs を **upstream vibeboard に汎用機能として載せる** (案 C のクリーン再設計版)。
- その上で CCM は upstream を clone し、AI Monitor を新契約に適合させる。
- → 正本は upstream に一本化され、CCM から vendored を削除できる。

### customTabs プラグイン契約 (現状・既にほぼ汎用)
現状コードは既に「baseUrl の HTTP プラグイン」という汎用契約になっており、CCM 固有依存はコードにはほぼ無い (AI Monitor は一実装に過ぎず、`sample-custom-tab/` が非 CCM 例を実証済み)。プラグインが満たす契約:

| エンドポイント | 役割 |
|---|---|
| `GET /api/sidebar` | `{ items: [{ id, label, sub?, group?, badge? }] }` を返す (サイドバー項目) |
| `GET /view?item=<id>` | item に対応する HTML を返す (右ペイン iframe に表示) |
| `GET /api/watch` | SSE。`item-changed` を送ると該当 iframe / サイドバーが自動更新 |

設定は `customTabs: [{ name, label, baseUrl }]`。server はプロキシせず baseUrl をクライアントへ渡し、ブラウザが直接 fetch する (CORS 前提・loopback)。

### 「クリーン化」で剥がす/整える CCM 結合 (実質は軽微)
コード上の CCM 依存はほぼ無く、整理対象は次の通り:
1. **topbar 並び順** (`app.js buildTabs()` 1099-1103): `CUSTOM_TABS` を常に最左固定。→ 意図的な仕様として文書化、または `order`/配置の設定可能化。
2. **先頭 item 自動選択** (`app.js` 1545-1556): customTab を開くと先頭項目へ自動遷移。コードは汎用だがコメントが AI Monitor/Dashboard 前提。→ 汎用挙動として文書化、必要なら opt-in 化。
3. コメント/README/サンプル中の AI Monitor 言及を一般化。
4. upstream main の新規コミット ("Root" 既定タブ化等) との整合。

## 対応方針 (Phase 構成)

> 注: Phase 1〜2 は **upstream `akiraak/vibeboard` リポ**側の作業、Phase 3 以降が **CCM リポ**側の作業。
> upstream への push / リリースは外部公開リポへの操作なので、実行はユーザー確認/担当とする。

### Phase 0: 設計確定
- [ ] customTabs プラグイン契約を確定し文書化する (`/api/sidebar` / `/view?item=` / `/api/watch` の仕様・スキーマ・CORS 前提)。現状契約を踏襲しつつ命名・項目を最終化。
- [ ] topbar 並び順と先頭自動選択を「汎用仕様 (固定)」にするか「設定可能」にするか決める (推奨: まず固定 + 文書化、設定化は将来)。
- [ ] upstream への載せ方を決める: `main` 直接マージ + リリースタグ (推奨)。CCM が clone で pin できるよう **タグ/SHA を必ず切る**。

### Phase 1: vibeboard 側 — クリーンな customTabs を upstream に実装
- [ ] upstream `akiraak/vibeboard` の最新 `main` を基点に作業ブランチを作成 (fork のコードを参照実装として流用)。
- [ ] customTabs 機構を移植・整理 (`config.ts` のスキーマ + バリデーション、`server.ts` の client 配信、`web/app.js` のタブ/サイドバー/iframe/SSE、`style.css`)。
- [ ] 自己更新 (SSE) / サイドバー折りたたみトグルのうち汎用価値があるものを取り込む。
- [ ] `sample-custom-tab/` を非 CCM の汎用サンプルとして整え、README に customTabs セクション + 契約仕様を追記。
- [ ] upstream main の新規変更 ("Root" 既定タブ等) と整合させる。

### Phase 2: vibeboard 側 — リリース (★ユーザー確認/担当)
- [ ] upstream へマージし、**バージョンを上げてタグを切る** (例 `v0.2.0`)。CCM が clone で pin する対象。

### Phase 3: CCM 側 — AI Monitor をクリーン契約に適合
- [ ] AI Monitor (`ai-monitor/`) が新しい customTabs 契約 (`/api/sidebar` / `/view?item=` / `/api/watch`) に準拠していることを確認/修正。契約変更があれば追従。
- [ ] CCM 固有挙動 (AI Monitor を最左・Dashboard 自動選択) を、upstream の汎用設定 (`vibeboard.config.json` の `customTabs` 並び順 + 自動選択仕様) で再現できることを確認。

### Phase 4: CCM 側 — clone 取得へ切替
- [ ] `run-ai-monitor.sh` を変更: `vibeboard/` が無ければ upstream の **pin したタグ/SHA を `git clone --depth 1 --branch <tag>`** で取得してから build。既にあれば再利用 (再取得は明示フラグ時のみ。例 `VIBEBOARD_REF` / 再 clone オプション)。
- [ ] vendored `vibeboard/` を **git 追跡から削除** (`git rm -r --cached vibeboard` 相当) し、`.gitignore` に `vibeboard/` を追加。
- [ ] `.gitignore` から不要になった `vibeboard/node_modules/`・`vibeboard/dist/` 個別行を整理 (`vibeboard/` 一括除外に集約)。
- [ ] clone 失敗時 (オフライン等) のフォールバック/エラーメッセージを用意。

### Phase 5: ドキュメント更新
- [ ] `CLAUDE.md` の「fork として取り込み済み (`./vibeboard/`)・本リポで直接コミット」記述を「upstream から clone して取得 (pin したタグ)」へ更新。
- [ ] `run-ai-monitor.sh` 冒頭コメント / 起動手順の説明を更新。

## 影響範囲
- **vibeboard (upstream)**: `src/config.ts` / `src/server.ts` / `src/web/{app.js,index.html,style.css}` / `sample-custom-tab/` / `README.md` / `package.json` (version)。
- **CCM**: `run-ai-monitor.sh` / `.gitignore` / `vibeboard/` (追跡削除) / `CLAUDE.md` / `vibeboard.config.json` (必要なら並び順・自動選択設定) / `ai-monitor/` (契約追従があれば)。
- `run-ai-monitor-client.sh` は vibeboard を起動しないため影響なし。

## テスト方針
- **vibeboard 単体**: `sample-custom-tab/` を起動し、汎用 customTab がサイドバー表示 / iframe 表示 / SSE 自動更新で動くことを確認 (CCM 非依存で成立すること)。
- **CCM 結合**: `run-ai-monitor.sh` をまっさらな状態 (vendored 削除後) から実行 → vibeboard が clone + build され、AI Monitor タブが従来どおり最左・Dashboard 自動選択・状態バッジ更新で動くことを確認。
- **clone 再現性**: pin したタグ/SHA で常に同じ vibeboard が取得されること。タグ未指定/オフライン時のフォールバック挙動。
- 既存の状態判定・音声・ミラー機能 (server モード) に退行が無いこと。

## リスク・未決事項
- **upstream への push/リリースは外部公開操作** (`akiraak/vibeboard` は公開リポ)。実行可否・タイミングはユーザー判断。CCM 側 (Phase 3-5) は upstream リリース完了を前提に進む依存がある。
- topbar 並び順・自動選択を「設定可能化」まで踏み込むか「固定仕様 + 文書化」で留めるかは Phase 0 で確定。過剰汎用化は避ける。
- vendored 削除は履歴改変 (filter-branch 等) はしない。`git rm --cached` で追跡だけ外し、過去履歴には残す。
- clone 方式は **オフライン/ネットワーク不通時に初回起動できなくなる**。`vibeboard/` が既にあれば再利用する設計でロックインを緩和する。
- degit (`npx degit akiraak/vibeboard#<ref>`) も選択肢 (vibeboard README 推奨) だが、TODO 文言どおり `git clone --depth 1` を採用 (pin が SHA/タグで明示でき、再現性が高い)。
