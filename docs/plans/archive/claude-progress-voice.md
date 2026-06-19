# Claude の進捗状況を音声でしゃべる機能（インターネット公開・push 型）

## 目的・背景

複数の Claude Code CLI を同時に走らせていると、どのセッションが「完了したか」「承認待ちで止まっているか」「まだ長時間走っているか」が画面を見ないと分からない。本機能は、各 CLI の進捗イベントを **音声で読み上げ**、かつ **どこからでもブラウザで状況を確認** できるようにする。

参考実装 `~/ai-twitch-cast`（Claude Code hook → Python サーバ → Gemini TTS → C# Windows アプリで再生。Twitch 配信系と密結合で重い）を土台に、配信系を全部そぎ落とし、claude-code-manager の既存検出ロジックを再利用した軽量・インターネット公開版を作る。

## ユーザー確定事項（要件）

ヒアリング（2026-06-18）+ 既存リポ調査で全項目確定:

1. **配信アーキテクチャ**: 複数端末（WSL2 / Mac）がクライアントを動かし内容を中央サーバへ送信。サーバが AI で音声生成。**ブラウザで再生**（現行 UI を拡張）。Windows ネイティブアプリ不要。
2. **読み上げ内容**: **キャラ口調ペルソナ**（ai-twitch-cast の「ちょビ」を流用、声・スタイルも流用）
3. **発話タイミング**: **完了報告 (Stop)** / **承認待ち (Permission/Ask)** / **長時間実行の途中経過**（指示受信では発話しないがタイマー起動に使う）
4. **サーバはインターネット公開**:
   - 公開サーバの役割 = **ダッシュボードもミラー**（クライアントが状態スナップショット = transcript 末尾/要約含む も push）
   - 認証 = **端末別トークン + UI ログイン**
   - 公開/TLS = **Cloudflare Tunnel**

### 調査で確定した技術選定

| 項目 | 確定内容 | 根拠 |
|---|---|---|
| #1 TTS | **Gemini TTS**（`google-genai` SDK, `client.models.generate_content` + `SpeechConfig`/`PrebuiltVoiceConfig`）。モデルは `GEMINI_TTS_MODEL`（既定 `gemini-2.5-flash-preview-tts`、本番は `gemini-2.5-pro-preview-tts`）。出力 **WAV 16-bit mono 24kHz**。スタイルは自然言語前置 `f"{style}: {本文}"`。要 `GEMINI_API_KEY` | `ai-twitch-cast/src/tts.py:118,136-172`、`src/gemini_client.py` |
| #5 ペルソナ「ちょビ」 | **声** `tts_voice="Leda"` / **スタイル** `終始にこにこしているような、柔らかく楽しげなトーンで読み上げてください` / **system_prompt**（Twitch 配信者ちょビ・好奇心旺盛・ツッコミ気質・照れ屋・AI を隠さない・落ち着いたトーン）/ **rules**（「コメントありがとう」で始めない・感嘆符は1文最大1個・荒らしは軽くスルー） | `ai-twitch-cast/src/character_manager.py:11-102`（`DEFAULT_CHARACTER`） |
| #2 サーバホスト | **既存 g3plus 自宅サーバ**（Ubuntu 24.04 / `g3plus.lan` `10.0.1.10`）に **Docker + docker-compose** で追加。共有ネットワーク `n8n_default`。**Cloudflare Tunnel（`g3plus`, ドメイン `chobi.me`）で公開**。Node 先例: cooking-basket（Express+TS, :3002）, photorans（:3004） | `g3plus-ops/CLAUDE.md`, `g3plus-ops/<svc>/docker-compose.yml`, `docs/workflows/*` |
| #3 トークン運用 | secrets = **per-service `.env`**（gitignore, `.env.example` 追跡, `env_file:` で注入。SOPS/Vault 等なし）。**UI 認証 = Cloudflare Access（email OTP）**（既存 autopilot/basket admin と同方式）。**端末別トークン = `.env` の `CCM_CLIENT_TOKENS`（カンマ区切り）を `Authorization: Bearer` 検証**（photorans `URL_SECRET` の fail-fast 流儀）。生成 `openssl rand -base64 32` | `g3plus-ops/*/.env.example`, `docs/workflows/photorans.md` |
| #4 永続化 | **メモリのみ（既定）**。g3plus は plain `.env`（鍵管理機構なし・同一ホスト）なので暗号化永続の旨味が薄く、ライブ状態はクライアントが再 push して自己回復。履歴が要れば後追いで `data/` ボリューム永続を opt-in | 本プラン #4 説明 + `g3plus-ops` 慣習 |

## 核心の設計転換（pull → push）

現行 ai-monitor は **サーバがローカル `~/.claude/projects/*/*.jsonl` と `/proc` を pull** する。公開サーバ（g3plus 上のコンテナ）はリモート端末のローカル FS を読めないため、データの流れを反転する:

- **各端末（クライアント）で既存検出ロジック（`state.ts`/`transcript.ts`/`awaiting-input.ts`）を動かし**、状態と直近イベントを算出。
- クライアントが **スナップショットを push**（ミラー用）+ **状態遷移時に音声イベントを push**（発話用）。
- 公開サーバは **集約ストア**（client × session, メモリ TTL）に貯め、`views.ts` の描画をそのまま使ってミラー配信 + 音声生成・配信。

### ai-monitor のモード化（後方互換）
- `--mode local`（既定・現行どおり）: ローカル FS pull + loopback 配信。**変更なし**。
- `--mode client`: ローカル FS pull + 公開サーバへ uplink push。
- `--mode server`: 公開アグリゲータ。認証 + ingestion + 集約ストアから配信。g3plus 上で Docker 稼働、Cloudflare Tunnel 公開。

## 全体アーキテクチャ

```
[クライアント端末: WSL2 / Mac ... 各マシン]  ai-monitor --mode client
  既存検出（state.ts / transcript.ts / awaiting-input.ts）でローカル FS を読み状態算出
  Claude Code hook（ccm-awaiting-marker.py 等）が低レイテンシ marker を提供（既存）
  uplink: 変化時 + 定期に HTTPS + 端末別 Bearer で push
    ├─ POST /api/ingest/snapshot     状態スナップショット（ミラー用）
    └─ POST /api/ingest/voice-event  状態遷移イベント（完了/承認待ち/途中経過）
    │
    ▼  ── Cloudflare Tunnel（TLS 終端・ホスト非露出, ccm.chobi.me）──
    ▼
[中央サーバ: g3plus 上の Docker コンテナ  ai-monitor --mode server]
  認証: /api/ingest/* は Bearer トークン（CCM_CLIENT_TOKENS, fail-fast）
        UI/閲覧系は Cloudflare Access（email OTP）+ CORS をオリジン限定
  Ingestion: 検証・dedup・レート制限 → 集約ストア（client×session, メモリ TTL）
  音声: detail → ペルソナ文（Anthropic Haiku, ちょビ口調）→ Gemini TTS（Leda/style 前置, WAV24k）→ utterance ストア
  配信:
    ├─ GET /view, /api/dashboard.json   集約ストアから views.ts で描画（ミラー）
    ├─ GET /api/voice/audio/:id         音声バイト
    └─ GET /api/watch (SSE)             sidebar / item-changed / voice-utterance（push 駆動）
    │
    ▼
[ブラウザ: どこからでも（Cloudflare Access 認証後）]
  ダッシュボード（ミラー）+ ボイス再生
  SSE → 有効 & フィルタ通過なら再生キュー → /api/voice/audio/:id → 順次再生
  コントロール: 🔊 ON/OFF（autoplay 解除兼）, 音量, 端末/種別フィルタ, 発話履歴
```

### ai-twitch-cast からの改善ポイント
- **ブラウザ再生**で C# Windows ネイティブアプリ廃止。WSL2 オーディオ依存を排除。
- **既存検出・描画ロジック再利用**（state/transcript/awaiting-input/views/summarize/SSE）。
- **マルチクライアント**: `clientId` + `projectDir/sessionId` で横断集約（本プロジェクトの主目的）。
- **配信系の全削除**（アバター・リップシンク・授業・チャット投稿）。`event → ペルソナ短文 → TTS → 再生` の最小フロー。
- **既存インフラに相乗り**: g3plus の Docker + Cloudflare Tunnel + `.env` + Cloudflare Access という確立運用にそのまま乗る（新規インフラ・新規認証機構を作らない）。

## コンポーネント詳細

### A. クライアント（`ai-monitor --mode client` + hook）
- 既存検出（`classifyV2` 等）で現状と同じ `entryToDashboardCardData` / `buildProcessViewData` 相当のスナップショットを作る。
- **uplink モジュール**（新規 `ai-monitor/src/uplink.ts`）:
  - 変化検出（既存 `snapshotFingerprint` 流用）+ 定期で `POST /api/ingest/snapshot`
  - 状態遷移（待機→AI処理中=開始 / →入力待ち=承認待ち / →停止・通常終了=完了 / 長時間継続=途中経過）で `POST /api/ingest/voice-event`
  - HTTPS + 端末別 Bearer。サーバ未到達時はリトライ/バックオフ + ローカルバッファ（落とさない）
- **設定**（env / `~/.config/ccm/client.json`）: `CCM_SERVER_URL`（`https://ccm.chobi.me`）, `CCM_CLIENT_TOKEN`, `CCM_CLIENT_LABEL`（既定 hostname）, `CCM_MIRROR_PROJECTS`（ミラー対象 allowlist）, `CCM_DRYRUN`。
- **hook**: 既存 `~/.claude/hooks/ccm-awaiting-marker.py` を活かす。低レイテンシ化に Stop hook で marker を置く程度を任意追加。送信本体は uplink。WSL2 / macOS 両対応。

### B. 中央サーバ（`ai-monitor --mode server`）
配置: `ai-monitor/src/server/`（既存 `server.ts` をモード分岐 or 分割）。
- **認証**（新規 `auth.ts`）:
  - `/api/ingest/*` = `Authorization: Bearer` を `CCM_CLIENT_TOKENS`（`.env` カンマ区切り）と照合。未設定/短すぎは fail-fast 起動拒否（photorans `URL_SECRET` 流儀）。※マシン送信なので CF Access はかけない（OTP 不可なため）。
  - UI/閲覧系（`/view`, `/api/dashboard.json`, `/api/process.json`, `/api/voice/audio/:id`, `/api/watch`）= **Cloudflare Access（email OTP）** を Zero Trust ダッシュボードで `ccm.chobi.me` に設定。アプリ側は任意で `CF_ACCESS_AUD`/`CF_ACCESS_TEAM_DOMAIN` 検証ミドルウェアを足す（cooking-basket admin と同方式）。`/api/ingest/*` は Access の Bypass/別ポリシーにする。
  - CORS を UI オリジン限定（`*` をやめる）。
- **Ingestion**（新規 `ingest.ts`）: `POST /api/ingest/snapshot` / `POST /api/ingest/voice-event`。検証・payload 上限・dedup・種別別クールダウン・レート制限。
- **集約ストア**（新規 `store.ts`）: `clientId × (projectDir/sessionId)` → 最新スナップショット + 直近音声イベント。メモリ + TTL（停止後は既存仕様に倣い 24h）。
- **配信**: 既存 `views.ts` / `/api/dashboard.json` / `/view` を、`buildEntries`（ローカル FS）の代わりに **集約ストアを読む実装**へ差し替え（データソース抽象化）。描画は無改造で再利用。
- **SSE**: 既存 `/api/watch` を push 駆動に。ingestion 到着でリスナ通知。`voice-utterance` 追加。
- **音声パイプライン**:
  - `persona.ts`: Anthropic Haiku で detail → ちょビ口調短文（〜50 字目安・projectName 込み・「コメントありがとう」で始めない等の rules 適用）。`summarize.ts` の Anthropic 利用パターン踏襲。`text→hash` キャッシュ。
  - `tts.ts`: `interface TtsProvider { synthesize(text): Promise<{bytes, mime}> }`。**既定 = Gemini**（`google-genai`, `gemini-2.5-flash-preview-tts`, voice `Leda`, style 前置, WAV24k）。`CCM_VOICE_TTS_PROVIDER` で差替可能。`hash(text+voice)→bytes` キャッシュ。
  - `voice/store.ts`: utterance（`id→{bytes, mime, text, meta}`, TTL）。`GET /api/voice/audio/:id`。
  - ブラウザ互換: WAV24k は HTML5 で再生可。帯域/iOS 互換が要れば mp3/opus 変換を検討。
- **ペルソナ設定ファイル**（`ai-monitor/voice-persona.json`）: ちょビの system_prompt / rules / tts_voice(Leda) / tts_style を移植し編集可能化（DB ではなく JSON で持つ）。

### C. Web UI（ブラウザ・どこからでも）
配置: `ai-monitor/src/views.ts` + ダッシュボード client JS。
- 認証は Cloudflare Access（アプリ側ログイン画面は不要 = ホームグロウンの password/session を作らない）。
- ミラーされたダッシュボード（pushed snapshot ベース、既存カード UI 流用）。
- ボイスコントロール: 🔊 ON/OFF（localStorage 永続・autoplay 解除兼）, 音量, フィルタ（端末/種別）, 「最近の発話」履歴 + 再再生。
- SSE → 有効 & フィルタ通過なら再生キュー → `/api/voice/audio/:id`（credentials 付き fetch）→ `HTMLAudioElement` で **順次** 再生（同時再生しない・古すぎる発話はスキップ）。

### D. デプロイ（g3plus + Cloudflare Tunnel）
g3plus-ops の確立パターンに準拠:
- **ops ディレクトリ** `/home/ubuntu/g3plus-ops/ai-monitor/` に `docker-compose.yml` + `Dockerfile`（multi-stage `node:20-alpine`, `npm ci`, TS ビルド, prod 依存）+ `.env`（gitignore）+ `.env.example`（追跡）。
- **アプリコード** はこのリポ（`claude-code-manager`）を g3plus の `/home/ubuntu/claude-code-manager/` に clone。ビルド対象は `ai-monitor/`。compose は `build.context` をアプリ位置、`dockerfile` を ops 側の絶対パスに。
- **compose**: `container_name: ai-monitor`, `restart: unless-stopped`, `env_file: ./.env`, `networks: [n8n_default]`（`external: true`）, port は内部 8181（CF Tunnel がホスト名→コンテナ:port を解決するので外部ポート開放不要）。
- **Cloudflare Tunnel**: Zero Trust → Tunnels → `g3plus` → Public Hostname に `ccm`（ドメイン `chobi.me`）→ `HTTP http://ai-monitor:8181` を追加。UI 側に Cloudflare Access（email OTP）ポリシー、`/api/ingest/*` は Bypass。
- **デプロイ**: scp（`~/.ssh/id_rsa_nopass` で `ubuntu@g3plus.lan`）で compose/Dockerfile/.env を配置 → `docker compose build --no-cache && docker compose down && docker compose up -d` → `docker logs ai-monitor --tail 30`。CI なし（手動・文書化）。
- `.env`（server）: `CCM_CLIENT_TOKENS`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GEMINI_TTS_MODEL`, `CCM_VOICE_TTS_PROVIDER`, `CF_ACCESS_AUD`/`CF_ACCESS_TEAM_DOMAIN`（任意）, `CCM_CORS_ORIGIN`, クールダウン値。

## 影響範囲

- **ai-monitor の前提（読み取り専用・loopback・CORS `*`・書き込み API なし）の見直し**: `--mode server` は公開・認証付き・ingestion あり。CLAUDE.md を「server モード = 公開アグリゲータ」「client/local モード = ローカル FS に read-only」と書き分ける。
- **データソース抽象化**: `buildEntries({ summarizer })` を local 実装 / remote（集約ストア）実装に分離。`views.ts` 描画は無改造で両対応。
- **既存 `/api/watch` SSE**: `voice-utterance` 追加（既存クライアントは未知イベント無視 → 後方互換）。push 駆動化。
- **新規依存**: `google-genai` 相当の Gemini 呼び出し（HTTP 直叩きで回避できれば追加しない）。Cloudflare Access 検証は任意でヘッダ確認のみ。
- **g3plus-ops 側の追加物**: 新サービス用ディレクトリ・compose・Dockerfile・.env・Tunnel public hostname・workflow ドキュメント。
- **vibeboard customTabs**: ローカルは `--mode local` 従来どおり。公開 UI は別ブラウザ or `baseUrl` を `https://ccm.chobi.me` に。

## セキュリティ / プライバシー / コスト

- **トランスポート**: Cloudflare Tunnel が TLS 終端、ホスト非露出。平文 HTTP を受けない。
- **認証**: ingestion = 端末別 Bearer（失効・ローテーション可・fail-fast）。UI = Cloudflare Access（email OTP）。`/api/voice/audio/:id` も Access 配下 + 推測困難 id。
- **CORS**: UI オリジン限定。
- **秘匿情報（ミラーで露出増）**: スナップショットに transcript 末尾・要約が含まれ、Cloudflare + g3plus + AI プロバイダ（Anthropic/Gemini）を通過。
  - **対象プロジェクト allowlist**（`CCM_MIRROR_PROJECTS`）でミラー範囲を限定。
  - redaction パス（明らかな秘匿パターンのマスク）+ サイズ上限。
  - 音声 detail は tool 名/入力を送らず短く切り詰め。
  - 「セッション内容が外部を通過する」ことを README/CLAUDE.md に明記。
- **保持**: 既定はメモリ + TTL のみ（再起動で消える・クライアント再 push で自己回復）。永続化は opt-in（`data/` ボリューム）。
- **濫用/DoS**: payload 上限・レート制限・dedup・クールダウン。Tunnel + Access で攻撃面縮小。
- **コスト**: イベントごとに ペルソナ LLM（Haiku）+ Gemini TTS。複数セッション同時で乱発 → dedup・クールダウン・キャッシュ必須。

## テスト方針

- **サーバ単体**（`node --test` + ts-node, 既存 `src/**/*.test.ts` 形式）:
  - `auth`: Bearer 受理/拒否・fail-fast、（任意）CF Access ヘッダ検証
  - `ingest`: 検証・dedup・クールダウン・レート制限・payload 上限
  - `store`: 集約 TTL、スナップショット → `views.ts` 描画
  - `persona`: プロンプト組み立て（純関数、LLM はモック）。ちょビ rules 反映
  - `tts`: フェイクプロバイダで `synthesize` + キャッシュ。Gemini 実装はモック
  - `voice/store`: TTL + `/api/voice/audio/:id`
  - SSE: `voice-utterance` payload 形 + push 駆動通知
- **クライアント uplink**: payload 構築、サーバ未到達時のリトライ/バックオフで落ちない、`CCM_DRYRUN` で送信内容検証。
- **手動 E2E**: WSL2（+ Mac）→ Cloudflare Tunnel（`ccm.chobi.me`）→ g3plus サーバ → 別ブラウザで Access 認証 → ミラー表示と 完了/承認待ち/途中経過 の順次再生を確認。

## Phase / Step 分解

- **Phase 1: 設計確定 & 基盤 PoC**
  - データソース抽象化（local pull / remote push）の設計
  - g3plus に最小 Docker サービス + Cloudflare Tunnel `ccm.chobi.me` 疎通 PoC（TLS + Access + Bypass の確認）
  - Gemini TTS（`google-genai`, Leda）で WAV 生成 → ブラウザ再生 PoC（Access 配下の認証付き fetch + autoplay）
  - 秘匿情報の扱い（allowlist / redaction / サイズ上限）と保持方針（メモリ TTL）確定
- **Phase 2: サーバ — 認証 + Ingestion 基盤**
  - 認証（`/api/ingest/*` の Bearer・fail-fast / UI 側 CF Access 前提）、CORS オリジン限定
  - `POST /api/ingest/snapshot` / `POST /api/ingest/voice-event`、集約ストア（client×session, TTL）
  - 検証・dedup・レート制限・payload 上限
- **Phase 3: サーバ — ダッシュボードミラー配信**
  - 集約ストアを `views.ts` / `/api/dashboard.json` / `/view` に接続（`buildEntries` の remote 実装）
  - SSE `/api/watch` を push 駆動化
- **Phase 4: クライアント — uplink エージェント**
  - `--mode client`: 既存検出を再利用しスナップショット + 音声イベントを push
  - 設定（server URL / token / label / allowlist）、HTTPS 送信、リトライ/バッファ、`CCM_DRYRUN`
  - WSL2 / Mac 両対応、既存 hook 共存
- **Phase 5: ペルソナ文生成 + TTS**
  - Anthropic Haiku で event → ちょビ口調短文、`voice-persona.json` 化、キャッシュ
  - Gemini TTS 実装（`synthesize` 抽象の既定）+ キャッシュ、utterance ストア + `GET /api/voice/audio/:id`
- **Phase 6: Web UI 再生 + ミラー表示**
  - ボイスコントロール（ON/OFF・音量・フィルタ・履歴）、SSE 受信 → 順次再生、ミラー表示
- **Phase 7: デプロイ & 公開（g3plus）**
  - `g3plus-ops/ai-monitor/` の compose + Dockerfile + .env(.example)、`n8n_default` 接続
  - Cloudflare Tunnel public hostname `ccm.chobi.me` 登録 + Access ポリシー（UI 要 OTP / ingest Bypass）
  - scp + ssh デプロイ手順、`g3plus-ops/docs/workflows/` にドキュメント
- **Phase 8: 仕上げ**
  - redaction/保持の最終調整、CLAUDE.md / README 更新、E2E、TODO/DONE 整理・本プランを `docs/plans/archive/` へ移動

## 残課題（実装中に詰める）

- 公開ホスト名（`ccm.chobi.me` 提案）・内部ポート（8181 提案）・コンテナ名（`ai-monitor` 提案）の最終確定。
- `voice-persona.json` のスキーマ（system_prompt/rules/voice/style + 発話別テンプレ）。
- redaction の対象パターンと allowlist の既定値。
- WAV24k のままか mp3/opus 変換するか（帯域・iOS 互換次第）。
- トークン発行・配布の運用（端末ごとに `openssl rand -base64 32` を `.env` の `CCM_CLIENT_TOKENS` に追記）。

## 補足: スコープ感

ミラー採用により本機能は「音声を足す」から「ai-monitor を **認証付き push 型の公開サービスに作り替える**」規模に拡大。ただし配置・公開・認証・シークレットは **すべて g3plus の既存運用（Docker + Cloudflare Tunnel + Access + `.env`）に相乗り** できるため、インフラ新設は不要。最も重いのは Phase 2〜4（認証 + ingestion + 集約 + uplink）。必要なら段階導入（まず音声/イベントのみ公開、ミラーは後追い）も可能だが、本プランは確定要件どおりミラー込みで設計する。
