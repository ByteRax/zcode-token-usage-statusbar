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

/* ---------- 1. v247 停留定时器链确已移除（防回归复活） ---------- */
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
  };
  vm.runInNewContext(change, vm.createContext(ctx));
  handler({ target: { type: 'checkbox', checked: true, dataset: {}, classList: { contains: c => c === 'zu-tip-click' } } });
  assert.equal(state.tipClick, 1);
  assert.equal(saved, 1);
  assert.deepEqual({ ...state.show }, { turn: 1 }, '不落入 show[undefined] 分支');
});

/* ---------- 3. mousemove 两态：缺省即时悬停（v246 原语义），点击模式不打开 ---------- */
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
    state: { tipClick: 0, theme: 'default' },
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
    tipFor: null, tipSig: '',
    hideTip: () => {}, drawTip: () => {}, showTipFor: () => {},
    hitItemFor: (t) => (t === subEntry ? subEntry : cell),
    inTipCorridor: () => false, inTipColumn: () => false,
    tipGraceTimer: 0, setTimeout: () => 1, clearTimeout: () => {},
    document: {},
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

test('v249 dwell-off (default): hover opens the stat tip immediately (v246 semantics restored)', () => {
  let opened = 0;
  const h = makeMoveHandler({ showTipFor: () => { opened++; } });
  h.move(h.cell, 100, 300);   // 首个事件：lastMoveAt=0 必过节流
  assert.equal(opened, 1, '开关关闭：命中格子立即 showTipFor（无停留延迟）');
  assert.equal(h.ctx.mouseInBar, true);
});

test('v249 dwell-off (default): hovering the sub-agent entry previews instantly (v217 contract)', () => {
  let previews = 0;
  const h = makeMoveHandler({ subPopShow: () => { previews++; } });
  h.move(h.subEntry, 100, 300);
  assert.equal(previews, 1, '开关关闭：悬停子代理入口即时 preview');
});

test('v249 click mode: hover neither opens cells nor previews the sub-agent popover', () => {
  let opened = 0, previews = 0;
  const h = makeMoveHandler({
    state: { tipClick: 1, theme: 'default' },
    showTipFor: () => { opened++; },
    subPopShow: () => { previews++; },
  });
  h.move(h.cell, 100, 300);
  h.move(h.subEntry, 110, 300);
  assert.equal(opened, 0, '点击模式悬停不打开统计卡');
  assert.equal(previews, 0, '点击模式悬停不预览子代理面板');
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
    let clickHandler = null, focusHandler = null, shown = 0, hidden = 0;
    const it = { __tip: 'tip', closest(sel) { return sel === '.it' ? it : null; } };
    const st = {
      bar: { addEventListener: (t, fn) => { if (t === 'click') clickHandler = fn; } },
      main: { addEventListener: (t, fn) => { if (t === 'focusin') focusHandler = fn; }, contains: () => true },
      state: { tipClick, theme: 'default' },
      inactive: () => false, restoringFocus: false,
      subPopMode: 'closed', subPopClose: () => {}, subPopShow: () => {},
      cancelTipGrace: () => {}, mouseInBar: false, tipFor: null, focusTipAt: 0, api: null,
      showTipFor: el => { shown++; st.tipFor = el; },
      hideTip: () => { hidden++; st.tipFor = null; },
      panel: { classList: { contains: () => false } },
      Date,
    };
    vm.runInNewContext(clickSrc + '\n' + focusSrc, vm.createContext(st));
    const ev = { target: { closest: sel => sel === '.it' ? it : null }, stopPropagation() {} };
    return { st, it, ev, clickHandler, focusHandler,
      clickOnce() { focusHandler({ target: it }); clickHandler(ev); } };
  }
  const s = session(1);
  s.clickOnce();   // 真实点击 span[tabindex=0] 的事件序：focusin 先于 click
  assert.equal(s.st.tipFor && s.st.tipFor.__tip, 'tip', '首击后 tooltip 保持打开（hidden=' + 0 + ' 预期）');
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
    let focusHandler = null, shown = 0;
    const it = { __tip: 'tip', closest(sel) { return sel === '.it' ? it : null; } };
    const st = {
      main: { addEventListener: (t, fn) => { if (t === 'focusin') focusHandler = fn; }, contains: () => true },
      state: { tipClick, theme: 'default' },
      inactive: () => false, restoringFocus: false,
      cancelTipGrace: () => {}, mouseInBar: false, tipFor: null, focusTipAt: 0, api: null,
      showTipFor: () => { shown++; },
      panel: { classList: { contains: () => false } },
    };
    vm.runInNewContext(focusSrc, vm.createContext(st));
    focusHandler({ target: it });
    assert.equal(shown, 1, 'tipClick=' + tipClick + '：键盘 Tab 聚焦即时打开');
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
