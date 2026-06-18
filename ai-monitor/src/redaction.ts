/**
 * 送信前 redaction（秘匿情報マスク）+ サイズ上限。
 *
 * ミラー機能では transcript 末尾・要約などのセッション本文が Cloudflare / g3plus /
 * AI プロバイダ (Anthropic / Gemini) を通過する。明らかな秘匿パターンは **クライアントが
 * push する前にここでマスク** し、サイズも上限で切り詰める (本文の暴発防止)。
 *
 * 方針:
 * - 純関数。副作用なし。Phase 4 の uplink から呼ぶ前提だが単体でテスト可能。
 * - マスクは `«redacted:種別»` に統一 (何が伏せられたか分かるが値は出さない)。
 * - 完全網羅は狙わない (誤検知より「明らかな鍵を漏らさない」を優先する保守的セット)。
 */

/** 1 テキストあたりの既定サイズ上限 (文字)。超過分は末尾を `…` でトリム。 */
export const MAX_TEXT_CHARS = 2000;

export interface RedactionResult {
  /** マスク後のテキスト */
  text: string;
  /** マスクした箇所数 (0 なら無改変) */
  redactions: number;
}

interface Rule {
  kind: string;
  re: RegExp;
  /** マッチ全体を置換するか、部分 (prefix を残す) かをコールバックで表現 */
  replace: (kind: string) => (match: string, ...groups: string[]) => string;
}

const MASK = (kind: string) => `«redacted:${kind}»`;

// 適用順は配列順。広域 (private key ブロック) → 個別鍵 → ヘッダ → env KEY=val の順で、
// 個別の値を確実にマスクしてから汎用パターンに渡す。
const RULES: Rule[] = [
  // -----BEGIN ... PRIVATE KEY----- ... -----END ... PRIVATE KEY-----
  {
    kind: 'private-key',
    re: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
    replace: k => () => MASK(k),
  },
  // Anthropic: sk-ant-...
  { kind: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g, replace: k => () => MASK(k) },
  // Google API key: AIza...
  { kind: 'google-key', re: /AIza[A-Za-z0-9_-]{20,}/g, replace: k => () => MASK(k) },
  // GitHub token: ghp_/gho_/ghu_/ghs_/ghr_...
  { kind: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{20,}/g, replace: k => () => MASK(k) },
  // Slack token: xoxb-/xoxa-/xoxp-/xoxr-/xoxs-...
  { kind: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replace: k => () => MASK(k) },
  // AWS access key id: AKIA + 16 [0-9A-Z]
  { kind: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g, replace: k => () => MASK(k) },
  // 汎用 OpenAI 風 sk-... (sk-ant は上で処理済み)
  { kind: 'api-key', re: /\bsk-[A-Za-z0-9]{20,}\b/g, replace: k => () => MASK(k) },
  // Authorization: <value> / authorization=<value> (行末まで = "Bearer xxx" ごとマスク)
  // Bearer ルールより先に当てて二重マスクを避ける。
  {
    kind: 'authorization',
    re: /\b(Authorization\s*[:=]\s*)(\S.*)/gi,
    replace: k => (_m, prefix) => `${prefix}${MASK(k)}`,
  },
  // 単独の Bearer <token> (Authorization 行以外)
  {
    kind: 'bearer-token',
    re: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{10,}=*/g,
    replace: k => (_m, prefix) => `${prefix}${MASK(k)}`,
  },
  // .env 風 KEY=value で、KEY 名が秘匿語を含むもの → 値だけマスク
  {
    kind: 'secret',
    re: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|APIKEY|CREDENTIAL|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)[A-Z0-9_]*)(\s*[:=]\s*)(["']?)([^\s"']+)\3/gi,
    replace: k => (_m, key, sep) => `${key}${sep}${MASK(k)}`,
  },
];

/**
 * 入力テキストに redaction を適用する。マスクした箇所数も返す。
 */
export function redact(input: string): RedactionResult {
  if (!input) return { text: input ?? '', redactions: 0 };
  let text = input;
  let redactions = 0;
  for (const rule of RULES) {
    const fn = rule.replace(rule.kind);
    text = text.replace(rule.re, (...args: unknown[]) => {
      redactions++;
      // args = [match, ...groups, offset, fullString]
      const match = args[0] as string;
      const groups = args.slice(1, -2) as string[];
      return fn(match, ...groups);
    });
  }
  return { text, redactions };
}

/**
 * 文字列を `maxChars` で切り詰める (末尾 `…`)。改行は保持。
 */
export function truncate(input: string, maxChars: number = MAX_TEXT_CHARS): string {
  if (!input) return input ?? '';
  if (input.length <= maxChars) return input;
  return input.slice(0, maxChars) + '…';
}

/**
 * redaction → サイズ上限の順で本文を整える、送信前の標準処理。
 * 先に redaction するのは、トリムでマスク対象が途中で切れて検知漏れするのを防ぐため。
 */
export function sanitizeText(input: string, maxChars: number = MAX_TEXT_CHARS): string {
  return truncate(redact(input).text, maxChars);
}
