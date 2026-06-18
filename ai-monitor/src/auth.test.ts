import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertServerAuthConfigured,
  bearerAuth,
  extractBearerToken,
  isAuthorizedToken,
  parseClientTokens,
  MIN_TOKEN_LENGTH,
} from './auth';

const VALID = 'a'.repeat(MIN_TOKEN_LENGTH); // 16 文字ちょうど
const VALID2 = 'b'.repeat(20);

test('parseClientTokens はカンマ区切りを trim + 空要素除去する', () => {
  assert.deepEqual(parseClientTokens('a,b , ,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseClientTokens(undefined), []);
  assert.deepEqual(parseClientTokens(''), []);
  assert.deepEqual(parseClientTokens('  '), []);
});

test('assertServerAuthConfigured: 0 個は起動拒否', () => {
  assert.throws(() => assertServerAuthConfigured([]), /CCM_CLIENT_TOKENS/);
});

test('assertServerAuthConfigured: 短すぎるトークンは起動拒否', () => {
  assert.throws(() => assertServerAuthConfigured(['short']), /短すぎる/);
});

test('assertServerAuthConfigured: 十分な長さなら通過', () => {
  assert.doesNotThrow(() => assertServerAuthConfigured([VALID, VALID2]));
});

test('extractBearerToken: 形式に応じて token を取り出す', () => {
  assert.equal(extractBearerToken(`Bearer ${VALID}`), VALID);
  assert.equal(extractBearerToken(`bearer ${VALID}`), VALID); // scheme は case-insensitive
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken('Basic abc'), null);
  assert.equal(extractBearerToken('Bearer'), null);
});

test('isAuthorizedToken: 一致/不一致/長さ違いで throw しない', () => {
  assert.equal(isAuthorizedToken(VALID, [VALID, VALID2]), true);
  assert.equal(isAuthorizedToken('c'.repeat(16), [VALID, VALID2]), false);
  // 長さが違っても timingSafeEqual で落ちない
  assert.equal(isAuthorizedToken('x', [VALID]), false);
});

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined, headers: {} };
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b;
    return res;
  };
  return res;
}

test('bearerAuth: 正しいトークンは next() を呼ぶ', () => {
  const mw = bearerAuth([VALID]);
  const res = fakeRes();
  let nexted = false;
  mw({ headers: { authorization: `Bearer ${VALID}` } } as any, res as any, () => {
    nexted = true;
  });
  assert.equal(nexted, true);
  assert.equal(res.statusCode, 200);
});

test('bearerAuth: ヘッダ欠落 / 不一致 / 形式不正は 401', () => {
  const mw = bearerAuth([VALID]);
  for (const header of [undefined, 'Bearer wrong-token-value', 'Basic xxxxx', 'Bearer']) {
    const res = fakeRes();
    let nexted = false;
    mw({ headers: header ? { authorization: header } : {} } as any, res as any, () => {
      nexted = true;
    });
    assert.equal(nexted, false, `header=${header} は next しない`);
    assert.equal(res.statusCode, 401, `header=${header} は 401`);
  }
});
