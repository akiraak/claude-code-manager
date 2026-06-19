# claude-code-manager

複数の Claude Code CLI 実行を一元管理するためのシステム。

## 目的

複数の Claude Code CLI を同時に走らせていると、「どの CLI が何をやっていたか」がすぐに分からなくなり混乱する。
本プロジェクトはその混乱を防ぐための管理基盤を提供する。

## システム要件

- **Web ページで閲覧できる**: 各 CLI の状況をブラウザから確認できる UI を持つ
- **Claude Code CLI 毎に表示する**: 起動中／実行履歴のある CLI ごとに区分けして表示する
- **ユーザーコマンドと AI 応答を見やすく表示**: ユーザーが投入したプロンプトと、Claude からの応答（ツール呼び出しを含む）を時系列で読みやすく描画する
- **情報量が多いものは AI で要約**: ログや出力が長くなった場合、AI を使って要約表示し、必要に応じて原文も参照できるようにする

## 用語

- **CLI セッション**: 1 つの `claude` プロセスの起動から終了までの単位
- **ターン**: ユーザー入力と、それに対する AI の応答（ツール呼び出し含む）の往復 1 回分

<!-- vibeboard:begin -->
## 開発管理画面 (vibeboard)

ローカル開発時のタスク・プラン管理は [vibeboard](https://github.com/akiraak/vibeboard) で行う。
upstream を本リポに fork として取り込み済み（`./vibeboard/`）。改修は本リポで直接コミットする。
upstream への反映は後追いで行う。

```bash
# 起動 (依存インストール + ビルド + 既存停止 + 起動 を全部やる)
./run-ai-monitor.sh
```

`http://localhost:8180` でプロジェクト直下の `docs/plans/`・`docs/specs/`・`TODO.md`・`DONE.md` を閲覧・編集できる。

- `TODO` タブで `TODO.md` / `DONE.md` をプレビュー表示・編集できる
  - 編集は楽観ロック（mtime チェック）付き。外部で先に更新されていた場合は保存時に 409 を返し、リロード / 手元維持 / 強制上書き を選べる
  - `fs.watch` + 2 秒ポーリングで外部変更を検知し、SSE でクライアントへ即時反映する
- ローカル開発専用（本番管理画面とは独立）
- ポート変更は `VIBEBOARD_PORT` 環境変数で指定可能（デフォルト 8180）

## AI Monitor (vibeboard customTabs プラグイン)

稼働中の Claude Code CLI を vibeboard 上で可視化するためのサーバ。`./ai-monitor/` に実装がある。`run-ai-monitor.sh` が vibeboard と一緒に起動する（別プロセス）。

```bash
# 起動 (vibeboard 8180 + ai-monitor 8181 をまとめて立ち上げる。
#       依存インストール + ビルドもスクリプト内で実施)
./run-ai-monitor.sh
```

- `vibeboard.config.json` の `customTabs` に AI Monitor のエントリ（`baseUrl: http://127.0.0.1:8181`）を登録済み。vibeboard 起動時に **AI Monitor** タブとして読み込まれる
- `run-ai-monitor.sh` は既に起動中の vibeboard / ai-monitor を `pgrep -f` で検出し、停止してから起動し直す
- ポート変更は `VIBEBOARD_PORT` / `AI_MONITOR_PORT` 環境変数で指定可能。AI Monitor 側を変えた場合は `vibeboard.config.json` の `baseUrl` も合わせる

#### 動作モード (`--mode`)

| モード | 役割 | FS アクセス | 書き込み API |
|---|---|---|---|
| `local` (既定) | ローカル FS を pull して loopback 配信 (従来どおり) | `~/.claude/projects/*/*.jsonl` と `/proc` のみ read-only | なし |
| `client` | local と同じ可視化 + 公開サーバへ uplink push | 同上 read-only | なし (送信のみ) |
| `server` | 公開アグリゲータ。端末別 Bearer で push を受け集約・音声生成・ミラー配信 | **FS は読まない** (集約ストア = メモリ + TTL) | `/api/ingest/*` (認証付き) |

`run-ai-monitor.sh` は `local` を起動する (`--mode local` 明示)。`local`/`client` は従来どおりローカル read-only で、書き込み API も持たない。公開・認証付き ingestion は `server` モードに限る。

ローカル動作検証用の起動スクリプト (ビルド + 同モードの既存停止 + 起動。3 つ併存可):
- `./run-voice-server.sh` — server モード (既定 8190。ミラー + 音声)。`http://127.0.0.1:8190/view?item=dashboard`
- `./run-voice-client.sh` — client モード (既定 8191。この端末の状態を server へ push)
- 各スクリプトの停止対象は自モードのみ (`pgrep -f "...--mode <mode>"`) なので互いを巻き込まない。設定の解決順は対象で分かれる: node (`cli.ts`) が読む設定 (トークン/キー/URL/ラベル/allowlist 等) は **env > リポ直下 `.env` > 既定**、スクリプト固有のポート/ホストと `SKIP_BUILD` は **env > 既定** (`.env` 非対応。`cli.ts` が `--port`/`--host` 引数で受け取り env/`.env` を見ないため)。

### ダッシュボードの状態バッジ

カード左上のバッジで 1 セッションの現在状態を 4 種類で示す。判定は `ai-monitor/src/state.ts` の `classifyV2`。

| バッジ | 色 | 装飾 | 条件 |
|---|---|---|---|
| AI処理中 | 緑       | 脈動 | CLI 生存 + 直近 30 秒以内に jsonl 更新あり (AI 非介在のローカルコマンド直後は除く) |
| 入力待ち | オレンジ | 脈動 | CLI 生存 + (末尾が `AskUserQuestion` / `ExitPlanMode` の未一致 `tool_use`) **または** (PermissionRequest hook の marker あり) |
| 待機中   | 黄       | 静止 | CLI 生存 + 上記以外 (アイドル / 通常のターン終了 / `/clear` `! ls` 等の AI 非介在ローカルコマンド直後) |
| 停止     | 灰       | 静止 | CLI 消滅 (24 時間だけ残る = `STOPPED_RETENTION_SEC = 86_400` 秒) |

入力待ち は **明示的なユーザー応答ブロッカーのみ** に限定する方針 (通常の AI ターン終了は 待機中)。
Bash / Edit / Write 等の Yes/No 権限プロンプトも入力待ちに含めるため、グローバル hook (`~/.claude/hooks/ccm-awaiting-marker.py`) が PermissionRequest 時に `/tmp/claude-code-manager/awaiting-input/<session_id>.json` を置き、PostToolUse / Stop で消す。AI Monitor はそれを読み取り、`fs.watch` で変化を即座に SSE へ反映する。
`/clear` `/help` `! ls` 等の AI 非介在ローカルコマンドは jsonl の末尾が `system` (`subtype: local_command`) になるため、mtime が新しくても AI処理中 ではなく 待機中 として扱う (誤検知防止)。
旧 `error` state は、対話ツール選択中に `/exit` した場合と本物のクラッシュを区別できず偽陽性が出るため `stopped` に統合した。
突き合わせキーは `projectDir` (= `~/.claude/projects/<projectDir>/`)。セッション中に `cd` しても projectDir は不変なので 1 セッションが 1 カードにまとまる。

### AI 要約 (オプション)

ダッシュボードのカードに「セッションは今何をしていてどこまで進んだか」を Claude API で 1〜2 行に要約して表示する。

- リポジトリ直下の `.env` (gitignore 済み) に `ANTHROPIC_API_KEY=...` を置くと有効になる。`ai-monitor` 起動時に `dotenv` で読む
- モデル: `claude-haiku-4-5-20251001` 固定
- キャッシュは `(jsonlPath, mtimeMs)` 単位のメモリ Map。サーバ再起動で消える
- キー未設定でもサーバは落ちず、カードに「(要約: API キー未設定)」が薄色表示される
- 要約完了は SSE (`event: item-changed { id: 'dashboard' }`) でクライアントへ push され、カードが自動更新される

### 進捗音声 + 公開ミラー (server/client モード)

各端末 (`--mode client`) が状態スナップショット + 状態遷移イベントを公開サーバ (`--mode server`) へ push し、サーバが **キャラ口調 (ちょビ) の短文 → 音声 (Gemini TTS)** を生成、ブラウザのダッシュボード上で **ミラー表示 + 順次再生**する。発話は **完了 / 承認待ち / 長時間実行の途中経過** のみ (指示受信では発話しない)。

- 主な env (server): `CCM_CLIENT_TOKENS` (必須・端末別 Bearer・fail-fast) / `CCM_CORS_ORIGIN` / `ANTHROPIC_API_KEY` (ペルソナ短文・未設定は fallback) / `GEMINI_API_KEY`(+`GEMINI_TTS_MODEL`) / `CCM_VOICE_TTS_PROVIDER` (gemini|none)。
- 主な env (client): `CCM_SERVER_URL` / `CCM_CLIENT_TOKEN` / `CCM_CLIENT_LABEL` / `CCM_MIRROR_PROJECTS` (ミラー対象 allowlist) / `CCM_DRYRUN`。
- ボイス UI (ON/OFF・音量・種別/端末フィルタ・履歴 + 再再生・SSE 順次再生) は **server モードのダッシュボードにのみ**載る (`renderDashboard(opts.voice)`)。🔊 ON のクリックが autoplay 解除を兼ねる。
- **プライバシー**: ミラーは transcript 末尾・要約・進捗テキストを Cloudflare / g3plus / AI プロバイダへ通過させる。送信前に `redaction.ts` で秘匿パターンをマスク + サイズ上限、`jsonlPath` は送らない、音声 detail は tool 名/入力を含めず短く切り詰め。対象は `CCM_MIRROR_PROJECTS` で限定する。保持はメモリ + TTL (集約 24h / utterance 1h) のみ。
- 公開デプロイ (g3plus + Cloudflare Tunnel `ccm.chobi.me` + Access) の成果物と手順は `ai-monitor/deploy/g3plus/`(Dockerfile / docker-compose.yml / .env.example / README) を参照。**インフラ操作はユーザー担当**。

## タスク管理ルール

- タスクは `TODO.md` で管理する
- タスクが完了したら `TODO.md` から該当項目を削除し、`DONE.md` に移動する
- `DONE.md` には完了日を `YYYY-MM-DD` 形式で付けて記録する
- 新しいタスクが発生したら `TODO.md` の適切なセクションに追加する
- タスクの実施前に `TODO.md` を確認し、優先度の高いものから着手する
- コミット時に `TODO.md` を確認し、実装した機能に対応するタスクがあれば `DONE.md` に移動する

## 作業着手ルール

作業（実装・調査いずれも）を始めるときは、コードに手を入れる前に以下を行う。

1. **プランファイルを作成する**: `docs/plans/<task-name>.md` に実装プラン or 調査プランを作成する
   - 目的・背景、対応方針、影響範囲、テスト方針を最低限記載する
   - 複数 Phase / Step に分かれる場合はファイル内でも Phase / Step を明示する
2. **`TODO.md` に該当項目があるか確認する**
   - 無ければ適切なセクションに追加する
   - 既存項目があれば、その項目に作成したプランファイルへのリンクを追記する（例: `[plan](docs/plans/<task-name>.md)`）
3. **複数 Phase / Step がある場合は `TODO.md` に子タスクとして追加する**
   - 親項目の下にインデントしたチェックボックスで Phase / Step を列挙する
   - Phase / Step が完了するごとにチェックを入れ、全完了で親項目を `DONE.md` に移す
4. **作業完了時の後片付け**
   - 親タスクを `DONE.md` に移動する
   - 対応するプランファイルは `docs/plans/archive/` に移動する
<!-- vibeboard:end -->
