import test from 'node:test';
import assert from 'node:assert/strict';

import { DialogueGenerator } from './persona';
import type { VoiceEventPayload } from './store';
import type { TtsProvider } from './tts';
import { parseSpokenKinds, SeenEventIds, SPOKEN_KINDS, VoicePipeline } from './voice-pipeline';
import { VoiceStore, type Utterance } from './voice-store';

const event = (over: Partial<VoiceEventPayload> = {}): VoiceEventPayload => ({
  clientId: 'wsl2-akira',
  projectDir: '-home-ubuntu-foo',
  kind: 'completed',
  detail: 'tests green',
  projectName: 'foo',
  ...over,
});

/** 1 発話だけ返す台本ジェネレータ（teacher）。 */
const fixedPersona = (line = 'foo、おわったよ'): DialogueGenerator =>
  new DialogueGenerator({
    generate: async () =>
      JSON.stringify([{ speaker: 'teacher', speech: line, tts_text: line, emotion: 'neutral', se: null }]),
  });

/** teacher → student の 2 発話を返す台本ジェネレータ。 */
const twoLinePersona = (): DialogueGenerator =>
  new DialogueGenerator({
    generate: async () =>
      JSON.stringify([
        { speaker: 'teacher', speech: 'テスト全部とおったよ', tts_text: 'テスト全部とおったよ', emotion: 'joy', se: null },
        { speaker: 'student', speech: 'へぇー、すごい！', tts_text: 'へぇー、すごい！', emotion: 'surprise', se: null },
      ]),
  });

const okTts: TtsProvider = {
  tag: 'fake',
  isEnabled: () => true,
  synthesize: async (t: string, opts) => ({
    bytes: Buffer.from(`wav:${opts?.voice ?? '?'}:${t}`),
    mime: 'audio/wav',
  }),
};

const throwingTts: TtsProvider = {
  tag: 'fake',
  isEnabled: () => true,
  synthesize: async () => {
    throw new Error('boom');
  },
};

const nullTts: TtsProvider = {
  tag: 'null',
  isEnabled: () => false,
  synthesize: async () => null,
};

test('started は読み上げない（utterance を作らない）', async () => {
  const store = new VoiceStore();
  let notified = 0;
  const pipe = new VoicePipeline({
    persona: fixedPersona(),
    tts: okTts,
    store,
    onUtterance: () => notified++,
  });
  const r = await pipe.handle(event({ kind: 'started' }));
  assert.deepEqual(r, []);
  assert.equal(store.size(), 0);
  assert.equal(notified, 0);
});

test('completed: persona + tts → 音声付き utterance + onUtterance', async () => {
  const store = new VoiceStore();
  const got: Utterance[] = [];
  const pipe = new VoicePipeline({
    persona: fixedPersona('foo、テスト全部とおった'),
    tts: okTts,
    store,
    now: () => 5000,
    onUtterance: u => got.push(u),
  });
  const us = await pipe.handle(event());
  assert.equal(us.length, 1);
  const u = us[0];
  assert.equal(u.text, 'foo、テスト全部とおった');
  assert.equal(u.kind, 'completed');
  assert.equal(u.clientId, 'wsl2-akira');
  assert.equal(u.speaker, 'teacher');
  assert.equal(u.createdAtMs, 5000);
  assert.ok(u.audio);
  assert.equal(u.audio!.mime, 'audio/wav');
  assert.equal(got.length, 1);
  assert.equal(got[0].id, u.id);
  assert.equal(store.get(u.id, 5000)!.text, 'foo、テスト全部とおった');
});

test('2 人会話: 発話ごとに utterance を作り、声を speaker で変え、順序を保つ', async () => {
  const store = new VoiceStore();
  const got: Utterance[] = [];
  const pipe = new VoicePipeline({
    persona: twoLinePersona(),
    tts: okTts,
    store,
    now: () => 1000,
    onUtterance: u => got.push(u),
  });
  const us = await pipe.handle(event());
  assert.equal(us.length, 2);
  assert.equal(us[0].speaker, 'teacher');
  assert.equal(us[1].speaker, 'student');
  // createdAtMs を 1ms ずつずらして会話順を保証
  assert.equal(us[0].createdAtMs, 1000);
  assert.equal(us[1].createdAtMs, 1001);
  // teacher=Leda / student=Aoede の声で合成されている
  assert.ok(us[0].audio!.bytes.toString().includes('Leda'));
  assert.ok(us[1].audio!.bytes.toString().includes('Aoede'));
  assert.equal(got.length, 2);
  // 同一 voice-event の発話は同じ groupId で束ねられる
  assert.equal(us[0].groupId, us[1].groupId);
  assert.ok(us[0].groupId);
});

test('TTS 無効: テキストのみの utterance を作る（onUtterance も発火）', async () => {
  const store = new VoiceStore();
  let notified = 0;
  const pipe = new VoicePipeline({
    persona: fixedPersona(),
    tts: nullTts,
    store,
    onUtterance: () => notified++,
  });
  const us = await pipe.handle(event({ kind: 'awaiting' }));
  assert.equal(us.length, 1);
  assert.equal(us[0].audio, undefined);
  assert.equal(notified, 1);
});

test('TTS が throw してもテキストのみで保存し、handle は throw しない', async () => {
  const store = new VoiceStore();
  const pipe = new VoicePipeline({ persona: fixedPersona(), tts: throwingTts, store });
  const us = await pipe.handle(event({ kind: 'progress' }));
  assert.equal(us.length, 1);
  assert.equal(us[0].audio, undefined);
  assert.equal(store.size(), 1);
});

test('onUtterance が throw しても handle は utterance を返す', async () => {
  const store = new VoiceStore();
  const pipe = new VoicePipeline({
    persona: fixedPersona(),
    tts: nullTts,
    store,
    onUtterance: () => {
      throw new Error('listener boom');
    },
  });
  const us = await pipe.handle(event());
  assert.equal(us.length, 1);
  assert.equal(store.size(), 1);
});

test('キー未設定 persona（fallback）でも音声化が進む', async () => {
  const store = new VoiceStore();
  const pipe = new VoicePipeline({
    persona: new DialogueGenerator({ apiKey: undefined }), // fallback テンプレ
    tts: okTts,
    store,
  });
  const us = await pipe.handle(event({ kind: 'completed', projectName: 'bar' }));
  assert.equal(us.length, 1);
  assert.match(us[0].text, /bar/);
  assert.ok(us[0].audio);
});

// ---- enqueue 直列化（端末またぎの混線防止） ------------------------------

/** synthesize を ms だけ遅延させる TTS（直列化の検証用に並行なら混線する状況を作る）。 */
const delayedTts = (ms: number): TtsProvider => ({
  tag: 'fake',
  isEnabled: () => true,
  synthesize: async (t: string, opts) => {
    await new Promise(r => setTimeout(r, ms));
    return { bytes: Buffer.from(`wav:${opts?.voice ?? '?'}:${t}`), mime: 'audio/wav' };
  },
});

test('enqueue: 直列化して 1 イベントの全発話を出し切ってから次へ（A 全件 → B 全件）', async () => {
  const store = new VoiceStore();
  const order: string[] = [];
  const pipe = new VoicePipeline({
    persona: twoLinePersona(),
    tts: delayedTts(10), // TTS 遅延あり: 並行なら A,B,A,B に混線するはず
    store,
    onUtterance: u => order.push(u.clientId),
  });
  // A と B をほぼ同時に enqueue（await しない）。直列化されれば onUtterance は A 全件 → B 全件。
  const pa = pipe.enqueue(event({ clientId: 'A' }));
  const pb = pipe.enqueue(event({ clientId: 'B' }));
  const [ua, ub] = await Promise.all([pa, pb]);
  assert.deepEqual(order, ['A', 'A', 'B', 'B']); // 混線しない
  // 返り値は各イベント分（混ざらない）
  assert.deepEqual(ua.map(u => u.clientId), ['A', 'A']);
  assert.deepEqual(ub.map(u => u.clientId), ['B', 'B']);
  // イベント内は同一 groupId、イベント間は別 groupId
  assert.equal(ua[0].groupId, ua[1].groupId);
  assert.notEqual(ua[0].groupId, ub[0].groupId);
});

test('enqueue: 0 発話イベント（started）を挟んでも順序が保たれチェーンが止まらない', async () => {
  const store = new VoiceStore();
  const order: string[] = [];
  const pipe = new VoicePipeline({
    persona: twoLinePersona(),
    tts: delayedTts(5),
    store,
    onUtterance: u => order.push(u.clientId),
  });
  const pa = pipe.enqueue(event({ clientId: 'A' }));
  const ps = pipe.enqueue(event({ clientId: 'S', kind: 'started' })); // SPOKEN_KINDS 外 = 0 件
  const pb = pipe.enqueue(event({ clientId: 'B' }));
  const [, us] = await Promise.all([pa, ps, pb]);
  assert.deepEqual(us, []); // started は無音
  assert.deepEqual(order, ['A', 'A', 'B', 'B']); // S を跨いでも A→B 順は不変
});

// ---- spokenKinds（CCM_VOICE_SPOKEN_KINDS）------------------------------------

test('parseSpokenKinds: 未設定/空/不正は既定にフォールバック', () => {
  assert.deepEqual(parseSpokenKinds(undefined), [...SPOKEN_KINDS]);
  assert.deepEqual(parseSpokenKinds(''), [...SPOKEN_KINDS]);
  assert.deepEqual(parseSpokenKinds('  '), [...SPOKEN_KINDS]);
  assert.deepEqual(parseSpokenKinds('bogus,nope'), [...SPOKEN_KINDS]);
});

test('parseSpokenKinds: progress を外す指定（試験運用①）/ 大文字・空白・重複・started を正規化', () => {
  assert.deepEqual(parseSpokenKinds('completed,awaiting'), ['completed', 'awaiting']);
  // started は許可外で無視・未知も無視・重複は畳む・前後空白と大文字を吸収
  assert.deepEqual(parseSpokenKinds(' Completed , started , completed , progress '), ['completed', 'progress']);
});

test('VoicePipeline: spokenKinds から progress を外すと progress は無音・completed は読む', async () => {
  const store = new VoiceStore();
  let notified = 0;
  const pipe = new VoicePipeline({
    persona: fixedPersona('foo、進捗ね'),
    tts: okTts,
    store,
    spokenKinds: parseSpokenKinds('completed,awaiting'),
    onUtterance: () => notified++,
  });
  assert.deepEqual(await pipe.handle(event({ kind: 'progress' })), []); // progress は無音
  assert.equal(store.size(), 0);
  assert.equal(notified, 0);

  const us = await pipe.handle(event({ kind: 'completed' })); // completed は従来どおり読む
  assert.equal(us.length, 1);
  assert.equal(us[0].kind, 'completed');
  assert.equal(notified, 1);
});

test('VoicePipeline: 既定（spokenKinds 未指定）は progress を読む（後方互換）', async () => {
  const store = new VoiceStore();
  const pipe = new VoicePipeline({ persona: fixedPersona('途中経過'), tts: okTts, store });
  const us = await pipe.handle(event({ kind: 'progress' }));
  assert.equal(us.length, 1);
  assert.equal(us[0].kind, 'progress');
});

// ---- spokenKindsProvider（UI ゲーティングの動的ゲート）------------------------

/** persona.generate / tts.synthesize の呼び出し回数を数える計装つきの依存を作る。 */
function countingDeps(line = 'foo、おわった') {
  let generated = 0;
  let synthesized = 0;
  const persona = new DialogueGenerator({
    generate: async () => {
      generated++;
      return JSON.stringify([{ speaker: 'teacher', speech: line, tts_text: line, emotion: 'neutral', se: null }]);
    },
  });
  const tts: TtsProvider = {
    tag: 'count',
    isEnabled: () => true,
    synthesize: async () => { synthesized++; return { bytes: Buffer.from('wav'), mime: 'audio/wav' }; },
  };
  return { persona, tts, gen: () => generated, syn: () => synthesized };
}

test('spokenKindsProvider: 空集合を返すと completed でも 0 件（Haiku/TTS 未呼び出し・onUtterance 未発火）', async () => {
  const store = new VoiceStore();
  let notified = 0;
  const d = countingDeps();
  const pipe = new VoicePipeline({
    persona: d.persona,
    tts: d.tts,
    store,
    spokenKindsProvider: () => new Set(), // viewer ゼロ相当
    onUtterance: () => notified++,
  });
  assert.deepEqual(await pipe.handle(event({ kind: 'completed' })), []);
  assert.equal(store.size(), 0);
  assert.equal(notified, 0);
  assert.equal(d.gen(), 0, 'persona.generate を呼ばない（コストが出ない）');
  assert.equal(d.syn(), 0, 'tts.synthesize を呼ばない（コストが出ない）');
});

test('spokenKindsProvider: {completed} を返すと completed は生成・progress は 0 件', async () => {
  const store = new VoiceStore();
  const d = countingDeps('できたよ');
  const pipe = new VoicePipeline({
    persona: d.persona,
    tts: d.tts,
    store,
    spokenKindsProvider: () => new Set(['completed'] as const),
  });
  assert.deepEqual(await pipe.handle(event({ kind: 'progress' })), []); // 天井外 = 無音
  assert.equal(d.gen(), 0);
  const us = await pipe.handle(event({ kind: 'completed' }));
  assert.equal(us.length, 1);
  assert.equal(us[0].kind, 'completed');
  assert.equal(d.gen(), 1);
});

test('spokenKindsProvider: 毎回参照されるので途中で広げると即反映（静的 set でない）', async () => {
  const store = new VoiceStore();
  let allowProgress = false;
  const pipe = new VoicePipeline({
    persona: fixedPersona('進捗'),
    tts: okTts,
    store,
    // completed は常に許可、progress は allowProgress 次第で動的に変わる。
    spokenKindsProvider: () => new Set(allowProgress ? ['completed', 'progress'] : ['completed']),
  });
  assert.deepEqual(await pipe.handle(event({ kind: 'progress' })), []); // 最初は無音
  allowProgress = true; // viewer が「途中経過」を ON にした相当
  assert.equal((await pipe.handle(event({ kind: 'progress' }))).length, 1); // 再起動なしで即生成
});

test('spokenKindsProvider 未指定なら静的 spokenKinds で動く（後方互換・provider が優先されない）', async () => {
  const store = new VoiceStore();
  // provider を渡さず spokenKinds=completed,awaiting → progress は無音・completed は生成。
  const pipe = new VoicePipeline({
    persona: fixedPersona('static'),
    tts: okTts,
    store,
    spokenKinds: parseSpokenKinds('completed,awaiting'),
  });
  assert.deepEqual(await pipe.handle(event({ kind: 'progress' })), []);
  assert.equal((await pipe.handle(event({ kind: 'completed' }))).length, 1);
});

// ---- eventId 冪等化（lost-ack 再送の二重生成防止） --------------------------

test('eventId 冪等化: 同一 eventId を 2 回処理しても 1 回だけ生成する', async () => {
  const store = new VoiceStore();
  let notified = 0;
  const pipe = new VoicePipeline({
    persona: fixedPersona(),
    tts: okTts,
    store,
    now: () => 1000,
    onUtterance: () => notified++,
  });
  const first = await pipe.handle(event({ eventId: 'E1' }));
  const second = await pipe.handle(event({ eventId: 'E1' })); // lost-ack 再送相当
  assert.equal(first.length, 1);
  assert.deepEqual(second, []); // 2 回目は生成しない
  assert.equal(store.size(), 1); // utterance も 1 件のまま
  assert.equal(notified, 1);
});

test('eventId 冪等化: 別 eventId はそれぞれ生成する', async () => {
  const store = new VoiceStore();
  const pipe = new VoicePipeline({ persona: fixedPersona(), tts: okTts, store, now: () => 1000 });
  assert.equal((await pipe.handle(event({ eventId: 'E1' }))).length, 1);
  assert.equal((await pipe.handle(event({ eventId: 'E2' }))).length, 1);
  assert.equal(store.size(), 2);
});

test('eventId 冪等化: eventId 欠落（旧クライアント）は dedup せず毎回生成する', async () => {
  const store = new VoiceStore();
  const pipe = new VoicePipeline({ persona: fixedPersona(), tts: okTts, store, now: () => 1000 });
  assert.equal((await pipe.handle(event())).length, 1);
  assert.equal((await pipe.handle(event())).length, 1); // eventId 無し → 抑制しない
  assert.equal(store.size(), 2);
});

test('eventId 冪等化: TTL 経過後は同一 eventId でも再生成する', async () => {
  const store = new VoiceStore();
  let nowMs = 1000;
  const pipe = new VoicePipeline({
    persona: fixedPersona(),
    tts: okTts,
    store,
    now: () => nowMs,
    seenEventTtlMs: 5000,
  });
  assert.equal((await pipe.handle(event({ eventId: 'E1' }))).length, 1);
  nowMs = 1000 + 5001; // TTL 超過
  assert.equal((await pipe.handle(event({ eventId: 'E1' }))).length, 1); // 失効後は再生成
  assert.equal(store.size(), 2);
});

test('SeenEventIds: TTL 内は既知、失効後は未知に戻る', () => {
  const seen = new SeenEventIds(1000, 100);
  assert.equal(seen.seen('x', 0), false); // 初回 = 未知（記録）
  assert.equal(seen.seen('x', 500), true); // TTL 内 = 既知
  assert.equal(seen.seen('x', 1001), false); // 失効 = 未知（再記録）
});

test('SeenEventIds: 件数上限を超えると古い順に間引く（再投入は未知扱い）', () => {
  const seen = new SeenEventIds(60_000, 2);
  seen.seen('a', 0);
  seen.seen('b', 0);
  assert.equal(seen.seen('b', 0), true); // まだ既知
  seen.seen('c', 0); // 'a' を押し出す（max=2）
  assert.equal(seen.size(), 2);
  assert.equal(seen.seen('a', 0), false); // 間引かれた 'a' は未知に戻る
});
