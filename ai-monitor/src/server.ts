import path from 'path';
import express, { Request, Response } from 'express';
import { ensureAwaitingInputDir, watchAwaitingInputMarkers } from './awaiting-input';
import { buildEntries, decodeId, type ActivityState, type MonitorEntry } from './state';
import { Summarizer } from './summarize';
import { findLastUserText, projectsDir, readTailEvents } from './transcript';
import { buildProcessViewData, entryToDashboardCardData, renderDashboard, renderNotFound, renderProcessView } from './views';

interface ServerOptions {
  port: number;
  host: string;
}

function corsHeaders(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
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

export function startServer(opts: ServerOptions): void {
  const app = express();

  // PermissionRequest hook の marker 置き場を起動時に確保しておく
  // (`fs.watch` は存在しないディレクトリを監視できないため)
  ensureAwaitingInputDir();

  // 要約が完了したタイミングで購読中の SSE クライアントに通知するためのリスナ集合
  const summaryListeners = new Set<() => void>();
  const summarizer = new Summarizer({
    onUpdate: () => {
      for (const fn of summaryListeners) {
        try { fn(); } catch { /* リスナのエラーは握りつぶす */ }
      }
    },
  });

  // すべてのレスポンスに CORS を付ける (ループバック専用前提で `*`)
  app.use((_req, res, next) => {
    corsHeaders(res);
    next();
  });

  // Phase 1 で追加。ダッシュボード iframe を自己更新化するための軽量 JSON API。
  // `renderDashboard` と同じ整形ロジック (entryToDashboardCardData) を共有するので、
  // クライアント側で時刻フォーマット / preview 切り詰めを再実装する必要はない。
  app.get('/api/dashboard.json', async (_req: Request, res: Response) => {
    try {
      const entries = await buildEntries({ summarizer });
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
      const projectDir = decodeId(itemId.slice('proc:'.length));
      if (!projectDir) {
        res.status(400).json({ error: 'invalid id' });
        return;
      }
      const entries = await buildEntries({ summarizer });
      const entry = entries.find(e => e.projectDir === projectDir);
      if (!entry) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json(buildProcessViewData(entry));
    } catch (err) {
      console.warn('[ai-monitor] /api/process.json 失敗', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  app.get('/api/sidebar', async (_req: Request, res: Response) => {
    try {
      const entries = await buildEntries({ summarizer });
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
      const entries = await buildEntries({ summarizer });
      if (itemId === 'dashboard' || itemId === '') {
        res.send(renderDashboard(entries));
        return;
      }
      if (itemId.startsWith('proc:')) {
        const id = itemId.slice('proc:'.length);
        const projectDir = decodeId(id);
        if (!projectDir) {
          res.status(400).send(renderNotFound('item id が不正です'));
          return;
        }
        const entry = entries.find(e => e.projectDir === projectDir);
        if (!entry) {
          res.status(404).send(renderNotFound(`プロセスが見つかりません: ${projectDir}`));
          return;
        }
        res.send(renderProcessView(entry));
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
      const projectDir = decodeId(itemId.slice('proc:'.length));
      if (!projectDir) {
        res.status(400).json({ error: 'invalid id' });
        return;
      }
      const entries = await buildEntries({ summarizer });
      const entry = entries.find(e => e.projectDir === projectDir);
      if (!entry || !entry.transcript) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (!summarizer.isEnabled()) {
        res.json({ state: 'unavailable' });
        return;
      }
      // 要約は state 判定 (50 件) より広い窓 + ピン留め user-text で組み立てる。
      // ツール往復が連続するセッションでも「直前のユーザー依頼」を必ず混ぜ込むため。
      // 窓を 300 にしているのは、renderEventsForPrompt 側で tool-use / tool-result を捨てるため
      // 150 だとツール往復の多いセッションで user/assistant の往復が数件しか拾えなくなるから。
      const events = readTailEvents(entry.transcript.jsonlPath, 300);
      const recalled = findLastUserText(entry.transcript.jsonlPath, entry.transcript.mtimeMs);
      // ?force=1 → キャッシュを無視して必ず再計算 (UI「再要約」ボタンで使う)
      const force = String(req.query.force ?? '') === '1';
      const result = summarizer.getOrCompute(
        entry.transcript.jsonlPath,
        entry.transcript.mtimeMs,
        { events, recentUserText: recalled ?? undefined },
        { force },
      );
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
        const entries = await buildEntries({ summarizer });
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

    // PermissionRequest hook の marker ディレクトリ変化で即時 tick を回す
    // (ポーリングだけだと最大 2 秒のラグが出る)。watch が張れない FS でも
    // ポーリングで拾えるので失敗は問題なし。
    // tick が走行中なら次の tick はリエントラントに走らないよう簡易ガード。
    let tickInflight = false;
    const triggerTick = (): void => {
      if (!alive || tickInflight) return;
      tickInflight = true;
      void tick().finally(() => { tickInflight = false; });
    };
    const stopMarkerWatch = watchAwaitingInputMarkers(triggerTick);

    // 初回呼び出しで現在状態をベースラインに乗せる (即時 sidebar push)
    await tick();
    // 2 秒間隔のポーリング
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
      stopMarkerWatch();
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
