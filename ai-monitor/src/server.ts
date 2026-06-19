import path from 'path';
import express, { Request, Response } from 'express';
import { assertServerAuthConfigured, bearerAuth } from './auth';
import { ensureAwaitingInputDir, watchAwaitingInputMarkers } from './awaiting-input';
import { LocalEntrySource, type EntrySource } from './entry-source';
import { Cooldown, createIngestRouter, RateLimiter } from './ingest';
import { loadPersona, PersonaGenerator } from './persona';
import { decodeId, type ActivityState, type MonitorEntry } from './state';
import { AggregateStore } from './store';
import { Summarizer } from './summarize';
import { projectsDir } from './transcript';
import { selectTtsProvider } from './tts';
import { VoicePipeline } from './voice-pipeline';
import { isValidUtteranceId, toUtteranceMeta, VoiceStore, type Utterance } from './voice-store';
import { buildProcessViewData, entryToDashboardCardData, renderDashboard, renderNotFound, renderProcessView } from './views';

type ServerMode = 'local' | 'client' | 'server';

interface ServerOptions {
  port: number;
  host: string;
  /** 動作モード。既定 local (現行どおり)。server のみ ingest + 認証 + CORS 限定を有効化する。 */
  mode?: ServerMode;
  /** server モード: ingest を許可する端末別トークン (fail-fast 済みを想定)。 */
  clientTokens?: readonly string[];
  /** server モード: CORS を反映する許可オリジン (空なら CORS ヘッダを付けない)。 */
  corsOrigins?: readonly string[];
  /** server モード: 集約ストア (未指定なら内部生成)。Phase 3 で RemoteEntrySource に渡す。 */
  store?: AggregateStore;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

const STATE_MARK: Record<ActivityState, string> = {
  'ai-processing': '●',
  'awaiting-user': '◆',
  'waiting': '◐',
  'stopped': '○',
};

const STATE_SUB_JA: Record<ActivityState, string> = {
  'ai-processing': 'AI処理中',
  'awaiting-user': '入力待ち',
  'waiting': '待機中',
  'stopped': '停止',
};

function buildSidebarItems(entries: MonitorEntry[]): Array<Record<string, string>> {
  const items: Array<Record<string, string>> = [
    {
      id: 'dashboard',
      label: 'Dashboard',
      sub: '全 CLI のサマリ',
      group: 'dashboard',
    },
  ];
  for (const e of entries) {
    const pid = e.process?.pid;
    const pidPart = pid !== undefined ? `PID ${pid}` : 'PID —';
    items.push({
      id: `proc:${e.id}`,
      label: path.basename(e.cwd) || e.cwd,
      sub: `${pidPart} · ${STATE_SUB_JA[e.state]}`,
      group: 'processes',
      badge: STATE_MARK[e.state],
    });
  }
  return items;
}

/** プロセス+jsonl の現状を ETag 用に「指紋化」する。差分検出に使う。 */
function snapshotFingerprint(entries: MonitorEntry[]): string {
  return entries
    .map(e => `${e.cwd}|${e.process?.pid ?? ''}|${e.transcript?.mtimeMs ?? 0}|${e.state}`)
    .join('\n');
}

export function startServer(opts: ServerOptions, source: EntrySource = new LocalEntrySource()): void {
  const app = express();
  const mode: ServerMode = opts.mode ?? 'local';
  const corsOrigins = opts.corsOrigins ?? [];

  // SSE を ingest 到着で即時更新するためのトリガ集合 (server モードの push 駆動用)。
  // 各 /api/watch 接続が自分の tick トリガを登録し、ingest 到着で一斉に叩く。
  const watchTriggers = new Set<() => void>();
  const notifyWatchers = (): void => {
    for (const fn of watchTriggers) {
      try { fn(); } catch { /* リスナのエラーは握りつぶす */ }
    }
  };

  // PermissionRequest hook の marker 置き場を起動時に確保しておく
  // (`fs.watch` は存在しないディレクトリを監視できないため)
  ensureAwaitingInputDir();

  // utterance 生成完了で購読中の SSE クライアントに `voice-utterance` を push するためのリスナ集合。
  // server モードのみ pipeline.onUtterance が発火させる (local/client では空のまま)。
  const voiceListeners = new Set<(u: Utterance) => void>();

  // 要約が完了したタイミングで購読中の SSE クライアントに通知するためのリスナ集合
  const summaryListeners = new Set<() => void>();
  const summarizer = new Summarizer({
    onUpdate: () => {
      for (const fn of summaryListeners) {
        try { fn(); } catch { /* リスナのエラーは握りつぶす */ }
      }
    },
  });

  // CORS。local/client はループバック専用前提で `*`。
  // server は公開されるため `*` をやめ、許可オリジンの Origin のみ反映する。
  app.use((req, res, next) => {
    if (mode === 'server') {
      const origin = req.headers.origin;
      if (origin && corsOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    next();
  });

  // server モードのみ: 端末別 Bearer 認証付きの Ingestion を有効化する。
  // local/client モードでは一切マウントしない (現行の読み取り専用挙動を維持)。
  if (mode === 'server') {
    const tokens = opts.clientTokens ?? [];
    // cli.ts で fail-fast 済みだが、startServer 直接呼びにも備えて再確認する。
    assertServerAuthConfigured(tokens);
    const store = opts.store ?? new AggregateStore();
    const snapshotLimiter = new RateLimiter({ windowMs: 10_000, max: 30 });
    const voiceCooldown = new Cooldown({ ms: 15_000 });

    // 音声パイプライン: voice-event → ペルソナ短文 (Haiku) → TTS (Gemini 既定) → utterance ストア。
    // persona の声/スタイルを TTS に渡し、生成完了を voiceListeners (SSE) へ push する。
    const persona = loadPersona();
    const personaGen = new PersonaGenerator({ persona });
    const tts = selectTtsProvider(process.env, persona);
    const voiceStore = new VoiceStore();
    const pipeline = new VoicePipeline({
      persona: personaGen,
      tts,
      store: voiceStore,
      onUtterance: (u) => {
        for (const fn of voiceListeners) {
          try { fn(u); } catch { /* リスナのエラーは握りつぶす */ }
        }
      },
    });
    console.log(
      `[ai-monitor] voice: persona=${personaGen.isEnabled() ? 'haiku' : 'fallback'} (${persona.name}), ` +
        `tts=${tts.isEnabled() ? tts.tag : 'none'}`,
    );

    app.use(
      '/api/ingest',
      bearerAuth(tokens),
      express.json({ limit: '512kb' }),
      createIngestRouter({
        store,
        snapshotLimiter,
        voiceCooldown,
        onChange: notifyWatchers,
        // voice-event 到着で音声生成を起動 (best-effort・応答を待たせない)。
        onVoiceEvent: (v) => { void pipeline.handle(v); },
      }),
    );

    // 合成済み音声バイトの配信。id は推測困難な capability (= app 層の「認証付き」)。
    // 本番はさらに Cloudflare Access (email OTP) 配下に置く (Phase 7)。server モードのみマウント。
    app.get('/api/voice/audio/:id', (req: Request, res: Response) => {
      const id = String(req.params.id ?? '');
      if (!isValidUtteranceId(id)) {
        res.status(400).json({ error: 'invalid id' });
        return;
      }
      const utt = voiceStore.get(id, Date.now());
      if (!utt || !utt.audio) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.setHeader('Content-Type', utt.audio.mime);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Length', String(utt.audio.bytes.length));
      res.end(utt.audio.bytes);
    });

    // 直近の発話メタ (bytes 抜き)。Phase 6 の履歴 UI 用。
    app.get('/api/voice/recent.json', (_req: Request, res: Response) => {
      noStore(res);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.json({ utterances: voiceStore.recent(Date.now()) });
    });
  }

  // Phase 1 で追加。ダッシュボード iframe を自己更新化するための軽量 JSON API。
  // `renderDashboard` と同じ整形ロジック (entryToDashboardCardData) を共有するので、
  // クライアント側で時刻フォーマット / preview 切り詰めを再実装する必要はない。
  app.get('/api/dashboard.json', async (_req: Request, res: Response) => {
    try {
      const entries = await source.buildEntries({ summarizer });
      noStore(res);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.json({
        renderedAt: new Date().toISOString(),
        entries: entries.map(entryToDashboardCardData),
      });
    } catch (err) {
      console.warn('[ai-monitor] /api/dashboard.json 失敗', err);
      res.status(500).json({
        renderedAt: new Date().toISOString(),
        entries: [],
        error: 'failed',
      });
    }
  });

  // Phase 4 で追加。プロセス詳細 iframe を自己更新化するための軽量 JSON API。
  // renderProcessView と同じ整形ロジック (buildProcessViewData) を共有する。
  app.get('/api/process.json', async (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    noStore(res);
    try {
      const itemId = String(req.query.id ?? '');
      if (!itemId.startsWith('proc:')) {
        res.status(400).json({ error: 'invalid id' });
        return;
      }
      const id = itemId.slice('proc:'.length);
      if (!id || !decodeId(id)) {
        res.status(400).json({ error: 'invalid id' });
        return;
      }
      const entries = await source.buildEntries({ summarizer });
      // id 一致で探す (local: encodeId(projectDir) / remote: (clientId,projectDir) 合成。どちらも一意)。
      const entry = entries.find(e => e.id === id);
      if (!entry) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json(buildProcessViewData(entry, source.readEvents(entry, 200)));
    } catch (err) {
      console.warn('[ai-monitor] /api/process.json 失敗', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  app.get('/api/sidebar', async (_req: Request, res: Response) => {
    try {
      const entries = await source.buildEntries({ summarizer });
      noStore(res);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.json({ items: buildSidebarItems(entries) });
    } catch (err) {
      console.warn('[ai-monitor] /api/sidebar 失敗', err);
      res.status(500).json({ items: [], error: 'failed' });
    }
  });

  app.get('/view', async (req: Request, res: Response) => {
    const itemId = String(req.query.item ?? '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "frame-ancestors http://127.0.0.1:* http://localhost:*");

    try {
      const entries = await source.buildEntries({ summarizer });
      if (itemId === 'dashboard' || itemId === '') {
        res.send(renderDashboard(entries));
        return;
      }
      if (itemId.startsWith('proc:')) {
        const id = itemId.slice('proc:'.length);
        if (!id || !decodeId(id)) {
          res.status(400).send(renderNotFound('item id が不正です'));
          return;
        }
        const entry = entries.find(e => e.id === id);
        if (!entry) {
          res.status(404).send(renderNotFound(`プロセスが見つかりません: ${id}`));
          return;
        }
        res.send(renderProcessView(entry, source.readEvents(entry, 200)));
        return;
      }
      res.status(404).send(renderNotFound(`未知の item: ${itemId}`));
    } catch (err) {
      console.warn('[ai-monitor] /view 失敗', err);
      res.status(500).send(renderNotFound('内部エラーが発生しました'));
    }
  });

  // 「要約」ボタン押下時の手動トリガ。
  // - 該当 entry を探し、jsonl から末尾イベントを読んで `getOrCompute` に渡す
  // - 即座に現在の状態 (idle/pending/ok/unavailable/error) を返す
  // - 完了時の通知は既存の onUpdate → SSE item-changed で行う (UI 側で iframe reload)
  app.post('/api/summarize', async (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    noStore(res);
    try {
      const itemId = String(req.query.id ?? '');
      if (!itemId.startsWith('proc:')) {
        res.status(400).json({ error: 'invalid id' });
        return;
      }
      const id = itemId.slice('proc:'.length);
      if (!id || !decodeId(id)) {
        res.status(400).json({ error: 'invalid id' });
        return;
      }
      const entries = await source.buildEntries({ summarizer });
      const entry = entries.find(e => e.id === id);
      if (!entry) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (!summarizer.isEnabled()) {
        res.json({ state: 'unavailable' });
        return;
      }
      // 要約の対象 (キャッシュキー・mtime・計算入力) は source が供給する。
      // local は jsonl から 300 件 + findLastUserText、remote は集約ストアから (jsonl 非依存)。
      // 窓を広く取るのは renderEventsForPrompt が tool-use/result を捨てるため
      // (狭いとツール往復の多いセッションで user/assistant が数件しか残らない)。
      const target = source.summaryTargetOf(entry);
      if (!target) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      // ?force=1 → キャッシュを無視して必ず再計算 (UI「再要約」ボタンで使う)
      const force = String(req.query.force ?? '') === '1';
      const result = summarizer.getOrCompute(target.key, target.mtimeMs, target.input, { force });
      res.json(result);
    } catch (err) {
      console.warn('[ai-monitor] /api/summarize 失敗', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  app.get('/api/watch', async (req: Request, res: Response) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let alive = true;
    let lastFingerprint = '';
    // id → "<mtimeMs>|<state>" — state も入れることで marker のみで切り替わる
    // (jsonl mtime は不変な) awaiting-user ↔ waiting の遷移も検出する
    let lastItemKey = new Map<string, string>();

    const tick = async (): Promise<void> => {
      if (!alive) return;
      try {
        const entries = await source.buildEntries({ summarizer });
        const fp = snapshotFingerprint(entries);
        if (fp !== lastFingerprint) {
          // サイドバー構成 (cwd/PID/state) が変わったとき
          const cwdsChanged = lastFingerprint.split('\n').map(s => s.split('|')[0]).sort().join(',')
            !== entries.map(e => e.cwd).sort().join(',');
          const stateChanged = lastFingerprint.split('\n').map(s => `${s.split('|')[0]}|${s.split('|')[3]}`).sort().join(',')
            !== entries.map(e => `${e.cwd}|${e.state}`).sort().join(',');
          if (cwdsChanged || stateChanged || lastFingerprint === '') {
            res.write('event: sidebar\ndata: {}\n\n');
          }
          lastFingerprint = fp;
        }
        // jsonl mtime / state 変化検出 → item-changed
        // state を key に含めることで PermissionRequest marker による遷移
        // (jsonl mtime は変わらない) も拾える
        for (const e of entries) {
          const mt = e.transcript?.mtimeMs ?? 0;
          const id = `proc:${e.id}`;
          const key = `${mt}|${e.state}`;
          const prev = lastItemKey.get(id);
          if (prev !== undefined && prev !== key) {
            res.write(`event: item-changed\ndata: ${JSON.stringify({ id })}\n\n`);
            // dashboard も「直近イベント」「状態バッジ」が変わるので一緒に通知
            res.write(`event: item-changed\ndata: ${JSON.stringify({ id: 'dashboard' })}\n\n`);
          }
          lastItemKey.set(id, key);
        }
        // 居なくなった ID は掃除
        const activeIds = new Set(entries.map(e => `proc:${e.id}`));
        for (const id of Array.from(lastItemKey.keys())) {
          if (!activeIds.has(id)) lastItemKey.delete(id);
        }
      } catch (err) {
        console.warn('[ai-monitor] watch tick 失敗', err);
      }
    };

    // 要約完了をトリガに dashboard を再取得させる
    const onSummaryUpdate = (): void => {
      if (!alive) return;
      try {
        res.write(`event: item-changed\ndata: ${JSON.stringify({ id: 'dashboard' })}\n\n`);
      } catch { /* ignore */ }
    };
    summaryListeners.add(onSummaryUpdate);

    // 新しい utterance ができたら meta (bytes 抜き) を push。ブラウザは id で /api/voice/audio/:id を取りに行く。
    const onVoice = (u: Utterance): void => {
      if (!alive) return;
      try {
        res.write(`event: voice-utterance\ndata: ${JSON.stringify(toUtteranceMeta(u))}\n\n`);
      } catch { /* ignore */ }
    };
    voiceListeners.add(onVoice);

    // 変化検出で即時 tick を回す (ポーリングだけだと最大 2 秒のラグが出る)。
    // tick が走行中なら次の tick はリエントラントに走らないよう簡易ガード。
    let tickInflight = false;
    const triggerTick = (): void => {
      if (!alive || tickInflight) return;
      tickInflight = true;
      void tick().finally(() => { tickInflight = false; });
    };
    // 即時更新のトリガ源はモードで分ける:
    // - server: ingest 到着 (notifyWatchers) で push 駆動。marker はローカル専用なので張らない。
    // - local/client: ローカル FS の PermissionRequest marker 変化で起こす (従来どおり)。
    let stopTrigger: () => void;
    if (mode === 'server') {
      watchTriggers.add(triggerTick);
      stopTrigger = () => { watchTriggers.delete(triggerTick); };
    } else {
      // watch が張れない FS でもポーリングで拾えるので失敗は問題なし。
      const stopMarkerWatch = watchAwaitingInputMarkers(triggerTick);
      stopTrigger = stopMarkerWatch;
    }

    // 初回呼び出しで現在状態をベースラインに乗せる (即時 sidebar push)
    await tick();
    // 2 秒間隔のポーリング (push 駆動のフォールバック)
    const pollInterval = setInterval(tick, 2000);
    // keep-alive
    const pingInterval = setInterval(() => {
      if (!alive) return;
      try { res.write(`: ping\n\n`); } catch { /* ignore */ }
    }, 30000);

    req.on('close', () => {
      alive = false;
      clearInterval(pollInterval);
      clearInterval(pingInterval);
      summaryListeners.delete(onSummaryUpdate);
      voiceListeners.delete(onVoice);
      stopTrigger();
    });
  });

  // ヘルスチェック / デバッグ用
  app.get('/', (_req: Request, res: Response) => {
    res.type('text').send('ai-monitor: see /api/sidebar, /api/dashboard.json, /api/process.json?id=proc:<id>, /view?item=dashboard, /api/watch');
  });

  app.listen(opts.port, opts.host, () => {
    console.log(`[ai-monitor] running at http://${opts.host}:${opts.port}`);
    console.log(`[ai-monitor] projects dir: ${projectsDir()}`);
    console.log('[ai-monitor] endpoints: /api/sidebar, /api/dashboard.json, /api/process.json, /view?item=..., /api/watch');
  });
}
