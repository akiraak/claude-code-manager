# ai-monitor server モード — g3plus デプロイ手順 (runbook)

`ai-monitor --mode server`（公開アグリゲータ）を g3plus 上の Docker で動かし、Cloudflare Tunnel で
`https://ccm.chobi.me` として公開するための手順。**g3plus / Cloudflare の操作はユーザーが実施する。**
本ディレクトリ（`ai-monitor/deploy/g3plus/`）の Dockerfile / docker-compose.yml / .env.example が成果物。

> ⚠️ **プライバシー**: server モードは各端末の **transcript 末尾・要約・進捗テキスト** を集約し、
> Cloudflare + g3plus + AI プロバイダ（Anthropic / Gemini）を通過させる。ミラー対象は
> クライアント側 `CCM_MIRROR_PROJECTS` で allowlist 限定すること（下記「クライアント設定」）。

## データフロー

```
端末(WSL2/Mac) ai-monitor --mode client
  └─ Bearer push ─▶ Cloudflare Tunnel (TLS, ccm.chobi.me)
                      └─▶ g3plus: docker ai-monitor :8181 (--mode server)
                            ├─ /api/ingest/*  端末別 Bearer (CCM_CLIENT_TOKENS)
                            ├─ 集約ストア → ミラー描画 + 音声生成 (Haiku→Gemini TTS)
                            └─ /view, /api/voice/*, /api/watch(SSE)
  ブラウザ ◀── Cloudflare Access (email OTP) ── UI / 音声再生
```

## URL 構成

| 種別 | パス | Cloudflare Access |
|---|---|---|
| UI（ダッシュボード/ミラー/音声） | `https://ccm.chobi.me/view?item=dashboard` ほか | **email OTP**（要認証） |
| 音声バイト | `https://ccm.chobi.me/api/voice/audio/:id` | OTP 配下 + 推測困難 id |
| SSE | `https://ccm.chobi.me/api/watch` | OTP 配下 |
| ingest（端末→サーバ） | `https://ccm.chobi.me/api/ingest/*` | **Bypass**（アプリの Bearer が gate） |

## 前提

- g3plus: `ssh -i /home/ubuntu/.ssh/id_rsa_nopass ubuntu@g3plus.lan`（10.0.1.10）。
- 共有ネットワーク `n8n_default`（external）と `cloudflared` コンテナが既に稼働（他サービスと同様）。
- アプリリポ `claude-code-manager` を g3plus の `/home/ubuntu/claude-code-manager/` に clone 済みにする。

## 初回デプロイ

### 1. アプリリポを g3plus に配置

```bash
ssh -i /home/ubuntu/.ssh/id_rsa_nopass ubuntu@g3plus.lan \
  'git clone <claude-code-manager の origin> /home/ubuntu/claude-code-manager || \
   (cd /home/ubuntu/claude-code-manager && git pull)'
```

### 2. デプロイ成果物を ops 側へ配置

ops リポの慣習に合わせ、Dockerfile / docker-compose.yml / .env.example を
`/home/ubuntu/g3plus-ops/ai-monitor/` に置く（このリポの `ai-monitor/deploy/g3plus/` が原本）。

```bash
# 開発機 (claude-code-manager がある側) から g3plus へ転送する例
DST=ubuntu@g3plus.lan:/home/ubuntu/g3plus-ops/ai-monitor
ssh -i ~/.ssh/id_rsa_nopass ubuntu@g3plus.lan 'mkdir -p /home/ubuntu/g3plus-ops/ai-monitor'
scp -i ~/.ssh/id_rsa_nopass \
  ai-monitor/deploy/g3plus/Dockerfile \
  ai-monitor/deploy/g3plus/docker-compose.yml \
  ai-monitor/deploy/g3plus/.env.example \
  "$DST/"
```

### 3. `.env` を作成（gitignore・サーバ上のみ）

```bash
ssh -i ~/.ssh/id_rsa_nopass ubuntu@g3plus.lan
cd /home/ubuntu/g3plus-ops/ai-monitor
cp .env.example .env

# 端末ごとに ingest トークンを生成（16 文字以上の URL-safe）
openssl rand -base64 32 | tr -d '+/=' | head -c 32 ; echo   # → CCM_CLIENT_TOKENS に追記
# CCM_CLIENT_TOKENS=tok_wsl2_xxxx,tok_mac_yyyy のようにカンマ区切りで複数
# ANTHROPIC_API_KEY / GEMINI_API_KEY も .env に設定（音声を出すなら必須級）
nano .env
```

`CCM_CLIENT_TOKENS` 未設定 / 16 文字未満が混じると **起動が exit 1**（fail-fast）。

### 4. ビルド & 起動

```bash
cd /home/ubuntu/g3plus-ops/ai-monitor
docker compose build --no-cache
docker compose down
docker compose up -d
docker logs ai-monitor --tail 30
```

期待ログ:
```
[ai-monitor] mode: server (ingest tokens: N, CORS origins: M)
[ai-monitor] voice: persona=haiku (ちょビ), tts=gemini|gemini-2.5-flash-preview-tts|Leda
[ai-monitor] running at http://0.0.0.0:8181
```
（`ANTHROPIC_API_KEY` 未設定なら `persona=fallback`、`GEMINI_API_KEY` 未設定なら `tts=none`）

### 5. Cloudflare Tunnel に public hostname を追加（ユーザー作業）

Zero Trust → Networks → Tunnels → `g3plus` → Public Hostname に追加:

| 項目 | 値 |
|---|---|
| Subdomain | `ccm` |
| Domain | `chobi.me` |
| Service | `HTTP` → `http://ai-monitor:8181` |

`cloudflared` コンテナが `n8n_default` に居て `ai-monitor` を名前解決できること（他サービスと同様）。

### 6. Cloudflare Access ポリシー（ユーザー作業）

Zero Trust → Access → Applications で `ccm.chobi.me` をカバーする。

- **UI 全体**（`/`・`/view`・`/api/dashboard.json`・`/api/process.json`・`/api/voice/*`・`/api/watch`・`/api/summarize`）
  → **Allow / email OTP**（自分の email のみ許可）。
- **ingest だけ Bypass**: パス `/api/ingest/*`（または `/api/ingest`）に **Bypass（Everyone）** の Include を、
  UI ポリシーより**優先順位を上**にして追加。理由: 端末はマシン送信で OTP を踏めない。
  ingest は **アプリの Bearer（`CCM_CLIENT_TOKENS`）が本当の gate** なので Bypass で安全。

> Access を分けるのが難しい場合は、`ccm-ingest.chobi.me`（Bypass）と `ccm.chobi.me`（OTP）の
> 2 ホスト名に分割し、どちらも `http://ai-monitor:8181` に向ける方式でもよい。その場合クライアントの
> `CCM_SERVER_URL` は ingest 用ホストを指す。

## クライアント（端末）設定

各端末で `ai-monitor --mode client` を動かす。env（または `~/.config/ccm/client.json` 相当の環境変数）:

```bash
export CCM_SERVER_URL=https://ccm.chobi.me     # ingest を Bypass で分けたならそのホスト
export CCM_CLIENT_TOKEN=tok_wsl2_xxxx          # サーバ .env の CCM_CLIENT_TOKENS の 1 つと一致
export CCM_CLIENT_LABEL=wsl2-main              # 省略時は hostname
export CCM_MIRROR_PROJECTS=claude-code-manager,my-proj   # ★ミラー対象 allowlist（プライバシー）
# 動作確認だけなら送信せずログのみ:
# export CCM_DRYRUN=1
ai-monitor --mode client
```

`CCM_SERVER_URL` 未設定 / `CCM_CLIENT_TOKEN` 16 文字未満は client 起動が exit 1（dryrun を除く）。
チューニング: `CCM_CLIENT_INTERVAL_MS` / `CCM_PROGRESS_AFTER_MS` / `CCM_PROGRESS_EVERY_MS`。

## スモーク確認チェックリスト

```bash
# 1) ingest が通る（Bypass + Bearer）
curl -s -X POST https://ccm.chobi.me/api/ingest/voice-event \
  -H "Authorization: Bearer <CCM_CLIENT_TOKENS の1つ>" -H "Content-Type: application/json" \
  -d '{"clientId":"smoke","projectDir":"-x","projectName":"smoke","kind":"completed"}'
# → {"ok":true}

# 2) 認証なしの ingest は弾かれる
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://ccm.chobi.me/api/ingest/voice-event \
  -H "Content-Type: application/json" -d '{}'   # → 401
```
- [ ] ブラウザで `https://ccm.chobi.me/view?item=dashboard` → Cloudflare の email OTP を踏む
- [ ] ダッシュボード上部に **ボイスバー**（🔊 ON/OFF・音量・フィルタ・履歴）が出る
- [ ] 🔊 を ON → 端末で実際に Claude を完了/承認待ちにすると **音声が順次再生**される
- [ ] 「履歴」を開き、過去発話の「再生」で再再生できる
- [ ] 端末フィルタに各 `CCM_CLIENT_LABEL` が現れ、絞り込める

## アプリコード更新（通常フロー）

```bash
ssh -i ~/.ssh/id_rsa_nopass ubuntu@g3plus.lan
cd /home/ubuntu/claude-code-manager && git pull
cd /home/ubuntu/g3plus-ops/ai-monitor
docker compose build --no-cache && docker compose up -d
docker logs ai-monitor --tail 30
```

## デプロイ設定の更新（compose / Dockerfile / .env）

```bash
# compose / Dockerfile を変えたとき: 原本 (このリポ) を編集 → scp で再配置 → 再ビルド
scp -i ~/.ssh/id_rsa_nopass ai-monitor/deploy/g3plus/{Dockerfile,docker-compose.yml} \
  ubuntu@g3plus.lan:/home/ubuntu/g3plus-ops/ai-monitor/
# .env を変えたとき: サーバ上で直接編集（git 管理外）
# 反映（.env のみの変更でも up -d で再生成される）
ssh -i ~/.ssh/id_rsa_nopass ubuntu@g3plus.lan \
  'cd /home/ubuntu/g3plus-ops/ai-monitor && docker compose up -d --build && docker logs ai-monitor --tail 20'
```

## トークンローテーション

```bash
# 1) 新トークン生成
openssl rand -base64 32 | tr -d '+/=' | head -c 32 ; echo
# 2) サーバ .env の CCM_CLIENT_TOKENS を差し替え（移行期間は新旧併記でカンマ区切り可）
# 3) docker compose up -d で再注入（env_file 読み直し）
# 4) 各端末の CCM_CLIENT_TOKEN を新値に更新
# 5) 移行完了後、旧トークンを .env から削除して再 up -d
```

## ロールバック

```bash
cd /home/ubuntu/claude-code-manager && git checkout <前のタグ/コミット>
cd /home/ubuntu/g3plus-ops/ai-monitor && docker compose build --no-cache && docker compose up -d
# 設定だけ戻すなら g3plus-ops を該当コミットへ戻して scp/再ビルド
```

## セキュリティ / 運用メモ

- **永続化なし**（メモリ + TTL）。再起動でミラー/発話履歴は消える → 各端末の client が再 push して自己回復。
- 音声・要約は **イベントごとに Haiku + Gemini 課金**。dedup / クールダウン / キャッシュは実装済みだが、
  多数同時セッションでは `CCM_VOICE_TTS_PROVIDER=none` で音声を止める運用も可。
- `CCM_CORS_ORIGIN` は公開ドメインのみに限定（既定 `.env.example` は `https://ccm.chobi.me`）。
- ホスト :8181 は開けない（CF Tunnel が docker network 経由で解決）。外部から直接コンテナに到達させない。

## ディレクトリ構成

```
claude-code-manager/                      # アプリリポ（context）
  ai-monitor/
    src/ … dist/ … voice-persona.json
    deploy/g3plus/                        # ★成果物の原本（このディレクトリ）
      Dockerfile  docker-compose.yml  .env.example  README.md
  .dockerignore                           # ビルドコンテキスト軽量化（リポ直下）

g3plus-ops/ai-monitor/                    # ★ g3plus 上の配置先
  Dockerfile  docker-compose.yml  .env(.example)
```

## 関連

- 親プラン: `docs/plans/archive/claude-progress-voice.md`（§D デプロイ）
- 本フェーズ計画: `docs/plans/archive/claude-progress-voice-phase7.md`
- 先例: `g3plus-ops/docs/workflows/photorans.md`（scp 転送 / Tunnel / fail-fast 流儀）
