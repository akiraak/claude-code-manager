#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f vibeboard/dist/cli.js ]; then
  echo "vibeboard/dist が見つかりません。先にビルドしてください:" >&2
  echo "  (cd vibeboard && npm install && npm run build)" >&2
  exit 1
fi

if [ ! -f ai-monitor/dist/cli.js ]; then
  echo "ai-monitor/dist が見つかりません。先にビルドしてください:" >&2
  echo "  (cd ai-monitor && npm install && npm run build)" >&2
  exit 1
fi

VIBEBOARD_PORT="${VIBEBOARD_PORT:-8180}"
AI_MONITOR_PORT="${AI_MONITOR_PORT:-8181}"

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

stop_existing "vibeboard"   "vibeboard/dist/cli.js"
stop_existing "ai-monitor"  "ai-monitor/dist/cli.js"

VIBEBOARD_PID=""
AI_MONITOR_PID=""

cleanup() {
  trap - EXIT INT TERM
  for pid in "$VIBEBOARD_PID" "$AI_MONITOR_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT INT TERM

node ai-monitor/dist/cli.js --port "$AI_MONITOR_PORT" &
AI_MONITOR_PID=$!
echo "[start] ai-monitor pid=$AI_MONITOR_PID port=$AI_MONITOR_PORT" >&2

node vibeboard/dist/cli.js --root . --port "$VIBEBOARD_PORT" &
VIBEBOARD_PID=$!
echo "[start] vibeboard  pid=$VIBEBOARD_PID port=$VIBEBOARD_PORT" >&2

wait -n
exit_code=$?
echo "[exit] 片方のプロセスが終了しました (code=$exit_code)。残りを停止します。" >&2
exit "$exit_code"
