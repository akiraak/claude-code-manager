# WebUI のボイス種別チェックでサーバ側の生成を抑止する

## 目的・背景

進捗音声 (server モード) の **Haiku 台本生成 + Gemini TTS は、ブラウザのチェックを外しても止まらない**。

- 現状の WebUI チェック (完了 / 承認待ち / 途中経過) は **ブラウザ単位の再生フィルタ**でしかない
  - `ai-monitor/src/views.ts` の `passes()` (≈ `views.ts:1148`)。`ccm-voice-kinds` (localStorage) に入っている種別だけ再生キューに積む。
  - チェックを外しても、サーバは `voice-event` を受けるたびに **台本 (Haiku) → TTS (Gemini) → utterance 保存 → SSE 配信**まで実行し、手元で鳴らさないだけ。**API/TTS コストは発生し続ける**。
- 生成自体を止める手段は env `CCM_VOICE_SPOKEN_KINDS` のみ (`voice-pipeline.ts:67-80` `parseSpokenKinds` → `server.ts:146` → `VoicePipeline` の静的 set → ゲート `voice-pipeline.ts:147`)。
  - これは **server 再起動が必要・全端末一律・即時反映でない**。

### 狙い

UI のチェック (と 🔊 ON/OFF) で **生成そのもの**を抑止する。

- API/TTS コスト削減 (誰も聴いていない種別・誰も見ていない時間帯は生成しない)
- 再起動不要・即時反映
- env の一律設定ではなく「いま接続している視聴者が欲しい種別」で動的に決める

## 用語の整理 (重要)

このコードベースの `clientId` は **発話元の端末** (`run-ai-monitor-client.sh` を動かしている PC) を指す。**ブラウザでダッシュボードを見ている視聴者**ではない。本機能では後者を **viewer** と呼び、新しい識別子 **`sub` (subscriber id)** を導入する。`clientId` (発話元端末) とは別物。

- 生成は「サーバで 1 本」(発話元端末ごとではなく、サーバ集約後に 1 イベント = 1 会話を生成)。
- 再生フィルタ (`passes()`) は「viewer ごと」(localStorage)。
- 本機能は **viewer 群の希望を集約して生成を絞る**。

## 現状の経路 (調査で確認済み)

### 生成パイプライン (止めたい対象)
```
POST /api/ingest/voice-event            ingest.ts:253-271 (validateVoiceEvent 98-134)
  → onVoiceEvent → pipeline.enqueue     server.ts:197
  → VoicePipeline.handle                voice-pipeline.ts:145
      ├─ ゲート: spokenKinds.has(kind)  voice-pipeline.ts:147  ← ここが唯一の生成抑止点 (静的 set)
      ├─ persona.generate (Haiku)       persona.ts:468  ← コスト
      ├─ tts.synthesize (Gemini)        tts.ts:119      ← コスト
      ├─ store.put (utterance 保存)     voice-store.ts:110
      └─ onUtterance → SSE voice-utterance  server.ts:443-449
```
- `spokenKinds` は **env から作る静的 set** (`server.ts:146` `parseSpokenKinds(process.env.CCM_VOICE_SPOKEN_KINDS)` → コンストラクタで `new Set`)。viewer の状態は一切見ていない。

### 再生フィルタ (viewer ごと・残す)
- `views.ts` `DASHBOARD_VOICE_SCRIPT` (≈ `views.ts:1066-`)。
- localStorage: `ccm-voice-enabled` (🔊 ON/OFF) / `ccm-voice-volume` / `ccm-voice-kinds` (種別) / `ccm-voice-client` (端末フィルタ)。
- `passes(meta)` (`views.ts:1148`) が `kindOn(kind)` と `clientFilter` で再生を間引く。チェック変更で `ccm-voice-kinds` を更新 (`views.ts:1293-1301`)。
- 初期履歴 `GET /api/voice/recent.json`、ライブは `EventSource('/api/watch')` の `voice-utterance` (`views.ts:1341-1347`)。

### SSE 接続のライフサイクル (viewer 在線の足場)
- `GET /api/watch` (`server.ts:375`)。接続ごとに `voiceListeners.add(onVoice)` (`server.ts:449`)、切断時 `req.on('close')` で `voiceListeners.delete` 他を解除 (`server.ts:482-489`)。
- **この接続の開閉が「viewer がいる/いなくなった」の自然なシグナル**。ここに sub の登録/解除を相乗りさせる。
- `/api/watch` は同一オリジン (vibeboard customTabs が `baseUrl: http://127.0.0.1:8190` の iframe で直接ロード) なので、追加 API も **同一オリジン (CORS 不要)**。

## 設計判断 (TODO の論点への回答)

### 1. 集約ポリシー = 和集合 (union, 「誰か ON なら生成」)
複数 viewer がいるとき、ある種別 K を生成するのは **接続中で 🔊 ON の viewer のうち 1 人でも K にチェックしている**とき。
- union なら「自分が外した種別を、別の viewer が聴けなくなる」事故が起きない (安全側)。
- 再生は従来どおり viewer ごとの `passes()` で更に絞る → **生成 = union / 再生 = viewer 個別**の二層。viewer A=完了のみ, viewer B=途中経過のみ なら、生成は完了+途中経過、A は完了だけ・B は途中経過だけ再生。
- 全 viewer が K を外す or viewer ゼロ → K は生成されない (= コスト削減の本体)。

### 2. env と UI の優先順位 = env はハード上限 (ceiling)、UI はその範囲内で絞るだけ
`CCM_VOICE_SPOKEN_KINDS` (server 運用者のコスト上限) を**天井**として維持する。UI は天井の**内側でしか**動かせない。
```
envAllow   = parseSpokenKinds(CCM_VOICE_SPOKEN_KINDS)   // 既定 completed,awaiting,progress
viewerUnion = ∪ { sub.kinds : sub が接続中 かつ enabled(🔊ON) }
effective  = envAllow ∩ viewerUnion                     // ← 実際に生成する種別
```
- env が `progress` を外していれば、viewer が途中経過にチェックしても **progress は生成しない** (運用者のコスト上限が常に勝つ)。
- `started` は従来どおりどの設定でも生成しない (`parseSpokenKinds` が弾く)。
- 不採用案: env を「初期値」にして UI が上書きで増やせる方式 → 1 viewer が運用者の止めた高コスト種別を復活できてしまうので却下。

### 3. viewer ゼロ時 = 無音 (これがコスト削減の主目的)
🔊 ON の viewer が 0 人 (= `viewerUnion` 空) なら `effective` も空 → **何も生成しない**。
- 誰もダッシュボードを見ていない時間帯の Haiku/TTS をまるごと節約する。
- トレードオフ: その間のイベントは utterance が残らない → 後から種別 ON + リロードしても履歴に出ない。コスト削減と引き換えに許容する (本プランの明示的な割り切り)。

### 4. 種別のみ対象。端末 (clientId) フィルタによる生成抑止は対象外 (将来)
TODO は種別チェック (完了/承認待ち/途中経過) が対象。`ccm-voice-client` (端末フィルタ) による生成抑止は、viewer ごとの許可端末集合を server が和集合管理する別設計が要るため**今回は対象外**。端末フィルタは従来どおり**再生のみ**に効く。

### 5. ロールバック弁 = `CCM_VOICE_UI_GATING` (on|off)
新 env `CCM_VOICE_UI_GATING` を用意し、`off` のときは **registry を見ず envAllow をそのまま生成**する (= 現行 100% 互換)。
- 不具合時は env 1 つで即座に従来挙動へ戻せる。
- 段階導入したい場合は最初 `off` で prefs エンドポイントだけ稼働確認 → `on` に切替も可能。
- **既定値は段階導入の安全性のため Phase によって変える**:
  - Phase 1〜3 の間 (viewer 登録経路が未完成の間) は **既定 `off`**。on にすると登録 viewer が常にゼロ → `effectiveKinds` が常に空 → **全種別が無音**になってしまうため。各コミット時点で「default 設定のまま起動しても従来どおり鳴る」状態を保つ。
  - 登録経路 (Phase 2 `/api/watch ?sub` + `POST /api/voice/prefs`、Phase 3 ブラウザ sub 採番) が揃う **Phase 4 で既定を `on`** (savings 既定) に切り替える。
  - それまでに gating を検証するときは明示的に `CCM_VOICE_UI_GATING=on` を指定する。

### 後方互換の論点 (古いキャッシュのダッシュボード)
- **`?sub` を宣言した `/api/watch` 接続だけ**を voice viewer として数える。`?sub` なしの `/api/watch` (proc 詳細 / sidebar の iframe、旧キャッシュのタブ) は voice viewer に数えない → これらは生成を生かし続けない。
- そのため「`?sub` を送らない**旧キャッシュのダッシュボードタブ**」は、リロードするまで一時的に無音になりうる。
  - これは自己回復する軽微・一時的な退行 (タブ再読込で解消)。ローカル/個人向けツールとして許容。
  - 安全策として `CCM_VOICE_UI_GATING=off` で従来挙動に即戻せる (上記 5)。
  - デプロイ後は開いているダッシュボードを 1 度リロードすれば新 JS (`?sub` 宣言) になる。

## 対応方針 (実装) — Phase / Step

### Phase 1 — server: viewer registry + 動的ゲート (コア)
- **1-1** 新規 `ai-monitor/src/voice-subscribers.ts` に `VoiceSubscriberRegistry` を実装 (時刻注入・他ストアと同方針で `Date.now()` を内部で呼ばない)。
  - 保持: `Map<sub, { kinds: Set<VoiceEventKind>, enabled: boolean, lastSeenMs: number }>`。
  - `register(sub, prefs, now)` / `update(sub, prefs, now)` / `touch(sub, now)` / `remove(sub)`。
  - `effectiveKinds(envAllow: ReadonlySet, now): Set<VoiceEventKind>`:
    - TTL 掃き出し (既定 `SUBSCRIBER_TTL_MS` ≈ 90s、SSE ping=30s より十分長い・切断検出のバックストップ)。
    - `enabled` な sub の `kinds` を union → `envAllow` と積集合して返す。
    - viewer ゼロ → 空集合。
  - 全要素を検証 (kinds は `awaiting|completed|progress` のみ、`started`/未知は捨てる)。
- **1-2** `VoicePipeline` (`voice-pipeline.ts`) に `spokenKindsProvider?: () => ReadonlySet<VoiceEventKind>` を `VoicePipelineDeps` 追加。
  - `handle` のゲート (`voice-pipeline.ts:147`) を「provider があればそれを毎回参照、無ければ従来の静的 `spokenKinds`」に変更:
    ```ts
    const spoken = this.spokenKindsProvider ? this.spokenKindsProvider() : this.spokenKinds;
    if (!spoken.has(event.kind)) return [];
    ```
  - provider 未指定なら**完全に従来挙動** (既存テスト・env のみ運用を壊さない)。
- **1-3** `server.ts` で registry を生成し provider を配線:
    ```ts
    const envAllow = new Set(parseSpokenKinds(process.env.CCM_VOICE_SPOKEN_KINDS));
    const uiGating = (process.env.CCM_VOICE_UI_GATING ?? 'off') !== 'off';  // 既定 off (Phase 4 で on へ。理由は §5)
    const spokenKindsProvider = uiGating
      ? () => subscribers.effectiveKinds(envAllow, Date.now())
      : undefined;   // off は従来の静的 spokenKinds=envAllow
    ```
  - `off` 時は従来どおり `spokenKinds: parseSpokenKinds(...)` を渡し provider を渡さない。

### Phase 2 — server: SSE ライフサイクル連携 + prefs エンドポイント
- **2-1** `/api/watch` (`server.ts:375`) に viewer 登録/解除を相乗り (server モードのみ):
  - 接続時、`?sub` があれば `subscribers.register(sub, seed, now)`。seed は `?voice`(0|1) と `?kinds`(csv) から (POST 到着前の取りこぼし防止)。`?sub` 無し接続は voice viewer に数えない。
  - 既存の即時 tick トリガと同様、ping (`server.ts:477`) のタイミングで `subscribers.touch(sub, now)`。
  - `req.on('close')` (`server.ts:482-489`) に `subscribers.remove(sub)` を追加。
- **2-2** `POST /api/voice/prefs` を server モードのみマウント (`server.ts:204-226` の voice 系エンドポイント群と並べる)。
  - `express.json({ limit: '4kb' })` をこのルートに付ける (ingest と同様にルート単位で body parse)。
  - body `{ sub: string, enabled: boolean, kinds: string[] }` を厳格検証 → `subscribers.update(sub, {enabled, kinds}, Date.now())`。
  - 同一オリジン (CORS 不要)。Bearer 不要 (`/api/voice/*` 既存と同列・本番は Cloudflare Access 配下)。
  - レスポンスは `{ effective: [...] }` を返し、デバッグ/将来の UI 表示に使えるようにする (任意)。
- **2-3** ログ: effective set が変わったら `[ai-monitor] voice: effective=<kinds> (viewers=N, env=<envAllow>)` を出す。生成が抑止されている状況を運用で確認できるように。

### Phase 3 — browser: sub 採番 + prefs 送信
- **3-1** `views.ts` `DASHBOARD_VOICE_SCRIPT`:
  - `sub` を採番 (sessionStorage `ccm-voice-sub`。タブ内 SSE 再接続で不変)。
  - `EventSource('/api/watch?sub=<sub>&voice=<0|1>&kinds=<csv>')` に変更 (初期 seed)。
  - `POST /api/voice/prefs {sub, enabled, kinds}` を送る契機:
    - 初期ロード時 (権威ある初期値)。
    - 種別チェック変更時 (`views.ts:1293-1301` のハンドラに追記)。
    - 🔊 ON/OFF 切替時 (`enabled`)。
  - SSE `onerror`/再接続時は同 URL で再登録される + 念のため prefs を再 POST。
  - `passes()` (再生フィルタ) は**変更しない** (生成=union, 再生=viewer 個別の二層を維持)。
- **3-2** 旧キャッシュ互換の注記をスクリプト冒頭コメントに残す (`?sub` 宣言が savings の前提)。

### Phase 4 — docs / env / テスト
- **4-1** `CLAUDE.md` の「進捗音声」節を更新:
  - `CCM_VOICE_SPOKEN_KINDS` は**ハード上限 (天井)**、UI のチェックは天井内で**生成を絞る** (union 集約・viewer ゼロは無音)。`passes()` は引き続き viewer ごとの再生フィルタ。
  - 新 env `CCM_VOICE_UI_GATING` (on|off) を追記。
- **4-2** `.env.example` / deploy `.env.example` に `CCM_VOICE_UI_GATING` を追記し、`CCM_VOICE_SPOKEN_KINDS` のコメントを「天井」と明記。
- **4-3** `server.ts` の `CCM_VOICE_UI_GATING` 既定を `off` → `on` に切り替える (登録経路が Phase 3 で揃うため。§5)。
- **4-4** テスト (下記「テスト方針」)。

## 影響範囲

| ファイル | 変更 |
|---|---|
| `ai-monitor/src/voice-subscribers.ts` | **新規** registry (union∩env / TTL / 時刻注入) |
| `ai-monitor/src/voice-pipeline.ts` | `spokenKindsProvider?` 追加・`handle` ゲート (`:147`) を provider 参照に。未指定は従来互換 |
| `ai-monitor/src/server.ts` | registry 生成・provider 配線・`CCM_VOICE_UI_GATING`・`/api/watch` 登録/解除・`POST /api/voice/prefs`・effective ログ |
| `ai-monitor/src/views.ts` | `sub` 採番・SSE URL に `?sub&voice&kinds`・prefs POST (初期/種別/ON-OFF)。`passes()` は不変 |
| `ai-monitor/src/ingest.ts` | **変更なし** (生成抑止は pipeline ゲートで行うため。ingest は集約ストア記録を継続) |
| `CLAUDE.md` / `.env.example` / deploy `.env.example` | env ドキュメント (天井 + `CCM_VOICE_UI_GATING`) |
| client (`uplink.ts` 等) | **変更なし** (端末→server の push は据え置き。viewer 集約は server 内で完結) |

- client は引き続き全 voice-event を push する (生成抑止は server 側で行う)。帯域も削りたい場合は将来 client 側で出さない案 (別タスク) を検討。

## テスト方針

### 自動テスト (unit)
- `voice-subscribers.test.ts` (新規):
  - union: viewerA=[completed], viewerB=[progress] → `effectiveKinds` = {completed, progress} (env=全許可時)。
  - env 天井: env=[completed,awaiting] のとき viewer=[progress] → 空 (progress は天井外)。
  - viewer ゼロ → 空集合。
  - `enabled=false` (🔊 OFF) の viewer は union に寄与しない。
  - TTL: `lastSeen + TTL` を過ぎた sub は `effectiveKinds` で除外 (時刻注入)。
  - `remove` 後は寄与しない。
- `voice-pipeline.test.ts` (追記):
  - `spokenKindsProvider` が空集合を返すと、completed イベントでも utterance 0 件 (Haiku/TTS 未呼び出し = `onUtterance` 未発火)。
  - provider が {completed} を返すと completed は生成・progress は 0 件。
  - **provider 未指定**なら従来どおり静的 `spokenKinds`/`SPOKEN_KINDS` で動く (後方互換)。
- `ingest`/prefs 検証 (該当 test 追記 or 新規):
  - `POST /api/voice/prefs` の body 検証 (kinds は許可種別のみ・型/配列長)。不正は 400、`started`/未知 kind は無視。

### 手動 / 運用テスト
1. `./run-ai-monitor.sh` (server) + 1 端末 client で起動。
2. ダッシュボードで全種別 ON → 完了/承認待ち/途中経過が生成・再生されることを確認。
3. 「途中経過」を外す → `logs/voice-server.log` に `[progress]` が**新たに出ない**こと、effective ログが `effective=completed,awaiting` になることを確認。
4. ダッシュボードのタブを全部閉じる → 新規 voice-event があっても**生成ログが出ない** (viewers=0)。
5. 2 タブで別々の種別をチェック → union で両方生成、各タブは自分のチェックぶんだけ再生されること。
6. `CCM_VOICE_UI_GATING=off` で再起動 → UI のチェックに関わらず env どおり生成 (ロールバック確認)。

## ロールバック
- `CCM_VOICE_UI_GATING=off` + server 再起動で従来 (env 静的) 挙動へ即復帰。コードは provider 未指定で従来パスに落ちるので安全。

## 未決事項
- `CCM_VOICE_UI_GATING` の**最終的な**既定 (Phase 4 以降) を `on` (savings 既定) とするか `off` とするか。**推奨は `on`** (本機能の目的がコスト削減のため)。要確認。なお Phase 1〜3 の間は登録経路未完成のため既定 `off` 固定 (§5)。
- `SUBSCRIBER_TTL_MS` の既定 (案 90s)。SSE ping=30s・切断検出が確実なので大きめでも可。**(Phase 1 で `DEFAULT_SUBSCRIBER_TTL_MS = 90s` で実装済み)**
- viewer ゼロ時に「履歴だけは残したい」ニーズが出たら、no-viewer 時のフォールバック生成を別 env で用意するか検討 (現状は無音=コスト削減優先)。

## TODO 反映
- 親タスク「WebUI のボイス種別チェックでサーバ側生成も止める」に本プランをリンクし、Phase 1〜4 を子タスクとして追加する。
