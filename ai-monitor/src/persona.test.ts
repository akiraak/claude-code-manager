import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildPersonaPrompt,
  cleanLine,
  DEFAULT_PERSONA,
  fallbackLine,
  loadPersona,
  PersonaGenerator,
  type PersonaInput,
} from './persona';

const input = (over: Partial<PersonaInput> = {}): PersonaInput => ({
  kind: 'completed',
  projectName: 'foo',
  ...over,
});

test('buildPersonaPrompt: 種別ラベル・プロジェクト・詳細・rules を反映する', () => {
  const { system, user } = buildPersonaPrompt(DEFAULT_PERSONA, input({ detail: 'tests green' }));
  // system に rules が全部入る
  for (const r of DEFAULT_PERSONA.rules) assert.ok(system.includes(r), `rule 欠落: ${r}`);
  assert.ok(system.includes('最大 50 字'));
  // user に種別ラベル・プロジェクト・詳細
  assert.ok(user.includes('作業完了'));
  assert.ok(user.includes('プロジェクト: foo'));
  assert.ok(user.includes('詳細: tests green'));
});

test('buildPersonaPrompt: projectName / detail 無しはその行を省く', () => {
  const { user } = buildPersonaPrompt(DEFAULT_PERSONA, { kind: 'awaiting' });
  assert.ok(user.includes('ユーザーの承認・入力待ち'));
  assert.ok(!user.includes('プロジェクト:'));
  assert.ok(!user.includes('詳細:'));
});

test('fallbackLine: 種別ごとに短文、projectName 無しは「セッション」', () => {
  assert.ok(fallbackLine(DEFAULT_PERSONA, input({ kind: 'completed' })).includes('foo'));
  assert.equal(fallbackLine(DEFAULT_PERSONA, { kind: 'awaiting' }).includes('セッション'), true);
  assert.match(fallbackLine(DEFAULT_PERSONA, input({ kind: 'progress' })), /まだ動いてる/);
});

test('cleanLine: 改行潰し・囲み引用符剥がし・上限トリム', () => {
  assert.equal(cleanLine('  やっ\nほー  '), 'やっ ほー');
  assert.equal(cleanLine('「完了したよ」'), '完了したよ');
  assert.equal(cleanLine('"done"'), 'done');
  const long = cleanLine('あ'.repeat(100));
  assert.ok(long.length <= 61); // 60 + 省略記号
  assert.ok(long.endsWith('…'));
  assert.equal(cleanLine('   '), '');
});

test('loadPersona: ファイル不在は DEFAULT_PERSONA', () => {
  const p = loadPersona('/nonexistent/voice-persona.json');
  assert.deepEqual(p, DEFAULT_PERSONA);
});

test('loadPersona: 欠落フィールドは既定で補完', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-'));
  const file = path.join(dir, 'voice-persona.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'テスト', ttsVoice: 'Aoede' }));
  const p = loadPersona(file);
  assert.equal(p.name, 'テスト');
  assert.equal(p.ttsVoice, 'Aoede');
  // 欠落は既定で埋まる
  assert.equal(p.ttsStyle, DEFAULT_PERSONA.ttsStyle);
  assert.deepEqual(p.rules, DEFAULT_PERSONA.rules);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadPersona: 壊れた JSON でも落ちず DEFAULT_PERSONA', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-'));
  const file = path.join(dir, 'voice-persona.json');
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(loadPersona(file), DEFAULT_PERSONA);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('voice-persona.json（リポ同梱）が DEFAULT を上書きせず読める', () => {
  const p = loadPersona();
  assert.equal(p.ttsVoice, 'Leda');
  assert.ok(p.rules.length > 0);
});

test('PersonaGenerator: generate 注入で LLM 出力を整形して返す', async () => {
  const gen = new PersonaGenerator({
    generate: async () => '「foo、テストが全部とおったよ」',
  });
  assert.equal(gen.isEnabled(), true);
  const text = await gen.generate(input());
  assert.equal(text, 'foo、テストが全部とおったよ');
});

test('PersonaGenerator: 成功結果はキャッシュ、同入力で再呼び出ししない', async () => {
  let calls = 0;
  const gen = new PersonaGenerator({
    generate: async () => {
      calls++;
      return `応答${calls}`;
    },
  });
  const a = await gen.generate(input());
  const b = await gen.generate(input());
  assert.equal(a, b);
  assert.equal(calls, 1);
  // 入力が変われば別呼び出し
  await gen.generate(input({ kind: 'awaiting' }));
  assert.equal(calls, 2);
});

test('PersonaGenerator: キー未設定は fallback（呼び出さず）', async () => {
  const gen = new PersonaGenerator({ apiKey: undefined });
  assert.equal(gen.isEnabled(), false);
  const text = await gen.generate(input({ kind: 'completed', projectName: 'bar' }));
  assert.equal(text, fallbackLine(DEFAULT_PERSONA, input({ kind: 'completed', projectName: 'bar' })));
});

test('PersonaGenerator: 例外時は fallback でキャッシュしない（再試行可）', async () => {
  let calls = 0;
  const gen = new PersonaGenerator({
    generate: async () => {
      calls++;
      throw new Error('boom');
    },
  });
  const a = await gen.generate(input());
  assert.equal(a, fallbackLine(DEFAULT_PERSONA, input()));
  await gen.generate(input());
  assert.equal(calls, 2, 'fallback はキャッシュせず再試行する');
});

test('PersonaGenerator: 空応答は fallback', async () => {
  const gen = new PersonaGenerator({ generate: async () => '   ' });
  const text = await gen.generate(input({ kind: 'progress', projectName: 'baz' }));
  assert.equal(text, fallbackLine(DEFAULT_PERSONA, input({ kind: 'progress', projectName: 'baz' })));
});
