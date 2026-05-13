import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProcessViewData, entryToDashboardCardData, renderDashboard, renderProcessView } from './views';
import type { MonitorEntry } from './state';

function makeEntry(over: Partial<MonitorEntry> = {}): MonitorEntry {
  return {
    id: 'enc',
    projectDir: '-home-user-foo',
    cwd: '/home/user/foo',
    state: 'waiting',
    ...over,
  };
}

test('entryToDashboardCardData: 必要フィールドが揃い、相対時刻と PID が meta に出る', () => {
  const lastActivityAt = new Date(Date.now() - 5_000).toISOString();
  const data = entryToDashboardCardData(
    makeEntry({
      state: 'ai-processing',
      process: { pid: 12345, cwd: '/home/user/foo' },
      lastActivityAt,
      tail: {
        lastUserText: '  hello world  ',
        lastUserAt: '2026-05-13T08:00:00.000Z',
        lastAssistantText: 'reply',
        lastAssistantAt: '2026-05-13T08:00:01.000Z',
        endsWithInteractiveToolUse: false,
        endsWithLocalCommand: false,
      },
      summary: { state: 'ok', text: '実装中', generatedAt: Date.now() },
    }),
  );

  assert.equal(data.id, 'enc');
  assert.equal(data.itemId, 'proc:enc');
  assert.equal(data.hashPath, 'ai-monitor/proc%3Aenc');
  assert.equal(data.cwd, '/home/user/foo');
  assert.equal(data.cwdShort, 'foo');
  assert.equal(data.state, 'ai-processing');
  assert.equal(data.stateLabel, 'AI処理中');
  assert.equal(data.pid, 12345);
  assert.equal(data.lastActivityAt, lastActivityAt);
  assert.match(data.lastActivityRel, /^\d+s ago$/);
  assert.match(data.meta, /^PID 12345 · \d+s ago$/);
  assert.equal(data.tail.lastUserText, 'hello world'); // trim 済み
  // `toLocaleTimeString('ja-JP', { hour12: false })` の出力 (環境により hour が
  // 1 桁になる) を緩めに許容する
  assert.match(data.tail.lastUserAt, /^\d{1,2}:\d{2}:\d{2}$/);
  assert.equal(data.tail.lastAssistantText, 'reply');
  assert.deepEqual(data.summary, { state: 'ok', text: '実装中', generatedAt: data.summary!.generatedAt! });
});

test('entryToDashboardCardData: tail / process / summary が無いとき安全なデフォルトを返す', () => {
  const data = entryToDashboardCardData(makeEntry({ state: 'stopped' }));

  assert.equal(data.pid, null);
  assert.equal(data.lastActivityAt, null);
  assert.equal(data.lastActivityRel, '—');
  assert.equal(data.meta, '—'); // PID 部分が落ちて相対時刻のみ
  assert.equal(data.tail.lastUserText, '');
  assert.equal(data.tail.lastUserAt, '--:--:--');
  assert.equal(data.tail.lastAssistantText, '');
  assert.equal(data.tail.lastAssistantAt, '--:--:--');
  assert.equal(data.summary, null);
  assert.equal(data.stateLabel, '停止');
});

test('renderDashboard: Phase 2 で必要な差分パッチ用フックがすべて出ている', () => {
  // 空のとき
  const empty = renderDashboard([]);
  assert.match(empty, /<div class="cards" data-cards hidden>/, 'empty 時は cards コンテナを hidden で出す');
  assert.match(empty, /<div class="empty" data-empty>/, 'empty 時は empty メッセージを表示');
  assert.match(empty, /data-dashboard-meta/, 'meta 行に data-dashboard-meta');
  assert.ok(empty.includes('new EventSource(\'/api/watch\')'), 'live-update スクリプトが埋め込まれている');
  assert.ok(empty.includes('/api/dashboard.json'), 'dashboard.json を fetch する');

  // カードあり
  const html = renderDashboard([
    {
      id: 'enc',
      projectDir: '-home-user-foo',
      cwd: '/home/user/foo',
      state: 'ai-processing',
      process: { pid: 1, cwd: '/home/user/foo' },
    },
  ]);
  assert.match(html, /<div class="cards" data-cards>/, 'カードあり時は cards は表示');
  assert.match(html, /<div class="empty" data-empty hidden>/, 'カードあり時は empty は hidden');
  assert.match(html, /data-card-id="proc:enc"/, '.card に data-card-id が付く');
});

test('buildProcessViewData: jsonl が無いとき events は空・headers は安全なデフォルト', () => {
  const data = buildProcessViewData(makeEntry({ state: 'stopped' }));
  assert.equal(data.itemId, 'proc:enc');
  assert.equal(data.cwdShort, 'foo');
  assert.equal(data.pid, '—');
  assert.equal(data.lastActivityLabel, '—');
  assert.equal(data.sessionId, '—');
  assert.equal(data.stateLabel, '停止');
  assert.deepEqual(data.events, []);
});

test('renderProcessView: Phase 4 で必要な差分パッチ用フックがすべて出ている', () => {
  const html = renderProcessView(makeEntry({
    state: 'ai-processing',
    process: { pid: 999, cwd: '/home/user/foo' },
  }));
  assert.match(html, /data-pid/, 'PID に data-pid マーカー');
  assert.match(html, /data-badge/, 'badge に data-badge マーカー');
  assert.match(html, /data-last-activity/, '最終活動に data-last-activity マーカー');
  assert.match(html, /data-session/, 'session に data-session マーカー');
  assert.match(html, /data-events/, 'events コンテナに data-events マーカー');
  assert.ok(html.includes('window.__procItemId = "proc:enc"'), 'itemId が JS に注入される');
  assert.ok(html.includes('/api/process.json'), 'process.json を fetch する');
  assert.ok(html.includes("new EventSource('/api/watch')"), 'SSE を直接購読する');
});

test('entryToDashboardCardData: 240 文字を超える user text は … で切られる', () => {
  const long = 'a'.repeat(300);
  const data = entryToDashboardCardData(
    makeEntry({
      tail: {
        lastUserText: long,
        lastUserAt: '2026-05-13T08:00:00.000Z',
        endsWithInteractiveToolUse: false,
        endsWithLocalCommand: false,
      },
    }),
  );
  assert.equal(data.tail.lastUserText.length, 241); // 240 + "…"
  assert.ok(data.tail.lastUserText.endsWith('…'));
});
