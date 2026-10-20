const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

/* v93：状态条「上下文容量」格已删（UI+tooltip），分档口径 ctxBandOf 的唯一消费方是
 * 原生按钮增强（overlay-ctxbtn.test.cjs 已覆盖其 DOM 行为）；本文件单测口径本身。 */
const bandStart = source.indexOf('    /* 上下文分档口径');
const bandEnd = source.indexOf('    function html(d) {', bandStart);
assert.ok(bandStart >= 0 && bandEnd > bandStart);
const bandSource = source.slice(bandStart, bandEnd);

function runBand(sess, { override = '', native = 0, exc = false } = {}) {
  const context = {
    state: { ctxOv: override },
    nativeCtxVal: native,
    excActive: () => exc,
    sess,
  };
  vm.runInNewContext(bandSource + '\n__result = ctxBandOf(sess);', context);
  return context.__result;
}

test('percentage and bands follow the shared thresholds: normal 70/85, million window 40/60', () => {
  assert.deepEqual(
    (({ cw, pct, cls }) => ({ cw, pct: +pct.toFixed(1), cls }))(runBand({ ctx: 63400, context_window: 200000 })),
    { cw: 200000, pct: 31.7, cls: 'ok' });
  assert.equal(runBand({ ctx: 140000, context_window: 200000 }).cls, 'warm');
  assert.equal(runBand({ ctx: 170000, context_window: 200000 }).cls, 'hot');
  assert.equal(runBand({ ctx: 450000, context_window: 1000000 }).cls, 'warm');
  assert.equal(runBand({ ctx: 610000, context_window: 1000000 }).cls, 'hot');
});

test('over-limit wins over any band and unknown capacity yields zero percent', () => {
  assert.equal(runBand({ ctx: 63400, context_window: 200000 }, { exc: true }).cls, 'exc');
  const none = runBand({ ctx: 63400, context_window: 0 }, { native: 0 });
  assert.deepEqual({ cw: none.cw, pct: none.pct, cls: none.cls }, { cw: 0, pct: 0, cls: 'ok' });
});

test('capacity sources still prefer the manual override and native client value', () => {
  assert.equal(runBand({ ctx: 50000, context_window: 200000 }, { override: '100000' }).cw, 100000);
  assert.equal(runBand({ ctx: 50000, context_window: 200000 }, { native: 150000 }).cw, 150000);
  assert.equal(runBand({ ctx: 50000 }).cw, 0);
});

test('context cell is gone from the bar markup and its setting row from the panel', () => {
  assert.doesNotMatch(source, /state\.show\.ctx/);
  assert.doesNotMatch(source, /data-k="ctx"/);
  assert.doesNotMatch(source, /class="cbar/);
  assert.doesNotMatch(source, /ttH\(L\("上下文容量"/);   // 自绘 tooltip 已删；原生面板名的描述性引用保留
  assert.match(source, /上下文窗口/, '手动覆盖输入框保留（喂 ctxBandOf）');
});
