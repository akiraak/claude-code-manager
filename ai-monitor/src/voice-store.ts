import crypto from 'crypto';
import type { VoiceEventKind } from './store';

/**
 * `--mode server` の utterance ストア。ペルソナ短文 + 合成済み音声バイトを **メモリ + TTL** で保持する。
 *
 * - id は `crypto.randomBytes(16)` の base64url（**推測困難** = capability）。`GET /api/voice/audio/:id`
 *   は id を知っていることそのものを認可とする（app 層の「認証付き」の実体。本番は加えて Cloudflare Access 配下）。
 * - 音声バイトは重いので TTL（既定 1h）+ 件数上限（既定 200・古い順退避）でメモリを制限する。
 * - 時刻は `nowMs` 注入（内部で `Date.now()` を呼ばない。集約ストアと同方針）。
 */

export interface UtteranceAudio {
  bytes: Buffer;
  mime: string;
}

export interface Utterance {
  id: string;
  text: string;
  kind: VoiceEventKind;
  clientId: string;
  projectDir: string;
  projectName?: string;
  createdAtMs: number;
  /** TTS が無効 / 失敗のときは undefined（テキストのみの utterance）。 */
  audio?: UtteranceAudio;
}

/** bytes を除いた配信用メタ（SSE `voice-utterance` / 履歴 list 用）。 */
export interface UtteranceMeta {
  id: string;
  text: string;
  kind: VoiceEventKind;
  clientId: string;
  projectName?: string;
  createdAtMs: number;
  hasAudio: boolean;
  mime?: string;
}

/** `put` の入力（id / createdAt はストアが採番）。 */
export interface PutUtterance {
  text: string;
  kind: VoiceEventKind;
  clientId: string;
  projectDir: string;
  projectName?: string;
  audio?: UtteranceAudio;
}

const DEFAULT_TTL_SEC = 3600;
const DEFAULT_MAX_ENTRIES = 200;

export interface VoiceStoreOptions {
  /** 保持期間（秒）。既定 1h。 */
  ttlSec?: number;
  /** 保持件数上限。既定 200。 */
  maxEntries?: number;
}

/** base64url の utterance id 形式チェック（ルートで明らかな不正を安く弾く）。 */
export function isValidUtteranceId(id: string): boolean {
  return /^[A-Za-z0-9_-]{16,64}$/.test(id);
}

export function toUtteranceMeta(u: Utterance): UtteranceMeta {
  return {
    id: u.id,
    text: u.text,
    kind: u.kind,
    clientId: u.clientId,
    projectName: u.projectName,
    createdAtMs: u.createdAtMs,
    hasAudio: Boolean(u.audio),
    mime: u.audio?.mime,
  };
}

export class VoiceStore {
  // Map の挿入順 = 古い順。件数上限の退避にこの順序を使う。
  private readonly items = new Map<string, Utterance>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts: VoiceStoreOptions = {}) {
    this.ttlMs = (opts.ttlSec ?? DEFAULT_TTL_SEC) * 1000;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  put(u: PutUtterance, nowMs: number): Utterance {
    this.prune(nowMs);
    const utt: Utterance = { id: newId(), createdAtMs: nowMs, ...u };
    this.items.set(utt.id, utt);
    while (this.items.size > this.maxEntries) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
    return utt;
  }

  get(id: string, nowMs: number): Utterance | undefined {
    this.prune(nowMs);
    return this.items.get(id);
  }

  /** 新しい順のメタ（bytes 抜き）。Phase 6 の履歴 UI 用。 */
  recent(nowMs: number, limit = 50): UtteranceMeta[] {
    this.prune(nowMs);
    return Array.from(this.items.values())
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, limit)
      .map(toUtteranceMeta);
  }

  prune(nowMs: number): void {
    const cutoff = nowMs - this.ttlMs;
    for (const [id, u] of this.items) {
      if (u.createdAtMs < cutoff) this.items.delete(id);
    }
  }

  size(): number {
    return this.items.size;
  }
}

function newId(): string {
  return crypto.randomBytes(16).toString('base64url');
}
