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

vibeboard と AI Monitor は別プロセスとして動かす。別ターミナルで両方を起動する。

```bash
# ターミナル 1: vibeboard (デフォルト port 8180)
./run-vibeboard.sh

# ターミナル 2: AI Monitor (デフォルト port 8181, 127.0.0.1 バインド)
./run-ai-monitor.sh
```

ブラウザで `http://localhost:8180` を開くと、左上のタブから **TODO / Plans / Specs / AI Monitor** が選べる。

## vibeboard.config.json

vibeboard 起動時に `vibeboard.config.json` を読み、`customTabs` 設定から AI Monitor タブを生成する。

```json
{
  "customTabs": [
    { "name": "ai-monitor", "label": "AI Monitor", "baseUrl": "http://127.0.0.1:8181" }
  ]
}
```

AI Monitor のポートを変える場合は `--port` で起動し、ここの `baseUrl` も同じポートに合わせる。

## 同時起動を 1 コマンドで

別ターミナルを開きたくない場合は、`concurrently` などで束ねる。

```bash
npx concurrently \
  --names vibeboard,ai-monitor \
  './run-vibeboard.sh' './run-ai-monitor.sh'
```

## 詳細

- プロジェクトの目的・要件は [`CLAUDE.md`](./CLAUDE.md)
- AI Monitor の設計・進捗は [`docs/plans/archive/ai-monitor.md`](./docs/plans/archive/ai-monitor.md)
- vibeboard customTabs 拡張の仕様は [`docs/specs/vibeboard-custom-tabs.md`](./docs/specs/vibeboard-custom-tabs.md)
