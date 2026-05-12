import { listClaudeProcesses, type ClaudeProcess } from './processes';
import { listTranscripts, type TranscriptInfo } from './transcript';

export type ActivityState = 'active' | 'recent' | 'idle';

export interface MonitorEntry {
  /** 表示・URL 用 ID (cwd を base64url 化したもの) */
  id: string;
  cwd: string;
  process?: ClaudeProcess;
  transcript?: TranscriptInfo;
  /** 最後のターン時刻 (ISO 文字列)。jsonl が無い場合は undefined。 */
  lastActivityAt?: string;
  /** activity 判定。プロセスが居なければ常に idle 扱い。 */
  state: ActivityState;
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

function classify(lastActivityAt: string | undefined, hasProcess: boolean): ActivityState {
  if (!lastActivityAt) return hasProcess ? 'idle' : 'idle';
  const t = Date.parse(lastActivityAt);
  if (!Number.isFinite(t)) return 'idle';
  const diff = Date.now() - t;
  if (diff <= 30_000) return 'active';
  if (diff <= 5 * 60_000) return 'recent';
  return 'idle';
}

/**
 * 稼働中の claude プロセスと jsonl を突き合わせて、UI に出すエントリ一覧を作る。
 * - 「プロセスが居る cwd」を主軸にする (= 生きてる CLI のみ表示)
 * - 同じ cwd の jsonl が無いプロセスは jsonl 無しエントリとして出す
 */
export async function buildEntries(): Promise<MonitorEntry[]> {
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

  const entries: MonitorEntry[] = [];
  const seen = new Set<string>();
  for (const proc of processes) {
    if (seen.has(proc.cwd)) continue;
    seen.add(proc.cwd);
    const ts = byCwd.get(proc.cwd);
    const lastActivityAt = ts ? new Date(ts.mtimeMs).toISOString() : undefined;
    entries.push({
      id: encodeId(proc.cwd),
      cwd: proc.cwd,
      process: proc,
      transcript: ts,
      lastActivityAt,
      state: classify(lastActivityAt, true),
    });
  }

  // cwd でソート (見やすさのため)
  entries.sort((a, b) => a.cwd.localeCompare(b.cwd));
  return entries;
}
