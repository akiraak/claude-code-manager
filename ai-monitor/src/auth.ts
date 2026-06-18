import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * `--mode server` の Ingestion API (`/api/ingest/*`) を保護する端末別 Bearer 認証。
 *
 * - トークンは `.env` の `CCM_CLIENT_TOKENS` にカンマ区切りで置く (端末ごとに 1 本)。
 * - 生成は `openssl rand -base64 32` 想定 (>= 16 文字を必須にして弱いトークンを弾く)。
 * - UI/閲覧系の認証は Cloudflare Access (email OTP) をインフラ層 (Phase 7) で掛ける方針なので、
 *   本モジュールは **マシン送信のための Bearer 検証のみ** を担う。
 *
 * `clientId` は payload 側から受け取る運用 (Phase 2 ではトークン→ラベル対応表は持たない)。
 */

/** トークンに要求する最小長 (これ未満が混じると fail-fast)。 */
export const MIN_TOKEN_LENGTH = 16;

/** `CCM_CLIENT_TOKENS` をカンマ区切りでパースし、trim + 空要素除去した配列を返す。 */
export function parseClientTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(t => t.trim())
    .filter(t => t.length > 0);
}

/**
 * server モード起動時の fail-fast チェック。問題があれば throw する (cli.ts が catch → exit 1)。
 * - トークンが 1 本も無い → 起動拒否。
 * - `MIN_TOKEN_LENGTH` 未満のトークンが混じる → 起動拒否。
 */
export function assertServerAuthConfigured(tokens: readonly string[]): void {
  if (tokens.length === 0) {
    throw new Error(
      'server モードには CCM_CLIENT_TOKENS が必要です (カンマ区切りの端末別トークン)。' +
        ' 生成例: openssl rand -base64 32',
    );
  }
  const short = tokens.filter(t => t.length < MIN_TOKEN_LENGTH);
  if (short.length > 0) {
    throw new Error(
      `CCM_CLIENT_TOKENS に短すぎるトークンがあります (>= ${MIN_TOKEN_LENGTH} 文字必須)。`,
    );
  }
}

/** `Authorization: Bearer <token>` ヘッダから token 部分だけを取り出す。無ければ null。 */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  // auth-scheme は RFC 7235 上 case-insensitive。
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

/**
 * 候補トークンが許可集合のいずれかと一致するかを、長さ依存以外のタイミング差を抑えて判定する。
 * (高エントロピーな base64 トークン前提だが、念のため `crypto.timingSafeEqual` で比較する。)
 */
export function isAuthorizedToken(candidate: string, tokens: readonly string[]): boolean {
  const cand = Buffer.from(candidate, 'utf-8');
  let ok = false;
  for (const t of tokens) {
    const buf = Buffer.from(t, 'utf-8');
    // 長さが違うと timingSafeEqual が throw するので長さ一致時のみ比較する。
    // 早期 return せず全候補を走査して、一致位置によるタイミング差も減らす。
    if (buf.length === cand.length && crypto.timingSafeEqual(buf, cand)) {
      ok = true;
    }
  }
  return ok;
}

/**
 * Bearer 認証ミドルウェアを作る。ヘッダ欠落 / 形式不正 / 不一致はすべて 401。
 * 成功時は何も付与せず next() する (clientId は payload から取るため)。
 */
export function bearerAuth(tokens: readonly string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = extractBearerToken(req.headers.authorization);
    if (!token || !isAuthorizedToken(token, tokens)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}
