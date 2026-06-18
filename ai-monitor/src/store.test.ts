import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AggregateStore,
  VOICE_EVENT_BUFFER,
  type SnapshotPayload,
  type VoiceEventPayload,
} from './store';
import { STOPPED_RETENTION_SEC } from './state';

function snapshot(over: Partial<SnapshotPayload> = {}): SnapshotPayload {
  return {
    clientId: 'wsl2-akira',
    entry: {
      id: 'id-1',
      projectDir: '-home-ubuntu-foo',
      cwd: '/home/ubuntu/foo',
      process: { pid: 1234 },
      transcript: { projectDir: '-home-ubuntu-foo', cwd: '/home/ubuntu/foo', mtimeMs: 1000, sessionId: 's1' },
      state: 'ai-processing',
    },
    events: [{ kind: 'user-text', timestamp: '2026-06-18T00:00:00Z', text: 'hi' }],
    ...over,
  };
}

function voice(over: Partial<VoiceEventPayload> = {}): VoiceEventPayload {
  return {
    clientId: 'wsl2-akira',
    projectDir: '-home-ubuntu-foo',
    kind: 'completed',
    detail: 'テストが緑になった',
    ...over,
  };
}

test('upsertSnapshot → listSessions で clientId 付きで取り出せる', () => {
  const store = new AggregateStore();
  const r = store.upsertSnapshot(snapshot(), 1000);
  assert.equal(r.changed, true);
  const sessions = store.listSessions(1000);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].entry.id, 'id-1');
  assert.equal(sessions[0].clientId, 'wsl2-akira');
  assert.equal(sessions[0].projectDir, '-home-ubuntu-foo');
  assert.equal(store.size(), 1);
});

test('同じ指紋の再 push は dedup (changed:false)', () => {
  const store = new AggregateStore();
  store.upsertSnapshot(snapshot(), 1000);
  const r2 = store.upsertSnapshot(snapshot(), 2000);
  assert.equal(r2.changed, false);
  assert.equal(store.size(), 1);
});

test('mtime / state が変わると changed:true', () => {
  const store = new AggregateStore();
  store.upsertSnapshot(snapshot(), 1000);
  const moved = snapshot();
  moved.entry.transcript!.mtimeMs = 2000;
  const r = store.upsertSnapshot(moved, 2000);
  assert.equal(r.changed, true);

  const stateChanged = snapshot();
  stateChanged.entry.state = 'waiting';
  const r2 = store.upsertSnapshot(stateChanged, 3000);
  assert.equal(r2.changed, true);
});

test('別 client が同じ projectDir を push しても 2 レコードに分かれる (衝突しない)', () => {
  const store = new AggregateStore();
  store.upsertSnapshot(snapshot(), 1000);
  store.upsertSnapshot(snapshot({ clientId: 'mac-akira' }), 1000);
  assert.equal(store.size(), 2);
  const sessions = store.listSessions(1000);
  assert.equal(sessions.length, 2);
  // 同じ projectDir でも clientId で区別できる
  assert.deepEqual(sessions.map(s => s.clientId).sort(), ['mac-akira', 'wsl2-akira']);
});

test('TTL を過ぎた push 途絶レコードは prune される', () => {
  const store = new AggregateStore();
  store.upsertSnapshot(snapshot(), 1000);
  const future = 1000 + STOPPED_RETENTION_SEC * 1000 + 1;
  assert.equal(store.listSessions(future).length, 0);
  assert.equal(store.size(), 0);
});

test('getEventsBySession は (clientId, projectDir) でイベント列を返す', () => {
  const store = new AggregateStore();
  store.upsertSnapshot(snapshot(), 1000);
  assert.equal(store.getEventsBySession('wsl2-akira', '-home-ubuntu-foo', 1000).length, 1);
  assert.equal(store.getEventsBySession('mac-akira', '-home-ubuntu-foo', 1000).length, 0);
  assert.equal(store.getEventsBySession('wsl2-akira', '-unknown', 1000).length, 0);
});

test('voice イベントはリングバッファ上限を超えない', () => {
  const store = new AggregateStore();
  for (let i = 0; i < VOICE_EVENT_BUFFER + 5; i++) {
    store.recordVoiceEvent(voice({ detail: `e${i}` }), 1000 + i);
  }
  const recent = store.recentVoiceEvents(2000);
  assert.equal(recent.length, VOICE_EVENT_BUFFER);
  // 新しい順。最後に入れた detail が先頭。
  assert.equal(recent[0].detail, `e${VOICE_EVENT_BUFFER + 4}`);
});

test('スナップショット未着でも voice イベントは落とさない', () => {
  const store = new AggregateStore();
  store.recordVoiceEvent(voice(), 1000);
  // entry が無いので listSessions には出ないが voice は残る
  assert.equal(store.listSessions(1000).length, 0);
  assert.equal(store.recentVoiceEvents(1000).length, 1);
});
