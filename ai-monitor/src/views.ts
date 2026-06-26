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
  'stopped': 'CLI 消滅 (24 時間だけ残る)',
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
.card-client {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
  background: #eef1f4;
  color: #4a5568;
}
.card-client::before { content: "🖥"; font-size: 9px; }

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 12px;
}
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: #555;
  margin: 16px 0 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid #e5e5e5;
}
.section-title[data-section="running"] { margin-top: 0; }
.section-title [data-count] { color: #999; font-weight: 400; }
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
.card-summary-stale { color: #888; }
.card-summary-stale .card-summary-text { color: #888; }
.card-summary-icon { flex: 0 0 auto; }
.card-summary-content {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}
.card-summary-text {
  flex: 1 1 auto;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 6;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-summary.expanded .card-summary-text {
  -webkit-line-clamp: unset;
  display: block;
  overflow: visible;
}
.card-summary-actions {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.card-summary-toggle,
.summarize-btn-link {
  display: inline-block;
  padding: 0;
  margin: 0;
  font: inherit;
  font-size: 11px;
  color: #1565c0;
  background: none;
  border: none;
  cursor: pointer;
}
.card-summary-toggle:hover,
.summarize-btn-link:hover { text-decoration: underline; }
.card-summary-toggle[hidden] { display: none; }
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

// Phase 6: server モードのダッシュボードにだけ載せるボイスコントロール UI の CSS。
// local/client モードでは renderDashboard が voice パネルを出さないので注入もしない。
const VOICE_STYLE = `
.voice-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  margin-bottom: 12px;
  background: #fff;
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  font-size: 12px;
}
.voice-toggle {
  font: inherit;
  font-weight: 600;
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid #c5dafd;
  background: #f1f7ff;
  color: #1565c0;
  cursor: pointer;
}
.voice-toggle[aria-pressed="true"] { background: #1565c0; color: #fff; border-color: #1565c0; }
.voice-vol { display: inline-flex; align-items: center; gap: 6px; color: #555; }
.voice-vol input[type="range"] { width: 90px; }
.voice-vol-num { min-width: 3ch; text-align: right; font-variant-numeric: tabular-nums; color: #555; }
.voice-filters, .voice-client { display: inline-flex; align-items: center; gap: 8px; color: #555; }
.voice-filters label { display: inline-flex; align-items: center; gap: 3px; cursor: pointer; }
.voice-client select { font: inherit; font-size: 12px; }
.voice-sep { width: 1px; align-self: stretch; background: #eee; }
.voice-history-toggle { font: inherit; font-size: 12px; color: #1565c0; background: none; border: none; cursor: pointer; }
.voice-now {
  color: #1b6e3a;
  font-size: 11px;
  flex: 1 1 120px;
  min-width: 0;
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.voice-now:empty::before { content: "—"; color: #ccc; }
.voice-history {
  margin-bottom: 12px;
  background: #fff;
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  padding: 4px 0;
  max-height: 260px;
  overflow-y: auto;
}
.voice-history-empty { color: #999; padding: 10px 12px; }
.vh-row { display: flex; align-items: baseline; gap: 8px; padding: 5px 12px; border-bottom: 1px solid #f3f3f3; }
.vh-row:last-child { border-bottom: none; }
.vh-time { color: #999; font-size: 11px; font-variant-numeric: tabular-nums; flex: 0 0 auto; }
.vh-kind { flex: 0 0 auto; font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 3px; }
.vh-kind-completed { background: #d4edda; color: #1b6e3a; }
.vh-kind-awaiting  { background: #ffe0b2; color: #bf360c; }
.vh-kind-progress  { background: #e3f2fd; color: #1565c0; }
.vh-client { flex: 0 0 auto; color: #455a64; font-size: 10px; background: #eceff1; padding: 1px 6px; border-radius: 3px; }
.vh-proj { flex: 0 0 auto; color: #888; font-size: 11px; }
.vh-speaker { flex: 0 0 auto; font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 3px; }
.vh-speaker-teacher { background: #ede7f6; color: #5e35b1; }
.vh-speaker-student { background: #fff3e0; color: #ef6c00; }
.vh-emotion { flex: 0 0 auto; font-size: 10px; color: #9c27b0; }
.vh-text { flex: 1 1 auto; min-width: 0; word-break: break-word; }
.vh-play { flex: 0 0 auto; font: inherit; font-size: 11px; color: #1565c0; background: none; border: none; cursor: pointer; }
.vh-play:hover { text-decoration: underline; }
`;

/** カード本文のプレビュー文字列を生成する。trim と末尾 … 付け。 */
function previewText(s: string | undefined, maxChars = 240): string {
  if (!s) return '';
  const cleaned = s.trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}…`;
}

/**
 * ダッシュボード 1 カード分の表示データ。JSON シリアライズ可能。
 *
 * Phase 2 で `/api/dashboard.json` のレスポンス要素として使う想定。
 * 「クライアント側に重複ロジックを置かない」方針で、相対時刻 / 時計表示 /
 * プレビュー切り詰めはすべてサーバ側で整形して文字列で持つ。
 */
export interface DashboardCardData {
  /** entry.id (base64url 化した projectDir) */
  id: string;
  /** サイドバー / 詳細ビューと突き合わせる ID (`proc:<id>`) */
  itemId: string;
  /** vibeboard 親への遷移 hash (`ai-monitor/<encodeURIComponent(itemId)>`) */
  hashPath: string;
  /** title 属性に出すフル cwd */
  cwd: string;
  /** カードヘッダに出す basename (空なら cwd 全体) */
  cwdShort: string;
  state: ActivityState;
  stateLabel: string;
  stateTooltip: string;
  /** 送信元クライアントのラベル (server ミラーのみ。local/client では null = 非表示) */
  clientLabel: string | null;
  /** プロセス未生存時は null */
  pid: number | null;
  /** ISO 文字列。詳細表示やツールチップ用に raw も保持 (jsonl 無しなら null) */
  lastActivityAt: string | null;
  /** "3s ago" / "1m ago" / "—" の整形済み相対時刻 */
  lastActivityRel: string;
  /** カードヘッダ右端の "PID 12345 · 3s ago" など (null PID なら相対時刻のみ) */
  meta: string;
  tail: {
    /** 整形済みプレビュー (trim + 末尾 … 付け)。無ければ空文字 */
    lastUserText: string;
    /** "HH:MM:SS" 形式の時計表示。jsonl に user が無ければ "--:--:--" */
    lastUserAt: string;
    lastAssistantText: string;
    lastAssistantAt: string;
  };
  /** 要約の現在状態。Summarizer 未提供時 / jsonl 無し時は null */
  summary: SummaryResult | null;
}

/**
 * MonitorEntry → DashboardCardData の純関数変換。
 *
 * - サーバ側初回描画 (`renderDashboard`) と `/api/dashboard.json` で
 *   同じ整形ロジックを共有させるための切り出し。
 * - 時刻整形 (`fmtRelativeTime` / `fmtClockTime`) はここで吸収するので、
 *   呼び出し側 (HTML テンプレ / JSON シリアライズ) は escapeHtml だけ
 *   気にすれば良い。
 */
export function entryToDashboardCardData(entry: MonitorEntry): DashboardCardData {
  const itemId = `proc:${entry.id}`;
  const hashPath = `ai-monitor/${encodeURIComponent(itemId)}`;
  const cwdShort = path.basename(entry.cwd) || entry.cwd;
  const pid = entry.process?.pid ?? null;
  const lastActivityRel = fmtRelativeTime(entry.lastActivityAt);
  const meta = pid !== null
    ? `PID ${pid} · ${lastActivityRel}`
    : lastActivityRel;
  return {
    id: entry.id,
    itemId,
    hashPath,
    cwd: entry.cwd,
    cwdShort,
    state: entry.state,
    stateLabel: STATE_LABEL_JA[entry.state],
    stateTooltip: STATE_TOOLTIP_JA[entry.state],
    clientLabel: entry.clientId ?? null,
    pid,
    lastActivityAt: entry.lastActivityAt ?? null,
    lastActivityRel,
    meta,
    tail: {
      lastUserText: previewText(entry.tail?.lastUserText),
      lastUserAt: fmtClockTime(entry.tail?.lastUserAt),
      lastAssistantText: previewText(entry.tail?.lastAssistantText),
      lastAssistantAt: fmtClockTime(entry.tail?.lastAssistantAt),
    },
    summary: entry.summary ?? null,
  };
}

/**
 * 要約テキストの先頭 64 文字に対する FNV-1a 32bit ハッシュ。
 * `data-summary-key` 属性として DOM に乗せて、SSE で要約 HTML を置換した
 * あとも「テキストが変わっていなければ展開状態を維持する」突き合わせキーとして使う。
 * DASHBOARD_LIVE_SCRIPT 内の同名関数と完全に同じ計算で揃えること。
 */
function summaryHashKey(text: string): string {
  const prefix = text.slice(0, 64);
  let h = 0x811c9dc5;
  for (let i = 0; i < prefix.length; i++) {
    h ^= prefix.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

function renderSummaryFromData(data: DashboardCardData): string {
  const summary = data.summary;
  if (!summary) return '';
  if (summary.state === 'ok' && summary.text) {
    const key = summaryHashKey(summary.text);
    const staleClass = summary.stale ? ' card-summary-stale' : '';
    const label = summary.stale ? '要約 (古い): ' : '要約: ';
    return `<div class="card-summary${staleClass}" data-collapsible data-summary-key="${escapeHtml(key)}">`
      + `<span class="card-summary-icon">📝</span>`
      + `<div class="card-summary-content">`
      + `<span class="card-summary-text">${label}${escapeHtml(summary.text)}</span>`
      + `<div class="card-summary-actions">`
      + `<button type="button" class="card-summary-toggle" data-summary-toggle hidden>展開</button>`
      + `<button type="button" class="summarize-btn-link" data-item-id="${escapeHtml(data.itemId)}" data-force="1">再要約</button>`
      + `</div>`
      + `</div>`
      + `</div>`;
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
    return `<div class="card-summary"><button type="button" class="summarize-btn" data-item-id="${escapeHtml(data.itemId)}">要約</button></div>`;
  }
  return '';
}

function renderCardFromData(data: DashboardCardData): string {
  // vibeboard 側の hash 形式に合わせる: `#<tab-name>/<encodeURIComponent(item-id)>`
  // 直接 `target="_top"` でフラグメント遷移すると iframe のオリジン (8181) で
  // 解決されてしまい vibeboard の枠を破ってしまうため、クリック時に
  // postMessage で親へ遷移を依頼する (DASHBOARD_SCRIPT 参照)。
  // `data-card-id` は Phase 2 の DOM 差分パッチで「同じ ID は使い回す」突き合わせキー。
  const href = `#${escapeHtml(data.hashPath)}`;
  const userBody = data.tail.lastUserText
    ? `<div class="term-body">${escapeHtml(data.tail.lastUserText)}</div>`
    : `<div class="term-body term-empty">(まだユーザー入力がありません)</div>`;
  const assistantBody = data.tail.lastAssistantText
    ? `<div class="term-body">${escapeHtml(data.tail.lastAssistantText)}</div>`
    : `<div class="term-body term-empty">(まだ Claude の返信がありません)</div>`;
  return `<div class="card card-state-${data.state}" data-card-id="${escapeHtml(data.itemId)}">
    <a class="card-link" href="${href}" data-hash="${escapeHtml(data.hashPath)}" title="${escapeHtml(data.cwd)}">
      <div class="card-header">
        <span class="badge badge-${data.state}" title="${escapeHtml(data.stateTooltip)}">${escapeHtml(data.stateLabel)}</span>
        ${data.clientLabel ? `<span class="card-client" title="送信元クライアント">${escapeHtml(data.clientLabel)}</span>` : ''}
        <span class="card-cwd">${escapeHtml(data.cwdShort)}</span>
        <span class="card-meta">${escapeHtml(data.meta)}</span>
      </div>
      <div class="card-terminal">
        <div class="term-block term-user">
          <div class="term-line">
            <span class="term-marker">▶</span>
            <span class="term-role">user</span>
            <span class="term-time">${escapeHtml(data.tail.lastUserAt)}</span>
          </div>
          ${userBody}
        </div>
        <div class="term-block term-assistant">
          <div class="term-line">
            <span class="term-marker">▶</span>
            <span class="term-role">claude</span>
            <span class="term-time">${escapeHtml(data.tail.lastAssistantAt)}</span>
          </div>
          ${assistantBody}
        </div>
      </div>
    </a>
    ${renderSummaryFromData(data)}
  </div>`;
}

// 要約ボタン押下時のクライアント処理 + カードクリック時の親遷移。
//
// - 要約ボタン: POST /api/summarize 呼び出し → 即座にボタンを「要約中…」表示に切り替え、
//   完了通知は親 (vibeboard) 側で SSE → iframe reload に乗るのでここでは待たない。
// - カードリンク: 直接 `target="_top"` でフラグメント遷移すると iframe のオリジン
//   (127.0.0.1:8181) で URL が解決されてしまい vibeboard (8180) の枠を破る。
//   そのため `parent.postMessage({ type: 'vb-nav', hash })` で親に遷移を依頼する。
const DASHBOARD_SCRIPT = `
(function() {
  function navigateTopHash(hash) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'vb-nav', hash: hash }, '*');
        return;
      }
    } catch (e) { /* fall through to local hash navigation */ }
    window.location.hash = hash;
  }

  document.addEventListener('click', function(ev) {
    var t = ev.target;
    if (!t) return;

    // 要約トグル ([data-summary-toggle]) → 折りたたみ / 展開切替
    // .card-summary は <a class="card-link"> の外なので navigateTopHash は呼ばれないが、
    // 念のため preventDefault / stopPropagation で握りつぶす。
    var toggle = t.closest ? t.closest('[data-summary-toggle]') : null;
    if (toggle) {
      ev.preventDefault();
      ev.stopPropagation();
      var wrap = toggle.closest('.card-summary');
      if (!wrap) return;
      var nowExpanded = !wrap.classList.contains('expanded');
      wrap.classList.toggle('expanded', nowExpanded);
      toggle.textContent = nowExpanded ? '折りたたむ' : '展開';
      return;
    }

    // カードリンク (a.card-link) クリック → 親 vibeboard に遷移を依頼
    var link = t.closest ? t.closest('.card-link') : null;
    if (link) {
      // 中クリック / Ctrl+クリックでは新規タブで開きたいので素通り
      if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      var hash = link.getAttribute('data-hash');
      if (!hash) return;
      ev.preventDefault();
      navigateTopHash(hash);
      return;
    }

    // 要約ボタン (idle 状態の大ボタン .summarize-btn / OK 状態のインライン .summarize-btn-link)
    // - data-force="1" が付いていれば force=1 を付ける (キャッシュ無視で再要約)
    // - ボタンの親 .card-summary 全体を「要約中…」表示に差し替える
    //   (OK ブランチではボタンが card-summary-content の中なので、wrap は card-summary を辿る)
    var btn = t.closest ? t.closest('.summarize-btn, .summarize-btn-link') : null;
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    var id = btn.getAttribute('data-item-id');
    if (!id) return;
    var force = btn.getAttribute('data-force') === '1';
    var wrap = btn.closest('.card-summary');
    if (wrap) {
      wrap.className = 'card-summary card-summary-pending';
      wrap.innerHTML = '<span class="spinner"></span><span class="card-summary-text">要約中…</span>';
    }
    var url = '/api/summarize?id=' + encodeURIComponent(id) + (force ? '&force=1' : '');
    fetch(url, { method: 'POST' })
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

// Phase 2: ダッシュボード iframe を「自己更新」型にする。
//
// 旧実装は親 vibeboard が SSE を受けるたびに iframe.src を差し替えて
// 全体を再ロードしていたため、白フラッシュ + 再レイアウト + バッジ脈動の
// 先頭リセット が起きていた。本スクリプトは iframe 内で直接
// `/api/watch` を購読し、変化があったら `/api/dashboard.json` を fetch して
// カード単位に DOM をパッチする。これにより:
//   - 変更のないカードは DOM が触られず一切ちらつかない
//   - `@keyframes badge-pulse` も DOM が残るので再生位置がリセットされない
//   - 初回 HTML はサーバ側で完全に描画済みなので、JS なし / SSE 未接続でも
//     カードは見える (FOUC 防止)
//
// サーバ側 (`renderCardFromData`) と HTML を一致させる必要があるので、
// レンダリング系の文字列は両方を意識してメンテナンスする。
const DASHBOARD_LIVE_SCRIPT = `
(function() {
  var es = null;
  var fetchTimer = null;
  var fetchInflight = false;
  var fetchAgain = false;

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // サーバ側 summaryHashKey と完全一致させる FNV-1a 32bit。先頭 64 文字。
  function summaryHashKey(text) {
    var prefix = String(text || '').slice(0, 64);
    var h = 0x811c9dc5;
    for (var i = 0; i < prefix.length; i++) {
      h ^= prefix.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16);
  }

  // line-clamp で本当に切られているかを判定し、トグルボタンの hidden を切り替える。
  // 「展開済み」のときは clamp 解除されているので scrollHeight==clientHeight になるが、
  // ユーザーが意図的に開いた状態なのでボタンは出しておく。
  function evalSummaryOverflow(wrap) {
    if (!wrap || !wrap.hasAttribute('data-collapsible')) return;
    var text = wrap.querySelector('.card-summary-text');
    var btn = wrap.querySelector('[data-summary-toggle]');
    if (!text || !btn) return;
    if (wrap.classList.contains('expanded')) {
      btn.hidden = false;
      return;
    }
    btn.hidden = text.scrollHeight <= text.clientHeight + 1;
  }

  function evalAllSummaries() {
    var wraps = document.querySelectorAll('.card-summary[data-collapsible]');
    for (var i = 0; i < wraps.length; i++) evalSummaryOverflow(wraps[i]);
  }

  // --- summary 部の HTML 構築 (サーバ側 renderSummaryFromData と一致させる) ---
  function renderSummary(data) {
    var s = data.summary;
    if (!s) return '';
    if (s.state === 'ok' && s.text) {
      var key = summaryHashKey(s.text);
      var staleClass = s.stale ? ' card-summary-stale' : '';
      var label = s.stale ? '要約 (古い): ' : '要約: ';
      return '<div class="card-summary' + staleClass + '" data-collapsible data-summary-key="' + esc(key) + '">'
        + '<span class="card-summary-icon">📝</span>'
        + '<div class="card-summary-content">'
        + '<span class="card-summary-text">' + label + esc(s.text) + '</span>'
        + '<div class="card-summary-actions">'
        + '<button type="button" class="card-summary-toggle" data-summary-toggle hidden>展開</button>'
        + '<button type="button" class="summarize-btn-link" data-item-id="' + esc(data.itemId) + '" data-force="1">再要約</button>'
        + '</div>'
        + '</div>'
        + '</div>';
    }
    if (s.state === 'pending') {
      return '<div class="card-summary card-summary-pending"><span class="spinner"></span><span class="card-summary-text">要約中…</span></div>';
    }
    if (s.state === 'unavailable') {
      return '<div class="card-summary card-summary-muted"><span class="card-summary-text">(要約: API キー未設定)</span></div>';
    }
    if (s.state === 'error') {
      return '<div class="card-summary card-summary-muted"><span class="card-summary-text">(要約失敗) — もう一度試す場合は再度ボタンを押してください</span></div>';
    }
    if (s.state === 'idle') {
      return '<div class="card-summary"><button type="button" class="summarize-btn" data-item-id="' + esc(data.itemId) + '">要約</button></div>';
    }
    return '';
  }

  // --- 新規追加カード用の innerHTML 構築 (renderCardFromData と一致) ---
  function renderCardInner(data) {
    var href = '#' + esc(data.hashPath);
    var userBody = data.tail.lastUserText
      ? '<div class="term-body">' + esc(data.tail.lastUserText) + '</div>'
      : '<div class="term-body term-empty">(まだユーザー入力がありません)</div>';
    var assistantBody = data.tail.lastAssistantText
      ? '<div class="term-body">' + esc(data.tail.lastAssistantText) + '</div>'
      : '<div class="term-body term-empty">(まだ Claude の返信がありません)</div>';
    return ''
      + '<a class="card-link" href="' + href + '" data-hash="' + esc(data.hashPath) + '" title="' + esc(data.cwd) + '">'
      +   '<div class="card-header">'
      +     '<span class="badge badge-' + esc(data.state) + '" title="' + esc(data.stateTooltip) + '">' + esc(data.stateLabel) + '</span>'
      +     (data.clientLabel ? '<span class="card-client" title="送信元クライアント">' + esc(data.clientLabel) + '</span>' : '')
      +     '<span class="card-cwd">' + esc(data.cwdShort) + '</span>'
      +     '<span class="card-meta">' + esc(data.meta) + '</span>'
      +   '</div>'
      +   '<div class="card-terminal">'
      +     '<div class="term-block term-user">'
      +       '<div class="term-line">'
      +         '<span class="term-marker">▶</span>'
      +         '<span class="term-role">user</span>'
      +         '<span class="term-time">' + esc(data.tail.lastUserAt) + '</span>'
      +       '</div>'
      +       userBody
      +     '</div>'
      +     '<div class="term-block term-assistant">'
      +       '<div class="term-line">'
      +         '<span class="term-marker">▶</span>'
      +         '<span class="term-role">claude</span>'
      +         '<span class="term-time">' + esc(data.tail.lastAssistantAt) + '</span>'
      +       '</div>'
      +       assistantBody
      +     '</div>'
      +   '</div>'
      + '</a>'
      + renderSummary(data);
  }

  function createCard(data) {
    var card = document.createElement('div');
    card.className = 'card card-state-' + data.state;
    card.setAttribute('data-card-id', data.itemId);
    card.innerHTML = renderCardInner(data);
    return card;
  }

  // クラス名の prefix 一致するものを全部剥がして newClass だけ付け直す。
  // 既に該当クラスだけ付いている場合は touch しない (アニメーション再生防止)。
  function swapPrefixClass(el, prefix, newClass) {
    if (!el) return;
    if (el.classList.contains(newClass)) {
      // 余計な prefix クラスが残っていないか確認
      var hasExtra = false;
      for (var i = 0; i < el.classList.length; i++) {
        var c = el.classList[i];
        if (c.indexOf(prefix) === 0 && c !== newClass) { hasExtra = true; break; }
      }
      if (!hasExtra) return;
    }
    var toRemove = [];
    for (var j = 0; j < el.classList.length; j++) {
      var cc = el.classList[j];
      if (cc.indexOf(prefix) === 0) toRemove.push(cc);
    }
    for (var k = 0; k < toRemove.length; k++) el.classList.remove(toRemove[k]);
    el.classList.add(newClass);
  }

  function setText(el, text) {
    if (!el) return;
    if (el.textContent !== text) el.textContent = text;
  }

  function setAttr(el, name, value) {
    if (!el) return;
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  function setTermBody(card, blockSel, text, emptyText) {
    var body = card.querySelector(blockSel + ' .term-body');
    if (!body) return;
    if (text) {
      if (body.classList.contains('term-empty')) body.classList.remove('term-empty');
      setText(body, text);
    } else {
      if (!body.classList.contains('term-empty')) body.classList.add('term-empty');
      setText(body, emptyText);
    }
  }

  function updateCard(card, data) {
    swapPrefixClass(card, 'card-state-', 'card-state-' + data.state);

    var badge = card.querySelector('.card-header .badge');
    swapPrefixClass(badge, 'badge-', 'badge-' + data.state);
    setText(badge, data.stateLabel);
    setAttr(badge, 'title', data.stateTooltip);

    // 送信元クライアントのチップ (server ミラーのみ。バッジ直後に表示)
    var clientEl = card.querySelector('.card-header .card-client');
    if (data.clientLabel) {
      if (!clientEl) {
        if (badge) badge.insertAdjacentHTML('afterend', '<span class="card-client" title="送信元クライアント">' + esc(data.clientLabel) + '</span>');
      } else {
        setText(clientEl, data.clientLabel);
      }
    } else if (clientEl) {
      clientEl.remove();
    }

    var link = card.querySelector('.card-link');
    if (link) {
      setAttr(link, 'href', '#' + data.hashPath);
      setAttr(link, 'data-hash', data.hashPath);
      setAttr(link, 'title', data.cwd);
    }

    setText(card.querySelector('.card-cwd'), data.cwdShort);
    setText(card.querySelector('.card-meta'), data.meta);
    setText(card.querySelector('.term-user .term-time'), data.tail.lastUserAt);
    setText(card.querySelector('.term-assistant .term-time'), data.tail.lastAssistantAt);
    setTermBody(card, '.term-user', data.tail.lastUserText, '(まだユーザー入力がありません)');
    setTermBody(card, '.term-assistant', data.tail.lastAssistantText, '(まだ Claude の返信がありません)');

    // 要約ブロックは状態ごとに DOM 構造が変わるので、生成済み HTML 同士を
    // 比較し、差分があれば差し替える。同じなら触らない (spinner / pulse の
    // アニメーション継続性のため)。
    //
    // 置換時は「同じ要約テキスト (= data-summary-key 一致) なら展開状態を維持」
    // ロジックを通す。テキストが変わった (≒ jsonl 更新で再計算された) ときは
    // 折りたたみから読み直してほしいので復元しない。
    var oldSummary = card.querySelector('.card-summary');
    var oldKey = oldSummary ? oldSummary.getAttribute('data-summary-key') : null;
    var wasExpanded = !!(oldSummary && oldSummary.classList.contains('expanded'));
    var newHTML = renderSummary(data);
    // expanded クラスは DOM 側だけにある状態なので、比較前に剥がしてから outerHTML を取る。
    var oldHTML = '';
    if (oldSummary) {
      var hadExpanded = oldSummary.classList.contains('expanded');
      if (hadExpanded) oldSummary.classList.remove('expanded');
      oldHTML = oldSummary.outerHTML;
      if (hadExpanded) oldSummary.classList.add('expanded');
    }
    if (newHTML !== oldHTML) {
      if (oldSummary) oldSummary.remove();
      if (newHTML) card.insertAdjacentHTML('beforeend', newHTML);
      var freshSummary = card.querySelector('.card-summary');
      if (freshSummary && freshSummary.hasAttribute('data-collapsible')) {
        var newKey = freshSummary.getAttribute('data-summary-key');
        if (wasExpanded && oldKey && newKey === oldKey) {
          freshSummary.classList.add('expanded');
          var t = freshSummary.querySelector('[data-summary-toggle]');
          if (t) t.textContent = '折りたたむ';
        }
        evalSummaryOverflow(freshSummary);
      }
    } else if (oldSummary && oldSummary.hasAttribute('data-collapsible')) {
      // テキストは同じだが、レイアウト変化でクランプ状況が変わっている可能性がある。
      evalSummaryOverflow(oldSummary);
    }
  }

  function patchContainer(container, entries) {
    // 既存カードを index 化
    var existing = {};
    var cards = container.querySelectorAll('.card[data-card-id]');
    for (var i = 0; i < cards.length; i++) {
      existing[cards[i].getAttribute('data-card-id')] = cards[i];
    }

    // ターゲット順序どおりに走査しつつ update/create + 並び替え
    var seen = {};
    var prev = null;
    for (var j = 0; j < entries.length; j++) {
      var data = entries[j];
      seen[data.itemId] = true;
      var card = existing[data.itemId];
      if (card) {
        updateCard(card, data);
      } else {
        card = createCard(data);
      }
      // 正しい位置 (prev の次) に既に居なければ移動 / 挿入
      var expected = prev ? prev.nextElementSibling : container.firstElementChild;
      if (expected !== card) {
        container.insertBefore(card, expected);
      }
      prev = card;
    }

    // ターゲットに無いカードは削除
    for (var id in existing) {
      if (!seen[id]) existing[id].remove();
    }
  }

  function applyPatch(payload) {
    var entries = (payload && payload.entries) || [];
    var runningContainer = document.querySelector('[data-cards-running]');
    var stoppedContainer = document.querySelector('[data-cards-stopped]');
    var emptyEl = document.querySelector('[data-empty]');
    if (!runningContainer || !stoppedContainer) return;

    var running = [];
    var stopped = [];
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].state === 'stopped') stopped.push(entries[i]);
      else running.push(entries[i]);
    }

    var isEmpty = entries.length === 0;
    if (emptyEl) emptyEl.hidden = !isEmpty;

    // 起動中セクション: 全件 0 のときは空メッセージに譲るため hidden
    var runningTitle = document.querySelector('[data-section="running"]');
    var hideRunning = running.length === 0;
    runningContainer.hidden = hideRunning;
    if (runningTitle) runningTitle.hidden = hideRunning;
    patchContainer(runningContainer, running);

    // 停止セクション: 0 件なら見出しごと隠す
    var stoppedTitle = document.querySelector('[data-section="stopped"]');
    var hideStopped = stopped.length === 0;
    stoppedContainer.hidden = hideStopped;
    if (stoppedTitle) stoppedTitle.hidden = hideStopped;
    patchContainer(stoppedContainer, stopped);

    // セクション見出しの件数
    var runningCount = document.querySelector('[data-section="running"] [data-count]');
    if (runningCount) setText(runningCount, String(running.length));
    var stoppedCount = document.querySelector('[data-section="stopped"] [data-count]');
    if (stoppedCount) setText(stoppedCount, String(stopped.length));

    // meta 行 (件数 + 取得時刻) を更新
    var metaEl = document.querySelector('[data-dashboard-meta]');
    if (metaEl) {
      setText(metaEl, '表示中 CLI: ' + entries.length + ' 件 · 取得時刻: ' + (payload.renderedAt || ''));
    }

    // 全カードの要約 overflow を再評価。レイアウト確定後に走らせたいので rAF で 1 フレーム待つ。
    requestAnimationFrame(evalAllSummaries);
  }

  function doFetch() {
    if (fetchInflight) { fetchAgain = true; return; }
    fetchInflight = true;
    fetch('/api/dashboard.json', { cache: 'no-store' })
      .then(function(r) { return r.json(); })
      .then(function(payload) { applyPatch(payload); })
      .catch(function(err) { console.warn('[ai-monitor] dashboard.json fetch failed', err); })
      .then(function() {
        fetchInflight = false;
        if (fetchAgain) { fetchAgain = false; scheduleFetch(); }
      });
  }

  // SSE が連発したときに 100ms にまとめる。
  function scheduleFetch() {
    if (fetchTimer) return;
    fetchTimer = setTimeout(function() { fetchTimer = null; doFetch(); }, 100);
  }

  function startSSE() {
    try { if (es) es.close(); } catch (e) { /* ignore */ }
    es = new EventSource('/api/watch');
    // dashboard / proc:* どちらの item-changed もダッシュボード表示に
    // 影響しうるので、id でフィルタせず常に refetch する (差分パッチが
    // 比較するので無駄な DOM 更新は起きない)。
    es.addEventListener('item-changed', function() { scheduleFetch(); });
    es.addEventListener('sidebar', function() { scheduleFetch(); });
    // onerror は EventSource が自動再接続するので何もしない
  }

  function init() {
    startSSE();
    // 初回 SSR 済みカードに対しても overflow 判定を走らせる。
    requestAnimationFrame(evalAllSummaries);
  }

  // カード幅が変われば line-clamp の overflow 判定も変わるので、resize 時に再評価。
  // (連発するので 100ms デバウンス)
  var resizeTimer = null;
  window.addEventListener('resize', function() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function() { resizeTimer = null; evalAllSummaries(); }, 100);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
`;

// Phase 6: server モードのダッシュボードに載せるボイスバー。
// 種別チェックボックスの初期 checked は SSR では全 ON にしておき、JS 起動時に
// localStorage の保存値で上書きする (JS なしでも崩れない素の HTML)。
function renderVoiceBar(): string {
  return `<div class="voice-bar" data-voice-bar>
    <button type="button" class="voice-toggle" data-voice-toggle aria-pressed="false">🔇 音声 OFF</button>
    <label class="voice-vol">音量 <input type="range" min="0" max="100" value="80" data-voice-volume><span class="voice-vol-num" data-voice-volume-value>80</span></label>
    <span class="voice-sep"></span>
    <span class="voice-filters" data-voice-kinds>
      <label><input type="checkbox" data-voice-kind="completed" checked> 完了</label>
      <label><input type="checkbox" data-voice-kind="awaiting" checked> 承認待ち</label>
      <label><input type="checkbox" data-voice-kind="progress" checked> 途中経過</label>
    </span>
    <label class="voice-client">端末 <select data-voice-client><option value="">すべて</option></select></label>
    <button type="button" class="voice-history-toggle" data-voice-history-toggle>履歴 ▾</button>
    <span class="voice-now" data-voice-now title="再生中の発話"></span>
  </div>
  <div class="voice-history" data-voice-history hidden></div>`;
}

// Phase 6: ボイス再生 + フィルタ + 履歴のクライアント JS (server モードのみ注入)。
//
// - 専用の EventSource('/api/watch') を張り `voice-utterance` を購読する。
//   既存 DASHBOARD_LIVE_SCRIPT の EventSource とは独立 (再接続時のリスナ喪失を避ける)。
// - 単一 HTMLAudioElement + キューで「順次再生」。同時再生しない・古すぎる発話は捨てる。
// - 🔊 トグル ON のクリックが autoplay 解除のユーザージェスチャを兼ねる。
// - 設定 (ON/OFF・音量・種別・端末) は localStorage に永続。
// - 履歴は起動時に /api/voice/recent.json で初期化し、以降 SSE で先頭に積む。
//   履歴の「再生」ボタンは明示操作なので OFF でも鳴らし、現在再生を止めて即再生する。
//
// [UI ゲーティング / Phase 3] この EventSource は `?sub=<viewer id>&voice=<0|1>&kinds=<csv>` を
//   宣言して張り、ON/OFF・種別を変えるたびに `POST /api/voice/prefs` で現在値を送る。server は
//   `?sub` を宣言した接続だけを「voice viewer」として数え、その希望種別の和集合 (∩ env 天井) だけを
//   生成する (誰も該当種別を ON にしていない / viewer ゼロ → 生成しない = コスト削減)。
//   ※ savings は「?sub 宣言」が前提。`?sub` を送らない旧キャッシュのタブは viewer に数えられず、
//     その種別は (他に ON の viewer が居なければ) 生成されない。タブを 1 度リロードすれば新 JS になる。
//   ※ server 側が CCM_VOICE_UI_GATING=off のときは prefs が 404 になるが best-effort なので無視してよい
//     (その場合 server は従来どおり env の静的種別で生成する)。
const DASHBOARD_VOICE_SCRIPT = `
(function() {
  var KINDS = ['completed', 'awaiting', 'progress'];
  var KIND_LABEL = { completed: '完了', awaiting: '承認待ち', progress: '途中経過' };
  var SPEAKER_LABEL = { teacher: 'ちょビ', student: 'なるこ' };
  var MAX_AGE_MS = 60000;   // これより古い発話は再生キューから捨てる (溜まった分を一気に喋らない)
  var MAX_HISTORY = 50;
  var GROUP_GAP_MS = 700;   // 別イベント (groupId 違い) の発話に移るとき挟む無音

  var bar = document.querySelector('[data-voice-bar]');
  if (!bar) return;
  // 二重初期化ガード: スクリプトが同一ドキュメントに 2 度注入されても EventSource を
  // 重複生成しない (voice-utterance listener が 2 つ = 同じ発話を 2 回再生する事故を防ぐ)。
  // 別タブ/iframe は別 window なので対象外 (仕様上の利用者起因)。
  if (window.__ccmVoiceInit) return;
  window.__ccmVoiceInit = true;
  var toggleBtn = document.querySelector('[data-voice-toggle]');
  var volEl = document.querySelector('[data-voice-volume]');
  var volNumEl = document.querySelector('[data-voice-volume-value]');
  var clientSel = document.querySelector('[data-voice-client]');
  var histToggle = document.querySelector('[data-voice-history-toggle]');
  var histEl = document.querySelector('[data-voice-history]');
  var nowEl = document.querySelector('[data-voice-now]');
  var kindBoxes = document.querySelectorAll('[data-voice-kind]');

  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // --- 設定の復元 ---
  var enabled = lsGet('ccm-voice-enabled', '0') === '1';
  var volume = (function() { var n = parseInt(lsGet('ccm-voice-volume', '80'), 10); return isNaN(n) ? 80 : Math.max(0, Math.min(100, n)); })();
  var kinds = (function() {
    try { var a = JSON.parse(lsGet('ccm-voice-kinds', '')); if (Array.isArray(a)) return a; } catch (e) { /* ignore */ }
    return KINDS.slice();
  })();
  var clientFilter = lsGet('ccm-voice-client', '');

  // viewer 識別子 (sub)。タブ単位で採番し sessionStorage に保持する (タブ内の SSE 再接続で不変・
  // 別タブは別 sub)。これを宣言した接続だけを server が「voice viewer」として数える (UI ゲーティング)。
  var sub = (function() {
    try {
      var s = sessionStorage.getItem('ccm-voice-sub');
      if (s) return s;
      var gen = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
        : (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
      sessionStorage.setItem('ccm-voice-sub', gen);
      return gen;
    } catch (e) {
      // sessionStorage 不可 (プライベートモード等) はメモリ内採番でフォールバック (この window 内で不変)。
      return 'mem-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
  })();

  // --- 状態 ---
  var queue = [];
  var playing = false;
  var seenClients = {};
  var history = [];
  var lastGroupId = null;   // 直近に再生した発話のグループ (別イベント検出用)
  var gapTimer = null;      // 別イベント間の無音タイマ
  var audio = new Audio();
  audio.preload = 'auto';

  // --- 再生済み id の重複排除 (同一 utterance が二重配信されても 1 回しか鳴らさない) ---
  // 二重初期化ガードで配信元の重複は防ぐが、保険として再生キュー側でも id を覚える。
  // 履歴の「再生」(playNow) は明示操作なので対象外 (既見でも鳴らす)。
  var SEEN_ID_MAX = 500;
  var seenIds = {};         // 投入済み id の集合
  var seenOrder = [];       // FIFO 退避用 (肥大防止)
  function markSeenId(id) {
    if (!id || seenIds[id]) return false;   // 既見 = 投入しない
    seenIds[id] = true;
    seenOrder.push(id);
    if (seenOrder.length > SEEN_ID_MAX) { delete seenIds[seenOrder.shift()]; }
    return true;
  }

  function applyToggleUI() {
    toggleBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    toggleBtn.textContent = enabled ? '🔊 音声 ON' : '🔇 音声 OFF';
  }
  // スライダー位置 (0-100) は「知覚音量」を線形に表すが、HTMLAudioElement.volume は
  // 振幅 (リニアゲイン) で、人の音量知覚は対数的。volume/100 をそのまま入れると中間域が
  // 体感上かなり大きく聞こえ、表示%と聞こえ方がズレる。知覚カーブに通して振幅へ変換する。
  // exp カーブ: x=1→1.0, x=0→0, x=0.5→約0.38 (≈ -8dB ≒ 体感ほぼ半分)。
  function perceptualGain(pct) {
    var x = Math.max(0, Math.min(100, pct)) / 100;
    if (x <= 0) return 0;
    return (Math.exp(x) - 1) / (Math.E - 1);
  }
  function applyVolume() { audio.volume = perceptualGain(volume); }
  function applyVolumeNum() { if (volNumEl) volNumEl.textContent = String(volume); }
  function kindOn(k) { return kinds.indexOf(k) !== -1; }
  function setNow(text) { if (nowEl) nowEl.textContent = text || ''; }
  function passes(meta) {
    if (!kindOn(meta.kind)) return false;
    if (clientFilter && meta.clientId !== clientFilter) return false;
    return true;
  }

  function ensureClientOption(id) {
    if (!id || seenClients[id]) return;
    seenClients[id] = true;
    var opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    clientSel.appendChild(opt);
    if (id === clientFilter) clientSel.value = id;
  }

  // --- 再生 (単一 audio + キュー) ---
  function enqueue(meta) {
    if (!enabled || !meta.hasAudio || !passes(meta)) return;
    if (!markSeenId(meta.id)) return;   // 既に投入済みの id は二重再生しない
    queue.push(meta);
    pump();
  }
  function groupKeyOf(meta) {
    // groupId があればそれ、無ければ id 単体を 1 グループ扱い
    return meta.groupId || ('@' + meta.id);
  }
  function clearGapTimer() {
    if (gapTimer !== null) { clearTimeout(gapTimer); gapTimer = null; }
  }
  function pump() {
    if (playing) return;
    var now = Date.now();
    while (queue.length) {
      var meta = queue.shift();
      if (now - meta.createdAtMs > MAX_AGE_MS) continue;   // 古すぎる
      if (!enabled || !passes(meta)) continue;             // 再生直前にも再チェック
      // 別イベント (groupId 違い) に移るときは少し間を開ける。
      // lastGroupId が null = キューが一度空になった直後なので待たせない。
      if (lastGroupId !== null && groupKeyOf(meta) !== lastGroupId) {
        playing = true;   // 無音中も再生中扱いにして二重 pump を防ぐ
        gapTimer = setTimeout(function() {
          gapTimer = null;
          playing = false;
          play(meta);
        }, GROUP_GAP_MS);
      } else {
        play(meta);
      }
      return;
    }
  }
  function play(meta) {
    playing = true;
    lastGroupId = groupKeyOf(meta);
    setNow((meta.projectName ? meta.projectName + ': ' : '') + (meta.speaker ? (SPEAKER_LABEL[meta.speaker] || meta.speaker) + '「' + (meta.text || '') + '」' : (meta.text || '')));
    applyVolume();
    var finished = false;
    function done() {
      if (finished) return;
      finished = true;
      audio.onended = null;
      audio.onerror = null;
      playing = false;
      setNow('');
      pump();
      // キューが空 = 一区切り。無音明けの最初の発話は待たせない。
      if (!playing) lastGroupId = null;
    }
    audio.onended = done;
    audio.onerror = done;   // 404 / 期限切れは黙って次へ
    audio.src = '/api/voice/audio/' + encodeURIComponent(meta.id);
    var p = audio.play();
    if (p && p.catch) p.catch(function() { done(); });   // autoplay ブロック等
  }
  function playNow(meta) {
    // 現在再生を止めて即再生 (履歴の「再生」= 明示操作なので OFF でも鳴らす)。
    clearGapTimer();
    try { audio.pause(); } catch (e) { /* ignore */ }
    audio.onended = null;
    audio.onerror = null;
    playing = false;
    play(meta);
  }

  // --- 履歴 ---
  function fmtTime(ms) {
    try { return new Date(ms).toLocaleTimeString('ja-JP', { hour12: false }); } catch (e) { return ''; }
  }
  function renderHistory() {
    if (!history.length) { histEl.innerHTML = '<div class="voice-history-empty">まだ発話はありません。</div>'; return; }
    var html = '';
    for (var i = 0; i < history.length; i++) {
      var m = history[i];
      html += '<div class="vh-row">'
        + '<span class="vh-time">' + esc(fmtTime(m.createdAtMs)) + '</span>'
        + '<span class="vh-kind vh-kind-' + esc(m.kind) + '">' + esc(KIND_LABEL[m.kind] || m.kind) + '</span>'
        + (m.clientId ? '<span class="vh-client">' + esc(m.clientId) + '</span>' : '')
        + (m.projectName ? '<span class="vh-proj">' + esc(m.projectName) + '</span>' : '')
        + (m.speaker ? '<span class="vh-speaker vh-speaker-' + esc(m.speaker) + '">' + esc(SPEAKER_LABEL[m.speaker] || m.speaker) + '</span>' : '')
        + (m.emotion && m.emotion !== 'neutral' ? '<span class="vh-emotion">' + esc(m.emotion) + '</span>' : '')
        + '<span class="vh-text">' + esc(m.text) + '</span>'
        + (m.hasAudio ? '<button type="button" class="vh-play" data-vh-id="' + esc(m.id) + '">再生</button>' : '')
        + '</div>';
    }
    histEl.innerHTML = html;
  }
  function addHistory(meta) {
    history.unshift(meta);
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    if (!histEl.hidden) renderHistory();
  }

  function onUtterance(meta) {
    if (!meta || !meta.id) return;
    ensureClientOption(meta.clientId);
    addHistory(meta);
    enqueue(meta);
  }

  // --- イベント結線 ---
  toggleBtn.addEventListener('click', function() {
    enabled = !enabled;
    lsSet('ccm-voice-enabled', enabled ? '1' : '0');
    applyToggleUI();
    postPrefs();   // 🔊 ON/OFF を生成抑止へ反映 (OFF の viewer は union に寄与しない)
    if (enabled) {
      pump();   // ユーザージェスチャ。溜まっていれば再生開始 (autoplay 解除も兼ねる)
    } else {
      queue.length = 0;
      clearGapTimer();
      try { audio.pause(); } catch (e) { /* ignore */ }
      audio.onended = null;
      audio.onerror = null;
      playing = false;
      lastGroupId = null;
      setNow('');
    }
  });
  volEl.addEventListener('input', function() {
    var n = parseInt(volEl.value, 10);
    volume = isNaN(n) ? volume : Math.max(0, Math.min(100, n));
    lsSet('ccm-voice-volume', String(volume));
    applyVolume();
    applyVolumeNum();
  });
  for (var i = 0; i < kindBoxes.length; i++) {
    kindBoxes[i].addEventListener('change', function() {
      var next = [];
      for (var j = 0; j < kindBoxes.length; j++) {
        if (kindBoxes[j].checked) next.push(kindBoxes[j].getAttribute('data-voice-kind'));
      }
      kinds = next;
      lsSet('ccm-voice-kinds', JSON.stringify(kinds));
      postPrefs();   // 種別チェックの変更を生成抑止へ反映 (union ∩ env 天井)
    });
  }
  clientSel.addEventListener('change', function() {
    clientFilter = clientSel.value || '';
    lsSet('ccm-voice-client', clientFilter);
  });
  histToggle.addEventListener('click', function() {
    histEl.hidden = !histEl.hidden;
    histToggle.textContent = histEl.hidden ? '履歴 ▾' : '履歴 ▴';
    if (!histEl.hidden) renderHistory();
  });
  histEl.addEventListener('click', function(ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('[data-vh-id]') : null;
    if (!btn) return;
    var id = btn.getAttribute('data-vh-id');
    for (var k = 0; k < history.length; k++) {
      if (history[k].id === id) { playNow(history[k]); return; }
    }
  });

  // --- 初期 UI 反映 ---
  applyToggleUI();
  volEl.value = String(volume);
  applyVolume();
  applyVolumeNum();
  for (var b = 0; b < kindBoxes.length; b++) {
    kindBoxes[b].checked = kindOn(kindBoxes[b].getAttribute('data-voice-kind'));
  }

  // --- 履歴の初期ロード (recent.json。古いものは再生せず履歴/端末候補のみ) ---
  fetch('/api/voice/recent.json', { cache: 'no-store' })
    .then(function(r) { return r.json(); })
    .then(function(payload) {
      var arr = (payload && payload.utterances) || [];
      for (var i = arr.length - 1; i >= 0; i--) ensureClientOption(arr[i].clientId);
      history = arr.slice(0, MAX_HISTORY);
      if (!histEl.hidden) renderHistory();
    })
    .catch(function() { /* 履歴は無くても良い */ });

  // --- viewer prefs を server へ送る (UI ゲーティング) ---
  // 生成抑止は「接続中 viewer の希望種別の和集合 (∩ env 天井)」で決まるので、ON/OFF・種別を変えるたびに
  // 権威ある現在値を POST する。端末フィルタ clientFilter は再生のみに効く (生成抑止の対象外) ので送らない。
  // uiGating=off の server では 404 になるが best-effort なので無視してよい (従来の静的種別生成にフォールバック)。
  function postPrefs() {
    try {
      fetch('/api/voice/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ sub: sub, enabled: enabled, kinds: kinds })
      }).catch(function() { /* best-effort */ });
    } catch (e) { /* ignore */ }
  }
  function watchUrl() {
    // 初期 seed (POST 到着前の取りこぼし防止)。再接続時はこの URL の seed が古い可能性があるが、
    // onopen で必ず postPrefs して現在値へ上書きするので問題ない。
    return '/api/watch?sub=' + encodeURIComponent(sub)
      + '&voice=' + (enabled ? '1' : '0')
      + '&kinds=' + encodeURIComponent(kinds.join(','));
  }

  // --- SSE (voice 専用の独立 EventSource。再接続はネイティブ任せ) ---
  var es = new EventSource(watchUrl());
  // (再)接続のたびに権威ある prefs を送り直す。初回ロード = 初期値の宣言、再接続 = 古い seed の上書き訂正。
  es.addEventListener('open', function() { postPrefs(); });
  es.addEventListener('voice-utterance', function(ev) {
    var meta = null;
    try { meta = JSON.parse(ev.data); } catch (e) { return; }
    onUtterance(meta);
  });
})();
`;

export function renderDashboard(entries: MonitorEntry[], opts: { voice?: boolean } = {}): string {
  const now = new Date().toISOString();
  const voice = opts.voice ?? false;
  // 起動中 / 停止 の 2 セクションに分割する。state === 'stopped' のみ停止セクション。
  // JS が動かない環境でも初回は HTML だけで両セクションが見える。
  const running = entries.filter(e => e.state !== 'stopped');
  const stopped = entries.filter(e => e.state === 'stopped');
  const isEmpty = entries.length === 0;
  const runningHtml = running.map(e => renderCardFromData(entryToDashboardCardData(e))).join('\n');
  const stoppedHtml = stopped.map(e => renderCardFromData(entryToDashboardCardData(e))).join('\n');
  const runningHidden = running.length === 0;
  const stoppedHidden = stopped.length === 0;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>AI Monitor Dashboard</title>
<style>${COMMON_STYLE}${voice ? VOICE_STYLE : ''}</style></head>
<body>
  <h1>Dashboard</h1>
  <div class="meta" data-dashboard-meta>表示中 CLI: ${entries.length} 件 · 取得時刻: ${escapeHtml(now)}</div>
  ${voice ? renderVoiceBar() : ''}
  <h2 class="section-title" data-section="running"${runningHidden ? ' hidden' : ''}>起動中 <span data-count>${running.length}</span></h2>
  <div class="cards" data-cards-running${runningHidden ? ' hidden' : ''}>${runningHtml}</div>
  <h2 class="section-title" data-section="stopped"${stoppedHidden ? ' hidden' : ''}>停止 <span data-count>${stopped.length}</span></h2>
  <div class="cards" data-cards-stopped${stoppedHidden ? ' hidden' : ''}>${stoppedHtml}</div>
  <div class="empty" data-empty${isEmpty ? '' : ' hidden'}>稼働中の Claude Code CLI が見つかりません。</div>
  <script>${DASHBOARD_SCRIPT}</script>
  <script>${DASHBOARD_LIVE_SCRIPT}</script>
  ${voice ? `<script>${DASHBOARD_VOICE_SCRIPT}</script>` : ''}
</body></html>`;
}

const MAX_INLINE_LEN = 800;

/**
 * Phase 4: 自己更新化のための「イベントごとの安定キー」。
 * jsonl は基本 append-only だが、200 件を超えると先頭からシフトして落ちる。
 * key には timestamp + kind + toolUseId + 本文先頭ハッシュ を混ぜて、
 * クライアント側で「既存 DOM 末尾と新規 payload の先頭が一致する区間を保持し、
 * 食い違いから先だけ差し替える」ことができるようにする。
 */
function eventKey(ev: NormalizedEvent, index: number): string {
  const textPrefix = (ev.text ?? '').slice(0, 64);
  // 簡易ハッシュ (FNV-1a 32bit) — 衝突しても DOM が再構築されるだけで実害なし
  let h = 0x811c9dc5;
  for (let i = 0; i < textPrefix.length; i++) {
    h ^= textPrefix.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return `${index}|${ev.timestamp}|${ev.kind}|${ev.toolUseId ?? ''}|${h.toString(16)}`;
}

function renderEvent(ev: NormalizedEvent, key: string): string {
  const kindClass = `kind-${ev.kind}`;
  const head = ev.kind === 'tool-use'
    ? `<span class="event-kind ${kindClass}">tool_use</span> <span>${escapeHtml(ev.toolName ?? '')}</span>`
    : `<span class="event-kind ${kindClass}">${ev.kind}</span>`;
  const text = ev.text ?? '';
  const escaped = escapeHtml(text);
  const meta = ev.isMeta ? ' <span style="color:#aaa">(meta)</span>' : '';
  if (text.length <= MAX_INLINE_LEN) {
    return `<div class="event" data-event-key="${escapeHtml(key)}">
      <div class="event-head">${head}${meta}<span>${escapeHtml(ev.timestamp)}</span></div>
      <div class="event-body">${escaped}</div>
    </div>`;
  }
  const preview = escapeHtml(text.slice(0, MAX_INLINE_LEN));
  return `<div class="event" data-event-key="${escapeHtml(key)}">
    <div class="event-head">${head}${meta}<span>${escapeHtml(ev.timestamp)}</span></div>
    <div class="event-body collapsed">${preview}</div>
    <details><summary>全文を表示 (${text.length} 文字)</summary><pre>${escaped}</pre></details>
  </div>`;
}

/**
 * プロセス詳細 1 件分の表示データ。Phase 4 で `/api/process.json` のレスポンスと、
 * サーバ側初回描画 (`renderProcessView`) の両方に同じものを渡す。
 *
 * `events[].html` は事前に escapeHtml 済みの完成 HTML を入れる。クライアント側で
 * 再エスケープしなくて済むようにし、なおかつ HTML 生成ロジックを一箇所に閉じ込める。
 */
export interface ProcessViewData {
  id: string;
  itemId: string;
  cwd: string;
  cwdShort: string;
  state: ActivityState;
  stateLabel: string;
  stateTooltip: string;
  /** "12345" or "—" */
  pid: string;
  /** "<iso> (<rel>)" or "—" */
  lastActivityLabel: string;
  /** jsonl のセッション ID、無ければ "—" */
  sessionId: string;
  events: Array<{ key: string; html: string }>;
  renderedAt: string;
}

/**
 * @param events 詳細表示するイベント列。未指定なら従来どおり `entry.transcript.jsonlPath` から読む
 *   (local モード)。server モードは jsonl を持たないため `EntrySource.readEvents` の結果を渡す。
 */
export function buildProcessViewData(entry: MonitorEntry, events?: NormalizedEvent[]): ProcessViewData {
  const evs = events ?? (entry.transcript ? readTailEvents(entry.transcript.jsonlPath, 200) : []);
  const lastActivityLabel = entry.lastActivityAt
    ? `${entry.lastActivityAt} (${fmtRelativeTime(entry.lastActivityAt)})`
    : '—';
  return {
    id: entry.id,
    itemId: `proc:${entry.id}`,
    cwd: entry.cwd,
    cwdShort: path.basename(entry.cwd) || entry.cwd,
    state: entry.state,
    stateLabel: STATE_LABEL_JA[entry.state],
    stateTooltip: STATE_TOOLTIP_JA[entry.state],
    pid: String(entry.process?.pid ?? '—'),
    lastActivityLabel,
    sessionId: entry.transcript?.sessionId ?? '—',
    events: evs.map((ev, i) => {
      const key = eventKey(ev, i);
      return { key, html: renderEvent(ev, key) };
    }),
    renderedAt: new Date().toISOString(),
  };
}

// Phase 4: プロセス詳細 iframe を自己更新型にする (Phase 2 の DASHBOARD_LIVE_SCRIPT と同形)。
//
// 旧実装は親 vibeboard が SSE を受けるたびに iframe.src を差し替えて、
// 詳細ビュー全体 (HTML + jsonl 200 件) を再ロードしていた。本スクリプトは iframe 内で
// `/api/watch` を直接購読し、自分の itemId に対応する item-changed が来たときだけ
// `/api/process.json` を fetch して、event 一覧の末尾差分とヘッダだけ書き換える。
//
// 末尾差分パッチの方針:
//   - jsonl は基本 append-only なので、新 payload の events[] と既存 DOM の
//     data-event-key を先頭から並列に走査し、食い違いより先だけ削除 → 末尾に追記
//   - 200 件超で先頭から rotate された場合は早い段階で不一致になり、全体が
//     再構築される (落ちるが頻度は低い)
//   - スクロール位置が末尾近辺だったときは追記後も自動で末尾追従する
const PROCESS_VIEW_LIVE_SCRIPT = `
(function() {
  var itemId = window.__procItemId;
  if (!itemId) return;
  var es = null;
  var fetchTimer = null;
  var fetchInflight = false;
  var fetchAgain = false;

  function setText(el, text) {
    if (!el) return;
    if (el.textContent !== text) el.textContent = text;
  }
  function setAttr(el, name, value) {
    if (!el) return;
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }
  function swapPrefixClass(el, prefix, newClass) {
    if (!el) return;
    if (el.classList.contains(newClass)) {
      var hasExtra = false;
      for (var i = 0; i < el.classList.length; i++) {
        var c = el.classList[i];
        if (c.indexOf(prefix) === 0 && c !== newClass) { hasExtra = true; break; }
      }
      if (!hasExtra) return;
    }
    var toRemove = [];
    for (var j = 0; j < el.classList.length; j++) {
      var cc = el.classList[j];
      if (cc.indexOf(prefix) === 0) toRemove.push(cc);
    }
    for (var k = 0; k < toRemove.length; k++) el.classList.remove(toRemove[k]);
    el.classList.add(newClass);
  }

  function isNearBottom() {
    var doc = document.documentElement;
    var threshold = 80; // px の余裕
    return (window.innerHeight + window.scrollY) >= (doc.scrollHeight - threshold);
  }

  function scrollToBottom() {
    var h = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    window.scrollTo(0, h);
  }

  function applyPatch(data) {
    // --- ヘッダの可変フィールド ---
    setText(document.querySelector('[data-pid]'), data.pid);
    var badge = document.querySelector('[data-badge]');
    swapPrefixClass(badge, 'badge-', 'badge-' + data.state);
    setAttr(badge, 'title', data.stateTooltip);
    setText(badge, data.stateLabel);
    setText(document.querySelector('[data-last-activity]'), data.lastActivityLabel);
    setText(document.querySelector('[data-session]'), data.sessionId);

    // --- イベント一覧の差分パッチ ---
    var container = document.querySelector('[data-events]');
    if (!container) return;
    var atBottom = isNearBottom();

    var emptyEl = container.querySelector('.empty');
    var newEvents = data.events || [];

    if (newEvents.length === 0) {
      // 全部消して empty メッセージ
      var existing = container.querySelectorAll('[data-event-key]');
      for (var x = 0; x < existing.length; x++) existing[x].remove();
      if (!emptyEl) {
        container.insertAdjacentHTML('beforeend', '<div class="empty">表示できるイベントがありません (jsonl が無いか空)。</div>');
      }
      return;
    }
    if (emptyEl) emptyEl.remove();

    var existingNodes = container.querySelectorAll('[data-event-key]');
    // 先頭から並列走査して、最初の不一致 index を見つける
    var i = 0;
    var limit = Math.min(existingNodes.length, newEvents.length);
    for (; i < limit; i++) {
      if (existingNodes[i].getAttribute('data-event-key') !== newEvents[i].key) break;
    }
    // i から先の既存 DOM を削除
    for (var d = existingNodes.length - 1; d >= i; d--) existingNodes[d].remove();
    // i から先を新規追記
    if (i < newEvents.length) {
      var html = '';
      for (var k = i; k < newEvents.length; k++) html += newEvents[k].html;
      container.insertAdjacentHTML('beforeend', html);
    }

    if (atBottom) scrollToBottom();
  }

  function doFetch() {
    if (fetchInflight) { fetchAgain = true; return; }
    fetchInflight = true;
    fetch('/api/process.json?id=' + encodeURIComponent(itemId), { cache: 'no-store' })
      .then(function(r) { return r.json(); })
      .then(function(payload) { if (payload && !payload.error) applyPatch(payload); })
      .catch(function(err) { console.warn('[ai-monitor] process.json fetch failed', err); })
      .then(function() {
        fetchInflight = false;
        if (fetchAgain) { fetchAgain = false; scheduleFetch(); }
      });
  }

  function scheduleFetch() {
    if (fetchTimer) return;
    fetchTimer = setTimeout(function() { fetchTimer = null; doFetch(); }, 100);
  }

  function startSSE() {
    try { if (es) es.close(); } catch (e) { /* ignore */ }
    es = new EventSource('/api/watch');
    // 自分の itemId に関係する item-changed のみで再 fetch する。
    // dashboard 通知は無視 (詳細ビューには影響しない)。
    es.addEventListener('item-changed', function(ev) {
      try {
        var p = JSON.parse(ev.data);
        if (p && p.id === itemId) scheduleFetch();
      } catch (e) { /* ignore */ }
    });
  }

  // 初回表示の末尾スクロールは既存挙動を踏襲
  if (document.readyState === 'complete') {
    scrollToBottom();
  } else {
    window.addEventListener('load', scrollToBottom);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startSSE);
  } else {
    startSSE();
  }
})();
`;

export function renderProcessView(entry: MonitorEntry, events?: NormalizedEvent[]): string {
  const data = buildProcessViewData(entry, events);
  const eventsHtml = data.events.length === 0
    ? `<div class="empty">表示できるイベントがありません (jsonl が無いか空)。</div>`
    : data.events.map(e => e.html).join('\n');
  // itemId は JS の文字列リテラルに入れるので JSON.stringify で安全にエンコード
  const itemIdLiteral = JSON.stringify(data.itemId);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(data.cwdShort)}</title>
<style>${COMMON_STYLE}</style></head>
<body>
  <h1 title="${escapeHtml(data.cwd)}">${escapeHtml(data.cwdShort)}</h1>
  <div class="meta">
    <code>${escapeHtml(data.cwd)}</code>
  </div>
  <div class="meta">
    PID: <code data-pid>${escapeHtml(data.pid)}</code>
    · <span class="badge badge-${data.state}" data-badge title="${escapeHtml(data.stateTooltip)}">${escapeHtml(data.stateLabel)}</span>
    · 最終活動: <span data-last-activity>${escapeHtml(data.lastActivityLabel)}</span>
    · session: <code data-session>${escapeHtml(data.sessionId)}</code>
  </div>
  <div class="meta" style="color:#aaa">
    jsonl はターン完了時にしか書き出されないため、進行中ターンの本文はここには出ません。
  </div>
  <div data-events>${eventsHtml}</div>
  <script>window.__procItemId = ${itemIdLiteral};</script>
  <script>${PROCESS_VIEW_LIVE_SCRIPT}</script>
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
