import crypto from 'crypto';
import { characterFor, type DialogueGenerator, type PersonaInput } from './persona';
import type { VoiceEventKind, VoiceEventPayload } from './store';
import type { TtsProvider } from './tts';
import type { Utterance, VoiceStore } from './voice-store';

/**
 * `--mode server` の音声オーケストレーション。集約ストアに記録された voice-event を
 * 「ちょビ & なるこ 2 人の会話台本」→ 各発話の TTS → utterance ストアへと流し、
 * 完了を `onUtterance` で通知する（SSE push 用）。
 *
 * - `started`（指示受信相当）は **読み上げない**（要件: 発話は完了 / 承認待ち / 途中経過のみ）。
 * - 1 つの voice-event から **複数 utterance**（2〜4 発話の会話）を生成し、speaker ごとに声を変える
 *   （teacher=Leda / student=Aoede）。同一会話は `groupId` で束ね、`createdAtMs` を 1ms ずつ
 *   ずらして**順序を保証**する（ブラウザ側の順次再生がそのまま会話順になる）。
 * - TTS が無効 / 失敗でも **テキストのみの utterance** を作る（ミラー / 履歴で文字は出せる）。
 * - `handle` は **絶対に throw しない**（ingest の応答や他イベントを巻き込まないため fire-and-forget で呼ばれる）。
 */

/** 音声化する種別（既定）。`started` は除外。 */
export const SPOKEN_KINDS: readonly VoiceEventKind[] = ['awaiting', 'completed', 'progress'];

/** 処理済み eventId を覚えておく既定 TTL（lost-ack 再送の間隔より十分長く）。 */
export const DEFAULT_SEEN_EVENT_TTL_MS = 600_000; // 10 分
/** 処理済み eventId の保持件数上限（流量から見て十分。超過は古い順に間引く）。 */
export const DEFAULT_SEEN_EVENT_MAX = 500;

/**
 * 処理済み eventId の TTL + 件数上限つきセット。lost-ack 再送（同一 eventId）を「既知」と
 * 判定して会話の二重生成を防ぐ。期限切れ・件数超過は古い順に捨てる（best-effort 冪等）。
 */
export class SeenEventIds {
  /** eventId → 失効時刻(ms)。Map の挿入順を FIFO 退避に使う。 */
  private readonly map = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = DEFAULT_SEEN_EVENT_TTL_MS,
    private readonly max: number = DEFAULT_SEEN_EVENT_MAX,
  ) {}

  /**
   * `id` が既知（未失効）なら true を返す（処理をスキップさせる）。
   * 未知 or 失効済みなら記録して false を返す（= これから処理する）。
   */
  seen(id: string, nowMs: number): boolean {
    const exp = this.map.get(id);
    if (exp !== undefined && exp > nowMs) return true;
    // 未知 or 失効 → 記録（失効していた古いエントリは上書き）。
    this.map.set(id, nowMs + this.ttlMs);
    if (this.map.size > this.max) {
      const overflow = this.map.size - this.max;
      let n = 0;
      for (const k of this.map.keys()) {
        this.map.delete(k);
        if (++n >= overflow) break;
      }
    }
    return false;
  }

  size(): number {
    return this.map.size;
  }
}

/**
 * env `CCM_VOICE_SPOKEN_KINDS`（csv）を読み上げ種別の配列にする純関数。
 * - 未設定/空/全て不正 → 既定 {@link SPOKEN_KINDS} にフォールバック（typo で全無音にならないよう fail-safe）。
 * - 許可は `awaiting` / `completed` / `progress` のみ。`started` や未知の値は無視する
 *   （`started` は要件上どの設定でも読み上げない）。重複は畳む。
 */
export function parseSpokenKinds(raw: string | undefined): VoiceEventKind[] {
  if (raw === undefined) return [...SPOKEN_KINDS];
  const allowed = new Set<VoiceEventKind>(SPOKEN_KINDS);
  const picked = raw
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter((s): s is VoiceEventKind => allowed.has(s as VoiceEventKind));
  return picked.length > 0 ? Array.from(new Set(picked)) : [...SPOKEN_KINDS];
}

export interface VoicePipelineDeps {
  persona: DialogueGenerator;
  tts: TtsProvider;
  store: VoiceStore;
  /** 現在時刻 (ms)。テストで固定するため注入可能。既定 Date.now。 */
  now?: () => number;
  /** utterance 生成完了時に呼ぶ（SSE `voice-utterance` push 用）。発話数分だけ順に呼ばれる。 */
  onUtterance?: (u: Utterance) => void;
  /**
   * 音声化する種別。既定 {@link SPOKEN_KINDS}（awaiting/completed/progress）。
   * env `CCM_VOICE_SPOKEN_KINDS` で絞り込み、頻度を下げられる（例: progress を外す）。
   * `started` は要件上どの設定でも読み上げない（既定に含まれない）。
   */
  spokenKinds?: readonly VoiceEventKind[];
  /**
   * 動的な読み上げ種別プロバイダ（UI ゲーティング用）。指定すると {@link VoicePipeline.handle} の
   * ゲートで **毎回これを参照**し、接続中 viewer の希望（env 天井 ∩ viewer union）を即時反映する。
   * 未指定なら静的 {@link spokenKinds} を使う（= 完全な従来挙動。env のみ運用・既存テストを壊さない）。
   */
  spokenKindsProvider?: () => ReadonlySet<VoiceEventKind>;
  /** 処理済み eventId を覚えておく TTL(ms)。既定 {@link DEFAULT_SEEN_EVENT_TTL_MS}。 */
  seenEventTtlMs?: number;
  /** 処理済み eventId の保持件数上限。既定 {@link DEFAULT_SEEN_EVENT_MAX}。 */
  seenEventMax?: number;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class VoicePipeline {
  private readonly persona: DialogueGenerator;
  private readonly tts: TtsProvider;
  private readonly store: VoiceStore;
  private readonly now: () => number;
  private readonly onUtterance: (u: Utterance) => void;
  private readonly spokenKinds: ReadonlySet<VoiceEventKind>;
  /** 動的な読み上げ種別プロバイダ（UI ゲーティング）。未指定なら静的 {@link spokenKinds} を使う。 */
  private readonly spokenKindsProvider?: () => ReadonlySet<VoiceEventKind>;
  /** lost-ack 再送 (同一 eventId) の二重生成を防ぐ冪等セット。 */
  private readonly seen: SeenEventIds;
  /** {@link enqueue} の直列化チェーン。前イベントの全 utterance を出し切ってから次へ。 */
  private chain: Promise<void> = Promise.resolve();

  constructor(deps: VoicePipelineDeps) {
    this.persona = deps.persona;
    this.tts = deps.tts;
    this.store = deps.store;
    this.now = deps.now ?? (() => Date.now());
    this.onUtterance = deps.onUtterance ?? (() => { /* noop */ });
    this.spokenKinds = new Set(deps.spokenKinds ?? SPOKEN_KINDS);
    this.spokenKindsProvider = deps.spokenKindsProvider;
    this.seen = new SeenEventIds(deps.seenEventTtlMs, deps.seenEventMax);
  }

  /**
   * voice-event を**直列に**処理する。fire-and-forget の入口（server.ts の `onVoiceEvent`）は
   * これを使う。1 イベントの全発話を `handle` で出し切ってから次イベントの生成を始めるので、
   * `onUtterance`（= SSE push）の順が「A を全部 → B を全部」になり、**端末をまたいだ会話の混線を防ぐ**。
   *
   * `handle` は throw しない設計だが、万一に備えチェーンは握りつぶして次イベントへ繋ぐ
   * （1 件の失敗で以降が止まらないように）。返り値は当該イベントの utterance（テスト用）。
   */
  enqueue(event: VoiceEventPayload): Promise<Utterance[]> {
    const run = this.chain.then(() => this.handle(event));
    this.chain = run.then(
      () => { /* settled */ },
      () => { /* handle は throw しない想定だが念のため */ },
    );
    return run;
  }

  async handle(event: VoiceEventPayload): Promise<Utterance[]> {
    try {
      // 生成抑止ゲート: provider があれば毎回参照（接続中 viewer の希望を即時反映）、
      // 無ければ従来の静的 spokenKinds（env のみ運用・後方互換）。
      const spoken = this.spokenKindsProvider ? this.spokenKindsProvider() : this.spokenKinds;
      if (!spoken.has(event.kind)) return [];

      // 冪等化: 同一 eventId を 2 度処理しない (lost-ack 再送 / 二重 ingest を吸収)。
      // eventId 欠落 (旧クライアント) は dedup せず従来どおり生成する (取りこぼしより重複許容)。
      // progress も eventId は発話ごとにユニークなので、周期通知が誤って抑制されることはない。
      if (event.eventId !== undefined && this.seen.seen(event.eventId, this.now())) {
        return [];
      }

      const persona = this.persona.getPersona();
      const lastConversation = this.store.recentTextsForSession(
        event.clientId,
        event.projectDir,
        this.now(),
      );
      // 旧クライアント (detail のみ) との後方互換: context が無ければ detail を notes に流す。
      const notes = event.context?.notes ?? (event.detail ? [event.detail] : undefined);
      const input: PersonaInput = {
        kind: event.kind,
        projectName: event.projectName,
        userPrompt: event.context?.userPrompt,
        actions: event.context?.actions,
        notes,
        elapsedMin: event.context?.elapsedMin,
        lastConversation,
      };

      const lines = await this.persona.generate(input);
      if (lines.length === 0) return [];

      const groupId = crypto.randomBytes(8).toString('base64url');
      const base = this.now();
      const out: Utterance[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const char = characterFor(persona, line.speaker);

        let audio: Utterance['audio'];
        if (this.tts.isEnabled()) {
          try {
            const r = await this.tts.synthesize(line.ttsText, {
              voice: char.ttsVoice,
              style: char.ttsStyle,
            });
            if (r) audio = { bytes: r.bytes, mime: r.mime };
          } catch (err) {
            // 音声だけ失敗。テキストは保存して先に進む。
            console.warn(`[ai-monitor] voice tts 失敗: ${errMsg(err)}（テキストのみ保存）`);
          }
        }

        // createdAtMs を 1ms ずつずらして会話順を保証する。
        const utt = this.store.put(
          {
            text: line.speech,
            kind: event.kind,
            clientId: event.clientId,
            projectDir: event.projectDir,
            projectName: event.projectName,
            speaker: line.speaker,
            emotion: line.emotion,
            se: line.se,
            groupId,
            audio,
          },
          base + i,
        );
        try {
          this.onUtterance(utt);
        } catch {
          /* listener のエラーは握りつぶす */
        }
        out.push(utt);
      }

      return out;
    } catch (err) {
      console.warn(`[ai-monitor] voice pipeline 失敗: ${errMsg(err)}`);
      return [];
    }
  }
}
