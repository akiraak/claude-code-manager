# claude-code-manager

複数の Claude Code CLI を同時に走らせるための、ローカル向け一元管理システム。

複数の `claude` プロセスを並行で動かしていると、「どのターミナルが何をやっていたか」「いま入力を待っているのはどれか」「終わったのはどれか」がすぐ分からなくなる。本リポジトリはその混乱を防ぐためのダッシュボードと、`TODO.md` / プラン / 仕様書を 1 つの画面でまとめて触る管理面を提供する。

ブラウザを 1 枚開いておけば、`~/.claude/projects/` 配下に書かれる jsonl と `/proc` のローカル情報だけを材料にして、稼働中の CLI / 停止済みの CLI / 直近のユーザー入力 / 直近の Claude 応答 / Claude API による要約 を一覧できる。書き込み API は持たないので Claude Code 側を一切汚さない。対象は「自分のマシン上で Claude Code CLI を複数同時に走らせている開発者」一人だけを想定したローカル専用ツール。

## 動作環境

- Node.js **18 以上** (`ai-monitor` / `vibeboard` の `package.json` `engines.node` 参照)
- Claude Code CLI が別途インストール済みで、`~/.claude/projects/<projectDir>/*.jsonl` にトランスクリプトが書かれていること
- グローバル hook `~/.claude/hooks/ccm-awaiting-marker.py` (権限プロンプトの「入力待ち」検出に使用。詳細は [権限プロンプト検出のための hook](#権限プロンプト検出のための-hook))
- Anthropic API キー (任意。AI 要約を使う場合のみ。`.env` に `ANTHROPIC_API_KEY=...` を置く)
- 動作確認 OS: Linux / macOS (WSL2 上で動作確認済み)。Windows ネイティブは未検証。

## 構成

- `vibeboard/` — ローカル開発時の TODO / Plans / Specs を閲覧・編集する管理画面 (upstream を fork として取り込み)
- `ai-monitor/` — 稼働中の Claude Code CLI を可視化する vibeboard customTabs プラグイン
- `docs/plans/` / `docs/specs/` — プラン・仕様
- `TODO.md` / `DONE.md` — タスク管理

## セットアップ

初回のみ、それぞれの依存をインストールしてビルドする (`run-ai-monitor.sh` 内でも同じことが走るので、スクリプト経由でしか起動しないなら省略可)。

```bash
(cd vibeboard && npm install && npm run build)
(cd ai-monitor && npm install && npm run build)
```

## 起動

`run-ai-monitor.sh` が vibeboard と AI Monitor の両方を起動する。既に起動中のプロセスがあれば `pgrep -f` で検出して停止してから起動し直す。依存インストール / ビルドもスクリプト内でやるので、初回でもこれ 1 本で立ち上がる。

```bash
./run-ai-monitor.sh
```

- vibeboard: `http://localhost:8180` (環境変数 `VIBEBOARD_PORT` で変更可)
- AI Monitor: `http://127.0.0.1:8181` (環境変数 `AI_MONITOR_PORT` で変更可)

ブラウザで `http://localhost:8180` を開くと、左上のタブから **TODO / Plans / Specs / AI Monitor** が選べる。Ctrl-C で両方まとめて終了する。

## 使い方

### vibeboard 各タブ

| タブ | できること |
|---|---|
| **TODO** | `TODO.md` / `DONE.md` をプレビュー + 編集。編集は mtime ベースの楽観ロック付きで、外部で先に更新されていた場合は 409 を返し、リロード / 手元維持 / 強制上書き を選べる。`fs.watch` + 2 秒ポーリングで外部変更を検知し SSE で即時反映 |
| **Plans** | `docs/plans/` 配下の Markdown 一覧 + プレビュー |
| **Specs** | `docs/specs/` 配下の Markdown 一覧 + プレビュー |
| **AI Monitor** | `vibeboard.config.json` の `customTabs` 経由で `http://127.0.0.1:8181` を埋め込み表示 |

### AI Monitor ダッシュボード

ダッシュボードは **起動中** / **停止** の 2 セクションに分かれている。停止カードは 24 時間後に表示から消える (`STOPPED_RETENTION_SEC = 86_400`)。

各カードに以下を表示する。

- 左上の **状態バッジ** (`AI処理中` / `入力待ち` / `待機中` / `停止` の 4 種類。詳細は [ダッシュボードの状態バッジ](#ダッシュボードの状態バッジ))
- **cwd** (生存時は `/proc/<pid>/cwd`、停止後は jsonl 内の最終 cwd)
- **PID** (生存時のみ)
- **直近のユーザー入力** (ツール連打で末尾窓から押し出されても遡って表示する)
- **直近の Claude 応答** (assistant-text の末尾)
- **AI 要約** (オプション。Anthropic API キーがあれば 4〜6 行の要約を出す)

要約 UI の操作:

- 未生成のときは「要約」ボタンが出る。押すと API 呼び出しがバックグラウンドで走り、完了時に SSE 経由でカードが自動更新される
- 表示中の要約は **展開** ボタンで全文を、再要約 ボタンでキャッシュを無視した再生成を行える
- jsonl が要約後に追記されると、要約のラベルが「要約 (古い):」(stale) に変わり薄色で表示される (新要約は次回ボタン押下で生成)

カードクリックで **プロセス詳細ビュー** に遷移する。突き合わせキーは `~/.claude/projects/<projectDir>/` の `projectDir` なので、CLI 起動後に `cd` してもセッションは 1 枚のカードにまとまる。

### AI Monitor プロセス詳細ビュー

選んだセッションの jsonl 末尾 **200 件** のイベントを古い順に表示する。

- user-text / assistant-text / tool-use / tool-result を 1 行ごとに描画
- SSE 自己更新型で、新しい行が追記されると末尾差分だけ DOM にパッチを当てる (スクロール位置が末尾近辺なら自動追従)
- 200 件を超えて先頭から rotate された場合のみ全体を再構築する (頻度は低い)

> ターン単位 (user → assistant + tools の往復) でのグルーピング表示は別 TODO で進行中 ([plan](docs/plans/process-view-tool-grouping.md))。現状は時系列フラット表示。

## ダッシュボードの状態バッジ

ダッシュボードカード左上の色付きバッジは、各 CLI セッションの現在状態を 4 種類で示す。判定ロジックは `ai-monitor/src/state.ts` の `classifyV2`。

| バッジ | 色 | 装飾 | 条件 |
|---|---|---|---|
| **AI処理中** | 緑 | 脈動 | CLI 生存 + 直近 30 秒以内に jsonl 更新あり (AI 非介在のローカルコマンド `/clear` `/help` `! ls` 等の直後は除く) |
| **入力待ち** | オレンジ | 脈動 | CLI 生存 + (末尾が `AskUserQuestion` / `ExitPlanMode` の未一致 `tool_use`) **または** (Bash / Edit / Write 等の権限プロンプト保留中 = PermissionRequest hook marker あり) |
| **待機中** | 黄 | 静止 | CLI 生存 + 上記以外 (アイドル / 通常のターン終了 / ローカルコマンド直後) |
| **停止** | 灰 | 静止 | CLI 消滅。プロセス終了後 24 時間だけ表示に残る (`STOPPED_RETENTION_SEC = 86_400`) |

緑 / オレンジ の脈動 = AI 側 / ユーザー側 のどちらかに「今すぐ動く必要がある」アクション。入力待ち (オレンジ) は AskUserQuestion / ExitPlanMode の明示的ブロッカーに加え、Bash / Edit / Write 等の Yes/No 権限プロンプトも検出する。通常の AI ターン終了は 待機中 で出るので、複数 CLI を並行運転していても 入力待ち が乱発しない。

`/clear` `/help` `! ls` 等の AI 非介在ローカルコマンドは jsonl の末尾が `system` (`subtype: local_command`) になるため、mtime が新しくても AI処理中 ではなく 待機中 として扱う。これにより、Claude にプロンプトを投げていないのに緑バッジが点く誤検知を防ぐ。

旧 `error` state は、対話ツール選択中に `/exit` した場合と本物のクラッシュを区別できず偽陽性が出るため `stopped` に統合した。

## AI 要約 (オプション)

AI Monitor のダッシュボードカードに「セッションは今何をしていてどこまで進んだか」を **4〜6 行 / 400〜600 文字** で表示する要約機能を持つ。これはオプションで、有効化するには Anthropic API キーをリポジトリ直下の `.env` に置く (`dotenv` で読む。`.gitignore` 済み)。

```bash
# claude-code-manager/.env
ANTHROPIC_API_KEY=sk-ant-...
```

- モデルは `claude-haiku-4-5-20251001` 固定 (コスト感度を優先。`ai-monitor/src/summarize.ts` の `DEFAULT_MODEL`)
- `max_tokens` = 1000、プロンプト本文は 6000 文字、ピン留めする直前ユーザー入力は最大 1200 文字
- システムプロンプトには prompt cache (`cache_control: { type: 'ephemeral' }`) を設定
- 要約は `(jsonlPath, mtimeMs)` 単位でメモリ Map にキャッシュ (サーバ再起動で消える)
- jsonl が要約後に追記されると、キャッシュは残したまま `stale: true` を立てて UI で「要約 (古い):」表示にする (新要約は「再要約」ボタンか次回 idle から)
- キー未設定でもサーバは起動し、カードには「(要約: API キー未設定)」と薄色で表示される
- キー不正 (4xx) は黙って `unavailable` 扱い、ネットワーク / 5xx はキャッシュに入れず次の jsonl 更新時に再試行される

要約完了は SSE (`event: item-changed { id: 'dashboard' }`) でクライアントへ push され、カードが自動で書き換わる。

## 進捗音声 + 公開ミラー (オプション)

複数端末で走る Claude Code の進捗を **音声で読み上げ**、かつ **どこからでもブラウザで状況確認**できるようにする push 型の公開機能。`ai-monitor` を 3 モードで使い分ける。

| モード | 役割 |
|---|---|
| `--mode local` (既定) | ローカル FS を pull して loopback 配信 (`run-ai-monitor.sh` がこれ) |
| `--mode client` | local と同じ可視化 + 公開サーバへ状態を uplink push |
| `--mode server` | 公開アグリゲータ。端末別 Bearer で push を受け、集約・音声生成・ミラー配信 |

```
端末(WSL2/Mac) --mode client  ──Bearer push──▶  公開サーバ --mode server  ──▶  ブラウザ
  既存検出で状態算出 + 送信            集約 + ちょビ口調短文 + Gemini TTS         ミラー表示 + 順次再生
```

- **発話タイミング**: 完了 (Stop) / 承認待ち (Permission・Ask) / 長時間実行の途中経過。指示受信では発話しない。
- **ボイス UI** (server モードのダッシュボードのみ): 🔊 ON/OFF (autoplay 解除兼)・音量・種別/端末フィルタ・履歴 + 再再生・SSE で受けて順次再生 (同時再生しない・古い発話はスキップ)。設定は localStorage 永続。
- **主な環境変数**
  - server: `CCM_INGEST_TOKENS` (必須・端末別 Bearer。16 文字以上・カンマ区切り。各端末の `CCM_CLIENT_TOKEN` を全部列挙。未設定/短すぎは起動失敗。旧名 `CCM_CLIENT_TOKENS` も後方互換で可・非推奨) / `CCM_CORS_ORIGIN` / `ANTHROPIC_API_KEY` (ペルソナ短文。未設定は fallback テンプレ) / `GEMINI_API_KEY` (+`GEMINI_TTS_MODEL`) / `CCM_VOICE_TTS_PROVIDER` (`gemini`|`none`)
  - client: `CCM_SERVER_URL` / `CCM_CLIENT_TOKEN` / `CCM_CLIENT_LABEL` / `CCM_MIRROR_PROJECTS` (ミラー対象 allowlist) / `CCM_DRYRUN`

```bash
# サーバ (公開アグリゲータ)
CCM_INGEST_TOKENS=tok_wsl2_xxxxxxxxxxxxxxxx ai-monitor --mode server --host 0.0.0.0 --port 8181
# 端末 (クライアント)
CCM_SERVER_URL=https://ccm.chobi.me CCM_CLIENT_TOKEN=tok_wsl2_xxxxxxxxxxxxxxxx \
  CCM_MIRROR_PROJECTS=claude-code-manager ai-monitor --mode client
```

ローカルで動作検証する場合は、ビルド + 既存停止 + 起動をまとめた **起動スクリプト**を使う (server 8190 / client 8191・`run-ai-monitor.sh` の local 8181 と併存可)。

```bash
# 端末A: サーバ (ミラー + 音声)。GEMINI_API_KEY/CCM_INGEST_TOKENS は .env か env で
./run-voice-server.sh      # → http://127.0.0.1:8190/view?item=dashboard を開く
# 端末B: クライアント (この端末の状態を push)
CCM_MIRROR_PROJECTS=claude-code-manager ./run-voice-client.sh
```

> 新しいクライアント端末では、起動前に一度 **`./scripts/setup-client.sh`** を実行する (権限プロンプト検出 hook の配置 + `~/.claude/settings.json` への冪等マージ + `.env` 雛形作成。冪等)。詳細・hook あり/なしの挙動差は [権限プロンプト検出のための hook](#権限プロンプト検出のための-hook) を参照。`local` / `server` モードのみで使う端末には不要。

設定の解決順は対象で分かれる:
- **node (`cli.ts`) が読む設定** (`CCM_CLIENT_TOKEN(S)` / `CCM_CORS_ORIGIN` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `GEMINI_TTS_MODEL` / `CCM_VOICE_TTS_PROVIDER` / `CCM_SERVER_URL` / `CCM_CLIENT_LABEL` / `CCM_MIRROR_PROJECTS` / `CCM_DRYRUN`) … **env > リポ直下 `.env` > 既定**（`.env` は `dotenv` が読む。スクリプトは値を上書きせず、env にも `.env` にも無いときだけトークンの開発用デフォルトを注入し警告する＝本番不可）
- **起動スクリプトが解決するポート/ホスト** (`CCM_SERVER_HOST` / `CCM_SERVER_PORT` / `CCM_CLIENT_DASH_PORT`) … **env > リポ直下 `.env` > 既定**（`run-voice-*.sh` が `.env` も読み `--host`/`--port` で渡す。`cli.ts` 自体は読まないので、直接 `node dist/cli.js` 起動時は `--host`/`--port` で指定する）
- **`SKIP_BUILD` / `CCM_LOG_DIR`** … **env > 既定 のみ**（実行ごとのフラグ・`.env` 非対応）

各スクリプトは出力を **`logs/voice-server.log` / `logs/voice-client.log`** に `tee` で追記する（ターミナル表示と両立。`logs/` は gitignore 済み・`CCM_LOG_DIR` で変更可）。後から `tail -f logs/voice-server.log` や Claude Code から参照できる。

> ⚠️ **プライバシー**: ミラーは transcript 末尾・要約・進捗テキストを Cloudflare / 公開サーバ / AI プロバイダ (Anthropic・Gemini) に通過させる。送信前に `ai-monitor/src/redaction.ts` で秘匿パターン (API キー・トークン・private key 等) をマスク + サイズ上限を掛け、`jsonlPath` は送らず、音声 detail は tool 名/入力を含めず短く切り詰める。ミラー対象は `CCM_MIRROR_PROJECTS` で限定すること。保持はメモリ + TTL (集約 24h / 音声 1h) のみで永続化しない。

公開デプロイ (g3plus + Cloudflare Tunnel `ccm.chobi.me` + Cloudflare Access) の成果物と手順は **[`ai-monitor/deploy/g3plus/`](ai-monitor/deploy/g3plus/)** (Dockerfile / docker-compose.yml / .env.example / README) を参照。サーバ・Cloudflare の操作はユーザーが実施する。

## vibeboard.config.json

vibeboard 起動時に `vibeboard.config.json` を読み、`customTabs` 設定から AI Monitor タブを生成する。

```json
{
  "customTabs": [
    { "name": "ai-monitor", "label": "AI Monitor", "baseUrl": "http://127.0.0.1:8181" }
  ]
}
```

AI Monitor のポートを変える場合は `AI_MONITOR_PORT=<N> ./run-ai-monitor.sh` で起動し、ここの `baseUrl` も同じポートに合わせる。

## 権限プロンプト検出のための hook

`Bash` / `Edit` / `Write` 等のツール実行に対する Yes/No 権限プロンプトを「入力待ち」バッジで検出するために、グローバル hook を 1 つ配置する。hook と Claude Code 側の設定はリポ未管理 = 端末ごとの配置が必要なため、**セットアップスクリプトで冪等に行う** (何度実行しても安全)。

```bash
./scripts/setup-client.sh
```

スクリプトがやること:

- `python3` の存在確認 + **絶対パス解決** (Homebrew のみの Mac でも hook 起動シェルの PATH に依存しないよう、`/opt/homebrew/bin/python3` 等の絶対パスを settings.json に書く)
- 正本 `ai-monitor/hooks/ccm-awaiting-marker.py` を `~/.claude/hooks/` へ配置 (+x・差分時のみ上書き・`.bak` 付き)
- `~/.claude/settings.json` の `PermissionRequest` / `PostToolUse` / `Stop` に hook を冪等マージ (既存 `notify-*.py` 等を壊さない・二重登録しない・`.bak` 付き)
- `.env` が無ければ `.env.example` から作成し、client モードに必要な値 (`CCM_SERVER_URL` / `CCM_CLIENT_TOKEN` / `CCM_CLIENT_LABEL`) の記入を案内

hook の中身:

- ファイル: `~/.claude/hooks/ccm-awaiting-marker.py` (正本は [`ai-monitor/hooks/ccm-awaiting-marker.py`](ai-monitor/hooks/ccm-awaiting-marker.py)・OS 非依存の純 python)
- 動作: `PermissionRequest` イベントで `/tmp/claude-code-manager/awaiting-input/<session_id>.json` を作成、`PostToolUse` / `Stop` で削除する
- AI Monitor は `fs.watch` でその marker ディレクトリを監視し、変化を即座に SSE で UI に反映する

### hook あり / なしの挙動

hook が足すのは **Bash / Edit / Write の権限プロンプトを「入力待ち」として検出する 1 点のみ**。状態バッジ・音声の大半は jsonl + プロセス検出から出るので hook なしでも動く (= 今 hook 無しでも進捗音声は鳴る)。

| 機能 | hook なし | hook あり |
|---|:---:|:---:|
| バッジ AI処理中 / 待機中 / 停止 | ✅ | ✅ |
| バッジ 入力待ち (AskUserQuestion / ExitPlanMode) | ✅ | ✅ |
| バッジ 入力待ち (Bash / Edit / Write の権限プロンプト) | ❌ | ✅ |
| 音声: 完了 / 途中経過 | ✅ | ✅ |
| 音声: 承認待ち (対話ツール: AskUserQuestion / ExitPlanMode) | ✅ | ✅ |
| 音声: 承認待ち (権限プロンプト) | ❌ | ✅ |

hook 無しで権限プロンプトが保留中のとき、jsonl は tool_use 直後で mtime が新しいためバッジは AI処理中 → 30 秒で 待機中 に落ち、この遷移を「完了」と**誤発話**する (実際は承認待ち)。hook を入れると marker で 承認待ち に強制遷移し、この偽の完了発話を是正する。`AskUserQuestion` / `ExitPlanMode` の検出は jsonl 末尾を直接見るので hook なしでも動く。

## 開発

```bash
# 単体テスト
(cd ai-monitor && npm test)
(cd vibeboard && npm test)

# ビルド単体
(cd ai-monitor && npm run build)
(cd vibeboard && npm run build)
```

- `tsconfig` は `strict` 有効
- ai-monitor のテストは `node --test` 直叩き + `ts-node/register`
- 作業着手前にプランファイル (`docs/plans/<task-name>.md`) を作る、TODO/DONE を回す等のルールは [`CLAUDE.md`](./CLAUDE.md) の「作業着手ルール」を参照

## トラブルシューティング

- **ポート競合**: `VIBEBOARD_PORT=<N> AI_MONITOR_PORT=<M> ./run-ai-monitor.sh` で変更。AI Monitor 側を変えたら `vibeboard.config.json` の `baseUrl` も合わせる
- **Bash / Edit / Write の権限プロンプトが「入力待ち」に変わらない**: `~/.claude/hooks/ccm-awaiting-marker.py` が配置されているか、Claude Code 側の hook 設定で読み込まれているかを確認
- **要約が出ない / `(要約: API キー未設定)` のままになる**: `.env` の `ANTHROPIC_API_KEY` を確認。`ai-monitor` のログに 4xx (`401` 等) が出ていればキー不正 (黙って `unavailable` になるので UI には理由が出ない)。5xx / ネットワークは次回 jsonl 更新で自動再試行される
- **停止カードが残り続ける**: 仕様。`STOPPED_RETENTION_SEC = 86_400` で 24 時間表示に残してから消す

## 詳細

- プロジェクトの目的・要件・運用ルールは [`CLAUDE.md`](./CLAUDE.md)
- AI Monitor の設計・進捗は [`docs/plans/archive/ai-monitor.md`](./docs/plans/archive/ai-monitor.md)
- vibeboard customTabs 拡張の仕様は [`docs/specs/vibeboard-custom-tabs.md`](./docs/specs/vibeboard-custom-tabs.md)
