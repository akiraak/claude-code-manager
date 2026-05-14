# README.md 更新 (アプリ説明 + 使い方 + 古い数値修正)

対象 TODO:

- `README.md にアプリの説明と使い方を入れて更新`

## 目的・背景

`README.md` は初期に作ったあと、機能追加 (24h retention / 起動中・停止 2 セクション / 要約の長尺化 / 再要約ボタン / 折りたたみ / stale 表示 / 権限プロンプト検出 etc.) が走ったが、本文は追従していない。実装と README の食い違いがあり、初見でリポジトリに触る人が**正しい挙動を把握できない**。

具体的に古い / 不足している記述:

1. **`STOPPED_RETENTION_SEC = 600` (= 10 分) と書いてあるが、実装は `86_400` (= 24 時間)**  
   `ai-monitor/src/state.ts:43`
2. **AI 要約を「1〜2 行で表示」と書いてあるが、実装は「4〜6 行 / 400〜600 文字」**  
   `ai-monitor/src/summarize.ts:55` のシステムプロンプト、`RESPONSE_MAX_TOKENS = 1000`
3. **AI処理中 バッジの条件**: 「AI 非介在のローカルコマンド直後 (`/clear` `! ls` 等) は除く」と CLAUDE.md にあるが README には未記載
4. **要約の最近機能が未記載**: 再要約ボタン / 折りたたみ展開 / 「要約 (古い):」プレフィックス (stale)
5. **ダッシュボードが 起動中 / 停止 の 2 セクションに分かれている**ことが未記載
6. **「使い方」が薄い**: vibeboard 各タブ (TODO / Plans / Specs) で何ができるか、AI Monitor ダッシュボード / プロセス詳細ビューで何を見るか、の動線が書かれていない
7. **動作環境 / 前提**: Node のバージョン要件 (vibeboard / ai-monitor の package.json 参照)、Claude Code CLI が `~/.claude/projects/` を書く前提、グローバル hook の存在 (`~/.claude/hooks/ccm-awaiting-marker.py`) が未明示
8. **トラブルシュート / FAQ**: ポート競合時の対処、hook が未配置の場合の挙動 (権限プロンプト未検出) が記載なし
9. **開発フロー**: ビルド / テスト (`(cd ai-monitor && npm test)`) / 単体テストの場所 が未記載

加えて、アプリそのものの「何を解決するためのものか」「ユーザー視点で何が見えるか」が一文ずつしかない。`CLAUDE.md` には書いてあるが、README は外向きの顔なので独立して読めるべき。

## ゴール

- 実装と一致した数値・条件に修正する (上記 1〜5)
- README 単体で「これは何で、何ができて、どうやって使うか」が分かる構成にする
- `CLAUDE.md` への参照は残しつつ、生情報は README にも含める
- 新規セクション (動作環境 / トラブルシュート / 開発) を追加する
- 文体は既存の README (です・ます調なし、断定調) に揃える

## 非ゴール

- スクリーンショットの追加 (画像は本タスクのスコープ外。差し込み位置だけ確保するかどうかも実装時に判断する)
- 英訳 (現状の日本語 README を維持)
- アーキテクチャ図 / シーケンス図の追加 (既に `docs/plans/archive/ai-monitor.md` 等にあるのでリンクで誘導)
- README をリポジトリ上で公開ドキュメント化する (GitHub Pages 等)
- 採用ライセンスの再検討 (LICENSE は触らない)
- `CLAUDE.md` の改修 (README とは別軸の保守)

## 対応方針

`README.md` を **section 単位で書き換える**。差分が大きすぎるとレビューしづらいので、目次レベルで Phase に分けて 1 セクションずつ着手する。

### 想定する最終目次 (案)

1. タイトル + 1〜2 段落の概要 (= 解決したい課題 / 提供する UI の要点)
2. **動作環境 / 前提** (新規) — Node / Claude Code CLI / Anthropic API キー (任意)
3. 構成 (現状の `## 構成` を維持、補強)
4. セットアップ (現状維持、Node バージョン注記を追加)
5. 起動 (現状維持、出力ログ例の項目を実装に揃える)
6. **使い方** (新規 or 大幅拡充)  
   6.1 vibeboard タブ (TODO / Plans / Specs / AI Monitor) の役割と操作  
   6.2 AI Monitor ダッシュボード (起動中 / 停止 の 2 セクション、カードの構成要素、要約 UI)  
   6.3 AI Monitor プロセス詳細ビュー (jsonl 末尾を時系列に表示。tool グループ化は別 TODO 進行中)
7. ダッシュボードの状態バッジ (現状維持、AI処理中 にローカルコマンド除外を追記)
8. AI 要約 (オプション) — 長さ / 再要約 / 折りたたみ / stale 表示 を追記
9. **`vibeboard.config.json`** (現状維持)
10. **権限プロンプト検出のための hook** (新規 or 既存セクション内) — `~/.claude/hooks/ccm-awaiting-marker.py` の存在を明記し、未配置時の挙動 (Bash/Edit/Write の Yes/No 待ちが「待機中」になる) を書く
11. **開発** (新規) — `(cd ai-monitor && npm test)` / `(cd vibeboard && npm test)` 等
12. **トラブルシューティング** (新規) — ポート競合、hook が反応しない、要約が出ない 等
13. 詳細リンク (現状維持 + 整理)

### Phase 1: 古い数値・条件の修正 (= 嘘を消す)

- `STOPPED_RETENTION_SEC=600` の 10 分記述を **86400 秒 / 24 時間** に修正
- 要約「1〜2 行」を **4〜6 行 / 400〜600 文字** に修正
- バッジ表の AI処理中 条件に「AI 非介在のローカルコマンド (`/clear`, `! ls` 等) 直後は除く」を追記
- 要約モデル名 / `RESPONSE_MAX_TOKENS` 等の細かい数値は CLAUDE.md と同期 (実装ファイルを正として)

### Phase 2: アプリ説明セクションの拡充

- 冒頭 1 段落を 2〜3 段落に拡張: 「なぜ作ったか」「何が見られるか」「対象ユーザー」
- 「動作環境 / 前提」セクションを新設:
  - Node.js のバージョン (`ai-monitor/package.json` / `vibeboard/package.json` の `engines` を確認して記載)
  - Claude Code CLI 自体は別途インストール済みである前提
  - `~/.claude/projects/` に jsonl が書かれることが動作前提
  - `.env` に置く Anthropic API キーは任意 (要約のみ)
  - 動作確認 OS: Linux / macOS (WSL2 想定)。Windows ネイティブは未検証

### Phase 3: 「使い方」セクションの新設・拡充

- vibeboard 各タブ (TODO / Plans / Specs / AI Monitor) でできることを箇条書きで
  - TODO タブ: `TODO.md` / `DONE.md` のプレビュー + 編集 (mtime 楽観ロック / 409 / SSE 即時反映)
  - Plans / Specs タブ: `docs/plans/` / `docs/specs/` 配下の Markdown 一覧 + プレビュー
  - AI Monitor タブ: customTabs 経由で `http://127.0.0.1:8181` を埋め込み
- AI Monitor ダッシュボードの読み方:
  - 起動中 / 停止 の 2 セクション (停止は 24h で消える)
  - カードの構成 (バッジ / cwd / PID / 直近の user 入力 / 直近の Claude 応答 / 要約)
  - 要約 UI 操作 (要約 ボタン / 展開 / 再要約 / 古いとき (stale) 表示)
- AI Monitor プロセス詳細ビューの読み方:
  - jsonl 末尾 200 件を時系列で表示
  - SSE で自己更新、末尾追従スクロール
  - 注釈: ターン単位グルーピングは別 TODO で進行中 ([plan](process-view-tool-grouping.md))

### Phase 4: 「開発」「トラブルシューティング」セクションの新設

- 開発:
  - テスト実行: `(cd ai-monitor && npm test)`, `(cd vibeboard && npm test)`
  - ビルド単体: `(cd ai-monitor && npm run build)`
  - tsconfig: `strict` 有効
  - プラン管理ルール (= 作業着手ルール) の存在を `CLAUDE.md` への参照で記載
- トラブルシューティング:
  - ポート競合: `VIBEBOARD_PORT` / `AI_MONITOR_PORT` で変更 + `vibeboard.config.json` の `baseUrl` 同期
  - hook が反応しない (権限プロンプトが「待機中」になる): `~/.claude/hooks/ccm-awaiting-marker.py` が配置されているか確認
  - 要約が出ない: `.env` の `ANTHROPIC_API_KEY` 確認 / 4xx は黙って unavailable / 5xx は次の jsonl 更新で再試行
  - 停止カードが残り続ける: 24h retention 仕様 (= バグではない)

### Phase 5: 仕上げ

- 全体の見出しレベルを揃える (`##` / `###`)
- 内部リンク (`./CLAUDE.md` / `./docs/plans/...`) の生存確認
- 既存リンク先 `docs/plans/archive/ai-monitor.md` 等が `archive/` に移動済みかを `git ls-files` で確認 (壊れていたらリンクを直す or 削除)
- 文体の最終チェック (です・ます調なし、断定調)

## 影響範囲

- `README.md` のみ (本文構成 + 内容)
- 他のドキュメント (`CLAUDE.md` / `docs/`) は触らない
- 実装コードは触らない

## Phase / Step 分割

### Phase 1: 古い数値・条件の修正

- [ ] 1-A. `STOPPED_RETENTION_SEC` の 10 分 → 24 時間 / 86400 秒 修正
- [ ] 1-B. 要約「1〜2 行」→「4〜6 行 / 400〜600 文字」修正
- [ ] 1-C. AI処理中 バッジ条件に「ローカルコマンド直後を除く」追記
- [ ] 1-D. 要約モデル / max_tokens 等の数値を実装と同期

### Phase 2: アプリ説明の拡充

- [ ] 2-A. 冒頭の概要を 2〜3 段落に拡張 (なぜ作ったか / 何が見られるか / 対象ユーザー)
- [ ] 2-B. 「動作環境 / 前提」セクションを新設 (Node / Claude Code CLI / `~/.claude/projects/` 前提 / `.env` 任意 / WSL2 想定)

### Phase 3: 「使い方」の新設・拡充

- [ ] 3-A. vibeboard 各タブ (TODO / Plans / Specs / AI Monitor) の役割と操作を箇条書きで
- [ ] 3-B. AI Monitor ダッシュボード読み方 (2 セクション / カード構成 / 要約 UI 操作)
- [ ] 3-C. AI Monitor プロセス詳細ビュー読み方 (jsonl 末尾 200 件 / SSE 自己更新 / ターングルーピング別 TODO への注釈)

### Phase 4: 開発 / トラブルシュート

- [ ] 4-A. 「開発」セクション (テスト / ビルド / 作業着手ルール参照)
- [ ] 4-B. 「トラブルシューティング」セクション (ポート競合 / hook 未配置 / 要約未表示 / 停止 24h)

### Phase 5: 仕上げ

- [ ] 5-A. 内部リンクの生存確認 (`docs/plans/archive/...` などが壊れていれば修正)
- [ ] 5-B. 見出しレベル / 文体の最終チェック
- [ ] 5-C. 全体読み直して 1 サイクル

## やらないこと (スコープ外)

- スクリーンショット / GIF の差し込み
- README の英訳
- `CLAUDE.md` の改修
- 実装コードの変更
- LICENSE / リポジトリメタ情報の変更
- アーキテクチャ図 / シーケンス図の追加 (既存 docs/plans/archive/ へのリンクで誘導)
