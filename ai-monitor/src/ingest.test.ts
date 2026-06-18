import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';

import {
  Cooldown,
  createIngestRouter,
  MAX_EVENTS,
  RateLimiter,
  validateSnapshot,
  validateVoiceEvent,
} from './ingest';
import { AggregateStore } from './store';

function validSnapshotBody(over: Record<string, unknown> = {}) {
  return {
    clientId: 'wsl2-akira',
    entry: {
      id: 'id-1',
      projectDir: '-home-ubuntu-foo',
      cwd: '/home/ubuntu/foo',
      process: { pid: 1234 },
      state: 'ai-processing',
    },
    events: [{ kind: 'user-text', timestamp: 't', text: 'hi' }],
    ...over,
  };
}

function validVoiceBody(over: Record<string, unknown> = {}) {
  return { clientId: 'wsl2-akira', projectDir: '-home-ubuntu-foo', kind: 'completed', detail: 'ok', ...over };
}

test('validateSnapshot: 正常系を通す', () => {
  const r = validateSnapshot(validSnapshotBody());
  assert.equal(r.ok, true);
});

test('validateSnapshot: 必須欠落 / 型不正 / 不正 state を弾く', () => {
  assert.equal(validateSnapshot(null).ok, false);
  assert.equal(validateSnapshot('x').ok, false);
  assert.equal(validateSnapshot(validSnapshotBody({ clientId: '' })).ok, false);
  assert.equal(validateSnapshot(validSnapshotBody({ entry: undefined })).ok, false);
  assert.equal(
    validateSnapshot({ clientId: 'c', entry: { id: 'i', projectDir: 'p', cwd: 'c', state: 'bogus' } }).ok,
    false,
  );
  assert.equal(
    validateSnapshot({ clientId: 'c', entry: { id: 'i', projectDir: 'p', cwd: 'c', state: 'waiting', process: { pid: 'x' } } }).ok,
    false,
  );
});

test('validateSnapshot: events 上限超過を弾く', () => {
  const events = Array.from({ length: MAX_EVENTS + 1 }, () => ({ kind: 'user-text', timestamp: 't', text: 'x' }));
  assert.equal(validateSnapshot(validSnapshotBody({ events })).ok, false);
});

test('validateVoiceEvent: 正常系と不正 kind', () => {
  assert.equal(validateVoiceEvent(validVoiceBody()).ok, true);
  assert.equal(validateVoiceEvent(validVoiceBody({ kind: 'bogus' })).ok, false);
  assert.equal(validateVoiceEvent(validVoiceBody({ projectDir: '' })).ok, false);
});

test('validateVoiceEvent: detail を上限で切り詰める', () => {
  const r = validateVoiceEvent(validVoiceBody({ detail: 'x'.repeat(9999) }));
  assert.equal(r.ok, true);
  if (r.ok) assert.ok(r.value.detail!.length <= 500);
});

test('RateLimiter: 窓内 max まで許可しそれ以降は拒否、窓が回ると復活', () => {
  const rl = new RateLimiter({ windowMs: 1000, max: 2 });
  assert.equal(rl.allow('k', 0), true);
  assert.equal(rl.allow('k', 100), true);
  assert.equal(rl.allow('k', 200), false); // 窓内 3 回目
  assert.equal(rl.allow('k', 1200), true); // 窓を跨いだ
  assert.equal(rl.allow('other', 200), true); // key 別
});

test('Cooldown: クールダウン中の同 key は拒否', () => {
  const cd = new Cooldown({ ms: 1000 });
  assert.equal(cd.allow('k', 0), true);
  assert.equal(cd.allow('k', 500), false);
  assert.equal(cd.allow('k', 1000), true);
  assert.equal(cd.allow('other', 500), true);
});

// --- ルータ統合 (認証なし・時刻固定) ---
async function withServer(
  deps: Parameters<typeof createIngestRouter>[0],
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use('/api/ingest', express.json({ limit: '512kb' }), createIngestRouter(deps));
  await new Promise<void>((resolve) => {
    const server = app.listen(0, async () => {
      const { port } = server.address() as AddressInfo;
      try {
        await fn(`http://127.0.0.1:${port}`);
      } finally {
        server.close(() => resolve());
      }
    });
  });
}

function post(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('ルータ: snapshot 受理 (200, changed) → dedup (changed:false)', async () => {
  const store = new AggregateStore();
  let clock = 1000;
  await withServer(
    {
      store,
      snapshotLimiter: new RateLimiter({ windowMs: 10_000, max: 100 }),
      voiceCooldown: new Cooldown({ ms: 0 }),
      now: () => clock,
    },
    async (base) => {
      const r1 = await post(base, '/api/ingest/snapshot', validSnapshotBody());
      assert.equal(r1.status, 200);
      assert.deepEqual(await r1.json(), { ok: true, changed: true });

      clock = 2000;
      const r2 = await post(base, '/api/ingest/snapshot', validSnapshotBody());
      const body2 = (await r2.json()) as { changed?: boolean };
      assert.equal(body2.changed, false); // 同指紋 dedup
      assert.equal(store.size(), 1);
    },
  );
});

test('ルータ: 不正 body は 400', async () => {
  await withServer(
    {
      store: new AggregateStore(),
      snapshotLimiter: new RateLimiter({ windowMs: 10_000, max: 100 }),
      voiceCooldown: new Cooldown({ ms: 0 }),
    },
    async (base) => {
      const r = await post(base, '/api/ingest/snapshot', { clientId: '' });
      assert.equal(r.status, 400);
    },
  );
});

test('ルータ: snapshot レート超過は 429', async () => {
  let clock = 0;
  await withServer(
    {
      store: new AggregateStore(),
      snapshotLimiter: new RateLimiter({ windowMs: 10_000, max: 1 }),
      voiceCooldown: new Cooldown({ ms: 0 }),
      now: () => clock,
    },
    async (base) => {
      assert.equal((await post(base, '/api/ingest/snapshot', validSnapshotBody())).status, 200);
      assert.equal((await post(base, '/api/ingest/snapshot', validSnapshotBody())).status, 429);
    },
  );
});

test('ルータ: voice-event はクールダウン中 429、別種別は通る', async () => {
  let clock = 0;
  await withServer(
    {
      store: new AggregateStore(),
      snapshotLimiter: new RateLimiter({ windowMs: 10_000, max: 100 }),
      voiceCooldown: new Cooldown({ ms: 15_000 }),
      now: () => clock,
    },
    async (base) => {
      assert.equal((await post(base, '/api/ingest/voice-event', validVoiceBody())).status, 200);
      assert.equal((await post(base, '/api/ingest/voice-event', validVoiceBody())).status, 429);
      // 別種別は別 key なので通る
      assert.equal((await post(base, '/api/ingest/voice-event', validVoiceBody({ kind: 'awaiting' }))).status, 200);
    },
  );
});
