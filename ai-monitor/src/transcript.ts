import fs from 'fs';
import os from 'os';
import path from 'path';

export type EventKind =
  | 'user-text'
  | 'assistant-text'
  | 'tool-use'
  | 'tool-result'
  | 'system';

export interface NormalizedEvent {
  kind: EventKind;
  timestamp: string;
  // 表示用の本文 (短くトリミング済み、必要に応じて呼び出し側で再加工)
  text: string;
  // ツールイベントの場合に名前 / id を持つ
  toolName?: string;
  toolUseId?: string;
  isMeta?: boolean;
}

export interface TranscriptInfo {
  /** projects 配下のディレクトリ名 (例: "-home-ubuntu-foo") */
  projectDir: string;
  /** アクティブな jsonl の絶対パス */
  jsonlPath: string;
  /** jsonl から取り出した最新の cwd (絶対パス) */
  cwd: string;
  /** ファイル mtime (ms) */
  mtimeMs: number;
  /** セッション ID (= jsonl のファイル名) */
  sessionId: string;
}

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** 末尾だけを読みたいので最後の N バイトを読み出すヘルパ */
function readTailBytes(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const len = Math.min(maxBytes, size);
    const offset = size - len;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    return buf.toString('utf-8');
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** ディレクトリ内で mtime が最新の `.jsonl` を 1 本返す。なければ null。 */
function pickLatestJsonl(dir: string): { file: string; mtimeMs: number } | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { file: string; mtimeMs: number } | null = null;
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith('.jsonl')) continue;
    const abs = path.join(dir, e.name);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(abs).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtimeMs > best.mtimeMs) best = { file: abs, mtimeMs };
  }
  return best;
}

/** jsonl の末尾を読んで、最後に見つかった `cwd` を返す。 */
function extractCwd(jsonlPath: string): string | null {
  let raw: string;
  try {
    raw = readTailBytes(jsonlPath, 256 * 1024);
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  // 末尾から走査する。最初に書き出される最終行は途中で途切れることがあるので捨てる。
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as { cwd?: unknown };
      if (typeof obj.cwd === 'string' && obj.cwd.length > 0) return obj.cwd;
    } catch {
      // 壊れた行はスキップ
    }
  }
  return null;
}

/**
 * projects 配下のすべてのディレクトリについて「最新の jsonl + その cwd」を返す。
 * cwd が読み取れないディレクトリは無視する。
 */
export function listTranscripts(): TranscriptInfo[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch (err) {
    console.warn(`[ai-monitor] projects ディレクトリを開けません: ${PROJECTS_DIR}`, err);
    return [];
  }
  const results: TranscriptInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const projectDir = e.name;
    const absDir = path.join(PROJECTS_DIR, projectDir);
    const picked = pickLatestJsonl(absDir);
    if (!picked) continue;
    const cwd = extractCwd(picked.file);
    if (!cwd) continue;
    const sessionId = path.basename(picked.file, '.jsonl');
    results.push({
      projectDir,
      jsonlPath: picked.file,
      cwd,
      mtimeMs: picked.mtimeMs,
      sessionId,
    });
  }
  return results;
}

export function projectsDir(): string {
  return PROJECTS_DIR;
}

/**
 * cwd を Claude Code が `~/.claude/projects/` 配下に作るディレクトリ名 (= `projectDir`)
 * に変換する。観測上、claude CLI は cwd の非英数字を全て `-` に置換した名前で
 * `projects/<encoded>/...jsonl` を保存する。
 *
 * - `/home/ubuntu/foo` → `-home-ubuntu-foo`
 * - `/home/ubuntu/foo/.claude/worktrees/bar` → `-home-ubuntu-foo--claude-worktrees-bar`
 *
 * 元 cwd への逆変換は (元の `-` が `/` 由来か元から `-` だったか曖昧で) できない。
 * このプロジェクトでは「同じ CLI セッション (launch dir 由来) を一意に束ねる」用途で
 * 前方変換だけを使う。
 */
export function cwdToProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** message.content から表示用のテキストを 1 つ取り出す (短くトリミングは呼び出し側で行う)。 */
function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const it = item as { type?: string; text?: string };
          if (it.type === 'text' && typeof it.text === 'string') return it.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content);
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * jsonl の末尾 N 行を正規化イベントにして返す。壊れた行は捨てる。
 * `limit` 行に達するまで末尾から遡って蓄積し、最後に時系列昇順で返す。
 */
export function readTailEvents(jsonlPath: string, limit = 200): NormalizedEvent[] {
  // 末尾 N 行のサイズが読めるよう余裕を持って読む (1 行 ~ 数 KB 想定で 1MB)
  let raw: string;
  try {
    raw = readTailBytes(jsonlPath, 1024 * 1024);
  } catch (err) {
    console.warn(`[ai-monitor] jsonl 読み取りに失敗: ${jsonlPath}`, err);
    return [];
  }
  const lines = raw.split('\n');
  // tail 領域の先頭 1 行は途中切れの可能性が高いので捨てる
  if (lines.length > 1) lines.shift();

  const out: NormalizedEvent[] = [];
  for (const line of lines) {
    if (!line) continue;
    if (out.length >= limit * 4) break; // tool_use と tool_result でイベントは増えるので余裕を持つ
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp : '';
    if (!timestamp) continue;
    const type = obj.type;
    const isMeta = obj.isMeta === true;

    if (type === 'user') {
      const msg = obj.message as { content?: unknown } | undefined;
      const content = msg?.content;
      if (typeof content === 'string') {
        out.push({ kind: 'user-text', timestamp, text: content, isMeta });
      } else if (Array.isArray(content)) {
        for (const item of content) {
          if (!item || typeof item !== 'object') continue;
          const it = item as { type?: string; tool_use_id?: string; content?: unknown };
          if (it.type === 'tool_result') {
            out.push({
              kind: 'tool-result',
              timestamp,
              text: stringifyToolResultContent(it.content),
              toolUseId: it.tool_use_id,
            });
          } else if (it.type === 'text') {
            const t = (it as { text?: string }).text;
            if (typeof t === 'string') {
              out.push({ kind: 'user-text', timestamp, text: t, isMeta });
            }
          }
        }
      }
    } else if (type === 'assistant') {
      const msg = obj.message as { content?: unknown } | undefined;
      const content = msg?.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (!item || typeof item !== 'object') continue;
          const it = item as {
            type?: string;
            text?: string;
            name?: string;
            id?: string;
            input?: unknown;
          };
          if (it.type === 'text' && typeof it.text === 'string') {
            out.push({ kind: 'assistant-text', timestamp, text: it.text });
          } else if (it.type === 'tool_use') {
            let inputPreview = '';
            try {
              inputPreview = JSON.stringify(it.input ?? {});
            } catch {
              inputPreview = '';
            }
            out.push({
              kind: 'tool-use',
              timestamp,
              text: inputPreview,
              toolName: it.name,
              toolUseId: it.id,
            });
          }
          // "thinking" などは MVP では捨てる
        }
      }
    } else if (type === 'system') {
      const text = typeof (obj as { content?: unknown }).content === 'string'
        ? ((obj as { content?: string }).content as string)
        : '';
      out.push({ kind: 'system', timestamp, text });
    }
    // file-history-snapshot / attachment / ai-title / last-prompt は MVP では無視
  }

  // 時系列昇順 (古い → 新しい)
  out.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

  // 末尾 limit 件に揃える
  if (out.length > limit) return out.slice(out.length - limit);
  return out;
}

/** イベント配列の最後のタイムスタンプ (= 直近活動時刻) を返す。 */
export function lastTimestamp(events: NormalizedEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ts = events[i].timestamp;
    if (ts) return ts;
  }
  return null;
}

export interface TailSummary {
  /** 末尾に近い user-text (meta は除外)。無ければ undefined。 */
  lastUserText?: string;
  lastUserAt?: string;
  /** 末尾に近い assistant-text。無ければ undefined。 */
  lastAssistantText?: string;
  lastAssistantAt?: string;
  /** 末尾イベントの kind。state 判定 / デバッグ用。 */
  lastEventKind?: EventKind;
  /** 末尾が tool_use で、対応する tool_result が tail 内に無いか。エラー判定用。 */
  endsWithUnmatchedToolUse: boolean;
}

/**
 * 時系列昇順のイベント配列から、カード表示と state 判定に必要な要約を取り出す。
 *
 * - 最後の user-text / assistant-text の本文と時刻
 * - 末尾イベントの kind
 * - 末尾が tool_use で、その toolUseId に対応する tool_result が tail に存在しないか
 *   (= ターン途中で死んだ → 'error' 状態の判定材料)
 */
export function summarizeTail(events: NormalizedEvent[]): TailSummary {
  let lastUserText: string | undefined;
  let lastUserAt: string | undefined;
  let lastAssistantText: string | undefined;
  let lastAssistantAt: string | undefined;

  for (const ev of events) {
    if (ev.kind === 'user-text' && !ev.isMeta) {
      lastUserText = ev.text;
      lastUserAt = ev.timestamp;
    } else if (ev.kind === 'assistant-text') {
      lastAssistantText = ev.text;
      lastAssistantAt = ev.timestamp;
    }
  }

  let lastEventKind: EventKind | undefined;
  let endsWithUnmatchedToolUse = false;
  if (events.length > 0) {
    const last = events[events.length - 1];
    lastEventKind = last.kind;
    if (last.kind === 'tool-use') {
      const id = last.toolUseId;
      // toolUseId が無い tool_use は照合不能なので「未一致」扱い (安全側)
      if (!id) {
        endsWithUnmatchedToolUse = true;
      } else {
        const matched = events.some(e => e.kind === 'tool-result' && e.toolUseId === id);
        endsWithUnmatchedToolUse = !matched;
      }
    }
  }

  return {
    lastUserText,
    lastUserAt,
    lastAssistantText,
    lastAssistantAt,
    lastEventKind,
    endsWithUnmatchedToolUse,
  };
}
