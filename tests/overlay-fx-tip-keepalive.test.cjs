const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { sliceOverlay } = require('./helpers/overlay-extract.cjs');

/* v227：预估费用说明小气泡（fxTip）悬停保活。fxTip 是 body 级独立浮层，挂在主 tip 与
 * 子代理浮层（.zu-sub-pop）之外——指针从 ? 图标移入气泡后，文档 mousemove 的「条外」
 * 分支把它判成 left-bar 强制收主 tip（hideTip 同步收气泡），子代理面板则被
 * preview-leave 倒计时收走，悬停说明气泡即灭。修复=处理器节流前新增分支：fxTip 显示中
 * 且目标在气泡内视同仍在 tooltip 上。本文件锁定该分支的判定表与「先于节流」的位置契约。
 * 真实悬停路径（伪 leave 过滤、8px 悬空缝）仍由实机指针验收，VM 合成事件测不出。 */

const handlerSource = sliceOverlay('listenGlobal(document, "mousemove"', '}, true);', { includeEnd: true });

function makeHandler(ctxExtra = {}) {
  let handler = null;
  const ctx = Object.assign({
    listenGlobal(target, type, fn) { handler = fn; },
    document: {},
    inactive: () => false,
    subPopOpen: () => false,
    subPopCancelHide: () => {},
    subPopScheduleHide: () => {},
    cancelTipGrace: () => {},
    hideTip: () => {},
    lastMoveAt: 0,
    mouseInBar: true,
    tipStats: { mv: 0, corridor: 0, grace: 0 },
    tip: { contains: () => false },
    bar: { contains: () => false },
    panel: { classList: { contains: () => false } },
    tipFor: null,
    inTipCorridor: () => false,
    inTipColumn: () => false,
    hitItemFor: () => null,
    showTipFor: () => {},
    drawTip: () => {},
    tipSig: '',
    state: { theme: 'default', tipClick: 0 },
    subPopMode: 'closed',
    subPopSuppressAt: 0,
    fxTip: { style: { display: 'none' }, closest: () => null, contains: () => false },
  }, ctxExtra);
  // Object.assign 会把访问器属性摊平成数据属性：ctxExtra 里的 getter/setter 按描述符重放
  Object.keys(ctxExtra).forEach(k => {
    const d = Object.getOwnPropertyDescriptor(ctxExtra, k);
    if (d && (d.get || d.set)) Object.defineProperty(ctx, k, d);
  });
  vm.runInNewContext(handlerSource, vm.createContext(ctx));
  assert.ok(handler, 'handler captured');
  return handler;
}

test('fxTip 显示中：指针进入气泡本体/子元素视同仍在 tooltip 上（不收主 tip 与气泡）', () => {
  const calls = { cancelGrace: 0, popCancel: 0, popSchedule: 0, hide: [] };
  const fxTip = { style: { display: 'block' }, closest: () => null, contains: () => false };
  const handler = makeHandler({
    fxTip,
    mouseInBar: false,
    cancelTipGrace: () => { calls.cancelGrace++; },
    subPopCancelHide: () => { calls.popCancel++; },
    subPopScheduleHide: () => { calls.popSchedule++; },
    hideTip: (force, cause) => { calls.hide.push({ force, cause }); },
  });
  // 气泡本体（padding/边框命中）
  handler({ target: fxTip, clientX: 500, clientY: 200 });
  assert.deepEqual(calls.hide, [], '不得收主 tip');
  assert.equal(fxTip.style.display, 'block');
  assert.equal(calls.cancelGrace, 1, '取消越顶宽限');
  assert.equal(calls.popCancel, 1, '取消子代理面板延迟关闭');
  assert.equal(calls.popSchedule, 0);
  // 子元素命中（气泡内文字/链接）：contains 命中即保活，不依赖 closest 结果
  const child = { closest: () => null };
  fxTip.contains = el => el === child;
  handler({ target: child, clientX: 500, clientY: 210 });
  assert.deepEqual(calls.hide, []);
  assert.equal(calls.cancelGrace, 2);
});

test('保活分支先于 150ms 节流：节流窗口内进入气泡也立即生效（停在气泡里不动不熄灭）', () => {
  let mv = 0;
  const calls = { cancelGrace: 0 };
  const fxTip = { style: { display: 'block' }, closest: () => null, contains: () => true };
  const handler = makeHandler({
    fxTip,
    lastMoveAt: Date.now(),   // 刚节流过：落到旧判定会在 150ms 节流处直接 return
    tipStats: { get mv() { return mv; }, set mv(v) { mv = v; }, corridor: 0, grace: 0 },
    cancelTipGrace: () => { calls.cancelGrace++; },
  });
  handler({ target: fxTip, clientX: 500, clientY: 200 });
  assert.equal(calls.cancelGrace, 1, '分支仍执行');
  assert.equal(mv, 0, '早退发生在 tipStats.mv 计数之前（节流之前）');
});

test('fxTip 隐藏或目标在气泡外：不拦截，回落原判定（left-bar 照旧）', () => {
  const hides = [];
  const mouse = { v: true };
  const mk = fxDisplay => makeHandler({
    fxTip: { style: { display: fxDisplay }, closest: () => null, contains: () => false },
    tipFor: {},
    get mouseInBar() { return mouse.v; }, set mouseInBar(v) { mouse.v = v; },
    hideTip: (force, cause) => { hides.push({ force, cause }); },
  });
  // 隐藏的 fxTip 不构成保活
  let handler = mk('none');
  handler({ target: { closest: () => null }, clientX: 100, clientY: 100 });
  assert.deepEqual(hides, [{ force: true, cause: 'left-bar' }]);
  assert.equal(mouse.v, false);
  // 显示中的 fxTip 也只保气泡内：目标悬停别处照旧收
  hides.length = 0; mouse.v = true;
  handler = mk('block');
  handler({ target: { closest: () => null }, clientX: 100, clientY: 100 });
  assert.deepEqual(hides, [{ force: true, cause: 'left-bar' }]);
});

test('子代理浮层开着时指针进入气泡：取消面板延迟关闭、不安排收起', () => {
  const calls = { popCancel: 0, popSchedule: 0 };
  const fxTip = { style: { display: 'block' }, contains: () => true };
  const handler = makeHandler({
    fxTip,
    subPopOpen: () => true,
    subPopCancelHide: () => { calls.popCancel++; },
    subPopScheduleHide: () => { calls.popSchedule++; },
  });
  handler({ target: { closest: () => null }, clientX: 500, clientY: 200 });
  assert.equal(calls.popCancel, 1);
  assert.equal(calls.popSchedule, 0, 'preview-leave 倒计时不因气泡悬停启动');
});

test('位置契约：fxTip 保活分支必须位于 subPop 进出判定与 150ms 节流之前', () => {
  const branch = handlerSource.indexOf('fxTip.style.display === "block"');
  const popBlock = handlerSource.indexOf('subPopOpen()');
  const throttle = handlerSource.indexOf('lastMoveAt < 150');
  assert.ok(branch > 0 && popBlock > 0 && throttle > 0);
  assert.ok(branch < popBlock && branch < throttle, '保活判定先于 subPop 块与节流返回');
});
