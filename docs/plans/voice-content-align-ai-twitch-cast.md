# 読み上げ内容を ai-twitch-cast に合わせる（モデルは Haiku 維持）

## 目的・背景

調査（`docs/plans/voice-content-diff-vs-ai-twitch-cast.md`）で、ai-monitor の読み上げが ai-twitch-cast と「内容が違う」主因は **投入コンテキスト枯渇 / 1 人独白 / 出力 50 字キャップ / 人格書き換え / 反復** だと判明した。本タスクは **テキスト生成モデルは Anthropic Claude Haiku のまま**、それ以外の読み上げ生成パイプラインを ai-twitch-cast の実装に合わせる。

### ユーザー確定事項（2026-06-19 ヒアリング）

- **モデル**: テキスト生成は Haiku（`claude-haiku-4-5-20251001`）維持。TTS は Gemini 維持。
- **トリガ**: イベント駆動のまま（`completed` / `awaiting` / `progress`）。中身だけ充実させる。8 分周期の途中実況は**追加しない**（要件 #3 と整合。`progress` が長時間作業の途中実況を既にカバー）。
- **演出**: **フル再現**。2 人会話（ちょビ=teacher + なるこ=student）+ `emotion` / `se` フィールドも生成する。このツールにはアバター / SE プレーヤー / 海外視聴者が無いので、`emotion`・`se` はメタとして保持し UI にラベル表示するに留め（再生・表情駆動はしない＝将来用）、`[lang:xx]` 多言語タグは日本語のみ運用なので実質無効（tts_text≒speech）。

### 移植元（読み取り専用・変更しない）

- `~/ai-twitch-cast/src/character_manager.py:10-130` — `DEFAULT_CHARACTER`（ちょビ）/ `DEFAULT_STUDENT_CHARACTER`（なるこ）/ emotions マップ / tts_voice・tts_style
- `~/ai-twitch-cast/src/ai_responder.py:678-856` — `generate_claude_work_conversation`（claude-work 用 system/user プロンプト + JSON 配列出力 + 検証）
- `~/ai-twitch-cast/src/prompt_builder.py:267-475` — `build_system_prompt`（length_rule / 感情分布 / SE / 多様性 / JSON 形式 / self_note / persona / stream_context の 5 層）
- `~/ai-twitch-cast/src/claude_watcher.py:169-209` — `_describe_tool_use` / `_extract_assistant_content`（アクション抽出）・トリガ定数

## 対応方針

ai-twitch-cast の「2 人会話で Claude の作業を実況」を、本実装の **client→server push + イベント駆動** アーキの上に移植する。Gemini chat の代わりに Haiku で **JSON 配列**を生成し、`speaker` ごとに声（Leda/Aoede）を割り当てて複数 utterance を順次再生する。

## 影響範囲（現状の型・モジュール）

| ファイル | 現状 | 変更 |
|---|---|---|
| `ai-monitor/voice-persona.json` | 1 キャラ（ちょビ・書き換え版） | **2 キャラ構造**（teacher/student、emotions 込み、原典 ちょビ/なるこ移植） |
| `src/persona.ts` | `PersonaConfig` 単体 / `buildPersonaPrompt`（1 文 system+user）/ `cleanLine` で 50 字 `…` 切り / hash キャッシュ | 2 キャラ型 / `buildClaudeWorkPrompt`（5 層 system + claude-work user）/ **JSON 配列パース + emotion 検証** / ハード切り詰め廃止 / 反復防止（last_conversation） |
| `src/store.ts` | `VoiceEventPayload { kind, detail?, projectName? }` | 構造化 `context { userPrompt?, actions?: string[], notes?: string[], elapsedMin? }` を追加（`detail` は後方互換で残す） |
| `src/uplink.ts` | `VoiceEventDetector` が `detail = lastAssistantText` を載せる | **アクション列 / userPrompt / notes / elapsedMin** を抽出して `context` を載せる |
| `src/transcript.ts` | NormalizedEvent（tool-use の input 保持状況を確認） | tool input（command/file_path/pattern/description）保持が無ければ拡張 + アクション整形ヘルパ |
| `src/ingest.ts` | voice-event 検証 | `context`（配列長・各文字数・合計サイズ）検証 |
| `src/redaction.ts` | detail マスク | `context.actions/notes/userPrompt` をマスク + サイズ上限 |
| `src/voice-pipeline.ts` | 1 event→1 utterance | 1 event→**複数 utterance**（順序保持）、speaker→voice |
| `src/voice-store.ts` | `Utterance { text, kind, ... }` | `speaker? / emotion? / se?` を追加（Meta にも） |
| `src/tts.ts` | 単一 voice（persona.ttsVoice） | speaker 別 voice（Leda/Aoede）。`synthesize(text, {voice,style})` か 2 プロバイダ |
| `src/views.ts` | 履歴に text のみ | speaker/emotion ラベル表示、複数 utterance を会話として順次再生、（任意）生成プロンプト全文の可視化 |

## Phase / Step 分解

- **Phase 1: 2 キャラ persona 設定 + ちょビ/なるこ移植**
  - `voice-persona.json` を `{ characters: { teacher, student }, ... }` 構造へ。`character_manager.py` の system_prompt / rules / emotions / tts_voice(Leda/Aoede) / tts_style を移植。
  - `persona.ts` の `PersonaConfig` を 2 キャラ型 + emotions に拡張。`loadPersona`/`mergePersona` を更新（旧 1 キャラ JSON も読めるフォールバック）。
- **Phase 2: コンテキスト拡張（client 側アクション抽出）**
  - `transcript.ts`: NormalizedEvent が tool input を保持しているか確認、足りなければ保持。`describeToolUse`（Bash→「コマンド実行: …80字」/ Edit→「ファイル編集: basename」/ Write/Read/Grep/Glob→「コード検索: …」/ Agent→「サブエージェント: …」）と `extractActions`（直近 10）を移植。
  - `store.ts` `VoiceEventPayload` に `context`。`uplink.ts` の `VoiceEventDetector`/`transitionEvent` が `userPrompt(200字) / actions(10) / notes(3×100字) / elapsedMin` を埋める。
  - `ingest.ts` 検証 + `redaction.ts` マスク（actions/notes/userPrompt）。
- **Phase 3: 対話生成（Haiku → JSON 配列）**
  - `buildClaudeWorkPrompt(personas, input)` 純関数。`ai_responder.py:774-826`(JA) を移植。「配信の視聴者」=「ダッシュボードを見ている人」に読み替え。system = teacher 人格 + キャラ定義(emotions) + claude-work ルール + 反復防止(last_conversation) + 感情分布 + JSON 形式。
  - Haiku で生成（JSON を促す。Anthropic に mime 強制は無いので **プロンプト指示 + 堅牢パース**。コードフェンス除去 → 配列/オブジェクト両対応 → 最大 4 → emotion を character.emotions で検証、未知は neutral）。
  - **長さはプロンプト指示のみ**（1〜2 文・~40 字目安）。`cleanLine` のハード `…` 切りは廃止（暴走防止の緩い上限のみ）。→ 隣 TODO「読み上げが途中で途切れる／全文読む」を解消。
  - 反復防止: セッション直近 utterance を `last_conversation` として渡す。入力固定 hash キャッシュは廃止（or last_conversation 込みキーで自然にばらす）。
- **Phase 4: マルチ発話パイプライン + 2 声 TTS**
  - `voice-pipeline.ts`: 1 event → dialogue 配列 → 各行ごとに speaker→voice 解決 → TTS → utterance を**順序付きで複数 emit**（`onUtterance` を行数分）。SPOKEN_KINDS は据え置き。
  - `voice-store.ts` `Utterance`/`UtteranceMeta`/`PutUtterance` に `speaker? / emotion? / se?`。
  - `tts.ts`: speaker→voice（teacher=Leda / student=Aoede）。キャッシュタグに voice を含める（既存どおり）。
- **Phase 5: UI（会話表示）+ emotion/SE 配線**
  - `views.ts`: ボイス履歴を speaker（ちょビ/なるこ）+ emotion ラベル付きで表示。1 event の複数 utterance を会話ブロックとして順次再生（既存の順次再生キューを利用、同一 event をまとめる）。
  - `emotion`/`se` はメタ保持 + ラベル表示のみ（再生・表情駆動はしない）。
  - （任意）検証可能性: 生成した system/user プロンプトと JSON 応答をデバッグ表示。
- **Phase 6: 記憶層（Persona / Self-Note 自動更新）— 段階導入可**
  - 過去発話タイムライン保持（メモリ + TTL）。周期（~15 分）で Haiku 要約 → `persona`(過去応答から抽出した性格・400字) / `self_note`(今日話したこと・400字) を生成し system プロンプトに注入（`prompt_builder.py:313-327`）。
  - **最重量・最後**。無くても Phase 1〜5 で 2 人会話 + 文脈実況は成立する。コスト / 状態増を見て要否を最終判断。
- **Phase 7: テスト + ドキュメント + 後片付け**
  - 純関数テスト: `persona.test.ts`（プロンプト組み立て / JSON パース / emotion 検証 / 反復防止）、アクション抽出、`redaction.test.ts` 追補、`voice-pipeline.test.ts`（複数 utterance / 2 声）。
  - 手動 E2E: client→server→ブラウザで 2 人会話の順次再生 + 履歴表示。
  - `CLAUDE.md` の AI Monitor 節を 2 人会話 / 演出方針 / context 拡張で更新。隣 TODO（途切れ）を DONE へ。本プラン + 調査プランを `docs/plans/archive/` へ。

## テスト方針

- **純関数中心**: プロンプト組み立て・JSON パース・emotion 検証・アクション抽出・redaction は LLM 非依存でユニットテスト（既存 `src/**/*.test.ts` 形式 / `node --test`）。
- **LLM / TTS はモック**: `PersonaGenerateFn` 差し替え（既存）、TTS は fake provider。
- **手動 E2E**: `./run-voice-server.sh` + `./run-voice-client.sh` で 実セッションを 1 ターン回し、2 人会話が順次再生され、内容が実アクションを反映していることを確認。`CCM_DRYRUN` で送信 context を確認。

## コスト・プライバシー注意

- **コスト増**: 1 event あたり Haiku 1 回（JSON 配列）+ Gemini TTS を発話数（2〜4）分。`completed`/`awaiting` の dedup（`spokenTransitionSig`）と TTS バイトキャッシュは維持。`progress` 周期は据え置き。
- **プライバシー**: context にアクション（コマンド先頭 80 字 / ファイル basename / 検索パターン）と Claude メモが乗り、ミラー + AI プロバイダを通過する量が増える。`redaction.ts` の対象を context 全フィールドに広げ、配列長・各文字数・合計サイズ上限を `ingest.ts` で強制。`CCM_MIRROR_PROJECTS` allowlist は従来どおり。

## 残課題（実装中に詰める）

- `voice-persona.json` の新スキーマ（2 キャラ + emotions）と後方互換の読み込み。
- Haiku の JSON 安定性（mime 強制不可）。失敗時 fallback（1 人 1 発話の従来テンプレへ縮退）を残す。
- 複数 utterance のブラウザ順次再生で「会話の途中で割り込まれない」順序保証。
- Phase 6（記憶層）の要否・周期・保持先。
