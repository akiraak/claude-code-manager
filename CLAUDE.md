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
upstream を本リポに fork として取り込み済み（`./vibeboard/`）。改修は本リポで直接コミットする。
upstream への反映は後追いで行う。

```bash
# 親プロジェクト直下から（初回のみ依存をインストール / ビルド）
(cd vibeboard && npm install && npm run build)
(cd ai-monitor && npm install && npm run build)
# 起動は run-ai-monitor.sh が vibeboard + AI Monitor をまとめて立ち上げる
./run-ai-monitor.sh
```

`http://localhost:8180` でプロジェクト直下の `docs/plans/`・`docs/specs/`・`TODO.md`・`DONE.md` を閲覧・編集できる。

- `TODO` タブで `TODO.md` / `DONE.md` をプレビュー表示・編集できる
  - 編集は楽観ロック（mtime チェック）付き。外部で先に更新されていた場合は保存時に 409 を返し、リロード / 手元維持 / 強制上書き を選べる
  - `fs.watch` + 2 秒ポーリングで外部変更を検知し、SSE でクライアントへ即時反映する
- ローカル開発専用（本番管理画面とは独立）
- ポート変更は `VIBEBOARD_PORT` 環境変数で指定可能（デフォルト 8180）

## AI Monitor (vibeboard customTabs プラグイン)

稼働中の Claude Code CLI を vibeboard 上で可視化するためのサーバ。`./ai-monitor/` に実装がある。`run-ai-monitor.sh` が vibeboard と一緒に起動する（別プロセス）。

```bash
# 初回のみ依存をインストール / ビルド
(cd ai-monitor && npm install && npm run build)
# 起動 (vibeboard 8180 + ai-monitor 8181 をまとめて立ち上げる)
./run-ai-monitor.sh
```

- `vibeboard.config.json` の `customTabs` に AI Monitor のエントリ（`baseUrl: http://127.0.0.1:8181`）を登録済み。vibeboard 起動時に **AI Monitor** タブとして読み込まれる
- `run-ai-monitor.sh` は既に起動中の vibeboard / ai-monitor を `pgrep -f` で検出し、停止してから起動し直す
- ポート変更は `VIBEBOARD_PORT` / `AI_MONITOR_PORT` 環境変数で指定可能。AI Monitor 側を変えた場合は `vibeboard.config.json` の `baseUrl` も合わせる
- 読み取り専用。`~/.claude/projects/*/*.jsonl` と `/proc` のみを参照し、書き込み API は持たない

### ダッシュボードの状態バッジ

カード左上のバッジで 1 セッションの現在状態を 4 種類で示す。判定は `ai-monitor/src/state.ts` の `classifyV2`。

| バッジ | 色 | 装飾 | 条件 |
|---|---|---|---|
| AI処理中 | 緑       | 脈動 | CLI 生存 + 直近 30 秒以内に jsonl 更新あり |
| 入力待ち | オレンジ | 脈動 | CLI 生存 + 末尾が `AskUserQuestion` / `ExitPlanMode` の未一致 `tool_use` のみ |
| 待機中   | 黄       | 静止 | CLI 生存 + 上記以外 (アイドル / 通常のターン終了) |
| 停止     | 灰       | 静止 | CLI 消滅 (10 分だけ残る = `STOPPED_RETENTION_SEC = 600` 秒) |

入力待ち は **明示的なユーザー応答ブロッカーのみ** に限定する方針 (通常の AI ターン終了は 待機中)。
旧 `error` state は、対話ツール選択中に `/exit` した場合と本物のクラッシュを区別できず偽陽性が出るため `stopped` に統合した。
突き合わせキーは `projectDir` (= `~/.claude/projects/<projectDir>/`)。セッション中に `cd` しても projectDir は不変なので 1 セッションが 1 カードにまとまる。

### AI 要約 (オプション)

ダッシュボードのカードに「セッションは今何をしていてどこまで進んだか」を Claude API で 1〜2 行に要約して表示する。

- リポジトリ直下の `.env` (gitignore 済み) に `ANTHROPIC_API_KEY=...` を置くと有効になる。`ai-monitor` 起動時に `dotenv` で読む
- モデル: `claude-haiku-4-5-20251001` 固定
- キャッシュは `(jsonlPath, mtimeMs)` 単位のメモリ Map。サーバ再起動で消える
- キー未設定でもサーバは落ちず、カードに「(要約: API キー未設定)」が薄色表示される
- 要約完了は SSE (`event: item-changed { id: 'dashboard' }`) でクライアントへ push され、カードが自動更新される

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
