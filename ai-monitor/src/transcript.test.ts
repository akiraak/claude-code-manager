import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { findLastUserText } from './transcript';

function mkTmpJsonl(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-monitor-transcript-'));
  return path.join(dir, name);
}

function writeLines(file: string, lines: object[]): void {
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

function userText(t: string, ts: string): object {
  return { type: 'user', timestamp: ts, message: { content: t } };
}

function assistantText(t: string, ts: string): object {
  return { type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text: t }] } };
}

function toolUse(id: string, name: string, ts: string): object {
  return { type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name, input: {} }] } };
}

function toolResult(id: string, body: string, ts: string): object {
  return { type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, content: body }] } };
}

test('findLastUserText: ツール往復 60 セットの先頭に置いた user-text を遡って拾える', () => {
  const file = mkTmpJsonl('case-a.jsonl');
  const lines: object[] = [];
  // 直近の user 発言を 1 件先頭付近に置く
  lines.push(userText('dashboard のテストをして', '2026-05-13T00:00:00.000Z'));
  lines.push(assistantText('OK', '2026-05-13T00:00:00.500Z'));
  // ツール往復 60 セット (= 120 イベント) を後ろに連ねる → tail 50 件には user-text は無い
  for (let i = 0; i < 60; i++) {
    const t1 = `2026-05-13T00:0${Math.floor(i / 60)}:${String(i % 60).padStart(2, '0')}.001Z`;
    const t2 = `2026-05-13T00:0${Math.floor(i / 60)}:${String(i % 60).padStart(2, '0')}.002Z`;
    lines.push(toolUse(`id-${i}`, 'Bash', t1));
    lines.push(toolResult(`id-${i}`, `ok-${i}`, t2));
  }
  writeLines(file, lines);
  const mtime = fs.statSync(file).mtimeMs;

  const result = findLastUserText(file, mtime);
  assert.ok(result, 'user-text を 1 件取り戻せること');
  assert.equal(result!.text, 'dashboard のテストをして');
  assert.equal(result!.at, '2026-05-13T00:00:00.000Z');
});

test('findLastUserText: user-text が一切無いセッションは null を返す', () => {
  const file = mkTmpJsonl('case-b.jsonl');
  const lines: object[] = [];
  // tool_use / tool_result だけ。user 発言は一度も無い
  for (let i = 0; i < 10; i++) {
    lines.push(toolUse(`id-${i}`, 'Bash', `2026-05-13T00:00:0${i}.001Z`));
    lines.push(toolResult(`id-${i}`, `ok-${i}`, `2026-05-13T00:00:0${i}.002Z`));
  }
  writeLines(file, lines);
  const mtime = fs.statSync(file).mtimeMs;

  // 動的に取り直すため、cache キーを衝突させない用に異なる path を毎回掘っているので OK
  assert.equal(findLastUserText(file, mtime), null);
});

test('findLastUserText: 直近の user-text が /clear の XML 包みなら整形済みで返る', () => {
  const file = mkTmpJsonl('case-c.jsonl');
  const lines: object[] = [
    userText('普通の発言', '2026-05-13T00:00:00.000Z'),
    userText(
      '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>',
      '2026-05-13T00:00:01.000Z',
    ),
    // 末尾は tool_result (Yes/No 承認相当) で押し込む → スキップされて /clear が返るはず
    toolResult('x', 'whatever', '2026-05-13T00:00:02.000Z'),
  ];
  writeLines(file, lines);
  const mtime = fs.statSync(file).mtimeMs;

  const result = findLastUserText(file, mtime);
  assert.ok(result);
  assert.equal(result!.text, '/clear');
  assert.equal(result!.at, '2026-05-13T00:00:01.000Z');
});

test('findLastUserText: 同じ mtime で 2 回呼ぶとキャッシュが効く (ファイル書換後も古い値を返す)', () => {
  const file = mkTmpJsonl('case-d.jsonl');
  writeLines(file, [userText('A', '2026-05-13T00:00:00.000Z')]);

  // 1 回目: mtime=100 で書き込み、A が返る
  const first = findLastUserText(file, 100);
  assert.equal(first?.text, 'A');

  // ファイルを書き換える (B が直近の user-text) が、mtime キーは同じ 100 のまま
  writeLines(file, [userText('B', '2026-05-13T00:00:01.000Z')]);
  const second = findLastUserText(file, 100);
  // キャッシュヒットなので B ではなく A が返る = ファイルを再読していない証拠
  assert.equal(second?.text, 'A');

  // mtime を 200 に変えると再スキャン → B が返る
  const third = findLastUserText(file, 200);
  assert.equal(third?.text, 'B');
});

test('findLastUserText: tool_result のみで text part が無い user 行は user-text として採用しない', () => {
  const file = mkTmpJsonl('case-e.jsonl');
  writeLines(file, [
    userText('実発言', '2026-05-13T00:00:00.000Z'),
    // tool_result だけが入った user 行 (= Yes/No 承認や Bash 結果): 採用してはいけない
    {
      type: 'user',
      timestamp: '2026-05-13T00:00:01.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'yes' }] },
    },
  ]);
  const mtime = fs.statSync(file).mtimeMs;

  const result = findLastUserText(file, mtime);
  assert.equal(result?.text, '実発言');
});

test('findLastUserText: isMeta=true の user 行はスキップする', () => {
  const file = mkTmpJsonl('case-f.jsonl');
  writeLines(file, [
    userText('実発言', '2026-05-13T00:00:00.000Z'),
    {
      type: 'user',
      timestamp: '2026-05-13T00:00:01.000Z',
      isMeta: true,
      message: { content: '隠しメタ発言' },
    },
  ]);
  const mtime = fs.statSync(file).mtimeMs;

  assert.equal(findLastUserText(file, mtime)?.text, '実発言');
});
