import test from 'node:test';
import assert from 'node:assert/strict';

import { buildUserPrompt } from './summarize';
import type { NormalizedEvent } from './transcript';

function ev(over: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    kind: 'tool-use',
    timestamp: '2026-05-13T08:00:00.000Z',
    text: '',
    ...over,
  };
}

test('buildUserPrompt: ピン留め user 入力が「最新のユーザー入力」セクションに出る', () => {
  const prompt = buildUserPrompt({
    events: [
      ev({ kind: 'assistant-text', text: 'はい、進めます' }),
      ev({ kind: 'tool-use', toolName: 'Bash', text: 'ls' }),
      ev({ kind: 'tool-result', text: 'a\nb\nc' }),
    ],
    recentUserText: { text: 'foo.md を直して', at: '2026-05-13T07:00:00.000Z' },
  });
  assert.ok(prompt.includes('# 最新のユーザー入力'), 'ピン留めセクション見出しが出る');
  assert.ok(prompt.includes('foo.md を直して'), 'ピン留め本文が出る');
  assert.ok(prompt.includes('# 直近のやり取り (古い順)'), '直近セクション見出しが出る');
  assert.ok(prompt.includes('[assistant] はい、進めます'), '直近セクションに assistant 行が出る');
});

test('buildUserPrompt: tool-use / tool-result は直近セクションに出ない', () => {
  const prompt = buildUserPrompt({
    events: [
      ev({ kind: 'user-text', text: 'やって', timestamp: '2026-05-13T07:00:00.000Z' }),
      ev({ kind: 'tool-use', toolName: 'Bash', text: 'ls -la' }),
      ev({ kind: 'tool-result', text: 'file1\nfile2' }),
      ev({ kind: 'assistant-text', text: '完了しました' }),
    ],
  });
  assert.ok(!prompt.includes('[tool_use'), 'tool_use 行は出ない');
  assert.ok(!prompt.includes('[tool_result]'), 'tool_result 行は出ない');
  assert.ok(prompt.includes('[user] やって'), 'user 行は出る');
  assert.ok(prompt.includes('[assistant] 完了しました'), 'assistant 行は出る');
});

test('buildUserPrompt: recentUserText 未指定なら「最新のユーザー入力」セクションは出ない', () => {
  const prompt = buildUserPrompt({
    events: [ev({ kind: 'assistant-text', text: 'hi' })],
  });
  assert.ok(!prompt.includes('# 最新のユーザー入力'));
  assert.ok(prompt.includes('# 直近のやり取り (古い順)'));
  assert.ok(prompt.includes('[assistant] hi'));
});

test('buildUserPrompt: events 中の user-text がピン留めと同一なら重複排除される', () => {
  const pinnedAt = '2026-05-13T07:00:00.000Z';
  const prompt = buildUserPrompt({
    events: [
      ev({ kind: 'user-text', text: 'foo.md を直して', timestamp: pinnedAt }),
      ev({ kind: 'tool-use', toolName: 'Bash', text: 'ls' }),
    ],
    recentUserText: { text: 'foo.md を直して', at: pinnedAt },
  });
  // ピン留めセクションに 1 回出ているが、直近セクションには `[user]` 行として出ない
  const userLineMatches = prompt.match(/^\[user\] /gm);
  assert.equal(userLineMatches, null, '[user] 行は直近セクションに出ない');
  // ピン留め本文は出る (1 回だけ)
  const occurrences = prompt.split('foo.md を直して').length - 1;
  assert.equal(occurrences, 1, 'ピン留め本文の出現は 1 回');
});

test('buildUserPrompt: 長いピン留め本文は 1200 文字 + 末尾 … で切られる', () => {
  const long = 'あ'.repeat(2000);
  const prompt = buildUserPrompt({
    events: [],
    recentUserText: { text: long, at: '2026-05-13T07:00:00.000Z' },
  });
  // セクション本文部分のみ抽出 (見出し直後の改行から末尾まで)
  const idx = prompt.indexOf('# 最新のユーザー入力\n');
  assert.notEqual(idx, -1);
  const after = prompt.slice(idx + '# 最新のユーザー入力\n'.length);
  // 改行で終わらないので as-is. 末尾が … で切られていることを確認
  assert.ok(after.endsWith('…'));
  // あ x 1200 + … = 1201 chars
  assert.equal(Array.from(after).length, 1201);
});
