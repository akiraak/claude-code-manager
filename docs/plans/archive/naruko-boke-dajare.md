# なるこにボケとダジャレ要素を入れる

## 目的・背景

進捗音声 (server モード) の 2 人会話は **ちょビ(先生=teacher) & なるこ(生徒=student)** の掛け合いで成立している。
現状の `voice-persona.json` / `persona.ts:DEFAULT_STUDENT` では、なるこは「明るくて元気・素直に質問・たまにちょっとズレた質問をする」程度で、**笑い要素 (ボケ・ダジャレ) は明示されていない**。
一方で先生 ちょビ は既に **「ツッコミ気質」** を持っており、漫才で言う ツッコミ役 の素地がある。

本タスクは、なるこを **ボケ役 (ボケ + ダジャレ/言葉遊び)** として強化し、ちょビ の ツッコミ と噛み合う掛け合いにして、進捗実況を聞いていて楽しいものにする。

### 設計上の前提・注意

- **ペルソナはデータ駆動**: 生成プロンプトは `buildClaudeWorkPrompt` が `student.systemPrompt`(persona.ts:253) と `student.rules`(persona.ts:268) を system に流し込む。つまり **`systemPrompt` / `rules` を編集するだけで生成挙動を変えられる**。プロンプト組み立てロジック (`buildClaudeWorkPrompt`) の構造には手を入れない方針 = 影響範囲を最小化する。
- **正本と既定の二重管理**: 実際に読まれるのは `ai-monitor/voice-persona.json` (編集可・正本)。`persona.ts:DEFAULT_STUDENT` は JSON 不在/破損時の fallback。**両者を同期**させる (今も内容が一致している)。
- **頻度は「控えめ」（ユーザー確定 2026-06-19）**: Haiku にダジャレを「毎回」言わせると寒さ・反復・うるささに直結する。**基本は今の素直な生徒のまま、ボケ/ダジャレは隠し味（数回の会話に 1 回程度・1 会話に多くても 1 つ）** に絞る。既存の「毎回同じリアクションをしない・バリエーションを出す」(persona.ts:264) とも整合させる。
- **awaiting で情報を埋もれさせない**: `awaiting` (承認・入力待ち) は「何で止まっているか伝えて『対応して』と気づかせる」のが目的 (`KIND_FOCUS.awaiting`)。ここでふざけすぎると肝心の状況が伝わらない。**awaiting ではボケを抑え、止まっている理由は分かるようにする**ルールを入れる。
- **長さ制約は維持**: 「先生より短めに話す」「1〜2 文・40 字目安」を崩さない。ダジャレは短い一言に留める。

## 対応方針

`voice-persona.json` の `student`（と同期のため `persona.ts:DEFAULT_STUDENT`）の **`systemPrompt` に「ボケ役 + ダジャレ好き（控えめ）」性格と「笑いのルール」を追記**し、**`rules` に頻度・awaiting 配慮の項目を追加**する。
あわせて先生 ちょビ 側に「なるこのボケに軽くツッコむ」ルールを 1 つ足し、掛け合いのオチが付くようにする（ユーザー確定 2026-06-19）。

ロジック・型・スキーマ・SSE・TTS には変更なし（データのみ）。

### 提案する具体文言（叩き台）

**student.systemPrompt（性格に追記 + 笑いのルール節を新設）**

```
## 性格
- 明るくて元気。好奇心が強い
- 素直で、わからないことは素直に聞く
- 先生の話に「へぇー！」「なるほど！」とリアクションする
- たまにちょっとズレた質問をする
- お調子者でボケ役の一面がある。たま〜にだけ、的外れな勘違いや大げさな反応で笑いを取りにいく
- ダジャレ・言葉遊びがちょっと好き。たま〜にだけ、作業に出てきた単語にひっかけて軽いダジャレを言う

## 笑いのルール
- ボケ・ダジャレは「隠し味」。基本は素直な生徒のままで、ふだんは出さない
- 出すのは数回の会話に 1 回くらい。1 回の会話で多くても 1 つまで。連発は厳禁
- すべってもいい。先生（ちょビ）にツッコんでもらう前提でいい
- ダジャレは短く一言で。状況説明や承認待ちの大事な情報を埋もれさせない
- 同じダジャレ・同じボケを繰り返さない。毎回ちがう切り口にする
```

**student.rules（追加）**

```
"ボケ・ダジャレは控えめ（隠し味）。ふだんは出さず、数回の会話に 1 回くらい。多くても 1 会話に 1 つ",
"承認待ち（止まっている）ときはふざけすぎず、何で止まっているかは伝わるようにする"
```

**teacher.rules（追加）**

```
"なるこがボケたら軽くツッコむ（ただし毎回はやりすぎない）"
```

> emotions は現状の `joy/surprise/thinking/neutral` のままでも成立する（ボケ用に新感情は必須でない）。明るく弾けさせたい場合のみ `excited` 追加を検討（任意・コード変更不要）。

## 影響範囲

| ファイル | 変更 |
|---|---|
| `ai-monitor/voice-persona.json` | `student.systemPrompt` に性格 2 行 + 「笑いのルール」節、`student.rules` に 2 項目、`teacher.rules` に「ツッコむ」1 項目を追加 |
| `ai-monitor/src/persona.ts` | `DEFAULT_STUDENT` / `DEFAULT_TEACHER` を上記と**同じ内容に同期** |
| 生成挙動 | server モードの台本生成で、なるこがときどきボケ/ダジャレを言うようになる。API/型/SSE/TTS は不変 |

非対象: `buildClaudeWorkPrompt` の構造、`store.ts`/`uplink.ts`/`ingest.ts`/`redaction.ts`/`tts.ts`/`views.ts`、CLAUDE.md（仕様の本質変更なし。必要なら一文だけ補足）。

## テスト方針

1. **既存テストが緑**: `cd ai-monitor && npm run build && npm test`。
   - 既存 `persona.test.ts` は構造（2 キャラ・Leda/Aoede・rules 非空・emotions 非空・loadPersona の DEFAULT 比較）を見るだけなので、文言追記では壊れない見込み。
   - `DEFAULT_STUDENT` を変えても、`loadPersona('/nonexistent')` 系は同じ定数比較なので維持される。
2. **同期チェック**: `voice-persona.json` の student と `DEFAULT_STUDENT` の `systemPrompt`/`rules` が一致していること。
3. **（オプション）軽い回帰テスト追加**: 同梱 `voice-persona.json` の `student.systemPrompt` に「ダジャレ」「ボケ」キーワードが含まれることを assert（文言が消える退行を検知）。LLM 出力自体は非決定的なので内容までは検証しない。
4. **手動目視**（API キーあり）: `./run-voice-server.sh`（+ `./run-voice-client.sh`）を起動し、`completed`/`progress`/`awaiting` の台本を数件確認。
   - (a) なるこが**ときどき**ボケ/ダジャレを言う、(b) **毎回ではない**、(c) **awaiting で止まっている理由が埋もれない**、(d) ちょビ のツッコミと噛み合う、を確認。
   - キー無し環境では `DialogueGenerator({ generate })` 注入や `CCM_DRYRUN` でプロンプト/フローのみ確認可。

## Phase / Step 分解

- **Phase 1: ペルソナ文言の追記・同期**
  - `voice-persona.json` の `student.systemPrompt`/`student.rules` を更新 + `teacher.rules` に「ツッコむ」追加
  - `persona.ts:DEFAULT_STUDENT` / `DEFAULT_TEACHER` を同内容に同期
- **Phase 2: 検証**
  - `npm run build && npm test` で既存テスト緑を確認（必要なら回帰テスト 1 本追加）
  - server+client を起動し台本を手動目視（頻度・awaiting・掛け合いを確認）し、寒すぎ/うるさすぎなら文言（頻度表現）を微調整
