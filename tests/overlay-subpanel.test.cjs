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

function position({ barLeft = 20, border = 1, itemLeft = 800, itemWidth = 80,
  panelWidth = 420, viewportWidth = 1200, open = true, missing = false } = {}) {
  const style = {};
  const context = {
    window: { innerWidth: viewportWidth },
    subPanel: { classList: { contains: () => open }, offsetWidth: panelWidth, style },
    bar: {
      clientLeft: border,
      getBoundingClientRect: () => ({ left: barLeft }),
      querySelector: () => missing ? null : {
        getBoundingClientRect: () => ({ left: itemLeft, width: itemWidth }),
      },
    },
  };
  vm.runInNewContext(positionSource + '\npositionSubPanel();', context);
  return { style, context };
}

test('sub-agent panel centers above the sub-agent item, not the bar left edge', () => {
  const { style } = position();
  assert.equal(style.left, '609px');
});

test('panel stays inside the right viewport edge', () => {
  const { style } = position({ itemLeft: 1100 });
  assert.equal(style.left, '751px');
});

test('panel stays inside the left viewport edge', () => {
  const { style } = position({ itemLeft: 10 });
  assert.equal(style.left, '-13px');
});

test('panel follows a moved item and a different panel width', () => {
  const { style } = position({ itemLeft: 480, itemWidth: 100, panelWidth: 300 });
  assert.equal(style.left, '359px');
});

test('closed panels and missing sub-agent items are not repositioned', () => {
  assert.deepEqual(position({ open: false }).style, {});
  assert.deepEqual(position({ missing: true }).style, {});
});

test('panel remains above the bar and is positioned on opening and tracking', () => {
  assert.match(source, /bottom:calc\(100% \+ 10px\)/);
  assert.match(source, /buildSubPanel\(lastSub\);\s*positionSubPanel\(\);\s*hideTip\(true, "sub-open"\)/);
  assert.match(source, /positionSubPanel\(\);\s*everMounted = true/);
});
