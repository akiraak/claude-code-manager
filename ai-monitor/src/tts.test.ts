import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CachingTtsProvider,
  GeminiTtsProvider,
  NullTtsProvider,
  pcmToWav,
  selectTtsProvider,
  type TtsProvider,
  type TtsResult,
} from './tts';

test('pcmToWav: 44byte ヘッダ + PCM、フィールドが正しい', () => {
  const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const wav = pcmToWav(pcm);
  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length); // RIFF chunk size
  assert.equal(wav.readUInt16LE(20), 1); // PCM
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(24), 24000); // 24kHz
  assert.equal(wav.readUInt16LE(34), 16); // 16bit
  assert.equal(wav.readUInt32LE(40), pcm.length); // data size
  assert.ok(wav.subarray(44).equals(pcm));
});

function fakeResponse(opts: { ok?: boolean; status?: number; json?: unknown; text?: string }): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => opts.json,
    text: async () => opts.text ?? '',
  } as unknown as Response;
}

test('GeminiTtsProvider: base64 PCM → WAV、prompt に style 前置 + voice 指定', async () => {
  const pcm = Buffer.from([10, 20, 30, 40]);
  let captured: { url: string; body: any } | null = null;
  const provider = new GeminiTtsProvider({
    apiKey: 'k',
    voice: 'Leda',
    style: 'やさしく',
    fetchImpl: (async (url: string, init: any) => {
      captured = { url, body: JSON.parse(init.body) };
      return fakeResponse({
        json: { candidates: [{ content: { parts: [{ inlineData: { data: pcm.toString('base64') } }] } }] },
      });
    }) as unknown as typeof fetch,
  });
  assert.equal(provider.isEnabled(), true);
  const result = await provider.synthesize('完了したよ');
  assert.ok(result);
  assert.equal(result!.mime, 'audio/wav');
  assert.ok(result!.bytes.subarray(44).equals(pcm));
  assert.equal(captured!.body.contents[0].parts[0].text, 'やさしく: 完了したよ');
  assert.equal(
    captured!.body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
    'Leda',
  );
});

test('GeminiTtsProvider: キー未設定は null（呼ばない）', async () => {
  let called = false;
  const provider = new GeminiTtsProvider({
    apiKey: undefined,
    fetchImpl: (async () => {
      called = true;
      return fakeResponse({});
    }) as unknown as typeof fetch,
  });
  assert.equal(provider.isEnabled(), false);
  assert.equal(await provider.synthesize('x'), null);
  assert.equal(called, false);
});

test('GeminiTtsProvider: HTTP エラーは throw', async () => {
  const provider = new GeminiTtsProvider({
    apiKey: 'k',
    fetchImpl: (async () => fakeResponse({ ok: false, status: 429, text: 'rate' })) as unknown as typeof fetch,
  });
  await assert.rejects(() => provider.synthesize('x'), /HTTP 429/);
});

test('GeminiTtsProvider: 音声 inlineData が無ければ throw', async () => {
  const provider = new GeminiTtsProvider({
    apiKey: 'k',
    fetchImpl: (async () => fakeResponse({ json: { candidates: [] } })) as unknown as typeof fetch,
  });
  await assert.rejects(() => provider.synthesize('x'), /inlineData/);
});

test('NullTtsProvider: 常に null・無効', async () => {
  const p = new NullTtsProvider();
  assert.equal(p.isEnabled(), false);
  assert.equal(await p.synthesize('x'), null);
});

class CountingProvider implements TtsProvider {
  readonly tag = 'count|v1';
  calls = 0;
  isEnabled(): boolean {
    return true;
  }
  async synthesize(text: string): Promise<TtsResult | null> {
    this.calls++;
    return { bytes: Buffer.from(text), mime: 'audio/wav' };
  }
}

test('CachingTtsProvider: 同テキストはキャッシュヒットで再 synth しない', async () => {
  const inner = new CountingProvider();
  const cached = new CachingTtsProvider(inner);
  const a = await cached.synthesize('foo');
  const b = await cached.synthesize('foo');
  assert.equal(inner.calls, 1);
  assert.deepEqual(a, b);
  await cached.synthesize('bar');
  assert.equal(inner.calls, 2);
});

test('CachingTtsProvider: null はキャッシュしない', async () => {
  let calls = 0;
  const inner: TtsProvider = {
    tag: 'n',
    isEnabled: () => true,
    synthesize: async () => {
      calls++;
      return null;
    },
  };
  const cached = new CachingTtsProvider(inner);
  await cached.synthesize('x');
  await cached.synthesize('x');
  assert.equal(calls, 2);
});

test('CachingTtsProvider: maxEntries 超過で古いものを退避', async () => {
  const inner = new CountingProvider();
  const cached = new CachingTtsProvider(inner, { maxEntries: 2 });
  await cached.synthesize('a');
  await cached.synthesize('b');
  await cached.synthesize('c'); // a を退避
  assert.equal(inner.calls, 3);
  await cached.synthesize('a'); // 退避済みなので再 synth
  assert.equal(inner.calls, 4);
  await cached.synthesize('c'); // まだ残ってる
  assert.equal(inner.calls, 4);
});

test('selectTtsProvider: none は Null', () => {
  const p = selectTtsProvider({ CCM_VOICE_TTS_PROVIDER: 'none' } as any, { ttsVoice: 'Leda', ttsStyle: 's' });
  assert.ok(p instanceof NullTtsProvider);
});

test('selectTtsProvider: gemini だがキー未設定は Null に落とす', () => {
  const p = selectTtsProvider({} as any, { ttsVoice: 'Leda', ttsStyle: 's' });
  assert.ok(p instanceof NullTtsProvider);
});

test('selectTtsProvider: gemini + キーあれば Caching でラップ', () => {
  const p = selectTtsProvider({ GEMINI_API_KEY: 'k' } as any, { ttsVoice: 'Leda', ttsStyle: 's' });
  assert.ok(p instanceof CachingTtsProvider);
  assert.equal(p.isEnabled(), true);
});
