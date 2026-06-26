import test from 'node:test';
import assert from 'node:assert/strict';

import type { VoiceEventKind } from './store';
import {
  DEFAULT_SUBSCRIBER_TTL_MS,
  MAX_PREFS_KINDS,
  MAX_SUB_LEN,
  parseVoicePrefsBody,
  sanitizeKinds,
  VoiceSubscriberRegistry,
} from './voice-subscribers';

/** env 天井（全許可）を組む小物。 */
const ALL: ReadonlySet<VoiceEventKind> = new Set<VoiceEventKind>(['awaiting', 'completed', 'progress']);

/** Set を安定ソートした配列にして比較しやすくする。 */
const sorted = (s: Set<VoiceEventKind>): VoiceEventKind[] => Array.from(s).sort();

test('union: viewer ごとの希望を和集合する (env=全許可)', () => {
  const reg = new VoiceSubscriberRegistry();
  reg.register('a', { enabled: true, kinds: ['completed'] }, 1000);
  reg.register('b', { enabled: true, kinds: ['progress'] }, 1000);
  assert.deepEqual(sorted(reg.effectiveKinds(ALL, 1000)), ['completed', 'progress']);
});

test('env 天井: 天井外の種別は viewer が希望しても生成しない', () => {
  const reg = new VoiceSubscriberRegistry();
  const env: ReadonlySet<VoiceEventKind> = new Set<VoiceEventKind>(['completed', 'awaiting']);
  reg.register('a', { enabled: true, kinds: ['progress'] }, 1000);
  // progress は天井外 → 空。
  assert.deepEqual(sorted(reg.effectiveKinds(env, 1000)), []);
  // 天井内 (completed) は通る。
  reg.update('a', { enabled: true, kinds: ['completed', 'progress'] }, 1000);
  assert.deepEqual(sorted(reg.effectiveKinds(env, 1000)), ['completed']);
});

test('viewer ゼロ → 空集合 (無音)', () => {
  const reg = new VoiceSubscriberRegistry();
  assert.deepEqual(sorted(reg.effectiveKinds(ALL, 1000)), []);
});

test('enabled=false (🔊 OFF) の viewer は union に寄与しない', () => {
  const reg = new VoiceSubscriberRegistry();
  reg.register('a', { enabled: false, kinds: ['completed', 'progress'] }, 1000);
  reg.register('b', { enabled: true, kinds: ['awaiting'] }, 1000);
  assert.deepEqual(sorted(reg.effectiveKinds(ALL, 1000)), ['awaiting']);
});

test('TTL: lastSeen + TTL を過ぎた sub は除外される', () => {
  const reg = new VoiceSubscriberRegistry({ ttlMs: 1000 });
  reg.register('a', { enabled: true, kinds: ['completed'] }, 1000);
  // ちょうど TTL 内 (cutoff = now - ttl = 1000。lastSeen=1000 は cutoff 以上なので生存)。
  assert.deepEqual(sorted(reg.effectiveKinds(ALL, 2000)), ['completed']);
  // TTL 超過 → 除外。
  assert.deepEqual(sorted(reg.effectiveKinds(ALL, 2001)), []);
  // 掃き出し済みなので size も 0。
  assert.equal(reg.size(2001), 0);
});

test('touch: 生存を延長して TTL 失効を防ぐ (未登録 sub は無視)', () => {
  const reg = new VoiceSubscriberRegistry({ ttlMs: 1000 });
  reg.register('a', { enabled: true, kinds: ['completed'] }, 1000);
  reg.touch('a', 1800); // lastSeen を更新
  assert.deepEqual(sorted(reg.effectiveKinds(ALL, 2500)), ['completed']); // 1800 基準でまだ生存
  // 未登録 sub への touch は幽霊 viewer を作らない。
  reg.touch('ghost', 2500);
  assert.equal(reg.size(2500), 1);
});

test('remove 後は寄与しない', () => {
  const reg = new VoiceSubscriberRegistry();
  reg.register('a', { enabled: true, kinds: ['completed'] }, 1000);
  reg.remove('a');
  assert.deepEqual(sorted(reg.effectiveKinds(ALL, 1000)), []);
  assert.equal(reg.size(1000), 0);
});

test('register/update は upsert (prefs を丸ごと差し替え)', () => {
  const reg = new VoiceSubscriberRegistry();
  reg.register('a', { enabled: true, kinds: ['completed', 'progress'] }, 1000);
  reg.update('a', { enabled: true, kinds: ['awaiting'] }, 1100); // 置換 (累積しない)
  assert.deepEqual(sorted(reg.effectiveKinds(ALL, 1100)), ['awaiting']);
});

test('sanitizeKinds: started / 未知 / 非文字列 / 重複を落とす', () => {
  assert.deepEqual(
    sorted(sanitizeKinds(['completed', 'started', 'bogus', 'COMPLETED', ' progress ', 42, null])),
    ['completed', 'progress'],
  );
  assert.deepEqual(sorted(sanitizeKinds('not-an-array')), []);
  assert.deepEqual(sorted(sanitizeKinds(undefined)), []);
});

test('空 sub は登録しない (防御)', () => {
  const reg = new VoiceSubscriberRegistry();
  reg.register('', { enabled: true, kinds: ['completed'] }, 1000);
  assert.equal(reg.size(1000), 0);
});

test('既定 TTL は ping(30s) より十分長い', () => {
  assert.ok(DEFAULT_SUBSCRIBER_TTL_MS >= 60_000);
});

test('parseVoicePrefsBody: 正常 body は正規化して返す', () => {
  const r = parseVoicePrefsBody({ sub: ' s1 ', enabled: true, kinds: ['completed', 'started', 'progress'] });
  assert.deepEqual(r, { sub: 's1', enabled: true, kinds: ['completed', 'progress'] }); // sub は trim、started は除外
});

test('parseVoicePrefsBody: enabled=false + 空 kinds は許容 (全 OFF 相当)', () => {
  assert.deepEqual(parseVoicePrefsBody({ sub: 's1', enabled: false, kinds: [] }), {
    sub: 's1',
    enabled: false,
    kinds: [],
  });
});

test('parseVoicePrefsBody: 不正な body は null (→ 400)', () => {
  assert.equal(parseVoicePrefsBody(null), null);
  assert.equal(parseVoicePrefsBody('nope'), null);
  assert.equal(parseVoicePrefsBody(42), null);
  assert.equal(parseVoicePrefsBody({ enabled: true, kinds: [] }), null); // sub 欠落
  assert.equal(parseVoicePrefsBody({ sub: 123, enabled: true, kinds: [] }), null); // sub 非文字列
  assert.equal(parseVoicePrefsBody({ sub: '', enabled: true, kinds: [] }), null); // sub 空
  assert.equal(parseVoicePrefsBody({ sub: '   ', enabled: true, kinds: [] }), null); // trim 後空
  assert.equal(parseVoicePrefsBody({ sub: 'x'.repeat(MAX_SUB_LEN + 1), enabled: true, kinds: [] }), null); // 長すぎ
  assert.equal(parseVoicePrefsBody({ sub: 's1', enabled: 'yes', kinds: [] }), null); // enabled 非 boolean
  assert.equal(parseVoicePrefsBody({ sub: 's1', enabled: true, kinds: 'completed' }), null); // kinds 非配列
  assert.equal(
    parseVoicePrefsBody({ sub: 's1', enabled: true, kinds: new Array(MAX_PREFS_KINDS + 1).fill('completed') }),
    null,
  ); // kinds 長すぎ
});

test('parseVoicePrefsBody: 未知/重複/非文字列の kind は捨てる', () => {
  const r = parseVoicePrefsBody({ sub: 's1', enabled: true, kinds: ['completed', 'bogus', 'COMPLETED', 7] });
  assert.deepEqual(r?.kinds, ['completed']);
});
