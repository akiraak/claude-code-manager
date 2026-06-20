# run-voice-client.sh を run-ai-monitor-client.sh にリネーム

## 目的・背景

`run-voice-client.sh` は `--mode client` を起動するスクリプトだが、実際には音声を生成・再生しない。
client がやるのは「この端末のセッション状態を server へ push する」ことと「ローカルダッシュボード
（local 表示・**音声なし**）を開く」ことだけで、音声生成（Haiku 台本 + Gemini TTS）と音声 UI は
すべて server 側（`run-ai-monitor.sh`）の責務。

もともとは `run-voice-server.sh`（音声本体）と `run-voice-client.sh` の対だったが、コミット `52baae8`
で server 側を `run-ai-monitor.sh` に統合・廃止したため、"voice-" のペア構造が崩れ client 側だけ
古い命名が残った。相方の `run-ai-monitor.sh` と対になるよう `run-ai-monitor-client.sh` に改名する。

## 対応方針

1. `git mv run-voice-client.sh run-ai-monitor-client.sh`
2. スクリプト内部: 起動ログ文言、ログファイル名 `voice-client.log` → `ai-monitor-client.log`
   （`ai-monitor-server.log` と対になり、同じ命名ズレの再発を防ぐ）
3. 運用ドキュメント／スクリプトの参照を更新:
   - `run-ai-monitor.sh`（ガイド文・コメント）
   - `CLAUDE.md`
   - `README.md`（ログファイル名 `voice-client.log` も）
   - `.env.example`
   - `scripts/setup-client.sh`（コメント・案内表示）
4. 履歴記録は据え置き: `DONE.md` と `docs/plans/archive/*` は「その時点の事実」の記録なので変更しない
   （`run-voice-server.sh` 等いまは存在しない名前も含むため、書き換えると履歴が不正確になる）
5. `docs/plans/voice-frequency-investigation.md:43` は「計測時点」の取得元ファイル名の記録（既に
   server 側も旧名 `logs/voice-server.log` のまま）なので据え置く。client 側だけ書き換えると計測が
   実際に読んだファイルを誤って表すため触らない。

## 影響範囲

- ファイル名変更 1 つ + 上記ドキュメント／スクリプトのテキスト置換のみ。ロジック変更なし。
- ログファイル名が変わるため、過去の `logs/voice-client.log` は次回起動以降は作られない（gitignore 済み・実害なし）。

## テスト方針

- `bash -n run-ai-monitor-client.sh` で構文チェック。
- リネーム後に `grep -rn run-voice-client`（履歴記録を除く）が 0 件であることを確認。
