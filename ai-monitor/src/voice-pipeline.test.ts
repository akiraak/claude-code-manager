import test from 'node:test';
import assert from 'node:assert/strict';

import { PersonaGenerator } from './persona';
import type { VoiceEventPayload } from './store';
import type { TtsProvider } from './tts';
import { VoicePipeline } from './voice-pipeline';
import { VoiceStore, type Utterance } from './voice-store';

const event = (over: Partial<VoiceEventPayload> = {}): VoiceEventPayload => ({
  clientId: 'wsl2-akira',
  projectDir: '-home-ubuntu-foo',
  kind: 'completed',
  detail: 'tests green',
  projectName: 'foo',
  ...over,
});

const fixedPersona = (line = 'foo、おわったよ'): PersonaGenerator =>
  new PersonaGenerator({ generate: async () => line });

const okTts: TtsProvider = {
  tag: 'fake',
  isEnabled: () => true,
  synthesize: async (t: string) => ({ bytes: Buffer.from('wav:' + t), mime: 'audio/wav' }),
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
  assert.equal(r, null);
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
  const u = await pipe.handle(event());
  assert.ok(u);
  assert.equal(u!.text, 'foo、テスト全部とおった');
  assert.equal(u!.kind, 'completed');
  assert.equal(u!.clientId, 'wsl2-akira');
  assert.equal(u!.createdAtMs, 5000);
  assert.ok(u!.audio);
  assert.equal(u!.audio!.mime, 'audio/wav');
  // onUtterance に同じ utterance が渡り、id でストアから引ける
  assert.equal(got.length, 1);
  assert.equal(got[0].id, u!.id);
  assert.equal(store.get(u!.id, 5000)!.text, 'foo、テスト全部とおった');
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
  const u = await pipe.handle(event({ kind: 'awaiting' }));
  assert.ok(u);
  assert.equal(u!.audio, undefined);
  assert.equal(notified, 1);
});

test('TTS が throw してもテキストのみで保存し、handle は throw しない', async () => {
  const store = new VoiceStore();
  const pipe = new VoicePipeline({ persona: fixedPersona(), tts: throwingTts, store });
  const u = await pipe.handle(event({ kind: 'progress' }));
  assert.ok(u);
  assert.equal(u!.audio, undefined);
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
  const u = await pipe.handle(event());
  assert.ok(u);
  assert.equal(store.size(), 1);
});

test('キー未設定 persona（fallback）でも音声化が進む', async () => {
  const store = new VoiceStore();
  const pipe = new VoicePipeline({
    persona: new PersonaGenerator({ apiKey: undefined }), // fallback テンプレ
    tts: okTts,
    store,
  });
  const u = await pipe.handle(event({ kind: 'completed', projectName: 'bar' }));
  assert.ok(u);
  assert.match(u!.text, /bar/);
  assert.ok(u!.audio);
});
