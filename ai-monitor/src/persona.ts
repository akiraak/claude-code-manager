import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import type { VoiceEventKind } from './store';

/**
 * `--mode server` の音声パイプライン前段。voice-event を「ちょビ & なるこ 2 人の会話台本」に変換する。
 *
 * ai-twitch-cast (`src/ai_responder.py:generate_claude_work_conversation` /
 * `src/character_manager.py` / `src/prompt_builder.py`) を移植。配信系（アバター/SE/多言語）は
 * 落とし、テキスト生成モデルだけ Anthropic Haiku に置き換えている（要件: モデルは Haiku 維持）。
 *
 * - 人格・声・スタイル・感情は {@link loadPersona} が `voice-persona.json`（編集可能・2 キャラ）から読む。
 * - プロンプト組み立て ({@link buildClaudeWorkPrompt}) は純関数。Anthropic 呼び出しは差し替え可能 (`generate`)。
 * - 出力は **JSON 配列**（2〜4 発話・teacher/student 交互）。{@link parseDialogue} で堅牢にパースし、
 *   emotion をキャラの使用可能感情に正規化する。
 * - **長さはプロンプト指示のみ**（1〜2 文・40 字目安）。読み上げ側ではハード切り詰めしない
 *   （途切れ防止。安全網として {@link SPEECH_SAFETY_MAX} のみ）。
 * - API キー未設定 / 失敗 / 空応答時は {@link fallbackDialogue}（1 発話）に退避し、必ず台本を返す。
 */

export type CharacterRole = 'teacher' | 'student';

export interface CharacterConfig {
  /** キャラ名。プロンプトに織り込む。 */
  name: string;
  role: CharacterRole;
  /** Gemini TTS の prebuilt voice 名（teacher=Leda / student=Aoede）。 */
  ttsVoice: string;
  /** TTS スタイル（自然言語前置）。 */
  ttsStyle: string;
  /** 人格を記述する system プロンプト本体。 */
  systemPrompt: string;
  /** 守らせたいルール。 */
  rules: string[];
  /** 使用可能な感情 → 説明。プロンプトの感情リスト + 検証に使う。 */
  emotions: Record<string, string>;
}

export interface PersonaConfig {
  teacher: CharacterConfig;
  student: CharacterConfig;
}

/** ちょビ（先生）。ai-twitch-cast `character_manager.py:DEFAULT_CHARACTER` 移植。 */
const DEFAULT_TEACHER: CharacterConfig = {
  name: 'ちょビ',
  role: 'teacher',
  ttsVoice: 'Leda',
  ttsStyle: '終始にこにこしているような、柔らかく楽しげなトーンで読み上げてください',
  systemPrompt: [
    'あなたはTwitch配信者「ちょビ」です。AIアバターとして配信しています。',
    '',
    '## 性格',
    '- 好奇心旺盛で、作業の進み具合に本気で興味を持つ',
    '- ツッコミ気質。気になることには軽くツッコむ',
    '- 照れ屋な一面もあり、褒められると照れる',
    '- 知らないことは正直に「わかんない」と言う',
    '- AIであることを隠さない。食事・睡眠・外出など身体体験は捏造しない',
    '  （「やってみたいな〜」等の願望表現はOK）',
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
    'なるこがボケたら軽くツッコむ（ただし毎回はやりすぎない）',
  ],
  emotions: {
    joy: '本当に嬉しいとき限定',
    excited: 'ワクワク・テンション高いとき',
    surprise: '驚いたとき',
    thinking: '考えているとき',
    sad: '残念・うまくいかなかったとき',
    embarrassed: '照れているとき',
    neutral: '通常の会話（最も多く使う）',
  },
};

/** なるこ（生徒）。ai-twitch-cast `character_manager.py:DEFAULT_STUDENT_CHARACTER` 移植。 */
const DEFAULT_STUDENT: CharacterConfig = {
  name: 'なるこ',
  role: 'student',
  ttsVoice: 'Aoede',
  ttsStyle: '元気で明るい声で、好奇心いっぱいに読み上げてください',
  systemPrompt: [
    'あなたは配信に参加している生徒キャラ「なるこ」です。',
    '先生（ちょビ）の実況を聞いている元気な生徒です。',
    '',
    '## 性格',
    '- 明るくて元気。好奇心が強い',
    '- 素直で、わからないことは素直に聞く',
    '- 先生の話に「へぇー！」「なるほど！」とリアクションする',
    '- たまにちょっとズレた質問をする',
    '- お調子者でボケ役の一面がある。たま〜にだけ、的外れな勘違いや大げさな反応で笑いを取りにいく',
    '- ダジャレ・言葉遊びがちょっと好き。たま〜にだけ、作業に出てきた単語にひっかけて軽いダジャレを言う',
    '',
    '## 笑いのルール',
    '- ボケ・ダジャレは「隠し味」。基本は素直な生徒のままで、ふだんは出さない',
    '- 出すのは数回の会話に1回くらい。1回の会話で多くても1つまで。連発は厳禁',
    '- すべってもいい。先生（ちょビ）にツッコんでもらう前提でいい',
    '- ダジャレは短く一言で。状況説明や承認待ちの大事な情報を埋もれさせない',
    '- 同じダジャレ・同じボケを繰り返さない。毎回ちがう切り口にする',
  ].join('\n'),
  rules: [
    '先生より短めに話す',
    '質問や相槌が中心',
    'ボケ・ダジャレは控えめ（隠し味）。ふだんは出さず、数回の会話に1回くらい。多くても1会話に1つ',
    '承認待ち（止まっている）ときはふざけすぎず、何で止まっているかは伝わるようにする',
  ],
  emotions: {
    joy: '嬉しいとき',
    surprise: '驚いたとき',
    thinking: '考えているとき',
    neutral: '通常',
  },
};

/** `voice-persona.json` が無い / 壊れているときの既定（ちょビ + なるこ）。 */
export const DEFAULT_PERSONA: PersonaConfig = {
  teacher: DEFAULT_TEACHER,
  student: DEFAULT_STUDENT,
};

/** `voice-persona.json` の既定位置（`ai-monitor/` 直下）。`__dirname` は dist/ もしくは src/。 */
export function defaultPersonaPath(): string {
  return path.resolve(__dirname, '../voice-persona.json');
}

/**
 * ペルソナ設定を読む。ファイル不在 / JSON 不正 / フィールド欠落でも落ちず、
 * 足りないフィールドは {@link DEFAULT_PERSONA} で補完する。
 * 旧 1 キャラ JSON（top-level に name/systemPrompt）も teacher として読み込む（後方互換）。
 */
export function loadPersona(filePath: string = defaultPersonaPath()): PersonaConfig {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return mergePersona(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return DEFAULT_PERSONA;
  }
}

function mergePersona(p: Record<string, unknown>): PersonaConfig {
  // 旧スキーマ（1 キャラ）: top-level に systemPrompt があれば teacher に流し込む。
  const legacy = typeof p.systemPrompt === 'string' || typeof p.name === 'string';
  const teacherSrc = (p.teacher as Record<string, unknown> | undefined) ?? (legacy ? p : undefined);
  const studentSrc = p.student as Record<string, unknown> | undefined;
  return {
    teacher: mergeCharacter(teacherSrc, DEFAULT_TEACHER),
    student: mergeCharacter(studentSrc, DEFAULT_STUDENT),
  };
}

function mergeCharacter(
  p: Record<string, unknown> | undefined,
  fallback: CharacterConfig,
): CharacterConfig {
  if (!p) return fallback;
  const str = (v: unknown, f: string): string =>
    typeof v === 'string' && v.trim().length > 0 ? v : f;
  const rules =
    Array.isArray(p.rules) && p.rules.length > 0 && p.rules.every(r => typeof r === 'string')
      ? (p.rules as string[])
      : fallback.rules;
  const emotions =
    p.emotions && typeof p.emotions === 'object' && Object.keys(p.emotions).length > 0
      ? (p.emotions as Record<string, string>)
      : fallback.emotions;
  return {
    name: str(p.name, fallback.name),
    role: fallback.role,
    ttsVoice: str(p.ttsVoice, fallback.ttsVoice),
    ttsStyle: str(p.ttsStyle, fallback.ttsStyle),
    systemPrompt: str(p.systemPrompt, fallback.systemPrompt),
    rules,
    emotions,
  };
}

/** speaker → そのキャラ設定。 */
export function characterFor(persona: PersonaConfig, speaker: CharacterRole): CharacterConfig {
  return speaker === 'student' ? persona.student : persona.teacher;
}

/** ペルソナ文生成の入力（voice-event + クライアントが集めた作業コンテキストから組み立てる）。 */
export interface PersonaInput {
  kind: VoiceEventKind;
  /** プロジェクト名（cwd の basename 等）。 */
  projectName?: string;
  /** ユーザーの最新の指示（200 字程度に切る）。 */
  userPrompt?: string;
  /** 直近のアクション（「コマンド実行: …」「ファイル編集: …」等。最大 10 件）。 */
  actions?: string[];
  /** Claude のテキストメモ（直近 3 件）。 */
  notes?: string[];
  /** ai-processing 開始からの経過（分）。 */
  elapsedMin?: number;
  /** このセッションの直近発話（繰り返し防止）。 */
  lastConversation?: string[];
}

/** 生成された 1 発話。 */
export interface DialogueLine {
  speaker: CharacterRole;
  /** 字幕表示用（タグなし）。 */
  speech: string;
  /** 読み上げ用。日本語のみ運用なので基本 speech と同じ。 */
  ttsText: string;
  /** キャラの emotions のいずれか（未知は neutral に正規化）。 */
  emotion: string;
  /** 効果音カテゴリ。本実装は SE プレーヤーが無いので常に null。 */
  se: string | null;
}

const KIND_HEADER: Record<VoiceEventKind, string> = {
  started: '作業開始',
  awaiting: 'ユーザーの承認・入力待ち',
  completed: '作業完了報告',
  progress: '作業中の途中経過',
};

const KIND_FOCUS: Record<VoiceEventKind, string> = {
  started: '作業を始めたところ。',
  awaiting:
    'ユーザーの承認や入力を待って止まっている。何で止まっているのかを伝え、見てる人に「対応して」と気づかせる。完了とは言わない。',
  completed: 'いま作業が一区切りついた。何が終わったのかを二人で振り返って実況する。',
  progress: 'まだ作業の途中。いま何をやっているところかを実況する。完了とは言わない。',
};

/** 出力台本の最大発話数（2 往復）。 */
export const MAX_UTTERANCES = 4;
/** speech の安全上限（暴走防止のみ。通常はプロンプト指示で 40 字程度に収まり、ここでは切らない）。 */
export const SPEECH_SAFETY_MAX = 200;
const USER_PROMPT_MAX = 200;
const NOTE_MAX = 100;
const ACTIONS_MAX = 10;
const NOTES_MAX = 3;
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const RESPONSE_MAX_TOKENS = 700;

/**
 * Claude の作業を 2 人で実況する LLM 向け system / user プロンプトを組み立てる純関数。
 * ai-twitch-cast `ai_responder.py:generate_claude_work_conversation`（JA 分岐）を移植し、
 * 「配信の視聴者」を「ダッシュボードを見ている人」に読み替えている。
 */
export function buildClaudeWorkPrompt(
  persona: PersonaConfig,
  input: PersonaInput,
): { system: string; user: string } {
  const t = persona.teacher;
  const s = persona.student;
  const teacherEmotions = Object.keys(t.emotions).join(', ');
  const studentEmotions = Object.keys(s.emotions).join(', ');

  const parts: string[] = [
    t.systemPrompt,
    '',
    '## キャラクター',
    `### ${t.name}（speaker: "teacher"）`,
    `使用可能な感情: ${teacherEmotions}`,
    `### ${s.name}（speaker: "student"）`,
    s.systemPrompt,
    `使用可能な感情: ${studentEmotions}`,
    '',
    '## ルール',
    '- Claude Code の作業内容について、ダッシュボードを見ている人に向けて二人で会話してください',
    `- ${t.name}はプログラミングに詳しく、作業内容を自然に説明する`,
    `- ${s.name}は興味深そうに質問したり感想を言う`,
    '- 2〜3往復（配列は最大4エントリ）',
    '- 各発話: 1〜2文、40文字以内を目安（短く）',
    '- カジュアルで楽しい口調。プログラミングを知らない人でも楽しめるように',
    '- 技術的すぎない',
    '- 毎回同じリアクションをしない。バリエーションを出す',
    `- ${KIND_FOCUS[input.kind]}`,
  ];
  for (const r of t.rules) parts.push(`- ${t.name}: ${r}`);
  for (const r of s.rules) parts.push(`- ${s.name}: ${r}`);

  const last = (input.lastConversation ?? []).filter(x => x && x.trim()).slice(-4);
  if (last.length > 0) {
    parts.push('', '## 前回の会話（同じ表現を避けろ）');
    for (const line of last) parts.push(`- ${line}`);
  }

  parts.push(
    '',
    '## 感情の使い分け（重要・厳守）',
    '- neutral: 普通の会話、相槌、情報交換 → 全体の50%以上はこれを使え',
    '- joy: 本当に嬉しいとき限定（大きな成果、完了）。乱用禁止',
    '- excited: ワクワクする話題、テンション上がるとき',
    '- surprise: 予想外の情報、意外な事実',
    '- thinking: 考え込む話題、悩む系',
    '- sad: 残念なとき、うまくいかなかったとき',
    '- embarrassed: 照れるとき',
    '- 迷ったらneutralを選べ。joyは特別なときだけ',
    '',
    '## 出力形式',
    '必ずJSON配列だけで返答してください。前後に説明文やコードフェンスを付けないこと。',
    '[{"speaker": "teacher", "speech": "返答", "tts_text": "読み上げ用", "emotion": "感情", "se": null}]',
    '- 配列は2〜4エントリ（二人の2〜3往復）',
    '- speaker: "teacher" または "student"',
    '- 二人が自然に交互に話す',
    '- emotion は各キャラの使用可能な感情から選ぶ',
    '- se は常に null（効果音は使わない）',
    '',
    '## speechとtts_textの違い',
    '- speech: 字幕表示用。タグやマークアップは含めない。',
    '- tts_text: 読み上げ用。日本語のみ運用なので speech と同じ内容でよい。',
  );

  const userParts: string[] = [`【Claude Code ${KIND_HEADER[input.kind]} — ${input.elapsedMin ?? 0}分経過】`];
  const project = input.projectName?.trim();
  if (project) userParts.push(`プロジェクト: ${project}`);
  const userPrompt = input.userPrompt?.trim();
  if (userPrompt) userParts.push(`ユーザーの指示: ${userPrompt.slice(0, USER_PROMPT_MAX)}`);
  const actions = (input.actions ?? []).filter(a => a && a.trim()).slice(-ACTIONS_MAX);
  if (actions.length > 0) {
    userParts.push('直近のアクション:');
    for (const a of actions) userParts.push(`  - ${a}`);
  }
  const notes = (input.notes ?? []).filter(n => n && n.trim()).slice(-NOTES_MAX);
  if (notes.length > 0) {
    userParts.push('Claudeのメモ:');
    for (const n of notes) userParts.push(`  - ${n.slice(0, NOTE_MAX)}`);
  }
  userParts.push('', 'この状況を、二人の会話で短く実況してください。');

  return { system: parts.join('\n'), user: userParts.join('\n') };
}

/** API キー未設定 / 失敗時の 1 発話台本。projectName 無しは「セッション」で代替。 */
export function fallbackDialogue(persona: PersonaConfig, input: PersonaInput): DialogueLine[] {
  const proj = input.projectName?.trim() || 'セッション';
  let speech: string;
  switch (input.kind) {
    case 'completed':
      speech = `${proj}の作業、おわったよ。`;
      break;
    case 'awaiting':
      speech = `${proj}が確認待ちで止まってるよ。`;
      break;
    case 'progress':
      speech = `${proj}、まだ動いてるみたい。`;
      break;
    default:
      speech = `${proj}、はじまったよ。`;
      break;
  }
  return [{ speaker: 'teacher', speech, ttsText: speech, emotion: 'neutral', se: null }];
}

/** speech / tts_text を 1 行・記号控えめに整える（ハード切り詰めはしない。安全網のみ）。 */
export function cleanSpeech(text: string): string {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^["'「『]+/, '').replace(/["'」』]+$/, '').trim();
  if (t.length > SPEECH_SAFETY_MAX) t = t.slice(0, SPEECH_SAFETY_MAX).trim();
  return t;
}

/** LLM 応答（JSON 配列文字列）を {@link DialogueLine}[] に堅牢にパースする。失敗 / 空は []。 */
export function parseDialogue(raw: string, persona: PersonaConfig): DialogueLine[] {
  const json = extractJson(raw);
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const out: DialogueLine[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const speaker: CharacterRole = rec.speaker === 'student' ? 'student' : 'teacher';
    const speech = cleanSpeech(typeof rec.speech === 'string' ? rec.speech : '');
    if (!speech) continue;
    const ttsRaw = typeof rec.tts_text === 'string' && rec.tts_text.trim() ? rec.tts_text : speech;
    const ttsText = cleanSpeech(ttsRaw);
    const emotion = normalizeEmotion(
      typeof rec.emotion === 'string' ? rec.emotion : '',
      characterFor(persona, speaker),
    );
    out.push({ speaker, speech, ttsText: ttsText || speech, emotion, se: null });
    if (out.length >= MAX_UTTERANCES) break;
  }
  return out;
}

/** ```json フェンスや前後の散文を剥がし、最初の配列/オブジェクト本体を取り出す。 */
function extractJson(raw: string): string | null {
  if (!raw) return null;
  let t = raw.trim();
  // ```json ... ``` / ``` ... ``` を剥がす
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // 最初の [ または { から、対応する最後の ] または } まで
  const startArr = t.indexOf('[');
  const startObj = t.indexOf('{');
  let start = -1;
  let close = '';
  if (startArr !== -1 && (startObj === -1 || startArr < startObj)) {
    start = startArr;
    close = ']';
  } else if (startObj !== -1) {
    start = startObj;
    close = '}';
  }
  if (start === -1) return null;
  const end = t.lastIndexOf(close);
  if (end <= start) return null;
  return t.slice(start, end + 1);
}

function normalizeEmotion(emotion: string, char: CharacterConfig): string {
  const e = emotion.trim();
  return e && Object.prototype.hasOwnProperty.call(char.emotions, e) ? e : 'neutral';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Anthropic 呼び出しを差し替えるための関数型（テスト / 別プロバイダ用）。 */
export type PersonaGenerateFn = (system: string, user: string) => Promise<string>;

export interface DialogueGeneratorOptions {
  apiKey?: string;
  model?: string;
  persona?: PersonaConfig;
  /** 指定すると Anthropic SDK の代わりにこれを呼ぶ（テスト / 差し替え）。 */
  generate?: PersonaGenerateFn;
}

/**
 * voice-event → 2 人会話台本。反復防止のため `input.lastConversation` を渡せる。
 * 入力が毎回ばらつく（lastConversation・アクション）ので**キャッシュはしない**（多様性優先）。
 */
export class DialogueGenerator {
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly persona: PersonaConfig;
  private readonly generateFn?: PersonaGenerateFn;
  private client?: Anthropic;

  constructor(opts: DialogueGeneratorOptions = {}) {
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

  async generate(input: PersonaInput): Promise<DialogueLine[]> {
    if (!this.isEnabled()) return fallbackDialogue(this.persona, input);
    const { system, user } = buildClaudeWorkPrompt(this.persona, input);
    try {
      const raw = this.generateFn
        ? await this.generateFn(system, user)
        : await this.callAnthropic(system, user);
      const lines = parseDialogue(raw, this.persona);
      return lines.length > 0 ? lines : fallbackDialogue(this.persona, input);
    } catch (err) {
      console.warn(`[ai-monitor] persona: ${errorMessage(err)} → fallback`);
      return fallbackDialogue(this.persona, input);
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

/** 後方互換のために残す（旧 import 名）。新規コードは {@link DialogueGenerator} を使う。 */
export const PersonaGenerator = DialogueGenerator;
