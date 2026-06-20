# client モードのターミナル表示を増やす（案）

## 目的・背景

`--mode client`（`./run-voice-client.sh`）で起動した端末のターミナルは、**起動直後の数行を出したあとは正常時ほぼ無言**になる。何が監視されていて、いま各セッションがどの状態で、いつ「開始 / 完了 / 入力待ち / 途中経過」が発火したのか（＝サーバへ送って音声化される素）が、その端末を開いている本人には全く見えない。

本プロジェクトの主目的は「複数の Claude Code CLI を同時に走らせると、どの CLI が何をやっていたか分からなくなる混乱を防ぐ」こと。client 端末のターミナルにもその情報を出せば、ブラウザを開かずに手元の端末だけで状況が掴める。

### 現状の出力（client モード）

| タイミング | 出力 | 頻度 |
|---|---|---|
| 起動時 | `[ai-monitor] mode: client` / `[uplink] 起動: server=… label=… interval=… mirror=…` | 1 回 |
| 初回接続 / 復帰 | `[uplink] サーバ接続OK / 復帰` | 遷移時のみ |
| 429 / 送信失敗 | `[uplink] snapshot レート制限…` / `送信失敗…バックオフ` | 異常時のみ |
| voice キュー | `voice キュー満杯…破棄` / `voice-event 恒久エラー…破棄` | 異常時のみ |
| dryrun | `[uplink][dryrun] POST /api/ingest/…`（全 POST） | dryrun のみ |

→ **正常稼働中は実質サイレント**。送信は流れているのに本人には何も見えない。

## 対応方針（案：A〜G）

`log` コールバックは既に `deps.log` で uplink 全体へ通っており、追加は `tickOnce` / `startUplink` への数行で済む。純関数（histogram 整形・行フォーマット）に切り出してテストする。

### 案A：状態遷移イベントのライブ表示　★最優先

`detector.observe()` が返す voice イベント（`started` / `completed` / `awaiting` / `progress`）を、enqueue するループでそのまま 1 行ずつ出す。**これがサーバで音声化される素そのもの**なので「いま手元の端末が何を喋らせたか」が一致する。遷移時のみ＝低頻度・高信号。

```
[uplink] ▶ 開始   claude-code-manager  「todo の…をやる」
[uplink] ✓ 完了   claude-code-manager  setup-client.sh を追加
[uplink] ⏸ 入力待 vibeboard            権限プロンプト待ち
[uplink] … 途中   ai-twitch-cast       12 分経過 / テスト実行中
```

- 既存の kind ラベル（`persona.ts`: 作業開始/作業完了報告/承認・入力待ち/途中）と整合させる。
- detail は redaction 済みの `lastUserText` / `lastAssistantText` を 1 行（〜40 字）に短縮。
- 実装位置：`createUplinkRunner` の `for (const ev of detector.observe(...)) queue.enqueue(ev)`。

### 案B：定期ステータスサマリ行（ハートビート）

ヒストグラムが変化したとき、または最後の出力から一定時間（既定 30s）経過したときに、監視中セッションの状態内訳を 1 行で出す。常に「今の全体像」が分かる。

```
[uplink] 12:34:05  監視3  🟢AI処理1 🟠入力待1 🟡待機1 ⚪停止0  送信OK voiceQ:0
```

- スロットル必須（毎 tick=4s は煩い）。「変化時 or 30s 経過」で抑制。
- `voiceQ` はキュー残数、`送信OK/断` は connected フラグ。

### 案C：スナップショット送信サマリ

成功送信は今サイレント。tick ごとに送った件数を定期ロールアップ（`送信 5 件 = 変化3 / heartbeat2`）。主にデータが流れている確認・デバッグ向け。値は A/B より低め。

### 案D：起動バナーの拡充

今 1 行の起動ログを複数行に。mode / server host / label / interval / mirror allowlist / progress しきい値 / dryrun / voiceQ 上限をまとめて出す。1 回限りだが設定ミスに気づける。

### 案E：詳細度の env 切り替え

`CCM_CLIENT_VERBOSE`（per-tick 詳細）/ `CCM_CLIENT_QUIET`（A だけ等）で既定はクリーンに保ちつつ段階を選べる。A/B を入れる前提のスイッチ。

### 案F：TTY 固定ステータス行（下部 1 行を上書き更新）

`process.stdout.isTTY` のとき、画面下部に 1 行のライブ更新行（`\r` 上書き）で現状態を出し、遷移ログ（案A）はその上にスクロールさせる。プログレスバー風で UX 最良。パイプ時は無効化（TTY 判定必須）なのでやや複雑。

### 案G：状態の色付け（ANSI）

ダッシュボードのバッジ色（緑/橙/黄/灰）に合わせて状態を着色。TTY 時のみ。A/B/F の可読性を上げる補助。

## 推奨

**A（遷移ライブ） + B（定期サマリ） + D（起動バナー）** を本命に、**E（verbose/quiet）** で既定をうるさくしない。**G（色）** は TTY 時の上乗せ。**C/F** は後回し（C はデバッグ用途、F は実装コスト高）。

理由：A が「どの CLI が何を」を最小実装で埋め、B が全体像、D が設定確認。いずれも `tickOnce`/`startUplink` への数行追加 + フォーマット純関数で収まり、`local`/`server` には影響しない。

## 影響範囲

- `ai-monitor/src/uplink.ts`（`createUplinkRunner` / `startUplink` にログ追加、フォーマット純関数を追加）
- 設定追加時のみ `loadClientConfig`（E の env）+ `cli.ts`
- `local`/`server` モードは不変

## テスト方針

- フォーマット純関数（遷移行・ヒストグラム行・バナー）を `uplink.test.ts` に単体追加。
- `tickOnce` を注入 `log` で叩き、遷移時に期待行が出る / サマリがスロットルされることを確認。
- TTY 系（F/G）は `isTTY` 分岐の純粋部分のみ単体化。

## 実装結果（2026-06-19）

ユーザー選択により **A + B + D のみ** を実装（C/E/F/G は見送り＝色 ANSI・env 切替・送信サマリ・TTY 固定行）。

- 案A: `formatTransitionLine()` を追加し、`createUplinkRunner.tickOnce` の voice イベント enqueue ループでライブ表示。started はユーザー指示を「」で括る・progress は経過分を前置・detail は 1 行 40 字で `…` 切り。
- 案B: `buildStateHistogram()` / `summarySignature()` / `formatSummaryLine()` を追加し、tick 末で「状態が変わったとき or `SUMMARY_EVERY_MS`(30s) 経過」で 1 行サマリ（`監視N 🟢AI処理.. 🟠入力待.. 🟡待機.. ⚪停止.. 送信OK/断 voiceQ:N`）。監視数は停止を除く稼働中件数。
- 案D: `formatStartupBanner()` を追加し、`startUplink` の 1 行起動ログを送信先/ラベル/間隔/ミラー/途中経過しきい値/voiceキュー上限の複数行バナーに置換。
- 変更は `ai-monitor/src/uplink.ts` のみ（純関数 + `tickOnce`/`startUplink` 数行）。`local`/`server` モードは不変。
- テスト: `uplink.test.ts` に純関数 + tickOnce ログの単体を追加（全 168 pass・`tsc` クリーン）。dryrun スモークで banner / `監視1 🟢AI処理1 … 送信OK voiceQ:0` を確認。
- 見送り（C/E/F/G）は将来やる場合の候補として本ファイルに残す。
