# run-ai-monitor.sh に run-voice-server.sh の機能を統合する

## 目的・背景

現状、ローカルで「セッション可視化 + 音声再生」を動かすには複数スクリプトを別々に起動する必要がある。

- `./run-ai-monitor.sh` … vibeboard(8180) + ai-monitor **local**(8181)。**音声 UI なし**。
- `./run-voice-server.sh` … ai-monitor **server**(8190)。ミラー + 音声生成 + 音声 UI。
  server は FS を読まず、client の push を受けて集約・配信する。
- `./run-voice-client.sh` … ai-monitor **client**。この端末の FS を読んで server へ push。

要望:
- `run-ai-monitor.sh` が起動する管理画面(vibeboard)に **voice-server の音声 UI を載せる**。
- `run-voice-server.sh` は `run-ai-monitor.sh` に**統合して廃止**する。
- `run-voice-client.sh` は **今までどおり**(別途起動・無改修・push 先も従来のまま)。

## 確定方針

1. **`run-ai-monitor.sh` = vibeboard + ai-monitor server(voice)**。**client は同梱しない**。
   （旧 local モード単体起動は廃止。run-ai-monitor.sh は「集約 + 表示 + 音声」の viewer 側に徹する）
2. **server の待ち受けポートは `run-voice-server.sh` と同じ `8190` のまま**(`CCM_SERVER_PORT`)。
   → これにより `run-voice-client.sh` は**今までどおり** `:8190` へ push すれば統合 server に届く
   （client の `.env`/設定は無変更）。
3. vibeboard の **AI Monitor タブにその server(voice) ダッシュボードを映す**ため、
   `vibeboard.config.json` の `baseUrl` を **`8181` → `8190`** に変更する。
   （server を 8190 のままにする以上、タブの向き先を 8190 に直すのが client を触らず一致させる唯一の方法）
4. `run-voice-server.sh` は **削除**(ロジックは run-ai-monitor.sh に取り込む)。
5. `run-voice-client.sh` は **無改修**。可視化したい端末（同一マシン含む）で従来どおり別途起動する。

## 構成 (ポート配線)

```
run-ai-monitor.sh が起動:
  vibeboard          :8180  (TODO/plans タブ + AI Monitor タブ)
    └ AI Monitor タブ → :8190  = ai-monitor server(voice) ダッシュボード(音声 UI 入り)
  ai-monitor server  :8190  voice生成(Gemini TTS) + ミラー + 音声UI  ← client が push

別途 (今までどおり・無改修):
  run-voice-client.sh → 各端末の FS を読み http://127.0.0.1:8190 へ push
```

- vibeboard: `VIBEBOARD_PORT` (既定 8180)
- server: `CCM_SERVER_PORT` (既定 8190) / `CCM_SERVER_HOST` (既定 127.0.0.1。`.env` で 0.0.0.0 にすれば LAN 公開)
- 旧 local(8181) は廃止。

## 挙動変更 (重要)

- 既定の `./run-ai-monitor.sh` が「ローカル read-only の local 表示(自端末を単体で表示)」から
  **「server(集約 + 音声) + vibeboard」** に変わる。
- **server は FS を読まない**ので、`run-ai-monitor.sh` だけでは **ダッシュボードのカードは空**。
  セッションを映すには `run-voice-client.sh` を（この端末や他端末で）起動して push する必要がある。
  ← 従来 local は単体で自端末を表示できたが、その用途は無くなる（client を別途起動する運用に統一）。
- server host 既定 127.0.0.1(loopback)。`.env` で 0.0.0.0 にすれば LAN 公開。
  `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` を設定したときだけ外部 AI へ redaction 済み断片を送り音声生成。
  未設定なら音は出ず(テキストのみ)・要約はフォールバック。

## 影響範囲

| ファイル | 変更 |
|---|---|
| `run-ai-monitor.sh` | local 起動を **server(voice) + vibeboard** 起動へ。`run-voice-server.sh` のロジック(ポート/ホスト解決・ingest トークン・キー案内・既存 server 停止)を取り込む。**client / token・URL 注入は持たない** |
| `vibeboard.config.json` | AI Monitor タブ `baseUrl` を **8181 → 8190** |
| `run-voice-server.sh` | **削除** |
| `run-voice-client.sh` | **無改修**(今までどおり) |
| `CLAUDE.md` | run-ai-monitor の役割・動作モード表・スクリプト一覧・音声節・ポート記述を更新。`run-voice-server.sh` 記述を削除 |
| `README.md` | `run-voice-server.sh` への参照(157 行付近)を更新 |
| `ai-monitor/deploy/g3plus/*` | `run-voice-server.sh` への参照があれば更新(grep して確認) |
| `TODO.md` / `DONE.md` / `docs/plans/` | 着手ルールに従い更新・完了時アーカイブ |

ai-monitor 本体(TS)の改修は **不要**(既存の server モード + 既存の voice UI をそのまま使うだけ)。

## 詳細設計 (run-ai-monitor.sh)

基本は現 `run-voice-server.sh`(server 起動) と vibeboard 起動の合成。`run-voice-*.sh` のヘルパ
(`dotenv_get` / ログ tee / stop パターン)を踏襲する。

### 1. ビルド
`build_pkg vibeboard` / `build_pkg ai-monitor` を従来どおり 1 回ずつ(`SKIP_BUILD=1` で省略可)。

### 2. ポート/ホスト解決 (env > .env > 既定)
`dotenv_get` で解決:
- `VIBEBOARD_PORT` (既定 8180)
- `CCM_SERVER_PORT` (既定 8190) … server 待受 = AI Monitor タブが指すポート
- `CCM_SERVER_HOST` (既定 127.0.0.1)

### 3. ingest トークン (server, env > .env > 開発用デフォルト)
`run-voice-server.sh` と同じ: `CCM_INGEST_TOKENS`(旧 `CCM_CLIENT_TOKENS` 後方互換)を解決し、
env にも `.env` にも無ければ開発用デフォルト `localdevtoken1234567890` を export。
**client 系の注入(`CCM_SERVER_URL` / `CCM_CLIENT_TOKEN`)は一切しない**(client は別スクリプトの責務)。

### 4. キー案内
`GEMINI_API_KEY` / `ANTHROPIC_API_KEY` 未設定時は案内ログのみ(注入しない)。

### 5. stop_existing のスコープ
自分が管理するものだけ停止:
- `vibeboard/dist/cli.js`
- `ai-monitor/dist/cli.js --mode server` … 統合 server(8190)の再起動
- `ai-monitor/dist/cli.js( --mode local| --port)` … 旧 local(8181) が残っていれば解放(移行クリーンアップ)

**`run-voice-client.sh` の client(`--mode client`)は止めない**(今までどおり別管理)。

### 6. プロセス管理
node 2 つ(server, vibeboard)を background 起動、PID を 2 つ収集。`cleanup` trap で両方 kill、
`wait -n` でどちらか終了時に全停止。起動順は **server → vibeboard**。

### 7. ログ
`CCM_LOG_DIR`(既定 `<repo>/logs`)に tee で「端末表示 + ファイル追記」。
ファイル: `ai-monitor-server.log` / `vibeboard.log`(client ログは無し)。

### 8. 起動案内
- 管理画面: `http://127.0.0.1:$VIBEBOARD_PORT` (AI Monitor タブ = voice ダッシュボード)
- 直リンク: `http://127.0.0.1:$CCM_SERVER_PORT/view?item=dashboard`
- **セッションを映すには `run-voice-client.sh` を別途起動する**旨を明示
- 音声: 🔊 ON のクリックが autoplay 解除を兼ねる旨、key 未設定時の挙動

## Phase 分割

- **Phase 1**: `run-ai-monitor.sh` を「server(voice) + vibeboard」起動へ改修
  (ポート/ホスト解決・ingest トークン・キー案内・stop_existing・2 プロセス管理・ログ・案内出力)
  ＋ `vibeboard.config.json` の `baseUrl` を 8190 へ変更
- **Phase 2**: `run-voice-server.sh` を削除し、参照(README / CLAUDE / deploy)を grep して整理
- **Phase 3**: `CLAUDE.md` ほかドキュメント更新(run-ai-monitor の役割・モード表・スクリプト一覧・音声節・ポート)
- **Phase 4**: 動作検証(下記)

## テスト方針

- `shellcheck run-ai-monitor.sh` / `bash -n` が通る。
- **キー無しで起動**: `./run-ai-monitor.sh` → vibeboard 8180 / server 8190(dev token)。
  `http://127.0.0.1:8180` の AI Monitor タブに **音声 UI(🔊)** が出る(server ダッシュボード)。
  この時点では client 未起動なのでカードは空。
- **client 連携**: `./run-voice-client.sh` を別途起動 → push が 200(401 でない)、
  client→server ミラー経由でカードが表示される。
- **`CCM_VOICE_TTS_PROVIDER=none`**: UI は出るが無音(テキストのみ)。
- **`GEMINI_API_KEY` 設定時**: 状態遷移で音声が生成・順次再生される。
- **隔離**: `run-voice-client.sh`(別端末/別ポート)を起動した状態で `run-ai-monitor.sh` を
  再起動しても client は生き残る(stop_existing が client を対象にしない)。
- **タブ表示**: `baseUrl` 8190 で AI Monitor タブが server を正しく表示する。

## 完了時の後片付け (着手ルール)

- `TODO.md` の親項目を `DONE.md` へ(完了日 `YYYY-MM-DD`)。
- 本プランを `docs/plans/archive/` へ移動。
- `CLAUDE.md` / `README.md` の整合を最終確認。
