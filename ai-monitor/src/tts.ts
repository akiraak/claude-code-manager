import crypto from 'crypto';

/**
 * `--mode server` の音声パイプライン後段。ペルソナ短文 → 音声バイトに変換する TTS 抽象。
 *
 * - `TtsProvider` 抽象に差し替え可能化（`CCM_VOICE_TTS_PROVIDER`）。既定は {@link GeminiTtsProvider}。
 * - Gemini は Phase 1 PoC（`poc/voice/tts-poc.mjs`）の HTTP 直叩きを移植（`google-genai` 依存を足さない）。
 *   出力は PCM s16le / 24kHz / mono → {@link pcmToWav} で WAV ラップ → `audio/wav`。
 * - {@link CachingTtsProvider} が `sha256(tag + text)` でバイトをキャッシュ（`hash(text+voice)` 相当）。
 * - キー未設定は {@link NullTtsProvider}（サーバは落とさず、音声無しの utterance を作れる）。
 */

export interface TtsResult {
  bytes: Buffer;
  mime: string;
}

/** 1 回の合成でキャラ別に声/スタイルを差し替えるためのオプション。 */
export interface SynthOptions {
  /** prebuilt voice 名（teacher=Leda / student=Aoede）。未指定はプロバイダ既定。 */
  voice?: string;
  /** スタイル（自然言語前置）。未指定はプロバイダ既定。 */
  style?: string;
}

export interface TtsProvider {
  /** キャッシュキーに混ぜる安定なタグ（model を含め、別モデルで衝突しないように）。 */
  readonly tag: string;
  /** 合成が可能か（キー設定済みか）。 */
  isEnabled(): boolean;
  /** 合成。無効 / 音声が取れないときは throw か null。voice/style を呼び出しごとに上書き可。 */
  synthesize(text: string, opts?: SynthOptions): Promise<TtsResult | null>;
}

const SAMPLE_RATE = 24000; // Gemini TTS の出力固定
const CHANNELS = 1;
const BITS = 16;

/** PCM (s16le) を最小 WAV (44byte RIFF/PCM) でラップする。Phase 1 PoC と同等。 */
export function pcmToWav(
  pcm: Buffer,
  opts: { sampleRate?: number; channels?: number; bits?: number } = {},
): Buffer {
  const sampleRate = opts.sampleRate ?? SAMPLE_RATE;
  const channels = opts.channels ?? CHANNELS;
  const bits = opts.bits ?? BITS;
  const blockAlign = (channels * bits) >> 3;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt チャンクサイズ
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

type FetchImpl = typeof fetch;

const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash-preview-tts';
const GEMINI_DEFAULT_VOICE = 'Leda';
const GEMINI_DEFAULT_STYLE = '終始にこにこしているような、柔らかく楽しげなトーンで読み上げてください';

function geminiEndpoint(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }>;
}

function extractAudioB64(json: GeminiResponse): string | undefined {
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    if (p.inlineData?.data) return p.inlineData.data;
  }
  return undefined;
}

export interface GeminiTtsOptions {
  apiKey?: string;
  model?: string;
  voice?: string;
  style?: string;
  /** テスト / 差し替え用。既定は global fetch。 */
  fetchImpl?: FetchImpl;
}

/** Generative Language API を HTTP 直叩きして WAV24k を返す既定プロバイダ。 */
export class GeminiTtsProvider implements TtsProvider {
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly style: string;
  private readonly fetchImpl: FetchImpl;
  readonly tag: string;

  constructor(opts: GeminiTtsOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
    this.model = opts.model ?? process.env.GEMINI_TTS_MODEL ?? GEMINI_DEFAULT_MODEL;
    this.voice = opts.voice ?? GEMINI_DEFAULT_VOICE;
    this.style = opts.style ?? GEMINI_DEFAULT_STYLE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.tag = `gemini|${this.model}|${this.voice}`;
  }

  isEnabled(): boolean {
    return Boolean(this.apiKey);
  }

  async synthesize(text: string, opts: SynthOptions = {}): Promise<TtsResult | null> {
    if (!this.apiKey) return null;
    const voice = opts.voice ?? this.voice;
    const style = opts.style ?? this.style;
    const prompt = `${style}: ${text}`;
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    };
    const resp = await this.fetchImpl(geminiEndpoint(this.model), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`gemini tts HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }
    const json = (await resp.json()) as GeminiResponse;
    const b64 = extractAudioB64(json);
    if (!b64) throw new Error('gemini tts: レスポンスに inlineData(音声) が無い');
    const pcm = Buffer.from(b64, 'base64');
    return { bytes: pcmToWav(pcm), mime: 'audio/wav' };
  }
}

/** TTS 無効時（キー未設定 / `CCM_VOICE_TTS_PROVIDER=none`）のプロバイダ。常に null。 */
export class NullTtsProvider implements TtsProvider {
  readonly tag = 'null';
  isEnabled(): boolean {
    return false;
  }
  async synthesize(_text: string, _opts?: SynthOptions): Promise<TtsResult | null> {
    return null;
  }
}

export interface CachingTtsOptions {
  /** 保持する音声バイトの最大件数（超過は挿入順で古いものから退避）。 */
  maxEntries?: number;
}

/** 任意のプロバイダを `sha256(tag + text)` でキャッシュするデコレータ。 */
export class CachingTtsProvider implements TtsProvider {
  private readonly inner: TtsProvider;
  private readonly cache = new Map<string, TtsResult>();
  private readonly maxEntries: number;
  readonly tag: string;

  constructor(inner: TtsProvider, opts: CachingTtsOptions = {}) {
    this.inner = inner;
    this.tag = inner.tag;
    this.maxEntries = opts.maxEntries ?? 200;
  }

  isEnabled(): boolean {
    return this.inner.isEnabled();
  }

  async synthesize(text: string, opts: SynthOptions = {}): Promise<TtsResult | null> {
    // voice/style ごとに別キャッシュ（同テキストでも teacher/student で別音声）。
    const key = crypto
      .createHash('sha256')
      .update(`${this.inner.tag}\n${opts.voice ?? ''}\n${opts.style ?? ''}\n${text}`)
      .digest('hex');
    const hit = this.cache.get(key);
    if (hit) return hit;
    const result = await this.inner.synthesize(text, opts);
    if (result) {
      this.cache.set(key, result);
      if (this.cache.size > this.maxEntries) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
    }
    return result;
  }
}

/**
 * env からプロバイダを選ぶ。`CCM_VOICE_TTS_PROVIDER`（既定 gemini / none|null）。
 * gemini はキー未設定なら {@link NullTtsProvider} に落とす（サーバは落とさない）。
 *
 * 声/スタイルは合成ごとに `synthesize(text, { voice, style })` で渡す（teacher=Leda / student=Aoede）。
 * ここで渡す既定 voice/style は override 無し呼び出しのフォールバック。
 */
export function selectTtsProvider(
  env: NodeJS.ProcessEnv,
  defaults?: { ttsVoice?: string; ttsStyle?: string },
): TtsProvider {
  const choice = (env.CCM_VOICE_TTS_PROVIDER ?? 'gemini').trim().toLowerCase();
  if (choice === 'none' || choice === 'null') return new NullTtsProvider();
  const gemini = new GeminiTtsProvider({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_TTS_MODEL,
    voice: defaults?.ttsVoice,
    style: defaults?.ttsStyle,
  });
  if (!gemini.isEnabled()) return new NullTtsProvider();
  return new CachingTtsProvider(gemini);
}
