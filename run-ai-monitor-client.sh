#!/usr/bin/env bash
# ai-monitor を client モードで起動する。この端末の Claude セッション状態を
# 公開サーバ (server モード) へ push する。検証では run-ai-monitor.sh (server) と対で使う。
# クライアント自身もローカルダッシュボード (従来 local 表示・音声なし) を別ポートで開く。
#
# 設定の優先順位:
#   node (cli.ts) が読む設定 … env > リポ直下 .env > 既定。
#     CCM_SERVER_URL / CCM_CLIENT_TOKEN / CCM_CLIENT_LABEL / CCM_MIRROR_PROJECTS /
#     CCM_DRYRUN など。.env は cli.ts の dotenv が読むため、スクリプトは値を上書きせず、
#     env にも .env にも無いときだけ開発用デフォルトを注入する。
#   起動スクリプト固有の設定 … env > リポ直下 .env > 既定 (このスクリプトが .env も読む)。
#     CCM_CLIENT_DASH_PORT / CCM_SERVER_PORT (push 先 URL の既定に使用)。
#   SKIP_BUILD / CCM_LOG_DIR は env > 既定 のみ (.env 非対応)。
#
#   CCM_SERVER_URL        push 先 (既定 http://127.0.0.1:<CCM_SERVER_PORT|8190>)
#   CCM_CLIENT_TOKEN      Bearer (server の CCM_INGEST_TOKENS のいずれかと一致させる)
#   CCM_CLIENT_LABEL      端末名 (既定 hostname。cli.ts が決定)
#   CCM_MIRROR_PROJECTS   ミラー対象 allowlist (cwd basename / projectDir / cwd。未設定=全件)
#   CCM_CLIENT_DASH_PORT  クライアント側ローカルダッシュボードのポート (既定 8191)
#   CCM_DRYRUN=1          実送信せずログのみ
#   SKIP_BUILD=1          ビルドを省略 (.env 不可)
#   CCM_LOG_DIR           ログ出力先 (既定 <repo>/logs。ai-monitor-client.log に tee 追記・.env 不可)
set -euo pipefail
cd "$(dirname "$0")"

# .env から KEY の値を取り出す (env に無いとき .env を参照し env > .env > 既定 を実現)。
# ポート類は cli.ts/dotenv が読まないので、起動スクリプトが解決する。表示用フォールバックにも使う。
dotenv_get() { [ -f .env ] && grep -E "^$1=." .env 2>/dev/null | tail -n1 | cut -d= -f2- || true; }

DASH_PORT="${CCM_CLIENT_DASH_PORT:-$(dotenv_get CCM_CLIENT_DASH_PORT)}"; DASH_PORT="${DASH_PORT:-8191}"
SERVER_PORT="${CCM_SERVER_PORT:-$(dotenv_get CCM_SERVER_PORT)}"; SERVER_PORT="${SERVER_PORT:-8190}"

# --- ログをファイルにも残す (Claude Code から参照できるように) ---
# 既定 <repo>/logs/ai-monitor-client.log。CCM_LOG_DIR で変更可。
LOG_DIR="${CCM_LOG_DIR:-$(pwd)/logs}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/ai-monitor-client.log"
exec > >(tee -a "$LOG") 2>&1
echo "===== [$(date '+%F %T')] run-ai-monitor-client start  dash_port=$DASH_PORT pid=$$ ====="

# --- ビルド (SKIP_BUILD=1 で省略) ---
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  [ -d ai-monitor/node_modules ] || { echo "[build] ai-monitor: npm install" >&2; (cd ai-monitor && npm install); }
  echo "[build] ai-monitor: npm run build" >&2
  (cd ai-monitor && npm run build)
fi

# --- push 先 (env > .env > 既定 loopback) ---
# .env にしか無い場合は bash 側で未束縛のままなので (dotenv は node が読む)、
# 表示用には ${..:-...} でフォールバックし set -u を踏まない。
if [ -z "${CCM_SERVER_URL:-}" ] && ! grep -qE '^CCM_SERVER_URL=.+' .env 2>/dev/null; then
  export CCM_SERVER_URL="http://127.0.0.1:$SERVER_PORT"
  echo "[info] CCM_SERVER_URL 未設定 → $CCM_SERVER_URL を使用" >&2
fi
SERVER_URL_DISP="${CCM_SERVER_URL:-$(dotenv_get CCM_SERVER_URL)}"
SERVER_URL_DISP="${SERVER_URL_DISP:-(未設定)}"

# --- トークン (env > .env > 開発用デフォルト。server と一致が必須) ---
if [ -z "${CCM_CLIENT_TOKEN:-}" ] && ! grep -qE '^CCM_CLIENT_TOKEN=.+' .env 2>/dev/null; then
  export CCM_CLIENT_TOKEN="localdevtoken1234567890"
  echo "[warn] CCM_CLIENT_TOKEN 未設定 → 開発用デフォルトを使用: $CCM_CLIENT_TOKEN" >&2
  echo "[warn]   server の CCM_INGEST_TOKENS にこの値が含まれている必要があります" >&2
fi

# --- ラベル / allowlist (cli.ts が env/.env から読む。スクリプトは表示のみ・上書きしない) ---
# 以前は CCM_CLIENT_LABEL を常に export していたが、それだと .env のラベルを
# hostname で握りつぶす (dotenv は既存 env を上書きしない) ため、export はやめ表示だけ行う。
LABEL_DISP="${CCM_CLIENT_LABEL:-$(dotenv_get CCM_CLIENT_LABEL)}"
LABEL_DISP="${LABEL_DISP:-$(hostname) (既定)}"
MIRROR_DISP="${CCM_MIRROR_PROJECTS:-$(dotenv_get CCM_MIRROR_PROJECTS)}"
if [ -n "$MIRROR_DISP" ]; then
  echo "[info] ミラー対象 allowlist: $MIRROR_DISP" >&2
else
  echo "[info] CCM_MIRROR_PROJECTS 未設定 → 検出した全プロジェクトをミラー (絞るなら設定)" >&2
fi

# --- 既存 client を停止 (server/local は止めない) ---
pids=$(pgrep -f "ai-monitor/dist/cli.js --mode client" || true)
if [ -n "$pids" ]; then
  echo "[stop] 既存 client を停止: $pids" >&2
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 1
fi

echo "[start] ai-monitor client  → push 先 $SERVER_URL_DISP  (label=$LABEL_DISP)" >&2
echo "[start]   ローカルダッシュボード(従来表示・音声なし): http://127.0.0.1:$DASH_PORT/view?item=dashboard" >&2
exec node ai-monitor/dist/cli.js --mode client --host 127.0.0.1 --port "$DASH_PORT"
