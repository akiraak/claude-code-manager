# Voice PoC (Gemini TTS → ブラウザ再生)

claude-progress-voice **Phase 1 / Part 3** の PoC。
Gemini TTS を **HTTP 直叩き**（`google-genai` SDK を足さない）で呼び、PCM→WAV を作って
ブラウザで再生できることを確認する。

## 構成

- `tts-poc.mjs` … Generative Language API を叩いて `out/voice.wav` を生成（Node 標準のみ・依存ゼロ）
- `play.html` … `out/voice.wav` を fetch → Blob → `<audio>` で順次再生する最小ページ
- `out/` … 生成物（gitignore 済み）

## 1) WAV を生成する

```bash
cd ai-monitor/poc/voice

# 鍵を環境変数で渡す。別リポ (~/ai-twitch-cast) の鍵を流用する例:
GEMINI_API_KEY=$(grep -E '^GEMINI_API_KEY=' ~/ai-twitch-cast/.env | cut -d= -f2-) \
  node tts-poc.mjs "やっほー、ちょビだよ。音声 PoC のテスト中。"
```

成功すると `out/voice.wav` が出力され、PCM/WAV バイト数・推定秒数・レイテンシが表示される。

環境変数:

| 変数 | 既定 | 説明 |
|---|---|---|
| `GEMINI_API_KEY` | （必須） | Generative Language API キー |
| `GEMINI_TTS_MODEL` | `gemini-2.5-flash-preview-tts` | 本番は `gemini-2.5-pro-preview-tts` も可 |
| `TTS_VOICE` | `Leda` | ちょビの声 |
| `TTS_STYLE` | 柔らかく楽しげなトーン | 本文の前に `<style>: ` として前置される |

## 2) ブラウザで再生する

`file://` だと `fetch('out/voice.wav')` が CORS で弾かれるので、簡易 HTTP で配信する:

```bash
cd ai-monitor/poc/voice
python3 -m http.server 8099
# → http://localhost:8099/play.html を開く
```

1. **🔊 再生を有効化** を 1 回クリック（autoplay 制限の解除）
2. **▶ out/voice.wav を再生** で音が鳴れば PoC 成功

## 本番への対応付け

- `tts-poc.mjs` の HTTP 呼び出し → server モードの `TtsProvider`（Gemini 実装）へ移植（Phase 5）
- `out/voice.wav` 配信 → `GET /api/voice/audio/:id`（Cloudflare Access 配下・推測困難 id, Phase 5）
- `play.html` の「キュー → 順次再生」→ Web UI のボイス再生（SSE 駆動・ON/OFF・音量・フィルタ, Phase 6）
- WAV24k のままで HTML5 再生可。帯域 / iOS 互換が問題なら mp3/opus 変換を検討。
