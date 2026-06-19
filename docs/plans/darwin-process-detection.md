# macOS (darwin) の claude プロセス検出

## 目的・背景

`--mode client` を Mac で動かしても、進捗音声が一切喋らない。原因は `processes.ts` の
darwin 経路が **スキャフォルド（空配列 + 1 回 warn）のまま** で、稼働中の `claude` CLI を
1 件も検出しないこと（Phase 4 でユーザー確定の上で後追いにした部分。
`docs/plans/archive/claude-progress-voice-phase4.md`「7) processes.ts」）。

### 喋らない連鎖（調査結果）

1. `processes.ts:63-69` `listClaudeProcessesDarwin()` が常に `[]` を返す。
2. → `state.ts:128` `classifyV2`: `!hasProcess` で Mac の全セッションが**常に `stopped`**。
   `buildEntries` の Step1（プロセス起点）が空回りし、Step2（jsonl 起点 = stopped）だけが動く。
3. → `uplink.ts:370-383` `transitionEvent` が発話の素を作るのは
   `→ awaiting-user` / `ai-processing → waiting` / `ai-processing` 継続 の遷移のみ。
   常に `stopped` だとこれらの遷移が起きず、`VoiceEventDetector` が voice-event を 0 件しか出さない。
4. → `ingest.ts:215-233` サーバは `POST /api/ingest/voice-event`（= `onVoiceEvent`）でしか喋らない。
   snapshot からは遷移を再計算しない。よって Mac から voice-event が来ない以上、永久に無発話。

結果、Mac セッションはミラー上に「停止（灰）」カードとしては出る（snapshot は state 不問で送るため）が、
AI処理中/完了 に変わらず喋らない。

### 直せば自動で流れる

サーバ/プロトコル/uplink は**一切変更不要**。`listClaudeProcessesDarwin()` が正しく
`{pid, cwd}` を返せば、`hasProcess:true` → 状態遷移 → voice-event → 発話が既存経路でそのまま通る。

## 対応方針

`processes.ts` の darwin 経路を、Linux 版（`pgrep` + `/proc`）に対応する形で `ps` + `lsof` で実装する。
Linux 経路（`listClaudeProcessesLinux` / `isRealClaude` / `readCwd`）は**不変**。

### 検出ロジック

1. **PID 列挙**: `ps -axww -o pid=,comm=,command=` で全プロセスを取り、`claude` を絞り込む。
   - 判定は Linux の `isRealClaude` に揃える: `comm` の basename が `claude`、
     **または** `command`（フル argv）の argv[0] basename が `claude`
     （npm/node 経由で `comm` が `node` になるケースの保険）。
   - 自分（ai-monitor の node プロセス）の pid は除外（Linux 同様 `selfPid` ガード）。
2. **cwd 取得**: 絞り込んだ PID をまとめて 1 回の `lsof -a -d cwd -p <pid1>,<pid2>,... -Fpn` に渡し、
   `p<pid>` / `n<path>` のフィールド出力をパースして `Map<pid, cwd>` を作る
   （pid ごとに lsof を呼ぶと遅いのでバッチ 1 回）。
   - cwd が取れなかった pid は除外（Linux で `readCwd` が null なら除外するのと同じ）。
3. 上記を突き合わせ、`{pid, cwd}[]` を pid 昇順で返す。

### 失敗時の挙動

- `ps` 失敗・`lsof` 不在/権限不足は try/catch で握り、1 回だけ warn して取れた範囲を返す
  （クラッシュさせない。最悪 `[]` に縮退してもスキャフォルド時と同等で悪化しない）。

### テスト容易性

シェル出力のパースを**純関数として切り出し**、fixture 文字列で単体テストする
（実シェル呼び出しのラッパは薄く保つ）。

- `parsePsClaudePids(stdout: string, selfPid: number): number[]`
- `parseLsofCwd(stdout: string): Map<number, string>`

fixture は Mac 実機で採取した `ps` / `lsof` の生出力を貼り付けて回帰させる。

## 影響範囲

- 変更: `ai-monitor/src/processes.ts`（darwin 経路の実装 + 純関数パーサの追加。Linux 経路は不変）。
- 追加: `ai-monitor/src/processes.test.ts`（純関数パーサの単体テスト。新規）。
- 非変更: `state.ts` / `uplink.ts` / `ingest.ts` / server / プロトコル / 起動スクリプト。

## テスト方針

- **単体**: `parsePsClaudePids` / `parseLsofCwd` を fixture で検証
  （comm が claude / node+argv0 claude / 無関係プロセス / 自 pid 除外 / 複数 pid の lsof / cwd 欠落）。
- **既存**: `npm test`（ai-monitor）が全緑のまま（Linux 経路を壊していないこと）。
- **実機（ユーザー担当・受け入れ基準）**:
  Mac で `--mode client` を起動し、WSL2 サーバのダッシュボードで
  - Mac カードが稼働中に「AI処理中（緑・脈動）」になる
  - ターン完了で「完了」、承認プロンプトで「承認待ち」になり、サーバが喋る
  WSL2 端末カードと挙動が一致すれば完了。

## Phase / Step

- [ ] Phase 1: 純関数パーサ + 単体テスト（`parsePsClaudePids` / `parseLsofCwd`、`processes.test.ts` 追加）
- [ ] Phase 2: darwin 検出のワイヤリング（`listClaudeProcessesDarwin` を ps+lsof 実装に、warn を失敗時のみに整理）
- [ ] Phase 3: Mac 実機検証（ユーザー担当。AI処理中/完了/承認待ち と発話を確認）
