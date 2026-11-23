'use strict';
/* tests/helpers/js-scan.cjs 自测：结构锁（重定向策略等）依赖这个扫描器，扫描器自己得先被锁住——
 * 注释/字符串/模板串里的字样不算调用，同一行字符串后面的调用不能漏，整个调用文本要截全。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { callSites, requiredModules } = require('./helpers/js-scan.cjs');

test('js-scan: callSites skips comments, strings, templates and regex literals and captures the whole call', () => {
  const src = [
    '// fetchImpl( in a line comment',
    '/* fetchImpl( in a block comment */',
    'const s = "fetchImpl( in a string"; const t = `fetchImpl( ${x} tail`;',
    'const re = /["\\/]/; a / b;',
    'fetchImpl(url, { redirect: "error" });',
    'j.fetchImpl(`x(${y})`, f(g(1)));',
    'myfetchImpl(1); _fetchImpl(2); fetchImplX(3);',
    "require('fs'); require(\"./quota-client.cjs\"); const m = require(name);",
  ].join('\n');
  const sites = callSites(src, 'fetchImpl');
  assert.deepEqual(sites.map((s) => s.text), ['fetchImpl(url, { redirect: "error" })', 'fetchImpl(`x(${y})`, f(g(1)))']);
  assert.equal(sites[0].line, 5);
  assert.equal(callSites(src, 'fetch').length, 0, 'fetchImpl( 不是 fetch(');
  assert.deepEqual(requiredModules(src).sort(), ['./quota-client.cjs', 'fs'], '只收字符串字面量模块名');
});

test('js-scan: a slash after postfix ++/-- is division, never a regex start (it would swallow the rest of the file)', () => {
  const one = (src) => callSites(src, 'fetchImpl').map((s) => s.text);
  assert.deepEqual(one('x = y++ / 2; fetchImpl(a);'), ['fetchImpl(a)']);
  assert.deepEqual(one('x = y--\n  / n;\nfetchImpl(b);'), ['fetchImpl(b)']);
  assert.deepEqual(one('if (i++ / 2) {}\nfetchImpl(c); fetchImpl(d);'), ['fetchImpl(c)', 'fetchImpl(d)']);
  // 一元加/减与二则运算后的斜杠仍按正则起点处理；真正的后缀 ++ 与斜杠之间可以隔空白
  assert.deepEqual(one('x = +/re/.t(s); fetchImpl(e);'), ['fetchImpl(e)']);
  assert.deepEqual(one('x = a + +/re/.t(s); fetchImpl(f);'), ['fetchImpl(f)']);
  assert.deepEqual(one('x = a++ + /re/.t(s); fetchImpl(g);'), ['fetchImpl(g)']);
  // 正则里的引号、括号与斜杠不扰乱后续调用
  assert.deepEqual(one('x = y++ / 2; const r = /["\']/g; fetchImpl(h, "x)");'), ['fetchImpl(h, "x)")']);
});
