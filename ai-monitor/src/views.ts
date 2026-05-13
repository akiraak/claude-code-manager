import path from 'path';
import type { ActivityState, MonitorEntry } from './state';
import type { SummaryResult } from './summarize';
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

function fmtClockTime(iso: string | undefined): string {
  if (!iso) return '--:--:--';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '--:--:--';
  return new Date(t).toLocaleTimeString('ja-JP', { hour12: false });
}

const STATE_LABEL_JA: Record<ActivityState, string> = {
  'ai-processing': 'AI処理中',
  'awaiting-user': '入力待ち',
  'waiting': '待機中',
  'stopped': '停止',
};

const STATE_TOOLTIP_JA: Record<ActivityState, string> = {
  'ai-processing': 'CLI 生存 + 直近 30 秒以内に jsonl 更新あり (AI が応答生成中 / ツール実行中)',
  'awaiting-user': 'Yes/No 選択待ち (AskUserQuestion / ExitPlanMode が pending)',
  'waiting': 'CLI 生存 + 直近 30 秒以内に jsonl 更新なし (アイドル / 通常のターン終了)',
  'stopped': 'CLI 消滅 (10 分間だけ残る)',
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
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  cursor: help;
}
.badge::before {
  content: "";
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.badge-ai-processing { background: #d4edda; color: #1b6e3a; }
.badge-ai-processing::before { animation: badge-pulse 1.6s ease-in-out infinite; }
.badge-awaiting-user { background: #ffe0b2; color: #bf360c; }
.badge-awaiting-user::before { animation: badge-pulse 1.6s ease-in-out infinite; }
.badge-waiting       { background: #fff3cd; color: #8a6100; }
.badge-stopped       { background: #e1e4e8; color: #57606a; }
@keyframes badge-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

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
  transition: border-color 0.1s, box-shadow 0.1s;
}
.card:hover { border-color: #bbb; box-shadow: 0 2px 6px rgba(0,0,0,0.04); }
.card-link {
  display: block;
  text-decoration: none;
  color: inherit;
}
.card-link:hover { text-decoration: none; }
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
  color: #333;
  font-size: 12px;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  line-height: 1.5;
  border-top: 1px solid #f0f0f0;
  padding-top: 8px;
  margin-top: 6px;
}
.card-summary:empty { display: none; }
.card-summary-muted { color: #999; font-style: italic; }
.card-summary-pending { color: #888; }
.card-summary-icon { flex: 0 0 auto; }
.card-summary-text {
  flex: 1 1 auto;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.summarize-btn {
  display: inline-block;
  padding: 3px 10px;
  font-size: 12px;
  font-family: inherit;
  color: #1565c0;
  background: #fff;
  border: 1px solid #c5dafd;
  border-radius: 4px;
  cursor: pointer;
}
.summarize-btn:hover { background: #f1f7ff; border-color: #1565c0; }
.summarize-btn:disabled { color: #888; background: #f5f5f5; border-color: #ddd; cursor: default; }
.spinner {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 2px solid #ddd;
  border-top-color: #888;
  border-radius: 50%;
  animation: card-summary-spin 0.8s linear infinite;
  vertical-align: -1px;
  margin-right: 4px;
}
@keyframes card-summary-spin { to { transform: rotate(360deg); } }
.card-terminal {
  background: #1e1e1e;
  border-radius: 6px;
  padding: 10px 12px;
  margin-top: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: #d4d4d4;
}
.term-block + .term-block { margin-top: 8px; }
.term-line {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 11px;
  margin-bottom: 2px;
}
.term-marker { flex: 0 0 auto; }
.term-role { flex: 0 0 auto; font-weight: 600; letter-spacing: 0.5px; }
.term-time { margin-left: auto; color: #808080; font-size: 11px; }
.term-user .term-marker, .term-user .term-role { color: #4ec9b0; }
.term-assistant .term-marker, .term-assistant .term-role { color: #dcdcaa; }
.term-body {
  white-space: pre-wrap;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  padding-left: 14px;
  color: #d4d4d4;
}
.term-body.term-empty { color: #6a6a6a; font-style: italic; }

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
  const tip = STATE_TOOLTIP_JA[state];
  return `<span class="badge badge-${state}" title="${escapeHtml(tip)}">${STATE_LABEL_JA[state]}</span>`;
}

/** カード本文のプレビュー文字列を生成する。trim と末尾 … 付け。 */
function previewText(s: string | undefined, maxChars = 240): string {
  if (!s) return '';
  const cleaned = s.trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}…`;
}

function renderSummary(entry: MonitorEntry): string {
  const summary = entry.summary;
  if (!summary) return '';
  const itemId = `proc:${entry.id}`;
  if (summary.state === 'ok' && summary.text) {
    return `<div class="card-summary"><span class="card-summary-icon">📝</span><span class="card-summary-text">要約: ${escapeHtml(summary.text)}</span></div>`;
  }
  if (summary.state === 'pending') {
    return `<div class="card-summary card-summary-pending"><span class="spinner"></span><span class="card-summary-text">要約中…</span></div>`;
  }
  if (summary.state === 'unavailable') {
    return `<div class="card-summary card-summary-muted"><span class="card-summary-text">(要約: API キー未設定)</span></div>`;
  }
  if (summary.state === 'error') {
    return `<div class="card-summary card-summary-muted"><span class="card-summary-text">(要約失敗) — もう一度試す場合は再度ボタンを押してください</span></div>`;
  }
  if (summary.state === 'idle') {
    return `<div class="card-summary"><button type="button" class="summarize-btn" data-item-id="${escapeHtml(itemId)}">要約</button></div>`;
  }
  return '';
}

function renderCard(entry: MonitorEntry): string {
  const href = `#ai-monitor/proc:${escapeHtml(entry.id)}`;
  const pid = entry.process?.pid;
  const pidPart = pid !== undefined ? `PID ${escapeHtml(String(pid))} · ` : '';
  const meta = `${pidPart}${escapeHtml(fmtRelativeTime(entry.lastActivityAt))}`;
  const cwdShort = path.basename(entry.cwd) || entry.cwd;
  const tail = entry.tail;
  const userPreview = previewText(tail?.lastUserText);
  const assistantPreview = previewText(tail?.lastAssistantText);
  const userBody = userPreview
    ? `<div class="term-body">${escapeHtml(userPreview)}</div>`
    : `<div class="term-body term-empty">(まだユーザー入力がありません)</div>`;
  const assistantBody = assistantPreview
    ? `<div class="term-body">${escapeHtml(assistantPreview)}</div>`
    : `<div class="term-body term-empty">(まだ Claude の返信がありません)</div>`;
  return `<div class="card card-state-${entry.state}">
    <a class="card-link" href="${href}" target="_top" title="${escapeHtml(entry.cwd)}">
      <div class="card-header">
        ${badge(entry.state)}
        <span class="card-cwd">${escapeHtml(cwdShort)}</span>
        <span class="card-meta">${meta}</span>
      </div>
      <div class="card-terminal">
        <div class="term-block term-user">
          <div class="term-line">
            <span class="term-marker">▶</span>
            <span class="term-role">user</span>
            <span class="term-time">${escapeHtml(fmtClockTime(tail?.lastUserAt))}</span>
          </div>
          ${userBody}
        </div>
        <div class="term-block term-assistant">
          <div class="term-line">
            <span class="term-marker">▶</span>
            <span class="term-role">claude</span>
            <span class="term-time">${escapeHtml(fmtClockTime(tail?.lastAssistantAt))}</span>
          </div>
          ${assistantBody}
        </div>
      </div>
    </a>
    ${renderSummary(entry)}
  </div>`;
}

// 要約ボタン押下時のクライアント処理。
// POST /api/summarize 呼び出し → 即座にボタンを「要約中…」表示に切り替え、
// 完了通知は親 (vibeboard) 側で SSE → iframe reload に乗るのでここでは待たない。
const DASHBOARD_SCRIPT = `
(function() {
  document.addEventListener('click', function(ev) {
    var t = ev.target;
    if (!t || !t.classList || !t.classList.contains('summarize-btn')) return;
    ev.preventDefault();
    ev.stopPropagation();
    var id = t.getAttribute('data-item-id');
    if (!id) return;
    var wrap = t.parentNode;
    if (wrap) {
      wrap.className = 'card-summary card-summary-pending';
      wrap.innerHTML = '<span class="spinner"></span><span class="card-summary-text">要約中…</span>';
    }
    fetch('/api/summarize?id=' + encodeURIComponent(id), { method: 'POST' })
      .catch(function(err) {
        if (wrap) {
          wrap.className = 'card-summary card-summary-muted';
          wrap.innerHTML = '<span class="card-summary-text">(要約呼び出しに失敗)</span>';
        }
        console.warn('summarize failed', err);
      });
  });
})();
`;

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
  <script>${DASHBOARD_SCRIPT}</script>
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
  const cwdShort = path.basename(entry.cwd) || entry.cwd;
  const eventsHtml = events.length === 0
    ? `<div class="empty">表示できるイベントがありません (jsonl が無いか空)。</div>`
    : events.map(renderEvent).join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(cwdShort)}</title>
<style>${COMMON_STYLE}</style></head>
<body>
  <h1 title="${escapeHtml(entry.cwd)}">${escapeHtml(cwdShort)}</h1>
  <div class="meta">
    <code>${escapeHtml(entry.cwd)}</code>
  </div>
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
