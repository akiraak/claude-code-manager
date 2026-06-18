import { STOPPED_RETENTION_SEC, type ActivityState } from './state';
import type { NormalizedEvent, TailSummary } from './transcript';

/**
 * `--mode server` の集約ストア。各端末 (client) が push したセッションスナップショットと
 * 状態遷移 (音声) イベントを **メモリ + TTL** で保持する。
 *
 * - キー: clientId (長さ接頭辞付き) + projectDir で 1 端末の 1 セッションを一意化する。
 * - 永続化しない。再起動で揮発し、クライアントが再 push して自己回復する (Phase 1 で確定した保持方針)。
 * - 時刻は呼び出し側から `nowMs` で注入する (テスト可能にするため内部で `Date.now()` を呼ばない)。
 *
 * Phase 2 では「受けて貯める」までを担う。集約ストア → `views.ts` 描画 (ミラー) は Phase 3、
 * voice イベント → ペルソナ文 → TTS は Phase 5。
 */

/** スナップショット payload の `entry` (= MonitorEntry のシリアライズ。`summary` は含めない)。 */
export interface SnapshotEntry {
  id: string;
  projectDir: string;
  cwd: string;
  /** プロセス生存時のみ。リモートの cwd は `entry.cwd` を使うので pid のみ送る。 */
  process?: { pid: number } | null;
  /** リモートは `jsonlPath` を送らない (絶対パスは無意味 + 情報漏れ)。 */
  transcript?: {
    projectDir: string;
    jsonlPath?: string;
    cwd: string;
    mtimeMs: number;
    sessionId: string;
  } | null;
  lastActivityAt?: string | null;
  tail?: TailSummary | null;
  state: ActivityState;
}

/** `POST /api/ingest/snapshot` の body。 */
export interface SnapshotPayload {
  clientId: string;
  sentAt?: string;
  entry: SnapshotEntry;
  /** readTailEvents 上限 200・redaction 済みの正規化イベント列。 */
  events?: NormalizedEvent[];
}

export type VoiceEventKind = 'started' | 'awaiting' | 'completed' | 'progress';

/** `POST /api/ingest/voice-event` の body。状態遷移イベント (発話の素)。 */
export interface VoiceEventPayload {
  clientId: string;
  sentAt?: string;
  projectDir: string;
  sessionId?: string;
  kind: VoiceEventKind;
  /** 発話の素になる短い説明 (クライアントで redaction + 切り詰め済み)。 */
  detail?: string;
  /** ペルソナ文に混ぜるプロジェクト名 (cwd の basename 等)。 */
  projectName?: string;
  /** 遷移後の状態。 */
  state?: ActivityState;
}

/** ストアに積まれた音声イベント (受信時刻付き)。 */
export interface StoredVoiceEvent extends VoiceEventPayload {
  receivedAtMs: number;
}

interface StoredSession {
  clientId: string;
  projectDir: string;
  /** スナップショット未着 (voice-event 先行) のうちは undefined。 */
  entry?: SnapshotEntry;
  events: NormalizedEvent[];
  /** dedup 用の指紋。`cwd|pid|mtimeMs|state`。 */
  fingerprint?: string;
  /** 最後に push を受けた時刻 (TTL 判定の基準)。 */
  lastSeenMs: number;
  voiceEvents: StoredVoiceEvent[];
}

/** セッションあたり保持する音声イベント数の上限 (リングバッファ)。 */
export const VOICE_EVENT_BUFFER = 20;

export interface AggregateStoreOptions {
  /** push が途絶えてからレコードを退避するまでの秒数 (既定: 停止保持と同じ 24h)。 */
  retentionSec?: number;
}

/**
 * セッションキー。clientId を「長さ接頭辞 + 本体」で連結することで、clientId / projectDir に
 * どんな文字が含まれても衝突しない (区切り文字に依存しない)。すべて印字可能 ASCII で、
 * ソースにバイナリ (NUL 等) を埋め込まない。
 */
function sessionKey(clientId: string, projectDir: string): string {
  return `${clientId.length}:${clientId}:${projectDir}`;
}

function entryFingerprint(entry: SnapshotEntry): string {
  return [
    entry.cwd,
    entry.process?.pid ?? '',
    entry.transcript?.mtimeMs ?? 0,
    entry.state,
  ].join('|');
}

export class AggregateStore {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly retentionMs: number;

  constructor(opts: AggregateStoreOptions = {}) {
    this.retentionMs = (opts.retentionSec ?? STOPPED_RETENTION_SEC) * 1000;
  }

  /**
   * スナップショットを反映する。指紋が前回と同一なら `lastSeenMs` だけ更新して `changed:false`
   * (dedup — Phase 3 の SSE push を無駄打ちさせない)。
   */
  upsertSnapshot(payload: SnapshotPayload, nowMs: number): { changed: boolean } {
    const key = sessionKey(payload.clientId, payload.entry.projectDir);
    const fp = entryFingerprint(payload.entry);
    const existing = this.sessions.get(key);
    const events = payload.events ?? [];

    if (existing) {
      existing.lastSeenMs = nowMs;
      if (existing.fingerprint === fp && existing.entry) {
        // 内容不変 (mtime も state も同じ) → dedup。entry/events は据え置き。
        return { changed: false };
      }
      existing.entry = payload.entry;
      existing.events = events;
      existing.fingerprint = fp;
      return { changed: true };
    }

    this.sessions.set(key, {
      clientId: payload.clientId,
      projectDir: payload.entry.projectDir,
      entry: payload.entry,
      events,
      fingerprint: fp,
      lastSeenMs: nowMs,
      voiceEvents: [],
    });
    return { changed: true };
  }

  /**
   * 音声イベントを積む。スナップショット未着でもイベントは落とさない
   * (順序保証が無いため、必要ならプレースホルダのセッションを作る)。
   */
  recordVoiceEvent(payload: VoiceEventPayload, nowMs: number): void {
    const key = sessionKey(payload.clientId, payload.projectDir);
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        clientId: payload.clientId,
        projectDir: payload.projectDir,
        events: [],
        lastSeenMs: nowMs,
        voiceEvents: [],
      };
      this.sessions.set(key, session);
    }
    session.lastSeenMs = nowMs;
    session.voiceEvents.push({ ...payload, receivedAtMs: nowMs });
    if (session.voiceEvents.length > VOICE_EVENT_BUFFER) {
      session.voiceEvents.splice(0, session.voiceEvents.length - VOICE_EVENT_BUFFER);
    }
  }

  /** TTL 内で entry を持つレコードを返す (Phase 3 の RemoteEntrySource 用)。 */
  listEntries(nowMs: number): SnapshotEntry[] {
    this.prune(nowMs);
    const out: SnapshotEntry[] = [];
    for (const s of this.sessions.values()) {
      if (s.entry) out.push(s.entry);
    }
    return out;
  }

  /** entry id でイベント列を返す (Phase 3 のプロセス詳細用)。 */
  getEvents(id: string, nowMs: number): NormalizedEvent[] {
    this.prune(nowMs);
    for (const s of this.sessions.values()) {
      if (s.entry?.id === id) return s.events;
    }
    return [];
  }

  /** TTL 内の音声イベントを新しい順で返す (Phase 5/6 用)。 */
  recentVoiceEvents(nowMs: number, limit = 50): StoredVoiceEvent[] {
    this.prune(nowMs);
    const all: StoredVoiceEvent[] = [];
    for (const s of this.sessions.values()) all.push(...s.voiceEvents);
    all.sort((a, b) => b.receivedAtMs - a.receivedAtMs);
    return all.slice(0, limit);
  }

  /** `lastSeenMs` が保持期間より古いレコードを退避する。 */
  prune(nowMs: number): void {
    const cutoff = nowMs - this.retentionMs;
    for (const [key, s] of this.sessions) {
      if (s.lastSeenMs < cutoff) this.sessions.delete(key);
    }
  }

  /** 現在のセッション数 (テスト / デバッグ用)。 */
  size(): number {
    return this.sessions.size;
  }
}
