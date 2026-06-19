import path from 'path';

import { watchAwaitingInputMarkers } from './awaiting-input';
import { LocalEntrySource, type EntrySource } from './entry-source';
import { sanitizeText } from './redaction';
import type { ActivityState, MonitorEntry } from './state';
import type {
  SnapshotEntry,
  SnapshotPayload,
  VoiceEventKind,
  VoiceEventPayload,
} from './store';
import type { NormalizedEvent, TailSummary } from './transcript';

/**
 * `--mode client` の uplink エージェント。
 *
 * 各端末で既存検出 ({@link LocalEntrySource} = `buildEntries`/`readTailEvents`/`classifyV2`) を
 * 再利用して現状を算出し、公開サーバ (`--mode server`) の Phase 2/3 で作った受け口へ push する:
 *  - `POST /api/ingest/snapshot`     状態スナップショット (ミラー用・latest-wins)
 *  - `POST /api/ingest/voice-event`  状態遷移イベント (発話の素・バッファ + バックオフで落とさない)
 *
 * 送信前に redaction ({@link sanitizeText}) を掛け、`jsonlPath` 等の漏洩源は送らない。
 * 公開サーバ未到達時はリトライ/バックオフし、voice-event はキューに溜めて落とさない。
 * `CCM_DRYRUN=1` で実送信せずログのみ。
 *
 * 設計の詳細は docs/plans/claude-progress-voice-phase4.md を参照。
 */

// ---- 定数 -----------------------------------------------------------------

const MAX_CLIENT_ID = 128;
const MIN_TOKEN_LEN = 16;
const DEFAULT_INTERVAL_MS = 4000;
const MIN_INTERVAL_MS = 1000;
const DEFAULT_PROGRESS_AFTER_MS = 120_000;
const DEFAULT_PROGRESS_EVERY_MS = 120_000;

/** 1 スナップショットで送るイベント上限 (server の MAX_EVENTS=200 内 + 512kb 上限対策で控えめに)。 */
export const SNAPSHOT_MAX_EVENTS = 150;
const EVENT_TEXT_MAX = 1200;
const TAIL_TEXT_MAX = 2000;
const VOICE_DETAIL_MAX = 300;

const SNAPSHOT_BASE_BACKOFF_MS = 5000;
const SNAPSHOT_MAX_BACKOFF_MS = 60_000;
/** 変化が無くても TTL/lastSeen を保つために snapshot を再送する間隔。 */
const SNAPSHOT_HEARTBEAT_MS = 30_000;
/** 429 (per-client レート制限) を受けたとき、次の snapshot 送信まで待つ時間。 */
const SNAPSHOT_RATE_LIMIT_COOLDOWN_MS = 5_000;
const DEFAULT_VOICE_MAX_QUEUE = 100;
const DEFAULT_VOICE_BASE_BACKOFF_MS = 2000;
const DEFAULT_VOICE_MAX_BACKOFF_MS = 60_000;
const DEFAULT_HTTP_TIMEOUT_MS = 8000;

// ---- 設定 -----------------------------------------------------------------

export interface ClientConfig {
  /** 送信先 (例 `https://ccm.chobi.me`)。末尾 `/` は除去済み。dryrun なら空でも可。 */
  serverUrl: string;
  /** 端末別 Bearer トークン。dryrun なら空でも可。 */
  token: string;
  /** clientId (集約ストアの突き合わせキー)。既定は hostname。 */
  label: string;
  /** ミラー対象 allowlist。null = 全件。 */
  mirrorProjects: string[] | null;
  /** true なら実送信せずログのみ。 */
  dryrun: boolean;
  /** snapshot tick 間隔 (ms)。 */
  intervalMs: number;
  /** ai-processing 継続がこの時間を超えたら最初の progress を出す。 */
  progressAfterMs: number;
  /** 以降 progress を出す間隔。 */
  progressEveryMs: number;
}

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

function parsePosIntMs(raw: string | undefined, dflt: number, min: number): number {
  if (raw === undefined || raw.trim() === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.max(min, Math.floor(n));
}

/**
 * env から {@link ClientConfig} を組み立てる (純関数)。
 * 非 dryrun では `CCM_SERVER_URL` (http(s)://) と `CCM_CLIENT_TOKEN` (16 文字以上) が必須で、
 * 欠落/不正なら throw する (cli.ts が catch → exit 1。photorans の URL_SECRET 流儀)。
 */
export function loadClientConfig(
  env: Record<string, string | undefined>,
  hostname: string,
): ClientConfig {
  const dryrun = isTruthy(env.CCM_DRYRUN);
  const serverUrl = (env.CCM_SERVER_URL ?? '').trim().replace(/\/+$/, '');
  const token = (env.CCM_CLIENT_TOKEN ?? '').trim();
  const label = ((env.CCM_CLIENT_LABEL ?? '').trim() || hostname || 'unknown').slice(0, MAX_CLIENT_ID);
  const list = parseList(env.CCM_MIRROR_PROJECTS);
  const mirrorProjects = list.length > 0 ? list : null;
  const intervalMs = parsePosIntMs(env.CCM_CLIENT_INTERVAL_MS, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS);
  const progressAfterMs = parsePosIntMs(env.CCM_PROGRESS_AFTER_MS, DEFAULT_PROGRESS_AFTER_MS, 1000);
  const progressEveryMs = parsePosIntMs(env.CCM_PROGRESS_EVERY_MS, DEFAULT_PROGRESS_EVERY_MS, 1000);

  if (!dryrun) {
    if (!serverUrl) {
      throw new Error('CCM_SERVER_URL が未設定です (client モードには必須。送信せず動かすなら CCM_DRYRUN=1)');
    }
    if (!/^https?:\/\//i.test(serverUrl)) {
      throw new Error(`CCM_SERVER_URL が http(s):// で始まっていません: ${serverUrl}`);
    }
    if (!token) {
      throw new Error('CCM_CLIENT_TOKEN が未設定です (client モードには必須。送信せず動かすなら CCM_DRYRUN=1)');
    }
    if (token.length < MIN_TOKEN_LEN) {
      throw new Error(`CCM_CLIENT_TOKEN が短すぎます (${MIN_TOKEN_LEN} 文字以上が必要)`);
    }
  }

  return { serverUrl, token, label, mirrorProjects, dryrun, intervalMs, progressAfterMs, progressEveryMs };
}

/**
 * entry がミラー対象 allowlist に含まれるか (純関数)。
 * allowlist 未設定 (null/空) は全件 true。設定時は cwd basename / projectDir / cwd 完全一致。
 */
export function isProjectMirrored(
  entry: { cwd: string; projectDir: string },
  allowlist: string[] | null,
): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  const base = path.basename(entry.cwd);
  return allowlist.includes(base) || allowlist.includes(entry.projectDir) || allowlist.includes(entry.cwd);
}

// ---- シリアライズ (送信前 redaction) --------------------------------------

function sanitizeEvents(events: NormalizedEvent[], maxEvents: number): NormalizedEvent[] {
  const sliced = events.length > maxEvents ? events.slice(events.length - maxEvents) : events;
  return sliced.map(e => (e.text ? { ...e, text: sanitizeText(e.text, EVENT_TEXT_MAX) } : { ...e }));
}

function sanitizeTail(tail: TailSummary | undefined): TailSummary | null {
  if (!tail) return null;
  return {
    ...tail,
    lastUserText: tail.lastUserText ? sanitizeText(tail.lastUserText, TAIL_TEXT_MAX) : tail.lastUserText,
    lastAssistantText: tail.lastAssistantText
      ? sanitizeText(tail.lastAssistantText, TAIL_TEXT_MAX)
      : tail.lastAssistantText,
  };
}

export interface BuildSnapshotOptions {
  maxEvents?: number;
  /** 送信時刻 (ms)。指定すると `sentAt` を ISO で埋める。 */
  sentAtMs?: number;
}

/**
 * `MonitorEntry` をワイヤ形式 {@link SnapshotPayload} に変換する (純関数・送信前 redaction)。
 *
 * - `process` は `{ pid }` のみ (cwd は entry.cwd を使うので落とす)。
 * - `transcript.jsonlPath` は **送らない** (絶対パスは無意味 + 情報漏れ)。
 * - event.text / tail 本文は {@link sanitizeText} でマスク + 切り詰め。
 * - 出力は Phase 2 の `validateSnapshot` が通る形 (テストでクロスチェックする)。
 */
export function buildSnapshotPayload(
  clientId: string,
  entry: MonitorEntry,
  events: NormalizedEvent[],
  opts: BuildSnapshotOptions = {},
): SnapshotPayload {
  const maxEvents = opts.maxEvents ?? SNAPSHOT_MAX_EVENTS;
  const snapEntry: SnapshotEntry = {
    id: entry.id,
    projectDir: entry.projectDir,
    cwd: entry.cwd,
    process: entry.process ? { pid: entry.process.pid } : null,
    transcript: entry.transcript
      ? {
          projectDir: entry.transcript.projectDir,
          cwd: entry.transcript.cwd,
          mtimeMs: entry.transcript.mtimeMs,
          sessionId: entry.transcript.sessionId,
        }
      : null,
    lastActivityAt: entry.lastActivityAt ?? null,
    tail: sanitizeTail(entry.tail),
    state: entry.state,
  };
  return {
    clientId,
    sentAt: opts.sentAtMs !== undefined ? new Date(opts.sentAtMs).toISOString() : undefined,
    entry: snapEntry,
    events: sanitizeEvents(events, maxEvents),
  };
}

/**
 * クライアント側の変化検出フィンガープリント。サーバの dedup 指紋 (`store.ts` の
 * `entryFingerprint`) と同じ `cwd|pid|mtimeMs|state` にしてあるので、これが変わったときだけ
 * 送れば「サーバが `changed:true` と見なす変化」を取りこぼさない (jsonl 追記は mtimeMs に出る)。
 */
export function entrySnapshotFingerprint(entry: MonitorEntry): string {
  return [entry.cwd, entry.process?.pid ?? '', entry.transcript?.mtimeMs ?? 0, entry.state].join('|');
}

// ---- 状態遷移検出 ---------------------------------------------------------

export interface VoiceSessionInput {
  projectDir: string;
  sessionId?: string;
  projectName?: string;
  state: ActivityState;
  /** 開始 (started) 発話の素 (redaction 済み)。 */
  lastUserText?: string;
  /** 承認待ち/完了/途中経過の発話の素 (redaction 済み)。 */
  lastAssistantText?: string;
  /**
   * 最後の assistant メッセージの timestamp。**ターンの識別子**として dedup に使う
   * (揺れ=同一 timestamp / 別ターン=新 timestamp)。送信はしない (client 内 dedup 専用)。
   */
  lastAssistantAt?: string;
}

export interface VoiceEventOut {
  projectDir: string;
  sessionId?: string;
  projectName?: string;
  kind: VoiceEventKind;
  detail?: string;
  state: ActivityState;
}

interface DetectorSessionState {
  state: ActivityState;
  /** ai-processing に入った時刻 (progress 判定の基準)。 */
  aiSinceMs?: number;
  /** 最後に progress を出した時刻。 */
  lastProgressMs?: number;
  /**
   * 直近に emit した「読み上げ対象の遷移イベント」(completed / awaiting) の署名
   * `kind|lastAssistantAt|detail`。**同一ターンの再発火だけ**を抑制するために使う。
   *
   * ターン完了直後は jsonl mtime が新しく classifyV2 が一時的に ai-processing と判定するため
   * `waiting→ai-processing→waiting` と揺れて、同じ assistant メッセージのまま completed が
   * 二重発火しうる。署名にターン識別子 `lastAssistantAt` を含めることで:
   *  - 揺れ (新しい assistant メッセージ無し) = 同一 timestamp → 同一署名 → 抑制
   *  - 別ターンの正規完了 = 新しい timestamp → 別署名 → **同じ短文・短時間でも発話**
   * これにより時間窓に頼らず「正規のフォローアップ完了を落とさない」を保証する。
   * 間に挟まる started は読み上げ対象でないので署名を更新しない (started を跨いでも抑制が効く)。
   * progress は周期通知なので対象外。
   */
  lastSpokenSig?: string;
}

/**
 * completed / awaiting の重複抑制キー。`lastAssistantAt` (= ターン識別子) を含めることで、
 * 同一ターンの揺れだけを抑制し、別ターンの同一テキストは別署名になり発話される。
 * ターン識別子が取れないとき (lastAssistantAt 未設定) は **抑制しない** (null) — 正規イベントを
 * 落とすより重複を許容する方が安全。
 */
function spokenTransitionSig(ev: VoiceEventOut, s: VoiceSessionInput): string | null {
  if (ev.kind !== 'completed' && ev.kind !== 'awaiting') return null;
  if (!s.lastAssistantAt) return null;
  return `${ev.kind}|${s.lastAssistantAt}|${ev.detail ?? ''}`;
}

/**
 * projectDir 単位で前回 state を覚え、tick ごとに遷移から発話イベントを 0..N 件出す (純粋・時刻注入)。
 *
 * - **初回観測 = baseline (発話しない)**。monitor 再起動で全 awaiting を再発話する事故を防ぐ。
 * - `* → awaiting-user` → awaiting / `* → ai-processing` → started /
 *   `ai-processing → waiting` → completed / `ai-processing → stopped` → 無 (/exit と区別不可) /
 *   ai-processing 継続が progressAfterMs 超で progress (以降 progressEveryMs ごと)。
 * - 一覧から消えた projectDir は state を破棄 (再登場は baseline 扱い)。
 */
export class VoiceEventDetector {
  private readonly states = new Map<string, DetectorSessionState>();
  private readonly progressAfterMs: number;
  private readonly progressEveryMs: number;

  constructor(opts: { progressAfterMs?: number; progressEveryMs?: number } = {}) {
    this.progressAfterMs = opts.progressAfterMs ?? DEFAULT_PROGRESS_AFTER_MS;
    this.progressEveryMs = opts.progressEveryMs ?? DEFAULT_PROGRESS_EVERY_MS;
  }

  observe(sessions: VoiceSessionInput[], nowMs: number): VoiceEventOut[] {
    const out: VoiceEventOut[] = [];
    const seen = new Set<string>();

    for (const s of sessions) {
      seen.add(s.projectDir);
      const prev = this.states.get(s.projectDir);

      if (!prev) {
        // 初回 = baseline。発話せず現在 state だけ記録する。
        this.states.set(s.projectDir, {
          state: s.state,
          aiSinceMs: s.state === 'ai-processing' ? nowMs : undefined,
        });
        continue;
      }

      if (s.state !== prev.state) {
        const ev = transitionEvent(prev.state, s);
        let lastSpokenSig = prev.lastSpokenSig;
        if (ev) {
          const sig = spokenTransitionSig(ev, s);
          if (sig !== null && sig === prev.lastSpokenSig) {
            // 同一ターンの再発火 (lastAssistantAt 不変) → 発話イベントを出さない。
            // 別ターンなら lastAssistantAt が変わり署名が変わるので、ここでは抑制されない。
            // (状態遷移自体は下で記録するので state machine は壊さない)。
          } else {
            out.push(ev);
            if (sig !== null) lastSpokenSig = sig;
          }
        }
        this.states.set(s.projectDir, {
          state: s.state,
          aiSinceMs: s.state === 'ai-processing' ? nowMs : undefined,
          lastProgressMs: undefined,
          lastSpokenSig,
        });
        continue;
      }

      // state 不変。ai-processing 継続中だけ progress を検討する。
      if (s.state === 'ai-processing') {
        const since = prev.aiSinceMs ?? nowMs;
        const due = prev.lastProgressMs === undefined
          ? nowMs - since >= this.progressAfterMs
          : nowMs - prev.lastProgressMs >= this.progressEveryMs;
        if (due) {
          out.push({
            projectDir: s.projectDir,
            sessionId: s.sessionId,
            projectName: s.projectName,
            kind: 'progress',
            detail: s.lastAssistantText,
            state: s.state,
          });
          // progress は周期通知なので lastSpokenSig は更新しない (completed/awaiting の重複判定に影響させない)。
          this.states.set(s.projectDir, { state: s.state, aiSinceMs: since, lastProgressMs: nowMs, lastSpokenSig: prev.lastSpokenSig });
        } else {
          this.states.set(s.projectDir, { state: s.state, aiSinceMs: since, lastProgressMs: prev.lastProgressMs, lastSpokenSig: prev.lastSpokenSig });
        }
      }
      // 非 ai-processing で state 不変なら prev のまま (何もしない)。
    }

    // 一覧から消えたセッションは state を破棄する。
    for (const key of Array.from(this.states.keys())) {
      if (!seen.has(key)) this.states.delete(key);
    }
    return out;
  }
}

function transitionEvent(prevState: ActivityState, s: VoiceSessionInput): VoiceEventOut | null {
  const base = {
    projectDir: s.projectDir,
    sessionId: s.sessionId,
    projectName: s.projectName,
    state: s.state,
  };
  if (s.state === 'awaiting-user') return { ...base, kind: 'awaiting', detail: s.lastAssistantText };
  if (s.state === 'ai-processing') return { ...base, kind: 'started', detail: s.lastUserText };
  if (prevState === 'ai-processing' && s.state === 'waiting') {
    return { ...base, kind: 'completed', detail: s.lastAssistantText };
  }
  return null;
}

// ---- HTTP 送信 ------------------------------------------------------------

export type PostOutcome =
  | { ok: true }
  | { ok: false; retryable: boolean; status?: number; error?: string };

export type Poster = (pathSuffix: string, body: unknown) => Promise<PostOutcome>;

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number }>;

/** HTTP status → 送信結果の分類。429/4xx は意図的拒否なので drop、408/5xx と例外は retry。 */
export function classifyStatus(status: number): PostOutcome {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 408 || status >= 500) return { ok: false, retryable: true, status };
  return { ok: false, retryable: false, status };
}

export interface HttpPosterOptions {
  serverUrl: string;
  token: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** `${serverUrl}/api/ingest${pathSuffix}` へ Bearer 付き POST する {@link Poster}。 */
export function createHttpPoster(opts: HttpPosterOptions): Poster {
  const base = opts.serverUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  if (!opts.fetchImpl && typeof globalThis.fetch !== 'function') {
    throw new Error('グローバル fetch がありません (Node 18+ が必要です)');
  }
  const doFetch: FetchLike = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  return async (pathSuffix, body) => {
    const url = `${base}/api/ingest${pathSuffix}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.token}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return classifyStatus(res.status);
    } catch (err) {
      // ネットワーク / timeout / abort はリトライ可能扱い。
      return { ok: false, retryable: true, error: String(err) };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** 実送信せずログのみ出す {@link Poster} (CCM_DRYRUN 用)。token は body に無いのでログに出ない。 */
export function createDryRunPoster(log: (msg: string) => void): Poster {
  return async (pathSuffix, body) => {
    log(`[uplink][dryrun] POST /api/ingest${pathSuffix} ${JSON.stringify(body).slice(0, 400)}`);
    return { ok: true };
  };
}

// ---- voice-event キュー (バッファ + バックオフ) ---------------------------

export interface VoiceEventQueueOptions {
  poster: Poster;
  clientId: string;
  maxSize?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * voice-event を **落とさず** に送るキュー。順序保持でドレインし、retryable 失敗は head に残して
 * バックオフ、not-retryable (4xx/429) は drop する。満杯時は最古を捨てる。
 */
export class VoiceEventQueue {
  private readonly q: VoiceEventOut[] = [];
  private readonly poster: Poster;
  private readonly clientId: string;
  private readonly maxSize: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private nextAttemptAt = 0;
  private backoffMs = 0;

  constructor(opts: VoiceEventQueueOptions) {
    this.poster = opts.poster;
    this.clientId = opts.clientId;
    this.maxSize = opts.maxSize ?? DEFAULT_VOICE_MAX_QUEUE;
    this.baseBackoffMs = opts.baseBackoffMs ?? DEFAULT_VOICE_BASE_BACKOFF_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_VOICE_MAX_BACKOFF_MS;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((m) => console.log(m));
  }

  size(): number {
    return this.q.length;
  }

  enqueue(ev: VoiceEventOut): void {
    if (this.q.length >= this.maxSize) {
      this.q.shift();
      this.log(`[uplink] voice キュー満杯 (${this.maxSize})。最古を破棄`);
    }
    this.q.push(ev);
  }

  /** キューをドレインする。バックオフ中なら何もしない。 */
  async flush(): Promise<void> {
    if (this.now() < this.nextAttemptAt) return;
    while (this.q.length > 0) {
      const ev = this.q[0];
      const payload: VoiceEventPayload = {
        clientId: this.clientId,
        sentAt: new Date(this.now()).toISOString(),
        ...ev,
      };
      let r: PostOutcome;
      try {
        r = await this.poster('/voice-event', payload);
      } catch (err) {
        r = { ok: false, retryable: true, error: String(err) };
      }
      if (r.ok) {
        this.q.shift();
        this.resetBackoff();
        continue;
      }
      if (!r.retryable) {
        this.q.shift();
        this.resetBackoff();
        this.log(`[uplink] voice-event 恒久エラー (status=${r.status ?? '?'})。破棄`);
        continue;
      }
      this.bumpBackoff();
      break;
    }
  }

  private bumpBackoff(): void {
    this.backoffMs = Math.min(Math.max(this.baseBackoffMs, this.backoffMs * 2), this.maxBackoffMs);
    this.nextAttemptAt = this.now() + this.backoffMs;
  }

  private resetBackoff(): void {
    this.backoffMs = 0;
    this.nextAttemptAt = 0;
  }
}

// ---- ランナー -------------------------------------------------------------

export interface UplinkRunnerDeps {
  /** 既定 LocalEntrySource。テストで差し替え可能。 */
  source?: EntrySource;
  /** 既定は dryrun なら DryRunPoster、そうでなければ HttpPoster。 */
  poster?: Poster;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface UplinkRunner {
  /** 1 回分の検出 → snapshot 送信 → voice 検出 → flush を回す。 */
  tickOnce(): Promise<void>;
  readonly queue: VoiceEventQueue;
  readonly detector: VoiceEventDetector;
}

/**
 * uplink の 1 tick ぶんの処理機構を組み立てる (タイマー/FS watch は張らない)。
 * `startUplink` がこれを使って周期実行する。テストは `tickOnce` を直接叩く。
 */
export function createUplinkRunner(config: ClientConfig, deps: UplinkRunnerDeps = {}): UplinkRunner {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((m) => console.log(m));
  const source = deps.source ?? new LocalEntrySource();
  const poster = deps.poster
    ?? (config.dryrun
      ? createDryRunPoster(log)
      : createHttpPoster({ serverUrl: config.serverUrl, token: config.token }));
  const detector = new VoiceEventDetector({
    progressAfterMs: config.progressAfterMs,
    progressEveryMs: config.progressEveryMs,
  });
  const queue = new VoiceEventQueue({ poster, clientId: config.label, now, log });

  let snapshotNextAttemptAt = 0;
  let snapshotBackoffMs = 0;
  let inflight = false;
  // サーバ到達状態。接続OK / 切れ の「遷移」だけをログする (毎回の成功送信は無言)。
  let connected = false;
  let everConnected = false;
  const markConnected = (): void => {
    if (connected) return;
    connected = true;
    if (!config.dryrun) log(`[uplink] サーバ接続${everConnected ? '復帰' : 'OK'} (server=${config.serverUrl})`);
    everConnected = true;
  };
  // entry.id → 最後に「200 で受理された」指紋 / 送信時刻。変化検出 + heartbeat + 公平性に使う。
  const lastSentFp = new Map<string, string>();
  const lastSentAtMs = new Map<string, number>();

  /**
   * snapshot を送る。**毎 tick 全 project を送らない** — それだと per-client レート制限
   * (server 既定 30/10s) を踏み、cwd ソート末尾の project が毎ウィンドウ 429 され恒久 starve する。
   * 指紋が変わった or heartbeat 期限切れの project だけを、最後に送った時刻が古い順 (= starve 気味を優先)
   * に送る。429 は今 tick を打ち切って短時間クールダウンし、未送信分は lastSent を据え置くので次 tick で先頭に来る。
   */
  const sendSnapshots = async (entries: MonitorEntry[]): Promise<void> => {
    const tnow = now();
    // 現存しない project の追跡情報を掃除 (Map の無制限増殖を防ぐ)。
    const live = new Set(entries.map(e => e.id));
    for (const k of Array.from(lastSentFp.keys())) {
      if (!live.has(k)) {
        lastSentFp.delete(k);
        lastSentAtMs.delete(k);
      }
    }

    if (tnow < snapshotNextAttemptAt) return; // バックオフ / レート制限クールダウン中

    const due = entries.filter(e => {
      const sentAt = lastSentAtMs.get(e.id);
      return (
        lastSentFp.get(e.id) !== entrySnapshotFingerprint(e) || // 変化した
        sentAt === undefined || // 未送信
        tnow - sentAt >= SNAPSHOT_HEARTBEAT_MS // heartbeat 期限切れ
      );
    });
    // 公平性: 最後に送った時刻が古い順 (未送信 = 0 = 最古)。バースト超過時も特定 project が starve しない。
    due.sort((a, b) => (lastSentAtMs.get(a.id) ?? 0) - (lastSentAtMs.get(b.id) ?? 0));

    for (const entry of due) {
      const events = source.readEvents(entry, SNAPSHOT_MAX_EVENTS);
      const payload = buildSnapshotPayload(config.label, entry, events, { sentAtMs: now() });
      const r = await poster('/snapshot', payload);
      if (r.ok) {
        markConnected();
        // changed:true / false (dedup) どちらも 200。受理されたので指紋と時刻を更新する。
        lastSentFp.set(entry.id, entrySnapshotFingerprint(entry));
        lastSentAtMs.set(entry.id, now());
        snapshotBackoffMs = 0;
        snapshotNextAttemptAt = 0;
        continue;
      }
      if (r.status === 429) {
        markConnected(); // 429 はサーバが応答している = 到達できている
        // レート制限。今 tick は打ち切り、短時間クールダウン。lastSent を更新しないので
        // 送れなかった project は次 tick で「古い順」の先頭に来る (恒久 starve しない)。
        snapshotBackoffMs = 0;
        snapshotNextAttemptAt = now() + SNAPSHOT_RATE_LIMIT_COOLDOWN_MS;
        log('[uplink] snapshot レート制限 (429)。短時間クールダウンして次 tick で再送');
        return;
      }
      // 5xx / network / timeout / その他 4xx (認証エラー等) → サーバ不調扱いで指数バックオフ。
      connected = false; // 接続が切れた (次に成功したら「接続復帰」をログ)
      snapshotBackoffMs = Math.min(Math.max(SNAPSHOT_BASE_BACKOFF_MS, snapshotBackoffMs * 2), SNAPSHOT_MAX_BACKOFF_MS);
      snapshotNextAttemptAt = now() + snapshotBackoffMs;
      log(`[uplink] snapshot 送信失敗 (status=${r.status ?? 'net'})。${Math.round(snapshotBackoffMs / 1000)}s バックオフ`);
      return;
    }
  };

  const tickOnce = async (): Promise<void> => {
    if (inflight) return; // 前 tick がまだ走っていればスキップ (重なり防止)
    inflight = true;
    try {
      let entries: MonitorEntry[];
      try {
        entries = await source.buildEntries();
      } catch (err) {
        log(`[uplink] buildEntries 失敗: ${String(err)}`);
        return;
      }
      const mirrored = entries.filter(e => isProjectMirrored(e, config.mirrorProjects));

      await sendSnapshots(mirrored);

      const inputs: VoiceSessionInput[] = mirrored.map(e => ({
        projectDir: e.projectDir,
        sessionId: e.transcript?.sessionId,
        projectName: path.basename(e.cwd) || e.cwd,
        state: e.state,
        lastUserText: e.tail?.lastUserText ? sanitizeText(e.tail.lastUserText, VOICE_DETAIL_MAX) : undefined,
        lastAssistantText: e.tail?.lastAssistantText
          ? sanitizeText(e.tail.lastAssistantText, VOICE_DETAIL_MAX)
          : undefined,
        // dedup 用のターン識別子 (最後の assistant メッセージの timestamp)。
        // 揺れ=同一 timestamp / 別ターン=新 timestamp。送信はせず client 内 dedup のみに使う。
        lastAssistantAt: e.tail?.lastAssistantAt,
      }));
      for (const ev of detector.observe(inputs, now())) queue.enqueue(ev);
      await queue.flush();
    } finally {
      inflight = false;
    }
  };

  return { tickOnce, queue, detector };
}

export interface UplinkHandle {
  stop(): void;
}

/**
 * uplink を起動して周期実行する。`setInterval` + 起動時即 tick + marker watch
 * (awaiting 低レイテンシ検出) を張る。返り値の `stop()` で全て閉じる。
 */
export function startUplink(config: ClientConfig, deps: UplinkRunnerDeps = {}): UplinkHandle {
  const log = deps.log ?? ((m) => console.log(m));
  const runner = createUplinkRunner(config, deps);

  let host = '(none)';
  try {
    host = config.serverUrl ? new URL(config.serverUrl).host : '(none)';
  } catch {
    host = config.serverUrl;
  }
  log(
    `[uplink] 起動: server=${config.dryrun ? '(dryrun)' : host} label=${config.label} ` +
      `interval=${config.intervalMs}ms mirror=${config.mirrorProjects ? config.mirrorProjects.join(',') : '全件'}`,
  );

  const trigger = (): void => {
    void runner.tickOnce();
  };
  trigger(); // 起動時即時
  const interval = setInterval(trigger, config.intervalMs);
  // PermissionRequest marker の変化で即 tick (awaiting を 2 秒待たずに拾う)。
  const stopWatch = watchAwaitingInputMarkers(trigger);

  return {
    stop(): void {
      clearInterval(interval);
      try {
        stopWatch();
      } catch {
        /* ignore */
      }
    },
  };
}
