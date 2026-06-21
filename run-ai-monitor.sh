#!/usr/bin/env bash
# run-ai-monitor.sh
# vibeboard (管理画面) + ai-monitor server (集約 + 音声 + ミラー) をまとめて起動する。
#
# server は FS を読まない「集める専用」の公開アグリゲータ。各端末のセッションを映すには
# 別途 run-ai-monitor-client.sh を起動して push する (この run-ai-monitor.sh を動かす PC でも
# 別途 client を起動する必要がある。単体ではダッシュボードのカードは空)。
# client (--mode client) は run-ai-monitor-client.sh が別管理。このスクリプトは止めない。
#
# 設定の優先順位:
#   node (cli.ts) が読む設定 … env > リポ直下 .env > 既定。
#     CCM_INGEST_TOKENS / CCM_CORS_ORIGIN / ANTHROPIC_API_KEY / GEMINI_API_KEY /
#     GEMINI_TTS_MODEL / CCM_VOICE_TTS_PROVIDER。スクリプトは値を上書きせず、env にも
#     .env にも無いときだけトークンの開発用デフォルトを注入する。
#   起動スクリプト固有の設定 … env > リポ直下 .env > 既定 (このスクリプトが .env も読む)。
#     VIBEBOARD_PORT / CCM_SERVER_PORT / CCM_SERVER_HOST。直接 node 起動時は --port/--host。
#     VIBEBOARD_REPO / VIBEBOARD_REF … vibeboard の clone 元 / pin するタグ (既定 v0.2.0)。
#   SKIP_BUILD / CCM_LOG_DIR は env > 既定 のみ (.env 非対応)。
#
# vibeboard ソースは本リポに vendored せず、初回起動時に upstream から clone する
# (vibeboard/ が無ければ VIBEBOARD_REF で shallow clone。既にあれば再利用)。
set -euo pipefail

cd "$(dirname "$0")"

# .env から KEY の値を取り出す (env に無いとき .env を参照し env > .env > 既定 を実現)。
# 注: cli.ts/dotenv はポート/ホストを読まないので、これらは起動スクリプトが解決して --port/--host で渡す。
dotenv_get() { [ -f .env ] && grep -E "^$1=." .env 2>/dev/null | tail -n1 | cut -d= -f2- || true; }

VIBEBOARD_PORT="${VIBEBOARD_PORT:-$(dotenv_get VIBEBOARD_PORT)}"; VIBEBOARD_PORT="${VIBEBOARD_PORT:-8180}"
SERVER_PORT="${CCM_SERVER_PORT:-$(dotenv_get CCM_SERVER_PORT)}"; SERVER_PORT="${SERVER_PORT:-8190}"
SERVER_HOST="${CCM_SERVER_HOST:-$(dotenv_get CCM_SERVER_HOST)}"; SERVER_HOST="${SERVER_HOST:-127.0.0.1}"

# vibeboard ソースは vendored をやめ upstream から pin したタグを clone して取得する。
# REPO/REF も env > .env > 既定 で解決する (REF はタグ/SHA。再現性のため固定推奨)。
# 既定は HTTPS (公開リポなので鍵不要・fresh checkout / CI でもそのまま clone できる)。
# SSH で取りたい場合は VIBEBOARD_REPO=git@github.com:akiraak/vibeboard.git を env/.env で指定。
VIBEBOARD_REPO="${VIBEBOARD_REPO:-$(dotenv_get VIBEBOARD_REPO)}"; VIBEBOARD_REPO="${VIBEBOARD_REPO:-https://github.com/akiraak/vibeboard.git}"
VIBEBOARD_REF="${VIBEBOARD_REF:-$(dotenv_get VIBEBOARD_REF)}"; VIBEBOARD_REF="${VIBEBOARD_REF:-v0.2.0}"

LOG_DIR="${CCM_LOG_DIR:-$(pwd)/logs}"
mkdir -p "$LOG_DIR"

# --- vibeboard ソース取得 (vendored 廃止: upstream の pin したタグを clone) ---
# vibeboard/ が無ければ upstream を VIBEBOARD_REF で shallow clone する。既にあれば再利用
# (再取得したいときは vibeboard/ を消すか、別 REF で手動 clone する)。clone 後の
# node_modules/dist は build_pkg が生成する。
ensure_vibeboard() {
  if [ -f vibeboard/package.json ]; then
    return 0  # 既存チェックアウトを再利用
  fi
  # vibeboard/ が在るのに package.json が無い = 壊れた/想定外の状態。
  # 自動削除するとユーザの中身を消しかねないので、消さずにエラーで止める。
  if [ -e vibeboard ]; then
    echo "[error] 'vibeboard' が存在しますが有効なチェックアウトではありません (package.json なし)。" >&2
    echo "[error]   中身を確認し、不要なら手動で削除してから再実行してください: rm -rf vibeboard" >&2
    exit 1
  fi
  # 取得前に ref が remote に在るか確認する。既定 v0.2.0 は upstream リリース後に存在する
  # ため、未リリース時は「タグ未公開」と分かる明確なエラーにする (cryptic な clone 失敗を防ぐ)。
  if ! git ls-remote --exit-code "$VIBEBOARD_REPO" \
         "refs/tags/$VIBEBOARD_REF" "refs/heads/$VIBEBOARD_REF" >/dev/null 2>&1; then
    echo "[error] $VIBEBOARD_REPO に ref '$VIBEBOARD_REF' が見つかりません (未公開タグ/ブランチ、またはネットワーク不通)。" >&2
    echo "[error]   - upstream をリリースしてタグを push してください (vibeboard リポで): git push origin main && git push origin $VIBEBOARD_REF" >&2
    echo "[error]   - 既に公開済みのタグ/ブランチを使うなら VIBEBOARD_REF=<ref> を env/.env で指定" >&2
    echo "[error]   - オフラインなら接続を確認して再実行" >&2
    exit 1
  fi
  # ここでは vibeboard/ は存在しない。一時ディレクトリへ clone し、成功時のみ配置する。
  # こうすることで clone 失敗時の後始末は「自分が作った一時 dir」だけに限定され、
  # 既存の vibeboard/ を絶対に消さない。
  local tmp="vibeboard.tmp.$$"
  rm -rf "$tmp"
  echo "[fetch] vibeboard が無いので upstream を clone します: $VIBEBOARD_REPO @ $VIBEBOARD_REF" >&2
  if ! git clone --depth 1 --branch "$VIBEBOARD_REF" "$VIBEBOARD_REPO" "$tmp"; then
    rm -rf "$tmp"  # 自分が作った一時 dir だけ消す (既存 vibeboard/ は触らない)
    echo "[error] vibeboard の clone に失敗しました ($VIBEBOARD_REPO @ $VIBEBOARD_REF)" >&2
    echo "[error]   - ネットワーク接続を確認するか、手動で次を実行: git clone --branch $VIBEBOARD_REF $VIBEBOARD_REPO vibeboard" >&2
    echo "[error]   - upstream にタグ $VIBEBOARD_REF がまだ無い場合は、リリース後に再実行してください" >&2
    echo "[error]   - SSH で取りたい場合は VIBEBOARD_REPO=git@github.com:akiraak/vibeboard.git を指定" >&2
    exit 1
  fi
  mv "$tmp" vibeboard
}
ensure_vibeboard

# --- ビルド (SKIP_BUILD=1 で省略) ---
build_pkg() {
  local dir="$1"
  if [ ! -d "$dir/node_modules" ]; then
    echo "[build] $dir: npm install" >&2
    (cd "$dir" && npm install)
  fi
  echo "[build] $dir: npm run build" >&2
  (cd "$dir" && npm run build)
}
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  build_pkg vibeboard
  build_pkg ai-monitor
fi

# --- 必須: ingest トークン (server, env > .env > 開発用デフォルト) ---
# env にも .env にも無いときだけ開発用デフォルトを export する (.env にある場合は dotenv に委ねる)。
# server が読むのは CCM_INGEST_TOKENS (旧 CCM_CLIENT_TOKENS も cli.ts が後方互換で読む)。
# client 系の注入 (CCM_SERVER_URL / CCM_CLIENT_TOKEN) は一切しない (client は run-ai-monitor-client.sh の責務)。
if [ -z "${CCM_INGEST_TOKENS:-}" ] && [ -z "${CCM_CLIENT_TOKENS:-}" ] \
   && ! grep -qE '^CCM_INGEST_TOKENS=.+' .env 2>/dev/null \
   && ! grep -qE '^CCM_CLIENT_TOKENS=.+' .env 2>/dev/null; then
  export CCM_INGEST_TOKENS="localdevtoken1234567890"
  echo "[warn] CCM_INGEST_TOKENS 未設定 → 開発用デフォルトを使用 (本番不可): $CCM_INGEST_TOKENS" >&2
  echo "[warn]   本番トークン生成: openssl rand -base64 32 | tr -d '+/=' | head -c 32" >&2
fi

# --- 任意: AI キーの有無を案内 (注入はしない) ---
if [ -z "${GEMINI_API_KEY:-}" ] && ! grep -qE '^GEMINI_API_KEY=.+' .env 2>/dev/null; then
  echo "[info] GEMINI_API_KEY 未設定 → 音声は出ません (テキストのみ)。鳴らすなら .env か env に設定" >&2
fi
if [ -z "${ANTHROPIC_API_KEY:-}" ] && ! grep -qE '^ANTHROPIC_API_KEY=.+' .env 2>/dev/null; then
  echo "[info] ANTHROPIC_API_KEY 未設定 → 要約 / ペルソナ短文は定型フォールバック" >&2
fi

# --- CORS: AI Monitor タブ (vibeboard :VIBEBOARD_PORT) が server (:SERVER_PORT) へ
#     ブラウザから fetch / SSE するため、server は vibeboard のオリジンを必ず許可する必要がある。
#     server モードは CCM_CORS_ORIGIN のオリジンしか許可しない (local の `*` と違う) ので、
#     未許可だと AI Monitor タブが "Failed to fetch" になる。
#     既存設定 (env > .env) があってもそれが vibeboard オリジンを含むとは限らないため、
#     vibeboard/server の loopback オリジンを「常にマージ」して export する (既存値は保持・重複除去)。
#     export するので dotenv (.env) より優先される = .env に何が入っていても loopback は必ず許可される。
CORS_REQUIRED="http://localhost:$VIBEBOARD_PORT,http://127.0.0.1:$VIBEBOARD_PORT,http://localhost:$SERVER_PORT,http://127.0.0.1:$SERVER_PORT"
CORS_EXISTING="${CCM_CORS_ORIGIN:-$(dotenv_get CCM_CORS_ORIGIN)}"
# 既存 + 必須 をカンマ連結 → 改行分割 → trim + 空/重複除去 (出現順維持) → カンマ再結合。
CCM_CORS_ORIGIN="$(printf '%s,%s' "$CORS_EXISTING" "$CORS_REQUIRED" \
  | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | awk 'NF && !seen[$0]++' | paste -sd, -)"
export CCM_CORS_ORIGIN
echo "[info] CCM_CORS_ORIGIN (vibeboard タブ用に loopback を必ず含めてマージ): $CCM_CORS_ORIGIN" >&2
echo "[info]   LAN 越し/別ホストのブラウザで開くなら .env か env の CCM_CORS_ORIGIN にそのオリジンを足す" >&2

stop_existing() {
  local label="$1" pattern="$2" pids
  pids=$(pgrep -f "$pattern" || true)
  if [ -n "$pids" ]; then
    echo "[stop] $label を停止: $pids" >&2
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      pids=$(pgrep -f "$pattern" || true)
      [ -z "$pids" ] && break
      sleep 0.5
    done
    pids=$(pgrep -f "$pattern" || true)
    if [ -n "$pids" ]; then
      echo "[stop] $label を強制終了: $pids" >&2
      # shellcheck disable=SC2086
      kill -9 $pids 2>/dev/null || true
    fi
  fi
}

# 自分が管理するものだけ停止する。
# - server: 自分の前回起動 + 旧 run-voice-server.sh が残っていればポート衝突回避で停止。
# - 旧 local(8181): 移行前の run-ai-monitor.sh が残っていれば解放 (--mode local / 旧 --port 形式)。
# run-ai-monitor-client.sh の client (--mode client) は対象外。
# パターンは cli.js の直後に続く語で判定するため、--mode server/client には一致しない
# (client は cli.js の直後が " --mode client" なので " --mode local"/" --port" にマッチしない)。
stop_existing "vibeboard"          "vibeboard/dist/cli.js"
stop_existing "ai-monitor server"  "ai-monitor/dist/cli.js --mode server"
stop_existing "ai-monitor local(旧)" "ai-monitor/dist/cli.js( --mode local| --port)"

SERVER_PID=""
VIBEBOARD_PID=""

cleanup() {
  trap - EXIT INT TERM
  for pid in "$SERVER_PID" "$VIBEBOARD_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT INT TERM

# 起動順: server → vibeboard。各プロセスの出力は端末表示 + ログファイル追記 (tee) の両立。
node ai-monitor/dist/cli.js --mode server --host "$SERVER_HOST" --port "$SERVER_PORT" \
  > >(tee -a "$LOG_DIR/ai-monitor-server.log") 2>&1 &
SERVER_PID=$!
echo "[start] ai-monitor server pid=$SERVER_PID 待受 http://$SERVER_HOST:$SERVER_PORT" >&2

node vibeboard/dist/cli.js --root . --port "$VIBEBOARD_PORT" \
  > >(tee -a "$LOG_DIR/vibeboard.log") 2>&1 &
VIBEBOARD_PID=$!
echo "[start] vibeboard pid=$VIBEBOARD_PID port=$VIBEBOARD_PORT" >&2

echo "" >&2
echo "[guide] 管理画面: http://127.0.0.1:$VIBEBOARD_PORT  (AI Monitor タブ = 音声つきダッシュボード)" >&2
echo "[guide] 直リンク: http://127.0.0.1:$SERVER_PORT/view?item=dashboard" >&2
echo "[guide] セッションを映すには各端末で ./run-ai-monitor-client.sh を別途起動して push してください (この PC でも必要)" >&2
echo "[guide] 音声: ダッシュボードで 🔊 ON をクリックすると autoplay が解除されます (GEMINI_API_KEY 未設定なら無音)" >&2

wait -n
exit_code=$?
echo "[exit] 片方のプロセスが終了しました (code=$exit_code)。残りを停止します。" >&2
exit "$exit_code"
