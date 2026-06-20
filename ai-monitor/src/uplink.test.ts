import test from 'node:test';
import assert from 'node:assert/strict';

import { validateSnapshot } from './ingest';
import { encodeId, type ActivityState, type MonitorEntry } from './state';
import type { EntrySource } from './entry-source';
import type { NormalizedEvent } from './transcript';
import {
  buildSnapshotPayload,
  classifyStatus,
  createHttpPoster,
  createUplinkRunner,
  formatStartupBanner,
  formatTransitionLine,
  isProjectMirrored,
  loadClientConfig,
  VoiceEventDetector,
  VoiceEventQueue,
  type ClientConfig,
  type FetchLike,
  type PostOutcome,
  type Poster,
  type VoiceEventOut,
  type VoiceSessionInput,
} from './uplink';

// ---- loadClientConfig -----------------------------------------------------

test('loadClientConfig: dryrun は url/token 無しでも通る', () => {
  const c = loadClientConfig({ CCM_DRYRUN: '1' }, 'myhost');
  assert.equal(c.dryrun, true);
  assert.equal(c.serverUrl, '');
  assert.equal(c.token, '');
  assert.equal(c.label, 'myhost'); // hostname フォールバック
  assert.equal(c.mirrorProjects, null); // 未設定 = 全件
  assert.equal(c.intervalMs, 4000);
});

test('loadClientConfig: 非 dryrun は url/token を fail-fast 検証する', () => {
  assert.throws(() => loadClientConfig({}, 'h'), /CCM_SERVER_URL/);
  assert.throws(() => loadClientConfig({ CCM_SERVER_URL: 'ftp://x' }, 'h'), /http\(s\)/);
  assert.throws(
    () => loadClientConfig({ CCM_SERVER_URL: 'https://x' }, 'h'),
    /CCM_CLIENT_TOKEN が未設定/,
  );
  assert.throws(
    () => loadClientConfig({ CCM_SERVER_URL: 'https://x', CCM_CLIENT_TOKEN: 'short' }, 'h'),
    /短すぎ/,
  );
});

test('loadClientConfig: 正常系を組み立てる (末尾 / 除去・label・mirror・interval)', () => {
  const c = loadClientConfig(
    {
      CCM_SERVER_URL: 'https://ccm.chobi.me/',
      CCM_CLIENT_TOKEN: '0123456789abcdef',
      CCM_CLIENT_LABEL: 'wsl2-akira',
      CCM_MIRROR_PROJECTS: 'foo, -home-ubuntu-bar ,',
      CCM_CLIENT_INTERVAL_MS: '2000',
    },
    'host',
  );
  assert.equal(c.serverUrl, 'https://ccm.chobi.me'); // 末尾 / 除去
  assert.equal(c.label, 'wsl2-akira');
  assert.deepEqual(c.mirrorProjects, ['foo', '-home-ubuntu-bar']);
  assert.equal(c.intervalMs, 2000);
  assert.equal(c.dryrun, false);
});

// ---- isProjectMirrored ----------------------------------------------------

test('isProjectMirrored: null は全件 / basename・projectDir 一致 / 非一致除外', () => {
  const e = { cwd: '/home/ubuntu/foo', projectDir: '-home-ubuntu-foo' };
  assert.equal(isProjectMirrored(e, null), true);
  assert.equal(isProjectMirrored(e, []), true);
  assert.equal(isProjectMirrored(e, ['foo']), true); // basename
  assert.equal(isProjectMirrored(e, ['-home-ubuntu-foo']), true); // projectDir
  assert.equal(isProjectMirrored(e, ['/home/ubuntu/foo']), true); // cwd 完全
  assert.equal(isProjectMirrored(e, ['bar']), false);
});

// ---- buildSnapshotPayload -------------------------------------------------

function entryFixture(state: ActivityState, over: Partial<MonitorEntry> = {}): MonitorEntry {
  return {
    id: encodeId('-home-ubuntu-foo'),
    projectDir: '-home-ubuntu-foo',
    cwd: '/home/ubuntu/foo',
    process: { pid: 1234, cwd: '/home/ubuntu/foo' },
    transcript: {
      projectDir: '-home-ubuntu-foo',
      jsonlPath: '/home/ubuntu/.claude/projects/-home-ubuntu-foo/s1.jsonl',
      cwd: '/home/ubuntu/foo',
      mtimeMs: 1000,
      sessionId: 's1',
    },
    lastActivityAt: '2026-06-18T00:00:00.000Z',
    tail: {
      lastUserText: 'テストを直して',
      lastAssistantText: 'やってます',
      endsWithInteractiveToolUse: false,
      endsWithLocalCommand: false,
    },
    state,
    ...over,
  };
}

test('buildSnapshotPayload: jsonlPath を落とし process を {pid} にし event を redact する', () => {
  const events: NormalizedEvent[] = [
    { kind: 'user-text', timestamp: 't', text: 'SECRET_TOKEN=abcdef0123456789' },
  ];
  const p = buildSnapshotPayload('wsl2-akira', entryFixture('ai-processing'), events);
  assert.equal(p.clientId, 'wsl2-akira');
  assert.equal(p.entry.transcript?.jsonlPath, undefined); // 送らない
  assert.equal(p.entry.transcript?.sessionId, 's1');
  assert.deepEqual(p.entry.process, { pid: 1234 }); // cwd を落とす
  assert.equal(p.entry.state, 'ai-processing');
  assert.match(p.events![0].text, /«redacted:secret»/); // redaction 済み
  // Phase 2 のサーバ側バリデータが受理する形であること (クロスチェック)
  assert.equal(validateSnapshot(p).ok, true);
});

test('buildSnapshotPayload: events は末尾 maxEvents 件に切り詰める', () => {
  const events: NormalizedEvent[] = Array.from({ length: 10 }, (_v, i) => ({
    kind: 'assistant-text' as const,
    timestamp: String(i),
    text: `e${i}`,
  }));
  const p = buildSnapshotPayload('c', entryFixture('waiting'), events, { maxEvents: 3 });
  assert.equal(p.events!.length, 3);
  assert.deepEqual(p.events!.map(e => e.text), ['e7', 'e8', 'e9']); // 末尾優先
});

// ---- classifyStatus -------------------------------------------------------

test('classifyStatus: 2xx=ok / 4xx・429=drop / 408・5xx=retry', () => {
  assert.deepEqual(classifyStatus(200), { ok: true });
  assert.deepEqual(classifyStatus(400), { ok: false, retryable: false, status: 400 });
  assert.deepEqual(classifyStatus(401), { ok: false, retryable: false, status: 401 });
  assert.deepEqual(classifyStatus(429), { ok: false, retryable: false, status: 429 });
  assert.deepEqual(classifyStatus(408), { ok: false, retryable: true, status: 408 });
  assert.deepEqual(classifyStatus(503), { ok: false, retryable: true, status: 503 });
});

// ---- VoiceEventDetector ---------------------------------------------------

function sess(state: ActivityState, over: Partial<VoiceSessionInput> = {}): VoiceSessionInput {
  return { projectDir: 'p', sessionId: 's', projectName: 'proj', state, ...over };
}

test('VoiceEventDetector: 初回観測は baseline で発話しない', () => {
  const d = new VoiceEventDetector();
  assert.deepEqual(d.observe([sess('awaiting-user')], 0), []);
});

test('VoiceEventDetector: 遷移ごとに started/awaiting/completed を出す', () => {
  const d = new VoiceEventDetector();
  d.observe([sess('waiting')], 0); // baseline
  const started = d.observe([sess('ai-processing', { lastUserText: 'do it' })], 10);
  assert.equal(started.length, 1);
  assert.equal(started[0].kind, 'started');
  assert.equal(started[0].detail, 'do it');

  const completed = d.observe([sess('waiting', { lastAssistantText: 'できました' })], 20);
  assert.equal(completed[0].kind, 'completed');
  assert.equal(completed[0].detail, 'できました');

  const awaiting = d.observe([sess('awaiting-user', { lastAssistantText: '承認して' })], 30);
  assert.equal(awaiting[0].kind, 'awaiting');
  assert.equal(awaiting[0].detail, '承認して');
});

test('VoiceEventDetector: ai-processing → stopped は発話しない', () => {
  const d = new VoiceEventDetector();
  d.observe([sess('ai-processing')], 0); // baseline
  assert.deepEqual(d.observe([sess('stopped')], 10), []);
});

test('VoiceEventDetector: ローカルコマンド終端 (endsWithLocalCommand) は completed を発話しない', () => {
  const d = new VoiceEventDetector();
  d.observe([sess('waiting')], 0); // baseline
  d.observe([sess('ai-processing', { lastUserText: 'do it' })], 10); // started
  // 完了後 30 秒窓内に /clear 等を叩くと ai-processing→waiting に倒れるが endsWithLocalCommand=true。
  const ev = d.observe([
    sess('waiting', { lastAssistantText: 'できました', lastAssistantAt: 'tA', endsWithLocalCommand: true }),
  ], 20);
  assert.deepEqual(ev, []); // 前倒し completed を抑制する
  // state は waiting に前進しているので、次の正規ターンは started から始まる (machine を壊さない)。
  const started = d.observe([sess('ai-processing', { lastUserText: 'next' })], 30);
  assert.equal(started.length, 1);
  assert.equal(started[0].kind, 'started');
});

test('VoiceEventDetector: ローカルコマンドでない通常完了は従来どおり completed を出す', () => {
  const d = new VoiceEventDetector();
  d.observe([sess('waiting')], 0); // baseline
  d.observe([sess('ai-processing')], 10); // started
  const ev = d.observe([
    sess('waiting', { lastAssistantText: '完了', endsWithLocalCommand: false }),
  ], 20);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'completed');
});

test('VoiceEventDetector: ai-processing 継続で progress を周期的に出す', () => {
  const d = new VoiceEventDetector({ progressAfterMs: 100, progressEveryMs: 50 });
  d.observe([sess('waiting')], 0);
  d.observe([sess('ai-processing')], 10); // since=10 (started)
  assert.deepEqual(d.observe([sess('ai-processing')], 50), []); // elapsed 40 < 100
  const p1 = d.observe([sess('ai-processing', { lastAssistantText: '作業中' })], 120); // elapsed 110 >= 100
  assert.equal(p1[0]?.kind, 'progress');
  assert.equal(p1[0]?.detail, '作業中');
  assert.deepEqual(d.observe([sess('ai-processing')], 140), []); // 140-120=20 < 50
  const p2 = d.observe([sess('ai-processing')], 180); // 180-120=60 >= 50
  assert.equal(p2[0]?.kind, 'progress');
});

test('VoiceEventDetector: 同一ターンの揺れによる completed 二重発火を抑制 (lastAssistantAt 不変)', () => {
  const d = new VoiceEventDetector();
  d.observe([sess('waiting')], 0); // baseline
  d.observe([sess('ai-processing', { lastUserText: 'u1' })], 10); // started
  const c1 = d.observe([sess('waiting', { lastAssistantText: 'できた', lastAssistantAt: 'tA' })], 20);
  assert.equal(c1.length, 1);
  assert.equal(c1[0].kind, 'completed');

  // ターン完了直後の mtime 揺れ: started を挟んでも同じ assistant メッセージ(tA)のまま
  // completed が再発火 → 抑制。
  const st = d.observe([sess('ai-processing', { lastUserText: 'u1' })], 30);
  assert.equal(st[0].kind, 'started');
  const c2 = d.observe([sess('waiting', { lastAssistantText: 'できた', lastAssistantAt: 'tA' })], 40);
  assert.deepEqual(c2, []);
});

test('VoiceEventDetector: 別ターンの completed は同一テキスト・短時間でも発話 (取りこぼさない)', () => {
  const d = new VoiceEventDetector();
  d.observe([sess('waiting')], 0);
  d.observe([sess('ai-processing')], 10);
  const c1 = d.observe([sess('waiting', { lastAssistantText: '完了', lastAssistantAt: 'tA' })], 20);
  assert.equal(c1.length, 1);

  // 新ターン: assistant メッセージが変わる(tB)。同じ短文・直後でも別の正規完了として発話する。
  d.observe([sess('ai-processing')], 22);
  const c2 = d.observe([sess('waiting', { lastAssistantText: '完了', lastAssistantAt: 'tB' })], 24);
  assert.equal(c2.length, 1);
  assert.equal(c2[0].detail, '完了');
});

test('VoiceEventDetector: lastAssistantAt が無いときは抑制しない (正規イベントを落とさない)', () => {
  const d = new VoiceEventDetector();
  d.observe([sess('waiting')], 0);
  d.observe([sess('ai-processing')], 10);
  const c1 = d.observe([sess('waiting', { lastAssistantText: '完了' })], 20); // lastAssistantAt 無し
  assert.equal(c1.length, 1);
  d.observe([sess('ai-processing')], 30);
  const c2 = d.observe([sess('waiting', { lastAssistantText: '完了' })], 40); // 識別子無し → 抑制せず発話
  assert.equal(c2.length, 1);
});

test('VoiceEventDetector: awaiting は同一ターンのフリッカを抑制し別プロンプトは発話', () => {
  const d = new VoiceEventDetector();
  d.observe([sess('ai-processing')], 0); // baseline
  const a1 = d.observe([sess('awaiting-user', { lastAssistantText: '承認して', lastAssistantAt: 'tA' })], 10);
  assert.equal(a1[0].kind, 'awaiting');
  // 同一ターン(tA)で awaiting→waiting→awaiting と揺れても 2 回目は抑制
  // (awaiting→waiting はイベントを出さないので lastSpokenSig は awaiting のまま)
  d.observe([sess('waiting', { lastAssistantText: '承認して', lastAssistantAt: 'tA' })], 20);
  const a2 = d.observe([sess('awaiting-user', { lastAssistantText: '承認して', lastAssistantAt: 'tA' })], 30);
  assert.deepEqual(a2, []);
  // 新しいプロンプト (別 assistant メッセージ tB) は発話する
  d.observe([sess('waiting', { lastAssistantText: '承認して', lastAssistantAt: 'tA' })], 40);
  const a3 = d.observe([sess('awaiting-user', { lastAssistantText: '別の確認', lastAssistantAt: 'tB' })], 50);
  assert.equal(a3.length, 1);
  assert.equal(a3[0].kind, 'awaiting');
});

test('VoiceEventDetector: 消えたセッションは破棄し再登場は baseline 扱い', () => {
  const d = new VoiceEventDetector();
  d.observe([sess('waiting')], 0);
  d.observe([], 10); // p が消えた
  // 再登場が awaiting でも baseline なので無発話
  assert.deepEqual(d.observe([sess('awaiting-user')], 20), []);
});

// ---- VoiceEventQueue ------------------------------------------------------

const voiceOut = (over: Partial<VoiceEventOut> = {}): VoiceEventOut => ({
  projectDir: 'p',
  kind: 'completed',
  state: 'waiting',
  ...over,
});

test('VoiceEventQueue: 成功時に順序保持でドレインし clientId を付与する', async () => {
  const sent: VoiceEventPayloadLike[] = [];
  const poster: Poster = async (_p, body) => {
    sent.push(body as VoiceEventPayloadLike);
    return { ok: true };
  };
  const q = new VoiceEventQueue({ poster, clientId: 'wsl2-akira', now: () => 0, log: () => {} });
  q.enqueue(voiceOut({ kind: 'started' }));
  q.enqueue(voiceOut({ kind: 'completed' }));
  await q.flush();
  assert.equal(q.size(), 0);
  assert.deepEqual(sent.map(s => s.kind), ['started', 'completed']);
  assert.equal(sent[0].clientId, 'wsl2-akira');
});

test('VoiceEventQueue: retryable はバックオフで残し、時間経過後に送れる', async () => {
  let nowMs = 0;
  const outcomes: PostOutcome[] = [{ ok: false, retryable: true }, { ok: true }];
  let i = 0;
  const poster: Poster = async () => outcomes[Math.min(i++, outcomes.length - 1)];
  const q = new VoiceEventQueue({
    poster,
    clientId: 'c',
    now: () => nowMs,
    baseBackoffMs: 1000,
    maxBackoffMs: 4000,
    log: () => {},
  });
  q.enqueue(voiceOut());
  await q.flush(); // retryable → 残る + nextAttemptAt=1000
  assert.equal(q.size(), 1);
  await q.flush(); // まだ now=0 < 1000 → poster を叩かない
  assert.equal(q.size(), 1);
  assert.equal(i, 1); // 2 回目の flush は poster 未呼び出し
  nowMs = 1000;
  await q.flush(); // ok
  assert.equal(q.size(), 0);
});

test('VoiceEventQueue: not-retryable は drop する', async () => {
  const poster: Poster = async () => ({ ok: false, retryable: false, status: 400 });
  const q = new VoiceEventQueue({ poster, clientId: 'c', now: () => 0, log: () => {} });
  q.enqueue(voiceOut());
  await q.flush();
  assert.equal(q.size(), 0);
});

test('VoiceEventQueue: 満杯時は最古を捨てる', async () => {
  const poster: Poster = async () => ({ ok: true });
  const q = new VoiceEventQueue({ poster, clientId: 'c', maxSize: 2, now: () => 0, log: () => {} });
  q.enqueue(voiceOut({ sessionId: 'a' }));
  q.enqueue(voiceOut({ sessionId: 'b' }));
  q.enqueue(voiceOut({ sessionId: 'c' })); // a を押し出す
  assert.equal(q.size(), 2);
});

test('VoiceEventQueue: lost-ack 再送をまたいで eventId が不変 (sentAt は更新)', async () => {
  let nowMs = 0;
  const sent: Array<{ eventId?: string; sentAt?: string }> = [];
  const outcomes: PostOutcome[] = [{ ok: false, retryable: true }, { ok: true }];
  let i = 0;
  const poster: Poster = async (_p, body) => {
    sent.push(body as { eventId?: string; sentAt?: string });
    return outcomes[Math.min(i++, outcomes.length - 1)];
  };
  const q = new VoiceEventQueue({
    poster, clientId: 'c', now: () => nowMs, baseBackoffMs: 1000, log: () => {},
  });
  // eventId は tick 側で 1 回採番され ev に載る。flush は同一 ev を再送する。
  q.enqueue(voiceOut({ eventId: 'E1' }));
  await q.flush();        // 1 回目: retryable (= ack 喪失相当) → キューに残る
  assert.equal(q.size(), 1);
  nowMs = 1000;           // バックオフ明け
  await q.flush();        // 2 回目: 成功 (再送)
  assert.equal(q.size(), 0);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].eventId, 'E1');
  assert.equal(sent[1].eventId, 'E1');             // 再送でも eventId 不変 → server が dedup 可能
  assert.notEqual(sent[0].sentAt, sent[1].sentAt); // sentAt は送信ごとに更新される
});

interface VoiceEventPayloadLike {
  clientId: string;
  kind: string;
}

// ---- createHttpPoster -----------------------------------------------------

test('createHttpPoster: URL/Bearer を組み立て status を分類する', async () => {
  let captured: { url: string; auth: string; body: string } | null = null;
  const fake: FetchLike = async (url, init) => {
    captured = { url, auth: init.headers.Authorization, body: init.body };
    return { status: 200 };
  };
  const poster = createHttpPoster({ serverUrl: 'https://x.example/', token: 'tok', fetchImpl: fake });
  const r = await poster('/snapshot', { a: 1 });
  assert.deepEqual(r, { ok: true });
  assert.equal(captured!.url, 'https://x.example/api/ingest/snapshot');
  assert.equal(captured!.auth, 'Bearer tok');
  assert.equal(captured!.body, JSON.stringify({ a: 1 }));
});

test('createHttpPoster: ネットワーク例外は retryable', async () => {
  const fake: FetchLike = async () => {
    throw new Error('boom');
  };
  const poster = createHttpPoster({ serverUrl: 'https://x', token: 't', fetchImpl: fake });
  const r = await poster('/snapshot', {});
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.retryable, true);
});

// ---- createUplinkRunner (統合) --------------------------------------------

test('createUplinkRunner.tickOnce: snapshot を送り、2 tick 目で遷移 voice を送る', async () => {
  let state: ActivityState = 'waiting';
  const source: EntrySource = {
    async buildEntries() {
      return [entryFixture(state)];
    },
    readEvents() {
      return [{ kind: 'user-text', timestamp: 't', text: 'hi' }];
    },
    summaryTargetOf() {
      return null;
    },
  };
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const poster: Poster = async (p, body) => {
    calls.push({ path: p, body: body as Record<string, unknown> });
    return { ok: true };
  };
  const config = loadClientConfig({ CCM_DRYRUN: '1' }, 'host');
  const runner = createUplinkRunner(config, { source, poster, now: () => 1000, log: () => {} });

  await runner.tickOnce();
  const snaps = calls.filter(c => c.path === '/snapshot');
  assert.equal(snaps.length, 1, 'snapshot を 1 件送る');
  assert.equal(calls.filter(c => c.path === '/voice-event').length, 0, '初回は baseline で voice なし');
  const snapEntry = snaps[0].body.entry as { transcript?: { jsonlPath?: string }; process?: unknown };
  assert.equal(snapEntry.transcript?.jsonlPath, undefined);
  assert.deepEqual(snapEntry.process, { pid: 1234 });

  // 状態遷移 waiting → ai-processing
  state = 'ai-processing';
  calls.length = 0;
  await runner.tickOnce();
  const voices = calls.filter(c => c.path === '/voice-event');
  assert.equal(voices.length, 1, '遷移で voice-event を送る');
  assert.equal(voices[0].body.kind, 'started');
  assert.equal(voices[0].body.clientId, 'host');
});

test('createUplinkRunner: 変化のない snapshot は再送せず heartbeat 時のみ再送する', async () => {
  const source: EntrySource = {
    async buildEntries() {
      return [entryFixture('waiting')];
    },
    readEvents() {
      return [];
    },
    summaryTargetOf() {
      return null;
    },
  };
  const calls: string[] = [];
  const poster: Poster = async (p) => {
    calls.push(p);
    return { ok: true };
  };
  const config = loadClientConfig({ CCM_DRYRUN: '1' }, 'host');
  let nowMs = 0;
  const runner = createUplinkRunner(config, { source, poster, now: () => nowMs, log: () => {} });

  await runner.tickOnce(); // 新規 → 送る
  nowMs = 100;
  await runner.tickOnce(); // 指紋不変 → 送らない (毎 tick 全送信でレート制限を踏まない)
  assert.equal(calls.filter(p => p === '/snapshot').length, 1);
  nowMs = 40_000; // heartbeat 経過 → TTL 維持のため再送
  await runner.tickOnce();
  assert.equal(calls.filter(p => p === '/snapshot').length, 2);
});

test('createUplinkRunner: 429 でも全 project が最終的に送られる (恒久 starve しない)', async () => {
  // 3 project。fake server は 1 ウィンドウ (10ms) に 2 件まで許可し、超過は 429。
  const entries = [0, 1, 2].map(i =>
    entryFixture('waiting', {
      id: `-p${i}`,
      projectDir: `-p${i}`,
      cwd: `/p${i}`,
      transcript: { projectDir: `-p${i}`, jsonlPath: '', cwd: `/p${i}`, mtimeMs: 1000, sessionId: `s${i}` },
    }),
  );
  const source: EntrySource = {
    async buildEntries() {
      return entries;
    },
    readEvents() {
      return [];
    },
    summaryTargetOf() {
      return null;
    },
  };
  let nowMs = 1;
  let windowStart = 0;
  let count = 0;
  const accepted = new Set<string>();
  const poster: Poster = async (p, body) => {
    if (p !== '/snapshot') return { ok: true };
    if (nowMs - windowStart >= 10) {
      windowStart = nowMs;
      count = 0;
    }
    if (count >= 2) return { ok: false, retryable: false, status: 429 };
    count++;
    accepted.add((body as { entry: { projectDir: string } }).entry.projectDir);
    return { ok: true };
  };
  const config = loadClientConfig({ CCM_DRYRUN: '1' }, 'host');
  const runner = createUplinkRunner(config, { source, poster, now: () => nowMs, log: () => {} });

  await runner.tickOnce(); // p0,p1 受理 / p2 で 429 → クールダウン
  assert.equal(accepted.size, 2);
  nowMs = 100_000; // クールダウン明け + fake ウィンドウもリセット
  await runner.tickOnce(); // 未送信 (= 最古) の p2 が先頭に来て送られる
  assert.deepEqual([...accepted].sort(), ['-p0', '-p1', '-p2']);
});

// ---- ターミナル表示の整形 (案A/B/D) ----------------------------------------

test('formatTransitionLine: started はユーザー指示を「」で括る', () => {
  const ev: VoiceEventOut = {
    projectDir: '-home-x', projectName: 'claude-code-manager',
    kind: 'started', state: 'ai-processing', detail: 'todo の表示を増やす',
  };
  const line = formatTransitionLine(ev);
  assert.equal(line, '[uplink] ▶ 開始   claude-code-manager  「todo の表示を増やす」');
});

test('formatTransitionLine: progress は経過分を前置し、長い detail は … で切る', () => {
  const ev: VoiceEventOut = {
    projectDir: '-p', projectName: 'p', kind: 'progress', state: 'ai-processing',
    detail: 'あ'.repeat(60), context: { elapsedMin: 12 },
  };
  const line = formatTransitionLine(ev);
  assert.ok(line.startsWith('[uplink] … 途中   p  12分経過 / '));
  assert.ok(line.endsWith('…'));
  // 40 字上限 (39 + …)
  assert.equal(line.split(' / ')[1].length, 40);
});

test('formatTransitionLine: detail 無しは末尾を付けない', () => {
  const line = formatTransitionLine({
    projectDir: '-p', projectName: 'p', kind: 'completed', state: 'waiting',
  });
  assert.equal(line, '[uplink] ✓ 完了   p');
});

test('formatStartupBanner: 主要設定を行に含める', () => {
  const config: ClientConfig = {
    serverUrl: 'https://ccm.example', token: 't', label: 'wsl2-akira',
    mirrorProjects: ['a', 'b'], dryrun: false, intervalMs: 4000,
    progressAfterMs: 120_000, progressEveryMs: 120_000,
  };
  const lines = formatStartupBanner(config, 'ccm.example');
  const joined = lines.join('\n');
  assert.ok(lines.every(l => l.startsWith('[uplink] ')));
  assert.ok(joined.includes('ccm.example'));
  assert.ok(joined.includes('wsl2-akira'));
  assert.ok(joined.includes('4000ms'));
  assert.ok(joined.includes('a,b'));
  assert.ok(joined.includes('120s 後・以降 120s ごと'));
});

test('formatStartupBanner: dryrun は送信先を伏せる', () => {
  const config: ClientConfig = {
    serverUrl: '', token: '', label: 'h', mirrorProjects: null, dryrun: true,
    intervalMs: 4000, progressAfterMs: 1000, progressEveryMs: 1000,
  };
  const joined = formatStartupBanner(config, '(none)').join('\n');
  assert.ok(joined.includes('(dryrun・送信なし)'));
  assert.ok(joined.includes('全件'));
});

test('createUplinkRunner.tickOnce: 遷移をログに出す (案A)', async () => {
  const logs: string[] = [];
  const baseEntry: MonitorEntry = {
    id: encodeId('-p'), projectDir: '-p', cwd: '/home/x/p',
    process: { pid: 1, cwd: '/home/x/p' } as MonitorEntry['process'],
    transcript: { projectDir: '-p', cwd: '/home/x/p', jsonlPath: '/j', mtimeMs: 1, sessionId: 's' },
    lastActivityAt: '2026-06-19T00:00:00.000Z',
    tail: {
      lastUserText: 'やって', lastAssistantText: 'できた',
      endsWithInteractiveToolUse: false, endsWithLocalCommand: false,
    },
    state: 'waiting',
  };
  let state: ActivityState = 'ai-processing';
  const source: EntrySource = {
    buildEntries: async () => [{ ...baseEntry, state }],
    readEvents: () => [],
    readTailEvents: () => [],
  } as unknown as EntrySource;
  const config = loadClientConfig({ CCM_DRYRUN: '1' }, 'host');
  const runner = createUplinkRunner(config, { source, poster: async () => ({ ok: true }), now: () => 1000, log: (m) => logs.push(m) });

  await runner.tickOnce(); // 初回 baseline (遷移なし)
  assert.ok(!logs.some(l => l.includes('✓ 完了')), '初回は遷移を出さない');

  logs.length = 0;
  state = 'waiting'; // ai-processing → waiting = completed
  await runner.tickOnce();
  assert.ok(logs.some(l => l.startsWith('[uplink] ✓ 完了')), '完了遷移が出る');
});
