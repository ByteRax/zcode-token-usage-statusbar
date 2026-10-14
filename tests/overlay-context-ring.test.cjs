const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
const start = source.indexOf('      if (state.show.ctx) {');
const end = source.indexOf('      if (state.show.turn) {', start);
assert.ok(start >= 0 && end > start);
const contextSource = source.slice(start, end);

function render(ctx, { capacity = 200000, override = '', native = 0, exc = false, show = true } = {}) {
  let result = null;
  const context = {
    state: { show: { ctx: show }, ctxOv: override },
    d: { context_window: capacity, native_ctx: native }, sess: { ctx },
    excActive: () => exc, it: (markup, tip) => { result = { markup, tip }; },
    L: (zh, en) => zh, fmt: String, fmtTime: () => '12:00',
    ttH: String, ttRow: (key, value) => key + value, ttNote: String,
  };
  vm.runInNewContext(contextSource, context);
  return result;
}

test('context ring starts at the top and retains the visible percentage and tooltip', () => {
  const { markup, tip } = render(63400);
  assert.match(markup, /<svg class="cbar"/);
  assert.match(markup, /class="cbar-track"/);
  assert.match(markup, /pathLength="100" stroke-dasharray="31\.7 100" transform="rotate\(-90 12 12\)"/);
  assert.match(markup, /class="pct ok">31\.7%/);
  assert.match(tip, /上下文容量/);
  assert.match(tip, /63400 \/ 200000/);
});
test('ring fill is bounded at zero and full while the percentage remains truthful', () => {
  assert.match(render(0).markup, /stroke-dasharray="0\.0 100"/);
  assert.match(render(200000).markup, /stroke-dasharray="100\.0 100"/);
  const over = render(250000).markup;
  assert.match(over, /stroke-dasharray="100\.0 100"/);
  assert.match(over, />125\.0%/);
});
test('ring retains the original warning bands and over-limit animation class', () => {
  for (const [ctx, capacity, cls] of [[60000, 100000, 'ok'], [70000, 100000, 'warm'], [85000, 100000, 'hot'], [400000, 1000000, 'warm'], [600000, 1000000, 'hot']]) {
    assert.match(render(ctx, { capacity }).markup, new RegExp('cbar-value ' + cls));
  }
  assert.match(render(63400, { exc: true }).markup, /cbar-value exc/);
});
test('unknown capacity does not invent a ring, and hidden context stays hidden', () => {
  const unknown = render(63400, { capacity: 0 });
  assert.doesNotMatch(unknown.markup, /cbar/);
  assert.match(unknown.markup, />63400</);
  assert.match(unknown.tip, /窗口容量未知/);
  assert.equal(render(63400, { show: false }), null);
});
test('capacity sources still prefer the manual override and native client value', () => {
  assert.match(render(50000, { override: '100000', native: 150000 }).markup, /stroke-dasharray="50\.0 100"/);
  assert.match(render(50000, { native: 100000 }).markup, /stroke-dasharray="50\.0 100"/);
});
test('ring size follows client font size and fill follows the existing color classes', () => {
  assert.match(source, /\.cbar\{[^\n]+width:calc\(var\(--ui-font-size,14px\) \+ 2px\)/);
  assert.match(source, /\.cbar-value\{stroke:currentColor\}/);
  assert.doesNotMatch(source, /\.cbar>i/);
});
