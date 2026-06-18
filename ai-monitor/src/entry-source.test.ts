import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LocalEntrySource,
  RemoteEntrySource,
  parseRemoteEntryId,
  remoteEntryId,
  type EntrySource,
} from './entry-source';
import { AggregateStore, type SnapshotPayload } from './store';

test('LocalEntrySource は EntrySource を満たし MonitorEntry[] を返す', async () => {
  const source: EntrySource = new LocalEntrySource();
  const entries = await source.buildEntries();
  // テスト環境では稼働中 CLI が居ないこともあるので「配列であること」だけ検証する
  // (現行 buildEntries への委譲が壊れていないことの smoke test)。
  assert.ok(Array.isArray(entries), 'buildEntries は配列を返す');
  for (const e of entries) {
    assert.equal(typeof e.id, 'string');
    assert.equal(typeof e.projectDir, 'string');
    assert.ok(['ai-processing', 'awaiting-user', 'waiting', 'stopped'].includes(e.state));
  }
});

function snapshot(over: Partial<SnapshotPayload> = {}): SnapshotPayload {
  return {
    clientId: 'wsl2-akira',
    entry: {
      id: 'client-side-id',
      projectDir: '-home-ubuntu-foo',
      cwd: '/home/ubuntu/foo',
      process: { pid: 1234 },
      transcript: { projectDir: '-home-ubuntu-foo', cwd: '/home/ubuntu/foo', mtimeMs: 1000, sessionId: 's1' },
      lastActivityAt: '2026-06-18T00:00:00.000Z',
      tail: {
        lastUserText: 'テストを直して',
        lastUserAt: '2026-06-18T00:00:00.000Z',
        endsWithInteractiveToolUse: false,
        endsWithLocalCommand: false,
      },
      state: 'ai-processing',
    },
    events: [{ kind: 'user-text', timestamp: '2026-06-18T00:00:00Z', text: 'hi' }],
    ...over,
  };
}

test('remoteEntryId ↔ parseRemoteEntryId は round-trip する (区切り文字に依存しない)', () => {
  const cases: Array<[string, string]> = [
    ['wsl2-akira', '-home-ubuntu-foo'],
    ['has:colon', 'dir:with:colons'],
    ['x', ''],
  ];
  for (const [clientId, projectDir] of cases) {
    const id = remoteEntryId(clientId, projectDir);
    assert.deepEqual(parseRemoteEntryId(id), { clientId, projectDir });
  }
  assert.equal(parseRemoteEntryId('!!!not-base64-composite!!!'), null);
});

test('RemoteEntrySource.buildEntries は SnapshotEntry を MonitorEntry に変換する', async () => {
  const store = new AggregateStore();
  store.upsertSnapshot(snapshot(), 1000);
  const source = new RemoteEntrySource(store, { now: () => 1000 });

  const entries = await source.buildEntries();
  assert.equal(entries.length, 1);
  const e = entries[0];
  // 合成 id (clientId 由来) — クライアント送信の id は使わない
  assert.equal(e.id, remoteEntryId('wsl2-akira', '-home-ubuntu-foo'));
  assert.notEqual(e.id, 'client-side-id');
  assert.equal(e.projectDir, '-home-ubuntu-foo');
  assert.equal(e.cwd, '/home/ubuntu/foo');
  // process は entry.cwd で cwd を補完して ClaudeProcess 形に
  assert.deepEqual(e.process, { pid: 1234, cwd: '/home/ubuntu/foo' });
  // transcript は jsonlPath 空 (remote は jsonl を読まない)
  assert.equal(e.transcript?.jsonlPath, '');
  assert.equal(e.transcript?.sessionId, 's1');
  assert.equal(e.state, 'ai-processing');
  assert.equal(e.tail?.lastUserText, 'テストを直して');
  assert.equal(e.lastActivityAt, '2026-06-18T00:00:00.000Z');
  // summarizer 未指定なら summary は付かない
  assert.equal(e.summary, undefined);
});

test('RemoteEntrySource: 別 client が同 projectDir でも 2 カードに分離する', async () => {
  const store = new AggregateStore();
  store.upsertSnapshot(snapshot(), 1000);
  store.upsertSnapshot(snapshot({ clientId: 'mac-akira' }), 1000);
  const source = new RemoteEntrySource(store, { now: () => 1000 });

  const entries = await source.buildEntries();
  assert.equal(entries.length, 2);
  const ids = new Set(entries.map(e => e.id));
  assert.equal(ids.size, 2, 'id が衝突しない');
});

test('RemoteEntrySource.readEvents は store から (clientId,projectDir) で引く', async () => {
  const store = new AggregateStore();
  store.upsertSnapshot(snapshot(), 1000);
  const source = new RemoteEntrySource(store, { now: () => 1000 });
  const [entry] = await source.buildEntries();

  const events = source.readEvents(entry, 200);
  assert.equal(events.length, 1);
  assert.equal(events[0].text, 'hi');
});

test('RemoteEntrySource.summaryTargetOf は合成キーと tail 由来の入力を返す', async () => {
  const store = new AggregateStore();
  store.upsertSnapshot(snapshot(), 1000);
  const source = new RemoteEntrySource(store, { now: () => 1000 });
  const [entry] = await source.buildEntries();

  const target = source.summaryTargetOf(entry);
  assert.ok(target);
  assert.equal(target!.key, 'remote:wsl2-akira|-home-ubuntu-foo|s1');
  assert.equal(target!.mtimeMs, 1000);
  assert.equal(target!.input.events.length, 1);
  assert.deepEqual(target!.input.recentUserText, {
    text: 'テストを直して',
    at: '2026-06-18T00:00:00.000Z',
  });
});
