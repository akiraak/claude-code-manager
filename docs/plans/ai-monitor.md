# AI Monitor — vibeboard に「稼働中 Claude Code CLI」モニタを追加する

## 目的・背景

複数の Claude Code CLI を同時に走らせていると「どの CLI が今何をやっているか」が把握しづらい
（`research.md` の調査結果より、jsonl とプロセス情報を組み合わせれば把握可能）。
vibeboard の管理画面上に AI Monitor タブを追加して、稼働中 CLI の状況を一目で見られるようにする。

ゴール:

- vibeboard の topbar に **AI Monitor** タブが追加されている
- 左ペインに **Dashboard** + 稼働中 CLI の **作業ディレクトリ一覧** が並ぶ
- 右ペインは
  - Dashboard: 全 CLI のサマリ（PID / cwd / 直近ターンの一言 / 最終活動時刻 / アイドル判定）を一覧表示
  - プロセス選択時: 該当 CLI の transcript（ユーザ入力・AI 応答・ツール呼び出し）を時系列で詳細表示
- jsonl 更新や CLI 起動/終了は **SSE で push** され、画面が自動更新される

非ゴール (MVP):

- AI による要約表示（将来 Phase で別途追加）
- transcript への書き込み / 操作介入（読み取り専用）
- 本番運用向けのマルチユーザ対応 / 認証

## アーキテクチャ方針

ユーザー回答に沿った構成:

- **vibeboard 本体を「拡張可能」に改修**して `customTabs` という新しい設定キーを追加する
- AI Monitor 自体は **claude-code-manager 配下に別プロセス**として実装する（HTTP サーバ）
- vibeboard はタブ表示・サイドバー描画・SSE 接続といった「外殻」だけを担当し、
  右ペインの中身は AI Monitor が返す HTML を **iframe で表示**する

### 拡張プロトコル (vibeboard ↔ プラグイン)

vibeboard.config.json に追加するキー:

```json
{
  "customTabs": [
    {
      "name": "ai-monitor",
      "label": "AI Monitor",
      "baseUrl": "http://127.0.0.1:8181"
    }
  ]
}
```

プラグイン側 (= AI Monitor) が公開する HTTP エンドポイント:

| メソッド / パス                  | 役割                                                             | レスポンス                                                                                            |
| -------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET  {baseUrl}/api/sidebar`     | 左ペインに並べる項目を返す                                       | `{ items: [{ id: string, label: string, sub?: string, group?: string, badge?: string }] }`            |
| `GET  {baseUrl}/api/watch`       | サイドバー / コンテンツ更新を SSE で push                        | `event: sidebar` (再フェッチを促す), `event: item-changed` で `{ id }` を渡す                          |
| `GET  {baseUrl}/view?item=<id>`  | 右ペインに iframe で埋め込む HTML（item 単位）                   | `text/html`                                                                                           |

- vibeboard は `customTabs[i].baseUrl` を読み取り専用で渡すだけ。書き込み系 API は持たない（読み取りプラグインに限定）。
- `id` は URL 安全な文字列。vibeboard はそのまま hash ルーティングに乗せる（`#ai-monitor/<id>`）。
- `group` を指定すると、サイドバー内でグルーピング表示（例: `dashboard` グループ / `processes` グループ）。
- SSE の再接続・keep-alive ping は vibeboard 既存の `/api/files/watch` 実装と同じパターンで運用する。

### 影響範囲

- **vibeboard** (`./vibeboard/`): 拡張機構の追加（config schema / server / web）。`.gitignore` から外し、本リポジトリに fork として取り込んで直接コミットする（以降 degit による再 vendor は行わない）
- **claude-code-manager**: AI Monitor サーバ実装、起動スクリプト、設定ファイル
- 既存の TODO / Plans / Specs タブには影響なし

## Phase / Step 構成

### Phase 1 — vibeboard 拡張機構

vibeboard 側に「customTabs」を実装する。AI Monitor とは独立に動くサンプルプラグインで検証する。

- **Step 1.1**: `src/config.ts` に `CustomTabConfig` を追加して `normalizeCustomTabs` を実装
  - `name` の衝突チェック（`todo` と既存 `categories` 名）
  - `baseUrl` の形式バリデーション（http(s) のみ、末尾スラッシュ正規化）
- **Step 1.2**: `src/server.ts` の `clientConfig` に `customTabs` を流す（baseUrl はクライアントが直接 fetch する）
- **Step 1.3**: `src/web/app.js` に拡張タブ対応を実装
  - `CUSTOM_TABS` 配列をクライアント設定から取り出してタブ描画に混ぜる
  - `activeCategory === customTab.name` のとき:
    - サイドバー: `GET {baseUrl}/api/sidebar` を fetch して描画
    - 右ペイン: 選択された `id` の `GET {baseUrl}/view?item=<id>` を iframe で表示
    - SSE: `EventSource({baseUrl}/api/watch)` で sidebar/item-changed を購読
  - 既存の SSE 接続（`/api/files/watch`）には影響しないこと
- **Step 1.4**: 仕様ドキュメントを `docs/specs/vibeboard-custom-tabs.md` に書く
  - エンドポイント仕様、JSON スキーマ、エラーハンドリング
  - CORS / セキュリティ要件:
    - プラグインは `127.0.0.1` のみにバインドすること（外部公開しない）
    - 全レスポンスに `Access-Control-Allow-Origin: *` を付ける（ループバック専用前提）
    - `GET /api/sidebar` / `GET /api/watch` は `Cache-Control: no-store` を付ける
    - 単純 GET のみで preflight は基本不要だが、将来書き込み API を足す場合は別途定義
- **Step 1.5**: `vibeboard/` を本リポジトリにコミットする準備
  - `.gitignore` から `vibeboard/` の行を削除
  - 代わりに `vibeboard/node_modules/` と `vibeboard/dist/` を ignore に追加（dist は build 成果物）
  - `vibeboard/{package.json, package-lock.json, src/, sample/, tsconfig.json, LICENSE, README.md}` 等を commit 対象にする
  - README / CLAUDE.md の「degit で vendor」記述を「本リポに fork として取り込み済み」へ書き換える
  - upstream (`akiraak/vibeboard`) への反映は別件として後回し

検証:

- vibeboard 単体で `npm run build`、`./run-vibeboard.sh` で従来の TODO/Plans/Specs が壊れていないこと
- ダミーの customTab エンドポイント（最小限の `/api/sidebar` と `/view`）を別ポートで立てて、タブが描画されることを確認

### Phase 2 — AI Monitor サーバ（読み取り専用）

claude-code-manager 直下に AI Monitor 用の Node 製 HTTP サーバを置く。
配置: `./ai-monitor/` (新規ディレクトリ) もしくは `./vibeboard-plugins/ai-monitor/`（最終配置は実装着手時に再判断）。

- **Step 2.1**: プロジェクト初期化
  - `package.json` / `tsconfig.json` / Express を入れる
  - ポート 8181 デフォルト、`--port` で変更可
  - `app.use(cors({ origin: true }))` 相当を入れて `Access-Control-Allow-Origin` を返す
  - リッスンは `127.0.0.1` 固定（外部に出さない）
- **Step 2.2**: プロセス列挙ユーティリティ
  - `pgrep -af claude` で候補 PID を拾い、各 PID について以下のいずれかで本物の `claude` プロセスだけに絞る:
    - `/proc/<PID>/comm` の中身が `claude` （= 実行ファイル名そのもの）
    - もしくは `/proc/<PID>/cmdline` を NUL 区切りで読み、`argv[0]` の basename が `claude`
  - これで「argv 途中に "claude" 文字列を含むだけの別プロセス」（例: `node vibeboard/dist/cli.js --root /home/ubuntu/claude-code-manager`）を弾く
  - 確定した PID について `/proc/<PID>/cwd` を `readlink` で解決
- **Step 2.3**: jsonl 検出 / 読み取り
  - PID → jsonl の対応付けは「projects 側を起点に逆引き」で行う（cwd → ディレクトリ名のエンコードを自前で再現しない。worktree 由来の二重ハイフン entry など曖昧性があるため）:
    1. `~/.claude/projects/*/` を列挙
    2. 各ディレクトリ内で mtime 最新の `.jsonl` を 1 本選ぶ
    3. その jsonl の任意の行をパースして `cwd` フィールドを取り出す（= Claude 自身が記録した cwd の正解値）
    4. Step 2.2 で得た「生きている PID とその cwd」と突き合わせる
  - 末尾 N 行（例: 200 行）を読み、行ごとに JSON.parse（壊れた行は捨てる）
  - イベントを `{ kind: 'user-text' | 'assistant-text' | 'tool-use' | 'tool-result' | 'system', timestamp, payload }` に正規化
- **Step 2.4**: HTTP エンドポイント実装
  - `GET /api/sidebar`: Dashboard 行 + 稼働中プロセス（cwd ベース）を返す
  - `GET /view?item=dashboard`: ダッシュボード HTML
  - `GET /view?item=proc:<encoded-cwd>`: プロセス詳細 HTML
  - `GET /api/watch`: SSE。ポーリング（2 秒間隔）で
    - プロセス一覧の差分検出 → `event: sidebar`
    - jsonl の mtime 変化検出 → `event: item-changed` `{ id }`
- **Step 2.5**: アイドル判定
  - 最後のターン timestamp から 5 分以上経過なら「idle」、30 秒以内なら「active」、その間は「recent」とサイドバー / ダッシュボードで色分け
- **Step 2.6**: ログ／エラーハンドリング
  - 起動時に検出した projects ディレクトリの場所と監視対象を console に出す
  - jsonl が読み取り中に壊れている可能性、ファイル消失、権限エラー等を握り潰しすぎないように warn ログを出す

検証:

- 別ターミナルで `claude` を 2 つ走らせ、`/api/sidebar` が正しく返るかを `curl` で確認
- jsonl に書き込みが発生したときに SSE で `item-changed` が飛ぶことを確認

### Phase 3 — AI Monitor フロント (右ペイン)

`/view` が返す HTML を整える。vibeboard の見た目とそろえるため、最小限の CSS で配色は揃える（同系統のフォント / トーン）。

- **Step 3.1**: 共通レイアウト
  - 上部にタイトル（"Dashboard" or "<cwd>"）と最終更新時刻 / アイドル表示
- **Step 3.2**: Dashboard ビュー
  - テーブル: cwd / PID / 状態 (active/recent/idle) / 最終活動 / 直近イベント1件
  - 行クリックで `parent.postMessage` でプロセス詳細に遷移するか、もしくは `target="_top"` のリンクで `#ai-monitor/proc:<id>` に飛ぶ
- **Step 3.3**: プロセス詳細ビュー
  - 時系列リスト: ユーザ入力 / AI テキスト / tool_use / tool_result を吹き出し風に
  - 長い tool_result は折り畳み（クリックで展開）。MVP は AI 要約なし、生テキストの先頭 N 行表示 + 全文展開ボタン
  - 末尾 200 行に限定（巨大セッション対策）。「もっと前を見る」ボタンで遡れる（将来 Phase）
  - 表示上部に「最終更新: <時刻>（ターン完了時点）」と注記する。jsonl はターン完了時にしか書き出されないため、進行中ターンの本文はここには出ない（research.md 既出）
- **Step 3.4**: 自動スクロール
  - SSE で item-changed が来たら iframe 内でも fetch しなおして最下部にスクロール
  - vibeboard 側からの再読み込みでも問題なく動くこと

### Phase 4 — 起動・運用

- **Step 4.1**: `./run-ai-monitor.sh` を新設して `node ai-monitor/dist/cli.js --port 8181` 起動
- **Step 4.2**: README / CLAUDE.md にセットアップ手順を追記
  - vibeboard.config.json に customTabs を入れる例
  - AI Monitor の起動方法
  - 同時起動の例（`run-vibeboard.sh` と `run-ai-monitor.sh` を別ターミナルで、または `concurrently` で）
- **Step 4.3**: `.gitignore` に AI Monitor 配下の `node_modules/` / `dist/` を追加（vibeboard 側の `.gitignore` 整理は Step 1.5 で実施済み）

### Phase 5 — AI 要約（将来）

MVP 完了後に着手する。

- ダッシュボードの「直近イベント」を Claude API で 1〜2 行に要約
- プロセス詳細の長い tool_result を要約して折り畳む（クリックで原文展開）
- レート制御 / キャッシュ（同じ jsonl 範囲で結果再利用）
- 別プランファイル `docs/plans/ai-monitor-summarize.md` を作って詳細化する（このプラン内では扱わない）

## テスト方針

- **vibeboard 既存機能の非破壊性**: Phase 1 完了時点で `npm run build` 後に TODO/Plans/Specs タブが従来どおり動くことを目視確認
- **customTabs のサンプル動作**: ダミーの customTab エンドポイントを 30 行程度のスクリプトで立て、サイドバー描画と iframe 表示の挙動を確認
- **AI Monitor サーバ単体**: `/api/sidebar`、`/view?item=...`、`/api/watch` を curl / `evhttp-tail` 等で検証
- **結合**: vibeboard と AI Monitor を両方立ち上げ、`claude` プロセスを 2 つ起動 → タブからプロセスをクリック → 右ペインに transcript 末尾が表示 → 片方で何か実行して jsonl が更新されたら SSE 経由で自動更新される
- **異常系**: claude プロセスが 0 個でも UI が空状態を素直に出す、jsonl が壊れた行を含んでも落ちない、AI Monitor サーバ未起動でも vibeboard 側がタブをクラッシュさせず "接続できません" を表示する

## Phase 2 完了メモ (2026-05-12)

- 配置は `./ai-monitor/` (新規ディレクトリ) で確定。`src/{cli,server,processes,transcript,state,views}.ts` の 6 ファイル構成。
- 起動: `(cd ai-monitor && npm install && npm run build)` 後に `node ai-monitor/dist/cli.js --port 8181`。`run-ai-monitor.sh` は Phase 4 で用意する。
- プロセス特定は `pgrep -af claude` → `/proc/<PID>/comm` で本物の `claude` だけに絞り、`/proc/<PID>/cmdline` の argv[0] basename を保険にしてある (npm exec 経由などで comm が `node` になる場合への対応)。自分自身 (ai-monitor) の PID は明示的に除外。
- jsonl 検出は `~/.claude/projects/*/` 配下で最新の `.jsonl` を選び、行末から `cwd` フィールドを取り出して PID と突き合わせる方式 (プラン通り)。tail 読みは末尾 256KB / 1MB を `fs.readSync` で取る軽量実装。
- SSE は 2 秒ポーリングで「サイドバー指紋 (cwd+PID+state) の差分」→ `sidebar` イベント、「jsonl mtime 変化」→ `item-changed` (該当 proc と `dashboard` の両方) を push する。30 秒 keep-alive ping 付き。
- アイドル判定: 30 秒以内 = active / 5 分以内 = recent / それ以上 = idle (プラン通り)。サイドバーバッジは `●◐○`、ダッシュボードは色付きチップで表示。
- 検証: `curl /api/sidebar` で 3 件の稼働中 CLI を確認、`/view?item=dashboard` / `/view?item=proc:<base64url>` が 200 で返ることを確認、jsonl を `touch` すると `item-changed` が SSE で飛ぶことを確認 (vibeboard との結合確認は Phase 4 で `vibeboard.config.json` に customTabs を追記してから実施)。

## 確定事項 / 検討メモ

- **vibeboard の取り込み方針**: 本リポに fork として取り込み、`.gitignore` から外して直接コミットする (Step 1.5)。upstream への PR は別件で後回し。
- **CORS 方針**: AI Monitor 側で `Access-Control-Allow-Origin: *` を返す案で確定 (Step 1.4 / 2.1)。ループバック専用 (`127.0.0.1` バインド) を前提に `*` を許容する。リバースプロキシ案は採用しない（vibeboard 側に SSE プロキシを実装する手間を回避するため）。
- **AI Monitor のプロセス分離**: vibeboard と同居させず別プロセスにする。SSE / ポーリングを持つ分、落ち分離・再起動の独立性を優先。
- **iframe の追加保険**: `/view` 側は `Content-Security-Policy: frame-ancestors http://127.0.0.1:*` を付けて軽い制約を入れる（ループバック以外の埋め込みを防ぐ）。
- **Phase 1 検証用ダミー customTab**: `vibeboard/sample-custom-tab/` に最小スクリプト（30 行程度）として置き、`/api/sidebar` と `/view` だけ返すサンプルで動作確認する。
