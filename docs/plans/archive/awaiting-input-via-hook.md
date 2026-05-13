# 権限プロンプト保留中も「入力待ち」として検知する (PermissionRequest hook 連携)

## 目的・背景

Bash / Edit / Write などの権限プロンプト (`Do you want to proceed?` の Yes/No) が表示されているとき、ダッシュボードでは **AI処理中** と表示されてしまう。

理由: 現状の `classifyV2` (`ai-monitor/src/state.ts:99`) の「入力待ち」判定は、末尾が未一致 `tool_use` でかつツール名が `AskUserQuestion` / `ExitPlanMode` の場合に限定している (`INTERACTIVE_TOOL_NAMES` @ `ai-monitor/src/transcript.ts:302`)。Bash 等は権限プロンプト保留中も実行中も jsonl 上のシグネチャが同じ (`tool_use` のみで `tool_result` が無い) ため、jsonl だけからは原理的に区別できない。

期待値: 権限プロンプトが表示されている間は **入力待ち** バッジを出す。

## 対応方針

Claude Code が権限プロンプト表示時に発火する `PermissionRequest` hook を活用する。hook で「現在このセッションは入力待ち」という marker ファイルを置き、AI Monitor がそれを読んで `awaiting-user` に上書きする。

- jsonl だけでは原理的に判別不能なので、hook 経由の OOB シグナルを足す
- 既存の jsonl ベース判定 (`AskUserQuestion` / `ExitPlanMode`) は残し、marker と OR で `awaiting-user` 判定
- 既に ai-twitch-cast が `PermissionRequest` hook (`~/.claude/hooks/notify-permission.py`) を音声化用途で使っているので、**別スクリプトを追加して並列に走らせる** 方針 (既存 hook には触らない)

### marker ファイルの設計

- 置き場所: `/tmp/claude-code-manager/awaiting-input/<session_id>.json`
  - hook が呼ばれる前にディレクトリが無くても作る (mkdir -p 相当)
- 内容例:
  ```json
  {
    "session_id": "f0c27d2e-2f67-4dde-a79d-d19a580b3249",
    "cwd": "/home/ubuntu/foo",
    "tool_name": "Bash",
    "tool_use_id": "toolu_xxx",
    "created_at": "2026-05-12T..."
  }
  ```
- 削除タイミング (どれか 1 つでも到達したら消える):
  1. **PostToolUse hook**: 該当 toolUseId のツールが完了した
  2. **Stop hook**: ターン全体が終了した
  3. **AI Monitor 側の passive cleanup**:
     - marker mtime > 1h → stale とみなして無視 (削除)
     - 対応する claude プロセスが居ない → 無視 (削除)

## 影響範囲

### Phase 1: hook 追加 (グローバル `~/.claude/`)

- 新規 `~/.claude/hooks/ccm-awaiting-marker.py`
  - stdin JSON を読んで `session_id`, `tool_name`, `tool_use_id` を抽出
  - `hook_event_name` を見て分岐:
    - `PermissionRequest` → marker 作成 (write-rename で atomic)
    - `PostToolUse` / `Stop` → marker 削除 (存在しなければ no-op)
  - 例外時は静かに失敗 (他 hook を巻き込まない)
- `~/.claude/settings.json` の `hooks` に:
  - `PermissionRequest` 配列に entry 追加 (既存の notify-permission.py と並ぶ)
  - `PostToolUse` / `Stop` も新設 or 追加
- `async: true` を付ける (権限プロンプトの応答を待たせない)

### Phase 2: AI Monitor 側で marker を読む

- 新規 `ai-monitor/src/awaiting-input.ts`
  - `MARKER_DIR = /tmp/claude-code-manager/awaiting-input`
  - `listAwaitingInputMarkers(): Map<sessionId, MarkerInfo>` を export
  - mtime 古い marker / 存在しないセッションのものは結果から除く (+物理削除して掃除)
- `ai-monitor/src/state.ts`
  - `ClassifyInput` に `hasAwaitingMarker: boolean` を追加
  - `classifyV2`: `hasProcess && (endsWithInteractiveToolUse || hasAwaitingMarker)` → `awaiting-user`
  - `buildEntries`: 起点ループに入る前に marker map を 1 度ロードし、各 entry の `sessionId` (= jsonl ファイル名) と突合して渡す

### Phase 3: SSE / UI 反映

- `ai-monitor/src/server.ts` (要確認、構成によっては別ファイル)
  - 既存の jsonl watcher と同様に、`MARKER_DIR` を `fs.watch` で監視
  - 変化があれば `event: item-changed { id: <該当 entry id> }` を push
  - 全件再計算でも実害ないなら `{ id: 'dashboard' }` で済ませる
- 任意: カードに「権限プロンプト: Bash」みたいな注釈を表示 (marker の tool_name を使う)
  - 過剰なら次フェーズに回す

### Phase 4: ドキュメント / 後片付け

- `CLAUDE.md` のダッシュボード状態バッジ章の **入力待ち** 行を更新
  - 「`AskUserQuestion` / `ExitPlanMode` の未一致 tool_use」 + 「PermissionRequest hook 由来の marker」 の OR
- `~/.claude/hooks/ccm-awaiting-marker.py` の冒頭コメントに「claude-code-manager の入力待ち検知用 marker」を明記
- 必要なら `README.md` にも追記
- `TODO.md` 側のチェック → `DONE.md` 移動、plan は `docs/plans/archive/` へ

## テスト方針

単体テストは導入していないので、手動検証で確認。

1. **Phase 1 検証**: claude を起動 (allow に無い `Bash` を実行) → marker ファイルが出来ることを `ls /tmp/claude-code-manager/awaiting-input/` で確認 → 承認 / 拒否のいずれでも marker が消えることを確認
2. **Phase 2 検証**: `node -e` で `buildEntries` を直接叩き、marker 有り / 無しで `state` が切り替わることを確認
3. **Phase 3 検証**: `run-ai-monitor.sh` を再起動して、別 CLI で権限プロンプト → ダッシュボードのバッジが **入力待ち** に切り替わる / プロンプト消えると 待機中 や AI処理中 に戻ることをブラウザで目視
4. **回帰確認**: 既存の `AskUserQuestion` / `ExitPlanMode` ケースが従来通り **入力待ち** のままを維持
5. **stale 掃除**: claude を強制終了して marker を残した状態で AI Monitor の動作が壊れない (marker は無視 / 削除される) ことを確認

## オープン項目 (実装時に確認)

- `PermissionRequest` hook の stdin JSON スキーマ (`session_id` / `tool_name` / `tool_use_id` 等のキー名)
  - 既存 ai-twitch-cast の `notify-permission.py` は使っていないので、実装着手時に 1 度ダンプして確認する
- `PostToolUse` hook が「拒否された場合」にも発火するか
  - 発火しないなら Stop / passive cleanup だけが頼り (それでも問題はない想定)
- async hook と marker 書き込みの race
  - PermissionRequest hook は権限プロンプト表示前なら確実に発火するはずだが、`async: true` だと書き込み前にユーザーが即答するパターンが理論上あり得る。実害はほぼ無いが要確認
