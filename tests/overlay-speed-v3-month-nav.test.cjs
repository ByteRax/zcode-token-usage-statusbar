'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');
const { readOverlayPart, sliceOverlay, getNamedSlice } = require('./helpers/overlay-extract.cjs');

// v479 月份导航事件级 harness（specs/speed-tooltip-v3.md §28.5）：把 06 主卡链与 01 精简
// chip 链的真实源码切片（spd3Activate / tpsSpd3Activate、speedTabActivate、tip 的
// mousedown 与 keydown 委托）跑在 VM 里，配极简假元素，验证四类动作、Esc、互斥、
// 边界与焦点归位在两条链上同构。状态机本体（wire 分片 spd3MonthAct/Anchor/Focus）与
// core 的筛选函数整文进 VM（真实实现，不打桩）；只对实例闭包私有名给替身，且都是
// 真实作用域存在的名字（speedSel / speedRebuildNow / tip / tpsTip / tpsTipFor /
// showTpsTip）——注入不存在的同名桩会掩盖真实页面里的 ReferenceError。
const core = readOverlayPart('04-speed-v3-core.js');
const view = readOverlayPart('04-speed-v3-view.js');
const wire = readOverlayPart('04-speed-v3-wire.js');
const bands = sliceOverlay('  var TPS_BANDS = [', '  /* tooltip 颜色对照图例');
const spdHelpers = sliceOverlay('  var SPD_RANGES = [', '  var SPD_PORTAL = "";');
const spdCompact = sliceOverlay('  function spdCompactRange(a, b) {', '  var SPD_PORTAL = "";');
// 06 主卡链切片（spawnInstance 闭包内，按整行锚点取）
const act06 = sliceOverlay('    function spd3Activate(e) {', '    /* 任何按下交互（含维度 select、柱）都立即进入 600ms 交互冻结');
const tab06 = sliceOverlay('    function speedTabActivate(e) {', '    /* v384 V3 模型筛选交互：');
const mouse06 = sliceOverlay('    tip.addEventListener("mousedown", function (e) {\n      /* v329：防止 tip 内交互元素', '    tip.addEventListener("click", function (e) {');
const key06 = sliceOverlay('    tip.addEventListener("keydown", function (e) {\n      if (e.key === "Tab" && e.shiftKey', '    tip.addEventListener("mouseout", function (e) {');
// 01 精简 chip 链切片（模块级）
const act01 = sliceOverlay('  function tpsSpd3Activate(e) {', '  /* v384 M3：tpsTip 链补 mousedown 阻断名单');
const mouse01 = sliceOverlay('  tpsTip.addEventListener("mousedown", function (e) {', '  tpsTip.addEventListener("pointerdown", function (e) {');
const key01 = sliceOverlay('  tpsTip.addEventListener("keydown", function (e) {\n    /* v384 M1：方向键移动', '  /* v384 V3 筛选弹出层搜索：input 委托挂 tpsTip 本体');
// v479「点弹层之外即收」的接入点：两条链 tip 的 pointerdown 委托，与整卡隐藏函数
// （弹层态随卡复位）；01 的 tpsTabActivate 随 down01 一起被调用，一并取真实实现
const down06 = sliceOverlay('    tip.addEventListener("pointerdown", function (e) {', '    tip.addEventListener("mousedown", function (e) {');
const hide06 = getNamedSlice('hideTipFn');
const tab01 = sliceOverlay('  function tpsTabActivate(e) {', '  /* v384 V3 模型筛选交互（compact 链镜像 06 分片 spd3Activate）');
const down01 = sliceOverlay('  tpsTip.addEventListener("pointerdown", function (e) {', '  tpsTip.addEventListener("click", function (e) {');
const hide01 = sliceOverlay('  function hideTpsTip() {', '  /* ---------- v280 柱 hover 信息卡 Portal');

// 冻结时钟 2026-11-05 14:00（同其余 V3 夹具纪律；SPD3_MON 缺席时弹层年份按它兜底）
const FIXED_NOW = new Date(2026, 10, 5, 14, 0, 0).getTime();
function makeCtx() {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [FIXED_NOW])); }
    static now() { return FIXED_NOW; }
  }
  const ctx = vm.createContext({
    L: zh => zh, Date: FakeDate, Math, JSON, isFinite, parseInt, parseFloat, Object, Array, String, Number,
  });
  vm.runInContext(bands + '\n' + spdHelpers + '\n' + spdCompact + '\n' + core + '\n' + view + '\n' + wire, ctx);
  return ctx;
}
const plain = x => JSON.parse(JSON.stringify(x));   // VM 域对象 → 宿主域再 deepEqual
const MON = (y, m) => y * 12 + m;

// ---------- 极简假元素：属性/类/父链 + closest（.class / [attr] / [attr="v"] / 逗号列表）+ 矩形 ----------
let focused = [];
function matchesSel(el, sel) {
  return sel.split(',').some(part => {
    const s = part.trim();
    if (s[0] === '.') return el.classes.includes(s.slice(1));
    const m = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(s);
    if (!m) return false;
    return m[2] === undefined ? el.hasAttribute(m[1]) : el.getAttribute(m[1]) === m[2];
  });
}
function mkEl(spec, parent) {
  spec = spec || {};
  const el = {
    attrs: Object.assign({}, spec.attrs || {}),
    classes: String(spec.cls || '').split(' ').filter(Boolean),
    parent: parent || null,
    rect: spec.rect || null,
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? String(this.attrs[n]) : null; },
    hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); },
    focus() { focused.push(this); },
  };
  if (!spec.noGeom) el.getBoundingClientRect = function () { return this.rect; };   // noGeom=量不到矩形的替身元素
  el.classList = { contains: c => el.classes.includes(c) };
  el.closest = function (sel) {
    for (let n = this; n; n = n.parent) if (matchesSel(n, sel)) return n;
    return null;
  };
  return el;
}
// 胶囊与弹层几何：根 top=100/right=940；胶囊底缘 222、右缘 926
const ROOT_RECT = { top: 100, bottom: 550, left: 20, right: 940 };
const NAV_RECT = { top: 196, bottom: 222, left: 780, right: 926 };
function mkDom() {
  const root = mkEl({ cls: 'zu-sv3-root', rect: ROOT_RECT });
  const nav = mkEl({ cls: 'zu-sv3-mnav', rect: NAV_RECT }, root);
  const prev = mkEl({ cls: 'zu-sv3-mbtn', attrs: { 'data-sv3-mnav': 'prev' } }, nav);
  const label = mkEl({ cls: 'zu-sv3-mlabel', attrs: { 'data-sv3-mlabel': '' } }, nav);
  const next = mkEl({ cls: 'zu-sv3-mbtn', attrs: { 'data-sv3-mnav': 'next' } }, nav);
  const svg = mkEl({}, prev);   // 真实事件的 target 是按钮里的 svg/path，靠 closest 上溯到按钮
  const pop = mkEl({ cls: 'zu-sv3-mpop' }, root);
  const yPrev = mkEl({ cls: 'zu-sv3-mbtn', attrs: { 'data-sv3-myear': '-1' } }, pop);
  const yNext = mkEl({ cls: 'zu-sv3-mbtn', attrs: { 'data-sv3-myear': '1' } }, pop);
  return { root, nav, prev, label, next, svg, pop, yPrev, yNext,
    pick: v => mkEl({ cls: 'zu-sv3-mpick', attrs: { 'data-sv3-mpick': String(v) } }, pop) };
}
const lookups = dom => ({
  '.zu-sv3-root': dom.root,
  '[data-sv3-mlabel]': dom.label,
  '.zu-sv3-mpop .zu-sv3-mpick.on': dom.cellOn,
  '.zu-sv3-mpop .zu-sv3-mpick:not([disabled])': dom.cellFirst,
  '.zu-sv3-mpop [data-sv3-myear]:not([disabled])': dom.yPrev,
});
// Esc 分层守卫：月历弹层开着时按 Esc 不得走到档位说明分支
function guardLaterLayers(ctx, name) {
  Object.defineProperty(ctx, name, { configurable: true, get() { throw new Error('不应走到 ' + name + ' 分支（月历弹层应最先收）'); } });
}

// ---------- 两条链的装配 ----------
// 重建模型：真实链路里 wire 每次重建都把 SPD3_MON 刷成新卡的 an.mon——切月是相对
// 「正在显示的卡」算的（钳制后的有效月），替身重建必须同步刷新，否则下一次点击会
// 拿旧卡的位置算边界。lo/hi 沿用（同一范围池），有效月按 sel.mon 钳进闭区间。
function monSync(ctx, sel) {
  const cur = ctx.SPD3_MON;
  if (!cur) return;
  const v = sel.mon ? sel.mon.y * 12 + sel.mon.m : cur.hi;
  const eff = Math.min(Math.max(v, cur.lo), cur.hi);
  ctx.SPD3_MON = { y: Math.floor(eff / 12), m: eff % 12, cur: eff === cur.hi, lo: cur.lo, hi: cur.hi };
}
function chain06(ctx, sel, dom) {
  const handlers = {};
  let rebuilds = 0;
  const nodes = lookups(dom);
  const tip = {
    style: { display: "block" },
    addEventListener(type, fn) { handlers[type] = fn; },
    querySelector(q) { return Object.prototype.hasOwnProperty.call(nodes, q) ? nodes[q] : null; },
  };
  ctx.tip = tip;
  ctx.speedSel = sel;
  ctx.speedChartHover = 3;
  ctx.speedInteractAt = 0;
  ctx.speedRebuildNow = function () { rebuilds++; monSync(ctx, sel); };
  /* pointerdown 委托与 hideTip 读的其余实例闭包名（都是真实作用域存在的名字） */
  ctx.mouseInBar = false;
  ctx.lastTipDownAt = 0;
  ctx.tipFor = null;
  ctx.cancelTipGrace = function () {};
  ctx.projTipTabActivate = function () { return false; };
  ctx.projTipMoreActivate = function () { return false; };
  ctx.state = { devKeepTip: false };
  ctx.tipStats = { hideSeq: [] };
  ctx.tipGraceTimer = 0;
  ctx.tipSig = "";
  ctx.spdHoverPortalHide = function () {};
  ctx.spdLegendTipHide = function () {};
  ctx.hideFxTip = function () {};
  vm.runInContext(act06 + '\n' + tab06 + '\n' + mouse06 + '\n' + key06 + '\n' + down06 + '\n' + hide06, ctx);
  guardLaterLayers(ctx, 'spdLegendTip');
  return {
    sel, handlers, dom, rebuilds: () => rebuilds,
    fire: (el, type) => vm.runInContext('spd3Activate', ctx)({ target: el, type: type || 'pointerdown' }),
    down: el => handlers.pointerdown({ target: el, button: 0, preventDefault() {}, stopPropagation() {} }),
    tab: el => vm.runInContext('speedTabActivate', ctx)({ target: el, stopPropagation() {} }),
    hide: (force, cause) => vm.runInContext('hideTip', ctx)(force, cause),
  };
}
function chain01(ctx, sel, dom) {
  const handlers = {};
  let rebuilds = 0;
  const nodes = lookups(dom);
  const t = { speedSel: sel, speedHover: 3 };
  const chip = { __zuT: t };
  const tpsTip = {
    style: { display: "block" },
    addEventListener(type, fn) { handlers[type] = fn; },
    querySelector(q) { return Object.prototype.hasOwnProperty.call(nodes, q) ? nodes[q] : null; },
  };
  ctx.tpsTip = tpsTip;
  ctx.tpsTipFor = chip;
  ctx.cancelTpsHide = function () {};
  ctx.spdHoverPortalHide = function () {};
  ctx.spdLegendTipHide = function () {};
  ctx.showTpsTip = function (el) { assert.equal(el, chip, '重编目标=当前 chip'); rebuilds++; monSync(ctx, sel); };
  vm.runInContext(act01 + '\n' + tab01 + '\n' + mouse01 + '\n' + key01 + '\n' + down01 + '\n' + hide01, ctx);
  guardLaterLayers(ctx, 'spdLegendTip');
  return {
    sel, handlers, dom, t, rebuilds: () => rebuilds,
    fire: (el, type) => vm.runInContext('tpsSpd3Activate', ctx)({ target: el, type: type || 'pointerdown' }),
    down: el => handlers.pointerdown({ target: el, button: 0, preventDefault() {}, stopPropagation() {} }),
    tab: el => vm.runInContext('tpsTabActivate', ctx)({ target: el, stopPropagation() {} }),
    hide: () => vm.runInContext('hideTpsTip', ctx)(),
  };
}
function mkSel() {
  return { range: 'all', period: 'month', dim: 'time',
    filt: { mode: 'auto', keys: null }, pop: { open: false, query: '' }, mon: null, mpop: { open: false, y: 0 } };
}
// 当前卡=2026-11，可看 2026-10..2026-11
const MON_NOW = { y: 2026, m: 10, cur: true, lo: MON(2026, 9), hi: MON(2026, 10) };
function setup(mkChain, mon) {
  focused = [];
  const ctx = makeCtx();
  const sel = mkSel();
  ctx.SPD3_MON = mon === undefined ? MON_NOW : mon;
  const dom = mkDom();
  dom.cellOn = dom.pick(MON(2026, 10));
  dom.cellFirst = dom.pick(MON(2026, 9));
  return { ctx, sel, dom, chain: mkChain(ctx, sel, dom) };
}
const mdown = (chain, el) => {
  const e = { target: el, stopped: 0, prevented: 0,
    stopPropagation() { this.stopped++; }, preventDefault() { this.prevented++; } };
  chain.handlers.mousedown(e);
  return e;
};
const POINTER = 'pointerdown', KEY = 'click';   // 两条链的键盘路径=click 委托（e.detail===0）

const CHAINS = [['06 主卡链', chain06], ['01 精简 chip 链', chain01]];

for (const [tag, mkChain] of CHAINS) {
  test(`[${tag}] 上个月/下个月（指针）：所选月前后移、收弹层、重建一次；不动焦点`, () => {
    const { ctx, sel, dom, chain } = setup(mkChain);
    assert.equal(chain.fire(dom.svg), true, '吞掉事件（target 是按钮里的 svg，closest 上溯到按钮）');
    assert.deepEqual(plain(sel.mon), { y: 2026, m: 9 }, '11 月 → 10 月');
    assert.equal(sel.mpop.open, false);
    assert.equal(chain.rebuilds(), 1);
    assert.deepEqual(focused, [], '指针路径不挪焦点（按下重建后卡内焦点本就留不住，不白费一次聚焦）');
    assert.equal(chain.fire(dom.next), true);
    assert.deepEqual(plain(sel.mon), { y: 2026, m: 10 }, '10 月 → 11 月（相对重建后的当前卡）');
    assert.equal(chain.rebuilds(), 2);
    assert.deepEqual(focused, []);
    if (tag.startsWith('06')) {
      assert.equal(ctx.speedChartHover, -1, '06：悬停下标复位（旧悬停卡随重建失效）');
      assert.equal(ctx.speedInteractAt, FIXED_NOW, '06：进入交互冻结');
    } else {
      assert.equal(chain.t.speedHover, -1, '01：悬停下标复位');
    }
  });

  test(`[${tag}] 上个月/选月（键盘）：重建销毁了原按钮 → 焦点归还月份文字`, () => {
    const { sel, dom, chain } = setup(mkChain);
    assert.equal(chain.fire(dom.prev, KEY), true);
    assert.deepEqual(plain(sel.mon), { y: 2026, m: 9 });
    assert.deepEqual(focused, [dom.label], '键盘：焦点归还月份文字');
    sel.mpop = { open: true, y: 2026 };
    assert.equal(chain.fire(dom.pick(MON(2026, 10)), KEY), true);
    assert.deepEqual(focused, [dom.label, dom.label]);
  });

  test(`[${tag}] 边界外不动作：当前月点下个月、下界月点上个月 → 状态不变、不重建、事件仍被吞`, () => {
    const atNow = setup(mkChain);
    const snap = JSON.stringify([atNow.sel.mon, atNow.sel.mpop]);
    assert.equal(atNow.chain.fire(atNow.dom.next), true);
    assert.equal(atNow.chain.rebuilds(), 0);
    assert.equal(JSON.stringify([atNow.sel.mon, atNow.sel.mpop]), snap);
    const atLo = setup(mkChain, { y: 2026, m: 9, cur: false, lo: MON(2026, 9), hi: MON(2026, 10) });
    atLo.sel.mon = { y: 2026, m: 9 };
    const snap2 = JSON.stringify([atLo.sel.mon, atLo.sel.mpop]);
    assert.equal(atLo.chain.fire(atLo.dom.prev), true);
    assert.equal(atLo.chain.rebuilds(), 0);
    assert.equal(JSON.stringify([atLo.sel.mon, atLo.sel.mpop]), snap2);
  });

  test(`[${tag}] 点月份文字（指针）：打开弹层、关掉筛选弹层、按胶囊实测锚定、不动焦点；再点收起`, () => {
    const { sel, dom, chain } = setup(mkChain);
    sel.pop = { open: true, query: 'glm' };   // 模型筛选弹层开着
    assert.equal(chain.fire(dom.label), true);
    assert.equal(sel.mpop.open, true);
    assert.equal(sel.mpop.y, 2026, '弹层年份=当前卡年份');
    assert.deepEqual(plain(sel.pop), { open: false, query: '' }, '与筛选弹层互斥');
    assert.equal(sel.mpop.top, NAV_RECT.bottom - ROOT_RECT.top + 6, 'top=胶囊底缘+6（相对根）');
    assert.equal(sel.mpop.right, ROOT_RECT.right - NAV_RECT.right, 'right=根右缘−胶囊右缘');
    assert.equal(chain.rebuilds(), 1);
    assert.deepEqual(focused, []);
    assert.equal(chain.fire(dom.label), true);
    assert.equal(sel.mpop.open, false);
    assert.equal(chain.rebuilds(), 2);
    assert.deepEqual(focused, []);
  });

  test(`[${tag}] 点月份文字（键盘）：焦点入选中月（优先于首个可用月）；收起归还文字`, () => {
    const { sel, dom, chain } = setup(mkChain);
    assert.equal(chain.fire(dom.label, KEY), true);
    assert.equal(sel.mpop.open, true);
    assert.deepEqual(focused, [dom.cellOn]);
    assert.equal(chain.fire(dom.label, KEY), true, '键盘收起');
    assert.deepEqual(focused, [dom.cellOn, dom.label]);
  });

  test(`[${tag}] 选月（指针）：置所选月、收弹层、重建；界外月份吞事件不动作`, () => {
    const { sel, dom, chain } = setup(mkChain);
    sel.mpop = { open: true, y: 2026 };
    assert.equal(chain.fire(dom.pick(MON(2026, 9))), true);
    assert.deepEqual(plain(sel.mon), { y: 2026, m: 9 });
    assert.equal(sel.mpop.open, false);
    assert.equal(chain.rebuilds(), 1);
    assert.deepEqual(focused, []);
    sel.mpop = { open: true, y: 2026 };
    assert.equal(chain.fire(dom.pick(MON(2026, 11))), true, '未来月：事件仍被吞');
    assert.equal(chain.rebuilds(), 1, '不重建');
    assert.deepEqual(plain(sel.mpop), { open: true, y: 2026 }, '弹层不动');
    assert.deepEqual(plain(sel.mon), { y: 2026, m: 9 });
  });

  test(`[${tag}] 切年：只改弹层年份、不动所选月、弹层保持打开；年界处不动作；键盘切年焦点落年份按钮`, () => {
    const { sel, dom, chain } = setup(mkChain, { y: 2026, m: 9, cur: false, lo: MON(2025, 11), hi: MON(2026, 10) });
    sel.mon = { y: 2026, m: 9 };
    sel.mpop = { open: true, y: 2026 };
    assert.equal(chain.fire(dom.yPrev), true);
    assert.deepEqual(plain(sel.mpop), { open: true, y: 2025 });
    assert.deepEqual(plain(sel.mon), { y: 2026, m: 9 });
    assert.equal(chain.rebuilds(), 1);
    assert.deepEqual(focused, [], '指针切年不动焦点');
    assert.equal(chain.fire(dom.yPrev), true, '再往前无可看年份');
    assert.equal(sel.mpop.y, 2025);
    assert.equal(chain.rebuilds(), 1, '不重建');
    sel.mpop.y = 2026;
    assert.equal(chain.fire(dom.yNext, KEY), true, '键盘路径切年');
    assert.equal(sel.mpop.y, 2026, '再往后无可看年份（键盘路径同样不动作）');
    assert.equal(chain.rebuilds(), 1);
    assert.equal(chain.fire(dom.yPrev, KEY), true);
    assert.deepEqual(focused, [dom.yPrev], '键盘切年：焦点落仍可用的年份按钮（重建后按选择器重查）');
  });

  test(`[${tag}] Esc：月历弹层开着 → 只收弹层（不走档位说明/关卡分支）、重建、焦点回文字`, () => {
    const { sel, dom, chain } = setup(mkChain);
    sel.mpop = { open: true, y: 2026 };
    assert.equal(typeof chain.handlers.keydown, 'function', 'keydown 委托已挂');
    let stopped = 0;
    chain.handlers.keydown({ key: 'Escape', stopPropagation() { stopped++; } });
    assert.equal(sel.mpop.open, false);
    assert.equal(chain.rebuilds(), 1);
    assert.equal(stopped, 1);
    assert.deepEqual(focused, [dom.label]);
  });

  test(`[${tag}] mousedown 阻断名单：胶囊/弹层内的按下拦截冒泡与默认行为；图表区不拦`, () => {
    const { dom, chain } = setup(mkChain);
    assert.equal(typeof chain.handlers.mousedown, 'function', 'mousedown 委托已挂');
    for (const el of [dom.svg, dom.label, dom.pick(MON(2026, 9)), dom.yPrev]) {
      const e = mdown(chain, el);
      assert.equal(e.stopped, 1, 'stopPropagation');
      assert.equal(e.prevented, 1, 'preventDefault');
    }
    const e2 = mdown(chain, mkEl({ cls: 'zu-sc-col' }, dom.root));
    assert.equal(e2.stopped, 0, '图表柱不拦');
    assert.equal(e2.prevented, 0);
  });

  test(`[${tag}] SPD3_MON 缺席（卡尚未重建/旧帧）：切月、选月不猜边界（无动作），开关弹层仍可用`, () => {
    const { ctx, sel, dom, chain } = setup(mkChain, null);
    assert.equal(ctx.SPD3_MON, null);
    assert.equal(chain.fire(dom.prev), true);
    assert.equal(sel.mon, null);
    assert.equal(chain.rebuilds(), 0);
    assert.equal(chain.fire(dom.label), true);
    assert.equal(sel.mpop.open, true);
    assert.equal(sel.mpop.y, 2026, '年份按当前年兜底');
    assert.equal(chain.rebuilds(), 1);
    sel.mpop.open = false;
    assert.equal(chain.fire(dom.pick(MON(2026, 9))), true);
    assert.equal(sel.mon, null, '不猜边界');
    assert.equal(chain.rebuilds(), 1);
  });

  test(`[${tag}] 非月份导航元素：原筛选分支不受影响（chip toggle 仍生效）`, () => {
    const { sel, chain } = setup(mkChain);
    assert.equal(chain.fire(mkEl({ cls: 'zu-sv3-chip', attrs: { 'data-k': 'prov_a\x1fglm-a' } })), true);
    assert.deepEqual(plain(sel.filt), { mode: 'sel', keys: ['prov_a\x1fglm-a'] });
    assert.equal(chain.rebuilds(), 1);
  });

  test(`[${tag}] 点弹层之外即收：日历格、筛选条计数、左卡 → 收弹层并重绘一次；弹层没开时点这些位置不重绘`, () => {
    const { sel, dom, chain } = setup(mkChain);
    const cell = mkEl({ cls: 'zu-hm-cell' }, dom.root);
    const fcount = mkEl({ cls: 'zu-sv3-fcount' }, mkEl({ cls: 'zu-sv3-fbar' }, dom.root));
    const left = mkEl({ cls: 'zu-sv3-main-num' }, mkEl({ cls: 'zu-sv3-left' }, dom.root));
    const inside = dom.pick(MON(2026, 10));   // 位于弹层内的月份格（带 data-sv3-mpick，对照）
    assert.equal(typeof chain.handlers.pointerdown, 'function', 'pointerdown 委托已挂');
    for (const el of [cell, fcount, left]) { chain.down(el); }
    assert.equal(sel.mpop.open, false);
    assert.equal(chain.rebuilds(), 0, '弹层没开：按下不触发任何重绘');
    for (const el of [cell, fcount, left]) {
      sel.mpop = { open: true, y: 2026, top: 118, right: 13 };
      const before = chain.rebuilds();
      chain.down(el);
      assert.equal(sel.mpop.open, false, '弹层收起');
      assert.equal(chain.rebuilds(), before + 1, '恰好重绘一次');
      assert.equal(sel.mon, null, '只收弹层，不改所选月');
      assert.equal(sel.period, 'month', '只收弹层，不切 Tab');
    }
    sel.mpop = { open: true, y: 2026 };
    const beforeIn = chain.rebuilds();
    chain.down(inside);
    assert.equal(sel.mpop.open, false, '弹层内点月份格=选月（本就收弹层），与之外判定无关');
    assert.deepEqual(plain(sel.mon), { y: 2026, m: 10 }, '选中的是当前月');
    assert.equal(chain.rebuilds(), beforeIn + 1, '选月自身重绘一次；若被「之外」判定误伤会先收弹层再选月、重绘两次');
  });

  test(`[${tag}] 点弹层之外即收不吞被点控件：点时间 Tab → 收弹层且切 Tab；点「模型筛选」→ 收月历、开筛选弹层`, () => {
    const { sel, dom, chain } = setup(mkChain);
    sel.mpop = { open: true, y: 2026 };
    let before = chain.rebuilds();
    chain.down(mkEl({ cls: 'zu-sv-tab', attrs: { 'data-sv-group': 'period', 'data-sv-val': 'today' } }, dom.root));
    assert.equal(sel.mpop.open, false, '月历收起');
    assert.equal(sel.period, 'today', '被点的 Tab 照常切换（从已脱离的旧节点读属性）');
    assert.equal(chain.rebuilds(), before + 2, '恰好两次重绘：点外即收一次 + Tab 动作自身一次');
    sel.period = 'month';
    sel.mpop = { open: true, y: 2026 };
    before = chain.rebuilds();
    chain.down(mkEl({ cls: 'zu-sv3-flabel', attrs: { 'data-sv3-fopen': '' } }, mkEl({ cls: 'zu-sv3-fbar' }, dom.root)));
    assert.equal(sel.mpop.open, false, '月历收起');
    assert.equal(sel.pop.open, true, '筛选弹层打开（互斥双向）');
    assert.equal(chain.rebuilds(), before + 2, '恰好两次重绘：点外即收一次 + fopen 动作自身一次');
    /* 键盘路径（Enter→click 委托，不经 pointerdown，spd3MonthOutside 兜不到）：
     * fopen 分支自身镜像补收月历（审查 MINOR：互斥双向此前只在指针路径成立） */
    sel.pop = { open: false, query: '' };
    sel.mpop = { open: true, y: 2026 };
    assert.equal(chain.fire(mkEl({ cls: 'zu-sv3-flabel', attrs: { 'data-sv3-fopen': '' } }, mkEl({ cls: 'zu-sv3-fbar' }, dom.root)), 'click'), true);
    assert.equal(sel.mpop.open, false, '键盘开筛选弹层同样收月历（fopen 分支镜像）');
    assert.equal(sel.pop.open, true, '筛选弹层打开');
  });

  test(`[${tag}] 「模型筛选」标签入口可开可收（v390 起白名单按无人使用的类名匹配、入口失配的回归锁）`, () => {
    const { sel, dom, chain } = setup(mkChain);
    const label = mkEl({ cls: 'zu-sv3-flabel', attrs: { 'data-sv3-fopen': '' } }, mkEl({ cls: 'zu-sv3-fbar' }, dom.root));
    chain.down(label);
    assert.equal(sel.pop.open, true, '点「模型筛选」打开筛选弹层');
    chain.down(label);
    assert.equal(sel.pop.open, false, '再点收起');
  });

  test(`[${tag}] 弹层内部与胶囊不算「之外」：弹层内切年保持打开；点月份文字只翻转一次`, () => {
    const { sel, dom, chain } = setup(mkChain, { y: 2026, m: 9, cur: false, lo: MON(2025, 11), hi: MON(2026, 10) });
    sel.mon = { y: 2026, m: 9 };
    sel.mpop = { open: true, y: 2026 };
    chain.down(dom.yPrev);
    assert.deepEqual(plain(sel.mpop), { open: true, y: 2025 }, '弹层内按下：切年，弹层保持打开');
    sel.mpop = { open: true, y: 2026 };
    chain.down(dom.label);
    assert.equal(sel.mpop.open, false, '点月份文字：收起（没有被「之外」判定和开关逻辑各翻一次）');
    chain.down(dom.label);
    assert.equal(sel.mpop.open, true, '再点：打开');
  });

  test(`[${tag}] 整卡隐藏即复位弹层态：重开不残留月历`, () => {
    const { sel, chain } = setup(mkChain);
    sel.mpop = { open: true, y: 2026 };
    chain.hide(true, 'left-bar');
    assert.equal(sel.mpop.open, false);
    assert.equal(sel.mon, null, '所选月保留（只有会话切换才复位）');
  });
}

test('[01 精简 chip 链] 切 Tab（键盘路径）：收起月历与筛选弹层、保留所选月（审查补齐 06 链同款契约）', () => {
  const { ctx, sel, chain } = setup(chain01);
  sel.mon = { y: 2026, m: 9 };
  sel.mpop = { open: true, y: 2026 };
  sel.pop = { open: true, query: 'glm' };
  chain.tab(mkEl({ cls: 'zu-sv-tab', attrs: { 'data-sv-group': 'period', 'data-sv-val': 'today' } }));
  assert.equal(sel.period, 'today');
  assert.equal(sel.mpop.open, false, '月历收起（键盘路径此前泄漏，指针路径由点外即收兜住）');
  assert.equal(sel.pop.open, false, '筛选弹层收起（对齐 06 链 v384 契约）');
  assert.deepEqual(plain(sel.mon), { y: 2026, m: 9 }, '所选月保留');
  assert.equal(chain.rebuilds(), 1);
});

test('[06 主卡链] 切 Tab：收起月历弹层、保留所选月', () => {
  const { ctx, sel, chain } = setup(chain06);
  sel.mon = { y: 2026, m: 9 };
  sel.mpop = { open: true, y: 2026 };
  chain.tab(mkEl({ cls: 'zu-sv-tab', attrs: { 'data-sv-group': 'period', 'data-sv-val': 'today' } }));
  assert.equal(sel.period, 'today');
  assert.equal(sel.mpop.open, false, '弹层收起');
  assert.deepEqual(plain(sel.mon), { y: 2026, m: 9 }, '所选月保留（切回本月还是该月）');
  assert.equal(chain.rebuilds(), 1);
  assert.equal(ctx.speedInteractAt > 0, true, '进入交互冻结');
});

test('spd3MonthAct/Anchor/Focus 纯函数边界：空入参不动作、量不到矩形不写锚定、焦点两级回退', () => {
  const ctx = makeCtx();
  ctx.__mon = MON_NOW;
  ctx.__nav = mkEl({ cls: 'zu-sv3-mbtn', attrs: { 'data-sv3-mnav': 'prev' } });
  ctx.__plain = mkEl({ cls: 'zu-sc-col' });
  assert.equal(vm.runInContext('spd3MonthAct(null, __nav, __mon)', ctx), '', '无 sel 不动作');
  assert.equal(vm.runInContext('spd3MonthAct({}, null, __mon)', ctx), '', '无元素不动作');
  assert.equal(vm.runInContext('spd3MonthAct({}, __plain, __mon)', ctx), '', '非月份导航元素不动作');
  // 锚定：胶囊或根量不到矩形（无 getBoundingClientRect 的替身元素）→ 保持原值
  const dom = mkDom();
  const navNoRect = mkEl({ cls: 'zu-sv3-mnav', noGeom: true }, dom.root);
  const btnNoRect = mkEl({ cls: 'zu-sv3-mbtn', attrs: { 'data-sv3-mlabel': '' } }, navNoRect);
  ctx.__mpop = { open: true, y: 2026 };
  ctx.__el = btnNoRect; ctx.__root = dom.root;
  vm.runInContext('spd3MonthAnchor(__mpop, __el, __root)', ctx);
  assert.deepEqual(plain(ctx.__mpop), { open: true, y: 2026 }, '胶囊量不到矩形不写锚定');
  ctx.__root = {};
  ctx.__el = dom.label;
  vm.runInContext('spd3MonthAnchor(__mpop, __el, __root)', ctx);
  assert.equal(ctx.__mpop.top, undefined, '根量不到矩形不写锚定');
  // 正常几何：与两条链用例同一组数值
  ctx.__dom = dom.root;
  vm.runInContext('spd3MonthAnchor(__mpop, __el, __dom)', ctx);
  assert.equal(ctx.__mpop.top, NAV_RECT.bottom - ROOT_RECT.top + 6);
  assert.equal(ctx.__mpop.right, ROOT_RECT.right - NAV_RECT.right);
  // 焦点归位：容器里什么都没有 → 不抛不聚焦
  focused = [];
  ctx.__tipNone = { querySelector() { return null; } };
  vm.runInContext('spd3MonthFocus(__tipNone, "open")', ctx);
  assert.deepEqual(focused, []);
  // open 的两级优先：选中月缺席才退到首个可用月（选择器列表按 DOM 序取首个，必须两步查）
  const on = mkEl({ cls: 'zu-sv3-mpick on' }), first = mkEl({ cls: 'zu-sv3-mpick' }), label = mkEl({ cls: 'zu-sv3-mlabel' }), yBtn = mkEl({ cls: 'zu-sv3-mbtn' });
  ctx.__tip = { querySelector(q) {
    if (q === '.zu-sv3-mpop .zu-sv3-mpick.on') return ctx.__hasOn ? on : null;
    if (q === '.zu-sv3-mpop .zu-sv3-mpick:not([disabled])') return first;
    if (q === '.zu-sv3-mpop [data-sv3-myear]:not([disabled])') return ctx.__hasYear ? yBtn : null;
    return label;
  } };
  ctx.__hasOn = true;
  vm.runInContext('spd3MonthFocus(__tip, "open")', ctx);
  ctx.__hasOn = false;
  vm.runInContext('spd3MonthFocus(__tip, "open")', ctx);
  ctx.__hasYear = true;
  vm.runInContext('spd3MonthFocus(__tip, "year")', ctx);
  ctx.__hasYear = false;
  vm.runInContext('spd3MonthFocus(__tip, "year")', ctx);
  vm.runInContext('spd3MonthFocus(__tip, "shift")', ctx);
  assert.deepEqual(focused, [on, first, yBtn, label, label], '选中月 → 首个可用月；年份按钮 → 文字；切月 → 文字');
});
