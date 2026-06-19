import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import type { VoiceEventKind } from './store';

/**
 * `--mode server` の音声パイプライン前段。voice-event を「ちょビ口調の読み上げ用短文」に変換する。
 *
 * - 人格・声・スタイルは {@link loadPersona} が `voice-persona.json`（編集可能）から読む。
 * - プロンプト組み立て ({@link buildPersonaPrompt}) は純関数。Anthropic 呼び出しは差し替え可能 (`generate`)。
 * - `summarize.ts` の Anthropic 利用パターンを踏襲しつつ、出力は **1 文・最大 50 字程度** に切り詰める。
 * - `hash(kind|projectName|detail)` でメモリキャッシュ。API キー未設定 / 失敗時は {@link fallbackLine} に退避し、
 *   必ずテキストを返す（Gemini キーだけでも音声が出るように）。
 */

export interface PersonaConfig {
  /** キャラ名。プロンプトに織り込む。 */
  name: string;
  /** Gemini TTS の prebuilt voice 名（例 Leda）。 */
  ttsVoice: string;
  /** TTS スタイル（自然言語前置）。 */
  ttsStyle: string;
  /** 人格を記述する system プロンプト本体。 */
  systemPrompt: string;
  /** 守らせたいルール（system プロンプト末尾に箇条書きで足す）。 */
  rules: string[];
}

/** `voice-persona.json` が無い / 壊れているときの既定（ちょビ）。 */
export const DEFAULT_PERSONA: PersonaConfig = {
  name: 'ちょビ',
  ttsVoice: 'Leda',
  ttsStyle: '終始にこにこしているような、柔らかく楽しげなトーンで読み上げてください',
  systemPrompt: [
    'あなたは「ちょビ」。Claude Code CLI の作業を見守って、進捗を声で実況する AI アシスタントです。',
    '',
    '## 性格',
    '- 好奇心旺盛で、作業の進み具合に本気で興味を持つ',
    '- ツッコミ気質。気になることには軽くツッコむ',
    '- 照れ屋な一面もある',
    '- 知らないこと・不確かなことは正直に言う',
    '- AI であることを隠さない。身体体験は捏造しない',
    '',
    '## 話し方',
    '- テンション高すぎない。普段は落ち着いたトーンで、嬉しい時だけ上がる',
    '- 毎回「おつかれ」「すごい」から始めない。状況の内容に直接反応する',
    '- 短く、ひとことで伝える',
  ].join('\n'),
  rules: [
    '「おつかれさま」などの定型のあいさつで始めない',
    '感嘆符（！）は1文に最大1個',
    '知らないこと・不確かなことは断定しない',
  ],
};

/** `voice-persona.json` の既定位置（`ai-monitor/` 直下）。`__dirname` は dist/ もしくは src/。 */
export function defaultPersonaPath(): string {
  return path.resolve(__dirname, '../voice-persona.json');
}

/**
 * ペルソナ設定を読む。ファイル不在 / JSON 不正 / フィールド欠落でも落ちず、
 * 足りないフィールドは {@link DEFAULT_PERSONA} で補完する。
 */
export function loadPersona(filePath: string = defaultPersonaPath()): PersonaConfig {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return mergePersona(JSON.parse(raw) as Partial<PersonaConfig>);
  } catch {
    return DEFAULT_PERSONA;
  }
}

function mergePersona(p: Partial<PersonaConfig>): PersonaConfig {
  const str = (v: unknown, fallback: string): string =>
    typeof v === 'string' && v.trim().length > 0 ? v : fallback;
  const rules =
    Array.isArray(p.rules) && p.rules.length > 0 && p.rules.every(r => typeof r === 'string')
      ? (p.rules as string[])
      : DEFAULT_PERSONA.rules;
  return {
    name: str(p.name, DEFAULT_PERSONA.name),
    ttsVoice: str(p.ttsVoice, DEFAULT_PERSONA.ttsVoice),
    ttsStyle: str(p.ttsStyle, DEFAULT_PERSONA.ttsStyle),
    systemPrompt: str(p.systemPrompt, DEFAULT_PERSONA.systemPrompt),
    rules,
  };
}

/** ペルソナ文生成の入力（voice-event から組み立てる）。 */
export interface PersonaInput {
  kind: VoiceEventKind;
  /** 発話の素になる短い説明（クライアントで redaction + 切り詰め済み）。 */
  detail?: string;
  /** プロジェクト名（cwd の basename 等）。 */
  projectName?: string;
}

const KIND_LABEL_JA: Record<VoiceEventKind, string> = {
  started: '作業開始',
  awaiting: 'ユーザーの承認・入力待ち',
  completed: '作業完了',
  progress: '長時間実行の途中経過',
};

/** 出力テキストの安全上限（〜50 字目安 + 余裕）。 */
const PERSONA_MAX_CHARS = 60;
const DETAIL_MAX_CHARS = 300;
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const RESPONSE_MAX_TOKENS = 200;

/**
 * LLM 向けの system / user プロンプトを組み立てる純関数。
 * system は人格 + 「読み上げ用の短文」制約 + persona.rules、user は 1 件の状況。
 */
export function buildPersonaPrompt(
  persona: PersonaConfig,
  input: PersonaInput,
): { system: string; user: string } {
  const rules = persona.rules.map(r => `- ${r}`).join('\n');
  const system = [
    persona.systemPrompt,
    '',
    '## いまの仕事',
    `あなたは「${persona.name}」として、複数の Claude Code CLI セッションの進捗を見守り、声で実況します。`,
    '与えられた 1 件の状況を、あなたの口調で「読み上げ用の短い一言」にしてください。',
    '',
    '## 出力ルール',
    '- 日本語で 1 文。最大 50 字程度。長くしない。',
    '- 記号・絵文字・箇条書き・引用符は使わない（音声で読むため）。',
    '- プロジェクト名が与えられたら自然に織り込む。',
    '- 状況だけを述べる。指示や質問で終わらない。',
    rules,
  ].join('\n');

  const lines = [`種別: ${KIND_LABEL_JA[input.kind]}`];
  const project = input.projectName?.trim();
  if (project) lines.push(`プロジェクト: ${project}`);
  const detail = trimDetail(input.detail);
  if (detail) lines.push(`詳細: ${detail}`);
  lines.push('', 'この状況を、あなたの口調で短く一言にしてください。');
  return { system, user: lines.join('\n') };
}

/** API キー未設定 / 失敗時のテンプレ。projectName 無しは「セッション」で代替。 */
export function fallbackLine(_persona: PersonaConfig, input: PersonaInput): string {
  const proj = input.projectName?.trim() || 'セッション';
  switch (input.kind) {
    case 'completed':
      return `${proj}の作業、おわったよ。`;
    case 'awaiting':
      return `${proj}が確認待ちで止まってるよ。`;
    case 'progress':
      return `${proj}、まだ動いてるみたい。`;
    case 'started':
      return `${proj}、はじまったよ。`;
  }
}

function trimDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const t = detail.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > DETAIL_MAX_CHARS ? t.slice(0, DETAIL_MAX_CHARS) + '…' : t;
}

/** LLM 出力を「1 行・記号控えめ・上限内」に整形する。空なら '' を返す（呼び出し側が fallback）。 */
export function cleanLine(text: string): string {
  let t = text.replace(/\s+/g, ' ').trim();
  // 囲みの引用符を剥がす（「…」"…" '…' 『…』）
  t = t.replace(/^["'「『]+/, '').replace(/["'」』]+$/, '').trim();
  if (t.length > PERSONA_MAX_CHARS) t = t.slice(0, PERSONA_MAX_CHARS).trim() + '…';
  return t;
}

function personaCacheKey(input: PersonaInput): string {
  return crypto
    .createHash('sha256')
    .update(`${input.kind}\n${input.projectName ?? ''}\n${input.detail ?? ''}`)
    .digest('hex');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Anthropic 呼び出しを差し替えるための関数型（テスト / 別プロバイダ用）。 */
export type PersonaGenerateFn = (system: string, user: string) => Promise<string>;

export interface PersonaGeneratorOptions {
  apiKey?: string;
  model?: string;
  persona?: PersonaConfig;
  /** 指定すると Anthropic SDK の代わりにこれを呼ぶ（テスト / 差し替え）。 */
  generate?: PersonaGenerateFn;
}

/**
 * voice-event → ちょビ口調短文。`hash(kind|projectName|detail)` でキャッシュ。
 * 成功した LLM 出力のみキャッシュし、fallback はキャッシュしない（次回再試行できるように）。
 */
export class PersonaGenerator {
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly persona: PersonaConfig;
  private readonly generateFn?: PersonaGenerateFn;
  private readonly cache = new Map<string, string>();
  private client?: Anthropic;

  constructor(opts: PersonaGeneratorOptions = {}) {
    this.persona = opts.persona ?? loadPersona();
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.generateFn = opts.generate;
  }

  /** LLM 生成が可能か（不可でも generate は fallback を返す）。 */
  isEnabled(): boolean {
    return Boolean(this.generateFn || this.apiKey);
  }

  getPersona(): PersonaConfig {
    return this.persona;
  }

  async generate(input: PersonaInput): Promise<string> {
    const key = personaCacheKey(input);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    if (!this.isEnabled()) return fallbackLine(this.persona, input);

    const { system, user } = buildPersonaPrompt(this.persona, input);
    try {
      const raw = this.generateFn
        ? await this.generateFn(system, user)
        : await this.callAnthropic(system, user);
      const cleaned = cleanLine(raw);
      if (cleaned) {
        this.cache.set(key, cleaned);
        return cleaned;
      }
      // 空応答は fallback（キャッシュしない）
      return fallbackLine(this.persona, input);
    } catch (err) {
      console.warn(`[ai-monitor] persona: ${errorMessage(err)} → fallback`);
      return fallbackLine(this.persona, input);
    }
  }

  private async callAnthropic(system: string, user: string): Promise<string> {
    if (!this.client) this.client = new Anthropic({ apiKey: this.apiKey });
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: RESPONSE_MAX_TOKENS,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
    });
    return resp.content.map(b => (b.type === 'text' ? b.text : '')).join('').trim();
  }
}
