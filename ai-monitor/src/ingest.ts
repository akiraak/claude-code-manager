import { Router, type Request, type Response } from 'express';
import type { ActivityState } from './state';
import type { NormalizedEvent } from './transcript';
import {
  AggregateStore,
  type SnapshotEntry,
  type SnapshotPayload,
  type VoiceEventContext,
  type VoiceEventKind,
  type VoiceEventPayload,
} from './store';

/**
 * `--mode server` の Ingestion (`POST /api/ingest/snapshot` / `/voice-event`)。
 *
 * - バリデータは純関数。型不正・必須欠落・サイズ超過を弾く (本モジュールのテスト主対象)。
 * - レート制限 (snapshot) / クールダウン (voice-event 種別別) で乱発を抑える。
 * - payload 全体サイズは server.ts 側の `express.json({ limit })` が担保する (超過は 413)。
 */

/** snapshot.events の最大件数 (Phase 1 で確定した readTailEvents 上限と同じ)。 */
export const MAX_EVENTS = 200;
const MAX_CLIENT_ID = 128;
const MAX_PROJECT_DIR = 512;
const MAX_DETAIL = 500;
// 2 人会話の素 context。配列長・各要素長を制限して payload 暴発を防ぐ。
const MAX_CONTEXT_USER_PROMPT = 300;
const MAX_CONTEXT_ITEM = 200;
const MAX_CONTEXT_ACTIONS = 10;
const MAX_CONTEXT_NOTES = 3;

const ACTIVITY_STATES: readonly ActivityState[] = [
  'ai-processing',
  'awaiting-user',
  'waiting',
  'stopped',
];
const VOICE_EVENT_KINDS: readonly VoiceEventKind[] = [
  'started',
  'awaiting',
  'completed',
  'progress',
];

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

/** `POST /api/ingest/snapshot` の body を検証して正規化する。 */
export function validateSnapshot(body: unknown): ValidationResult<SnapshotPayload> {
  if (!isRecord(body)) return { ok: false, error: 'body must be an object' };
  if (!isNonEmptyString(body.clientId, MAX_CLIENT_ID)) {
    return { ok: false, error: 'clientId required' };
  }
  if (!isRecord(body.entry)) return { ok: false, error: 'entry required' };
  const e = body.entry;
  if (!isNonEmptyString(e.id, MAX_PROJECT_DIR)) return { ok: false, error: 'entry.id required' };
  if (!isNonEmptyString(e.projectDir, MAX_PROJECT_DIR)) {
    return { ok: false, error: 'entry.projectDir required' };
  }
  if (typeof e.cwd !== 'string') return { ok: false, error: 'entry.cwd required' };
  if (!ACTIVITY_STATES.includes(e.state as ActivityState)) {
    return { ok: false, error: 'entry.state invalid' };
  }
  if (e.process != null) {
    if (!isRecord(e.process) || typeof e.process.pid !== 'number') {
      return { ok: false, error: 'entry.process invalid' };
    }
  }
  if (e.transcript != null) {
    if (!isRecord(e.transcript) || typeof e.transcript.mtimeMs !== 'number') {
      return { ok: false, error: 'entry.transcript invalid' };
    }
  }
  if (body.events != null) {
    if (!Array.isArray(body.events)) return { ok: false, error: 'events must be an array' };
    if (body.events.length > MAX_EVENTS) return { ok: false, error: 'events too many' };
  }

  // 検証を通った body をそのまま正規化形として採用する (余剰フィールドは無視)。
  const value: SnapshotPayload = {
    clientId: body.clientId,
    sentAt: typeof body.sentAt === 'string' ? body.sentAt : undefined,
    entry: e as unknown as SnapshotEntry,
    events: (body.events as NormalizedEvent[] | undefined) ?? undefined,
  };
  return { ok: true, value };
}

/** `POST /api/ingest/voice-event` の body を検証する。detail は上限で切り詰める。 */
export function validateVoiceEvent(body: unknown): ValidationResult<VoiceEventPayload> {
  if (!isRecord(body)) return { ok: false, error: 'body must be an object' };
  if (!isNonEmptyString(body.clientId, MAX_CLIENT_ID)) {
    return { ok: false, error: 'clientId required' };
  }
  if (!isNonEmptyString(body.projectDir, MAX_PROJECT_DIR)) {
    return { ok: false, error: 'projectDir required' };
  }
  if (!VOICE_EVENT_KINDS.includes(body.kind as VoiceEventKind)) {
    return { ok: false, error: 'kind invalid' };
  }
  if (body.detail != null && typeof body.detail !== 'string') {
    return { ok: false, error: 'detail must be a string' };
  }
  if (body.state != null && !ACTIVITY_STATES.includes(body.state as ActivityState)) {
    return { ok: false, error: 'state invalid' };
  }

  const detail = typeof body.detail === 'string' ? body.detail.slice(0, MAX_DETAIL) : undefined;
  const value: VoiceEventPayload = {
    clientId: body.clientId,
    sentAt: typeof body.sentAt === 'string' ? body.sentAt : undefined,
    projectDir: body.projectDir,
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
    kind: body.kind as VoiceEventKind,
    detail,
    projectName: typeof body.projectName === 'string' ? body.projectName : undefined,
    state: body.state as ActivityState | undefined,
    context: sanitizeContext(body.context),
  };
  return { ok: true, value };
}

/** voice-event の context を型・配列長・各要素長で安全化する（不正は無視して落とさない）。 */
function sanitizeContext(raw: unknown): VoiceEventContext | undefined {
  if (!isRecord(raw)) return undefined;
  const strItems = (v: unknown, maxItems: number): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const out = v
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .slice(0, maxItems)
      .map(x => x.slice(0, MAX_CONTEXT_ITEM));
    return out.length > 0 ? out : undefined;
  };
  const ctx: VoiceEventContext = {};
  if (typeof raw.userPrompt === 'string' && raw.userPrompt.trim()) {
    ctx.userPrompt = raw.userPrompt.slice(0, MAX_CONTEXT_USER_PROMPT);
  }
  const actions = strItems(raw.actions, MAX_CONTEXT_ACTIONS);
  if (actions) ctx.actions = actions;
  const notes = strItems(raw.notes, MAX_CONTEXT_NOTES);
  if (notes) ctx.notes = notes;
  if (typeof raw.elapsedMin === 'number' && Number.isFinite(raw.elapsedMin) && raw.elapsedMin >= 0) {
    ctx.elapsedMin = Math.min(Math.round(raw.elapsedMin), 100000);
  }
  return Object.keys(ctx).length > 0 ? ctx : undefined;
}

/** 固定窓レート制限。`key` 単位で `windowMs` あたり `max` 回まで許可する。 */
export class RateLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly hits = new Map<string, { windowStart: number; count: number }>();

  constructor(opts: { windowMs: number; max: number }) {
    this.windowMs = opts.windowMs;
    this.max = opts.max;
  }

  allow(key: string, nowMs: number): boolean {
    const cur = this.hits.get(key);
    if (!cur || nowMs - cur.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: nowMs, count: 1 });
      return true;
    }
    if (cur.count >= this.max) return false;
    cur.count++;
    return true;
  }
}

/** 種別別クールダウン。`key` 単位で前回許可から `ms` 経過するまで再許可しない。 */
export class Cooldown {
  private readonly ms: number;
  private readonly last = new Map<string, number>();

  constructor(opts: { ms: number }) {
    this.ms = opts.ms;
  }

  allow(key: string, nowMs: number): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && nowMs - prev < this.ms) return false;
    this.last.set(key, nowMs);
    return true;
  }
}

export interface IngestDeps {
  store: AggregateStore;
  snapshotLimiter: RateLimiter;
  voiceCooldown: Cooldown;
  /** 現在時刻 (ms)。テストで固定するため注入可能。既定は Date.now。 */
  now?: () => number;
  /**
   * ストアが変化したときに呼ばれる (SSE push 駆動用)。
   * snapshot は `changed:true` のときのみ、voice-event は記録後に毎回発火する。
   */
  onChange?: () => void;
  /**
   * voice-event 記録後に **検証済み payload** を渡して呼ばれる (Phase 5 の音声パイプライン起動用)。
   * server.ts が `v => void pipeline.handle(v)` を渡す。非同期・best-effort で、ここでは await しない
   * (ingest の応答を待たせない)。
   */
  onVoiceEvent?: (payload: VoiceEventPayload) => void;
  /**
   * 検証を通った ingest を受けたときに clientId を渡して呼ばれる (接続状況ログ用)。
   * snapshot / voice-event 両方で毎回呼ばれる。初回接続/再接続の判定・ログは呼び出し側 (server.ts) が行う。
   */
  onContact?: (clientId: string, via: 'snapshot' | 'voice-event') => void;
}

/**
 * `/api/ingest` 配下のルータを作る。認証 (bearerAuth) は server.ts でマウント時に前段で噛ませる。
 */
export function createIngestRouter(deps: IngestDeps): Router {
  const now = deps.now ?? (() => Date.now());
  const onChange = deps.onChange ?? (() => { /* noop */ });
  const onVoiceEvent = deps.onVoiceEvent ?? (() => { /* noop */ });
  const onContact = deps.onContact ?? (() => { /* noop */ });
  const router = Router();

  router.post('/snapshot', (req: Request, res: Response) => {
    const parsed = validateSnapshot(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    // 認証 (bearerAuth) + 検証を通った = 正当なクライアントからの到達。レート制限の前に記録する。
    onContact(parsed.value.clientId, 'snapshot');
    if (!deps.snapshotLimiter.allow(parsed.value.clientId, now())) {
      res.status(429).json({ error: 'rate limited' });
      return;
    }
    const { changed } = deps.store.upsertSnapshot(parsed.value, now());
    // 内容に変化があったときだけ SSE を起こす (dedup された再送では起こさない)。
    if (changed) onChange();
    res.json({ ok: true, changed });
  });

  router.post('/voice-event', (req: Request, res: Response) => {
    const parsed = validateVoiceEvent(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const v = parsed.value;
    onContact(v.clientId, 'voice-event');
    const key = `${v.clientId}|${v.projectDir}|${v.kind}`;
    if (!deps.voiceCooldown.allow(key, now())) {
      res.status(429).json({ error: 'cooldown' });
      return;
    }
    deps.store.recordVoiceEvent(v, now());
    // 音声パイプライン (persona → TTS → utterance) を起動。応答は待たせない。
    onVoiceEvent(v);
    onChange();
    res.json({ ok: true });
  });

  return router;
}
