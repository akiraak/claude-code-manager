import Anthropic from '@anthropic-ai/sdk';
import type { NormalizedEvent } from './transcript';

export type SummaryState = 'idle' | 'ok' | 'pending' | 'unavailable' | 'error';

export interface SummaryResult {
  state: SummaryState;
  /** state === 'ok' の場合のみセットされる要約テキスト */
  text?: string;
  /** state === 'ok' の場合のみセットされる生成時刻 (epoch ms) */
  generatedAt?: number;
  /** state === 'error' のときの簡単なメッセージ (UI には出さない、ログ用) */
  error?: string;
  /**
   * 要約生成時の jsonl mtime と現在の jsonl mtime がズレているか。
   * `readSummaryStatus` が立てる。要約結果本体には載せない。
   * UI 側で薄色化 / 「(古い)」表示の判定に使う。
   */
  stale?: boolean;
}

/** Summarizer 内部キャッシュの 1 エントリ。生成時の mtime を一緒に保持する。 */
export interface CachedSummary {
  result: SummaryResult;
  mtimeMs: number;
}

export interface SummarizerOptions {
  apiKey?: string;
  model?: string;
  /**
   * 計算完了時に呼ばれる。`key` は `jsonlPath` 単体 (mtime は含まない)。
   * SSE push のトリガに使う想定。
   */
  onUpdate?: (key: string, result: SummaryResult) => void;
}

/**
 * 要約計算の入力。`events` は末尾窓のイベント、`recentUserText` は
 * 窓を超えて遡って取った「直前のユーザー入力」(findLastUserText の結果)。
 * ツール連打で events 窓から user-text が押し出されても、ピン留めで
 * 必ずプロンプトに乗せるためにある。
 */
export interface SummarizeInput {
  events: NormalizedEvent[];
  recentUserText?: { text: string; at: string };
}

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const PROMPT_MAX_CHARS = 6000;
const PINNED_USER_MAX_CHARS = 1200;
const RESPONSE_MAX_TOKENS = 1000;

const SYSTEM_PROMPT =
  'あなたは Claude Code CLI のセッションログを読み、現在のタスクの概要と進捗を日本語 4〜6 行 (合計 400〜600 文字程度) で要約するアシスタントです。ユーザーが最後に何を依頼したかを必ず踏まえてください。冗長な前置きや「要約します」のような枕は付けないでください。';

/**
 * Claude API で「セッションは今何をしていてどこまで進んだか」を 4〜6 行に要約する。
 *
 * - `jsonlPath` 単位でメモリにキャッシュ (1 jsonl = 最大 1 要約)。
 *   生成時の `mtimeMs` も一緒に保持し、新しい mtime のリクエスト時に
 *   「これは古いキャッシュ」と判定できるようにする。
 * - 同じ jsonl への並行呼び出しは in-flight Promise を共有
 * - API キー未設定なら常に `{ state: 'unavailable' }` を返す (ネットワーク呼び出しはしない)
 * - 4xx (キー不正等) はキャッシュへ `unavailable` を保存し沈黙
 * - 5xx / ネットワークはキャッシュへ保存せず、次の呼び出しで再試行可能
 *
 * `peek` は mtime に関係なく最後に保存された結果を返す。これにより、
 * jsonl が 1 行追記されただけで UI 上の要約表示が消えてしまうのを防ぐ
 * (新しい要約は次の `getOrCompute` で計算され、完了するまで旧結果が
 * 表示され続ける)。「古い」判定は呼び出し側 (`readSummaryStatus`) が
 * `cached.mtimeMs` と現在の mtime を比較して行う。
 */
export class Summarizer {
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly onUpdate: (key: string, result: SummaryResult) => void;
  private readonly cache = new Map<string, CachedSummary>();
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

  /**
   * 最後に保存した要約結果と、その生成時の mtime を返す。`mtimeMs` の
   * 一致判定は呼び出し側で行う (= 古いキャッシュも返す)。
   */
  peek(jsonlPath: string): CachedSummary | undefined {
    return this.cache.get(jsonlPath);
  }

  /** 計算中 (inflight) かどうか。`getOrCompute` を呼ばずに状態だけ知りたいときに使う。 */
  isInflight(jsonlPath: string): boolean {
    return this.inflight.has(jsonlPath);
  }

  /**
   * キャッシュの mtime が一致すれば即返し、ずれていれば (or 無ければ)
   * バックグラウンドで計算を開始して `pending` を返す。
   * 計算完了時に `onUpdate(jsonlPath, result)` が呼ばれる (SSE push のトリガに使う想定)。
   *
   * 旧結果は新結果が完成するまで `peek` 経由で見える。
   *
   * `opts.force` を true にするとキャッシュを無視して必ず再計算をキックする。
   * 既に inflight な計算があればそれを共有する (二重起動はしない)。UI 側「再要約」ボタンで使う。
   */
  getOrCompute(
    jsonlPath: string,
    mtimeMs: number,
    input: SummarizeInput,
    opts: { force?: boolean } = {},
  ): SummaryResult {
    if (!this.apiKey) return { state: 'unavailable' };
    if (!opts.force) {
      const cached = this.cache.get(jsonlPath);
      if (cached && cached.mtimeMs === mtimeMs) return cached.result;
    }
    if (!this.inflight.has(jsonlPath)) this.startCompute(jsonlPath, mtimeMs, input);
    return { state: 'pending' };
  }

  /** Phase 2 検証 / 結合テスト用に「完了まで待つ」API。通常 UI からは使わない。 */
  async wait(
    jsonlPath: string,
    mtimeMs: number,
    input: SummarizeInput,
    opts: { force?: boolean } = {},
  ): Promise<SummaryResult> {
    if (!this.apiKey) return { state: 'unavailable' };
    if (!opts.force) {
      const cached = this.cache.get(jsonlPath);
      if (cached && cached.mtimeMs === mtimeMs) return cached.result;
    }
    let p = this.inflight.get(jsonlPath);
    if (!p) p = this.startCompute(jsonlPath, mtimeMs, input);
    return p;
  }

  private startCompute(jsonlPath: string, mtimeMs: number, input: SummarizeInput): Promise<SummaryResult> {
    const p = this.compute(input)
      .then(result => {
        this.cache.set(jsonlPath, { result, mtimeMs });
        return result;
      })
      .catch(err => {
        const result: SummaryResult = { state: 'error', error: errorMessage(err) };
        // 5xx / ネットワークはキャッシュに入れない (次回呼び出しで再試行可)
        return result;
      })
      .finally(() => {
        this.inflight.delete(jsonlPath);
      })
      .then(result => {
        try { this.onUpdate(jsonlPath, result); } catch { /* listener エラーは握りつぶす */ }
        return result;
      });
    this.inflight.set(jsonlPath, p);
    return p;
  }

  private async compute(input: SummarizeInput): Promise<SummaryResult> {
    if (!this.client) {
      this.client = new Anthropic({ apiKey: this.apiKey });
    }
    const userContent = buildUserPrompt(input);
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
            content: userContent,
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
 * LLM 向けのユーザープロンプト全体を組み立てる。
 *
 * 構造:
 *   1. 指示文 (1〜2 行)
 *   2. `# 最新のユーザー入力` セクション
 *      - `input.recentUserText` を最大 `PINNED_USER_MAX_CHARS` 文字でトリムして全文を載せる
 *      - 無ければセクションごと省略する
 *   3. `# 直近のやり取り (古い順)` セクション
 *      - events を `renderEventsForPrompt` で末尾から詰めて 1 本に整形
 *      - 末尾の `[user] …` が `recentUserText` と同一なら重複排除
 *
 * 上下で同じ user-text が二重に乗ると Haiku が混乱しやすいので、片方しか出さない。
 */
export function buildUserPrompt(input: SummarizeInput): string {
  const sections: string[] = [
    '以下は Claude Code CLI のセッションのスナップショットです。',
    'このセッションが「今何をしていて、どこまで進んでいるか」を 4〜6 行で要約してください。',
    'ユーザーが最後に何を依頼したかを必ず踏まえてください。',
  ];

  const pinned = trimUserText(input.recentUserText?.text, PINNED_USER_MAX_CHARS);
  if (pinned) {
    sections.push('', '# 最新のユーザー入力', pinned);
  }

  const transcript = renderEventsForPrompt(input.events, PROMPT_MAX_CHARS, input.recentUserText);
  if (transcript) {
    sections.push('', '# 直近のやり取り (古い順)', transcript);
  }

  return sections.join('\n');
}

/** 改行を残したまま長すぎる本文を切り詰める。空文字 / undefined はそのまま undefined を返す。 */
function trimUserText(text: string | undefined, maxChars: number): string | undefined {
  if (!text) return undefined;
  const t = text.trim();
  if (!t) return undefined;
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + '…';
}

/**
 * 末尾イベント配列を「LLM に投入する 1 本のテキスト」に整形する。
 * - meta / tool-use / tool-result は除外 (会話文脈に効かないノイズが要約予算を食うのを避ける)
 * - 各イベントを 1 行に縮める (本文は 400 文字でトリム)
 * - 末尾から詰めて全体を maxChars 以内に収める (= 古いイベントから順に落とす)
 * - `pinned` と一致する `[user]` 行はピン留めセクションと重複するため除外する
 */
function renderEventsForPrompt(
  events: NormalizedEvent[],
  maxChars: number,
  pinned?: { text: string; at: string },
): string {
  const pinnedTextNormalized = pinned ? pinned.text.replace(/\s+/g, ' ').trim() : '';
  const lines: string[] = [];
  for (const ev of events) {
    if (ev.isMeta) continue;
    // ピン留めと同じ user-text はスキップ (timestamp 一致 or 本文一致のどちらでも)
    if (
      pinned &&
      ev.kind === 'user-text' &&
      (ev.timestamp === pinned.at ||
        ev.text.replace(/\s+/g, ' ').trim() === pinnedTextNormalized)
    ) {
      continue;
    }
    let line: string;
    if (ev.kind === 'user-text') line = `[user] ${ev.text}`;
    else if (ev.kind === 'assistant-text') line = `[assistant] ${ev.text}`;
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
