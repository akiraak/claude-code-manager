# run-ai-monitor.sh に run-voice-server.sh の機能を統合する

## 目的・背景

現状、ローカルで「セッション可視化 + 音声再生」を一通り動かすには複数のスクリプトを
別々に起動する必要がある。

- `./run-ai-monitor.sh` … vibeboard(8180) + ai-monitor **local**(8181)。**音声 UI なし**。
- `./run-voice-server.sh` … ai-monitor **server**(8190)。ミラー + 音声生成 + 音声 UI。ただし
  server は FS を読まないので、データを映すには **client** が push してくる必要がある。
- `./run-voice-client.sh` … ai-monitor **client**。この端末の FS を読んで server へ push。

ユーザー要望は「`run-ai-monitor.sh` で表示される管理画面に voice server の音声再生機能も
全部含める」「`run-voice-server.sh` は廃止して統合」。

音声 UI は CLAUDE.md のとおり **server モードのダッシュボードにのみ** 載る
(`renderDashboard(opts.voice)`)。よって 1 コマンドで「この端末のセッション + 音声再生」を
1 画面に揃えるには、`run-ai-monitor.sh` が **server(voice)** と **client(自端末 FS を push)** の
両方を起動し、vibeboard の AI Monitor タブ(8181)がその server ダッシュボードを指す構成にする。

## 確定した方針 (ユーザー合意済み)

1. **voice を常に含める**: `run-ai-monitor.sh` は無条件で server(voice) を起動する
   (専用の opt-in フラグは設けない)。
2. **配線は「AI Monitor タブを voice 化」**: server を **8181** で起動し、AI Monitor タブ
   (`vibeboard.config.json` の `baseUrl: http://127.0.0.1:8181`)がそのまま voice ダッシュボード
   になる。`vibeboard.config.json` は変更不要。client は自端末 FS を読んで 8181 へ push する。
3. **`run-voice-server.sh` は削除して統合**: 共通シェル関数化はせず、必要な処理を
   `run-ai-monitor.sh` に取り込む。単体での server-only 起動はできなくなる
   (`run-voice-client.sh` は他端末からの push 用途で **残す**)。

## 最終的な構成 (ポート配線)

```
vibeboard            :8180  (TODO/plans タブ + AI Monitor タブ)
  └ AI Monitor タブ  → :8181  = ai-monitor server (voice) ダッシュボード
ai-monitor server    :8181  voice生成(Gemini TTS) + ミラー + 音声UI  ← client が push
ai-monitor client    :8182  この端末の FS を読み、http://127.0.0.1:8181 へ push
                            (client 自身のローカルダッシュは 8182。普段は見ない)
```

- vibeboard: `VIBEBOARD_PORT` (既定 8180)
- server   : `AI_MONITOR_PORT` (既定 8181。**従来 local が使っていたポートを server が引き継ぐ**)
- client   : `CCM_CLIENT_DASH_PORT` (既定 **8182**。`run-voice-client.sh` の既定 8191 とは別値)

## 影響範囲

| ファイル | 変更 |
|---|---|
| `run-ai-monitor.sh` | local 起動を **server + client** 起動へ。config 解決 / token・URL 注入 / ログ / 3 プロセス管理 / stop_existing スコープ修正 |
| `run-voice-server.sh` | **削除** |
| `vibeboard.config.json` | 変更不要 (baseUrl 8181 のまま server を指す) |
| `CLAUDE.md` | run-ai-monitor の説明・動作モードの記述・スクリプト一覧・音声節を更新。run-voice-server.sh 記述を削除 |
| `ai-monitor/deploy/g3plus/README` 等 | run-voice-server.sh への参照があれば更新 (grep して確認) |
| `TODO.md` / `DONE.md` / `docs/plans/` | 着手ルールに従い更新・完了時アーカイブ |

ai-monitor 本体 (TS) の改修は **不要** (既存の server/client モードと既存の voice UI を組み合わせるだけ)。

## 詳細設計 (run-ai-monitor.sh)

### 1. config 解決 (env > .env > 既定)

`run-voice-*.sh` の `dotenv_get()` ヘルパを取り込み、ポート類を解決する。
- `AI_MONITOR_PORT` (server の待受 = ダッシュボードポート, 既定 8181)
- `CCM_CLIENT_DASH_PORT` (client のローカルダッシュ, 既定 8182)
- `CCM_SERVER_HOST` (server の待受ホスト, 既定 127.0.0.1)
- `VIBEBOARD_PORT` (既定 8180) は従来どおり。

### 2. token / URL 注入 (env > .env > 開発用デフォルト)

server と client のトークン不一致 (push が 401) を防ぐのが最重要。

- **ingest トークン (server)**: `CCM_INGEST_TOKENS` を解決
  (env `CCM_INGEST_TOKENS` > env `CCM_CLIENT_TOKENS`(旧) > .env のいずれか)。
  どこにも無ければ開発用デフォルト `localdevtoken1234567890` を export
  (`run-voice-server.sh` のロジックを踏襲)。
- **client トークン**: `CCM_CLIENT_TOKEN` が env/.env に無ければ、**解決済み ingest トークンの
  先頭値**を `CCM_CLIENT_TOKEN` として export する。これで自端末 self-push が常に一致する。
  (ユーザーが明示設定していればそれを尊重)
- **`CCM_SERVER_URL` (client の push 先)**: env/.env に無ければ
  `http://127.0.0.1:$AI_MONITOR_PORT` を export。
- **`GEMINI_API_KEY` / `ANTHROPIC_API_KEY`**: 注入しない。未設定なら案内ログのみ
  (Gemini 無し=音は出ずテキストのみ / Anthropic 無し=ペルソナ定型文フォールバック)。
- **`CCM_VOICE_TTS_PROVIDER`** (gemini|none) / **`CCM_CLIENT_LABEL`** / **`CCM_MIRROR_PROJECTS`**:
  上書きしない (dotenv に委ねる)。label は表示のみ (export すると .env を握りつぶすため)。

### 3. ビルド

`build_pkg vibeboard` / `build_pkg ai-monitor` は従来どおり 1 回ずつ。server も client も
同じ `ai-monitor/dist` を使うので二重ビルド不要。

### 4. stop_existing のスコープ

再起動時に自分が管理するプロセスだけを止める。**他端末用 `run-voice-client.sh` の client
(別ポート) を巻き込まない**のが要点。

- `vibeboard/dist/cli.js` … 従来どおり
- `ai-monitor/dist/cli.js --mode server` … 自分の server (単一 server 設計なので mode 一致で可)
- `ai-monitor/dist/cli.js --mode client --host 127.0.0.1 --port $CLIENT_DASH_PORT`
  … **ポート限定**で自分の client のみ (8191 等で動く別端末の client は残す)
- `ai-monitor/dist/cli.js( --mode local| --port)` … 旧 local が 8181 を握っていた場合に解放
  (EADDRINUSE 回避。移行時のクリーンアップ)

### 5. プロセス管理

3 つの node を background 起動し、PID を 3 つ収集。`cleanup` trap で 3 つとも kill、`wait -n` で
いずれか終了時に全停止 (既存パターンの拡張)。起動順は **server → client → vibeboard**
(client が push する前に server が listen しているように。uplink は失敗時リトライするので
厳密な readiness 待ちは不要だが順序は付けておく)。

### 6. ログ

`run-voice-*.sh` 同様、`CCM_LOG_DIR` (既定 `<repo>/logs`) に残す。background 各プロセスを
`> >(tee -a "$LOG_DIR/<name>.log") 2>&1` で「端末表示 + ファイル追記」両立。
ファイル名は `vibeboard.log` / `ai-monitor-server.log` / `ai-monitor-client.log`
(旧 `voice-server.log` は廃止)。

### 7. 起動時の案内出力

開いて確認する URL を明示する:
- 管理画面: `http://127.0.0.1:$VIBEBOARD_PORT` (AI Monitor タブ = voice ダッシュボード)
- 直リンク: `http://127.0.0.1:$AI_MONITOR_PORT/view?item=dashboard`
- 音声: 🔊 ON のクリックが autoplay 解除を兼ねる旨、key 未設定時の挙動。

## 挙動変更 / プライバシー注意

- 既定の `./run-ai-monitor.sh` が、これまでの「ローカル read-only の local モード」から
  **ローカル server(集約 + 音声) + client(push)** に変わる。
- server は host 既定 **127.0.0.1 (loopback)** なので外部公開はされない。`GEMINI_API_KEY` /
  `ANTHROPIC_API_KEY` を設定した場合のみ外部 AI プロバイダへ (redaction 済みの) transcript 断片が
  送られて音声が生成される。key 未設定なら音は出ず (テキストのみ)・要約はフォールバック。
- 音を止めたいだけなら `CCM_VOICE_TTS_PROVIDER=none` (UI は残る)。送信対象は
  `CCM_MIRROR_PROJECTS` で従来どおり限定可能。

## Phase 分割

- **Phase 1**: `run-ai-monitor.sh` を server + client 起動へ改修
  (config 解決 / token・URL 注入 / stop_existing スコープ / 3 プロセス管理 / ログ / 案内出力)
- **Phase 2**: `run-voice-server.sh` を削除し、参照 (deploy README 等) を grep して整理
- **Phase 3**: `CLAUDE.md` ほかドキュメント更新 (run-ai-monitor の役割・モード表・スクリプト一覧・
  音声節・プライバシー注意)
- **Phase 4**: 動作検証 (下記テスト方針)

## テスト方針

- `shellcheck run-ai-monitor.sh` が通る。
- **キー無しで起動**: `./run-ai-monitor.sh` → vibeboard 8180 / server 8181(dev token) /
  client が 8181 へ push / client dash 8182。`http://127.0.0.1:8180` の AI Monitor タブに
  **音声 UI (🔊 トグル)** が出る。既存 jsonl のセッションが client→server ミラー経由で
  カード表示される。
- **トークン一致**: `ai-monitor-client.log` で push が 200 (401 でない) こと。
- **`CCM_VOICE_TTS_PROVIDER=none`**: UI は出るが音は鳴らない (テキストのみ)。
- **`GEMINI_API_KEY` 設定時**: 状態遷移で音声が生成・順次再生される。
- **再起動の隔離**: 別端末で `./run-voice-client.sh` (8191) を起動した状態で
  `./run-ai-monitor.sh` を 2 回起動し直しても、8191 の client が **生き残る** こと
  (stop_existing が自分の 8182 client / server / vibeboard のみを止める)。
- **旧 local の解放**: 旧 local(8181) が残っていても EADDRINUSE にならず server が 8181 を取れる。

## 完了時の後片付け (着手ルール)

- `TODO.md` の親項目を `DONE.md` へ (完了日 `YYYY-MM-DD`)。
- 本プランを `docs/plans/archive/` へ移動。
- CLAUDE.md / README の整合を最終確認。
