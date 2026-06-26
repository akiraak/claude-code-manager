# claude-code-manager

複数の Claude Code CLI 実行を一元管理するためのシステム。

## 目的

複数の Claude Code CLI を同時に走らせていると、「どの CLI が何をやっていたか」がすぐに分からなくなり混乱する。
本プロジェクトはその混乱を防ぐための管理基盤を提供する。

## システム要件

- **Web ページで閲覧できる**: 各 CLI の状況をブラウザから確認できる UI を持つ
- **Claude Code CLI 毎に表示する**: 起動中／実行履歴のある CLI ごとに区分けして表示する
- **ユーザーコマンドと AI 応答を見やすく表示**: ユーザーが投入したプロンプトと、Claude からの応答（ツール呼び出しを含む）を時系列で読みやすく描画する
- **情報量が多いものは AI で要約**: ログや出力が長くなった場合、AI を使って要約表示し、必要に応じて原文も参照できるようにする

## 用語

- **CLI セッション**: 1 つの `claude` プロセスの起動から終了までの単位
- **ターン**: ユーザー入力と、それに対する AI の応答（ツール呼び出し含む）の往復 1 回分

<!-- vibeboard:begin -->
## 開発管理画面 (vibeboard)

ローカル開発時のタスク・プラン管理は [vibeboard](https://github.com/akiraak/vibeboard) で行う。
vibeboard は本リポに vendored せず、`run-ai-monitor.sh` が **upstream から pin したタグ (`VIBEBOARD_REF`・既定 `v0.2.0`) を `git clone`** して `./vibeboard/` に取得する（無ければ clone、あれば再利用。`vibeboard/` は gitignore 済み）。
AI Monitor が依存する customTabs は upstream vibeboard の汎用機能 (v0.2.0+) なので、vibeboard 側の改修は upstream に直接入れてタグを上げ、`VIBEBOARD_REF` を更新する。clone 元/タグは `VIBEBOARD_REPO`/`VIBEBOARD_REF` で変更可能。

```bash
# 起動 (vibeboard を upstream から clone[初回のみ] + 依存インストール + ビルド + 既存停止 + 起動 を全部やる)
./run-ai-monitor.sh
```

`http://localhost:8180` でプロジェクト直下の `docs/plans/`・`docs/specs/`・`TODO.md`・`DONE.md` を閲覧・編集できる。

- `TODO` タブで `TODO.md` / `DONE.md` をプレビュー表示・編集できる
  - 編集は楽観ロック（mtime チェック）付き。外部で先に更新されていた場合は保存時に 409 を返し、リロード / 手元維持 / 強制上書き を選べる
  - `fs.watch` + 2 秒ポーリングで外部変更を検知し、SSE でクライアントへ即時反映する
- ローカル開発専用（本番管理画面とは独立）
- ポート変更は `VIBEBOARD_PORT` 環境変数で指定可能（デフォルト 8180）

## AI Monitor (vibeboard customTabs プラグイン)

稼働中の Claude Code CLI を vibeboard 上で可視化するためのサーバ。`./ai-monitor/` に実装がある。`run-ai-monitor.sh` が ai-monitor を **server モード (集約 + 音声 + ミラー)** で vibeboard と一緒に起動する（別プロセス）。

```bash
# 起動 (vibeboard 8180 + ai-monitor server 8190 をまとめて立ち上げる。
#       依存インストール + ビルドもスクリプト内で実施)
./run-ai-monitor.sh
```

- `vibeboard.config.json` の `customTabs` に AI Monitor のエントリ（`baseUrl: http://127.0.0.1:8190`）を登録済み。vibeboard 起動時に **AI Monitor** タブ（= server の音声つきダッシュボード）として読み込まれる
- server は FS を読まない「集める専用」。`run-ai-monitor.sh` 単体ではカードは空で、各端末（この PC を含む）で `run-ai-monitor-client.sh` を別途起動して push すると映る
- `run-ai-monitor.sh` は既に起動中の vibeboard / ai-monitor server / 旧 local を `pgrep -f` で検出し停止してから起動し直す。`run-ai-monitor-client.sh` の client (`--mode client`) は巻き込まない
- ポート/ホスト変更は `VIBEBOARD_PORT` / `CCM_SERVER_PORT` / `CCM_SERVER_HOST` 環境変数（または `.env`）で指定可能。server ポートを変えた場合は `vibeboard.config.json` の `baseUrl` も合わせる

#### 動作モード (`--mode`)

| モード | 役割 | FS アクセス | 書き込み API |
|---|---|---|---|
| `local` (既定) | ローカル FS を pull して loopback 配信 (従来どおり) | `~/.claude/projects/*/*.jsonl` と `/proc` のみ read-only | なし |
| `client` | local と同じ可視化 + 公開サーバへ uplink push | 同上 read-only | なし (送信のみ) |
| `server` | 公開アグリゲータ。端末別 Bearer で push を受け集約・音声生成・ミラー配信 | **FS は読まない** (集約ストア = メモリ + TTL) | `/api/ingest/*` (認証付き) |

`run-ai-monitor.sh` は `server` を起動する (`--mode server` 明示)。`local`/`client` は従来どおりローカル read-only で、書き込み API も持たない。公開・認証付き ingestion は `server` モードに限る。

起動スクリプト (ビルド + 同モードの既存停止 + 起動):
- `./run-ai-monitor.sh` — vibeboard (8180) + ai-monitor **server** (既定 8190。集約 + 音声 + ミラー)。管理画面 `http://127.0.0.1:8180` の AI Monitor タブ = `http://127.0.0.1:8190/view?item=dashboard`
- `./run-ai-monitor-client.sh` — client モード (既定 8191。この端末の状態を server へ push)。`run-ai-monitor.sh` と対で、可視化したい各端末（同一 PC を含む）で別途起動する
- 各スクリプトの停止対象は自分が管理するもの (`run-ai-monitor.sh` = vibeboard / server / 旧 local、`run-ai-monitor-client.sh` = client) のみで互いを巻き込まない。設定の解決順: node (`cli.ts`) が読む設定 (トークン/キー/URL/ラベル/allowlist 等) と、起動スクリプトが解決するポート/ホスト (`VIBEBOARD_PORT`/`CCM_SERVER_HOST`/`CCM_SERVER_PORT`/`CCM_CLIENT_DASH_PORT`) は **env > リポ直下 `.env` > 既定** (ポート/ホストは各起動スクリプトが `.env` を読む。直接 `node` 起動時は `--host`/`--port`)。`SKIP_BUILD`/`CCM_LOG_DIR` のみ **env > 既定**。

新しい **client** 端末は起動前に一度 `./scripts/setup-client.sh` を実行する (権限プロンプト検出 hook の `~/.claude/hooks/` 配置 + `~/.claude/settings.json` への冪等マージ + `.env` 雛形作成。`python3` は絶対パス解決して settings.json に書く。何度実行しても安全)。`local`/`server` のみで使う端末には不要。hook あり/なしの挙動差は下表のとおりで、hook が足すのは Bash/Edit/Write 権限プロンプトの「入力待ち」検出だけ (完了/途中経過/対話ツールの承認待ち音声は hook 非依存)。

### ダッシュボードの状態バッジ

カード左上のバッジで 1 セッションの現在状態を 4 種類で示す。判定は `ai-monitor/src/state.ts` の `classifyV2`。

| バッジ | 色 | 装飾 | 条件 |
|---|---|---|---|
| AI処理中 | 緑       | 脈動 | CLI 生存 + 直近 30 秒以内に jsonl 更新あり (AI 非介在のローカルコマンド直後は除く) |
| 入力待ち | オレンジ | 脈動 | CLI 生存 + (末尾が `AskUserQuestion` / `ExitPlanMode` の未一致 `tool_use`) **または** (PermissionRequest hook の marker あり) |
| 待機中   | 黄       | 静止 | CLI 生存 + 上記以外 (アイドル / 通常のターン終了 / `/clear` `! ls` 等の AI 非介在ローカルコマンド直後) |
| 停止     | 灰       | 静止 | CLI 消滅 (24 時間だけ残る = `STOPPED_RETENTION_SEC = 86_400` 秒) |

入力待ち は **明示的なユーザー応答ブロッカーのみ** に限定する方針 (通常の AI ターン終了は 待機中)。
Bash / Edit / Write 等の Yes/No 権限プロンプトも入力待ちに含めるため、グローバル hook (`~/.claude/hooks/ccm-awaiting-marker.py`・正本は `ai-monitor/hooks/ccm-awaiting-marker.py`・配置は `scripts/setup-client.sh`) が PermissionRequest 時に `/tmp/claude-code-manager/awaiting-input/<session_id>.json` を置き、PostToolUse / Stop で消す。AI Monitor はそれを読み取り、`fs.watch` で変化を即座に SSE へ反映する。
`/clear` `/help` `! ls` 等の AI 非介在ローカルコマンドは jsonl の末尾が `system` (`subtype: local_command`) になるため、mtime が新しくても AI処理中 ではなく 待機中 として扱う (誤検知防止)。
旧 `error` state は、対話ツール選択中に `/exit` した場合と本物のクラッシュを区別できず偽陽性が出るため `stopped` に統合した。
突き合わせキーは `projectDir` (= `~/.claude/projects/<projectDir>/`)。セッション中に `cd` しても projectDir は不変なので 1 セッションが 1 カードにまとまる。

### AI 要約 (オプション)

ダッシュボードのカードに「セッションは今何をしていてどこまで進んだか」を Claude API で 1〜2 行に要約して表示する。

- リポジトリ直下の `.env` (gitignore 済み) に `ANTHROPIC_API_KEY=...` を置くと有効になる。`ai-monitor` 起動時に `dotenv` で読む
- モデル: `claude-haiku-4-5-20251001` 固定
- キャッシュは `(jsonlPath, mtimeMs)` 単位のメモリ Map。サーバ再起動で消える
- キー未設定でもサーバは落ちず、カードに「(要約: API キー未設定)」が薄色表示される
- 要約完了は SSE (`event: item-changed { id: 'dashboard' }`) でクライアントへ push され、カードが自動更新される

### 進捗音声 + 公開ミラー (server/client モード)

各端末 (`--mode client`) が状態スナップショット + 状態遷移イベントを公開サーバ (`--mode server`) へ push し、サーバが **ちょビ(先生) & なるこ(生徒) の 2 人会話台本 (Haiku) → 音声 (Gemini TTS)** を生成、ブラウザのダッシュボード上で **ミラー表示 + 順次再生**する。発話は **完了 / 承認待ち / 長時間実行の途中経過** のみ (指示受信では発話しない)。読み上げ生成は ai-twitch-cast (`~/ai-twitch-cast`) の実装に寄せてある (テキスト生成モデルだけ Haiku 維持。詳細は `docs/plans/archive/voice-content-align-ai-twitch-cast.md`)。

- **2 人会話 + 作業コンテキスト**: client は遷移イベントに「ユーザー指示 / 直近アクション列 (コマンド実行・ファイル編集・検索・サブエージェント) / Claude のメモ / 経過分」を `context` として載せる (`transcript.ts:extractWorkContext` で抽出 → 送信前 redaction)。server は `persona.ts` (`buildClaudeWorkPrompt`) でこれを 2 人の掛け合い (1 イベント = 2〜4 発話の JSON 配列・emotion 付き) に変換。speaker ごとに声を変える (teacher=Leda / student=Aoede)。同一イベントの発話は `groupId` で束ね `createdAtMs` を 1ms ずつずらして会話順を保証。ダッシュボードの順次再生は、連続する発話で `groupId` が変わる (= 別イベントに移る) ときだけ短い無音 (`GROUP_GAP_MS` 既定 700ms) を挟み、同一イベント内は連続再生する (キューが空になると次の発話は待たせない)。
- **長さ**: 文字数制限は生成プロンプト側 (1〜2 文・40 字目安) で行い、読み上げは全文を読む (`persona.ts` はハード切り詰めをしない。安全網 `SPEECH_SAFETY_MAX` のみ)。
- **キャラ設定**: `ai-monitor/voice-persona.json` (編集可・2 キャラ: `teacher` / `student`。各 `systemPrompt` / `rules` / `emotions` / `ttsVoice` / `ttsStyle`)。旧 1 キャラ JSON は teacher に流し込む後方互換あり。`emotion`/`se` はメタとして保持・UI ラベル表示のみ (アバター/効果音プレーヤーは無いので再生はしない)。

- 主な env (server): `CCM_INGEST_TOKENS` (必須・端末別 Bearer・カンマ区切りで全端末分・fail-fast。旧名 `CCM_CLIENT_TOKENS` も後方互換・非推奨。クライアントの `CCM_CLIENT_TOKEN` 単数と区別) / `CCM_CORS_ORIGIN` / `ANTHROPIC_API_KEY` (ペルソナ短文・未設定は fallback) / `GEMINI_API_KEY`(+`GEMINI_TTS_MODEL`) / `CCM_VOICE_TTS_PROVIDER` (gemini|none) / `CCM_VOICE_SPOKEN_KINDS` (読み上げ種別の csv・既定 `completed,awaiting,progress`。許可は awaiting/completed/progress のみで started は常に無音。**生成の絶対上限=天井**で、UI のチェックはこの内側でしか効かない。頻度を下げたいとき絞る。例 `completed,awaiting` で progress=2分間隔の途中経過を 0%。未設定/空/不正は既定にフォールバック) / `CCM_VOICE_UI_GATING` (on|off・既定 on。下記「UI ゲーティング」参照。off で従来の env 静的生成へロールバック)。server 1 箇所で全端末の読み上げ上限を制御する。
- 主な env (client): `CCM_SERVER_URL` / `CCM_CLIENT_TOKEN` / `CCM_CLIENT_LABEL` / `CCM_MIRROR_PROJECTS` (ミラー対象 allowlist) / `CCM_DRYRUN`。
- ボイス UI (ON/OFF・音量・種別/端末フィルタ・履歴 + 再再生・SSE 順次再生) は **server モードのダッシュボードにのみ**載る (`renderDashboard(opts.voice)`)。🔊 ON のクリックが autoplay 解除を兼ねる。
- **UI ゲーティング (`CCM_VOICE_UI_GATING`・既定 on)**: 種別チェック (完了/承認待ち/途中経過) と 🔊 ON/OFF で **server 側の生成 (Haiku 台本 + Gemini TTS) そのもの**を抑止する。誰も聴いていない種別・時間帯の API/TTS コストを節約し、再起動不要・即時反映。
  - **二層構造**: 生成 = `envAllow ∩ ∪{接続中 🔊ON viewer の希望種別}` (= effective) / 再生 = 従来どおり viewer ごとの `passes()`。`CCM_VOICE_SPOKEN_KINDS`=天井、UI=その内側で union 集約。**🔊ON の viewer がゼロ or 全員その種別を外す → 無音 (生成しない)**。割り切り: viewer ゼロ時間帯のイベントは utterance が残らない (後から種別 ON + リロードしても履歴に出ない)。
  - **仕組み**: viewer は **`sub`** (sessionStorage `ccm-voice-sub`・タブ単位・発話元端末 `clientId` とは別物) を採番し、`/api/watch?sub=&voice=&kinds=` で購読 + `POST /api/voice/prefs` で ON/OFF・種別を送る。server は `voice-subscribers.ts` の registry (`effectiveKinds = union ∩ envAllow`・TTL 90s・接続/ping/切断で register/touch/remove) で集約し、`VoicePipeline` の `spokenKindsProvider` が generate 前のゲートで毎回参照する。effective が変わると `[ai-monitor] voice: effective=… (viewers=N, env=…)` をログ。
  - **off** にすると provider 未配線で従来の env 静的生成 (`CCM_VOICE_SPOKEN_KINDS` の種別を常時生成) へ即ロールバック (prefs は 404・viewer 非集計)。端末フィルタ (`ccm-voice-client`) による生成抑止は対象外で、従来どおり再生のみに効く。
- **プライバシー**: ミラーは transcript 末尾・要約・進捗テキストを Cloudflare / g3plus / AI プロバイダへ通過させる。送信前に `redaction.ts` で秘匿パターンをマスク + サイズ上限、`jsonlPath` は送らない。音声の `context` は **アクション要約のみ** (コマンド先頭 80 字 / ファイルは basename / 検索パターン先頭 50 字 / ユーザー指示・Claude メモは各 160 字・配列長は actions 10・notes 3 件) を載せ、`ingest.ts` でも型・配列長・各要素長を再検証する。対象は `CCM_MIRROR_PROJECTS` で限定する。保持はメモリ + TTL (集約 24h / utterance 1h) のみ。
- 公開デプロイ (g3plus + Cloudflare Tunnel `ccm.chobi.me` + Access) の成果物と手順は `ai-monitor/deploy/g3plus/`(Dockerfile / docker-compose.yml / .env.example / README) を参照。**インフラ操作はユーザー担当**。

## タスク管理ルール

- タスクは `TODO.md` で管理する
- タスクが完了したら `TODO.md` から該当項目を削除し、`DONE.md` に移動する
- `DONE.md` には完了日を `YYYY-MM-DD` 形式で付けて記録する
- 新しいタスクが発生したら `TODO.md` の適切なセクションに追加する
- タスクの実施前に `TODO.md` を確認し、優先度の高いものから着手する
- コミット時に `TODO.md` を確認し、実装した機能に対応するタスクがあれば `DONE.md` に移動する

## 作業着手ルール

作業（実装・調査いずれも）を始めるときは、コードに手を入れる前に以下を行う。

1. **プランファイルを作成する**: `docs/plans/<task-name>.md` に実装プラン or 調査プランを作成する
   - 目的・背景、対応方針、影響範囲、テスト方針を最低限記載する
   - 複数 Phase / Step に分かれる場合はファイル内でも Phase / Step を明示する
2. **`TODO.md` に該当項目があるか確認する**
   - 無ければ適切なセクションに追加する
   - 既存項目があれば、その項目に作成したプランファイルへのリンクを追記する（例: `[plan](docs/plans/<task-name>.md)`）
3. **複数 Phase / Step がある場合は `TODO.md` に子タスクとして追加する**
   - 親項目の下にインデントしたチェックボックスで Phase / Step を列挙する
   - Phase / Step が完了するごとにチェックを入れ、全完了で親項目を `DONE.md` に移す
4. **作業完了時の後片付け**
   - 親タスクを `DONE.md` に移動する
   - 対応するプランファイルは `docs/plans/archive/` に移動する
<!-- vibeboard:end -->
