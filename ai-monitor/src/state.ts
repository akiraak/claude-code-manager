import { listClaudeProcesses, type ClaudeProcess } from './processes';
import type { Summarizer, SummaryResult } from './summarize';
import {
  listTranscripts,
  readTailEvents,
  summarizeTail,
  type TailSummary,
  type TranscriptInfo,
} from './transcript';

export type ActivityState = 'ai-processing' | 'waiting' | 'stopped' | 'error';

/** プロセス消滅後もダッシュボードに残す保持時間 (秒)。これを超えた jsonl は表示から落とす。 */
export const STOPPED_RETENTION_SEC = 600;

/** ai-processing 判定で「最近 jsonl が動いた」とみなす閾値 (ms)。 */
const AI_PROCESSING_FRESH_MS = 30_000;

export interface MonitorEntry {
  /** 表示・URL 用 ID (cwd を base64url 化したもの) */
  id: string;
  cwd: string;
  process?: ClaudeProcess;
  transcript?: TranscriptInfo;
  /** 最後のターン時刻 (ISO 文字列)。jsonl が無い場合は undefined。 */
  lastActivityAt?: string;
  /** カード描画と state 判定に使うイベント要約。jsonl が無ければ undefined。 */
  tail?: TailSummary;
  /** activity 判定。プロセス生存有無と jsonl mtime / 末尾イベント種別から決まる。 */
  state: ActivityState;
  /** AI 要約結果。Summarizer 未提供時 / jsonl 無し時は undefined。 */
  summary?: SummaryResult;
}

export interface BuildEntriesOptions {
  /** 渡された場合、jsonl がある entry に getOrCompute の結果を summary としてセットする。 */
  summarizer?: Summarizer;
}

/** cwd → URL 安全な ID。decode 側は decodeId を使う。 */
export function encodeId(cwd: string): string {
  return Buffer.from(cwd, 'utf-8').toString('base64url');
}

export function decodeId(id: string): string | null {
  try {
    const s = Buffer.from(id, 'base64url').toString('utf-8');
    if (!s) return null;
    return s;
  } catch {
    return null;
  }
}

interface ClassifyInput {
  hasProcess: boolean;
  lastActivityAt?: string;
  endsWithUnmatchedToolUse: boolean;
}

/**
 * 新 4 状態 (ai-processing / waiting / stopped / error) の判定。
 *
 * - プロセス生存 → 直近 30 秒で jsonl が動いたなら ai-processing、それ以外は waiting
 * - プロセス消滅 → 末尾が未一致 tool_use なら error、それ以外は stopped
 *   (stopped はさらに STOPPED_RETENTION_SEC のフィルタを buildEntries 側で行う)
 */
export function classifyV2(opts: ClassifyInput): ActivityState {
  if (opts.hasProcess) {
    const t = opts.lastActivityAt ? Date.parse(opts.lastActivityAt) : NaN;
    if (Number.isFinite(t) && Date.now() - t <= AI_PROCESSING_FRESH_MS) return 'ai-processing';
    return 'waiting';
  }
  if (opts.endsWithUnmatchedToolUse) return 'error';
  return 'stopped';
}

/**
 * 稼働中の claude プロセスと jsonl を突き合わせて、UI に出すエントリ一覧を作る。
 * - 「プロセスが居る cwd」を起点に列挙
 * - プロセスが消えた transcript も `STOPPED_RETENTION_SEC` 以内なら停止 / エラーとして残す
 * - 各 entry には末尾イベントの要約 (tail) を含める
 */
export async function buildEntries(opts: BuildEntriesOptions = {}): Promise<MonitorEntry[]> {
  const [processes, transcripts] = await Promise.all([
    listClaudeProcesses(),
    Promise.resolve(listTranscripts()),
  ]);

  // cwd → transcript の Map (jsonl は cwd で逆引き)。同じ cwd が複数あれば mtime 最新を残す。
  const byCwd = new Map<string, TranscriptInfo>();
  for (const t of transcripts) {
    const cur = byCwd.get(t.cwd);
    if (!cur || t.mtimeMs > cur.mtimeMs) byCwd.set(t.cwd, t);
  }

  const summarizer = opts.summarizer;
  const entries: MonitorEntry[] = [];
  const seen = new Set<string>();

  // 1) プロセス起点: 生きている CLI
  for (const proc of processes) {
    if (seen.has(proc.cwd)) continue;
    seen.add(proc.cwd);
    const ts = byCwd.get(proc.cwd);
    const events = ts ? readTailEvents(ts.jsonlPath, 50) : [];
    const tail = ts ? summarizeTail(events) : undefined;
    const lastActivityAt = ts ? new Date(ts.mtimeMs).toISOString() : undefined;
    const summary = ts && summarizer
      ? summarizer.getOrCompute(ts.jsonlPath, ts.mtimeMs, events)
      : undefined;
    entries.push({
      id: encodeId(proc.cwd),
      cwd: proc.cwd,
      process: proc,
      transcript: ts,
      lastActivityAt,
      tail,
      state: classifyV2({
        hasProcess: true,
        lastActivityAt,
        endsWithUnmatchedToolUse: tail?.endsWithUnmatchedToolUse ?? false,
      }),
      summary,
    });
  }

  // 2) プロセスが居ない transcript: 保持期間内なら stopped / error として残す
  const retentionCutoffMs = Date.now() - STOPPED_RETENTION_SEC * 1000;
  for (const ts of byCwd.values()) {
    if (seen.has(ts.cwd)) continue;
    if (ts.mtimeMs < retentionCutoffMs) continue;
    seen.add(ts.cwd);
    const events = readTailEvents(ts.jsonlPath, 50);
    const tail = summarizeTail(events);
    const lastActivityAt = new Date(ts.mtimeMs).toISOString();
    const summary = summarizer
      ? summarizer.getOrCompute(ts.jsonlPath, ts.mtimeMs, events)
      : undefined;
    entries.push({
      id: encodeId(ts.cwd),
      cwd: ts.cwd,
      transcript: ts,
      lastActivityAt,
      tail,
      state: classifyV2({
        hasProcess: false,
        lastActivityAt,
        endsWithUnmatchedToolUse: tail.endsWithUnmatchedToolUse,
      }),
      summary,
    });
  }

  // cwd でソート (見やすさのため)
  entries.sort((a, b) => a.cwd.localeCompare(b.cwd));
  return entries;
}
