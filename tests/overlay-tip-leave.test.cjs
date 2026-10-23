const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

/* v99：tooltip 伪边界 leave 过滤。Chrome 悬停链收缩/重算会补发 DOM 内部的
 * documentElement/tip mouseleave（格内 .v↔.dim 空隙、tooltip 子元素之间），指针并未离开
 * 本文档；此前每次伪 leave 都按 v47 分流挂 400ms 宽限，鼠标停在空隙/tooltip 上无人取消
 * →「弹出后立即关闭」。修复后 tipLeaveAt 在贴边判定后取触发时刻最深 :hover 元素甄别：
 * 仍是本档具体元素即伪 leave 忽略；截断到 body/iframe/webview 或空链按真边界走原分流。
 * 真实悬停行为由 Playwright 实机验证（/tmp 复现脚本，未入库）；本文件锁定甄别判定表。 */

const start = source.indexOf('    function tipLeaveAt(x, y) {');
const end = source.indexOf('    listenGlobal(document.documentElement, "mouseleave"', start);
assert.ok(start >= 0 && end > start, 'tipLeaveAt 函数与挂载点都存在');
const fnSource = source.slice(start, end);

function runLeave({ x = 680, y = 400, hover = null, tipFor = {}, tipRect = null } = {}) {
  let hidden = null, boundaryHide = 0, mouseInBar = true;
  const timers = [];
  const htmlEl = { tagName: 'HTML' }, bodyEl = { tagName: 'BODY' };
  const doc = {
    body: bodyEl, documentElement: htmlEl,
    querySelectorAll(sel) {
      assert.equal(sel, ':hover');
      return hover === null ? [htmlEl, bodyEl] : hover;
    },
  };
  const ctx = {
    document: doc,
    innerWidth: 1280, innerHeight: 800,
    inactive: () => false,
    tipFor, mouseInBarRef: () => mouseInBar,
    get mouseInBar() { return mouseInBar; }, set mouseInBar(v) { mouseInBar = v; },
    tip: { getBoundingClientRect: () => tipRect || { left: 551, top: 509, right: 810, bottom: 673 } },
    tipStats: { grace: 0 },
    tipGraceTimer: 0,
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() { },
    cancelTipGrace() { },
    tipBoundaryHide() { boundaryHide++; mouseInBar = false; },
    hideTip(force, cause) { hidden = { force, cause }; },
  };
  vm.runInNewContext(fnSource + '\n__result = tipLeaveAt(__x, __y);',
    Object.assign(vm.createContext(ctx), { __x: x, __y: y }));
  return { hidden, timers, boundaryHide, mouseInBar: () => mouseInBar, tipStats: ctx.tipStats };
}

test('悬停链停在本档具体元素上：伪 leave 一律忽略（格内空隙/tooltip 本体不再熄灭）', () => {
  const cell = { tagName: 'SPAN' };   // 格内空白命中的 .it
  const r = runLeave({ x: 670, y: 691, hover: [{ tagName: 'HTML' }, { tagName: 'BODY' }, cell] });
  assert.equal(r.hidden, null, '不得隐藏');
  assert.equal(r.timers.length, 0, '不得挂宽限定时器');
  assert.equal(r.boundaryHide, 0);
  assert.equal(r.mouseInBar(), true, '忽略路径不得翻转 mouseInBar（render-orphan 总闸语义不变）');

  const tipChild = { tagName: 'DIV' };   // tooltip 内部元素间伪 tip leave
  const r2 = runLeave({ x: 680, y: 590, hover: [tipChild] });
  assert.equal(r2.hidden, null);
  assert.equal(r2.timers.length, 0);

  const htmlOnly = runLeave({ x: 670, y: 691, hover: [{ tagName: 'HTML' }] });   // 链只剩 html 同属伪边界
  assert.equal(htmlOnly.hidden, null);
  assert.equal(htmlOnly.timers.length, 0);
});

test('hover 链截断到 body（空档区/已进子文档）：真边界按 v47 分流', () => {
  // 列内（tip 横向 ±30px）→ 挂 400ms 宽限；hover=null 即链只剩 html/body 的默认形态
  const r = runLeave({ x: 680, y: 470 });
  assert.equal(r.hidden, null);
  assert.deepEqual(r.timers.map(t => t.ms), [400]);
  assert.equal(r.tipStats.grace, 1);
  // 列外 → 立即 left-bar
  const r2 = runLeave({ x: 100, y: 400 });
  assert.deepEqual(r2.hidden, { force: true, cause: 'left-bar' });
  assert.equal(r2.timers.length, 0);
  assert.equal(r2.mouseInBar(), false);
});

test('hover 链为空（甩出窗口）与 iframe/webview 深层同样按真边界处理', () => {
  const none = runLeave({ x: 680, y: 470, hover: [] });
  assert.deepEqual(none.timers.map(t => t.ms), [400]);
  const frame = runLeave({ x: 680, y: 470, hover: [{ tagName: 'HTML' }, { tagName: 'BODY' }, { tagName: 'IFRAME' }] });
  assert.deepEqual(frame.timers.map(t => t.ms), [400]);
  const wv = runLeave({ x: 680, y: 470, hover: [{ tagName: 'HTML' }, { tagName: 'WEBVIEW' }] });
  assert.deepEqual(wv.timers.map(t => t.ms), [400]);
});

test('贴边坐标仍是最高优先级：win-leave 立即收，不受 hover 链影响', () => {
  const cell = { tagName: 'SPAN' };
  const r = runLeave({ x: 670, y: 798, hover: [{ tagName: 'HTML' }, { tagName: 'BODY' }, cell] });
  assert.equal(r.boundaryHide, 1, '贴边走 tipBoundaryHide');
  assert.equal(r.hidden, null, 'boundaryHide 内部处理，不经 hideTip');
  assert.equal(r.timers.length, 0);
});

test('querySelectorAll 异常时不拦截（降级为原 v47 行为）', () => {
  let hidden = null;
  const timers = [];
  const ctx = {
    document: { querySelectorAll() { throw new Error('no :hover'); } },
    innerWidth: 1280, innerHeight: 800,
    inactive: () => false, tipFor: {}, mouseInBar: true,
    tip: { getBoundingClientRect: () => ({ left: 551, top: 509, right: 810, bottom: 673 }) },
    tipStats: { grace: 0 }, tipGraceTimer: 0,
    setTimeout(fn, ms) { timers.push(ms); return 1; }, clearTimeout() { },
    cancelTipGrace() { }, tipBoundaryHide() { },
    hideTip(force, cause) { hidden = { force, cause }; },
  };
  vm.runInNewContext(fnSource + '\n__result = tipLeaveAt(__x, __y);',
    Object.assign(vm.createContext(ctx), { __x: 680, __y: 470 }));
  assert.deepEqual(timers, [400], '异常放行 → 照旧挂宽限');
});

test('documentElement 与 tooltip 两处 mouseleave 都路由 tipLeaveAt（过滤对两者生效）', () => {
  assert.match(source, /listenGlobal\(document\.documentElement, "mouseleave", function \(e\) \{\s*\n\s*tipLeaveAt\(e\.clientX, e\.clientY\);\s*\n\s*\}, true\)/);
  assert.match(source, /tip\.addEventListener\("mouseleave", function \(e\) \{\s*\n\s*tipLeaveAt\(e\.clientX, e\.clientY\);\s*\n\s*\}, true\)/);
});

test('web 版同一语义：过滤在 tipLeaveAt 内且双挂载点路由一致', () => {
  const web = fs.readFileSync(path.join(__dirname, '..', 'web', 'overlay.js'), 'utf8');
  const wStart = web.indexOf('    function tipLeaveAt(x, y) {');
  const wEnd = web.indexOf('    listenGlobal(document.documentElement, "mouseleave"', wStart);
  assert.ok(wStart >= 0 && wEnd > wStart);
  const wFn = web.slice(wStart, wEnd);
  assert.match(wFn, /querySelectorAll\(":hover"\)/, 'web 版同样取最深 :hover 甄别');
  assert.match(wFn, /IFRAME/);
  assert.match(web, /tip\.addEventListener\("mouseleave", function \(e\) \{\s*\n\s*tipLeaveAt\(e\.clientX, e\.clientY\);\s*\n\s*\}, true\)/);
});
