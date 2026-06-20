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
  /** kind === 'system' のときの subtype (例: 'local_command')。state 判定で参照する。 */
  systemSubtype?: string;
  /**
   * kind === 'user-text' で、元データが AI 非介在のローカルコマンド由来か
   * (`<command-name>/clear</command-name>` や `<local-command-stdout>` の包み)。
   * `text` は {@link formatUserMessageForDisplay} で `/clear` 等へ整形済みなので、整形後の
   * 文字列からはコマンド痕跡を判別できない。発話 context ({@link extractWorkContext}) で
   * コマンド文字列やシェル出力を `userPrompt` に混入させないための判別フラグ。
   */
  isLocalCommand?: boolean;
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

/**
 * スラッシュコマンドを叩くと jsonl の user.content には
 *   "<command-name>/clear</command-name>\n<command-message>...</command-message>\n<command-args>...</command-args>"
 * のような XML 風の包みが書き出される。ダッシュボードでそのまま出すとノイズになるので
 * `/clear` / `/foo bar` のような表示用文字列に整形する。
 *
 * `! ...` でシェル実行したときは `<local-command-stdout>...</local-command-stdout>` だけが
 * user メッセージ (または system event) として書かれる。中身のみを取り出し、空なら
 * `(出力なし)` のプレースホルダを返す。
 *
 * 該当パターンに当たらない普通のテキストはそのまま返す。
 */
function formatUserMessageForDisplay(raw: string): string {
  const nameMatch = raw.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (nameMatch) {
    const name = nameMatch[1].trim();
    const argsMatch = raw.match(/<command-args>([\s\S]*?)<\/command-args>/);
    const args = argsMatch ? argsMatch[1].trim() : '';
    return args ? `${name} ${args}` : name;
  }
  const stdoutMatch = raw.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
  if (stdoutMatch) {
    const inner = stdoutMatch[1].trim();
    return inner.length > 0 ? inner : '(出力なし)';
  }
  return raw;
}

/**
 * user メッセージの **整形前 raw** が AI 非介在のローカルコマンド由来か
 * (`<command-name>...` のスラッシュコマンド包み / `<local-command-stdout>...` のシェル出力)。
 *
 * {@link formatUserMessageForDisplay} が `/clear` 等へ整形した後では判別できないため、
 * 整形と同じ raw を見てフラグ ({@link NormalizedEvent.isLocalCommand}) を立てるのに使う。
 */
function isLocalCommandRaw(raw: string): boolean {
  return /<command-name>[\s\S]*?<\/command-name>/.test(raw)
    || /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/.test(raw);
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
        out.push({ kind: 'user-text', timestamp, text: formatUserMessageForDisplay(content), isMeta, isLocalCommand: isLocalCommandRaw(content) });
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
              out.push({ kind: 'user-text', timestamp, text: formatUserMessageForDisplay(t), isMeta, isLocalCommand: isLocalCommandRaw(t) });
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
      const raw = typeof (obj as { content?: unknown }).content === 'string'
        ? ((obj as { content?: string }).content as string)
        : '';
      const subtype = typeof (obj as { subtype?: unknown }).subtype === 'string'
        ? ((obj as { subtype?: string }).subtype as string)
        : undefined;
      out.push({ kind: 'system', timestamp, text: formatUserMessageForDisplay(raw), systemSubtype: subtype });
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

/**
 * 末尾が未一致 tool_use のとき、そのツールが「ユーザー応答待ち」と見なせるツール名の集合。
 *
 * これらのツールは harness 側でユーザーに選択を促すため、tool_use が書かれた直後は
 * CLI 自体は何も処理せずユーザー入力を待っている。state 判定では AI処理中 ではなく
 * 待機中 に振り分けたい。
 */
const INTERACTIVE_TOOL_NAMES = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
]);

export interface TailSummary {
  /** 末尾に近い user-text (meta は除外)。無ければ undefined。 */
  lastUserText?: string;
  lastUserAt?: string;
  /** 末尾に近い assistant-text。無ければ undefined。 */
  lastAssistantText?: string;
  lastAssistantAt?: string;
  /** 末尾イベントの kind。デバッグ用。 */
  lastEventKind?: EventKind;
  /**
   * 末尾が未一致 tool_use で、ツール名が `INTERACTIVE_TOOL_NAMES` に含まれるか。
   * true のときは AI が処理中ではなくユーザー応答を待っている状態とみなす。
   */
  endsWithInteractiveToolUse: boolean;
  /**
   * 末尾が `system` kind の `local_command` subtype か (例: `/clear`, `! ls` 直後)。
   * AI 呼び出しを伴わないローカルコマンドで終わっている → state 判定で waiting 扱いにする。
   */
  endsWithLocalCommand: boolean;
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
  let endsWithInteractiveToolUse = false;
  let endsWithLocalCommand = false;
  if (events.length > 0) {
    const last = events[events.length - 1];
    lastEventKind = last.kind;
    if (last.kind === 'tool-use' && last.toolName && INTERACTIVE_TOOL_NAMES.has(last.toolName)) {
      // 末尾が対話ツールの tool_use なら定義上「対応する tool_result はまだ存在しない」
      // (応答済みなら tool_result が後ろに付くため末尾は別 kind)。したがってこの位置に
      // 居る限り pending とみなす。toolUseId 照合は冗長なので省略。
      endsWithInteractiveToolUse = true;
    }
    if (last.kind === 'system' && last.systemSubtype === 'local_command') {
      // `/clear` `/help` `! ls` 等、AI 呼び出しを伴わないローカルコマンド直後。
      // jsonl mtime は更新されるが実際は何も処理していないので waiting 扱いにしたい。
      endsWithLocalCommand = true;
    }
  }

  return {
    lastUserText,
    lastUserAt,
    lastAssistantText,
    lastAssistantAt,
    lastEventKind,
    endsWithInteractiveToolUse,
    endsWithLocalCommand,
  };
}

/** 2 人会話の素になる作業コンテキスト（ai-twitch-cast `TranscriptSummary` 相当）。 */
export interface WorkContext {
  /** ユーザーの最新の指示。 */
  userPrompt?: string;
  /** 実行されたアクションの説明文（順序保持・呼び出し側で末尾 N 件に絞る）。 */
  actions: string[];
  /** アシスタントのテキストメモ（10 字超のみ・順序保持）。 */
  notes: string[];
}

function toolUseBasename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * tool-use イベントを人間可読なアクション文に変換する。
 * `ev.text` は tool input の JSON 文字列（{@link readTailEvents} が格納）。
 * ai-twitch-cast `claude_watcher.py:_describe_tool_use` 移植。
 */
export function describeToolUse(ev: NormalizedEvent): string {
  const tool = ev.toolName ?? '';
  let input: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(ev.text || '{}');
    if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown>;
  } catch {
    /* 入力が JSON でなければ空扱い */
  }
  const str = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (tool) {
    case 'Bash':
      return `コマンド実行: ${str('command').slice(0, 80)}`;
    case 'Edit':
    case 'MultiEdit':
      return `ファイル編集: ${toolUseBasename(str('file_path'))}`;
    case 'Write':
      return `ファイル作成: ${toolUseBasename(str('file_path'))}`;
    case 'Read':
      return `ファイル読み取り: ${toolUseBasename(str('file_path'))}`;
    case 'Grep':
    case 'Glob':
      return `コード検索: ${str('pattern').slice(0, 50)}`;
    case 'Agent':
    case 'Task':
      return `サブエージェント: ${str('description').slice(0, 50)}`;
    default:
      return tool ? `${tool}を使用` : '';
  }
}

/**
 * 時系列イベント列から「ユーザー指示 / アクション列 / メモ」を抽出する純関数。
 * ai-twitch-cast `claude_watcher.py:TranscriptParser` 移植（差分追跡はせず、渡された窓全体を見る）。
 */
export function extractWorkContext(events: NormalizedEvent[]): WorkContext {
  let userPrompt: string | undefined;
  const actions: string[] = [];
  const notes: string[] = [];
  for (const ev of events) {
    if (ev.kind === 'user-text' && !ev.isMeta && !ev.isLocalCommand) {
      // ローカルコマンド (`/clear` `! ls` 等) は `isLocalCommand` で除外する。text は
      // 整形済み (`/clear` / シェル出力) で痕跡が消えているため、文字列の startsWith では
      // 判別できない (旧ガードは空振りしていた)。
      const t = ev.text?.trim();
      if (t) userPrompt = t;
    } else if (ev.kind === 'tool-use') {
      const a = describeToolUse(ev);
      if (a) actions.push(a);
    } else if (ev.kind === 'assistant-text') {
      const t = ev.text?.trim();
      if (t && t.length > 10) notes.push(t);
    }
  }
  return { userPrompt, actions, notes };
}

export interface LastUserTextRef {
  /** 表示用に整形済み (XML 包み剥がし / local-command-stdout 抽出済み) */
  text: string;
  /** jsonl の timestamp フィールド (ISO 文字列) */
  at: string;
}

interface LastUserTextCacheEntry {
  mtimeMs: number;
  value: LastUserTextRef | null;
}

// (jsonlPath, mtimeMs) で結果をキャッシュする。jsonl は append-only なので
// mtime 不変 = 直近 user-text も不変。サーバ再起動で揮発する前提。
const lastUserTextCache = new Map<string, LastUserTextCacheEntry>();

// 段階拡張で読むサイズ。最初の窓で当たれば I/O は 256KB で済む。
// 16MB まで読んでも user-text が無ければ「本当に入力なし」とみなす。
const FIND_USER_TEXT_SCAN_SIZES = [
  256 * 1024,
  1024 * 1024,
  4 * 1024 * 1024,
  16 * 1024 * 1024,
];

function parseUserTextFromLine(line: string): LastUserTextRef | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj.type !== 'user') return null;
  if (obj.isMeta === true) return null;
  const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp : '';
  if (!timestamp) return null;
  const msg = obj.message as { content?: unknown } | undefined;
  const content = msg?.content;
  if (typeof content === 'string') {
    return { text: formatUserMessageForDisplay(content), at: timestamp };
  }
  if (Array.isArray(content)) {
    // 1 行に複数 part がある場合は readTailEvents/summarizeTail と挙動を合わせ、
    // 末尾の text part を採用する (tool_result は無視 = Yes/No 承認は捨てる)。
    for (let i = content.length - 1; i >= 0; i--) {
      const item = content[i];
      if (!item || typeof item !== 'object') continue;
      const it = item as { type?: string; text?: string };
      if (it.type === 'text' && typeof it.text === 'string') {
        return { text: formatUserMessageForDisplay(it.text), at: timestamp };
      }
    }
  }
  return null;
}

/**
 * jsonl 末尾から逆順に走査し、直近の user-text (= ユーザーが打った発言) を 1 件返す。
 * Yes/No 承認 (= tool_result) や isMeta は飛ばす。見つからなければ null。
 *
 * `readTailEvents(50)` の窓を超えて user-text を遡及できるよう、256KB → 16MB と
 * 段階的に窓を拡げる。結果は (jsonlPath, mtimeMs) でメモする。
 *
 * 用途: state 判定 ({@link summarizeTail}) は触らず、ダッシュボード表示用に
 *   `lastUserText` が undefined だったときのフォールバックとして使う。
 */
export function findLastUserText(jsonlPath: string, mtimeMs: number): LastUserTextRef | null {
  const cached = lastUserTextCache.get(jsonlPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.value;

  let fileSize: number;
  try {
    fileSize = fs.statSync(jsonlPath).size;
  } catch {
    return null;
  }
  if (fileSize === 0) {
    lastUserTextCache.set(jsonlPath, { mtimeMs, value: null });
    return null;
  }

  for (const size of FIND_USER_TEXT_SCAN_SIZES) {
    let raw: string;
    try {
      raw = readTailBytes(jsonlPath, size);
    } catch {
      return null;
    }
    const lines = raw.split('\n');
    // tail バッファの先頭 1 行はオフセット途中切れの可能性があるので捨てる。
    // ただし窓がファイル全体を含むなら先頭から有効なので捨てない。
    const readingWholeFile = size >= fileSize;
    if (!readingWholeFile && lines.length > 1) lines.shift();

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      const parsed = parseUserTextFromLine(line);
      if (parsed) {
        lastUserTextCache.set(jsonlPath, { mtimeMs, value: parsed });
        return parsed;
      }
    }

    if (readingWholeFile) break; // 全体を読み終えたので拡張不要
  }

  lastUserTextCache.set(jsonlPath, { mtimeMs, value: null });
  return null;
}
