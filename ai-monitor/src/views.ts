import type { MonitorEntry } from './state';
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
}
.badge-active { background: #e6f4ea; color: #1e7e34; }
.badge-recent { background: #fff4e5; color: #b86200; }
.badge-idle   { background: #eceff1; color: #546e7a; }
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

function badge(state: 'active' | 'recent' | 'idle'): string {
  const label = state.charAt(0).toUpperCase() + state.slice(1);
  return `<span class="badge badge-${state}">${label}</span>`;
}

function summarizeLastEvent(events: NormalizedEvent[]): string {
  if (events.length === 0) return '—';
  const last = events[events.length - 1];
  const trimmed = last.text.replace(/\s+/g, ' ').trim();
  const preview = trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
  const kindLabel = last.kind === 'tool-use' ? `[${last.toolName ?? 'tool'}]` : `[${last.kind}]`;
  return `${kindLabel} ${preview}`;
}

export function renderDashboard(entries: MonitorEntry[]): string {
  const now = new Date().toISOString();
  const rows = entries.map(e => {
    const events = e.transcript ? readTailEvents(e.transcript.jsonlPath, 50) : [];
    const last = summarizeLastEvent(events);
    return `<tr>
      <td><a href="#ai-monitor/proc:${escapeHtml(e.id)}" target="_top">${escapeHtml(e.cwd)}</a></td>
      <td><code>${escapeHtml(String(e.process?.pid ?? '—'))}</code></td>
      <td>${badge(e.state)}</td>
      <td>${escapeHtml(fmtRelativeTime(e.lastActivityAt))}</td>
      <td>${escapeHtml(last)}</td>
    </tr>`;
  }).join('\n');
  const body = entries.length === 0
    ? `<div class="empty">稼働中の Claude Code CLI が見つかりません。</div>`
    : `<table>
        <thead>
          <tr><th>cwd</th><th>PID</th><th>state</th><th>最終活動</th><th>直近イベント</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>AI Monitor Dashboard</title>
<style>${COMMON_STYLE}</style></head>
<body>
  <h1>Dashboard</h1>
  <div class="meta">稼働中 CLI: ${entries.length} 件 · 取得時刻: ${escapeHtml(now)}</div>
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
