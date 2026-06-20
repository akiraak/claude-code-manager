# 端末ごとの会話が混じって聞こえる問題の調査と修正

## 目的・背景

ダッシュボードのボイス再生で、**別端末（client）の 2 人会話が混ざって聞こえる**という報告。
1 イベント（completed / awaiting / progress）は「ちょビ & なるこ」の 2〜4 発話に展開されるが、
その途中に別端末（別イベント）の発話が割り込み、会話が交互に再生されてしまう。

要件: **1 イベントで再生される音声が複数になっても、それを通して（連続して）流す**。

## 調査結果（根本原因）

音声生成は server モードの `VoicePipeline.handle(event)` が担う。1 イベントにつき:

1. `persona.generate()` で 2〜4 発話の台本を作り、
2. **発話ごとに `await tts.synthesize()` してから** `store.put()` → `onUtterance(u)` を呼ぶ
   （`onUtterance` が SSE `voice-utterance` を push する）。

つまり 1 イベント内の発話は逐次（`await` を挟んで順番に）emit される。問題は **イベント間**:

```
server.ts:194  onVoiceEvent: (v) => { void pipeline.handle(v); }
```

これは **fire-and-forget で直列化が無い**。voice-event が近接して届くと（別端末同士、または
同一端末の連続イベント）、`handle(A)` と `handle(B)` が**並行**に走る。各 `handle` は発話ごとに
`await tts.synthesize`（数秒）で待つため、`onUtterance` の発火が実時間で交互になる:

```
A1, B1, A2, B2, A3 …   ← SSE がこの順で push
```

クライアント側の再生キュー（`views.ts` `DASHBOARD_VOICE_SCRIPT`）は**単一 audio + フラット FIFO**で、
届いた順にそのまま再生する（`enqueue`→`pump`→`play`→`onended`→`pump`）。SSE が交互順なので、
**会話が端末をまたいで混線して聞こえる**。

- 同一端末でも混線しうる: client の `VoiceEventQueue` は POST を 1 件ずつ送るが、server は
  `handle` を await せず即応答するため、event1 の音声生成中に event2 の生成が始まり並行化する。
- groupId / createdAtMs(+1ms) は「**同一イベント内**の順序」は保証するが、**イベント間の非分断**は
  保証しない（混線はイベント間の割り込みなので別問題）。

## 対応方針

**server 側で `pipeline.handle` を直列化する**。1 イベントの全 utterance を出し切ってから次イベントの
生成を始めれば、SSE の push 順が「A を全部 → B を全部」になり、クライアントの既存 FIFO が自然に
通しで再生する（クライアント側は変更不要）。再生はもともと単一 audio で逐次なので、生成を直列化しても
体感の再生速度は変わらない（むしろ到着順＝再生順が安定する）。

実装:

- `VoicePipeline` に内部プロミスチェーン `private chain` を持たせ、`enqueue(event)` を追加。
  `enqueue` は `chain.then(() => handle(event))` で前イベントの完了後に処理を始め、`chain` を更新する。
  `handle` 自体は throw しない設計なのでチェーンは握りつぶしで継続。`handle`（per-event worker）は
  現状のまま残し、既存テストと単体性を維持する。
- `server.ts:194` を `onVoiceEvent: (v) => { void pipeline.enqueue(v); }` に変更。

### 検討した代替案

- **クライアント側で groupId 単位にバッファ**: 1 グループの全 utterance が揃うまで再生を待つ案。
  だが「グループ完了」を知る信号が無く（何発話来るか不明）、タイムアウト頼みで脆い。サーバ直列化なら
  順序が保証され、クライアントは無改修で済む → 不採用。
- **発話をイベント単位でバッチ emit**: first utterance まで全 TTS を待つので初動が遅い。逐次 emit を
  保ちつつ直列化（採用案）の方がログ/ミラーの即時性を損なわない。

## 影響範囲

- `ai-monitor/src/voice-pipeline.ts`（`enqueue` 追加・`handle` は不変）
- `ai-monitor/src/server.ts`（`onVoiceEvent` を `enqueue` に）
- クライアント（`views.ts`）/ store / ingest は変更なし
- `local`/`client` モードは pipeline を使わないので無影響

## テスト方針

- `voice-pipeline.test.ts` に「`enqueue` を 2 件ほぼ同時に呼ぶと、TTS に遅延があっても
  `onUtterance` が A 全件 → B 全件の順で発火し、混線しない」直列化テストを追加。
- 既存 `handle` テストは不変（後方互換）。`tsc` クリーン + 全テスト green を確認。

## Phase

- [x] Phase 1: 調査（根本原因の特定）← 本ファイルにまとめ済み
- [x] Phase 2: `VoicePipeline.enqueue` 直列化 + server 結線 + テスト

## 実装結果（2026-06-19）

- 根本原因: `server.ts` の `onVoiceEvent: (v) => { void pipeline.handle(v); }` が直列化なしの
  fire-and-forget で、近接イベントの `handle` が並行実行 → 発話ごとの `await tts` を挟むため
  `onUtterance`(=SSE) が端末をまたいで交互発火 → クライアントのフラット FIFO が混線再生していた。
- 修正: `VoicePipeline` に内部プロミスチェーン + `enqueue(event)` を追加（前イベントの全 utterance を
  出し切ってから次へ・`handle` は throw しないがチェーンは握りつぶしで継続）。`server.ts` の結線を
  `pipeline.enqueue(v)` に変更。`handle`（per-event worker）は不変＝既存テスト互換。クライアント/
  store/ingest は無改修（SSE の順序が保証されるので既存 FIFO がそのまま通し再生になる）。
- 変更: `voice-pipeline.ts`（enqueue 追加）・`server.ts`（結線）・`ingest.ts`（doc コメント）。
- テスト: `voice-pipeline.test.ts` に直列化テスト 2 件追加（A 全件→B 全件・0 発話 started を跨いでも
  順序保持）。`delayedTts` で並行なら混線する状況を作り、`enqueue` が `['A','A','B','B']` になることを確認。
  全 170 pass・`tsc` クリーン・`build` OK。
- 手動 E2E（複数 client + 実 TTS で実際に混線しないか）はユーザー環境で別途（鍵が要るため）。
