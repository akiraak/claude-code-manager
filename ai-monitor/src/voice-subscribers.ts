import type { VoiceEventKind } from './store';

/**
 * `--mode server` の **viewer 購読登録簿**。UI ゲーティング（種別チェックでサーバ側の生成を抑止する）の
 * コア。`run-ai-monitor-client.sh` の **発話元端末** (`clientId`) ではなく、**ブラウザでダッシュボードを
 * 見ている視聴者** (= subscriber, `sub`) ごとに「🔊 ON/OFF」と「希望する種別」を保持する。
 *
 * - `effectiveKinds(envAllow, now)` が「接続中（未失効）かつ enabled な viewer の希望種別の **和集合**」を
 *   env 天井 (`envAllow`) と **積集合**して返す（生成すべき種別）。viewer ゼロ / 全員 OFF → 空集合 = 無音。
 * - 時刻は `nowMs` 注入（内部で `Date.now()` を呼ばない。voice-store / 集約ストアと同方針）。
 * - SSE 切断の取りこぼしに備え、`lastSeen + TTL` を過ぎた sub は読み出し時に掃き出す（バックストップ）。
 */

/** viewer が読み上げを希望できる種別。`started` は対象外（要件上どの設定でも無音）。 */
export const SUBSCRIBABLE_KINDS: readonly VoiceEventKind[] = ['awaiting', 'completed', 'progress'];

/**
 * 購読の既定 TTL。SSE ping（30s）より十分長く取り、`req.on('close')` を取りこぼしても
 * いずれ確実に消えるようにするための **切断検出バックストップ**（通常は close / remove で即消える）。
 */
export const DEFAULT_SUBSCRIBER_TTL_MS = 90_000; // 90s

export interface SubscriberPrefs {
  /** 🔊 ON/OFF。false の viewer は union に寄与しない（接続はしているが聴いていない）。 */
  enabled: boolean;
  /** viewer が希望する種別。許可外（`started`/未知）は捨てる。 */
  kinds: readonly VoiceEventKind[] | readonly string[];
}

interface SubscriberEntry {
  kinds: Set<VoiceEventKind>;
  enabled: boolean;
  lastSeenMs: number;
}

/**
 * 任意入力（`?kinds` csv の split 結果 / prefs body）を **許可種別のみ**の Set に正規化する純関数。
 * `started` / 未知 / 非文字列 / 重複を落とす（registry へ入れる前段の防御。ingest 側でも再検証する）。
 */
export function sanitizeKinds(kinds: unknown): Set<VoiceEventKind> {
  const allowed = new Set<VoiceEventKind>(SUBSCRIBABLE_KINDS);
  const out = new Set<VoiceEventKind>();
  if (!Array.isArray(kinds)) return out;
  for (const k of kinds) {
    if (typeof k !== 'string') continue;
    const v = k.trim().toLowerCase();
    if (allowed.has(v as VoiceEventKind)) out.add(v as VoiceEventKind);
  }
  return out;
}

/** `POST /api/voice/prefs` の検証済み body。kinds は許可種別のみへ正規化済み。 */
export interface VoicePrefsBody {
  sub: string;
  enabled: boolean;
  kinds: VoiceEventKind[];
}

/** sub 識別子の最大長（sessionStorage 由来の短い乱数を想定。異常に長い値を弾く）。 */
export const MAX_SUB_LEN = 128;
/** kinds 配列の最大要素数（種別は高々数個。異常に長い配列を安く弾く）。 */
export const MAX_PREFS_KINDS = 16;

/**
 * `POST /api/voice/prefs` の body を **厳格検証**する純関数（テスト可能）。
 * - object でない / `sub` が非文字列・空・長すぎ / `enabled` が非 boolean / `kinds` が配列でない・長すぎ
 *   → `null`（呼び出し側は 400）。
 * - `kinds` は {@link sanitizeKinds} で許可種別のみへ正規化（`started`/未知は捨てる）。
 *   空配列は許容する（= 全種別 OFF 相当。enabled だが何も希望しない viewer）。
 */
export function parseVoicePrefsBody(body: unknown): VoicePrefsBody | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.sub !== 'string') return null;
  const sub = b.sub.trim();
  if (sub.length === 0 || sub.length > MAX_SUB_LEN) return null;
  if (typeof b.enabled !== 'boolean') return null;
  if (!Array.isArray(b.kinds) || b.kinds.length > MAX_PREFS_KINDS) return null;
  return { sub, enabled: b.enabled, kinds: Array.from(sanitizeKinds(b.kinds)) };
}

export interface VoiceSubscriberRegistryOptions {
  /** 切断検出バックストップ TTL(ms)。既定 {@link DEFAULT_SUBSCRIBER_TTL_MS}。 */
  ttlMs?: number;
}

export class VoiceSubscriberRegistry {
  private readonly subs = new Map<string, SubscriberEntry>();
  private readonly ttlMs: number;

  constructor(opts: VoiceSubscriberRegistryOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_SUBSCRIBER_TTL_MS;
  }

  /**
   * sub を登録 / 上書きする（冪等な upsert）。`register`（SSE 接続時の seed）と
   * `update`（prefs POST）は同義で、どちらも prefs を丸ごと差し替える。空 `sub` は無視。
   */
  register(sub: string, prefs: SubscriberPrefs, nowMs: number): void {
    this.upsert(sub, prefs, nowMs);
  }

  update(sub: string, prefs: SubscriberPrefs, nowMs: number): void {
    this.upsert(sub, prefs, nowMs);
  }

  private upsert(sub: string, prefs: SubscriberPrefs, nowMs: number): void {
    if (!sub) return;
    this.subs.set(sub, {
      kinds: sanitizeKinds(prefs.kinds),
      enabled: Boolean(prefs.enabled),
      lastSeenMs: nowMs,
    });
  }

  /**
   * 生存を更新する（SSE ping 等の契機。prefs は変えない）。未登録 sub は無視する
   * （登録は `register` で明示的に行う。ping だけで空 prefs の幽霊 viewer を作らない）。
   */
  touch(sub: string, nowMs: number): void {
    const e = this.subs.get(sub);
    if (e) e.lastSeenMs = nowMs;
  }

  /** sub を即時除去する（SSE `close` 時）。 */
  remove(sub: string): void {
    this.subs.delete(sub);
  }

  /**
   * 実際に生成すべき種別 = （接続中かつ enabled な viewer の希望種別の和集合）∩ `envAllow`。
   * 副作用で TTL 切れの sub を掃き出す。viewer ゼロ / 全員 OFF / 全員天井外 → 空集合（無音）。
   */
  effectiveKinds(envAllow: ReadonlySet<VoiceEventKind>, nowMs: number): Set<VoiceEventKind> {
    this.prune(nowMs);
    const out = new Set<VoiceEventKind>();
    for (const e of this.subs.values()) {
      if (!e.enabled) continue;
      for (const k of e.kinds) {
        if (envAllow.has(k)) out.add(k);
      }
    }
    return out;
  }

  /** TTL 切れの sub を除去する（読み出し系から呼ぶ）。 */
  prune(nowMs: number): void {
    const cutoff = nowMs - this.ttlMs;
    for (const [sub, e] of this.subs) {
      if (e.lastSeenMs < cutoff) this.subs.delete(sub);
    }
  }

  /** 現在の（未失効）viewer 数。effective ログの `viewers=N` 用。 */
  size(nowMs: number): number {
    this.prune(nowMs);
    return this.subs.size;
  }
}
