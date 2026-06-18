# 調査: Claude Code 作業中にサーバが止まる原因

## 目的・背景

`./run-ai-monitor.sh` で起動した ai-monitor / vibeboard が、Claude Code を使った作業中に
気付くと両方とも止まっている、という報告。原因を切り分けて、再発防止の選択肢を出す。

実際に「今」の状態を確認したところ、`pgrep -af 'ai-monitor|vibeboard'` で 0 件、
`ss -tln` で 8180 / 8181 ともリスナ無し。直近の起動ログ (TODO に貼られているもの) では
両方とも起動成功していたので、起動後どこかで死んだのは確定。

## 調査範囲

- `run-ai-monitor.sh` 起動スクリプトの構造
- `ai-monitor` の Node プロセス内部のエラー処理
- システム側のヒント (OOM / セッション切断)

## 観測したこと

1. `run-ai-monitor.sh` の構造（fragile）
   - `wait -n` 採用。**片方の子プロセスが死ぬと親シェルも exit する**。
   - `trap cleanup EXIT INT TERM` で、シェル exit 時に残った子も kill する。
     → 片方が落ちると、健在だったもう片方も巻き添えで死ぬ。
   - フォアグラウンド実行。`nohup` も `setsid` も使っていない。
     → 起動したターミナルが SIGHUP を受けたら（WSL の接続切れ / ターミナル閉鎖）両方落ちる。
   - 標準出力 / 標準エラーをファイルに残していない。**死後検死ができない**。
   - 自動再起動なし。

2. Node プロセス内部の例外パス（個別には基本的に握りつぶされている）
   - `server.ts` の各 route handler: try/catch で握りつぶし
   - SSE `/api/watch` の `tick` / ping: try/catch で握りつぶし
   - `Summarizer.startCompute`: `.catch()` で SummaryResult.error に変換
   - `awaiting-input.ts` の `fs.watch`: try/catch + `watcher.on('error')`
   - `processes.ts` の `listClaudeProcesses`: pgrep が exitcode=1 (no match) なら空配列、
     **それ以外のエラーは throw する**。ただし呼び出し元 (`buildEntries`) は SSE/route の try/catch
     に守られているので、これ自体で process は死なない。
   - `cli.ts`: `startServer(opts)` のあと **`process.on('uncaughtException')` / `'unhandledRejection'`
     ハンドラを登録していない**。万一漏れた場合、デフォルト挙動で Node プロセスは終了する
     (Node 15 以降の既定)。

3. システム
   - `dmesg` に OOM 痕跡なし。`free -h` 上は余裕あり (used 2.9G / total 15G)。
   - 直近の `last` / `who` から見える限り、SSH/WSL セッション断は無さそう。

## 仮説 (確からしさ順)

A. **起動シェルが SIGHUP / 切断を受けて落ち、`trap cleanup` で両方 kill された**
   - 一番説明能力が高い。WSL ターミナル閉鎖、ssh セッション切断、誤って `Ctrl+C` 等。
   - 「Claude Code 作業中に止まる」のは、Claude Code を起動したターミナルとは別の
     ターミナルでスクリプトを動かしていて、そちらを閉じた／切れた可能性。

B. **片方の子プロセスがクラッシュ → `wait -n` で親 exit → 健在側も巻き添え**
   - tick / route の try/catch は厚いが、SDK 内部の Promise 漏れ等が起きると `uncaughtException`
     未登録なので Node がそのまま落ちる。
   - 死後ログが残らないため、クラッシュ時の原因切り分けは現状不可能。

C. **WSL のセッション層が一時的にプロセスを掃除した**
   - 痕跡は今回見つからなかった。可能性としては薄いが完全には否定できない。

## 提案する打ち手 (実装はユーザーに確認してから)

P1. **死因を捕まえる**: `run-ai-monitor.sh` を改修
   - 標準出力 / 標準エラーを `logs/ai-monitor.log` / `logs/vibeboard.log` に tee
   - `wait -n` をやめて、各 PID を独立に監視し落ちた側だけ報告
   - 片方が落ちた場合の自動再起動 (最大 N 回 / バックオフ)
   - 任意: `setsid` でセッションを分離し、起動シェルの SIGHUP に巻き込まれないようにする

P2. **Node 側の安全網**: `cli.ts` に
   - `process.on('uncaughtException', err => { console.error(...); })`
   - `process.on('unhandledRejection', err => { console.error(...); })`
   登録して、ログに痕跡が残るようにする (落とすか継続するかは要検討)。

P3. **systemd --user で常駐させる** (任意・大改修)
   - WSL でも `systemctl --user` は使える。Restart=on-failure で勝手に立ち直る。
   - スクリプト改修より一段重いので、P1 で十分かは要相談。

## テスト方針

- P1 のログ出力は、いったん `kill -9` で片方を落として両ログが残るか / 自動復活するかを目視
- P2 は throw を埋め込んで dev 起動して、ログに出ること & プロセス継続することを確認
