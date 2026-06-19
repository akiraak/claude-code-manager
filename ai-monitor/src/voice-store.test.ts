import test from 'node:test';
import assert from 'node:assert/strict';

import { isValidUtteranceId, VoiceStore, type PutUtterance } from './voice-store';

const base: PutUtterance = {
  text: 'foo、おわったよ',
  kind: 'completed',
  clientId: 'wsl2-akira',
  projectDir: '-home-ubuntu-foo',
  projectName: 'foo',
};

test('put/get: 採番した id で取り出せる', () => {
  const store = new VoiceStore();
  const u = store.put({ ...base, audio: { bytes: Buffer.from('wav'), mime: 'audio/wav' } }, 1000);
  assert.ok(isValidUtteranceId(u.id));
  assert.equal(u.createdAtMs, 1000);
  const got = store.get(u.id, 1000);
  assert.ok(got);
  assert.equal(got!.text, 'foo、おわったよ');
  assert.ok(got!.audio);
});

test('put: 乱数 id はユニーク', () => {
  const store = new VoiceStore();
  const ids = new Set<string>();
  for (let i = 0; i < 100; i++) ids.add(store.put(base, 1000 + i).id);
  assert.equal(ids.size, 100);
});

test('get: 未知 id は undefined', () => {
  const store = new VoiceStore();
  assert.equal(store.get('nope-nope-nope-nope', 1000), undefined);
});

test('TTL: 保持期間を過ぎた utterance は退避', () => {
  const store = new VoiceStore({ ttlSec: 10 });
  const u = store.put(base, 1000);
  assert.ok(store.get(u.id, 1000 + 5_000));
  // 10s 経過後は消える
  assert.equal(store.get(u.id, 1000 + 11_000), undefined);
  assert.equal(store.size(), 0);
});

test('件数上限: 超過で古い順に退避', () => {
  const store = new VoiceStore({ maxEntries: 2 });
  const a = store.put(base, 1);
  const b = store.put(base, 2);
  const c = store.put(base, 3);
  assert.equal(store.size(), 2);
  assert.equal(store.get(a.id, 3), undefined); // 最古が消える
  assert.ok(store.get(b.id, 3));
  assert.ok(store.get(c.id, 3));
});

test('recent: 新しい順のメタ、bytes は含めない', () => {
  const store = new VoiceStore();
  store.put({ ...base, projectName: 'old' }, 1000);
  store.put(
    { ...base, projectName: 'new', audio: { bytes: Buffer.from('x'), mime: 'audio/wav' } },
    2000,
  );
  const recent = store.recent(2000);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].projectName, 'new');
  assert.equal(recent[0].hasAudio, true);
  assert.equal(recent[0].mime, 'audio/wav');
  assert.equal(recent[1].hasAudio, false);
  // メタに bytes は無い
  assert.equal((recent[0] as unknown as Record<string, unknown>).audio, undefined);
});

test('isValidUtteranceId: 形式チェック', () => {
  assert.equal(isValidUtteranceId('A'.repeat(22)), true);
  assert.equal(isValidUtteranceId('a-b_c1234567890ABCD'), true);
  assert.equal(isValidUtteranceId('short'), false);
  assert.equal(isValidUtteranceId('has space 1234567890'), false);
  assert.equal(isValidUtteranceId('../etc/passwd000000'), false);
});
