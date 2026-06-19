# Phase 7: デプロイ & 公開（g3plus + Cloudflare Tunnel）

親プラン: [claude-progress-voice.md](claude-progress-voice.md)
前フェーズ: [phase6](claude-progress-voice-phase6.md)（Web UI 再生 + ミラー表示）

Phase 7 のゴールは「`--mode server` を g3plus 上の Docker コンテナで動かし、Cloudflare Tunnel
（`ccm.chobi.me`）で公開、UI に Cloudflare Access（email OTP）/ ingest は Bypass を掛ける」ための
**デプロイ成果物 + 手順書** を用意すること。

## スコープ方針（重要）

g3plus サーバ操作と Cloudflare（Tunnel / Access）設定は **ユーザーが実施する**（インフラはユーザー担当）。
本フェーズで Claude が行うのは **デプロイ成果物（Dockerfile / docker-compose.yml / .env.example / .dockerignore）と
手順書（runbook）の作成まで**。実際の scp・`docker compose`・Cloudflare ダッシュボード操作は代行しない。

成果物は **このリポ内 `ai-monitor/deploy/g3plus/`** に置く（アプリと同じ git で版管理）。
ユーザーは runbook に従い `g3plus-ops/ai-monitor/` へコピーし、g3plus 上で起動 + Cloudflare を設定する。
（`.dockerignore` だけはビルドコンテキスト root = リポジトリ直下に置く必要があるので例外的にリポ直下。）

## 前提・調査結果（g3plus-ops の確立パターン準拠）

- Node 先例: `g3plus-ops/photorans`（Express+TS, multi-stage `node:20-alpine`, `npm ci` → `tsc` → `npm ci --omit=dev`）。
- compose は `build.context` = アプリリポ位置 / `dockerfile` = ops 側絶対パス / `container_name` / `restart: unless-stopped` /
  `env_file: ./.env` / `networks: [n8n_default]`（`external: true`）/ json-file ログローテ。
- 共有ネットワーク `n8n_default` は外部定義済み。Cloudflare Tunnel（`g3plus`, ドメイン `chobi.me`）が `http://<container>:<port>` に解決。

### コードが実際に読む env（src の `process.env` 実走査で確定）
| env | 必須 | 用途 / 既定 |
|---|---|---|
| `CCM_CLIENT_TOKENS` | **必須** | ingest の端末別 Bearer（カンマ区切り・各 16 文字以上）。未設定/短すぎは **起動失敗**（fail-fast）|
| `CCM_CORS_ORIGIN` | 任意 | ブラウザ UI の許可オリジン（カンマ区切り）。未設定なら CORS ヘッダ無し |
| `ANTHROPIC_API_KEY` | 任意 | ペルソナ短文（ちょビ）+ カード要約。未設定は fallback テンプレ |
| `GEMINI_API_KEY` | 任意 | TTS。未設定は音声なし（テキストのみ utterance）|
| `GEMINI_TTS_MODEL` | 任意 | 既定 `gemini-2.5-flash-preview-tts` |
| `CCM_VOICE_TTS_PROVIDER` | 任意 | `gemini`（既定）/ `none` |

- コードは `CF_ACCESS_*` を読まない → Cloudflare Access はインフラ層（Tunnel + Zero Trust）だけで完結（アプリ改修不要）。

### コンテナ化の要点
- ネイティブモジュール無し（express/dotenv/@anthropic-ai/sdk のみ）→ builder に python3/make/g++ 不要。
- `cli.ts` は `PORT`/`HOST` env を読まず `--port`/`--host` 引数のみ。コンテナは **`--host 0.0.0.0`** 必須（同一 network / Tunnel 到達のため）。CMD で明示。
- `loadPersona` は `__dirname/../voice-persona.json`（= `/app/ai-monitor/voice-persona.json`）を読む → prod stage に **`voice-persona.json` を COPY** する。
- `dotenv.config({ path: __dirname/../../.env })`（= `/app/.env`）はコンテナに無くて良い（`env_file` が環境変数を直接注入。dotenv はファイル不在でも no-op）。
- 外部ポート開放は不要（CF Tunnel が `http://ai-monitor:8181` に解決）。`ports:` は張らず `expose: 8181` のみ。
- 永続化なし（メモリ + TTL。クライアント再 push で自己回復。永続は将来 opt-in）。

## 成果物（このフェーズで作る）
- `ai-monitor/deploy/g3plus/Dockerfile` — multi-stage `node:20-alpine`。`ai-monitor/` をビルドし dist + prod deps + `voice-persona.json` を prod stage へ。`CMD node dist/cli.js --mode server --host 0.0.0.0 --port 8181`。HEALTHCHECK 付き。
- `ai-monitor/deploy/g3plus/docker-compose.yml` — `container_name: ai-monitor` / `context: /home/ubuntu/claude-code-manager` / `dockerfile: /home/ubuntu/g3plus-ops/ai-monitor/Dockerfile` / `env_file` / `expose: 8181` / `networks: [n8n_default]` / ログローテ。
- `ai-monitor/deploy/g3plus/.env.example` — 上表の env を網羅。トークン生成コマンド込み。
- `ai-monitor/deploy/g3plus/README.md` — runbook（コピー配置 → .env → build/up → Cloudflare Tunnel hostname → Access ポリシー（UI=OTP / ingest=Bypass）→ クライアント設定 → スモーク → ローテ → ロールバック → セキュリティ注意）。
- `.dockerignore`（リポジトリ直下）— `node_modules` / `dist` / `.git` / `vibeboard` / `docs` 等を除外しビルドコンテキストを軽量化。

## 影響範囲
- アプリコード（`ai-monitor/src/*`）は **無改修**（server モードは Phase 2〜6 で完成済み）。
- 追加は deploy 成果物 + `.dockerignore` のみ。`.dockerignore` はビルド時のコンテキスト除外だけで実行に影響しない。
- g3plus-ops リポ・Cloudflare 設定は **本フェーズでは触らない**（ユーザー作業）。

## テスト方針
- **ローカル Docker ビルド検証**（任意・Docker があれば）: `docker build -f ai-monitor/deploy/g3plus/Dockerfile -t ai-monitor:test .` が通り、
  `docker run --rm -e CCM_CLIENT_TOKENS=localtesttoken1234 -p 18181:8181 ai-monitor:test` が server モードで起動し
  `/view?item=dashboard` に voice パネルが出ることを確認。Docker 不在なら手順書にコマンドを残し実走はユーザーに委ねる。
- 成果物の静的検証: compose の YAML 妥当性 / Dockerfile の COPY 対象（voice-persona.json 含む）/ .env.example が全 env を網羅。
- 実 E2E（Cloudflare Tunnel + Access 越し）は **ユーザーがインフラ構築後に実施**（手順書に確認チェックリストを記載）。

## Step 分解
- [x] Step 1: `.dockerignore`（リポ直下）+ `ai-monitor/deploy/g3plus/Dockerfile` + `docker-compose.yml` + `.env.example`
- [x] Step 2: `ai-monitor/deploy/g3plus/README.md`（runbook 一式）
- [x] Step 3: ローカル Docker ビルド検証（可能なら）/ プラン・TODO 更新・ハンドオフ手順の提示

## 実走ログ

### 2026-06-18 成果物作成 + ローカル Docker 実ビルド検証
- 作成: `.dockerignore`（リポ直下）/ `ai-monitor/deploy/g3plus/` に `Dockerfile`・`docker-compose.yml`・`.env.example`・`README.md`。
- アプリコード無改修（server モードは Phase 2〜6 で完成済み）。
- ローカル Docker 28.0.2 で実ビルド + 実行検証（context=リポ直下・`-f ai-monitor/deploy/g3plus/Dockerfile`）:
  - `docker build` 成功（multi-stage・builder で `npm ci`→`tsc`→`npm ci --omit=dev`、prod へ dist+node_modules+package.json+voice-persona.json を COPY）。
  - **fail-fast**: `CCM_CLIENT_TOKENS` 無しで起動 → `server モードには CCM_CLIENT_TOKENS が必要です` で exit 1。
  - **正常起動**: `CCM_CLIENT_TOKENS=...` で `mode: server` / `running at http://0.0.0.0:8181`（0.0.0.0 バインド確認）。
  - `/view?item=dashboard` に `data-voice-bar` / `data-voice-toggle` / `.voice-bar` / `/api/voice/recent.json`（= server モードで voice パネル搭載）。
  - **認証**: `POST /api/ingest/voice-event` Bearer=200 / 認証なし=401。
  - **HEALTHCHECK**: 起動後 `healthy`。
  - 検証後イメージ/コンテナは削除（クリーン）。
- 残（ユーザー作業）: g3plus への clone + 成果物 scp + `.env` 作成 + `docker compose build/up`、Cloudflare Tunnel `ccm.chobi.me` 追加、Access ポリシー（UI=OTP / `/api/ingest/*`=Bypass）、各端末の `--mode client` 設定。手順は README に記載。

## 残課題（Phase 8）
- redaction/保持の最終調整・CLAUDE.md/README 更新・E2E・TODO/DONE 整理・本プラン群の archive は Phase 8。
- 永続化（`data/` ボリューム）opt-in は要望が出たら後追い。
