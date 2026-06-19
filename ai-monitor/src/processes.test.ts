import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePsClaudePids, parseLsofCwd } from './processes';

// Mac 実機で採取した `ps -axww -o pid=,comm=,command=` の生出力をベースにしたフィクスチャ。
// - 42732 / 53598: comm が `claude` の本物のセッション
// - 54321: node 経由で comm が `node` だが argv[0] basename が `claude` (保険ケース)
// - 53731: ugrep (無関係)
// - 60784: zsh の引数に "claude" を含むが argv[0] は zsh (substring 一致で誤検知しないこと)
// - 99999: 本物の claude だが selfPid と一致 (= 自分自身は除外)
const PS_FIXTURE = [
  '    1 /sbin/launchd    /sbin/launchd',
  '53731 ugrep            ugrep -G --ignore-files -i claude',
  '60784 /bin/zsh         /bin/zsh -c eval \'cd /Users/akiraak/.claude && claude --resume\'',
  '54321 node             /Users/akiraak/.nvm/versions/node/v20.0.0/bin/claude --resume',
  '42732 claude           claude --permission-mode auto',
  '53598 claude           claude --permission-mode auto',
  '99999 claude           claude --permission-mode auto',
  '',
].join('\n');

test('parsePsClaudePids: comm=claude / node+argv0=claude を拾い、無関係・substring・自pid を除外する', () => {
  const pids = parsePsClaudePids(PS_FIXTURE, 99999);
  assert.deepEqual(pids, [42732, 53598, 54321]);
});

test('parsePsClaudePids: selfPid が無関係なら本物の claude を全件返す (昇順)', () => {
  const pids = parsePsClaudePids(PS_FIXTURE, 1);
  assert.deepEqual(pids, [42732, 53598, 54321, 99999]);
});

test('parsePsClaudePids: claude が無ければ空配列', () => {
  const stdout = ['    1 /sbin/launchd    /sbin/launchd', '53731 ugrep            ugrep -i claude'].join('\n');
  assert.deepEqual(parsePsClaudePids(stdout, 1), []);
});

test('parsePsClaudePids: 空文字・PID 無し行・空行を無視する', () => {
  assert.deepEqual(parsePsClaudePids('', 1), []);
  assert.deepEqual(parsePsClaudePids('\n  \nGARBAGE LINE\n', 1), []);
});

test('parsePsClaudePids: 同一 PID が重複しても 1 回だけ返す', () => {
  const stdout = ['42732 claude claude --foo', '42732 claude claude --foo'].join('\n');
  assert.deepEqual(parsePsClaudePids(stdout, 1), [42732]);
});

// Mac 実機で採取した `lsof -a -d cwd -p <pids> -Fpn` の生出力。`fcwd` (fd) 行が混ざる。
// 99999 は cwd (n 行) が取れなかった pid (= map に入らない)。
const LSOF_FIXTURE = [
  'p42732',
  'fcwd',
  'n/Users/akiraak/Projects/kitchen-living',
  'p53598',
  'fcwd',
  'n/Users/akiraak/Projects/claude-code-manager',
  'p99999',
  'fcwd',
  '',
].join('\n');

test('parseLsofCwd: p/n 行から Map<pid, cwd> を作り、fcwd 行は無視する', () => {
  const map = parseLsofCwd(LSOF_FIXTURE);
  assert.equal(map.get(42732), '/Users/akiraak/Projects/kitchen-living');
  assert.equal(map.get(53598), '/Users/akiraak/Projects/claude-code-manager');
});

test('parseLsofCwd: cwd (n 行) が無い pid は map に入らない', () => {
  const map = parseLsofCwd(LSOF_FIXTURE);
  assert.equal(map.has(99999), false);
  assert.equal(map.size, 2);
});

test('parseLsofCwd: 空入力・タグ無し行を無視する', () => {
  assert.equal(parseLsofCwd('').size, 0);
  assert.equal(parseLsofCwd('\n\n').size, 0);
});

test('parseLsofCwd: pid あたり最初の n 行を採用する', () => {
  const stdout = ['p123', 'n/first', 'n/second'].join('\n');
  const map = parseLsofCwd(stdout);
  assert.equal(map.get(123), '/first');
});
