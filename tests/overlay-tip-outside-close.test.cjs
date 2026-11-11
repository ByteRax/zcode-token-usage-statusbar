const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readOverlaySource, getNamedSlice } = require('./helpers/overlay-extract.cjs');
const source = readOverlaySource();

/* v339（issue #297）：数据详情 hover 卡缺少「点击空白/Esc 关闭」。此前唯一关闭途径是
 * 鼠标移开（mousemove 采样 / leave 分流 / chip 的 180ms 延时），点空白不收——详情卡
 * 挡住下方消息流时必须绕开卡片移动鼠标，且 v271/v329 按压硬保活窗（tip 内按压后 1.2s）
 * 会把「点过 Tab 后点空白」的收起也吞掉。修复：
 *  · document mousedown 捕获（tipOutsideDown）：target 落在自绘浮层本体 / 条面 / 设置
 *    面板 / 各弹框之外即外点，主 tip 收 cause="outside"（进 hideTip 硬保活窗白名单，
 *    devKeepTip 总闸不白名单——开发者常驻模式契约不变），chip tooltip 一并收；
 *  · document keydown 冒泡（tipGlobalEsc）：焦点不在条目/浮层内（点空白后落 body）时
 *    既有元素级 Escape 链收不到，此处兜底一次收一个，不 preventDefault 不吞宿主语义。
 * 真实悬停/点击行为由 Playwright 实机验证；本文件锁定判定表。 */

const outsideSrc = getNamedSlice('tipOutsideDown');
const escSrc = getNamedSlice('tipGlobalEsc');
const hideTipSrc = getNamedSlice('hideTipFn');

/* ---- 桩 ---- */
function stubEl(name, { display = 'none', openClass = false, kids = [] } = {}) {
  const node = {
    __name: name,
    style: { display },
    classList: { contains: (c) => openClass && c === 'open' },
    contains: (t) => kids.some((k) => k === t || (k && k.contains && k.contains(t))),
    closest: () => null,
  };
  return node;
}
function stubTarget({ inModal = false } = {}) {
  return {
    __name: 'target',
    closest: (sel) => (inModal && /zu-mp-ov/.test(sel) ? { __name: 'modal' } : null),
  };
}
function runOutside({
  inactive = false, inModal = false, panelOpen = false,
  tipFor = null, quotaTipFor = null, rateTipFor = null, tpsTipFor = null,
  rstTipFor = null, subTipFor = null, gitTipFor = null,
  fxOpen = false, legendOpen = false,
  targetIn = null,   /* 'tip'|'bar'|'panel'|'fx'|'legend'|'tps'|null(空白) */
} = {}) {
  const calls = { hideTip: [], quota: 0, rate: 0, tps: 0, rst: 0, sub: 0, git: 0, fx: 0, legend: 0 };
  const ctx = {
    inactive: () => inactive,
    target: stubTarget({ inModal }),
    tipFor, quotaTipFor, rateTipFor, tpsTipFor, rstTipFor, subTipFor, gitTipFor,
    bar: stubEl('bar'),
    panel: stubEl('panel', { openClass: panelOpen }),
    tip: stubEl('tip'),
    tpsTip: stubEl('tpsTip'),
    rstTip: stubEl('rstTip'),
    subTip: stubEl('subTip'),
    gitTip: stubEl('gitTip'),
    quotaTip: stubEl('quotaTip'),
    rateTip: stubEl('rateTip'),
    fxTip: stubEl('fxTip', { display: fxOpen ? 'block' : 'none' }),
    spdLegendTip: stubEl('legend', { display: legendOpen ? 'block' : 'none' }),
    hideTip: (force, cause) => calls.hideTip.push({ force, cause }),
    hideQuotaTip: () => { calls.quota++; },
    hideRateTip: () => { calls.rate++; },
    hideTpsTip: () => { calls.tps++; },
    hideRstTip: () => { calls.rst++; },
    hideSubTip: () => { calls.sub++; },
    hideGitTip: () => { calls.git++; },
    hideFxTip: () => { calls.fx++; },
    spdLegendTipHide: () => { calls.legend++; },
  };
  /* contains 回填：targetIn 指定的容器视 target 为后代（ctx 构造完成后再绑定） */
  ctx.tip.contains = (t) => targetIn === 'tip' && t === ctx.target;
  ctx.tpsTip.contains = (t) => targetIn === 'tps' && t === ctx.target;
  ctx.rstTip.contains = (t) => targetIn === 'rst' && t === ctx.target;
  ctx.subTip.contains = (t) => targetIn === 'sub' && t === ctx.target;
  ctx.gitTip.contains = (t) => targetIn === 'git' && t === ctx.target;
  ctx.quotaTip.contains = (t) => targetIn === 'quota' && t === ctx.target;
  ctx.rateTip.contains = (t) => targetIn === 'rate' && t === ctx.target;
  ctx.bar.contains = () => targetIn === 'bar';
  ctx.panel.contains = (t) => panelOpen && targetIn === 'panel';
  ctx.fxTip.contains = (t) => targetIn === 'fx' && t === ctx.target;
  ctx.spdLegendTip.contains = (t) => targetIn === 'legend' && t === ctx.target;
  const result = { calls };
  vm.runInNewContext(outsideSrc + '\n__result = tipOutsideDown(__ev);',
    Object.assign(vm.createContext(ctx), { __ev: { target: ctx.target }, __result: null }));
  return result;
}

test('外点 mousedown：主 tip 以 outside 立即收起', () => {
  const r = runOutside({ tipFor: {} });
  assert.deepEqual(r.calls.hideTip, [{ force: true, cause: 'outside' }]);
  assert.equal(r.calls.tps, 0);
});

test('tip 本体/条面/设置面板内部按压不是外点（切格、re-click、⚙ 依赖这些路径）', () => {
  assert.deepEqual(runOutside({ tipFor: {}, targetIn: 'tip' }).calls.hideTip, []);
  assert.deepEqual(runOutside({ tipFor: {}, targetIn: 'bar' }).calls.hideTip, []);
  assert.deepEqual(runOutside({ tipFor: {}, panelOpen: true, targetIn: 'panel' }).calls.hideTip, []);
  /* 面板开着但点在面板外空白：仍算外点（与设置面板自身 outside 判定同向） */
  assert.deepEqual(runOutside({ tipFor: {}, panelOpen: true }).calls.hideTip,
    [{ force: true, cause: 'outside' }]);
});

test('弹框内部不算外点（词包查看/模型选择/压缩确认/子代理浮层各自有关闭链）', () => {
  assert.deepEqual(runOutside({ tipFor: {}, inModal: true }).calls.hideTip, []);
});

test('v271 硬保活窗白名单：outside 不被 1.2s 窗吞掉，left-bar 仍被吞（既有回归）', () => {
  function runHide({ cause, lastDown, devKeep = 0, mouseInBar = false }) {
    const tipStats = { hides: 0, lastHide: '', hideSeq: [] };
    const ctx = {
      state: { devKeepTip: devKeep },
      cause, force: true, mouseInBar,
      lastTipDownAt: lastDown,
      Date, setTimeout, clearTimeout,
      tipStats,
      spdHoverPortalHide: () => { }, spdLegendTipHide: () => { },
      tipGraceTimer: 0, clearTimeoutRef: clearTimeout,
      tip: { style: { display: 'block' }, removeAttribute: () => { } },
      tipFor: {}, fxTip: { style: { display: 'none' } },
      hideFxTip: () => { },
    };
    vm.runInNewContext(hideTipSrc + '\n__result = hideTip(__force, __cause);',
      Object.assign(vm.createContext(ctx), { __force: true, __cause: cause }));
    return tipStats;
  }
  const now = Date.now();
  assert.equal(runHide({ cause: 'outside', lastDown: now - 100 }).lastHide, 'outside',
    '按压窗内点空白是显式关闭意图，必须收');
  assert.equal(runHide({ cause: 'left-bar', lastDown: now - 100 }).lastHide, 'blocked:left-bar',
    'left-bar 在硬保活窗内仍被吞（v271 既有行为不变）');
  assert.equal(runHide({ cause: 'left-bar', lastDown: 0 }).lastHide, 'left-bar');
  assert.equal(runHide({ cause: 'outside', lastDown: now - 100, devKeep: 1 }).lastHide,
    'dev-keep:outside', 'devKeepTip 常驻模式契约不变：outside 不在总闸白名单');
  assert.equal(runHide({ cause: 'escape', lastDown: now - 100, devKeep: 1 }).lastHide, 'escape',
    'devKeepTip 下 Escape 仍可关（既有）');
});

test('chip tooltip 外点一并收，本体内部按压保持', () => {
  const chips = { quotaTipFor: 'quota', rateTipFor: 'rate', tpsTipFor: 'tps', rstTipFor: 'rst', subTipFor: 'sub', gitTipFor: 'git' };
  for (const [field, key] of Object.entries(chips)) {
    const o = {}; o[field] = {};
    const r = runOutside(o);
    assert.equal(r.calls[key], 1, `${key} tooltip 外点应收`);
    assert.deepEqual(r.calls.hideTip, [], '主 tip 未开不受影响');
  }
  assert.equal(runOutside({ tpsTipFor: {}, targetIn: 'tps' }).calls.tps, 0, 'tpsTip 内按压保持');
});

test('费用说明/档位说明浮层：外点收、内部按压保持', () => {
  const r = runOutside({ fxOpen: true, legendOpen: true });
  assert.equal(r.calls.fx, 1);
  assert.equal(r.calls.legend, 1);
  assert.equal(runOutside({ fxOpen: true, targetIn: 'fx' }).calls.fx, 0, '费用气泡内按压保持');
  assert.equal(runOutside({ legendOpen: true, targetIn: 'legend' }).calls.legend, 0, '档位说明内按压保持');
});

test('实例失效与全关时零开销早退（不触发 closest）', () => {
  assert.deepEqual(runOutside({ inactive: true, tipFor: {} }).calls.hideTip, []);
  const probes = [];
  const ctx2 = {
    inactive: () => false,
    tipFor: null, quotaTipFor: null, rateTipFor: null, tpsTipFor: null,
    rstTipFor: null, subTipFor: null, gitTipFor: null,
    fxTip: { style: { display: 'none' } }, spdLegendTip: { style: { display: 'none' } },
    target: { closest: (s) => { probes.push(s); return null; } },
  };
  vm.runInNewContext(outsideSrc + '\n__result = tipOutsideDown(__ev);',
    Object.assign(vm.createContext(ctx2), { __ev: { target: ctx2.target } }));
  assert.deepEqual(probes, [], '全关时不得做 closest 探测');
});

function runEsc({ key = 'Escape', inactive = false, tipFor = null, tpsTipFor = null,
  rstTipFor = null, quotaTipFor = null, gitTipFor = null, subTipFor = null, rateTipFor = null,
  fxOpen = false, legendOpen = false } = {}) {
  const calls = { hideTip: [], tps: 0, rst: 0, quota: 0, git: 0, sub: 0, rate: 0, fx: 0, legend: 0, prevented: 0, stopped: 0 };
  const ctx = {
    inactive: () => inactive,
    tipFor, tpsTipFor, rstTipFor, quotaTipFor, gitTipFor, subTipFor, rateTipFor,
    fxTip: { style: { display: fxOpen ? 'block' : 'none' } },
    spdLegendTip: { style: { display: legendOpen ? 'block' : 'none' } },
    hideTip: (force, cause) => calls.hideTip.push({ force, cause }),
    hideTpsTip: () => { calls.tps++; },
    hideRstTip: () => { calls.rst++; },
    hideQuotaTip: () => { calls.quota++; },
    hideGitTip: () => { calls.git++; },
    hideSubTip: () => { calls.sub++; },
    hideRateTip: () => { calls.rate++; },
    hideFxTip: () => { calls.fx++; },
    spdLegendTipHide: () => { calls.legend++; },
  };
  const ev = { key, preventDefault: () => { calls.prevented++; }, stopPropagation: () => { calls.stopped++; } };
  vm.runInNewContext(escSrc + '\n__result = tipGlobalEsc(__ev);',
    Object.assign(vm.createContext(ctx), { __ev: ev }));
  return calls;
}

test('全局 Escape 兜底：焦点在 body 时也能收起当前打开的详情卡（一次收一个）', () => {
  assert.deepEqual(runEsc({ tipFor: {} }).hideTip, [{ force: true, cause: 'escape' }]);
  assert.equal(runEsc({ tipFor: {} }).tps, 0, '主 tip 收起时不再连带 chip（hideTip 链内自收 fx/legend）');
  assert.equal(runEsc({ tpsTipFor: {} }).tps, 1);
  assert.equal(runEsc({ rstTipFor: {} }).rst, 1);
  assert.equal(runEsc({ quotaTipFor: {} }).quota, 1);
  assert.equal(runEsc({ subTipFor: {} }).sub, 1);
  assert.equal(runEsc({ rateTipFor: {} }).rate, 1);
  assert.equal(runEsc({ gitTipFor: {} }).git, 1);
  assert.equal(runEsc({ fxOpen: true }).fx, 1);
  assert.equal(runEsc({ legendOpen: true }).legend, 1);
  assert.equal(runEsc({}).fx, 0, '全关时无动作');
});

test('非 Escape 键与实例失效不动作；兜底不吞宿主键盘语义', () => {
  assert.deepEqual(runEsc({ key: 'a', tipFor: {} }).hideTip, []);
  assert.deepEqual(runEsc({ inactive: true, tipFor: {} }).hideTip, []);
  const c = runEsc({ tipFor: {} });
  assert.equal(c.prevented, 0, '不 preventDefault');
  assert.equal(c.stopped, 0, '不 stopPropagation');
});

test('挂载契约：mousedown 捕获 / keydown 冒泡（不抢 tip 内分层 Esc）', () => {
  assert.match(source, /listenGlobal\(document, "mousedown", tipOutsideDown, true\)/);
  assert.match(source, /listenGlobal\(document, "keydown", tipGlobalEsc\);?\s*\n/);
  assert.doesNotMatch(source, /listenGlobal\(document, "keydown", tipGlobalEsc, true\)/,
    'Escape 必须冒泡挂载，否则抢跑 tip 内「先收档位说明不关卡」分层');
});
