import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyV2 } from './state';

const now = () => new Date().toISOString();

test('classifyV2: mtime fresh + endsWithLocalCommand=true → waiting (ローカルコマンド直後は AI 非介在)', () => {
  const result = classifyV2({
    hasProcess: true,
    lastActivityAt: now(),
    endsWithInteractiveToolUse: false,
    hasAwaitingMarker: false,
    endsWithLocalCommand: true,
  });
  assert.equal(result, 'waiting');
});

test('classifyV2: mtime fresh + endsWithLocalCommand=false → ai-processing', () => {
  const result = classifyV2({
    hasProcess: true,
    lastActivityAt: now(),
    endsWithInteractiveToolUse: false,
    hasAwaitingMarker: false,
    endsWithLocalCommand: false,
  });
  assert.equal(result, 'ai-processing');
});

test('classifyV2: 対話ツール pending は endsWithLocalCommand より優先 → awaiting-user', () => {
  const result = classifyV2({
    hasProcess: true,
    lastActivityAt: now(),
    endsWithInteractiveToolUse: true,
    hasAwaitingMarker: false,
    endsWithLocalCommand: true,
  });
  assert.equal(result, 'awaiting-user');
});

test('classifyV2: hasProcess=false は他フラグを問わず stopped', () => {
  const result = classifyV2({
    hasProcess: false,
    lastActivityAt: now(),
    endsWithInteractiveToolUse: false,
    hasAwaitingMarker: false,
    endsWithLocalCommand: true,
  });
  assert.equal(result, 'stopped');
});

test('classifyV2: mtime が 30 秒より古いと endsWithLocalCommand に関わらず waiting', () => {
  const old = new Date(Date.now() - 60_000).toISOString();
  const result = classifyV2({
    hasProcess: true,
    lastActivityAt: old,
    endsWithInteractiveToolUse: false,
    hasAwaitingMarker: false,
    endsWithLocalCommand: false,
  });
  assert.equal(result, 'waiting');
});
