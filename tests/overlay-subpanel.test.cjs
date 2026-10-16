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
  viewportWidth = 1200, barTop = 600, open = true, missing = false } = {}) {
  const style = {};
  const context = {
    window: { innerWidth: viewportWidth },
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

test('panel is body-mounted fixed above the bar and positioned on opening and tracking', () => {
  assert.match(source, /\.panel\{position:fixed/);                       // v80：不再依赖 bottom:calc 挂条
  assert.match(source, /buildSubPanel\(lastSub\);\s*positionSubPanel\(\);\s*hideTip\(true, "sub-open"\)/);
  assert.match(source, /positionSubPanel\(\);\s*everMounted = true/);
});
