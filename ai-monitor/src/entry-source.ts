import {
  buildEntries,
  decodeId,
  encodeId,
  readSummaryStatus,
  type BuildEntriesOptions,
  type MonitorEntry,
} from './state';
import type { SummarizeInput, SummaryResult } from './summarize';
import {
  findLastUserText,
  readTailEvents,
  type NormalizedEvent,
  type TranscriptInfo,
} from './transcript';
import { AggregateStore, type RemoteSession } from './store';

/** `/api/summarize` 用。Summarizer のキャッシュキー・対象 mtime・計算入力をまとめたもの。 */
export interface SummaryTarget {
  /** Summarizer キャッシュキー (local=jsonlPath, remote=合成キー)。Summarizer は opaque 文字列として扱う。 */
  key: string;
  /** 対象の mtime (staleness 判定)。 */
  mtimeMs: number;
  /** 要約計算の入力。 */
  input: SummarizeInput;
}

/**
 * ダッシュボード描画の唯一のデータソースを抽象化する seam。
 *
 * 現行 (local モード) はローカル FS / `/proc` を pull する {@link LocalEntrySource}。
 * 公開サーバ (server モード) はリモート端末の FS を読めないため、集約ストアを読む
 * {@link RemoteEntrySource} を使う。
 *
 * `views.ts` / `server.ts` の描画系は `EntrySource` のメソッドだけに依存させ、データの
 * 出どころ (pull / push) を意識させない。`buildEntries` がカード一覧、`readEvents` が詳細ビュー、
 * `summaryTargetOf` が要約のキー/入力をそれぞれ source に応じて供給する。
 */
export interface EntrySource {
  buildEntries(opts?: BuildEntriesOptions): Promise<MonitorEntry[]>;
  /** プロセス詳細ビュー用のイベント列。local は jsonl から、remote は集約ストアから読む。 */
  readEvents(entry: MonitorEntry, limit: number): NormalizedEvent[];
  /** 要約のキー・対象 mtime・入力。要約できない (jsonl/transcript 無し) なら null。 */
  summaryTargetOf(entry: MonitorEntry): SummaryTarget | null;
}

/**
 * 現行どおりローカルの `/proc` + `~/.claude/projects` + marker を pull する実装。
 * 既存の自由関数 {@link buildEntries} / {@link readTailEvents} に委譲するだけで、挙動は完全に同一。
 */
export class LocalEntrySource implements EntrySource {
  buildEntries(opts: BuildEntriesOptions = {}): Promise<MonitorEntry[]> {
    return buildEntries(opts);
  }

  readEvents(entry: MonitorEntry, limit: number): NormalizedEvent[] {
    return entry.transcript ? readTailEvents(entry.transcript.jsonlPath, limit) : [];
  }

  summaryTargetOf(entry: MonitorEntry): SummaryTarget | null {
    if (!entry.transcript) return null;
    const { jsonlPath, mtimeMs } = entry.transcript;
    // 要約は state 判定 (50 件) より広い窓 + ピン留め user-text で組み立てる
    // (server.ts /api/summarize の従来挙動をそのまま移設)。
    const events = readTailEvents(jsonlPath, 300);
    const recalled = findLastUserText(jsonlPath, mtimeMs);
    return { key: jsonlPath, mtimeMs, input: { events, recentUserText: recalled ?? undefined } };
  }
}

/**
 * 複数端末が同じ `projectDir` を push しても 1 カードに潰れないよう、`(clientId, projectDir)` を
 * 合成して URL 安全な entry id を作る。`store` の `sessionKey` と同じ「長さ接頭辞」方式なので、
 * clientId / projectDir にどんな文字が含まれても衝突せず、{@link parseRemoteEntryId} で復元できる。
 */
export function remoteEntryId(clientId: string, projectDir: string): string {
  return encodeId(`${clientId.length}:${clientId}:${projectDir}`);
}

/** {@link remoteEntryId} の逆変換。不正な id は null。 */
export function parseRemoteEntryId(id: string): { clientId: string; projectDir: string } | null {
  const raw = decodeId(id);
  if (!raw) return null;
  const colon = raw.indexOf(':');
  if (colon <= 0) return null;
  const len = Number(raw.slice(0, colon));
  if (!Number.isInteger(len) || len < 0) return null;
  const rest = raw.slice(colon + 1);
  // rest = `${clientId}${':'}${projectDir}` で clientId はちょうど len 文字。
  if (rest.length < len + 1 || rest[len] !== ':') return null;
  return { clientId: rest.slice(0, len), projectDir: rest.slice(len + 1) };
}

/** remote の Summarizer キャッシュキー。jsonlPath が無いので合成キーで代替する。 */
function remoteSummaryKey(clientId: string, projectDir: string, sessionId: string): string {
  return `remote:${clientId}|${projectDir}|${sessionId}`;
}

/**
 * `--mode server` 用。端末が push した集約ストア ({@link AggregateStore}) を読み、
 * `SnapshotEntry` を描画系が期待する `MonitorEntry` に変換して供給する。
 *
 * - jsonl を持たないため `transcript.jsonlPath` は空文字。詳細イベントは `readEvents` が store から返す。
 * - `process` は `entry.cwd` で cwd を補完して `ClaudeProcess` 形にする。
 * - id は `(clientId, projectDir)` 合成 ({@link remoteEntryId}) でマルチクライアント衝突を避ける。
 * - 時刻は `now` で注入 (テスト可能にするため内部で直接 `Date.now()` を呼ばない)。
 */
export class RemoteEntrySource implements EntrySource {
  private readonly store: AggregateStore;
  private readonly now: () => number;

  constructor(store: AggregateStore, opts: { now?: () => number } = {}) {
    this.store = store;
    this.now = opts.now ?? (() => Date.now());
  }

  async buildEntries(opts: BuildEntriesOptions = {}): Promise<MonitorEntry[]> {
    const sessions = this.store.listSessions(this.now());
    const entries = sessions.map(s => toMonitorEntry(s, opts.summarizer));
    entries.sort((a, b) => a.cwd.localeCompare(b.cwd));
    return entries;
  }

  readEvents(entry: MonitorEntry, limit: number): NormalizedEvent[] {
    const parsed = parseRemoteEntryId(entry.id);
    if (!parsed) return [];
    const events = this.store.getEventsBySession(parsed.clientId, parsed.projectDir, this.now());
    return limit > 0 && events.length > limit ? events.slice(-limit) : events;
  }

  summaryTargetOf(entry: MonitorEntry): SummaryTarget | null {
    const parsed = parseRemoteEntryId(entry.id);
    if (!parsed || !entry.transcript) return null;
    const events = this.store.getEventsBySession(parsed.clientId, parsed.projectDir, this.now());
    // jsonl が無いので findLastUserText は使えない。クライアントが算出済みの tail を流用する。
    const recentUserText = entry.tail?.lastUserText
      ? { text: entry.tail.lastUserText, at: entry.tail.lastUserAt ?? '' }
      : undefined;
    return {
      key: remoteSummaryKey(parsed.clientId, parsed.projectDir, entry.transcript.sessionId),
      mtimeMs: entry.transcript.mtimeMs,
      input: { events, recentUserText },
    };
  }
}

/** 集約ストアの 1 セッション (clientId 付き) を描画系の `MonitorEntry` に変換する。 */
function toMonitorEntry(
  session: RemoteSession,
  summarizer?: BuildEntriesOptions['summarizer'],
): MonitorEntry {
  const { clientId, projectDir, entry: e } = session;
  const transcript: TranscriptInfo | undefined = e.transcript
    ? {
        projectDir: e.transcript.projectDir,
        // remote は jsonl を読まない (readEvents が store から返す)。絶対パスは無意味かつ漏洩源なので空に。
        jsonlPath: e.transcript.jsonlPath ?? '',
        cwd: e.transcript.cwd,
        mtimeMs: e.transcript.mtimeMs,
        sessionId: e.transcript.sessionId,
      }
    : undefined;
  const process = e.process ? { pid: e.process.pid, cwd: e.cwd } : undefined;
  let summary: SummaryResult | undefined;
  if (summarizer && transcript) {
    summary = readSummaryStatus(
      summarizer,
      remoteSummaryKey(clientId, projectDir, transcript.sessionId),
      transcript.mtimeMs,
    );
  }
  return {
    id: remoteEntryId(clientId, projectDir),
    projectDir,
    cwd: e.cwd,
    process,
    transcript,
    lastActivityAt: e.lastActivityAt ?? undefined,
    tail: e.tail ?? undefined,
    state: e.state,
    summary,
  };
}
