import Anthropic from '@anthropic-ai/sdk';
import type { NormalizedEvent } from './transcript';

export type SummaryState = 'ok' | 'pending' | 'unavailable' | 'error';

export interface SummaryResult {
  state: SummaryState;
  /** state === 'ok' の場合のみセットされる要約テキスト */
  text?: string;
  /** state === 'ok' の場合のみセットされる生成時刻 (epoch ms) */
  generatedAt?: number;
  /** state === 'error' のときの簡単なメッセージ (UI には出さない、ログ用) */
  error?: string;
}

export interface SummarizerOptions {
  apiKey?: string;
  model?: string;
  /** 計算完了時に呼ばれる。Phase 3 で SSE push のトリガに使う。 */
  onUpdate?: (key: string, result: SummaryResult) => void;
}

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const PROMPT_MAX_CHARS = 4000;
const RESPONSE_MAX_TOKENS = 200;

const SYSTEM_PROMPT =
  'あなたは Claude Code CLI のセッションログを読み、現在のタスクの概要と進捗を日本語 1〜2 行で要約するアシスタントです。冗長な前置きや「要約します」のような枕は付けないでください。';

/**
 * Claude API で「セッションは今何をしていてどこまで進んだか」を 1〜2 行に要約する。
 *
 * - `(jsonlPath, mtimeMs)` 単位でメモリにキャッシュ
 * - 同じキーへの並行呼び出しは in-flight Promise を共有
 * - API キー未設定なら常に `{ state: 'unavailable' }` を返す (ネットワーク呼び出しはしない)
 * - 4xx (キー不正等) はその mtime のキャッシュへ `unavailable` を保存し沈黙
 * - 5xx / ネットワークはキャッシュへ保存せず、次の呼び出しで再試行可能
 */
export class Summarizer {
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly onUpdate: (key: string, result: SummaryResult) => void;
  private readonly cache = new Map<string, SummaryResult>();
  private readonly inflight = new Map<string, Promise<SummaryResult>>();
  private client?: Anthropic;

  constructor(opts: SummarizerOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.onUpdate = opts.onUpdate ?? (() => { /* noop */ });
  }

  isEnabled(): boolean {
    return Boolean(this.apiKey);
  }

  private cacheKey(jsonlPath: string, mtimeMs: number): string {
    return `${jsonlPath}@${mtimeMs}`;
  }

  /** キャッシュにあれば返す。無ければ undefined。Phase 3 で SSE 通知時の参照に使う。 */
  peek(jsonlPath: string, mtimeMs: number): SummaryResult | undefined {
    return this.cache.get(this.cacheKey(jsonlPath, mtimeMs));
  }

  /**
   * キャッシュにあれば即返し、無ければバックグラウンドで計算を開始して `pending` を返す。
   * 計算完了時に `onUpdate(key, result)` が呼ばれる (SSE push のトリガに使う想定)。
   */
  getOrCompute(jsonlPath: string, mtimeMs: number, events: NormalizedEvent[]): SummaryResult {
    if (!this.apiKey) return { state: 'unavailable' };
    const key = this.cacheKey(jsonlPath, mtimeMs);
    const cached = this.cache.get(key);
    if (cached) return cached;
    if (!this.inflight.has(key)) this.startCompute(key, events);
    return { state: 'pending' };
  }

  /** Phase 2 検証 / 結合テスト用に「完了まで待つ」API。通常 UI からは使わない。 */
  async wait(jsonlPath: string, mtimeMs: number, events: NormalizedEvent[]): Promise<SummaryResult> {
    if (!this.apiKey) return { state: 'unavailable' };
    const key = this.cacheKey(jsonlPath, mtimeMs);
    const cached = this.cache.get(key);
    if (cached) return cached;
    let p = this.inflight.get(key);
    if (!p) p = this.startCompute(key, events);
    return p;
  }

  private startCompute(key: string, events: NormalizedEvent[]): Promise<SummaryResult> {
    const p = this.compute(events)
      .then(result => {
        this.cache.set(key, result);
        return result;
      })
      .catch(err => {
        const result: SummaryResult = { state: 'error', error: errorMessage(err) };
        // 5xx / ネットワークはキャッシュに入れない (次回呼び出しで再試行可)
        return result;
      })
      .finally(() => {
        this.inflight.delete(key);
      })
      .then(result => {
        try { this.onUpdate(key, result); } catch { /* listener エラーは握りつぶす */ }
        return result;
      });
    this.inflight.set(key, p);
    return p;
  }

  private async compute(events: NormalizedEvent[]): Promise<SummaryResult> {
    if (!this.client) {
      this.client = new Anthropic({ apiKey: this.apiKey });
    }
    const transcript = renderEventsForPrompt(events, PROMPT_MAX_CHARS);
    try {
      const resp = await this.client.messages.create({
        model: this.model,
        max_tokens: RESPONSE_MAX_TOKENS,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          {
            role: 'user',
            content: `以下は Claude Code CLI のセッション末尾です。最初のユーザー入力と直近のやりとりから「今このセッションは何をしていて、どこまで進んだか」を 1〜2 行で要約してください。\n\n---\n${transcript}\n---`,
          },
        ],
      });
      const text = resp.content
        .map(b => (b.type === 'text' ? b.text : ''))
        .join('')
        .trim();
      return { state: 'ok', text, generatedAt: Date.now() };
    } catch (err) {
      const status = httpStatus(err);
      if (typeof status === 'number' && status >= 400 && status < 500) {
        // 4xx は不変。キャッシュに unavailable を入れたいので throw せず unavailable を返す
        console.warn(`[ai-monitor] summarize: ${status} ${errorMessage(err)}`);
        return { state: 'unavailable' };
      }
      console.warn(`[ai-monitor] summarize: ${errorMessage(err)}`);
      throw err;
    }
  }
}

function httpStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const e = err as { status?: unknown; response?: { status?: unknown } };
    if (typeof e.status === 'number') return e.status;
    if (e.response && typeof e.response.status === 'number') return e.response.status;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 末尾イベント配列を「LLM に投入する 1 本のテキスト」に整形する。
 * - meta は除外
 * - 各イベントを 1 行に縮める (本文は 400 文字でトリム)
 * - 末尾から詰めて全体を maxChars 以内に収める (= 古いイベントから順に落とす)
 */
function renderEventsForPrompt(events: NormalizedEvent[], maxChars: number): string {
  const lines: string[] = [];
  for (const ev of events) {
    if (ev.isMeta) continue;
    let line: string;
    if (ev.kind === 'user-text') line = `[user] ${ev.text}`;
    else if (ev.kind === 'assistant-text') line = `[assistant] ${ev.text}`;
    else if (ev.kind === 'tool-use') line = `[tool_use:${ev.toolName ?? '?'}] ${ev.text}`;
    else if (ev.kind === 'tool-result') line = `[tool_result] ${ev.text}`;
    else continue;
    // 改行を空白に潰し、長すぎる本文はトリム
    line = line.replace(/\s+/g, ' ').trim();
    if (line.length > 400) line = line.slice(0, 400) + '…';
    lines.push(line);
  }
  const tail: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    const add = l.length + 1;
    if (total + add > maxChars) break;
    tail.unshift(l);
    total += add;
  }
  return tail.join('\n');
}
