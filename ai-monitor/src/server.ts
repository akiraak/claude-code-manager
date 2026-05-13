import path from 'path';
import express, { Request, Response } from 'express';
import { enumerateClaudeProcessCandidates, listClaudeProcesses } from './processes';
import { buildEntries, decodeId, type ActivityState, type MonitorEntry } from './state';
import { Summarizer } from './summarize';
import { listTranscripts, projectsDir, readTailEvents } from './transcript';
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

const STATE_MARK: Record<ActivityState, string> = {
  'ai-processing': '●',
  'waiting': '◐',
  'stopped': '○',
  'error': '⚠',
};

const STATE_SUB_JA: Record<ActivityState, string> = {
  'ai-processing': 'AI処理中',
  'waiting': '待機中',
  'stopped': '停止',
  'error': 'エラー',
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
        const debug = req.query.debug === '1';
        res.send(renderDashboard(entries, { debug }));
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
      const events = readTailEvents(entry.transcript.jsonlPath, 50);
      const result = summarizer.getOrCompute(entry.transcript.jsonlPath, entry.transcript.mtimeMs, events);
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
    let lastItemKey = new Map<string, number>(); // id → mtimeMs

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

    // 要約完了をトリガに dashboard を再取得させる
    const onSummaryUpdate = (): void => {
      if (!alive) return;
      try {
        res.write(`event: item-changed\ndata: ${JSON.stringify({ id: 'dashboard' })}\n\n`);
      } catch { /* ignore */ }
    };
    summaryListeners.add(onSummaryUpdate);

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
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Phase 1 デバッグ API (採取が終わったら削除する想定。CLAUDE.md / plan 参照)
  //
  // - /api/debug/processes : pgrep 候補ごとの comm / argv0 / cwd / 採否を JSON で返す
  // - /api/debug/entries   : buildEntries の出力 + transcripts 生情報
  // ──────────────────────────────────────────────────────────────

  app.get('/api/debug/processes', async (_req: Request, res: Response) => {
    noStore(res);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const [candidates, accepted] = await Promise.all([
        enumerateClaudeProcessCandidates(),
        listClaudeProcesses(),
      ]);
      res.json({
        selfPid: process.pid,
        candidates,
        accepted,
        acceptedCount: accepted.length,
        candidateCount: candidates.length,
      });
    } catch (err) {
      console.warn('[ai-monitor] /api/debug/processes 失敗', err);
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/debug/entries', async (_req: Request, res: Response) => {
    noStore(res);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const [entries, transcripts, candidates] = await Promise.all([
        buildEntries({ summarizer }),
        Promise.resolve(listTranscripts()),
        enumerateClaudeProcessCandidates(),
      ]);
      const now = Date.now();
      res.json({
        now,
        entries: entries.map(e => ({
          id: e.id,
          projectDir: e.projectDir,
          cwd: e.cwd,
          state: e.state,
          hasProcess: !!e.process,
          pid: e.process?.pid,
          transcript: e.transcript
            ? {
                jsonlPath: e.transcript.jsonlPath,
                cwd: e.transcript.cwd,
                mtimeMs: e.transcript.mtimeMs,
                ageMs: now - e.transcript.mtimeMs,
                sessionId: e.transcript.sessionId,
              }
            : null,
          tail: e.tail
            ? {
                lastEventKind: e.tail.lastEventKind,
                endsWithUnmatchedToolUse: e.tail.endsWithUnmatchedToolUse,
                lastUserAt: e.tail.lastUserAt,
                lastAssistantAt: e.tail.lastAssistantAt,
              }
            : null,
        })),
        transcripts: transcripts.map(t => ({
          projectDir: t.projectDir,
          jsonlPath: t.jsonlPath,
          cwd: t.cwd,
          mtimeMs: t.mtimeMs,
          ageMs: now - t.mtimeMs,
          sessionId: t.sessionId,
        })),
        processCandidates: candidates,
      });
    } catch (err) {
      console.warn('[ai-monitor] /api/debug/entries 失敗', err);
      res.status(500).json({ error: String(err) });
    }
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
