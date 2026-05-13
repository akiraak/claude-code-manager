import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface ClaudeProcess {
  pid: number;
  cwd: string;
}

// `/proc/<PID>/comm` の中身が "claude" なら本物の CLI プロセスとして採用する。
// `cmdline` の argv[0] の basename が "claude" のケースも受け入れる
// (npm exec 経由などで comm が "node" になる可能性への保険)。
function isRealClaude(pid: number): boolean {
  try {
    const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
    if (comm === 'claude') return true;
  } catch {
    // 読めない PID は除外
  }
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`);
    const nul = cmdline.indexOf(0);
    const argv0 = nul === -1 ? cmdline.toString('utf-8') : cmdline.subarray(0, nul).toString('utf-8');
    if (argv0 && path.basename(argv0) === 'claude') return true;
  } catch {
    // 読めない PID は除外
  }
  return false;
}

function readCwd(pid: number): string | null {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

// `pgrep -af claude` で候補 PID を拾い、本物の claude プロセスに絞り込む。
export async function listClaudeProcesses(): Promise<ClaudeProcess[]> {
  const candidates = await enumerateClaudeProcessCandidates();
  return candidates
    .filter(c => c.accepted && c.cwd !== null)
    .map(c => ({ pid: c.pid, cwd: c.cwd as string }))
    .sort((a, b) => a.pid - b.pid);
}

/**
 * デバッグ用: `pgrep -af claude` の候補 PID ごとに採否と理由を返す。
 * Phase 1 の「停止表示の原因採取」用。判定ロジック自体は `listClaudeProcesses` と同じ
 * (内部で本関数を呼び出している)。
 */
export interface ClaudeProcessCandidate {
  pid: number;
  /** pgrep が出した行 (PID を除いた残り) */
  pgrepLine: string;
  comm: string | null;
  cmdlineArgv0: string | null;
  cwd: string | null;
  accepted: boolean;
  rejectReason: string | null;
}

export async function enumerateClaudeProcessCandidates(): Promise<ClaudeProcessCandidate[]> {
  let stdout = '';
  try {
    const r = await execFileAsync('pgrep', ['-af', 'claude']);
    stdout = r.stdout;
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string };
    if (typeof e.code === 'number' && e.code === 1) {
      return [];
    }
    throw err;
  }

  const selfPid = process.pid;
  const seen = new Set<number>();
  const out: ClaudeProcessCandidate[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (seen.has(pid)) continue;
    seen.add(pid);

    let comm: string | null = null;
    try { comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf-8').trim(); } catch { /* ignore */ }

    let argv0: string | null = null;
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`);
      const nul = cmdline.indexOf(0);
      argv0 = nul === -1 ? cmdline.toString('utf-8') : cmdline.subarray(0, nul).toString('utf-8');
    } catch { /* ignore */ }

    const cwd = readCwd(pid);
    const isClaude = isRealClaude(pid);

    let accepted = false;
    let reason: string | null = null;
    if (pid === selfPid) {
      reason = 'self (ai-monitor)';
    } else if (!isClaude) {
      reason = 'isRealClaude=false (comm/argv0 が claude でない)';
    } else if (!cwd) {
      reason = 'readCwd 失敗 (/proc/<pid>/cwd が読めない)';
    } else {
      accepted = true;
    }
    out.push({
      pid,
      pgrepLine: m[2] ?? '',
      comm,
      cmdlineArgv0: argv0,
      cwd,
      accepted,
      rejectReason: reason,
    });
  }
  out.sort((a, b) => a.pid - b.pid);
  return out;
}
