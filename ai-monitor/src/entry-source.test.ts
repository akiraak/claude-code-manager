import test from 'node:test';
import assert from 'node:assert/strict';

import { LocalEntrySource, type EntrySource } from './entry-source';

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
