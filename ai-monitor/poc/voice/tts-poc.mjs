#!/usr/bin/env node
// Gemini TTS → WAV 生成 PoC (claude-progress-voice Phase 1 / Part 3)
//
// google-genai SDK を足さず、Generative Language API を HTTP 直叩きする。
// レスポンスは PCM s16le / 24kHz / mono の base64。これを WAV ヘッダでラップして
// out/voice.wav に書き出す。ブラウザ再生は同ディレクトリの play.html で行う。
//
// 使い方:
//   GEMINI_API_KEY=... node tts-poc.mjs ["しゃべらせたい本文"]
//   # 例: 別リポの鍵を流用して実走
//   GEMINI_API_KEY=$(grep -E '^GEMINI_API_KEY=' ~/ai-twitch-cast/.env | cut -d= -f2-) \
//     node tts-poc.mjs "やっほー、ちょビだよ。音声 PoC のテスト中。"
//
// env:
//   GEMINI_API_KEY   (必須)
//   GEMINI_TTS_MODEL (既定 gemini-2.5-flash-preview-tts)
//   TTS_VOICE        (既定 Leda)
//   TTS_STYLE        (既定 = ちょビの柔らかく楽しげなトーン)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const VOICE = process.env.TTS_VOICE || 'Leda';
const STYLE = process.env.TTS_STYLE || '終始にこにこしているような、柔らかく楽しげなトーンで読み上げてください';
const TEXT = process.argv.slice(2).join(' ') || 'やっほー、ちょビだよ。Phase 1 の音声 PoC、ちゃんと聞こえてるかな？';

const SAMPLE_RATE = 24000; // Gemini TTS の出力固定
const CHANNELS = 1;
const BITS = 16;

if (!API_KEY) {
  console.error('[tts-poc] GEMINI_API_KEY が未設定です。');
  console.error("  例: GEMINI_API_KEY=$(grep -E '^GEMINI_API_KEY=' ~/ai-twitch-cast/.env | cut -d= -f2-) node tts-poc.mjs");
  process.exit(1);
}

/** PCM (s16le) を最小 WAV (RIFF/PCM) でラップする。 */
function pcmToWav(pcm, { sampleRate = SAMPLE_RATE, channels = CHANNELS, bits = BITS } = {}) {
  const blockAlign = (channels * bits) >> 3;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);        // fmt チャンクサイズ
  header.writeUInt16LE(1, 20);         // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function main() {
  const prompt = `${STYLE}: ${TEXT}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } },
      },
    },
  };

  console.log(`[tts-poc] model=${MODEL} voice=${VOICE}`);
  console.log(`[tts-poc] prompt=${prompt}`);

  const started = Date.now();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`[tts-poc] HTTP ${resp.status} ${resp.statusText}`);
    console.error(errText.slice(0, 1000));
    process.exit(1);
  }

  const json = await resp.json();
  const part = json?.candidates?.[0]?.content?.parts?.find(p => p?.inlineData?.data);
  const b64 = part?.inlineData?.data;
  if (!b64) {
    console.error('[tts-poc] 音声データ (inlineData) が取得できませんでした。レスポンス:');
    console.error(JSON.stringify(json, null, 2).slice(0, 1500));
    process.exit(1);
  }

  const pcm = Buffer.from(b64, 'base64');
  const wav = pcmToWav(pcm);
  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'voice.wav');
  fs.writeFileSync(outPath, wav);

  const ms = Date.now() - started;
  const durSec = (pcm.length / (SAMPLE_RATE * (BITS >> 3) * CHANNELS)).toFixed(2);
  console.log(`[tts-poc] OK: ${outPath}`);
  console.log(`[tts-poc] PCM ${pcm.length} bytes → WAV ${wav.length} bytes (約 ${durSec}s, レイテンシ ${ms}ms)`);
  console.log('[tts-poc] 再生: poc/voice ディレクトリで `python3 -m http.server 8099` → http://localhost:8099/play.html');
}

main().catch(err => {
  console.error('[tts-poc] 失敗:', err);
  process.exit(1);
});
