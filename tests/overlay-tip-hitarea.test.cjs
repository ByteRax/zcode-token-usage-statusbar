const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* v117 悬停命中区扩到整栏：hitItemFor 把条面空隙/分隔符按 sep 中线就近归属到条目。
 * 切片纪律（tests.md）：函数体自源码切出、sandbox 提供 main 桩与伪元素，
 * closest/getBoundingClientRect 按语义桩化；行为断言 + handler 接线各占一半。 */
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
const start = source.indexOf('function hitItemFor');
const end = source.indexOf('/* 事件挂 document 捕获阶段');
assert.ok(start > 0 && end > start, 'hitItemFor slice anchors found');

function makeFixture(opts = {}) {
  const its = (opts.items || ['it0', 'it1', 'it2']).map((name, i) => ({
    name, __tip: opts.noTipLast && i === (opts.items || ['it0', 'it1', 'it2']).length - 1 ? null : 'tip-' + name,
  }));
  // sep 加宽到 40px：中线与边缘差足以采样（真实 sep 是 1px 竖线，中点即分界）
  const seps = [{ left: 100, right: 140 }, { left: 200, right: 240 }]
    .map(r => ({ getBoundingClientRect: () => r }));
  const main = { querySelectorAll: (sel) => (sel === '.it' ? its : sel === '.sep' ? seps : []) };
  const hitItemFor = vm.runInNewContext('(' + source.slice(start, end) + ')', { main });
  const target = (isIt, inMain) => ({
    closest(sel) {
      if (sel === '.it') return isIt ? its[1] : null;
      if (sel === '.zu-main') return inMain ? main : null;
      return null;
    },
  });
  return { hitItemFor, its, target };
}

test('direct .it hit returns the item itself', () => {
  const f = makeFixture();
  assert.equal(f.hitItemFor(f.target(true, true), 0), f.its[1]);
});

test('gap inside .zu-main maps to the item left of the crossed sep midpoint', () => {
  const f = makeFixture();
  assert.equal(f.hitItemFor(f.target(false, true), 50), f.its[0]);   // sep0 中线 120 以左
  assert.equal(f.hitItemFor(f.target(false, true), 130), f.its[1]);  // sep0 中线右侧仍归右条目
  assert.equal(f.hitItemFor(f.target(false, true), 150), f.its[1]);  // 两中线之间
  assert.equal(f.hitItemFor(f.target(false, true), 230), f.its[2]);  // sep1 中线以右进尾空隙
});

test('gap right of the last sep falls back to the last item only when it has a tip', () => {
  const f = makeFixture();
  assert.equal(f.hitItemFor(f.target(false, true), 250), f.its[2]);
  const g = makeFixture({ noTipLast: true });
  assert.equal(g.hitItemFor(g.target(false, true), 250), null);   // 兜底目标无 __tip：维持 v33.2 保持不动
});

test('gear and empty bar keep the v33.2 no-op (null)', () => {
  const f = makeFixture();
  assert.equal(f.hitItemFor(f.target(false, false), 50), null);   // ⚙ 在 .zu-main 之外
  const empty = makeFixture({ items: [] });
  assert.equal(empty.hitItemFor(empty.target(false, true), 50), null);
});

test('mousemove handler routes hits through hitItemFor with clientX', () => {
  const h = source.indexOf('listenGlobal(document, "mousemove"');
  const handler = source.slice(h, source.indexOf('}, true);', h));
  assert.match(handler, /var el = hitItemFor\(t, e\.clientX\);/);
  assert.doesNotMatch(handler, /var el = t\.closest\("\.it"\);/);
});
