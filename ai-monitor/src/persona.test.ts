import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildClaudeWorkPrompt,
  cleanSpeech,
  DEFAULT_PERSONA,
  DialogueGenerator,
  fallbackDialogue,
  loadPersona,
  parseDialogue,
  type PersonaInput,
} from './persona';

const input = (over: Partial<PersonaInput> = {}): PersonaInput => ({
  kind: 'completed',
  projectName: 'foo',
  ...over,
});

test('buildClaudeWorkPrompt: 2 キャラ定義・ルール・JSON 形式・感情ガイドを system に入れる', () => {
  const { system, user } = buildClaudeWorkPrompt(
    DEFAULT_PERSONA,
    input({
      userPrompt: 'バグを直して',
      actions: ['コマンド実行: npm test', 'ファイル編集: foo.ts'],
      notes: ['テストが通った'],
      elapsedMin: 3,
    }),
  );
  // system: 2 キャラ + speaker タグ + 感情 + JSON 形式
  assert.ok(system.includes(DEFAULT_PERSONA.teacher.name));
  assert.ok(system.includes(DEFAULT_PERSONA.student.name));
  assert.ok(system.includes('speaker: "teacher"'));
  assert.ok(system.includes('speaker: "student"'));
  assert.ok(system.includes('使用可能な感情'));
  assert.ok(system.includes('感情の使い分け'));
  assert.ok(system.includes('JSON配列'));
  // user: 種別ヘッダ・経過・プロジェクト・指示・アクション・メモ
  assert.ok(user.includes('作業完了報告'));
  assert.ok(user.includes('3分経過'));
  assert.ok(user.includes('プロジェクト: foo'));
  assert.ok(user.includes('ユーザーの指示: バグを直して'));
  assert.ok(user.includes('コマンド実行: npm test'));
  assert.ok(user.includes('ファイル編集: foo.ts'));
  assert.ok(user.includes('Claudeのメモ'));
});

test('buildClaudeWorkPrompt: kind ごとにヘッダとフォーカスが変わる', () => {
  const awaiting = buildClaudeWorkPrompt(DEFAULT_PERSONA, input({ kind: 'awaiting' }));
  assert.ok(awaiting.user.includes('ユーザーの承認・入力待ち'));
  assert.ok(awaiting.system.includes('止まっている'));
  const progress = buildClaudeWorkPrompt(DEFAULT_PERSONA, input({ kind: 'progress' }));
  assert.ok(progress.user.includes('作業中の途中経過'));
});

test('buildClaudeWorkPrompt: lastConversation があれば「繰り返すな」節を足す', () => {
  const { system } = buildClaudeWorkPrompt(
    DEFAULT_PERSONA,
    input({ lastConversation: ['さっきの発話A', 'さっきの発話B'] }),
  );
  assert.ok(system.includes('同じ表現を避けろ'));
  assert.ok(system.includes('さっきの発話A'));
});

test('parseDialogue: JSON 配列を DialogueLine[] にし、emotion を検証・最大 4 に制限', () => {
  const raw = JSON.stringify([
    { speaker: 'teacher', speech: 'A', tts_text: 'A', emotion: 'joy', se: null },
    { speaker: 'student', speech: 'B', emotion: 'unknown-emotion' },
    { speaker: 'teacher', speech: 'C', emotion: 'thinking' },
    { speaker: 'student', speech: 'D' },
    { speaker: 'teacher', speech: 'E' },
  ]);
  const lines = parseDialogue(raw, DEFAULT_PERSONA);
  assert.equal(lines.length, 4); // 5 件 → 4 に切る
  assert.equal(lines[0].speaker, 'teacher');
  assert.equal(lines[0].emotion, 'joy');
  // 未知の emotion は neutral に正規化
  assert.equal(lines[1].emotion, 'neutral');
  // tts_text 欠落は speech で補完
  assert.equal(lines[3].ttsText, 'D');
  // se は常に null
  assert.equal(lines[0].se, null);
});

test('parseDialogue: ```json フェンスや前後の散文があっても配列を取り出す', () => {
  const raw = 'はい！\n```json\n[{"speaker":"teacher","speech":"やったね"}]\n```\nどうぞ';
  const lines = parseDialogue(raw, DEFAULT_PERSONA);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].speech, 'やったね');
});

test('parseDialogue: 単一オブジェクトも配列化、壊れた JSON は空配列', () => {
  const one = parseDialogue('{"speaker":"student","speech":"へぇー"}', DEFAULT_PERSONA);
  assert.equal(one.length, 1);
  assert.equal(one[0].speaker, 'student');
  assert.deepEqual(parseDialogue('not json at all', DEFAULT_PERSONA), []);
});

test('cleanSpeech: 改行潰し・囲み引用符剥がし。短文はそのまま（ハード切り詰めしない）', () => {
  assert.equal(cleanSpeech('  やっ\nほー  '), 'やっ ほー');
  assert.equal(cleanSpeech('「完了したよ」'), '完了したよ');
  assert.equal(cleanSpeech('"done"'), 'done');
  // 40 字程度の通常文は丸ごと残る（途切れない）
  const normal = 'テストが全部とおって、ビルドも成功したから、これで安心して次に進めるよ。';
  assert.equal(cleanSpeech(normal), normal);
  assert.equal(cleanSpeech('   '), '');
});

test('fallbackDialogue: 種別ごとに 1 発話（teacher）、projectName 無しは「セッション」', () => {
  assert.match(fallbackDialogue(DEFAULT_PERSONA, input({ kind: 'completed' }))[0].speech, /foo/);
  const awaiting = fallbackDialogue(DEFAULT_PERSONA, { kind: 'awaiting' });
  assert.equal(awaiting.length, 1);
  assert.equal(awaiting[0].speaker, 'teacher');
  assert.match(awaiting[0].speech, /セッション/);
  assert.match(fallbackDialogue(DEFAULT_PERSONA, input({ kind: 'progress' }))[0].speech, /まだ動いてる/);
});

test('loadPersona: ファイル不在は DEFAULT_PERSONA（teacher + student）', () => {
  const p = loadPersona('/nonexistent/voice-persona.json');
  assert.deepEqual(p, DEFAULT_PERSONA);
});

test('loadPersona: 旧 1 キャラ JSON は teacher に流し込み、student は既定', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-'));
  const file = path.join(dir, 'voice-persona.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'テスト', ttsVoice: 'Charon', systemPrompt: 'あなたはテスト。' }));
  const p = loadPersona(file);
  assert.equal(p.teacher.name, 'テスト');
  assert.equal(p.teacher.ttsVoice, 'Charon');
  // 欠落は既定で補完
  assert.deepEqual(p.teacher.emotions, DEFAULT_PERSONA.teacher.emotions);
  // student は既定（なるこ）
  assert.equal(p.student.name, DEFAULT_PERSONA.student.name);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadPersona: 壊れた JSON でも落ちず DEFAULT_PERSONA', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-'));
  const file = path.join(dir, 'voice-persona.json');
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(loadPersona(file), DEFAULT_PERSONA);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('voice-persona.json（リポ同梱）が 2 キャラで読める（Leda / Aoede）', () => {
  const p = loadPersona();
  assert.equal(p.teacher.ttsVoice, 'Leda');
  assert.equal(p.student.ttsVoice, 'Aoede');
  assert.ok(p.teacher.rules.length > 0);
  assert.ok(Object.keys(p.teacher.emotions).length > 0);
});

test('なるこ（student）にボケ・ダジャレ要素、ちょビ（teacher）にツッコミが入っている（同梱 + 既定とも）', () => {
  for (const [label, p] of [['bundled', loadPersona()], ['default', DEFAULT_PERSONA]] as const) {
    // student: 性格 + ルールにボケ/ダジャレが含まれる
    assert.ok(p.student.systemPrompt.includes('ボケ'), `${label}: student.systemPrompt にボケ`);
    assert.ok(p.student.systemPrompt.includes('ダジャレ'), `${label}: student.systemPrompt にダジャレ`);
    assert.ok(
      p.student.rules.some(r => r.includes('ボケ') || r.includes('ダジャレ')),
      `${label}: student.rules にボケ/ダジャレ`,
    );
    // teacher: ボケにツッコむルールがある
    assert.ok(
      p.teacher.rules.some(r => r.includes('ツッコ')),
      `${label}: teacher.rules にツッコミ`,
    );
  }
});

test('DialogueGenerator: generate 注入で JSON をパースして DialogueLine[] を返す', async () => {
  const gen = new DialogueGenerator({
    generate: async () =>
      JSON.stringify([{ speaker: 'teacher', speech: 'foo、テストが全部とおったよ', emotion: 'joy' }]),
  });
  assert.equal(gen.isEnabled(), true);
  const lines = await gen.generate(input());
  assert.equal(lines.length, 1);
  assert.equal(lines[0].speech, 'foo、テストが全部とおったよ');
  assert.equal(lines[0].emotion, 'joy');
});

test('DialogueGenerator: キー未設定は fallback（呼び出さず）', async () => {
  const gen = new DialogueGenerator({ apiKey: undefined });
  assert.equal(gen.isEnabled(), false);
  const lines = await gen.generate(input({ kind: 'completed', projectName: 'bar' }));
  assert.deepEqual(lines, fallbackDialogue(DEFAULT_PERSONA, input({ kind: 'completed', projectName: 'bar' })));
});

test('DialogueGenerator: 例外時は fallback', async () => {
  const gen = new DialogueGenerator({
    generate: async () => {
      throw new Error('boom');
    },
  });
  const lines = await gen.generate(input());
  assert.deepEqual(lines, fallbackDialogue(DEFAULT_PERSONA, input()));
});

test('DialogueGenerator: パース不能（空台本）は fallback', async () => {
  const gen = new DialogueGenerator({ generate: async () => 'まったく JSON じゃない応答' });
  const lines = await gen.generate(input({ kind: 'progress', projectName: 'baz' }));
  assert.deepEqual(lines, fallbackDialogue(DEFAULT_PERSONA, input({ kind: 'progress', projectName: 'baz' })));
});
