import express, { Request, Response } from 'express';
import { buildEntries, decodeId, type MonitorEntry } from './state';
import { projectsDir } from './transcript';
import { renderDashboard, renderNotFound, renderProcessView } from './views';

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
    const dot = e.state === 'active' ? '●' : e.state === 'recent' ? '◐' : '○';
    items.push({
      id: `proc:${e.id}`,
      label: e.cwd,
      sub: `PID ${e.process?.pid ?? '—'} · ${e.state}`,
      group: 'processes',
      badge: dot,
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

  // すべてのレスポンスに CORS を付ける (ループバック専用前提で `*`)
  app.use((_req, res, next) => {
    corsHeaders(res);
    next();
  });

  app.get('/api/sidebar', async (_req: Request, res: Response) => {
    try {
      const entries = await buildEntries();
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
      const entries = await buildEntries();
      if (itemId === 'dashboard' || itemId === '') {
        res.send(renderDashboard(entries));
        return;
      }
      if (itemId.startsWith('proc:')) {
        const id = itemId.slice('proc:'.length);
        const cwd = decodeId(id);
        if (!cwd) {
          res.status(400).send(renderNotFound('item id が不正です'));
          return;
        }
        const entry = entries.find(e => e.cwd === cwd);
        if (!entry) {
          res.status(404).send(renderNotFound(`プロセスが見つかりません: ${cwd}`));
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

  app.get('/api/watch', async (req: Request, res: Response) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let alive = true;
    let lastFingerprint = '';
    let lastItemKey = new Map<string, number>(); // id → mtimeMs

    const tick = async (): Promise<void> => {
      if (!alive) return;
      try {
        const entries = await buildEntries();
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
        // jsonl mtime 変化検出 → item-changed
        for (const e of entries) {
          const mt = e.transcript?.mtimeMs ?? 0;
          const id = `proc:${e.id}`;
          const prev = lastItemKey.get(id);
          if (prev !== undefined && prev !== mt) {
            res.write(`event: item-changed\ndata: ${JSON.stringify({ id })}\n\n`);
            // dashboard も「直近イベント」列が変わるので一緒に通知
            res.write(`event: item-changed\ndata: ${JSON.stringify({ id: 'dashboard' })}\n\n`);
          }
          lastItemKey.set(id, mt);
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
    });
  });

  // ヘルスチェック / デバッグ用
  app.get('/', (_req: Request, res: Response) => {
    res.type('text').send('ai-monitor: see /api/sidebar, /view?item=dashboard, /api/watch');
  });

  app.listen(opts.port, opts.host, () => {
    console.log(`[ai-monitor] running at http://${opts.host}:${opts.port}`);
    console.log(`[ai-monitor] projects dir: ${projectsDir()}`);
    console.log('[ai-monitor] endpoints: /api/sidebar, /view?item=..., /api/watch');
  });
}
