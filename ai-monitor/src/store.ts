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
  /** 発話の素になる短い説明 (クライアントで redaction + 切り詰め済み)。後方互換で残す。 */
  detail?: string;
  /** ペルソナ文に混ぜるプロジェクト名 (cwd の basename 等)。 */
  projectName?: string;
  /** 遷移後の状態。 */
  state?: ActivityState;
  /**
   * 2 人会話の素になる作業コンテキスト (クライアントで抽出 + redaction + 切り詰め済み)。
   * ai-twitch-cast の `summary` 相当。ingest で配列長・各文字数が検証される。
   */
  context?: VoiceEventContext;
  /**
   * イベント単位の冪等キー (クライアントが採番。lost-ack 再送をまたいで不変)。
   * server はこれで再送された同一イベントを判定し、会話の二重生成を防ぐ。
   * 旧クライアントは未設定 → server は dedup せず従来どおり生成する。
   */
  eventId?: string;
}

/** voice-event に載せる作業コンテキスト (会話台本生成の入力)。 */
export interface VoiceEventContext {
  /** ユーザーの最新の指示 (200 字程度)。 */
  userPrompt?: string;
  /** 直近のアクション (「コマンド実行: …」「ファイル編集: …」等。最大 10 件)。 */
  actions?: string[];
  /** Claude のテキストメモ (直近 3 件)。 */
  notes?: string[];
  /** ai-processing 開始からの経過 (分)。 */
  elapsedMin?: number;
}

/** ストアに積まれた音声イベント (受信時刻付き)。 */
export interface StoredVoiceEvent extends VoiceEventPayload {
  receivedAtMs: number;
}

/** `listSessions` が返す 1 セッション。entry に加えて突き合わせ用の clientId / projectDir を持つ。 */
export interface RemoteSession {
  clientId: string;
  projectDir: string;
  entry: SnapshotEntry;
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

  /**
   * TTL 内で entry を持つセッションを **clientId 付き**で返す (Phase 3 の RemoteEntrySource 用)。
   *
   * `SnapshotEntry.id` は端末側で `encodeId(projectDir)` を振っており、複数端末が同じ
   * `projectDir` を push すると衝突する。RemoteEntrySource はこの `clientId` を使って
   * `(clientId, projectDir)` の合成 id を作り、ミラー上で 1 カードに分離する。
   */
  listSessions(nowMs: number): RemoteSession[] {
    this.prune(nowMs);
    const out: RemoteSession[] = [];
    for (const s of this.sessions.values()) {
      if (s.entry) out.push({ clientId: s.clientId, projectDir: s.projectDir, entry: s.entry });
    }
    return out;
  }

  /** `(clientId, projectDir)` でイベント列を返す (Phase 3 のプロセス詳細 / 要約用)。 */
  getEventsBySession(clientId: string, projectDir: string, nowMs: number): NormalizedEvent[] {
    this.prune(nowMs);
    const s = this.sessions.get(sessionKey(clientId, projectDir));
    return s ? s.events : [];
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
