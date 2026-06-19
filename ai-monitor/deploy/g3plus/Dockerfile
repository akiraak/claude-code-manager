# ai-monitor — `--mode server`（公開アグリゲータ）用イメージ
#
# ビルドコンテキスト: /home/ubuntu/claude-code-manager （アプリリポ直下）
# このファイルの g3plus 上での最終配置: /home/ubuntu/g3plus-ops/ai-monitor/Dockerfile
#   （docker-compose.yml の `dockerfile:` がこの絶対パスを指す）
#
# ネイティブモジュール無し（express / dotenv / @anthropic-ai/sdk のみ）なので
# builder に python3/make/g++ は不要。TTS は Node 20 の global fetch を直叩きする。

FROM node:20-alpine AS builder
WORKDIR /app/ai-monitor

# 依存解決（package-lock.json 準拠の再現ビルド）
COPY ai-monitor/package*.json ./
RUN npm ci

# TypeScript ビルド（tsc → dist/）
COPY ai-monitor/tsconfig.json ./
COPY ai-monitor/src ./src
RUN npm run build

# 本番依存のみへ刈り込む（devDeps: typescript / ts-node / @types を落とす）
RUN npm ci --omit=dev

# --- Production ---
FROM node:20-alpine
WORKDIR /app/ai-monitor

RUN apk add --no-cache tzdata
ENV TZ=Asia/Tokyo

COPY --from=builder /app/ai-monitor/dist ./dist
COPY --from=builder /app/ai-monitor/node_modules ./node_modules
COPY --from=builder /app/ai-monitor/package.json ./package.json
# loadPersona は __dirname/../voice-persona.json（= /app/ai-monitor/voice-persona.json）を読む。
# dist は /app/ai-monitor/dist なので 1 階層上に置く。
COPY ai-monitor/voice-persona.json ./voice-persona.json

EXPOSE 8181

# server モードは 0.0.0.0 にバインドして同一 docker network（n8n_default）/
# Cloudflare Tunnel から到達可能にする。cli.ts は PORT/HOST env を読まず
# --port/--host 引数のみ見るため CMD で明示する。
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:8181/ >/dev/null 2>&1 || exit 1

CMD ["node", "dist/cli.js", "--mode", "server", "--host", "0.0.0.0", "--port", "8181"]
