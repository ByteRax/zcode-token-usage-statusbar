const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
const start = source.indexOf('    function positionSubPop() {');
const end = source.indexOf('    var subRateTimer = 0;', start);
assert.ok(start >= 0 && end > start, 'positionSubPop slice found');
const positionSource = source.slice(start, end);

/* v217：统一浮层定位——优先入口上方 12px，左右夹紧 12px；入口 rect 全零回退条锚；
 * 入口断连即关（无法确认归属）。 */
function position({ entryLeft = 800, entryWidth = 80, entryTop = 600, entryH = 20,
  panelWidth = 820, panelHeight = 500, viewportWidth = 1200, viewportHeight = 800,
  barLeft = 400, barTop = 600, entry = 'live', theme = 'default' } = {}) {
  const style = {};
  const rects = {
    entry: { left: entryLeft, width: entryWidth, top: entryTop, height: entryH },
    bar: { left: barLeft, width: 100, top: barTop, height: 20 },
  };
  const entryEl = entry === 'live' ? { isConnected: true, getBoundingClientRect: () => rects.entry }
    : entry === 'gone' ? { isConnected: false, getBoundingClientRect: () => rects.entry }
    : null;
  const context = {
    window: { innerWidth: viewportWidth, innerHeight: viewportHeight },
    subPopOpen: () => true,
    subPopEntry: entryEl,
    subPopClose: (r, cause) => { context.closed = cause; },
    subPanel: { offsetWidth: panelWidth, offsetHeight: panelHeight, style },
    bar: { getBoundingClientRect: () => rects.bar },
    state: { theme },
  };
  vm.runInNewContext(positionSource + '\npositionSubPop();', context);
  return { style, context };
}

test('popover centers above the entry and clamps to the left edge', () => {
  const { style } = position();
  assert.equal(style.left, '368px');   // 中心 840 − 410 = 430 → 钳右缘 1200−820−12
  assert.equal(style.top, '88px');     // 600 − 500 − 12
});

test('popover stays inside the viewport edges (12px)', () => {
  const { style } = position({ entryLeft: 1100 });
  assert.equal(style.left, '368px');   // 1200 − 820 − 12
  const l = position({ entryLeft: 10 });
  assert.equal(l.style.left, '12px');
});

test('popover flips below the entry when the space above is insufficient', () => {
  const { style } = position({ entryTop: 300 });   // 300 − 512 < 12 → 下方
  assert.equal(style.top, '288px');   // 332 + 500 > 788 → 钳底边 800−500−12
});

test('zero-rect entry falls back to the bar anchor; a detached entry closes the popover', () => {
  const fb = position({ entry: 'zero' });
  assert.equal(fb.style.left, '40px');   // bar 中心 450 − 410 = 40，未触边
  assert.equal(fb.style.top, '88px');
  const g = position({ entry: 'gone' });
  assert.equal(g.context.closed, 'entry-gone');
});

/* v217：buildSubPop 签名幂等——同数据重复推送不重建（保持滚动/焦点/选择），数据真变才重建 */
{
  const s0 = source.indexOf('    function subPopItems(sub) {');
  const s1 = source.indexOf('    function positionSubPop() {', s0);
  assert.ok(s0 >= 0 && s1 > s0, 'buildSubPop slice found');
  const buildSource = source.slice(s0, s1);   // 从 subPopItems 起：状态变量（subPopSel/sig/mode）由 ctx 注入

  function makePanel() {
    const panel = { children: [], classList: { add() {}, remove() {}, toggle() {}, contains: () => false } };
    Object.defineProperty(panel, 'innerHTML', {
      get() { return ''; },
      set(v) { panel.children.length = 0; panel.__html = v; },   // 对齐真 DOM：赋值即清子节点
      configurable: true,
    });
    panel.querySelector = () => null;
    panel.querySelectorAll = () => [];
    return panel;
  }
  function runBuild(panel, sub, sel) {
    const ctx = {
      subPopSel: sel || '', subPopMode: 'pinned', subPopSig: panel.__zuSig || '',
      subPanel: panel, subRate: { slots: {} }, state: { cost: 1 },
      pickedSid: 'sid_main', subPopSess: 'sid_main',
      L: (a) => a, ttEsc: (a) => String(a), escAttr: (a) => String(a),
      fmt: () => '1', countFmt: () => '1', fmtMoney: () => '¥1', fmtTime: () => '12:00',
      tpsBand: () => null, FXQ_ICON: '<svg class="tip-fxq"></svg>',
      subPopIco: () => '<svg></svg>',
      subRateSlotText: () => 'est', JSON,
    };
    ctx.subPopSel = (panel.__zuSel = sel !== undefined ? sel : (panel.__zuSel || ''));
    ctx.sub = sub;
    vm.runInNewContext(buildSource + '\nbuildSubPop(sub);', ctx);
    panel.__zuSig = ctx.subPopSig;
    return ctx;
  }

  test('unified popover is not rebuilt while open when the pushed data is unchanged', () => {
    const sub = { total: 100, active: false, requests: 3, cost_usd: 0.5, models: [],
      list: [{ task: 'probe', title: 't', agent: 'zcode-gen', sid: 'sess_subagent_abcd1234',
        input: 1, output: 2, cache_read: 0, reasoning: 0, cache_write: 0, requests: 1, tps_avg: 10, last: 123 }] };
    const panel = makePanel();
    runBuild(panel, sub, '');
    assert.ok(panel.__html && panel.__html.includes('zu-spnav'), 'first build renders shell');
    const marker = { marker: true };
    panel.children.push(marker);
    runBuild(panel, sub, '');
    assert.ok(panel.children.includes(marker), 'same data → DOM untouched (sig early-return)');
    runBuild(panel, Object.assign({}, sub, { total: 200 }), '');
    assert.ok(!panel.children.includes(marker), 'changed data → rebuilt');
    assert.ok(panel.__html.includes('zu-spnav'), 'rebuilt popover renders shell');
  });

  test('unified popover renders summary KPIs, cost and model table from real fields', () => {
    const sub = { total: 100, active: false, requests: 3, cost_usd: 0.5, rate_avg: 90,
      input: 60, output: 30, cache_read: 40, models: [
        { model: 'glm-x', total: 100, requests: 3, cost_usd: 0.5 }] };
    const panel = makePanel();
    runBuild(panel, sub, '');
    const html = panel.__html;
    assert.ok(html.includes('zu-sp-kpis3'), 'primary KPI band');
    assert.ok(html.includes('预估费用'), 'cost KPI present');
    assert.ok(html.includes('zu-sp-models'), 'model table present');
    assert.ok(html.includes('tip-fxq" data-model="glm-x"'), 'per-model ? icon carries data-model');
    assert.ok(!html.includes('查看子代理明细'), 'old CTA removed');
    assert.ok(!html.includes('Enter'), 'no Enter keycap');
  });
}
