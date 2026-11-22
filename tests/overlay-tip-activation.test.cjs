const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readOverlaySource, sliceOverlay } = require('./helpers/overlay-extract.cjs');

/* v249 悬浮窗口激活方式（用户裁定简化）：⚙「点击激活悬浮窗口」（zusage3.tipClick）缺省关
 * = 恢复即时悬停原语义（v246 逐行为，v247 的 1000ms 停留定时器链已整体移除）；仅显式 "1"
 * 开 = 点击激活（悬停不打开/切换任何浮层，bar.click 接管，focusTipAt 防 focusin→click
 * 首击抵消，子代理 preview 关闭、点击 pinned 打开）。本文件锁两态判定表、点击模式事件序、
 * 开关接线与还原契约。真实指针/伪 leave 仍须实机验收（tests.md §4）。 */
const source = readOverlaySource();
function extract(start, end) {
  return sliceOverlay(start, end);
}

/* ---------- 1. v247 停留定时器链确已移除（防回归复活；v439 另以 tipHover* 短门槛独立实现） ---------- */
test('v249: the v247 dwell timer chain is fully removed from the implementation', () => {
  const withoutLedger = source
    .replace(/\/\* VERSION 台账[\s\S]*?\*\/\s*/m, '')
    .replace(/^.*var VERSION = [^\n]*\n/m, '');
  for (const sym of ['HOVER_OPEN_DELAY_MS', 'hoverTimer', 'hoverSchedule', 'hoverCheck', 'hoverStillOn', 'hoverCancel', 'hoverKey']) {
    assert.equal(withoutLedger.indexOf(sym), -1, sym + ' 不得残留（VERSION 台账的历史叙述除外）');
  }
});

/* ---------- 2. 开关接线：LS/state/启动读/persist/两处回填/change 分支 ---------- */
test('v249 setting: LS key, default-off state seed, boot read, persist and both panel backfills', () => {
  assert.match(source, /tipClick: "zusage3\.tipClick"/);
  assert.match(source, /tipClick: 0,/);   // 缺省关 = 即时悬停（非 ctxCpt 那种缺省开）
  assert.match(source, /if \(ls\(LS\.tipClick, ""\) === "1"\) state\.tipClick = 1;/);
  assert.match(source, /lsSet\(LS\.tipClick, state\.tipClick \? "1" : "0"\);/);
  assert.match(source, /class="zu-tip-click"/);
  assert.match(source, /L\("点击激活悬浮窗口", "Click to open popups"\)/);
  const reads = (source.match(/var tipClickBox = panel\.querySelector\("\.zu-tip-click"\);/g) || []).length;
  assert.equal(reads, 2, 'buildPanel 尾部与 syncPanel 两处回填都在（语言切换不走 syncPanel）');
  const change = extract('    panel.addEventListener("change",', '    listenGlobal(document, "mousedown"');
  assert.match(change, /t2\.classList\.contains\("zu-tip-click"\)/);
  assert.match(change, /state\.tipClick = t2\.checked \? 1 : 0;/);
  const clickIdx = change.indexOf('zu-tip-click'), genericIdx = change.indexOf('if (t2.type === "checkbox")');
  assert.ok(clickIdx > 0 && genericIdx > 0 && clickIdx < genericIdx, '新分支先于通用 checkbox 分支（不落 show[undefined]）');
});

/* ---------- 2b. v439 悬停门槛接线：LS/state（默认 50）/启动读/persist/下拉/两处回填/change 分支 ---------- */
test('v441 setting: LS key, default-500 state seed, boot read, persist, select markup and both panel backfills', () => {
  assert.match(source, /tipHoverMs: "zusage3\.tipHoverMs"/);
  assert.match(source, /tipHoverMs: 500,/);   // v441 改档：默认 500ms（issue #445）
  assert.match(source, /var thm0 = parseInt\(ls\(LS\.tipHoverMs, ""\), 10\);/);
  assert.match(source, /if \(thm0 >= 0 && thm0 <= 10000\) state\.tipHoverMs = thm0;/);
  assert.match(source, /lsSet\(LS\.tipHoverMs, String\(parseInt\(state\.tipHoverMs, 10\) \|\| 0\)\);/);
  assert.match(source, /class="zu-tip-hover-ms"/);
  assert.match(source, /L\("悬停显示延迟", "Hover popup delay"\)/);
  const reads = (source.match(/var tipHoverMsSel = panel\.querySelector\("\.zu-tip-hover-ms"\);/g) || []).length;
  assert.equal(reads, 2, 'buildPanel 尾部与 syncPanel 两处回填都在');
  const change = extract('    panel.addEventListener("change",', '    listenGlobal(document, "mousedown"');
  assert.match(change, /t2\.classList\.contains\("zu-tip-hover-ms"\)/);
  assert.match(change, /state\.tipHoverMs = thm1 > 0 \? thm1 : 0;/);
  assert.match(change, /tipHoverCancel\(\);/, '改档即撤在途排程，下一采样按新门槛');
  const hoverIdx = change.indexOf('zu-tip-hover-ms');
  assert.ok(hoverIdx > 0 && hoverIdx < genericIdxLocal(change), '下拉分支先于通用 checkbox 分支');
  function genericIdxLocal(s) { return s.indexOf('if (t2.type === "checkbox")'); }
});

test('v439 setting: change handler stores the delay, persists and cancels pending schedule', () => {
  const change = extract('    panel.addEventListener("change",', '    listenGlobal(document, "mousedown"');
  let handler = null, saved = 0, cancels = 0;
  const state = { tipHoverMs: 500, tipClick: 0, show: { turn: 1 } };
  let chipDisarms = 0;
  const ctx = {
    panel: { addEventListener: (type, fn) => { if (type === 'change') handler = fn; } },
    state, persist: () => { saved++; }, inactive: () => false,
    zuChipHoverDisarm: () => { chipDisarms++; },
    pluginRequest: () => {}, renderAll: () => {}, syncPanel: () => {}, scanRateLines: () => {},
    scanDeterministicLines: () => {}, showSettingsFeedback: () => {}, setBarTheme: () => {},
    setBarJust: () => {}, sendAutoCompactConfig: () => {}, applyProjPath: () => {},
    applyCmdkW: () => {}, syncCompactBtn: () => {}, closeCompactDlg: () => {},
    rebuildExcBubble: () => {}, autoCompactOnShow: () => {}, refreshWants: () => {},
    richTextAttempts: {}, richTextUnitEpoch: 0, gear: { setAttribute: () => {} },
    ls: () => '', lsSet: () => {}, LS: { autoCompact: '' }, buildPanel: () => {},
    document: { querySelector: () => null },
    tipHoverCancel: () => { cancels++; },
  };
  vm.runInNewContext(change, vm.createContext(ctx));
  handler({ target: { type: 'select-one', value: '200', dataset: {}, classList: { contains: c => c === 'zu-tip-hover-ms' } } });
  assert.equal(state.tipHoverMs, 200);
  assert.equal(saved, 1);
  assert.equal(cancels, 1, '改档撤在途排程');
  handler({ target: { type: 'select-one', value: '0', dataset: {}, classList: { contains: c => c === 'zu-tip-hover-ms' } } });
  assert.equal(state.tipHoverMs, 0, '0=划过即显（v246 原语义）');
  handler({ target: { type: 'select-one', value: '-5', dataset: {}, classList: { contains: c => c === 'zu-tip-hover-ms' } } });
  assert.equal(state.tipHoverMs, 0, '负数归零（v442 review M9 变异补防）');
  handler({ target: { type: 'select-one', value: 'abc', dataset: {}, classList: { contains: c => c === 'zu-tip-hover-ms' } } });
  assert.equal(state.tipHoverMs, 0, 'NaN 归零（v442 review M9 变异补防）');
  assert.ok(chipDisarms >= 1, '改档同步撤 chip 单槽（v442 一致性）');
});

test('v249 setting: change handler flips state and persists without touching show cells', () => {
  const change = extract('    panel.addEventListener("change",', '    listenGlobal(document, "mousedown"');
  let handler = null, saved = 0;
  const state = { tipClick: 0, show: { turn: 1 } };
  const ctx = {
    panel: { addEventListener: (type, fn) => { if (type === 'change') handler = fn; } },
    state, persist: () => { saved++; }, inactive: () => false,
    pluginRequest: () => {}, renderAll: () => {}, syncPanel: () => {}, scanRateLines: () => {},
    scanDeterministicLines: () => {}, showSettingsFeedback: () => {}, setBarTheme: () => {},
    setBarJust: () => {}, sendAutoCompactConfig: () => {}, applyProjPath: () => {},
    applyCmdkW: () => {}, syncCompactBtn: () => {}, closeCompactDlg: () => {},
    rebuildExcBubble: () => {}, autoCompactOnShow: () => {}, refreshWants: () => {},
    richTextAttempts: {}, richTextUnitEpoch: 0, gear: { setAttribute: () => {} },
    ls: () => '', lsSet: () => {}, LS: { autoCompact: '' }, buildPanel: () => {},
    document: { querySelector: () => null },
    tipHoverCancel: () => {},
  };
  vm.runInNewContext(change, vm.createContext(ctx));
  handler({ target: { type: 'checkbox', checked: true, dataset: {}, classList: { contains: c => c === 'zu-tip-click' } } });
  assert.equal(state.tipClick, 1);
  assert.equal(saved, 1);
  assert.deepEqual({ ...state.show }, { turn: 1 }, '不落入 show[undefined] 分支');
});

/* ---------- 3. mousemove 两态：缺省走悬停门槛排程（v439），点击模式不排程 ---------- */
function makeMoveHandler(extra = {}) {
  const start = source.indexOf('listenGlobal(document, "mousemove"');
  const end = source.indexOf('}, true);', start);
  const handlerSource = source.slice(start, end + '}, true);'.length);
  let handler = null;
  const cell = { __tip: 'cell-tip', closest: () => null };
  const subEntry = { __tip: null, closest(sel) { return sel === '.zu-sub' ? subEntry : null; } };
  const ctx = Object.assign({
    listenGlobal: (t, type, fn) => { if (type === 'mousemove') handler = fn; },
    inactive: () => false,
    state: { tipClick: 0, theme: 'default', tipHoverMs: 500 },
    fxTip: { style: { display: 'none' }, contains: () => false },
    subPopOpen: () => false,
    subPopMode: 'closed', subPopSuppressAt: 0,
    subPopCancelHide: () => {}, subPopScheduleHide: () => {}, subPopShow: () => {},
    cancelTipGrace: () => {},
    tipStats: { mv: 0, corridor: 0, grace: 0 },
    lastMoveAt: 0,
    Date,
    mouseInBar: false,
    tip: { contains: () => false },
    bar: { contains: () => true },
    panel: { classList: { contains: () => false } },
    morePanel: { classList: { contains: () => false } },   // v350「···」菜单守卫
    tipFor: null, tipSig: '',
    hideTip: () => {}, drawTip: () => {}, showTipFor: () => {},
    hitItemFor: (t) => (t === subEntry ? subEntry : cell),
    inTipCorridor: () => false, inTipColumn: () => false,
    tipGraceTimer: 0, setTimeout: () => 1, clearTimeout: () => {},
    document: {},
    tipHoverCancel: () => {},
    tipHoverSchedule: () => {},
  }, extra);
  Object.keys(extra).forEach(k => {
    const d = Object.getOwnPropertyDescriptor(extra, k);
    if (d && (d.get || d.set)) Object.defineProperty(ctx, k, d);
  });
  vm.runInNewContext(handlerSource, vm.createContext(ctx));
  assert.ok(handler, 'mousemove handler captured');
  const move = (target, x = 100, y = 200) => handler({ target, clientX: x, clientY: y });
  return { ctx, move, cell, subEntry };
}

test('v439 dwell (default): hovering a cell routes through the hover threshold scheduler', () => {
  const sched = [];
  const h = makeMoveHandler({ tipHoverSchedule: (el, isSub) => sched.push([el, isSub]) });
  h.move(h.cell, 100, 300);   // 首个事件：lastMoveAt=0 必过节流
  assert.deepEqual(sched, [[h.cell, false]], '命中格子走 tipHoverSchedule（门槛内不直开）');
  assert.equal(h.ctx.mouseInBar, true);
});

test('v439 dwell: hovering the sub-agent entry schedules the preview through the same threshold', () => {
  const sched = [];
  const h = makeMoveHandler({ tipHoverSchedule: (el, isSub) => sched.push([el, isSub]) });
  h.move(h.subEntry, 100, 300);
  assert.deepEqual(sched, [[h.subEntry, true]], '子代理入口走同一门槛（preview 延迟与统计卡一致）');
});

test('v249 click mode: hover neither opens cells nor previews the sub-agent popover', () => {
  let opened = 0, previews = 0;
  const sched = [];
  const h = makeMoveHandler({
    state: { tipClick: 1, theme: 'default', tipHoverMs: 500 },
    showTipFor: () => { opened++; },
    subPopShow: () => { previews++; },
    tipHoverSchedule: (el, isSub) => sched.push([el, isSub]),
  });
  h.move(h.cell, 100, 300);
  h.move(h.subEntry, 110, 300);
  assert.equal(opened, 0, '点击模式悬停不打开统计卡');
  assert.equal(previews, 0, '点击模式悬停不预览子代理面板');
  assert.deepEqual(sched, [], '点击模式不排程悬停门槛');
});

/* ---------- 3b. v439 悬停门槛链本体：排程/复核/改靶重排/取消 ---------- */
function makeHoverChain(extra = {}) {
  const chainSrc = sliceOverlay('var tipHoverTimer = 0, tipHoverPend = null;', 'function tipOutsideDown(e) {');
  const cellA = { __tip: 'tip-a', closest: () => null };
  const cellB = { __tip: 'tip-b', closest: () => null };
  const subEntry = { __tip: null, closest(sel) { return sel === '.zu-sub' ? subEntry : null; } };
  let handler = null;
  const timers = [];
  const ctx = Object.assign({
    state: { tipClick: 0, tipHoverMs: 500 },
    inactive: () => false,
    lastPt: { x: -1, y: -1 },
    Date,
    document: { elementFromPoint: () => null },
    panel: { classList: { contains: () => false } },
    morePanel: { classList: { contains: () => false } },
    tip: { style: { display: 'none' }, contains: () => false },
    tipFor: null,
    showTipFor: () => {},
    hitItemFor: () => null,
    subPopMode: 'closed', subPopSuppressAt: 0,
    subPopShow: () => {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  }, extra);
  Object.keys(extra).forEach(k => {
    const d = Object.getOwnPropertyDescriptor(extra, k);
    if (d && (d.get || d.set)) Object.defineProperty(ctx, k, d);
  });
  vm.runInNewContext(chainSrc + '\nhandler = { schedule: tipHoverSchedule, fire: tipHoverFire, cancel: tipHoverCancel };', vm.createContext(ctx));
  handler = ctx.handler;
  return { ctx, handler, cellA, cellB, subEntry, timers };
}

test('v439 chain: default 500ms arms a timer instead of opening; same-cell reschedule keeps the wait', () => {
  let opened = 0;
  const h = makeHoverChain({ showTipFor: () => { opened++; } });
  h.handler.schedule(h.cellA, false);
  assert.equal(opened, 0, '门槛内不直开');
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 500, '默认 500ms（v441 改档）');
  h.handler.schedule(h.cellA, false);
  assert.equal(h.timers.length, 1, '同格续期不重置已等待时长');
  h.handler.schedule(h.cellB, false);
  assert.equal(h.timers.length, 2, '换格重排（旧定时器作废换新）');
});

test('v439 chain: 0ms config restores pass-through immediate open (v246 semantics)', () => {
  let opened = 0;
  const h = makeHoverChain({ state: { tipClick: 0, tipHoverMs: 0 }, showTipFor: () => { opened++; } });
  h.handler.schedule(h.cellA, false);
  assert.equal(opened, 1, '0=划过即显，不排程');
  assert.equal(h.timers.length, 0);
});

test('v439 chain: fire re-verifies via elementFromPoint at lastPt before opening', () => {
  let opened = 0;
  const h = makeHoverChain({
    showTipFor: (el) => { if (el === h.cellA) opened++; },
    lastPt: { x: 120, y: 300 },
    document: { elementFromPoint: () => h.cellA },
    hitItemFor: (t) => (t === h.cellA ? h.cellA : null),
  });
  h.handler.schedule(h.cellA, false);
  h.timers[0].fn();   // 触发到点复核
  assert.equal(opened, 1, '复核仍命中同格：打开');
  h.handler.schedule(h.cellB, false);
  h.timers[1].fn();
  assert.equal(opened, 1, '复核元素换格（elementFromPoint→B、hitItemFor→null）：不弹旧格');
});

test('v439 chain: fire with pointer drifted to another cell re-arms for the new cell', () => {
  const opened = [];
  const h = makeHoverChain({
    showTipFor: (el) => opened.push(el),
    lastPt: { x: 200, y: 300 },
    document: { elementFromPoint: () => h.cellB },
    hitItemFor: () => h.cellB,
  });
  h.handler.schedule(h.cellA, false);
  h.timers[0].fn();
  assert.deepEqual(opened, [], '漂移不放旧格');
  assert.equal(h.timers.length, 2, '改靶重排新定时器');
  assert.equal(h.timers[1].ms, 500);
  h.timers[1].fn();
  assert.deepEqual(opened, [h.cellB], '指针已停在新格：重排到点即开');
});

test('v439 chain: fire fails closed when re-hit is unavailable, panel open, or click mode', () => {
  let opened = 0;
  const h = makeHoverChain({
    showTipFor: () => { opened++; },
    lastPt: { x: 120, y: 300 },
    document: { elementFromPoint: () => { throw new Error('sandbox'); } },
  });
  h.handler.schedule(h.cellA, false);
  h.timers[0].fn();
  assert.equal(opened, 0, '复核异常不弹（fail-closed）');
  const h2 = makeHoverChain({
    showTipFor: () => { opened++; },
    lastPt: { x: 120, y: 300 },
    document: { elementFromPoint: () => h.cellA },
    hitItemFor: () => h.cellA,
    panel: { classList: { contains: (c) => c === 'open' } },
  });
  h2.handler.schedule(h2.cellA, false);
  h2.timers[0].fn();
  assert.equal(opened, 0, '设置面板开着不弹');
  const h3 = makeHoverChain({
    state: { tipClick: 1, tipHoverMs: 50 },
    showTipFor: () => { opened++; },
    lastPt: { x: 120, y: 300 },
    document: { elementFromPoint: () => h3.cellA },
    hitItemFor: () => h3.cellA,
  });
  h3.handler.schedule(h3.cellA, false);   // 等待期间切到点击模式
  h3.ctx.state.tipClick = 1;
  h3.timers[0].fn();
  assert.equal(opened, 0, '切点击模式后在途排程到点放弃');
});

test('v439 chain: sub-entry preview delayed and opened via subPopShow on verified re-hit', () => {
  const previews = [];
  const h = makeHoverChain({
    subPopShow: (el, pin) => previews.push([el, pin]),
    lastPt: { x: 150, y: 300 },
    document: { elementFromPoint: () => h.subEntry },
  });
  h.handler.schedule(h.subEntry, true);
  assert.deepEqual(previews, [], '门槛内不预览');
  h.timers[0].fn();
  assert.deepEqual(previews, [[h.subEntry, false]], '复核命中子代理入口：preview 打开（非 pinned）');
});

test('v439 chain: cancel clears the armed timer and pending target', () => {
  let opened = 0;
  let cleared = 0;
  const h = makeHoverChain({
    showTipFor: () => { opened++; },
    lastPt: { x: 120, y: 300 },
    document: { elementFromPoint: () => h.cellA },
    hitItemFor: () => h.cellA,
    clearTimeout: () => { cleared++; },
  });
  h.handler.schedule(h.cellA, false);
  h.handler.cancel();
  assert.equal(cleared, 1, '取消时清掉在途定时器');
  h.timers[0].fn();   // 已取消：fire 无 pend 可取
  assert.equal(opened, 0, '取消后到点不弹');
});

test('v249 click mode: an already-open tip keeps its keep/close branches (tip hover, panel)', () => {
  const hidden = [];
  let now = 1e12;
  const tipChild = { closest: () => null };   // tooltip 内子元素：有 closest，能走过 !t.closest 早退
  const tipNode = { contains: (t) => t === tipChild };
  const h = makeMoveHandler({
    Date: { now: () => (now += 200) },   // 每次 move 推进 200ms，越过 150ms 节流
    state: { tipClick: 1, theme: 'default' },
    tipFor: {},   // 已有 tooltip 打开
    tip: tipNode,
    hideTip: (force, cause) => hidden.push(cause),
  });
  h.move(tipChild, 100, 300);
  assert.deepEqual(hidden, [], '鼠标移入 tooltip：点击模式下仍保持（keep 分支真路径）');
  assert.equal(h.ctx.mouseInBar, true);
  h.move({ closest: (sel) => sel === '.panel' ? {} : null }, 120, 300);
  assert.deepEqual(hidden, ['panel-hover'], '移入面板仍按 panel-hover 收起');
});

/* ---------- 4. 点击模式：bar.click 首击打开 / 再击关闭 / 停留模式不接管 ---------- */
test('v249 click mode: first click opens (focusin race), re-click closes; dwell mode ignores clicks', () => {
  const clickSrc = extract('    bar.addEventListener("click", function (e) {', '    subPanel.addEventListener("click"');
  const focusSrc = extract('    main.addEventListener("focusin", function (e) {', '    main.addEventListener("focusout"');
  function session(tipClick) {
    let clickHandler = null, focusHandler = null, shown = 0, hidden = 0, focusCancels = 0;
    const it = { __tip: 'tip', getBoundingClientRect: () => ({ left: 0, right: 50 }), closest(sel) { return sel === '.it' ? it : null; } };
    const st = {
      bar: { addEventListener: (t, fn) => { if (t === 'click') clickHandler = fn; } },
      main: { addEventListener: (t, fn) => { if (t === 'focusin') focusHandler = fn; }, contains: () => true, getBoundingClientRect: () => ({ left: 0, right: 100 }) },
      state: { tipClick, theme: 'default' },
      inactive: () => false, restoringFocus: false,
      subPopMode: 'closed', subPopClose: () => {}, subPopShow: () => {},
      cancelTipGrace: () => {}, tipHoverCancel: () => { focusCancels++; }, mouseInBar: false, tipFor: null, focusTipAt: 0, api: null,
      showTipFor: el => { shown++; st.tipFor = el; },
      hideTip: () => { hidden++; st.tipFor = null; },
      panel: { classList: { contains: () => false } },
    morePanel: { classList: { contains: () => false } },   // v350「···」菜单守卫
      Date,
    };
    vm.runInNewContext(clickSrc + '\n' + focusSrc, vm.createContext(st));
    const ev = { target: { closest: sel => sel === '.it' ? it : null }, stopPropagation() {} };
    return { st, it, ev, clickHandler, focusHandler, cancels: () => focusCancels,
      clickOnce() { focusHandler({ target: it }); clickHandler(ev); } };
  }
  const s = session(1);
  s.clickOnce();   // 真实点击 span[tabindex=0] 的事件序：focusin 先于 click
  assert.equal(s.st.tipFor && s.st.tipFor.__tip, 'tip', '首击后 tooltip 保持打开（hidden=' + 0 + ' 预期）');
  assert.equal(s.cancels(), 1, 'v442：focusin 打开前撤在途悬停排程（review 变异 c 补防）');
  assert.equal(s.st.focusTipAt > 0, true, 'focusin 记录 focusTipAt');
  // 再击：焦点已在同格不会重新 focusin，直接 click，且距 focusTipAt 已超 300ms 守卫窗口
  s.st.focusTipAt = 0;
  s.clickHandler(s.ev);
  assert.equal(s.st.tipFor, null, '再击关闭');
  const off = session(0);
  off.focusHandler({ target: off.it });
  const shownAfterFocus = off.st.tipFor ? 1 : 0;
  assert.equal(shownAfterFocus, 1, '停留模式 focusin 仍即时打开（键盘契约）');
  off.clickHandler(off.ev);
  assert.equal(off.st.tipFor && off.st.tipFor.__tip, 'tip', '停留模式 click 不接管（不关也不重开）');
});

test('v249 keyboard: focusin opens immediately in BOTH modes (accessibility unchanged)', () => {
  const focusSrc = extract('    main.addEventListener("focusin", function (e) {', '    main.addEventListener("focusout"');
  for (const tipClick of [0, 1]) {
    let focusHandler = null, shown = 0, focusCancels = 0;
    const it = { __tip: 'tip', getBoundingClientRect: () => ({ left: 0, right: 50 }), closest(sel) { return sel === '.it' ? it : null; } };
    const st = {
      main: { addEventListener: (t, fn) => { if (t === 'focusin') focusHandler = fn; }, contains: () => true, getBoundingClientRect: () => ({ left: 0, right: 100 }) },
      state: { tipClick, theme: 'default' },
      inactive: () => false, restoringFocus: false,
      cancelTipGrace: () => {}, tipHoverCancel: () => { focusCancels++; }, mouseInBar: false, tipFor: null, focusTipAt: 0, api: null,
      showTipFor: () => { shown++; },
      panel: { classList: { contains: () => false } },
    morePanel: { classList: { contains: () => false } },   // v350「···」菜单守卫
    };
    vm.runInNewContext(focusSrc, vm.createContext(st));
    focusHandler({ target: it });
    assert.equal(shown, 1, 'tipClick=' + tipClick + '：键盘 Tab 聚焦即时打开');
    assert.equal(focusCancels, 1, 'v442：键盘打开同时撤在途排程（两模式一致）');
    assert.ok(st.focusTipAt > 0, 'focusTipAt 被记录（点击模式首击防抵消依赖它）');
  }
});

test('v249 sub-agent in click mode: bar click still pins the popover open (existing contract)', () => {
  const clickSrc = extract('    bar.addEventListener("click", function (e) {', '    subPanel.addEventListener("click"');
  let clickHandler = null, pinned = 0;
  const sub = { closest(sel) { return sel === '.zu-sub' ? sub : null; } };
  const ctx = {
    bar: { addEventListener: (t, fn) => { if (t === 'click') clickHandler = fn; } },
    state: { tipClick: 1 },
    inactive: () => false, subPopMode: 'closed',
    subPopClose: () => {}, subPopShow: (entry, pin) => { if (pin) pinned++; },
  };
  vm.runInNewContext(clickSrc, vm.createContext(ctx));
  clickHandler({ target: sub, stopPropagation() {} });
  assert.equal(pinned, 1, '点击模式点击子代理入口仍 pinned 打开（v246 既有契约不受开关影响）');
});

/* ---------- 3c. v440 chip 悬停门槛：工具行/流内 chip 家族同走 tipHoverMs（用户规格） ---------- */
test('v440 wiring: six toolbar chips gate mouseenter and disarm on mouseleave (keyboard focus stays immediate)', () => {
  assert.match(source, /el\.addEventListener\("mouseenter", function \(\) \{ cancelRstHide\(\); var elT = this; zuChipHoverArm\(elT, function \(\) \{ showRstTip\(elT\); \}\); \}\)/);
  assert.match(source, /el\.addEventListener\("mouseleave", function \(\) \{ zuChipHoverDisarm\(el\); scheduleRstHide\(\); \}\)/);
  assert.match(source, /chip\.addEventListener\("mouseenter", function \(\) \{ cancelTpsHide\(\); zuChipHoverArm\(chip, function \(\) \{ showTpsTip\(chip\); \}\); \}\)/);
  assert.match(source, /chip\.addEventListener\("mouseleave", function \(\) \{ zuChipHoverDisarm\(chip\); scheduleTpsHide\(\); \}\)/);
  assert.match(source, /chip\.addEventListener\("mouseenter", function \(\) \{ var qT = this; zuChipHoverArm\(qT, function \(\) \{ onQuotaEnter\.call\(qT\); \}\); \}\)/);
  assert.match(source, /chip\.addEventListener\("mouseleave", function \(\) \{ zuChipHoverDisarm\(chip\); hideQuotaTip\(\); \}\)/);
  assert.match(source, /b\.addEventListener\("mouseenter", function \(\) \{ var bT = this; zuChipHoverArm\(bT, function \(\) \{ showEnhanceTip\(bT\); \}\); \}\)/);
  assert.match(source, /b\.addEventListener\("mouseleave", function \(\) \{ zuChipHoverDisarm\(b\); scheduleEnhHide\(\); \}\)/);
  assert.match(source, /chip\.addEventListener\("mouseenter", function \(\) \{ var gT = this; zuChipHoverArm\(gT, function \(\) \{ onGitEnter\.call\(gT\); \}\); \}\)/);
  assert.match(source, /chip\.addEventListener\("mouseleave", function \(\) \{ zuChipHoverDisarm\(chip\); hideGitTipSoon\(\); \}\)/);
  assert.match(source, /chip\.addEventListener\("mouseenter", function \(\) \{ var sT = this; zuChipHoverArm\(sT, function \(\) \{ onSysChipEnter\.call\(sT\); \}\); \}\)/);
  assert.match(source, /chip\.addEventListener\("mouseleave", function \(\) \{ zuChipHoverDisarm\(chip\); hideSysTipSoon\(\); \}\)/);
  /* 键盘路径不进门：focus 仍直呼原处理器（issue #445 语义 = 悬停门槛，不挡键盘） */
  assert.match(source, /chip\.addEventListener\("focus", onQuotaEnter\)/);
  assert.match(source, /chip\.addEventListener\("focus", onGitEnter\)/);
  assert.match(source, /chip\.addEventListener\("focus", onSysChipEnter\)/);
  assert.match(source, /el\.addEventListener\("focus", function \(\) \{ showRstTip\(this\); \}\)/);
  assert.match(source, /b\.addEventListener\("focus", function \(\) \{ showEnhanceTip\(this\); \}\)/);
  assert.match(source, /chip\.addEventListener\("focus", function \(\) \{ showTpsTip\(chip\); \}\)/);
});

test('v440 wiring: flow-chip delegation gates over, disarms on real leave; dispose sweeps the slot', () => {
  assert.match(source, /zuChipHoverArm\(chip, function \(\) \{ showSubTip\(chipT\); \}\)/, '子代理速率/工作流卡/状态面板行 chip 委托同走门槛');
  assert.match(source, /zuChipHoverDisarm\(fromChip\)/, 'docOut 真离开 chip 才撤排程（chip 内子元素间移动不撤）');
  assert.match(source, /zuChipHoverDisarm\(\);   \/\/ v440/, 'disposeOverlay 统一撤在途排程');
});

test('v440 gate: single slot keyed by element — keep on same, switch cancels, disarm kills, 0 passes through', () => {
  const gateSrc = sliceOverlay('var zuChipHoverSlot = null;', 'function subTipDocOver(e) {');
  const elA = { isConnected: true }, elB = { isConnected: true };
  const timers = [];
  const opened = [];
  const ctx = {
    state: { tipHoverMs: 50 },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
    clearTimeout: (n) => { if (timers[n - 1]) timers[n - 1].cleared = true; },
  };
  vm.runInNewContext(gateSrc + '\nglobalThis.gate = { arm: zuChipHoverArm, disarm: zuChipHoverDisarm };', vm.createContext(ctx));
  const gate = ctx.gate;
  gate.arm(elA, () => opened.push('A'));
  assert.equal(opened.length, 0, '门槛内不直开');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 50);
  gate.arm(elA, () => opened.push('A'));
  assert.equal(timers.length, 1, '同 chip 续期不重排（已等待时长不重置）');
  gate.arm(elB, () => opened.push('B'));
  assert.equal(timers.length, 2, '换 chip 重排');
  assert.equal(timers[0].cleared, true, '旧排程被撤（快速扫过多 chip 不连跳）');
  gate.disarm(elB);
  timers[1].fn();
  assert.deepEqual(opened, [], '离开后过期回调直接弃（槽身份自校验）');
  gate.disarm(elA);   // 陌生 key / 空槽静默
  ctx.state.tipHoverMs = 0;
  gate.arm(elA, () => opened.push('A0'));
  assert.deepEqual(opened, ['A0'], '0=划过即显（v246 原语义），不排程');
  assert.equal(timers.length, 2);
  ctx.state.tipHoverMs = 50;
  gate.arm({ isConnected: false }, () => opened.push('dead'));
  timers[2].fn();
  assert.deepEqual(opened, ['A0'], '到点时 chip 已断连（实例销毁/重建摘除）：不重挂');
  gate.arm(elB, () => opened.push('B2'));
  timers[3].fn();
  assert.deepEqual(opened, ['A0', 'B2'], '正常到点打开并清槽');
});

/* ---------- 3d. v442 收口审查修复批：真离开撤排程 / fail-closed / 流内委托行为级 ---------- */
test('v442 fire: invalid lastPt fails closed even when elementFromPoint would hit (review M2)', () => {
  let opened = 0;
  const h = makeHoverChain({
    showTipFor: () => { opened++; },
    lastPt: { x: -1, y: -1 },   // 未动过的初值
    document: { elementFromPoint: () => h.cellA },
    hitItemFor: () => h.cellA,
  });
  h.handler.schedule(h.cellA, false);
  h.timers[0].fn();
  assert.equal(opened, 0, 'px<0（切片沙箱/未动过）不弹——elementFromPoint 命中也不复核放行');
});

test('v442 tipLeaveAt: genuine boundary during pending dwell cancels the schedule; pseudo-leave keeps it (review MAJOR)', () => {
  const leaves = sliceOverlay('    function tipLeaveAt(x, y) {', '    listenGlobal(document.documentElement, "mouseleave"');
  const cell = { tagName: 'SPAN' };
  function session({ hovered, tipFor, withinGuard }) {
    const calls = { cancel: 0, boundary: [] };
    const ctx = {
      inactive: () => false,
      tipFor: tipFor ? { __tip: 't' } : null,
      lastTipDownAt: withinGuard ? Date.now() - 100 : 0,
      Date,
      innerWidth: 1200, innerHeight: 900,
      document: { querySelectorAll: (sel) => (sel === ':hover' ? hovered : []) },
      tipHoverCancel: () => { calls.cancel++; },
      tipBoundaryHide: (src) => { calls.boundary.push(src); },
      tip: { getBoundingClientRect: () => ({ left: 400, right: 600, top: 700, bottom: 730 }) },
      tipStats: { grace: 0 }, mouseInBar: false,
      state: { devKeepTip: 0 }, hideTip: () => {}, cancelTipGrace: () => {}, tipGraceTimer: 0,
      setTimeout: () => 1, clearTimeout: () => {},
    };
    vm.runInNewContext(leaves, vm.createContext(ctx));
    return { ctx, calls };
  }
  let s1 = session({ hovered: [], tipFor: false, withinGuard: false });
  s1.ctx.tipLeaveAt(600, 400);   // 视口内真离开（进聊天子文档形态）
  assert.equal(s1.calls.cancel, 1, '待开门窗口内真边界跃迁必须撤排程（tipFor 尚空也要撤）');
  s1 = session({ hovered: [], tipFor: true, withinGuard: false });
  s1.ctx.tipLeaveAt(600, 400);
  assert.equal(s1.calls.cancel, 1, '已开门态真离开同样撤排程');
  let s2 = session({ hovered: [cell], tipFor: false, withinGuard: false });
  s2.ctx.tipLeaveAt(600, 400);   // v99 伪 leave（:hover 最深仍是格内元素）
  assert.equal(s2.calls.cancel, 0, '伪边界不得撤排程（流式重排补发会永久打断 dwell）');
  let s3 = session({ hovered: [], tipFor: true, withinGuard: false });
  s3.ctx.tipLeaveAt(600, 899);   // 贴底边
  assert.equal(s3.calls.cancel, 1);
  assert.deepEqual(s3.calls.boundary, ['edge'], '贴边真离开仍走 tipBoundaryHide');
  let s4 = session({ hovered: [], tipFor: true, withinGuard: true });
  s4.ctx.tipLeaveAt(600, 899);   // 按压保活窗内真边界
  assert.equal(s4.calls.cancel, 1, 'v442 复审 M-2：撤排程先于 1.2s 守卫（保活窗内也撤）');
  assert.deepEqual(s4.calls.boundary, [], '守卫内不触发 tipBoundaryHide（v277 语义不变）');
});

test('v442 boundaryHide and dispose lock the cancel paths in source (review MAJOR follow-up)', () => {
  const bh = sliceOverlay('    function tipBoundaryHide(src) {', '    listenGlobal(window, "blur"');
  assert.match(bh, /tipHoverCancel\(\);/, 'win-leave/edge/blur 入口撤在途排程');
  assert.match(source, /cancelAnimationFrame\(frame\);\s*cancelTipGrace\(\);\s*tipHoverCancel\(\);/, '12 分片 dispose 撤条面链');
});

test('v442 flow delegation: leaving the chip disarms the pending open; inner moves keep it (review M7)', () => {
  const gateSrc = sliceOverlay('var zuChipHoverSlot = null;', 'document.addEventListener("mouseover", subTipDocOver, true);');
  const chip = { __zuT: { k: 1 }, isConnected: true, closest: (sel) => (/\.zu-subrate|\.zu-wfrun|\.zu-substat/.test(sel) ? chip : null) };
  const timers = [];
  const calls = { show: [], hide: 0 };
  const ctx = {
    state: { tipHoverMs: 500 },
    stale: () => false,
    Date,
    document: { addEventListener() { }, elementFromPoint: () => chip },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (n) => { if (timers[n - 1]) timers[n - 1].cleared = true; },
    cancelSubHide: () => { },
    showSubTip: (el) => calls.show.push(el),
    scheduleSubHide: () => { calls.hide++; },
    subTipFor: null,
    subTip: { contains: () => false },
  };
  vm.runInNewContext(gateSrc, vm.createContext(ctx));
  const child = { closest: chip.closest.bind(chip) };
  ctx.subTipDocOver({ target: child });   // 委托悬停 → 排程（不直开）
  assert.equal(calls.show.length, 0, '门槛内不直开');
  assert.equal(timers.length, 1);
  ctx.subTipDocOut({ target: child, relatedTarget: { closest: chip.closest.bind(chip) } });   // chip 内子元素间移动
  assert.notEqual(timers[0].cleared, true, 'chip 内移动不撤排程');
  ctx.subTipDocOut({ target: child, relatedTarget: null });   // 真离开
  assert.equal(timers[0].cleared, true, '真离开 chip 撤在途排程');
  timers[0].fn();
  assert.equal(calls.show.length, 0, '离开后到点不弹（过期回调弃置）');
  ctx.subTipDocOver({ target: child });
  timers[1].fn();
  assert.deepEqual(calls.show, [chip], '停留到点经委托正常打开');
});
