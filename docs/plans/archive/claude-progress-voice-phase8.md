# Phase 8: 仕上げ（redaction/保持の確認・ドキュメント・E2E・整理）

親プラン: [claude-progress-voice.md](claude-progress-voice.md)
前フェーズ: [phase7](claude-progress-voice-phase7.md)（デプロイ成果物）

Phase 8 のゴールは「redaction/保持が実装どおり効いていることを確認し、CLAUDE.md / README を
モード対応に更新、ローカル E2E（client→server ループバック）で経路を実証、TODO/DONE 整理 + プラン archive」まで。

## 調査結果（redaction / 保持は実装・配線済み → コード変更不要）

src 実走査で確認:
- **redaction**: `uplink.ts` のシリアライズが全送信テキストに `sanitizeText`(redact→truncate) を適用。
  - snapshot tail: `TAIL_TEXT_MAX=2000` / events: `EVENT_TEXT_MAX=1200` / voice detail: `VOICE_DETAIL_MAX=300`。
  - voice `detail` は tail 本文（redaction 済み・300 字切り詰め）由来で、**tool 名/入力は送らない**。
  - `transcript.jsonlPath` は送らない（絶対パス漏れ防止）。
  - `redaction.ts` のマスク種別: private-key / anthropic / google / github / slack / aws / 汎用 sk- / Authorization / Bearer / `*SECRET/TOKEN/...=値`。
- **allowlist**: client の `CCM_MIRROR_PROJECTS` でミラー対象を限定（uplink）。
- **保持**: 集約ストア TTL = `STOPPED_RETENTION_SEC`（24h）/ utterance ストア TTL = 1h + 200 件上限。メモリのみ（再起動で消え、client 再 push で自己回復）。

→ 「最終調整」は **現状で要件を満たしているため新規実装はしない**。本フェーズは確認 + 文書化に徹する。

## 対応方針

### Step 1: ドキュメント更新
- **CLAUDE.md** `## AI Monitor`:
  - 「読み取り専用」の 1 行を **モード別**に書き換え:
    - `--mode local`（既定）/ `--mode client` = ローカル FS に read-only（+ client は公開サーバへ uplink push）
    - `--mode server` = 公開アグリゲータ（認証付き ingest・集約ストア・音声生成・ミラー配信。FS は読まない）
  - **進捗音声機能**の小節を追加（client→server→ブラウザ再生の 1 段落 + 主要 env + プライバシー注記 + deploy runbook への参照）。
- **README.md**:
  - 「## 進捗音声 + 公開ミラー (オプション)」を追加（概要・3 モード・起動例・主要 env・プライバシー・runbook 参照）。

### Step 2: ローカル E2E（client→server ループバック）
- server をローカルポートで起動（`CCM_VOICE_TTS_PROVIDER=none` で課金回避）。
- client を `CCM_SERVER_URL=http://127.0.0.1:<port>` + token で起動し、既存検出が拾ったセッションを push。
- server 側 `/api/dashboard.json`(ミラー) と `/api/voice/recent.json` / SSE にデータが現れることを確認。
- 認証境界（Bearer 無し ingest = 401）も確認。
- Cloudflare 越しの実 E2E は Phase 7 runbook のチェックリストに委ねる（ユーザーのインフラ構築後）。

### Step 3: 整理
- 親タスク「claudeの進捗状況を音声でしゃべる機能」を `DONE.md` へ移動（完了日 2026-06-18、各 Phase を子記録）。実 g3plus/Cloudflare デプロイはユーザー作業（runbook 提供済み）と明記。
- `TODO.md` から親タスクを削除。
- 本プラン群（`claude-progress-voice*.md` 全 8 + 親）を `docs/plans/archive/` へ移動。

## 影響範囲
- アプリコード無改修（redaction/保持は実装済み）。変更は CLAUDE.md / README.md / TODO.md / DONE.md とプラン移動のみ。

## テスト方針
- `npm test`（既存 136）が緑のまま（ドキュメント更新なのでテスト不変）。
- ローカル E2E スモークを実走しログを残す。

## Step 分解
- [x] Step 1: CLAUDE.md / README.md をモード対応 + 進捗音声機能 へ更新
- [x] Step 2: ローカル E2E（client→server ループバック）スモーク
- [x] Step 3: TODO→DONE 移動・プラン archive・最終確認（`npm test` 緑）

## 実走ログ

### 2026-06-18 redaction/保持の確認
- src 実走査で redaction/保持が実装・配線済みと確認（uplink の `sanitizeText` 全経路適用・`jsonlPath` 除外・voice detail 300 字・TTL 集約 24h / utterance 1h）。**コード変更なし**。

### 2026-06-18 ドキュメント更新
- `CLAUDE.md`: `## AI Monitor` に `--mode` 別の役割表（local/client/server）+ 「進捗音声 + 公開ミラー」小節（env・プライバシー・runbook 参照）を追加。「読み取り専用」をモード対応に書き換え。
- `README.md`: 「## 進捗音声 + 公開ミラー (オプション)」を追加（3 モード表・データフロー図・env・起動例・プライバシー注記・`ai-monitor/deploy/g3plus/` 参照）。
- `npm test` = **136 pass / 0 fail**（ドキュメント更新なので不変）。

### 2026-06-18 ローカル E2E（client→server ループバック）
- server `:8194`（`CCM_CLIENT_TOKENS` 設定・`tts=none`・persona=fallback で課金回避）+ client `:8195`（`CCM_SERVER_URL=http://127.0.0.1:8194`・`CCM_MIRROR_PROJECTS=claude-code-manager`・interval 2s）を起動。
- 結果: client が稼働中セッション（`claude-code-manager`, ai-processing）を検出 → allowlist 通過 → push。
  - server 集約ミラー `/api/dashboard.json` に **entries=1**（合成 id = clientId×projectDir, state=ai-processing）が出現 = client→server ミラー経路が実バイトで成立。
  - 認証境界: Bearer 無し `POST /api/ingest/snapshot` = **401**。
- Cloudflare Tunnel + Access 越しの実 E2E は Phase 7 runbook のチェックリストに従いユーザーがインフラ構築後に実施。

### 2026-06-18 整理
- 親タスク「claudeの進捗状況を音声でしゃべる機能」を `DONE.md` へ移動（実 g3plus/Cloudflare デプロイはユーザー作業・runbook 提供済みと明記）。`TODO.md` から削除。
- `claude-progress-voice*.md`（親 + Phase 1〜8）を `docs/plans/archive/` へ移動。

## 残課題（任意・後追い）
- 永続化（`data/` ボリューム）opt-in。
- WAV→mp3/opus 変換（帯域/iOS 互換）。
- macOS の process 検出（`processes.ts` darwin スキャフォルド）の実装。
