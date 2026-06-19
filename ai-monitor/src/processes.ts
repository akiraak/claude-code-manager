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
 * - macOS (darwin): `/proc` が無いため `ps` + `lsof` で実装する ({@link listClaudeProcessesDarwin})。
 */
export async function listClaudeProcesses(): Promise<ClaudeProcess[]> {
  if (process.platform === 'darwin') return listClaudeProcessesDarwin();
  return listClaudeProcessesLinux();
}

let warnedDarwin = false;

// darwin 経路の失敗 (ps/lsof の不在・権限不足・異常終了) は握って取れた範囲を返す。
// listClaudeProcesses はタイマーで繰り返し呼ばれるのでログ汚染を避け、1 回だけ warn する。
function warnDarwinOnce(msg: string, err: unknown): void {
  if (warnedDarwin) return;
  warnedDarwin = true;
  console.warn(`[ai-monitor] macOS process 検出: ${msg}`, err);
}

/**
 * `ps -axww -o pid=,comm=,command=` の出力から claude プロセスの PID を抽出する純関数。
 *
 * 判定は Linux の {@link isRealClaude} に揃える: `comm` の basename が `claude`、
 * **または** `command` (フル argv) の argv[0] basename が `claude`
 * (node/npm 経由で comm が node になり argv[0] が claude スクリプトを指すケースの保険)。
 * comm 列はパディングされるが空白で split すれば argv[0] が 2 番目のトークンになる。
 * claude の comm/argv[0] に空白は入らないため、素朴な split で取りこぼさない
 * (空白入りパスの無関係プロセスを誤分割しても basename が claude にならず除外される)。
 */
export function parsePsClaudePids(stdout: string, selfPid: number): number[] {
  const seen = new Set<number>();
  const pids: number[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (pid === selfPid) continue;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const tokens = m[2].split(/\s+/);
    const comm = tokens[0] ?? '';
    const argv0 = tokens[1] ?? '';
    const isClaude =
      (comm !== '' && path.basename(comm) === 'claude') ||
      (argv0 !== '' && path.basename(argv0) === 'claude');
    if (!isClaude) continue;
    pids.push(pid);
  }
  pids.sort((a, b) => a - b);
  return pids;
}

/**
 * `lsof -a -d cwd -p <pids> -Fpn` のフィールド出力から `Map<pid, cwd>` を作る純関数。
 *
 * フィールド出力は 1 行 1 フィールドで先頭文字がタグ: `p<pid>` / `n<path>`。
 * `-Fpn` を指定しても各ファイルの先頭に `fcwd` (fd) 行が入るが無視する。
 * `-d cwd` で cwd だけに絞っているので pid あたり `n` 行は 1 つ (最初の値を採用)。
 * cwd が取れなかった pid は map に入らない (= 呼び出し側で除外される)。
 */
export function parseLsofCwd(stdout: string): Map<number, string> {
  const map = new Map<number, string>();
  let pid: number | null = null;
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      const n = Number(value);
      pid = Number.isFinite(n) && n > 0 ? n : null;
    } else if (tag === 'n') {
      if (pid !== null && value !== '' && !map.has(pid)) {
        map.set(pid, value);
      }
    }
  }
  return map;
}

// `ps` で claude の候補 PID を拾い、`lsof` でまとめて cwd を引く (macOS / darwin)。
async function listClaudeProcessesDarwin(): Promise<ClaudeProcess[]> {
  let psOut = '';
  try {
    const r = await execFileAsync('ps', ['-axww', '-o', 'pid=,comm=,command=']);
    psOut = r.stdout;
  } catch (err: unknown) {
    warnDarwinOnce('ps の実行に失敗しました', err);
    return [];
  }

  const pids = parsePsClaudePids(psOut, process.pid);
  if (pids.length === 0) return [];

  // lsof は対象 pid のどれかが消えていたりすると exit code 1 を返すが、
  // 取れた分は stdout に入るので握って使う (1 回の呼び出しでバッチ取得)。
  let cwdByPid = new Map<number, string>();
  try {
    const r = await execFileAsync('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn']);
    cwdByPid = parseLsofCwd(r.stdout);
  } catch (err: unknown) {
    const e = err as { stdout?: string };
    if (typeof e.stdout === 'string' && e.stdout !== '') {
      cwdByPid = parseLsofCwd(e.stdout);
    } else {
      warnDarwinOnce('lsof の実行に失敗しました', err);
    }
  }

  const out: ClaudeProcess[] = [];
  for (const pid of pids) {
    const cwd = cwdByPid.get(pid);
    if (!cwd) continue;
    out.push({ pid, cwd });
  }
  out.sort((a, b) => a.pid - b.pid);
  return out;
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
