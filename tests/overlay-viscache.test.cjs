const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* v115 可见性判定 TTL 缓存（上游 xhwxt PR #26 同源）：ghostOf / modalOpenCached /
 * reallyVisible(hitSelf) / coverOK(cardHitOK) 在同一矩形+模式下 120~150ms 内复用结果，
 * 元素矩形一变立即重算。行为级断言：elementFromPoint / getComputedStyle 只在未命中时发生。
 * 切片纪律：visible 在切片外，桩为恒真；coverOK 片段引用实例级 cardCache，桩为 null。 */
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
function slice(from, to) {
  const a = source.indexOf(from), b = source.indexOf(to);
  assert.ok(a > 0 && b > a, 'slice markers: ' + from);
  return source.slice(a, b);
}
const visFns = slice('    function isOwnOverlay(el) {', '    function findComposer() {');
const coverFns = slice('    function coverOK(el) {', '    /* 隐藏态诊断');

function boot() {
  const calls = { gcs: 0, efp: 0, qs: 0 };
  const body = { children: [] };
  const sandbox = vm.createContext({
    innerWidth: 1200, innerHeight: 800,
    hitEl: null, cardCache: null, calls,
    visible: () => true,   // 切片外依赖：恒真，本测试只关心缓存行为
    getComputedStyle: el => {
      calls.gcs++;
      return Object.assign({ visibility: 'visible', opacity: '1', display: 'block', position: 'static', zIndex: 'auto', backgroundColor: 'transparent' }, el && el.computed);
    },
    document: {
      body,
      hidden: false,
      querySelector: () => { calls.qs++; return null; },
      querySelectorAll: () => { calls.qs++; return []; },
      elementFromPoint: () => { calls.efp++; return sandbox.hitEl; },
    },
  });
  vm.runInContext(visFns + '\n' + coverFns, sandbox);
  return { sandbox, calls };
}
function makeEl(sandbox, rect) {
  return vm.runInContext('(function(r){ return { rect: r,' +
    ' getBoundingClientRect: function(){ return this.rect; },' +
    ' parentElement: document.body, contains: function(){ return false; },' +
    ' closest: function(){ return ".panel"; } }; })', sandbox)(rect);
}
/* 命中一个只部分覆盖输入框的外来元素：reallyVisible 判「部分遮挡仍可见」（v65 豁免），
 * coverOK 无此豁免判 false——两个家族在同一元素同一矩形上值分歧，是键隔离的照妖镜 */
function partialCover() {
  return { getBoundingClientRect: () => ({ left: 20, top: 405, right: 400, bottom: 420 }),
    contains: () => false, closest: () => null };
}
function fullCover() {
  return { getBoundingClientRect: () => ({ left: 0, top: 0, right: 600, bottom: 600 }),
    contains: () => false, closest: () => null };
}
/* 整体罩住但命中自有浮层类：ownOK=true 走 v40/v41 自有面板豁免判可见、ownOK=false 仍判被盖 */
function ownFullCover() {
  return { getBoundingClientRect: () => ({ left: 0, top: 0, right: 600, bottom: 600 }),
    contains: () => false, closest: () => ".panel" };
}
/* 从左上角罩住但右缘未达输入框右缘：partial 判定的 right 腿（hr.right < r.right）唯一成立 */
function cornerCover() {
  return { getBoundingClientRect: () => ({ left: 0, top: 0, right: 300, bottom: 600 }),
    contains: () => false, closest: () => null };
}
/* 从左上角罩住、右缘超出但下缘未达：partial 判定的 bottom 腿（hr.bottom < r.bottom）唯一成立 */
function cornerCoverBottom() {
  return { getBoundingClientRect: () => ({ left: 0, top: 0, right: 600, bottom: 300 }),
    contains: () => false, closest: () => null };
}

test('ghostOf caches inGhostSubtree per element within TTL', () => {
  const { sandbox, calls } = boot();
  const el = makeEl(sandbox, { left: 10, top: 400, width: 500, height: 50, right: 510, bottom: 450 });
  assert.equal(sandbox.ghostOf(el), false);
  assert.equal(sandbox.ghostOf(el), false);   // TTL 内复用：不再沿祖先链取计算样式
  assert.equal(calls.gcs, 1);
});

test('reallyVisible caches by rect+mode: same-key rect change recomputes, mode change recomputes', () => {
  const { sandbox, calls } = boot();
  const rect = { left: 10, top: 400, width: 500, height: 50, right: 510, bottom: 450 };
  const el = makeEl(sandbox, rect);
  sandbox.hitEl = partialCover();   // 部分遮挡 → 两模式均为可见（partial 豁免不依赖 ownOK）
  assert.equal(sandbox.reallyVisible(el, false), true);
  assert.equal(sandbox.reallyVisible(el, false), true);   // 同键同矩形：命中缓存
  assert.equal(calls.efp, 1);
  el.rect = { left: 10, top: 410, width: 500, height: 50, right: 510, bottom: 460 };   // 同键改矩形：必须重算
  assert.equal(sandbox.reallyVisible(el, false), true);
  assert.equal(calls.efp, 2);
  assert.equal(sandbox.reallyVisible(el, false), true);   // 新矩形缓存命中
  assert.equal(calls.efp, 2);
  sandbox.hitEl = cornerCover();   // 左上罩住、右缘未达输入框右缘：partial 的 right 腿唯一成立
  el.rect = { left: 10, top: 420, width: 500, height: 50, right: 510, bottom: 470 };   // 再改矩形触发重算走该腿
  assert.equal(sandbox.reallyVisible(el, false), true);
  assert.equal(calls.efp, 3);
  sandbox.hitEl = cornerCoverBottom();   // 下缘未达：bottom 腿唯一成立（其余三腿全假）
  el.rect = { left: 10, top: 430, width: 500, height: 50, right: 510, bottom: 480 };   // 同键改矩形触发重算走该腿
  assert.equal(sandbox.reallyVisible(el, false), true);
  assert.equal(calls.efp, 4);
  sandbox.hitEl = fullCover();      // 换成整体罩住（非自有浮层）：两模式均判被盖
  assert.equal(sandbox.reallyVisible(el, true), false);   // 模式键 "o" ≠ "n"：重算
  assert.equal(calls.efp, 5);
});

test('ownOK exempts own overlays when fully covered: mode divergence is cached per key', () => {
  const { sandbox, calls } = boot();
  const el = makeEl(sandbox, { left: 10, top: 400, width: 500, height: 50, right: 510, bottom: 450 });
  sandbox.hitEl = ownFullCover();   // 整体罩住但命中 .panel（自有浮层）
  assert.equal(sandbox.reallyVisible(el, false), false);   // ownOK=false：无豁免，判被盖
  assert.equal(calls.efp, 1);
  assert.equal(sandbox.reallyVisible(el, true), true);     // ownOK=true：v40/v41 豁免，判可见
  assert.equal(calls.efp, 2);
  assert.equal(sandbox.reallyVisible(el, true), true);     // "o" 键缓存命中
  assert.equal(sandbox.reallyVisible(el, false), false);   // 回落 "n" 键：重算而非读 "o" 的 true
  assert.equal(calls.efp, 3);
});

test('coverOK and reallyVisible cache entries do not cross-pollinate (o/n vs c)', () => {
  const { sandbox, calls } = boot();
  const el = makeEl(sandbox, { left: 10, top: 400, width: 500, height: 50, right: 510, bottom: 450 });
  sandbox.hitEl = partialCover();
  /* 同元素同矩形：reallyVisible=部分遮挡可见(true)，coverOK=无豁免判被盖(false)——值分歧 */
  assert.equal(sandbox.reallyVisible(el, false), true);   // 写入 "n"=true
  assert.equal(calls.efp, 1);
  assert.equal(sandbox.coverOK(el), false);               // 写入 "c"=false（单条目被覆盖）
  assert.equal(calls.efp, 2);
  assert.equal(sandbox.reallyVisible(el, false), true);   // "n"≠"c" 必须 miss 重算，不得读回 "c" 的 false
  assert.equal(calls.efp, 3);
  assert.equal(sandbox.coverOK(el), false);               // "c"≠"n" 同理重算
  assert.equal(calls.efp, 4);
  sandbox.hitEl = fullCover();   // 整体罩住：补「缓存命中读回 false」的读回路径（防 val 被写死 true 的变异存活）
  assert.equal(sandbox.reallyVisible(el, false), false);   // 重算写入 "n"=false
  assert.equal(calls.efp, 5);
  assert.equal(sandbox.reallyVisible(el, false), false);   // 命中读回 false，不重算
  assert.equal(calls.efp, 5);
});

test('coverOK recomputes on same-key rect change and keeps TTL semantics otherwise', () => {
  const { sandbox, calls } = boot();
  const el = makeEl(sandbox, { left: 10, top: 400, width: 500, height: 50, right: 510, bottom: 450 });
  sandbox.hitEl = el;   // 命中自身 → 可见
  assert.equal(sandbox.coverOK(el), true);
  assert.equal(sandbox.coverOK(el), true);   // 同矩形同键：命中缓存
  assert.equal(calls.efp, 1);
  sandbox.hitEl = null;   // 缓存期内改动命中元素不影响返回值（矩形未变，TTL 陈旧语义）
  assert.equal(sandbox.coverOK(el), true);
  assert.equal(calls.efp, 1);
  sandbox.hitEl = el;   // 恢复命中自身，再验同键改矩形的重算
  el.rect = { left: 10, top: 410, width: 500, height: 50, right: 510, bottom: 460 };   // 同键改矩形：重算
  assert.equal(sandbox.coverOK(el), true);
  assert.equal(calls.efp, 2);
  el.rect = { left: 10, top: 440, width: 500, height: 50, right: 510, bottom: 490 };   // 换矩形 + 整体罩住：coverOK 的 false 读回路径
  sandbox.hitEl = fullCover();
  assert.equal(sandbox.coverOK(el), false);   // 重算写入 "c"=false
  assert.equal(calls.efp, 3);
  assert.equal(sandbox.coverOK(el), false);   // 命中读回 false，不重算
  assert.equal(calls.efp, 3);
});

test('modalOpenCached skips modalOpen querySelector within TTL', () => {
  const { sandbox, calls } = boot();
  assert.equal(sandbox.modalOpenCached(), false);   // 无弹窗：querySelector 恒 null
  assert.equal(calls.qs, 1);
  assert.equal(sandbox.modalOpenCached(), false);   // TTL 内短路：不再查询
  assert.equal(calls.qs, 1);
});

test('plugin settings dialog and large plugin panel never count as a host modal', () => {
  const { sandbox } = boot();
  const classes = { contains: name => name === 'zusage-panel' };
  const ownDialog = { classList: classes, computed: { display: 'block' } };
  const ownPanel = { classList: classes, getBoundingClientRect: () => ({ width: 1200, height: 800 }), computed: {
    position: 'fixed', display: 'block', visibility: 'visible', opacity: '1', zIndex: '2147483647', backgroundColor: 'rgb(20, 20, 20)',
  } };
  const hostDialog = { computed: { display: 'block' } };
  const hostOverlay = { getBoundingClientRect: () => ({ width: 1200, height: 800 }), computed: {
    position: 'fixed', display: 'block', visibility: 'visible', opacity: '1', zIndex: '40', backgroundColor: 'rgba(0, 0, 0, 0.5)',
  } };
  let dialogs = [ownDialog];
  sandbox.document.querySelectorAll = selector => selector === '[role="dialog"]' ? dialogs : [];
  sandbox.document.body.children = [ownPanel];
  assert.equal(sandbox.modalOpen(), false, 'own dialog and panel are not a host modal');
  dialogs = [hostDialog];
  assert.equal(sandbox.modalOpen(), false, 'own panel is not a host overlay');
  dialogs = [ownDialog];
  sandbox.document.body.children = [hostOverlay];
  assert.equal(sandbox.modalOpen(), false, 'own dialog is not a host dialog');
  dialogs = [hostDialog];
  assert.equal(sandbox.modalOpen(), true, 'real host modal still hides the bar');
});

test('hidden dialog does not suppress the bar, while a visible dialog with an overlay does', () => {
  const { sandbox } = boot();
  const dialog = { computed: { display: 'none' } };
  const overlay = { getBoundingClientRect: () => ({ width: 1200, height: 800 }), computed: {
    position: 'fixed', display: 'block', visibility: 'visible', opacity: '1', zIndex: '40', backgroundColor: 'rgba(0, 0, 0, 0.5)',
  } };
  sandbox.document.querySelectorAll = selector => selector === '[role="dialog"]' ? [dialog] : [];
  sandbox.document.body.children = [overlay];
  assert.equal(sandbox.modalOpen(), false, 'a display:none settings panel is not a modal overlay');
  dialog.computed = { display: 'block' };
  assert.equal(sandbox.modalOpen(), true, 'a visible dialog plus a full-screen fixed overlay is modal');
});
