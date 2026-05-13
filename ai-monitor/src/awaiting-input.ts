import fs from 'fs';
import path from 'path';

/**
 * `~/.claude/hooks/ccm-awaiting-marker.py` が PermissionRequest 時に置く marker の格納先。
 *
 * marker は `<session_id>.json` 1 ファイル = 1 セッション。tool 完了 (PostToolUse) /
 * ターン終了 (Stop) で hook が削除する。AI Monitor 側は読み取りと stale 掃除のみ行う。
 */
export const AWAITING_INPUT_DIR = '/tmp/claude-code-manager/awaiting-input';

/** これより古い marker は stale とみなして物理削除する (hook 取りこぼし対策)。 */
const MARKER_MAX_AGE_MS = 60 * 60 * 1000;

export interface AwaitingMarker {
  sessionId: string;
  /** 権限プロンプトを出しているツール名 (例: "Bash")。表示用注釈に使う想定。 */
  toolName: string;
  /** hook が marker を書き出した時刻 (ISO)。 */
  createdAt: string;
}

/**
 * marker ディレクトリ (と親) を `mkdir -p` 相当で用意する。
 *
 * `fs.watch` は存在しないディレクトリを監視できないため、SSE watcher を張る前に
 * 一度呼んで取りこぼしを防ぐ。hook 側でも `os.makedirs(exist_ok=True)` するので
 * 競合しても害は無い。失敗しても黙って続行 (権限不足等)。
 */
export function ensureAwaitingInputDir(): void {
  try {
    fs.mkdirSync(AWAITING_INPUT_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

/**
 * marker ディレクトリの変化を監視して、変更があれば `onChange` を呼ぶ。
 *
 * 用途: SSE watcher の 2 秒ポーリングだけだと marker 作成/削除の反映に
 * 最大 2 秒のラグがあるため、`fs.watch` で即時トリガを足す。
 * watcher が張れない (FS が watch 非対応 等) 場合はポーリングへフォールバックする
 * ので、失敗は静かに飲み込む。
 *
 * 返り値の関数で watcher を閉じる。
 */
export function watchAwaitingInputMarkers(onChange: () => void): () => void {
  ensureAwaitingInputDir();
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(AWAITING_INPUT_DIR, { persistent: false }, () => {
      try { onChange(); } catch { /* ignore */ }
    });
    watcher.on('error', () => { /* ignore — fall back to polling */ });
  } catch {
    watcher = null;
  }
  return () => {
    if (watcher) {
      try { watcher.close(); } catch { /* ignore */ }
      watcher = null;
    }
  };
}

/**
 * marker ディレクトリを走査して `sessionId` → marker の Map を返す。
 *
 * - mtime が `MARKER_MAX_AGE_MS` を超えた marker は stale とみなし、物理削除して結果に含めない
 * - JSON パース失敗のファイルは無視 (書き込み中の race を踏むと一瞬空ファイルが見えうるため、
 *   stale 削除と違って物理削除はしない)
 * - ディレクトリ自体が無い場合は空 Map を返す (hook が一度も発火していない正常ケース)
 */
export function listAwaitingInputMarkers(): Map<string, AwaitingMarker> {
  const out = new Map<string, AwaitingMarker>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(AWAITING_INPUT_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  const cutoff = Date.now() - MARKER_MAX_AGE_MS;
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith('.json')) continue;
    if (e.name.startsWith('.')) continue; // write-rename 中の一時ファイル除け
    const abs = path.join(AWAITING_INPUT_DIR, e.name);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(abs).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs < cutoff) {
      try { fs.unlinkSync(abs); } catch { /* ignore */ }
      continue;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const m = parsed as Record<string, unknown>;
    const sessionId = typeof m.session_id === 'string' ? m.session_id : '';
    if (!sessionId) continue;
    out.set(sessionId, {
      sessionId,
      toolName: typeof m.tool_name === 'string' ? m.tool_name : '',
      createdAt: typeof m.created_at === 'string' ? m.created_at : '',
    });
  }
  return out;
}
