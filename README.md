# claude-code-manager

複数の Claude Code CLI を一元管理するためのシステム。

## 構成

- `vibeboard/` — ローカル開発時の TODO / Plans / Specs を閲覧・編集する管理画面（upstream を fork として取り込み）
- `ai-monitor/` — 稼働中の Claude Code CLI を可視化する vibeboard customTabs プラグイン
- `docs/plans/` / `docs/specs/` — プラン・仕様
- `TODO.md` / `DONE.md` — タスク管理

## セットアップ

初回のみ、それぞれの依存をインストールしてビルドする。

```bash
(cd vibeboard && npm install && npm run build)
(cd ai-monitor && npm install && npm run build)
```

## 起動

`run-ai-monitor.sh` が vibeboard と AI Monitor の両方を起動する。既に起動中のプロセスがあれば停止してから起動し直す。

```bash
./run-ai-monitor.sh
```

- vibeboard: `http://localhost:8180` (環境変数 `VIBEBOARD_PORT` で変更可)
- AI Monitor: `http://127.0.0.1:8181` (環境変数 `AI_MONITOR_PORT` で変更可)

ブラウザで `http://localhost:8180` を開くと、左上のタブから **TODO / Plans / Specs / AI Monitor** が選べる。Ctrl-C で両方まとめて終了する。

## vibeboard.config.json

vibeboard 起動時に `vibeboard.config.json` を読み、`customTabs` 設定から AI Monitor タブを生成する。

```json
{
  "customTabs": [
    { "name": "ai-monitor", "label": "AI Monitor", "baseUrl": "http://127.0.0.1:8181" }
  ]
}
```

AI Monitor のポートを変える場合は `AI_MONITOR_PORT=<N> ./run-ai-monitor.sh` で起動し、ここの `baseUrl` も同じポートに合わせる。

## ダッシュボードの状態バッジ

ダッシュボードカード左上の色付きバッジは、各 CLI セッションの現在状態を 4 種類で示す。判定ロジックは `ai-monitor/src/state.ts` の `classifyV2`。

| バッジ | 色 | 装飾 | 条件 |
|---|---|---|---|
| **AI処理中** | 緑 | 脈動 | CLI 生存 + 直近 30 秒以内に jsonl 更新あり |
| **入力待ち** | オレンジ | 脈動 | CLI 生存 + (末尾が `AskUserQuestion` / `ExitPlanMode` の未一致 `tool_use`) **または** (Bash/Edit/Write 等の権限プロンプト保留中 = PermissionRequest hook marker あり) |
| **待機中** | 黄 | 静止 | CLI 生存 + 上記以外 (アイドル / 通常のターン終了) |
| **停止** | 灰 | 静止 | CLI 消滅。プロセス終了後 10 分だけ表示に残る (`STOPPED_RETENTION_SEC=600`) |

緑 / オレンジ の脈動 = AI 側 / ユーザー側 のどちらかに「今すぐ動く必要がある」アクション。
入力待ち (オレンジ) は AskUserQuestion / ExitPlanMode の明示的ブロッカーに加え、Bash / Edit / Write 等の Yes/No 権限プロンプトも検出する。通常の AI ターン終了は 待機中 で出るので、複数 CLI を並行運転していても 入力待ち が乱発しない。

権限プロンプトの検出はグローバル hook (`~/.claude/hooks/ccm-awaiting-marker.py`) 経由で行う。`PermissionRequest` で `/tmp/claude-code-manager/awaiting-input/<session_id>.json` を置き、`PostToolUse` / `Stop` で消す。AI Monitor はそれを読み取り、`fs.watch` で変化を即座に SSE へ反映する。

突き合わせキーは `~/.claude/projects/<projectDir>/` の `projectDir`。CLI 起動後にユーザーが `cd` してもセッションは 1 枚のカードにまとまる。

## AI 要約 (オプション)

AI Monitor のダッシュボードカードに「セッションは今何をしていてどこまで進んだか」を 1〜2 行で表示する要約機能を持つ。これはオプションで、有効化するには Anthropic API キーをリポジトリ直下の `.env` に置く。

```bash
# claude-code-manager/.env (gitignore 済み)
ANTHROPIC_API_KEY=sk-ant-...
```

- モデルは `claude-haiku-4-5-20251001` 固定 (コスト感度を優先)
- 要約は `(jsonlPath, mtimeMs)` 単位でメモリにキャッシュされ、同じセッションの同じ状態で再計算は走らない
- キー未設定でもサーバは起動し、カードには「(要約: API キー未設定)」と薄色で表示される
- キー不正 (4xx) は黙って `unavailable` 扱い、ネットワーク / 5xx は次の jsonl 更新時に再試行される

## 詳細

- プロジェクトの目的・要件は [`CLAUDE.md`](./CLAUDE.md)
- AI Monitor の設計・進捗は [`docs/plans/archive/ai-monitor.md`](./docs/plans/archive/ai-monitor.md)
- vibeboard customTabs 拡張の仕様は [`docs/specs/vibeboard-custom-tabs.md`](./docs/specs/vibeboard-custom-tabs.md)
