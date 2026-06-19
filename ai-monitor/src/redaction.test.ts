import test from 'node:test';
import assert from 'node:assert/strict';

import { redact, truncate, sanitizeText, MAX_TEXT_CHARS } from './redaction';

test('Anthropic キーをマスクする', () => {
  const r = redact('key is sk-' + 'ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 done');
  assert.match(r.text, /«redacted:anthropic-key»/);
  assert.doesNotMatch(r.text, /sk-ant-api03/);
  assert.equal(r.redactions, 1);
});

test('Google / GitHub / AWS / Slack の鍵をマスクする', () => {
  const aiza = redact('AIza' + 'SyA1234567890abcdefghijklmnopqrstuv');
  assert.match(aiza.text, /«redacted:google-key»/);

  const gh = redact('ghp' + '_abcdefghijklmnopqrstuvwxyz0123456789');
  assert.match(gh.text, /«redacted:github-token»/);

  const aws = redact('id=AKIAIOSFODNN7EXAMPLE');
  assert.match(aws.text, /«redacted:aws-key»/);

  // 偽の固定フィクスチャ (redaction 検証用)。GitHub の Slack トークン検出器に当たらないよう
  // 数字セグメントを避けた明示的なダミー文字列にしている (regex `xox[baprs]-[A-Za-z0-9-]{10,}` は一致)。
  const slack = redact('xoxb-EXAMPLE-FIXTURE-TOKEN');
  assert.match(slack.text, /«redacted:slack-token»/);
});

test('Authorization 行は prefix を残して値 (Bearer トークン含む) をマスクする', () => {
  const auth = redact('Authorization: Bearer abcdef0123456789ABCDEF');
  assert.equal(auth.text, 'Authorization: «redacted:authorization»');
  assert.doesNotMatch(auth.text, /abcdef0123456789ABCDEF/);
});

test('単独の Bearer トークンも prefix を残してマスクする', () => {
  const bearer = redact('header={Bearer abcdef0123456789ABCDEF}');
  assert.match(bearer.text, /Bearer «redacted:bearer-token»/);
  assert.doesNotMatch(bearer.text, /abcdef0123456789ABCDEF/);
});

test('.env 風 KEY=value は秘匿語を含む KEY のみ値をマスクする', () => {
  const secret = redact('GEMINI_API_KEY=supersecretvalue123');
  assert.match(secret.text, /GEMINI_API_KEY=«redacted:secret»/);

  const normal = redact('PORT=8181');
  assert.equal(normal.text, 'PORT=8181');
  assert.equal(normal.redactions, 0);
});

test('PRIVATE KEY ブロックをまるごとマスクする', () => {
  const pem = '-----BEGIN RSA ' + 'PRIVATE KEY-----\nMIIabc\nDEF==\n-----END RSA PRIVATE KEY-----';
  const r = redact(`before\n${pem}\nafter`);
  assert.match(r.text, /«redacted:private-key»/);
  assert.doesNotMatch(r.text, /MIIabc/);
  assert.match(r.text, /before/);
  assert.match(r.text, /after/);
});

test('秘匿が無い普通の文章は無改変', () => {
  const r = redact('これは普通の進捗報告です。テストが全部緑になりました。');
  assert.equal(r.redactions, 0);
  assert.equal(r.text, 'これは普通の進捗報告です。テストが全部緑になりました。');
});

test('空文字・未定義入力でも落ちない', () => {
  assert.equal(redact('').text, '');
  // @ts-expect-error 故意に undefined を渡す (uplink で値欠落しても落ちないこと)
  assert.equal(redact(undefined).text, '');
});

test('truncate は maxChars 超で末尾 … を付ける', () => {
  assert.equal(truncate('abcdef', 3), 'abc…');
  assert.equal(truncate('abc', 3), 'abc');
  assert.equal(truncate('x'.repeat(MAX_TEXT_CHARS + 10)).endsWith('…'), true);
});

test('sanitizeText は redaction 後にトリムする (境界をまたぐ鍵が半分漏れない)', () => {
  // 鍵がトリム境界の近くにあっても、先に redaction されるので生の鍵は決して残らない。
  const padded = 'x'.repeat(10) + ' sk-' + 'ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 ' + 'y'.repeat(100);
  const out = sanitizeText(padded, 40);
  assert.match(out, /«redacted:anthropic-key»/);
  assert.doesNotMatch(out, /sk-ant/); // 生の鍵断片が一切出ない
});
