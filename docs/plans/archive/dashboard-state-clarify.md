# ダッシュボード状態表示の整理 (2026-05-12)

## 目的・背景

TODO:

> 動作中のプロセスが「停止中」と表示される。ステータスが分からないのでどのような状態で何が出るのか整理

ダッシュボードカードの「state バッジ」は現状 4 種類 (`ai-processing` / `waiting` / `stopped` / `error`) だが、

1. 動いている CLI が「停止」表示になるケースがある (バグの可能性 / 仕様の認識ずれ)
2. それぞれの state が「何を意味し、いつ出るのか」がドキュメント化されていない

ため、ユーザーが画面を見ても状況を把握しづらい。本タスクでは「現状の整理 → 不整合があれば修正 → ラベル / 仕様を明確化」を行う。

## 現状の分類ロジック (おさらい)

`ai-monitor/src/state.ts` の `classifyV2`:

| 入力 | 結果 |
|------|------|
| プロセス生存 + jsonl mtime ≤ 30 秒前 | `ai-processing` (バッジ: AI処理中) |
| プロセス生存 + jsonl mtime > 30 秒前 / jsonl 無し | `waiting` (バッジ: 待機中) |
| プロセス消滅 + 末尾が未一致 `tool_use` | `error` (バッジ: エラー) |
| プロセス消滅 + 上記以外 | `stopped` (バッジ: 停止) |

加えて `buildEntries` の組み立て:

- Path 1: 生きているプロセス起点で entry を作る (cwd で dedup)
- Path 2: 生きているプロセスが見つからなかった transcript のうち、mtime が 10 分 (`STOPPED_RETENTION_SEC=600`) 以内のものを stopped / error として残す

つまり「動いている CLI が停止表示」になるのは Path 1 でプロセスが拾えず、Path 2 経由で transcript だけが描画されている、というのが論理的に唯一のシナリオ。

## 想定される原因仮説

1. **`listClaudeProcesses` がプロセスを取り損ねている**
   - `isRealClaude`: `/proc/<pid>/comm` が `claude` でも `cmdline` argv[0] basename が `claude` でもないと弾く
   - 本環境では `comm=claude` を確認済みだが、`node /path/to/cli.js` 経由で起動された場合などは `node` になり弾かれる可能性がある
   - 何らかの理由で `readCwd(/proc/<pid>/cwd)` が失敗するケース (権限 / コンテナ越し)
2. **transcript の cwd ↔ プロセス cwd が一致しない**
   - シンボリックリンクや `pwd -P` 経由などで物理パスと論理パスが食い違うと、`seen.has(proc.cwd)` で吸収できず Path 2 にも進入して二重カード化 (片方 stopped)
3. **「動作中だが jsonl が更新されていない」状態の混同**
   - state=`waiting` (バッジ「待機中」) を画面上「停止」と読み違えている可能性
   - 「待機中」「停止」のバッジ色 (青 vs グレー) のコントラストが弱い

## 対応方針 (Phase 分け)

### Phase 1: 計測・現象再現 ✅ 採取完了 (2026-05-12)

- ダッシュボード描画時の判定根拠を `?debug=1` などで表に出す (state / hasProcess / mtime / cwd / endsWithUnmatchedToolUse)
- 実際に「動いている CLI が停止表示」になっている entry の入力値を採取
- 必要に応じて `listClaudeProcesses` / `listTranscripts` の生出力を JSON で吐くデバッグ API を一時追加

#### 実装した一時計測

- `processes.ts`: `enumerateClaudeProcessCandidates()` を追加。pgrep の各候補に対し comm / argv0 / cwd / 採否 / 拒否理由を返す
- `server.ts`: `/api/debug/processes` と `/api/debug/entries` を追加 (JSON)
- `views.ts`: `renderDashboard(entries, { debug })` 拡張、`?debug=1` で判定根拠テーブルを上部に折り畳み表示

#### 採取結果 (2026-05-12 13:03 JST 頃の本環境)

`/api/debug/entries` の出力で、本タスクで対象としていた「動いている CLI が停止表示」の現象が再現:

| cwd (entry) | state | hasProcess | pid | transcript cwd |
|---|---|---|---|---|
| `/home/ubuntu/claude-code-manager` | waiting | yes | 834616 | (なし) |
| `/home/ubuntu/claude-code-manager/ai-monitor` | error | **no** | — | `/home/ubuntu/claude-code-manager/ai-monitor` |

- `/proc/834616/cwd` = `/home/ubuntu/claude-code-manager` (親ディレクトリ)
- 一方、その PID が書いている jsonl は `~/.claude/projects/-home-ubuntu-claude-code-manager/...jsonl` で、jsonl 内の `cwd` フィールドは `/home/ubuntu/claude-code-manager/ai-monitor` (ユーザーが `cd ai-monitor` した後の作業ディレクトリ)
- `buildEntries` は cwd 完全一致で突き合わせるため **同じ CLI が「プロセスのみ entry」と「jsonl のみ entry」の 2 枚に分裂**
- 後者は `hasProcess=false` 扱いになり、jsonl 末尾が tool_use のまま (= 動作中のターン途中) のため `state=error` と分類されて「動いている CLI がエラー / 停止表示」に見えていた

#### Phase 2 への引き継ぎ事項

- 仮説 1 (isRealClaude の取りこぼし) は本環境では再現せず: pgrep が拾った PID で `accepted=true` になっているものは comm=`claude` / argv0=`claude` のケースだけだった
- **仮説 2 (cwd 不一致) が主犯**。ただしシンボリックリンクや `realpath` 由来ではなく「CLI 起動後に `cd` した結果として `/proc/<pid>/cwd` と jsonl 内 cwd がズレる」パターン
- → Phase 2 で必要なのは:
  1. プロセスと transcript の突き合わせを「cwd 完全一致」から「**同一 projectDir (= 末尾 jsonl ファイル所在ディレクトリ)** での突き合わせ」に変える、または「プロセス cwd が transcript cwd の祖先 / 子孫」も許容する
  2. ある CLI セッションが 1 枚のカードにまとまるよう dedup ロジックを刷新

### Phase 2: 分類ロジックの修正 ✅ 実装完了 (2026-05-12)

採取結果から「主犯は cwd 不一致 (CLI 起動後の `cd`)」と判明したため、突き合わせキーを
**cwd → projectDir** に変更した。projectDir は `~/.claude/projects/` 配下のディレクトリ名で、
CLI 起動時の launch dir を Claude が `cwd.replace(/[^A-Za-z0-9]/g, '-')` で符号化したもの。
セッション中に `cd` しても projectDir は不変なので、1 セッションが必ず 1 entry にまとまる。

#### 実装内容

- `transcript.ts`: `cwdToProjectDir(cwd)` を追加 (非英数字 → `-`)。前方変換のみで逆変換はしない (元の `-` と `/` 由来の `-` を区別できないため)。
- `state.ts`:
  - `MonitorEntry` に `projectDir: string` を追加。`id` は `encodeId(projectDir)` で生成 (cwd 由来ではない)
  - `buildEntries` の Map を `byCwd` → `byProjectDir` に。`seen` も projectDir で管理
  - Path 1 (生プロセス): `cwdToProjectDir(proc.cwd)` で突合
  - Path 2 (transcript のみ): `ts.projectDir` で突合
  - `e.cwd` は表示専用に格下げ。生プロセス時は process cwd、消滅時は transcript cwd (sub-dir 化することあり)
- `server.ts`: `/view` と `/api/summarize` の lookup を `e.cwd === cwd` → `e.projectDir === projectDir` に変更。`/api/debug/entries` のレスポンスに `projectDir` フィールドを追加 (確認しやすさのため)。

#### 動作確認結果 (2026-05-12 13:13 JST 頃の本環境)

`/api/debug/entries` の出力で、Phase 1 で 2 枚に分裂していた本セッションが 1 枚に統合された:

| projectDir | cwd (entry) | transcript cwd | state | hasProcess | pid |
|---|---|---|---|---|---|
| `-home-ubuntu-claude-code-manager` | `/home/ubuntu/claude-code-manager` | `/home/ubuntu/claude-code-manager/ai-monitor` | **ai-processing** | yes | 834616 |

`waiting` / `error` の二重表示が解消され、entry.cwd (launch dir) と transcript.cwd (現在の cwd) が
別々のフィールドとして保持されている。

#### 残作業 (Phase 2 のフォローアップ)

- Phase 1 で入れたデバッグ API (`/api/debug/processes`, `/api/debug/entries`, `?debug=1` パネル) と
  `enumerateClaudeProcessCandidates` は、Phase 3 で表示仕様を固める際に再度参照する可能性がある
  ため一旦残置。Phase 3 完了後に削除する

### Phase 3: 表示 / 仕様の明確化 ✅ 実装完了 (2026-05-12)

state 定義 (最終形):

```
ai-processing : CLI 生存 + 直近 30 秒以内に jsonl 更新あり
waiting       : CLI 生存 + 直近 30 秒以内に jsonl 更新なし (入力待ち / アイドル含む)
error         : CLI 消滅 + jsonl 末尾が tool_use のまま (ツール途中で死んだ)
stopped       : CLI 消滅 + 末尾 tool_use 未一致なし (正常終了 or 単に終わっただけ)
```

#### 実装内容

- `views.ts`:
  - badge 色を 4 状態でハッキリ分けた: 緑 (AI処理中) / 黄 (待機中) / 灰 (停止) / 赤 (エラー)。
    特に「待機中 (青系) vs 停止 (灰)」のコントラストが弱かったので、待機中を黄系 (`#fff3cd / #8a6100`) に振り替え
  - badge 左に色付きドット (`::before`) を追加し、AI処理中だけ脈動アニメーション (`badge-pulse`) を付与
  - `STATE_TOOLTIP_JA` を新設し、badge に `title="..."` で「この state が出る条件」を hover tooltip 表示
- `README.md` / `CLAUDE.md` に state 定義表を追記。突き合わせキー (`projectDir`) と保持時間 (`STOPPED_RETENTION_SEC = 600`) も併記
- Phase 1 で入れたデバッグ機構を撤去:
  - `processes.ts` から `enumerateClaudeProcessCandidates` / `ClaudeProcessCandidate` を削除 (`listClaudeProcesses` に直接インライン化)
  - `server.ts` から `/api/debug/processes` / `/api/debug/entries` を削除
  - `views.ts` から `renderDebugTable` と `RenderDashboardOptions.debug` (`?debug=1`) を削除

#### 動作確認 (2026-05-12)

- `npm run build` 成功
- `./run-ai-monitor.sh` で再起動。ブラウザ実機ではなく `curl /view?item=dashboard` の HTML を確認:
  - 新しい badge クラス / 色 / `title` 属性が反映されている
  - `badge-pulse` アニメーションが ai-processing に付与されている
- `/api/debug/processes` は 404 (削除済み) を返す
- `?debug=1` を付けてもデバッグ表は出ない (パラメータ無視)

## 影響範囲

- `ai-monitor/src/processes.ts` (`isRealClaude` 緩和の可能性)
- `ai-monitor/src/state.ts` (`buildEntries` の cwd 正規化 / dedup 強化、必要なら `classifyV2` 微調整)
- `ai-monitor/src/server.ts` (デバッグ API の一時追加 → 確認後削除)
- `ai-monitor/src/views.ts` (バッジ tooltip / 色味)
- README / CLAUDE.md (state 定義表)

## テスト方針

- 手動: `./run-ai-monitor.sh` を起動した状態で
  - 動いている claude を起動 → カードが `ai-processing` / `waiting` 表示
  - 動いている claude が「停止」表示になるケースを意図的に作って再現 / 修正
  - claude を `kill` → 10 分以内は `stopped` / `error`、10 分後に消える
- デバッグ API は確認後にコミット前に必ず削除する
