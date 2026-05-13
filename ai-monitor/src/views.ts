import type { ActivityState, MonitorEntry } from './state';
import { readTailEvents, type NormalizedEvent } from './transcript';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtRelativeTime(iso: string | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 0) return new Date(t).toLocaleString();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

const STATE_LABEL_JA: Record<ActivityState, string> = {
  'ai-processing': 'AI処理中',
  'waiting': '待機中',
  'stopped': '停止',
  'error': 'エラー',
};

const COMMON_STYLE = `
* { box-sizing: border-box; }
body {
  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  margin: 0;
  padding: 16px;
  color: #1a1a1a;
  background: #fafafa;
}
h1 { font-size: 18px; margin: 0 0 12px; }
.meta { color: #666; font-size: 12px; margin-bottom: 12px; }
.badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.badge-ai-processing { background: #e6f4ea; color: #1e7e34; }
.badge-waiting       { background: #e3f2fd; color: #1565c0; }
.badge-stopped       { background: #eceff1; color: #546e7a; }
.badge-error         { background: #fdecea; color: #b71c1c; }

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 12px;
}
.card {
  display: block;
  background: #fff;
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  padding: 12px 14px;
  text-decoration: none;
  color: inherit;
  transition: border-color 0.1s, box-shadow 0.1s;
}
.card:hover { border-color: #bbb; box-shadow: 0 2px 6px rgba(0,0,0,0.04); }
.card-state-error { border-color: #f5c6cb; }
.card-state-stopped { background: #fbfbfb; }
.card-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.card-cwd {
  font-weight: 600;
  font-size: 13px;
  word-break: break-all;
  flex: 1 1 auto;
  min-width: 0;
}
.card-meta { color: #666; font-size: 11px; white-space: nowrap; }
.card-summary {
  color: #555;
  font-size: 12px;
  margin-bottom: 8px;
  min-height: 0;
}
.card-summary:empty { display: none; }
.card-user, .card-assistant {
  border-top: 1px solid #f0f0f0;
  padding-top: 8px;
  margin-top: 6px;
}
.card-line-head { font-size: 11px; color: #666; margin-bottom: 2px; }
.card-line-body {
  font-size: 12px;
  color: #333;
  white-space: pre-wrap;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  max-height: 4.5em;
}
.card-line-body.empty { color: #aaa; }

table { width: 100%; border-collapse: collapse; font-size: 12px; background: #fff; }
th, td { padding: 6px 10px; border-bottom: 1px solid #eee; text-align: left; vertical-align: top; }
th { background: #f5f5f5; font-weight: 600; }
tr:hover td { background: #fafafa; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
pre { background: #f5f5f5; padding: 8px; border-radius: 4px; overflow-x: auto; max-height: 240px; }
.event {
  background: #fff;
  border: 1px solid #eee;
  border-radius: 6px;
  padding: 8px 12px;
  margin-bottom: 8px;
}
.event-head { font-size: 11px; color: #666; margin-bottom: 4px; display: flex; gap: 8px; align-items: center; }
.event-kind {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 600;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.kind-user-text       { background: #e3f2fd; color: #1565c0; }
.kind-assistant-text  { background: #f3e5f5; color: #6a1b9a; }
.kind-tool-use        { background: #fff3e0; color: #ef6c00; }
.kind-tool-result     { background: #f1f8e9; color: #558b2f; }
.kind-system          { background: #eceff1; color: #455a64; }
.event-body { white-space: pre-wrap; word-break: break-word; }
.event-body.collapsed { max-height: 6em; overflow: hidden; position: relative; }
.event-body.collapsed::after {
  content: ""; position: absolute; bottom: 0; left: 0; right: 0; height: 2em;
  background: linear-gradient(transparent, #fff);
}
details > summary { cursor: pointer; color: #1565c0; font-size: 11px; }
.empty { color: #999; padding: 20px; text-align: center; }
a { color: #1565c0; text-decoration: none; }
a:hover { text-decoration: underline; }
`;

function badge(state: ActivityState): string {
  return `<span class="badge badge-${state}">${STATE_LABEL_JA[state]}</span>`;
}

/** カード本文のプレビュー文字列を生成する。trim と末尾 … 付け。 */
function previewText(s: string | undefined, maxChars = 240): string {
  if (!s) return '';
  const cleaned = s.trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}…`;
}

function renderCardBody(entry: MonitorEntry): string {
  const tail = entry.tail;
  const userPreview = previewText(tail?.lastUserText);
  const assistantPreview = previewText(tail?.lastAssistantText);
  const userBody = userPreview
    ? `<div class="card-line-body">${escapeHtml(userPreview)}</div>`
    : `<div class="card-line-body empty">(まだユーザー入力がありません)</div>`;
  const assistantBody = assistantPreview
    ? `<div class="card-line-body">${escapeHtml(assistantPreview)}</div>`
    : `<div class="card-line-body empty">(まだ Claude の返信がありません)</div>`;
  return `
    <div class="card-summary"><!-- Phase 2/3 で AI 要約を挿入 --></div>
    <div class="card-user">
      <div class="card-line-head">👤 ユーザー (${escapeHtml(fmtRelativeTime(tail?.lastUserAt))})</div>
      ${userBody}
    </div>
    <div class="card-assistant">
      <div class="card-line-head">🤖 Claude (${escapeHtml(fmtRelativeTime(tail?.lastAssistantAt))})</div>
      ${assistantBody}
    </div>`;
}

function renderCard(entry: MonitorEntry): string {
  const href = `#ai-monitor/proc:${escapeHtml(entry.id)}`;
  const pid = entry.process?.pid;
  const pidPart = pid !== undefined ? `PID ${escapeHtml(String(pid))} · ` : '';
  const meta = `${pidPart}${escapeHtml(fmtRelativeTime(entry.lastActivityAt))}`;
  return `<a class="card card-state-${entry.state}" href="${href}" target="_top">
    <div class="card-header">
      ${badge(entry.state)}
      <span class="card-cwd">${escapeHtml(entry.cwd)}</span>
      <span class="card-meta">${meta}</span>
    </div>
    ${renderCardBody(entry)}
  </a>`;
}

export function renderDashboard(entries: MonitorEntry[]): string {
  const now = new Date().toISOString();
  const body = entries.length === 0
    ? `<div class="empty">稼働中の Claude Code CLI が見つかりません。</div>`
    : `<div class="cards">${entries.map(renderCard).join('\n')}</div>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>AI Monitor Dashboard</title>
<style>${COMMON_STYLE}</style></head>
<body>
  <h1>Dashboard</h1>
  <div class="meta">表示中 CLI: ${entries.length} 件 · 取得時刻: ${escapeHtml(now)}</div>
  ${body}
</body></html>`;
}

const MAX_INLINE_LEN = 800;

function renderEvent(ev: NormalizedEvent): string {
  const kindClass = `kind-${ev.kind}`;
  const head = ev.kind === 'tool-use'
    ? `<span class="event-kind ${kindClass}">tool_use</span> <span>${escapeHtml(ev.toolName ?? '')}</span>`
    : `<span class="event-kind ${kindClass}">${ev.kind}</span>`;
  const text = ev.text ?? '';
  const escaped = escapeHtml(text);
  const meta = ev.isMeta ? ' <span style="color:#aaa">(meta)</span>' : '';
  if (text.length <= MAX_INLINE_LEN) {
    return `<div class="event">
      <div class="event-head">${head}${meta}<span>${escapeHtml(ev.timestamp)}</span></div>
      <div class="event-body">${escaped}</div>
    </div>`;
  }
  const preview = escapeHtml(text.slice(0, MAX_INLINE_LEN));
  return `<div class="event">
    <div class="event-head">${head}${meta}<span>${escapeHtml(ev.timestamp)}</span></div>
    <div class="event-body collapsed">${preview}</div>
    <details><summary>全文を表示 (${text.length} 文字)</summary><pre>${escaped}</pre></details>
  </div>`;
}

const PROCESS_VIEW_SCRIPT = `
(function() {
  function scrollToBottom() {
    var h = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    window.scrollTo(0, h);
  }
  if (document.readyState === 'complete') {
    scrollToBottom();
  } else {
    window.addEventListener('load', scrollToBottom);
  }
})();
`;

export function renderProcessView(entry: MonitorEntry): string {
  const events = entry.transcript ? readTailEvents(entry.transcript.jsonlPath, 200) : [];
  const lastActivityLabel = entry.lastActivityAt
    ? `${entry.lastActivityAt} (${fmtRelativeTime(entry.lastActivityAt)})`
    : '—';
  const sessionId = entry.transcript?.sessionId ?? '—';
  const eventsHtml = events.length === 0
    ? `<div class="empty">表示できるイベントがありません (jsonl が無いか空)。</div>`
    : events.map(renderEvent).join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(entry.cwd)}</title>
<style>${COMMON_STYLE}</style></head>
<body>
  <h1>${escapeHtml(entry.cwd)}</h1>
  <div class="meta">
    PID: <code>${escapeHtml(String(entry.process?.pid ?? '—'))}</code>
    · ${badge(entry.state)}
    · 最終活動: ${escapeHtml(lastActivityLabel)}
    · session: <code>${escapeHtml(sessionId)}</code>
  </div>
  <div class="meta" style="color:#aaa">
    jsonl はターン完了時にしか書き出されないため、進行中ターンの本文はここには出ません。
  </div>
  ${eventsHtml}
  <script>${PROCESS_VIEW_SCRIPT}</script>
</body></html>`;
}

export function renderNotFound(message: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Not Found</title>
<style>${COMMON_STYLE}</style></head>
<body>
  <h1>表示できません</h1>
  <div class="meta">${escapeHtml(message)}</div>
</body></html>`;
}
