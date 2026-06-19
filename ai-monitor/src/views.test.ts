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

test('entryToDashboardCardData: clientId があれば clientLabel に入る / 無ければ null', () => {
  assert.equal(entryToDashboardCardData(makeEntry({ clientId: 'wsl2-akira' })).clientLabel, 'wsl2-akira');
  assert.equal(entryToDashboardCardData(makeEntry()).clientLabel, null);
});

test('renderDashboard: clientId があるとカードに送信元ラベル span が出る / 無ければ出ない', () => {
  // <script> 以降の DASHBOARD_LIVE_SCRIPT にも span 文字列リテラルが含まれるので、
  // 実カード部 (最初の <script> より前) に絞って照合する。
  const cardsOnly = (html: string): string => html.split('<script>')[0];
  const withLabel = cardsOnly(renderDashboard([makeEntry({ state: 'waiting', clientId: 'mac-akira' })]));
  assert.match(withLabel, /<span class="card-client"[^>]*>mac-akira<\/span>/);
  const without = cardsOnly(renderDashboard([makeEntry({ state: 'waiting' })]));
  assert.doesNotMatch(without, /<span class="card-client"/); // head の CSS `.card-client {` とは別物
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
  assert.match(empty, /<div class="cards" data-cards-running hidden>/, 'empty 時は起動中コンテナを hidden で出す');
  assert.match(empty, /<div class="cards" data-cards-stopped hidden>/, 'empty 時は停止コンテナを hidden で出す');
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
  assert.match(html, /<div class="cards" data-cards-running>/, '起動中コンテナは表示');
  assert.match(html, /<div class="empty" data-empty hidden>/, 'カードあり時は empty は hidden');
  assert.match(html, /data-card-id="proc:enc"/, '.card に data-card-id が付く');
});

function countMatches(s: string, re: RegExp): number {
  return (s.match(re) ?? []).length;
}

test('renderDashboard: 起動中 / 停止 が両方あるとき 2 セクションに振り分けられる', () => {
  const html = renderDashboard([
    {
      id: 'a',
      projectDir: '-a',
      cwd: '/a',
      state: 'ai-processing',
      process: { pid: 1, cwd: '/a' },
    },
    {
      id: 'b',
      projectDir: '-b',
      cwd: '/b',
      state: 'waiting',
      process: { pid: 2, cwd: '/b' },
    },
    {
      id: 'c',
      projectDir: '-c',
      cwd: '/c',
      state: 'stopped',
    },
  ]);

  // 起動中セクション (2 件): 見出し + 件数 + コンテナが表示
  assert.match(html, /<h2 class="section-title" data-section="running">起動中 <span data-count>2<\/span><\/h2>/);
  assert.match(html, /<div class="cards" data-cards-running>/);
  // 停止セクション (1 件)
  assert.match(html, /<h2 class="section-title" data-section="stopped">停止 <span data-count>1<\/span><\/h2>/);
  assert.match(html, /<div class="cards" data-cards-stopped>/);

  // カードが正しいコンテナに居ること: data-cards-running の直後に proc:a と proc:b、
  // data-cards-stopped の直後に proc:c
  const runningSection = html.match(/<div class="cards" data-cards-running>([\s\S]*?)<\/div>\s*<h2/);
  assert.ok(runningSection, '起動中コンテナの中身を抽出できる');
  assert.match(runningSection![1], /data-card-id="proc:a"/);
  assert.match(runningSection![1], /data-card-id="proc:b"/);
  assert.doesNotMatch(runningSection![1], /data-card-id="proc:c"/);

  const stoppedSection = html.match(/<div class="cards" data-cards-stopped>([\s\S]*?)<\/div>/);
  assert.ok(stoppedSection, '停止コンテナの中身を抽出できる');
  assert.match(stoppedSection![1], /data-card-id="proc:c"/);
  assert.doesNotMatch(stoppedSection![1], /data-card-id="proc:a"/);

  // 全カード数 = 3
  assert.equal(countMatches(html, /data-card-id="proc:/g), 3);
  // empty メッセージは hidden
  assert.match(html, /<div class="empty" data-empty hidden>/);
});

test('renderDashboard: 全件起動中のとき 停止セクションは見出しごと hidden', () => {
  const html = renderDashboard([
    {
      id: 'a',
      projectDir: '-a',
      cwd: '/a',
      state: 'ai-processing',
      process: { pid: 1, cwd: '/a' },
    },
  ]);
  assert.match(html, /<h2 class="section-title" data-section="running">起動中 <span data-count>1<\/span><\/h2>/);
  assert.match(html, /<h2 class="section-title" data-section="stopped" hidden>停止 <span data-count>0<\/span><\/h2>/);
  assert.match(html, /<div class="cards" data-cards-running>/);
  assert.match(html, /<div class="cards" data-cards-stopped hidden>/);
});

test('renderDashboard: 全件停止のとき 起動中セクションは見出しごと hidden / empty は出さない', () => {
  const html = renderDashboard([
    {
      id: 'a',
      projectDir: '-a',
      cwd: '/a',
      state: 'stopped',
    },
    {
      id: 'b',
      projectDir: '-b',
      cwd: '/b',
      state: 'stopped',
    },
  ]);
  assert.match(html, /<h2 class="section-title" data-section="running" hidden>起動中 <span data-count>0<\/span><\/h2>/);
  assert.match(html, /<h2 class="section-title" data-section="stopped">停止 <span data-count>2<\/span><\/h2>/);
  assert.match(html, /<div class="cards" data-cards-running hidden>/);
  assert.match(html, /<div class="cards" data-cards-stopped>/);
  // entries.length > 0 なので empty は hidden
  assert.match(html, /<div class="empty" data-empty hidden>/);
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

test('renderDashboard: 要約 OK のカードに折りたたみ用フックが出る', () => {
  const html = renderDashboard([
    {
      id: 'enc',
      projectDir: '-home-user-foo',
      cwd: '/home/user/foo',
      state: 'waiting',
      process: { pid: 1, cwd: '/home/user/foo' },
      summary: { state: 'ok', text: 'タスク A をやっています', generatedAt: 1 },
    },
  ]);
  // 折りたたみフラグ
  assert.match(html, /<div class="card-summary" data-collapsible data-summary-key="[0-9a-f]+">/);
  // テキストとボタンを内包する content wrapper
  assert.match(html, /<div class="card-summary-content">/);
  // 要約本文
  assert.match(html, /<span class="card-summary-text">要約: タスク A をやっています<\/span>/);
  // トグルボタン (初期は hidden、JS で overflow 判定後に表示される)
  assert.match(html, /<button type="button" class="card-summary-toggle" data-summary-toggle hidden>展開<\/button>/);
  // 再要約ボタン (要約済みカードでも force=1 でキャッシュ無視の再計算ができる)
  assert.match(
    html,
    /<button type="button" class="summarize-btn-link" data-item-id="proc:enc" data-force="1">再要約<\/button>/,
  );
  // ライブスクリプトに hash 関数 / overflow 判定 / 展開状態保持の処理が含まれている
  assert.ok(html.includes('summaryHashKey'), 'クライアント側 hash 関数が埋め込まれている');
  assert.ok(html.includes('evalSummaryOverflow'), 'overflow 判定関数が埋め込まれている');
  assert.ok(html.includes("'折りたたむ'"), '展開時のラベル切替コードがある');
});

test('renderDashboard: 要約 OK + stale なら薄色クラスと「(古い)」プレフィックスが付く', () => {
  const html = renderDashboard([
    {
      id: 'enc',
      projectDir: '-home-user-foo',
      cwd: '/home/user/foo',
      state: 'waiting',
      process: { pid: 1, cwd: '/home/user/foo' },
      summary: { state: 'ok', text: 'タスク A をやっています', generatedAt: 1, stale: true },
    },
  ]);
  // 薄色化クラスが付く
  assert.match(html, /<div class="card-summary card-summary-stale" data-collapsible/);
  // 本文に「(古い)」プレフィックス
  assert.match(html, /<span class="card-summary-text">要約 \(古い\): タスク A をやっています<\/span>/);
  // 同じ本文なので summary key は通常版と一致 (展開状態保持のため)
  const stalePart = html.match(/data-summary-key="([0-9a-f]+)"/);
  assert.ok(stalePart, 'data-summary-key が抽出できる');
});

test('renderDashboard: 要約 pending / idle / unavailable には折りたたみフックは出ない', () => {
  const baseEntry = {
    projectDir: '-home-user-foo',
    cwd: '/home/user/foo',
    process: { pid: 1, cwd: '/home/user/foo' },
  } as const;
  // 埋め込み <script> 部にも "data-collapsible" / "data-summary-toggle" などの
  // 文字列リテラルが含まれるので、`.card-summary` ブロックだけを切り出して検査する。
  function extractSummaryHtml(html: string): string {
    const m = html.match(/<div class="card-summary[^"]*"[^>]*>[\s\S]*?<\/div>(?=\s*<\/div>)/);
    return m ? m[0] : '';
  }

  const pendingSummary = extractSummaryHtml(renderDashboard([
    { id: 'p', state: 'waiting', summary: { state: 'pending' }, ...baseEntry },
  ]));
  assert.ok(pendingSummary, 'pending カードの .card-summary が抽出できる');
  assert.doesNotMatch(pendingSummary, /data-collapsible/, 'pending には data-collapsible は付かない');
  assert.doesNotMatch(pendingSummary, /data-summary-toggle/, 'pending にはトグルは付かない');
  assert.match(pendingSummary, /要約中…/);

  const idleSummary = extractSummaryHtml(renderDashboard([
    { id: 'i', state: 'waiting', summary: { state: 'idle' }, ...baseEntry },
  ]));
  assert.doesNotMatch(idleSummary, /data-collapsible/, 'idle には data-collapsible は付かない');
  assert.match(idleSummary, /summarize-btn/);

  const unavailSummary = extractSummaryHtml(renderDashboard([
    { id: 'u', state: 'waiting', summary: { state: 'unavailable' }, ...baseEntry },
  ]));
  assert.doesNotMatch(unavailSummary, /data-collapsible/);
  assert.match(unavailSummary, /API キー未設定/);
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

// --- Phase 6: ボイスコントロール UI ---

test('renderDashboard: voice:true で voice パネル / スクリプト / 配信参照のフックが出る', () => {
  const html = renderDashboard([makeEntry({ state: 'waiting' })], { voice: true });
  // パネル本体のフック
  assert.match(html, /data-voice-bar/);
  assert.match(html, /data-voice-toggle/);
  assert.match(html, /data-voice-volume/);
  assert.match(html, /data-voice-client/);
  assert.match(html, /data-voice-history-toggle/);
  assert.match(html, /data-voice-history/);
  assert.match(html, /data-voice-now/);
  // 種別フィルタ 3 種
  assert.match(html, /data-voice-kind="completed"/);
  assert.match(html, /data-voice-kind="awaiting"/);
  assert.match(html, /data-voice-kind="progress"/);
  // 再生スクリプトと配信エンドポイント参照
  assert.match(html, /EventSource\('\/api\/watch'\)/);
  assert.match(html, /voice-utterance/);
  assert.match(html, /\/api\/voice\/audio\//);
  assert.match(html, /\/api\/voice\/recent\.json/);
  // localStorage 永続キー
  assert.match(html, /ccm-voice-enabled/);
  assert.match(html, /ccm-voice-volume/);
  assert.match(html, /ccm-voice-kinds/);
  assert.match(html, /ccm-voice-client/);
  // voice 専用 CSS
  assert.match(html, /\.voice-bar/);
});

test('renderDashboard: 既定 (voice 指定なし) では voice パネルもスクリプトも出ない (後方互換)', () => {
  const html = renderDashboard([makeEntry({ state: 'waiting' })]);
  assert.doesNotMatch(html, /data-voice-bar/);
  assert.doesNotMatch(html, /data-voice-toggle/);
  assert.doesNotMatch(html, /\/api\/voice\/audio\//);
  assert.doesNotMatch(html, /\.voice-bar/);
  // 既存のカード / 差分パッチ用フックは従来どおり出る
  assert.match(html, /data-cards-running/);
  assert.match(html, /data-card-id/);
});

test('renderDashboard: voice:false を明示しても出ない', () => {
  const html = renderDashboard([makeEntry()], { voice: false });
  assert.doesNotMatch(html, /data-voice-bar/);
});

test('renderDashboard: voice:true でも従来のカード / 差分パッチ用フックは維持される', () => {
  const html = renderDashboard([makeEntry({ state: 'ai-processing' })], { voice: true });
  assert.match(html, /data-cards-running/);
  assert.match(html, /data-cards-stopped/);
  assert.match(html, /data-card-id/);
  assert.match(html, /data-dashboard-meta/);
});
