# Phase 1: 設計確定 & 基盤 PoC

親プラン: [claude-progress-voice.md](claude-progress-voice.md)

Phase 1 のゴールは「実装に入る前に設計を確定し、リスクの高い土台を PoC で潰す」こと。
本ファイルは **Phase 1 の作業記録 + 確定した設計判断** を残す（実装が進んだら親プランへ反映）。

## スコープと担当

| Part | 内容 | 本セッションでの扱い |
|---|---|---|
| 1 | データソース抽象化（local pull / remote push）の設計 | **実施**: 設計確定 + 安全リファクタ（`EntrySource` 導入） |
| 2 | g3plus 最小 Docker + Cloudflare Tunnel `ccm.chobi.me` 疎通 PoC | **別作業**（ユーザーが g3plus / Cloudflare 側で別途実施） |
| 3 | Gemini TTS → ブラウザ再生 PoC | **実施**: HTTP 直叩き PoC スクリプト + 再生ページ + 実走 |
| 4 | redaction / 保持方針の確定 | **実施**: 方針確定 + `redaction.ts` PoC + テスト |

---

## Part 1: データソース抽象化（確定）

### 現状のデータフロー（pull 型）

```
buildEntries(state.ts)                       ← 唯一のデータソース seam
  ├─ listClaudeProcesses()   /proc           （プロセス生存）
  ├─ listTranscripts()       ~/.claude/...    （jsonl 最新 + cwd + mtime）
  └─ listAwaitingInputMarkers() /tmp/...      （権限プロンプト marker）
  → MonitorEntry[]
       ├─ server.ts /api/dashboard.json, /api/sidebar, /view, /api/watch
       │    → entryToDashboardCardData() / renderDashboard()
       ├─ server.ts /view?proc, /api/process.json
       │    → buildProcessViewData()  ※ readTailEvents(jsonlPath,200) を直接読む
       └─ server.ts /api/summarize
            → Summarizer.getOrCompute(jsonlPath, mtimeMs, {events})
```

ポイント: 描画系（`views.ts`）はすべて `MonitorEntry`（一部は jsonlPath 経由の追加読み）に依存している。
公開サーバ（g3plus コンテナ）はリモート端末の `/proc`・`~/.claude` を読めないので、ここを **抽象化** して
local（pull）/ remote（集約ストア）を差し替えられるようにする。

### 確定した抽象: `EntrySource`

```ts
// ai-monitor/src/entry-source.ts
export interface EntrySource {
  buildEntries(opts?: BuildEntriesOptions): Promise<MonitorEntry[]>;
}
export class LocalEntrySource implements EntrySource { /* 現行 buildEntries を委譲 */ }
// 将来 (Phase 3): class RemoteEntrySource implements EntrySource { /* 集約ストアを読む */ }
```

- `startServer(opts, source = new LocalEntrySource())` が `EntrySource` を受け取り、
  `/api/dashboard.json` `/api/sidebar` `/view` `/api/watch` の `buildEntries({summarizer})` を
  `source.buildEntries({summarizer})` に差し替える。
- **本セッションの安全リファクタはここまで**（挙動不変・テスト緑）。RemoteEntrySource / mode 分岐は Phase 2/3。

### Phase 1 で判明した「MonitorEntry だけでは足りない」点（重要）

| 消費点 | 現状の追加依存 | remote モードへの対応（確定方針） |
|---|---|---|
| `buildProcessViewData` | `readTailEvents(jsonlPath, 200)` を **FS から直接** 読む | snapshot に **正規化済み `events[]`（上限 200・redaction 済み）** を載せ、remote では FS の代わりにそれを使う。`EntrySource` を Phase 3 で `getEvents(id)` 付きに拡張 |
| `Summarizer.getOrCompute` | `jsonlPath` + `mtimeMs` をキャッシュキーに使う | remote は jsonlPath が無いので **合成キー `clientId|projectDir|sessionId` + snapshot の mtime 相当** を採用。要約入力 `events`/`recentUserText` は snapshot から渡す（サーバ側で生成。クライアントは生成しない） |
| `/api/summarize` の force | jsonlPath 前提 | 同上の合成キーで対応 |

### snapshot payload スキーマ（client → server, Phase 4 で実装）

`POST /api/ingest/snapshot`（端末別 Bearer）。1 セッション = 1 payload。

```jsonc
{
  "clientId": "wsl2-akira",            // CCM_CLIENT_LABEL（既定 hostname）
  "sentAt": "2026-06-18T12:00:00Z",
  "entry": {                           // = MonitorEntry のシリアライズ（summary は除外）
    "id": "...", "projectDir": "...", "cwd": "...",
    "process": { "pid": 1234 } | null,
    "transcript": { "projectDir","jsonlPath?","cwd","mtimeMs","sessionId" } | null,
    "lastActivityAt": "..." | null,
    "tail": { "lastUserText","lastUserAt","lastAssistantText","lastAssistantAt",
              "lastEventKind","endsWithInteractiveToolUse","endsWithLocalCommand" },
    "state": "ai-processing|awaiting-user|waiting|stopped"
  },
  "events": [ /* readTailEvents 上限 200・redaction 済みの NormalizedEvent[] */ ]
}
```

- `jsonlPath` は **送らない**（リモートの絶対パスは無意味＋情報漏れ）。サーバは合成キーで識別する。
- `summary` はクライアントから送らない（サーバが Haiku で生成、Part 4 の redaction 後）。
- すべてのテキストはクライアント側で **redaction + サイズ上限** を通してから送る（Part 4）。
- サーバ側 `RemoteEntrySource` は payload から `MonitorEntry` を復元し、`summary` だけ自前の Summarizer で埋める。

### server.ts への影響（最小）

- `startServer(opts: ServerOptions, source: EntrySource = new LocalEntrySource())`
- 既存 `cli.ts` の `startServer(opts)` は **無変更**（デフォルト引数で後方互換）。
- 既存テスト（state/summarize/transcript/views）は `buildEntries` 本体・views 本体に触れないので影響なし。

---

## Part 3: Gemini TTS → ブラウザ再生 PoC（確定）

参考実装 `~/ai-twitch-cast/src/tts.py` の呼び出しを **HTTP 直叩き** に置き換え（`google-genai` 依存を足さない方針）。

- エンドポイント: `POST https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={GEMINI_API_KEY}`
- モデル: `gemini-2.5-flash-preview-tts`（既定）
- body:
  ```jsonc
  {
    "contents": [{ "parts": [{ "text": "<style>: <本文>" }] }],
    "generationConfig": {
      "responseModalities": ["AUDIO"],
      "speechConfig": { "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Leda" } } }
    }
  }
  ```
- レスポンス: `candidates[0].content.parts[0].inlineData.data` = base64 の **PCM s16le / 24kHz / mono**
- これを **WAV ヘッダ（44 byte, 1ch, 16bit, 24000Hz）でラップ** すれば HTML5 `<audio>` で再生可。

実装物: `ai-monitor/poc/voice/`
- `tts-poc.mjs` … 上記 HTTP を叩いて PCM→WAV を `out/voice.wav` に書き出す（依存ゼロ・Node 標準のみ）
- `play.html` … `out/voice.wav` を読み込み、🔊 ボタン（autoplay 解除兼）で順次再生する最小ページ
- `README.md` … 実行手順（鍵の渡し方・`python3 -m http.server` での再生）

実走結果（本セッション）: 下部「実走ログ」を参照。

確定判断:
- PoC は **WAV24k のまま** ブラウザ再生で十分。帯域 / iOS 互換が問題になったら mp3/opus 変換を Phase 5/6 で検討。
- voice=`Leda` / style 前置の方式は ai-twitch-cast 流用で確定。
- 本番（server モード）では TTS を `interface TtsProvider { synthesize(text): Promise<{bytes,mime}> }` で抽象化し、
  既定 Gemini。`hash(text+voice)` でキャッシュ。utterance ストア + `GET /api/voice/audio/:id`（Phase 5）。

---

## Part 4: redaction / 保持方針（確定）

ミラー採用により **セッション本文（transcript 末尾・要約）が Cloudflare + g3plus + AI プロバイダを通過** する。
これを許容範囲に抑えるための方針を確定する。

### 1) 対象範囲の allowlist
- `CCM_MIRROR_PROJECTS`（クライアント env, カンマ区切りの projectDir または cwd 部分一致）。
- **未設定なら何も push しない（fail-safe）**。明示的に許可したプロジェクトだけがミラー対象。

### 2) redaction（送信前にクライアントで必ず適用）
`ai-monitor/src/redaction.ts`（純関数・本セッションで PoC 実装 + テスト）。対象パターン:
- API キー類: `sk-ant-…` / `sk-…` / `AIza…`（Google） / `gh[pousr]_…`（GitHub） / AWS `AKIA…`
- Bearer / Authorization ヘッダ値、`xox[baprs]-…`（Slack）
- 秘密鍵ブロック `-----BEGIN … PRIVATE KEY-----`
- `.env` 風 `KEY=value` の **値側**（KEY 名に SECRET/TOKEN/PASSWORD/KEY/CREDENTIAL を含む場合）
- マスク表現は `«redacted:種別»` に統一（何が伏せられたか分かるが値は出さない）。

### 3) サイズ上限
- 1 テキスト（tail 各本文・event.text）: 既定 2KB で末尾トリム（`…`）。
- snapshot 全体: 既定 256KB。超過分は events を古い方から落とす。
- 音声 detail 文: tool 名/入力は送らず、〜50 字に切り詰め（ペルソナ生成は Part5）。

### 4) 保持方針
- **既定はメモリ + TTL のみ**。停止後の保持は既存仕様に倣い 24h（`STOPPED_RETENTION_SEC = 86_400`）。
- 再起動で揮発 → クライアントが再 push して自己回復。
- 永続化（`data/` ボリューム）は **opt-in**（Phase 7 以降、必要になってから）。

### 5) 文書化
- 「セッション内容が外部（Cloudflare / g3plus / Anthropic / Gemini）を通過する」ことを Phase 8 で README / CLAUDE.md に明記。

---

## Phase 1 完了条件（チェック）

- [x] Part 1: `EntrySource` 導入リファクタが入り、`npm test` 緑・`npm run build` 通過・挙動不変
- [x] Part 3: TTS PoC スクリプト + 再生ページがあり、実走で WAV 生成 → 配信路まで確認（最終の音出しは実ブラウザでの 🔊 クリックのみ残）
- [x] Part 4: redaction 方針確定 + `redaction.ts` + テスト緑
- [ ] Part 2: 別作業（本ファイルでは done 扱いにしない。ユーザー側完了後に親 TODO で消化）

## 次フェーズへの申し送り

- Phase 3 で `EntrySource` に `getEvents(id)`（process 詳細用）を追加し `RemoteEntrySource` を実装。
- Phase 3/5 で Summarizer を合成キー対応にする（jsonlPath 依存の除去）。
- Phase 4 で uplink がこの redaction + サイズ上限 + allowlist を通してから push。
- Phase 5 で `TtsProvider` 抽象 + utterance ストア。PoC の HTTP 呼び出しをサーバへ移植。

## 実走ログ

### 2026-06-18 Part 1 / Part 4（コード + テスト）
- 追加: `ai-monitor/src/entry-source.ts`（`EntrySource` / `LocalEntrySource`）+ `entry-source.test.ts`
- 変更: `ai-monitor/src/server.ts` — `startServer(opts, source = new LocalEntrySource())`、6 箇所の `buildEntries({summarizer})` を `source.buildEntries(...)` に。`cli.ts` は無変更（後方互換）。
- 追加: `ai-monitor/src/redaction.ts`（`redact` / `truncate` / `sanitizeText`）+ `redaction.test.ts`
- 結果: `npm run build` 通過 / `npm test` = **39 tests, 39 pass, 0 fail**（挙動不変を確認）。

### 2026-06-18 Part 3（Gemini TTS PoC 実走）
- 追加: `ai-monitor/poc/voice/`（`tts-poc.mjs` / `play.html` / `README.md`）、`out/` は gitignore。
- 鍵: `~/ai-twitch-cast/.env` の `GEMINI_API_KEY` を流用（ユーザー承認済み、外部 API 課金 1 回）。
- 実走: `model=gemini-2.5-flash-preview-tts` / `voice=Leda` / style 前置。
  - 出力 `out/voice.wav` = **284,730 bytes**（PCM 284,686 bytes）/ **約 5.93s** / レイテンシ **4,172ms**。
  - 検証: `file` → `RIFF WAVE Microsoft PCM, 16 bit, mono 24000 Hz`、`python3 wave` → ch=1/16bit/24000Hz/5.93s。
  - 配信路: `python3 -m http.server` で `play.html`=200(text/html)、`out/voice.wav`=200(`audio/x-wav`, 284730 bytes)。
  - 残: 実ブラウザでの 🔊 クリックによる音出し確認（人手・README 手順どおり）。
- 確定: PoC は **WAV24k のままブラウザ再生で十分**。HTTP 直叩きで成立 → `google-genai` 依存は不要。
