#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f vibeboard/dist/cli.js ]; then
  echo "vibeboard/dist が見つかりません。先にビルドしてください:" >&2
  echo "  (cd vibeboard && npm install && npm run build)" >&2
  exit 1
fi

port_set=0
for arg in "$@"; do
  case "$arg" in
    --port|--port=*) port_set=1 ;;
  esac
done

if [ "$port_set" -eq 0 ]; then
  set -- --port 8180 "$@"
fi

exec node vibeboard/dist/cli.js --root . "$@"
