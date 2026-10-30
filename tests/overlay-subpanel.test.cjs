const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
const start = source.indexOf('    function positionSubPanel() {');
const end = source.indexOf('    function toggleSubPanel()', start);
assert.ok(start >= 0 && end > start);
const positionSource = source.slice(start, end);

/* v80：面板 fixed 挂 body，left 为视口坐标（条目水平居中后夹紧视口），
 * top = 条上沿 − 面板高 − 10px 缝。 */
function position({ itemLeft = 800, itemWidth = 80, panelWidth = 420, panelHeight = 200,
  viewportWidth = 1200, barTop = 600, open = true, missing = false, theme = 'default', chip = null } = {}) {
  const style = {};
  const context = {
    window: { innerWidth: viewportWidth },
    state: { theme },   // v146：精简模式锚 chip 的分支不触达（default 走条面格）
    tpsChipCache: chip,
    subPanel: { classList: { contains: () => open }, offsetWidth: panelWidth, offsetHeight: panelHeight, style },
    bar: {
      getBoundingClientRect: () => ({ top: barTop }),
      querySelector: () => missing ? null : {
        getBoundingClientRect: () => ({ left: itemLeft, width: itemWidth }),
      },
    },
  };
  vm.runInNewContext(positionSource + '\npositionSubPanel();', context);
  return { style, context };
}

test('sub-agent panel centers above the sub-agent item in viewport coordinates', () => {
  const { style } = position();
  assert.equal(style.left, '630px');   // 800 + 80/2 − 420/2，未触边
  assert.equal(style.top, '390px');    // 600 − 200 − 10
});

test('panel stays inside the right viewport edge', () => {
  const { style } = position({ itemLeft: 1100 });
  assert.equal(style.left, '772px');   // 1200 − 420 − 8
});

test('panel stays inside the left viewport edge', () => {
  const { style } = position({ itemLeft: 10 });
  assert.equal(style.left, '8px');
});

test('panel follows a moved item and a different panel width', () => {
  const { style } = position({ itemLeft: 480, itemWidth: 100, panelWidth: 300 });
  assert.equal(style.left, '380px');
});

test('closed panels and missing sub-agent items are not repositioned', () => {
  assert.deepEqual(position({ open: false }).style, {});
  assert.deepEqual(position({ missing: true }).style, {});
});

/* v177：精简下速率 chip 被摘除（会话切到无速率样本）时不得回落隐藏条内的 .zu-sub——
 * 那是全零矩形，会把开着面板钉到视口左上角；面板保持打开时的最后位置。 */
test('v177 compact: a missing or disconnected rate chip leaves the open panel in place', () => {
  assert.deepEqual(position({ theme: 'compact', chip: null }).style, {});
  assert.deepEqual(position({ theme: 'compact', chip: { isConnected: false } }).style, {});
});

test('v177 compact: a connected rate chip anchors the panel above itself', () => {
  const { style } = position({
    theme: 'compact',
    chip: { isConnected: true, getBoundingClientRect: () => ({ left: 800, width: 80, top: 500 }) },
  });
  assert.equal(style.left, '630px');   // 同条面格：chip 水平居中
  assert.equal(style.top, '290px');    // 500 − 200 − 10
});

test('panel is body-mounted fixed above the bar and positioned on opening and tracking', () => {
  assert.match(source, /\.panel\{position:fixed/);                       // v80：不再依赖 bottom:calc 挂条
  assert.match(source, /buildSubPanel\(lastSub\);\s*positionSubPanel\(\);\s*hideTip\(true, "sub-open"\)/);
  assert.match(source, /positionSubPanel\(\);\s*everMounted = true/);
});

/* ---------- 2026-10-24 夜间扫描回归：面板打开期间的周期推送不得整面板重建 ---------- */

/* buildSubPanel 切片（引用的外层符号在 context 预注入）：同数据重复推送走内容签名早退，
 * 滚动位置/文本选择不被每 1.5s 的泵推送打断；数据真变仍整面板重建。 */
{
  const start2 = source.indexOf('    function buildSubPanel(sub) {');
  const end2 = source.indexOf('    function positionSubPanel()', start2);
  assert.ok(start2 >= 0 && end2 > start2, 'buildSubPanel slice found');
  const buildSource = source.slice(start2, end2);

  function makePanel() {
    const panel = { children: [] };
    Object.defineProperty(panel, 'innerHTML', {
      get() { return ''; },
      set(v) { if (v === '') panel.children.length = 0; },   // 对齐真 DOM：清空即弃子节点
      configurable: true,
    });
    panel.appendChild = (el) => { panel.children.push(el); return el; };
    return panel;
  }
  function runBuild(panel, sub, tab) {
    const ctx = {
      document: { createElement: () => ({ className: '', textContent: '', style: {},
        setAttribute() {}, appendChild() {} }) },
      L: (a) => a, fmt: () => '1', fmtTime: () => '12:00', ioc: () => 'i/o',
      ttRow: (k,v) => k+': '+v, subRateSlotText: () => 'est', subRate: { slots: {} },
      subPanelTab: tab, subPanel: panel, sub, JSON,
    };
    vm.runInNewContext(buildSource + '\nbuildSubPanel(sub);', ctx);
    return ctx;
  }

  test('sub-agent panel is not rebuilt while open when the pushed data is unchanged', () => {
    const sub = { total: 100, active: false, requests: 3, list: [
      { task: 'probe', title: 't', agent: 'zcode-gen', sid: 'sess_subagent_abcd1234',
        input: 1, output: 2, cache_read: 0, reasoning: 0, cache_write: 0, requests: 1, tps_avg: 10, last: 123 }] };
    const panel = makePanel();
    runBuild(panel, sub, 0);
    assert.ok(panel.children.length > 0, 'first build renders content');
    const marker = { marker: true };
    panel.children.push(marker);
    runBuild(panel, sub, 0);   // 同数据推送：签名命中早退
    assert.ok(panel.children.includes(marker), 'same data → DOM untouched');
    runBuild(panel, Object.assign({}, sub, { total: 200 }), 0);   // 数据真变：重建
    assert.ok(!panel.children.includes(marker), 'changed data → panel rebuilt');
    assert.ok(panel.children.length > 0, 'rebuilt panel renders content');
  });
}
