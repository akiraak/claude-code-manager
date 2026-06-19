import type { PersonaGenerator } from './persona';
import type { VoiceEventKind, VoiceEventPayload } from './store';
import type { TtsProvider } from './tts';
import type { Utterance, VoiceStore } from './voice-store';

/**
 * `--mode server` の音声オーケストレーション。集約ストアに記録された voice-event を
 * ペルソナ短文 → TTS → utterance ストアへと流し、完了を `onUtterance` で通知する（SSE push 用）。
 *
 * - `started`（指示受信相当）は **読み上げない**（要件 #3: 発話は完了 / 承認待ち / 途中経過のみ）。
 * - TTS が無効 / 失敗でも **テキストのみの utterance** を作る（ミラー / 履歴で文字は出せる）。
 * - `handle` は **絶対に throw しない**（ingest の応答や他イベントを巻き込まないため fire-and-forget で呼ばれる）。
 */

/** 音声化する種別。`started` は除外。 */
export const SPOKEN_KINDS: readonly VoiceEventKind[] = ['awaiting', 'completed', 'progress'];

export interface VoicePipelineDeps {
  persona: PersonaGenerator;
  tts: TtsProvider;
  store: VoiceStore;
  /** 現在時刻 (ms)。テストで固定するため注入可能。既定 Date.now。 */
  now?: () => number;
  /** utterance 生成完了時に呼ぶ（SSE `voice-utterance` push 用）。 */
  onUtterance?: (u: Utterance) => void;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class VoicePipeline {
  private readonly persona: PersonaGenerator;
  private readonly tts: TtsProvider;
  private readonly store: VoiceStore;
  private readonly now: () => number;
  private readonly onUtterance: (u: Utterance) => void;

  constructor(deps: VoicePipelineDeps) {
    this.persona = deps.persona;
    this.tts = deps.tts;
    this.store = deps.store;
    this.now = deps.now ?? (() => Date.now());
    this.onUtterance = deps.onUtterance ?? (() => { /* noop */ });
  }

  async handle(event: VoiceEventPayload): Promise<Utterance | null> {
    try {
      if (!SPOKEN_KINDS.includes(event.kind)) return null;

      const text = await this.persona.generate({
        kind: event.kind,
        detail: event.detail,
        projectName: event.projectName,
      });
      if (!text) return null;

      let audio: Utterance['audio'];
      if (this.tts.isEnabled()) {
        try {
          const r = await this.tts.synthesize(text);
          if (r) audio = { bytes: r.bytes, mime: r.mime };
        } catch (err) {
          // 音声だけ失敗。テキストは保存して先に進む。
          console.warn(`[ai-monitor] voice tts 失敗: ${errMsg(err)}（テキストのみ保存）`);
        }
      }

      const utt = this.store.put(
        {
          text,
          kind: event.kind,
          clientId: event.clientId,
          projectDir: event.projectDir,
          projectName: event.projectName,
          audio,
        },
        this.now(),
      );
      try {
        this.onUtterance(utt);
      } catch {
        /* listener のエラーは握りつぶす */
      }
      return utt;
    } catch (err) {
      console.warn(`[ai-monitor] voice pipeline 失敗: ${errMsg(err)}`);
      return null;
    }
  }
}
