#!/usr/bin/env bash
# ai-monitor を server モード (公開アグリゲータ / ミラー + 音声生成) で起動する。
# ローカル動作検証用。run-ai-monitor.sh (local モード) とは別物・別ポート・併存可。
#
# 設定の優先順位:
#   node (cli.ts) が読む設定 … env > リポ直下 .env > 既定。
#     CCM_CLIENT_TOKENS / CCM_CORS_ORIGIN / ANTHROPIC_API_KEY / GEMINI_API_KEY /
#     GEMINI_TTS_MODEL / CCM_VOICE_TTS_PROVIDER。スクリプトは値を上書きせず、env にも
#     .env にも無いときだけトークンの開発用デフォルトを注入する。
#   スクリプト固有の設定 … env > 既定 のみ (.env は読まない。cli.ts は --port/--host
#     引数で受け取り env/.env を参照しないため)。CCM_SERVER_PORT / CCM_SERVER_HOST / SKIP_BUILD。
#
#   CCM_SERVER_PORT   待受ポート (既定 8190・.env 不可)
#   CCM_SERVER_HOST   待受ホスト (既定 127.0.0.1。LAN/Tunnel 公開なら 0.0.0.0・.env 不可)
#   CCM_CLIENT_TOKENS ingest 用 Bearer (必須・カンマ区切り)。env/.env 無しなら開発用デフォルト
#   GEMINI_API_KEY    Gemini TTS キー (未設定なら音は出ずテキストのみ)
#   ANTHROPIC_API_KEY ペルソナ短文用 (未設定なら定型文フォールバック)
#   CCM_VOICE_TTS_PROVIDER  gemini(既定) | none
#   SKIP_BUILD=1      ビルドを省略 (.env 不可)
#   CCM_LOG_DIR       ログ出力先 (既定 <repo>/logs。voice-server.log に tee 追記・.env 不可)
set -euo pipefail
cd "$(dirname "$0")"

PORT="${CCM_SERVER_PORT:-8190}"
HOST="${CCM_SERVER_HOST:-127.0.0.1}"

# --- ログをファイルにも残す (Claude Code から参照できるように) ---
# exec で foreground 実行なので、tee へ流して「ターミナル表示 + ファイル追記」の両立にする。
# 既定 <repo>/logs/voice-server.log。CCM_LOG_DIR で変更可。
LOG_DIR="${CCM_LOG_DIR:-$(pwd)/logs}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/voice-server.log"
exec > >(tee -a "$LOG") 2>&1
echo "===== [$(date '+%F %T')] run-voice-server start  host=$HOST port=$PORT pid=$$ ====="

# --- ビルド (SKIP_BUILD=1 で省略) ---
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  [ -d ai-monitor/node_modules ] || { echo "[build] ai-monitor: npm install" >&2; (cd ai-monitor && npm install); }
  echo "[build] ai-monitor: npm run build" >&2
  (cd ai-monitor && npm run build)
fi

# --- 必須: ingest トークン (env > .env > 開発用デフォルト) ---
# env にも .env にも無いときだけ開発用デフォルトを export する
# (.env にある場合は export せず dotenv に委ねる)。
if [ -z "${CCM_CLIENT_TOKENS:-}" ] && ! grep -qE '^CCM_CLIENT_TOKENS=.+' .env 2>/dev/null; then
  export CCM_CLIENT_TOKENS="localdevtoken1234567890"
  echo "[warn] CCM_CLIENT_TOKENS 未設定 → 開発用デフォルトを使用 (本番不可): $CCM_CLIENT_TOKENS" >&2
  echo "[warn]   本番トークン生成: openssl rand -base64 32 | tr -d '+/=' | head -c 32" >&2
fi

# --- 任意: 音声キーの有無を案内 ---
if [ -z "${GEMINI_API_KEY:-}" ] && ! grep -qE '^GEMINI_API_KEY=.+' .env 2>/dev/null; then
  echo "[info] GEMINI_API_KEY 未設定 → 音声は出ません (テキストのみ)。鳴らすなら .env か env に設定" >&2
fi

# --- 既存 server を停止 (ポート衝突回避。local/client は止めない) ---
pids=$(pgrep -f "ai-monitor/dist/cli.js --mode server" || true)
if [ -n "$pids" ]; then
  echo "[stop] 既存 server を停止: $pids" >&2
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 1
fi

echo "[start] ai-monitor server  待受 http://$HOST:$PORT" >&2
echo "[start]   ダッシュボード(ミラー+音声): http://127.0.0.1:$PORT/view?item=dashboard" >&2
exec node ai-monitor/dist/cli.js --mode server --host "$HOST" --port "$PORT"
