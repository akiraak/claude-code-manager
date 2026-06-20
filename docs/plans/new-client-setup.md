# 新しいクライアント環境のセットアップ (hook など初期設定)

## 目的・背景

新しい端末 (Mac 等) で client モード (`run-voice-client.sh`) を動かすとき、リポを clone して
`.env` を書くだけでは **権限プロンプト (Bash / Edit / Write の Yes/No) の「入力待ち」検出**が
効かない。これはグローバル hook `~/.claude/hooks/ccm-awaiting-marker.py` と
`~/.claude/settings.json` の hook 登録が **リポ未管理 = 各端末に手動配置が必要**なため。

現状 Mac には hook 未配置。本プランは「新規端末を hook 込みで再現可能にセットアップする」手順と
スクリプトを整備する。あわせて **hook あり / なしで挙動がどう変わるか**を明文化する
(「hook 無しでも音声は鳴る」のはなぜか、を含む)。

### hook あり / なし 挙動比較 (これがこのタスクの背景の核心)

hook (`ccm-awaiting-marker.py`) が触るのは **権限プロンプトの検出だけ**。状態判定・音声の大半は
jsonl + プロセス検出から出るので hook に依存しない。実装根拠は
`ai-monitor/src/state.ts` (`classifyV2`) と `ai-monitor/src/uplink.ts` (`VoiceEventDetector` /
`transitionEvent`)。

| 機能 | hook なし | hook あり | 依存元 |
|---|---|---|---|
| バッジ AI処理中 / 待機中 / 停止 | ✅ | ✅ | jsonl mtime + プロセス検出 |
| バッジ 入力待ち (AskUserQuestion / ExitPlanMode) | ✅ | ✅ | jsonl 末尾 (`endsWithInteractiveToolUse`) |
| バッジ 入力待ち (Bash/Edit/Write の Yes/No 権限プロンプト) | ❌ | ✅ | marker (`hasAwaitingMarker`) |
| 音声: 完了 (completed) | ✅ | ✅ | `ai-processing → waiting` 遷移 |
| 音声: 途中経過 (progress) | ✅ | ✅ | ai-processing 継続が `progressAfterMs` 超 |
| 音声: 承認待ち (awaiting) — 対話ツール | ✅ | ✅ | `* → awaiting-user` (jsonl 末尾由来) |
| 音声: 承認待ち (awaiting) — 権限プロンプト | ❌ | ✅ | `* → awaiting-user` (marker 由来) |

**結論**: 「今 hook 入ってないけど音声再生はされている」は正しい挙動。完了 / 途中経過 / 対話ツールの
承認待ちは hook 非依存で鳴る。hook が足すのは **Bash/Edit/Write の権限プロンプトを「入力待ち」と
して検出する 1 点のみ**。

#### hook を入れる価値 (副作用の是正)

hook 無しで権限プロンプトが保留中のとき、jsonl は tool_use を書いた直後で mtime が新しいため
バッジは **AI処理中** 表示になり、30 秒応答が無いと **待機中** に落ちる。この
`ai-processing → waiting` 遷移は `VoiceEventDetector` が **`completed` (完了) と誤発話**する
(実際は承認待ちなのに「完了しました」と読み上げる偽陽性)。hook を入れると marker により
`awaiting-user` へ強制遷移し、偽の完了発話を抑止して正しく **承認待ち**を発話する。

## 対応方針

### Phase 1: hook をリポに vendor する
- `ai-monitor/hooks/ccm-awaiting-marker.py` を正本としてリポに取り込む (現行 `~/.claude/hooks/` の
  ものと同一内容)。これで「リポ未管理」を解消し、端末間で差分が出ないようにする。
- 配置先 (`/tmp/claude-code-manager/awaiting-input`) と marker スキーマは `awaiting-input.ts` の
  定義と一致させる (sessionId / tool_name / created_at)。

### Phase 2: セットアップスクリプト `scripts/setup-client.sh`
冪等に以下を行う:
1. **前提チェック**: `python3` の存在確認 (macOS は Xcode CLT / Homebrew が必要。無ければ案内して中断)。
   解決した **絶対パス** (`command -v python3`。Homebrew は `/opt/homebrew/bin/python3`) を settings.json の
   hook コマンドに書き込み、Claude Code が hook を起動するシェルの PATH に依存しないようにする
   (素の `python3` だと Homebrew のみの Mac で PATH 解決に失敗しうる)。
2. **hook 配置**: `ai-monitor/hooks/ccm-awaiting-marker.py` を `~/.claude/hooks/` に
   コピーし実行権限を付与。既存があれば内容比較し、差分時のみ上書き (バックアップを残す)。
3. **settings.json への hook 登録**: `~/.claude/settings.json` の
   `hooks.PermissionRequest` / `hooks.PostToolUse` / `hooks.Stop` に
   `python3 $HOME/.claude/hooks/ccm-awaiting-marker.py` を **既存 hook を壊さず** 追記する。
   - 既存の `notify-*.py` 等を消さない / 二重登録しない冪等マージが必須。
   - JSON 編集は python3 で行う (jq 非依存)。書き込み前に `settings.json.bak` を作る。
4. **`.env` 雛形**: `.env` が無ければ `.env.example` をコピーし、client モードに必要な
   `CCM_SERVER_URL` / `CCM_CLIENT_TOKEN` / `CCM_CLIENT_LABEL` を埋めるよう案内 (値は対話入力 or 手編集)。
5. 完了後、次の一歩 (`./run-voice-client.sh`) を表示。

### Phase 3: macOS 固有の確認
- プロセス検出: darwin (ps + lsof) は実装済み (DONE.md 参照)。hook 自体は OS 非依存の純 python。
- `~/.claude/settings.json` のパスと `/tmp/claude-code-manager/...` は macOS でもそのまま使える。
- `python3` の所在 (`/usr/bin/python3` は CLT 必須 / Homebrew は `/opt/homebrew/bin/python3`) を
  Phase 2 の前提チェックで吸収する。

### Phase 4: ドキュメント反映
- `CLAUDE.md` / `README.md` の client セットアップ節に「`scripts/setup-client.sh` を実行 → `.env`
  記入 → `run-voice-client.sh`」の流れと、上記 hook あり/なし比較表を追記する。

## 影響範囲

- 追加: `ai-monitor/hooks/ccm-awaiting-marker.py`, `scripts/setup-client.sh`。
- 変更: `CLAUDE.md`, `README.md` (ドキュメントのみ)。
- ユーザーのグローバル設定 `~/.claude/settings.json` / `~/.claude/hooks/` をスクリプト実行時に変更
  (バックアップ付き・冪等)。アプリ本体コード (`ai-monitor/src/*`) は変更しない。

## テスト方針

- **マージ冪等性**: setup スクリプトを 2 回実行しても settings.json の hook が二重登録されない / 既存
  `notify-*.py` が残ることを確認。空の settings.json・hook 未設定・既に登録済みの 3 ケースを試す。
- **hook 動作**: 任意プロジェクトで Bash 権限プロンプトを出し、
  `/tmp/claude-code-manager/awaiting-input/<session_id>.json` が生成 → 承認後に消えることを確認。
- **挙動確認**: ダッシュボードで権限プロンプト中に **入力待ち** バッジ + **承認待ち** 音声が出ること
  (hook 無し時に偽の **完了** が鳴っていたのが是正されること) を比較確認。
- 既存ユニットテスト (`awaiting-input` / `state` / `uplink`) は据え置き (本タスクはコード非変更)。

## 備考
- インフラ (公開サーバ / Cloudflare) はユーザー担当。本タスクは client 端末ローカルの初期設定に閉じる。
- 既存 hook の正本は現状 `~/.claude/hooks/ccm-awaiting-marker.py`。Phase 1 ではこれを基に vendor する。
