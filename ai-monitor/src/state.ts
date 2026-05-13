import { listClaudeProcesses, type ClaudeProcess } from './processes';
import type { Summarizer, SummaryResult } from './summarize';
import {
  cwdToProjectDir,
  listTranscripts,
  readTailEvents,
  summarizeTail,
  type TailSummary,
  type TranscriptInfo,
} from './transcript';

/**
 * 「要約」を起動するためのボタンを出すかどうか / 現在の状態を返す。
 *
 * 自動では呼ばずに、UI の「要約」ボタン押下時にだけ計算するため、
 * ここでは `peek` と `isInflight` だけを覗いて idle/pending/cached を出し分ける。
 */
function readSummaryStatus(
  summarizer: Summarizer,
  jsonlPath: string,
  mtimeMs: number,
): SummaryResult {
  if (!summarizer.isEnabled()) return { state: 'unavailable' };
  const cached = summarizer.peek(jsonlPath, mtimeMs);
  if (cached) return cached;
  if (summarizer.isInflight(jsonlPath, mtimeMs)) return { state: 'pending' };
  return { state: 'idle' };
}

export type ActivityState = 'ai-processing' | 'awaiting-user' | 'waiting' | 'stopped';

/** プロセス消滅後もダッシュボードに残す保持時間 (秒)。これを超えた jsonl は表示から落とす。 */
export const STOPPED_RETENTION_SEC = 600;

/** ai-processing 判定で「最近 jsonl が動いた」とみなす閾値 (ms)。 */
const AI_PROCESSING_FRESH_MS = 30_000;

export interface MonitorEntry {
  /** 表示・URL 用 ID (projectDir を base64url 化したもの) */
  id: string;
  /** Claude が `~/.claude/projects/` 配下に作るディレクトリ名。1 セッションを一意に束ねるキー。 */
  projectDir: string;
  /**
   * 表示用の cwd。process 生存時は `/proc/<pid>/cwd` (= launch dir)、
   * 消滅時は transcript jsonl 内の最終 cwd (途中で `cd` していれば sub-dir のこともある)。
   */
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

/** 任意文字列 → URL 安全な ID。現在は projectDir を入力に取る運用 (cwd ではない)。 */
export function encodeId(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url');
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
  /** 末尾がユーザー応答待ちツール (AskUserQuestion / ExitPlanMode) の tool_use か */
  endsWithInteractiveToolUse: boolean;
}

/**
 * 4 状態 (ai-processing / awaiting-user / waiting / stopped) の判定。
 *
 * - プロセス生存:
 *   - 末尾が対話ツール (`AskUserQuestion` / `ExitPlanMode`) で未一致 → awaiting-user
 *   - jsonl が直近 30 秒以内に更新 → ai-processing
 *   - それ以外 → waiting
 * - プロセス消滅: stopped (STOPPED_RETENTION_SEC で表示から落とすのは buildEntries 側)
 *
 * 「死亡時にツール途中だったか」を旧 `error` で区別していたが、対話ツールの選択中に
 * `/exit` した場合と本物のクラッシュを区別できず偽陽性が出るため統合した。
 */
export function classifyV2(opts: ClassifyInput): ActivityState {
  if (!opts.hasProcess) return 'stopped';
  if (opts.endsWithInteractiveToolUse) return 'awaiting-user';
  const t = opts.lastActivityAt ? Date.parse(opts.lastActivityAt) : NaN;
  if (Number.isFinite(t) && Date.now() - t <= AI_PROCESSING_FRESH_MS) return 'ai-processing';
  return 'waiting';
}

/**
 * 稼働中の claude プロセスと jsonl を突き合わせて、UI に出すエントリ一覧を作る。
 *
 * プロセスと transcript の突き合わせは **projectDir** をキーに行う。理由は、
 * セッション開始後にユーザーが `cd` すると process cwd (= launch dir) と
 * jsonl 内 `cwd` フィールド (= 最終 cwd) がずれるため、cwd 完全一致だと
 * 同じ 1 セッションが「プロセスのみカード」「jsonl のみカード」の 2 枚に
 * 分裂してしまうことがあった (jsonl のみ側は「動作中なのに停止表示」になる)。
 *
 * - 「プロセスが居る projectDir」を起点に列挙 (cwd → projectDir 変換)
 * - プロセスが消えた projectDir も `STOPPED_RETENTION_SEC` 以内なら停止 / エラーとして残す
 * - 各 entry には末尾イベントの要約 (tail) を含める
 */
export async function buildEntries(opts: BuildEntriesOptions = {}): Promise<MonitorEntry[]> {
  const [processes, transcripts] = await Promise.all([
    listClaudeProcesses(),
    Promise.resolve(listTranscripts()),
  ]);

  // projectDir → transcript の Map (1 プロジェクト 1 トランスクリプト、mtime 最新を残す)
  const byProjectDir = new Map<string, TranscriptInfo>();
  for (const t of transcripts) {
    const cur = byProjectDir.get(t.projectDir);
    if (!cur || t.mtimeMs > cur.mtimeMs) byProjectDir.set(t.projectDir, t);
  }

  const summarizer = opts.summarizer;
  const entries: MonitorEntry[] = [];
  const seen = new Set<string>();

  // 1) プロセス起点: 生きている CLI (projectDir で dedup & 突合)
  for (const proc of processes) {
    const projectDir = cwdToProjectDir(proc.cwd);
    if (seen.has(projectDir)) continue;
    seen.add(projectDir);
    const ts = byProjectDir.get(projectDir);
    const events = ts ? readTailEvents(ts.jsonlPath, 50) : [];
    const tail = ts ? summarizeTail(events) : undefined;
    const lastActivityAt = ts ? new Date(ts.mtimeMs).toISOString() : undefined;
    const summary = ts && summarizer
      ? readSummaryStatus(summarizer, ts.jsonlPath, ts.mtimeMs)
      : undefined;
    entries.push({
      id: encodeId(projectDir),
      projectDir,
      cwd: proc.cwd,
      process: proc,
      transcript: ts,
      lastActivityAt,
      tail,
      state: classifyV2({
        hasProcess: true,
        lastActivityAt,
        endsWithInteractiveToolUse: tail?.endsWithInteractiveToolUse ?? false,
      }),
      summary,
    });
  }

  // 2) プロセスが居ない projectDir: 保持期間内なら stopped / error として残す
  const retentionCutoffMs = Date.now() - STOPPED_RETENTION_SEC * 1000;
  for (const ts of byProjectDir.values()) {
    if (seen.has(ts.projectDir)) continue;
    if (ts.mtimeMs < retentionCutoffMs) continue;
    seen.add(ts.projectDir);
    const events = readTailEvents(ts.jsonlPath, 50);
    const tail = summarizeTail(events);
    const lastActivityAt = new Date(ts.mtimeMs).toISOString();
    const summary = summarizer
      ? readSummaryStatus(summarizer, ts.jsonlPath, ts.mtimeMs)
      : undefined;
    entries.push({
      id: encodeId(ts.projectDir),
      projectDir: ts.projectDir,
      cwd: ts.cwd,
      transcript: ts,
      lastActivityAt,
      tail,
      state: classifyV2({
        hasProcess: false,
        lastActivityAt,
        endsWithInteractiveToolUse: tail.endsWithInteractiveToolUse,
      }),
      summary,
    });
  }

  // cwd でソート (見やすさのため)
  entries.sort((a, b) => a.cwd.localeCompare(b.cwd));
  return entries;
}
