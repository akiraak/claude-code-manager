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

/**
 * 稼働中の claude CLI プロセスを列挙する。プラットフォームで実装を分ける。
 *
 * - Linux / WSL2: `pgrep -af` + `/proc/<pid>/{comm,cmdline,cwd}` ({@link listClaudeProcessesLinux})。
 * - macOS (darwin): `/proc` が無いため別実装が要る。現状は **スキャフォルドのみ**
 *   ({@link listClaudeProcessesDarwin} が空配列 + 1 回 warn)。`ps`+`lsof` ベースの実装は後追い
 *   (docs/plans/claude-progress-voice-phase4.md「7) processes.ts」)。
 */
export async function listClaudeProcesses(): Promise<ClaudeProcess[]> {
  if (process.platform === 'darwin') return listClaudeProcessesDarwin();
  return listClaudeProcessesLinux();
}

let warnedDarwinUnsupported = false;

/**
 * macOS の process 検出スキャフォルド。実機検証ができないため後追いとする
 * (ユーザー確定 2026-06-18: 今は WSL2 中心)。現状は空配列を返してクラッシュさせない
 * (Mac では jsonl 由来の stopped カードのみ表示される)。`ps -axww -o pid=,comm=` +
 * `lsof -a -d cwd -p <pid> -Fn` ベースの実装をここに埋める予定。
 */
async function listClaudeProcessesDarwin(): Promise<ClaudeProcess[]> {
  if (!warnedDarwinUnsupported) {
    warnedDarwinUnsupported = true;
    console.warn('[ai-monitor] macOS の process 検出は未実装です (後追い)。稼働中 CLI は検出されません');
  }
  return [];
}

// `pgrep -af claude` で候補 PID を拾い、本物の claude プロセスに絞り込む (Linux / WSL2)。
async function listClaudeProcessesLinux(): Promise<ClaudeProcess[]> {
  let stdout = '';
  try {
    const r = await execFileAsync('pgrep', ['-af', 'claude']);
    stdout = r.stdout;
  } catch (err: unknown) {
    const e = err as { code?: number };
    if (typeof e.code === 'number' && e.code === 1) {
      return [];
    }
    throw err;
  }

  const selfPid = process.pid;
  const seen = new Set<number>();
  const out: ClaudeProcess[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^(\d+)\s+/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (pid === selfPid) continue;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (!isRealClaude(pid)) continue;
    const cwd = readCwd(pid);
    if (!cwd) continue;
    out.push({ pid, cwd });
  }
  out.sort((a, b) => a.pid - b.pid);
  return out;
}
