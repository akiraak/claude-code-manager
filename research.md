# 複数 Claude CLI の監視 — 実現可能性調査

複数の Claude CLI がそれぞれのディレクトリで動いている状況で、「各インスタンスが過去に何をしてきたか・今何をしているか」を把握する監視用 Claude Code を動かせるかを調査した結果。

結論: **実現可能**。必要な情報源はすべてローカルファイルとして揃っている。

## 利用できる情報源

### 1. 動いている Claude プロセスの特定

```bash
pgrep -af claude              # 動いている Claude CLI の PID 一覧
readlink /proc/<PID>/cwd      # それぞれの作業ディレクトリ
```

調査時点での実例 (4 プロセス):

| PID    | cwd                                |
| ------ | ---------------------------------- |
| 257204 | `/home/ubuntu/ai-twitch-cast`      |
| 303067 | `/home/ubuntu/deep-pulse`          |
| 744375 | `/home/ubuntu/voice-changer-lab`   |
| 795822 | `/home/ubuntu` (調査を担当した自分) |

### 2. 各 Claude の活動ログ (transcript)

パス:

```
~/.claude/projects/<cwd を / → - でエンコードしたディレクトリ>/<session-id>.jsonl
```

例: `voice-changer-lab` の現セッション
→ `/home/ubuntu/.claude/projects/-home-ubuntu-voice-changer-lab/fc17bb8d-….jsonl`

中身は **1 行 1 JSON** のイベントログ。すべて入っている:

- `type: user` … ユーザ入力 / tool 結果
- `type: assistant` … Claude のテキスト応答, `tool_use` 呼び出し
- `type: system` … システムイベント
- 共通フィールド: `timestamp`, `cwd`, `sessionId`, ツール名 (`Bash`, `Edit`, …) と入出力

### 3. PID → アクティブ jsonl の対応付け

1. `/proc/PID/cwd` から作業ディレクトリを取得
2. 対応する `~/.claude/projects/-...-<dir>/` 内で **mtime が最新の `.jsonl`** が現役セッション
3. ファイルは追記モードで開閉される (`/proc/PID/fd` に常駐しない) ので、いつでも安全に読める

## 監視 Claude の実装案

### 最小構成 (対話)

別ターミナルで `claude` を 1 つ起動し、こんなプロンプトを投げれば即動く:

> `pgrep -af claude` で動いている Claude を列挙し、各 PID の `/proc/PID/cwd` から作業ディレクトリを取り、対応する `~/.claude/projects/*/` の最新 `.jsonl` の末尾を読んで、各インスタンスが今何をしているか・直近何をしてきたかを日本語で要約してください。30 秒ごとに繰り返してダッシュボード形式で表示。

### 自動化

- **`/loop` スキル**: 一定間隔で同じプロンプトを再投入 (例: `/loop 30s 各 Claude の状況を要約して`)
- **`tail -f`** をすべてのアクティブ jsonl にかけ、差分を流し込むストリーミング型
- **hook (`settings.json`)**: 各 Claude 側に `PostToolUse` などのフックを仕込み、活動を別所にログ出力させて監視側はそれを読むだけにする

## 注意点

- **アイドル中の Claude も「動いている」**
  プロセスは生きていても、最後のターンから何時間も経っていることが多い。実際、調査時点では `ai-twitch-cast` / `deep-pulse` は 1 日以上前から jsonl 未更新だった。mtime で「今アクティブか / 待機中か」を判別する必要がある。

- **transcript はターン終了後に書き出される**
  ストリーミング途中のテキストはファイルにまだ無い。「進行中のターンの中身」をリアルタイムに見るには hook など別の仕組みが必要。

- **ファイルが大きい**
  数十万トークン超のセッションが普通にあるので、毎回末尾だけ (`tail -n 200` 程度) 読むのが現実的。

- **複数セッション同居**
  1 つの cwd 配下に過去ログが大量に並ぶので、必ず mtime で絞り込む。

- **書き込み中の最終行が壊れている可能性**
  parse 失敗した行は捨てる前提で実装する。

## 参考: jsonl 1 行の構造 (抜粋)

`type: user` (tool 結果のケース):

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      { "tool_use_id": "...", "type": "tool_result", "content": "Updated task #5 status" }
    ]
  },
  "timestamp": "2026-05-12T19:05:01.040Z",
  "cwd": "/home/ubuntu/voice-changer-lab",
  "sessionId": "fc17bb8d-2e9f-436b-ba4c-6bed9b119da3"
}
```

`type: assistant` はテキスト本文 (`content[].type == "text"`) と `tool_use` 呼び出し (`content[].type == "tool_use"`, `name`, `input`) が混在する配列を持つ。
