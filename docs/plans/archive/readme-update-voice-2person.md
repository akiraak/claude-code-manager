# README.md の更新 (音声を 2 人会話へ同期)

## 目的・背景

README.md が現行実装から乖離している。特に「進捗音声 + 公開ミラー」周りが、
単一ペルソナ「ちょビ口調短文」のままだが、実装は **ちょビ(先生) & なるこ(生徒) の
2 人会話台本** に移行済み。最近のコミット (音量スライダー数値表示 / 知覚カーブ /
groupId 無音 / ローカルコマンド無視) も未反映。README を現状に合わせる。

> 注: `docs/plans/archive/readme-update.md` は初期の README 全面書き換えの別タスク。本ファイルは
> その後の「音声=2 人会話」同期タスク。

## 乖離の調査結果 (コードと突き合わせ済み)

- **音声ペルソナが 2 人会話に変わっている** (`voice-persona.json` = teacher/student の 2 キャラ、
  `persona.ts` `buildClaudeWorkPrompt` が 1 イベント → 2〜4 発話の JSON 配列を生成)。
  README は「ちょビ口調短文」の単一ペルソナ表現のまま。
- **話者ごとに声が違う** (teacher=Leda / student=Aoede)。README 未記載。
- **groupId で会話を束ね、別イベント遷移時のみ無音 `GROUP_GAP_MS = 700ms` を挟む**
  (`views.ts`)。README 未記載。
- **`CCM_VOICE_SPOKEN_KINDS`** (読み上げ種別 csv フィルタ。既定 completed,awaiting,progress)
  が server env / 設定解決順の一覧に未記載。
- **emotion / speaker ラベルが UI に出る** (`views.ts` `.vh-speaker` / `.vh-emotion`)。
  音量スライダーに数値 % 表示 + 知覚カーブ変換。README のボイス UI 記述が古い。
- **音声 context の中身** を README プライバシー節でコードと突き合わせて精緻化。
  実測 (`uplink.ts`): userPrompt 200 字 / アクション・メモ各 160 字 / actions 10・notes 3 件。
  アクション中身は `transcript.ts` で command 80 字・pattern 50 字・file は basename に縮めてから。
  (CLAUDE.md の「各 160 字」は userPrompt が実際は 200 字でわずかに不正確だったため、コードに合わせた)
- 文字数の上限は `SPEECH_SAFETY_MAX = 200` のみ (ハード切り詰めしない)。

確認の結果、以下は **現状と一致しており変更不要**:
- AI 要約 (4〜6 行 / 400〜600 文字、Haiku 固定、max_tokens 1000、PROMPT 6000、PINNED 1200)
- 状態バッジ 4 種類の条件
- `CCM_INGEST_TOKENS` の 16 文字必須・カンマ区切り・fail-fast
- 設定解決順 (env > .env > 既定) / ログ / hook

## 対応方針

README の「進捗音声 + 公開ミラー」節を中心に、2 人会話・話者別ボイス・groupId 無音再生・
`CCM_VOICE_SPOKEN_KINDS`・emotion/speaker ラベル・音量数値表示・`voice-persona.json` を反映。
プライバシー節の音声 context 記述も精緻化する。それ以外の節は現状一致のため触らない。

## 影響範囲

- `README.md` のみ (ドキュメント)。コード変更なし。

## テスト方針

- ドキュメントのため自動テストなし。記述内容をコード (`persona.ts` / `voice-pipeline.ts` /
  `views.ts` / `server.ts` / `uplink.ts` / `voice-persona.json`) と突き合わせて事実確認済み。
