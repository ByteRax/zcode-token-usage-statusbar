const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* v247 悬浮窗口激活方式：⚙ 开关（zusage3.tipClick 缺省关=停留 1 秒、仅显式 "1" 开=点击）
 * 与独立 1000ms 停留计时链的契约。真实悬停/伪 leave 只能实机指针验收，VM 只锁判定表、
 * 定时器纪律、取消出口与接线（tests.md 反假绿灯纪律：另配行为级切片，不靠字符串冒充）。 */
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
function extract(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'slice ' + start);
  return source.slice(a, b);
}

/* ---------- 1. 开关接线：LS/state/启动读/persist/两处回填/change 分支 ---------- */
test('v247 setting: LS key, default-off state seed, boot read and persist round-trip', () => {
  assert.match(source, /tipClick: "zusage3\.tipClick"/);
  assert.match(source, /tipClick: 0,/);   // 缺省关（停留 1 秒），不是 ctxCpt 那种缺省开
  assert.match(source, /if \(ls\(LS\.tipClick, ""\) === "1"\) state\.tipClick = 1;/);
  assert.match(source, /lsSet\(LS\.tipClick, state\.tipClick \? "1" : "0"\);/);
  // 面板行 + 双语文案 + 两处回填（buildPanel 尾部与 syncPanel 各一处，>=2）
  assert.match(source, /class="zu-tip-click"/);
  assert.match(source, /L\("点击激活悬浮窗口", "Click to open popups"\)/);
  const reads = (source.match(/var tipClickBox = panel\.querySelector\("\.zu-tip-click"\);/g) || []).length;
  assert.equal(reads, 2, 'buildPanel 与 syncPanel 两处回填都在（语言切换不走 syncPanel）');
  // change 委托分支在通用 checkbox 分支之前并 return，避免 show[undefined]
  const change = extract('    panel.addEventListener("change",', '    listenGlobal(document, "mousedown"');
  assert.match(change, /t2\.classList\.contains\("zu-tip-click"\)/);
  assert.match(change, /state\.tipClick = t2\.checked \? 1 : 0;/);
  assert.match(change, /hoverCancel\(\);/);
  const clickIdx = change.indexOf('zu-tip-click'), genericIdx = change.indexOf('if (t2.type === "checkbox")');
  assert.ok(clickIdx > 0 && genericIdx > 0 && clickIdx < genericIdx, '新分支先于通用 checkbox 分支');
});

test('v247 setting: change handler flips state, persists, cancels pending hover, leaves show untouched', () => {
  const change = extract('    panel.addEventListener("change",', '    listenGlobal(document, "mousedown"');
  let handler = null, saved = 0, cancels = 0;
  const state = { tipClick: 0, show: { turn: 1 } };
  const ctx = {
    panel: { addEventListener: (type, fn) => { if (type === 'change') handler = fn; } },
    state,
    persist: () => { saved++; },
    hoverCancel: () => { cancels++; },
    inactive: () => false,
    pluginRequest: () => {}, renderAll: () => {}, syncPanel: () => {}, scanRateLines: () => {},
    scanDeterministicLines: () => {}, showSettingsFeedback: () => {}, setBarTheme: () => {},
    setBarJust: () => {}, sendAutoCompactConfig: () => {}, applyProjPath: () => {},
    applyCmdkW: () => {}, syncCompactBtn: () => {}, closeCompactDlg: () => {},
    rebuildExcBubble: () => {}, autoCompactOnShow: () => {}, refreshWants: () => {},
    richTextAttempts: {}, richTextUnitEpoch: 0,
    gear: { setAttribute: () => {} },
    ls: () => '', lsSet: () => {}, LS: { autoCompact: '' },
    buildPanel: () => {}, document: { querySelector: () => null },
    t2: null,
  };
  vm.runInNewContext(change, vm.createContext(ctx));
  assert.ok(handler, 'change handler captured');
  handler({ target: { type: 'checkbox', checked: true, dataset: {}, classList: { contains: c => c === 'zu-tip-click' } } });
  assert.equal(state.tipClick, 1);
  assert.equal(saved, 1);
  assert.equal(cancels, 1);
  assert.deepEqual({ ...state.show }, { turn: 1 }, '不落入 show[undefined] 分支');
});

/* ---------- 2. 停留计时链：独立定时器、1000ms、到点复核、取消出口 ---------- */
function hoverChain(extra = {}) {
  const start = '    var HOVER_OPEN_DELAY_MS = 1000;';
  const end = '    /* 隐藏总闸（v33.3）';
  const body = extract(start, end);
  const timers = new Map();
  let id = 0, now = 0;
  const ctx = Object.assign({
    state: { tipClick: 0 },
    mouseInBar: true,
    tipFor: null,
    panel: { classList: { contains: () => false } },
    subPopOpen: () => false,
    subPopMode: 'closed',
    subPopSuppressAt: 0,
    Date: { now: () => now },
    inactive: () => false,
    document: {
      querySelectorAll: () => [{ tagName: 'SPAN' }],   // :hover 最深元素非 body/iframe
      elementFromPoint: () => ({ closest: () => null }),
    },
    bar: { contains: () => true },
    hitItemFor: () => ({ __tip: 'tip' }),
    showTipFor: () => {},
    subPopShow: () => {},
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimeout: n => timers.delete(n),
    focusTipAt: 0,
  }, extra);
  Object.keys(extra).forEach(k => {
    const d = Object.getOwnPropertyDescriptor(extra, k);
    if (d && (d.get || d.set)) Object.defineProperty(ctx, k, d);
  });
  vm.runInNewContext(body + '\napi = { hoverCancel, hoverSchedule, hoverCheck, hoverStillOn };', vm.createContext(ctx));
  return { api: ctx.api, timers, setNow: v => { now = v; }, ctx };
}

test('v247 dwell: one independent 1000ms timer, same hit element does not reset it', () => {
  const cell = { __tip: 'a' };
  const h = hoverChain();
  h.api.hoverSchedule(100, 200, cell);
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].ms, 1000, '独立 1000ms，不依赖 150ms 节流');
  const firstId = [...h.timers.keys()][0];
  h.api.hoverSchedule(100, 200, cell);   // 节流会反复采样同一格
  assert.equal(h.timers.size, 1, '同格在途不重排（重排将永不触发）');
  assert.equal([...h.timers.keys()][0], firstId, '同格续期必须保留原 timer id（不 clearTimeout 重排）');
  assert.equal(h.ctx.hoverX, 100, '同格续期仍刷新当前坐标');
  h.api.hoverSchedule(101, 200, { __tip: 'b' });   // 相邻格 1px 微移：换目标必须重排
  assert.equal(h.timers.size, 1);
  assert.equal(h.ctx.hoverX, 101, '换目标后到点用新坐标');
  assert.notEqual(h.ctx.hoverKey, cell, 'key 换成新元素');
});

test('v247 dwell: click mode never schedules, cancel clears the pending timer', () => {
  const h = hoverChain({ state: { tipClick: 1 } });
  h.api.hoverSchedule(100, 200);
  assert.equal(h.timers.size, 0, '点击模式不排停留计时');
  const h2 = hoverChain();
  h2.api.hoverSchedule(100, 200);
  h2.api.hoverCancel();
  assert.equal(h2.timers.size, 0);
});

test('v247 dwell: to-point re-hits via elementFromPoint at current coords (survives 1.5s .it rebuild)', () => {
  let opened = 0, pointArgs = null, hitNode = null, hitX = null;
  const liveNode = { tagName: 'SPAN', closest: () => null };
  const freshCell = { id: 'fresh' };
  const h = hoverChain({
    tipFor: null,
    hitItemFor: (at, x) => { hitNode = at; hitX = x; return freshCell; },
    showTipFor: el => { opened++; assert.equal(el.id, 'fresh'); },
    document: {
      querySelectorAll: () => [{ tagName: 'SPAN' }],
      elementFromPoint: (...args) => { pointArgs = args; return liveNode; },
    },
  });
  h.api.hoverSchedule(240, 300, {});
  // 到点前鼠标微移到同格另一坐标：续期刷新当前坐标，复核用新坐标
  h.api.hoverSchedule(242, 300, h.ctx.hoverKey);
  const fn = [...h.timers.values()][0].fn;
  fn();
  assert.deepEqual(pointArgs, [242, 300], '到点按续期后的当前 hoverX/hoverY 取节点（不复用 1 秒前坐标）');
  assert.equal(hitNode, liveNode, 'hitItemFor 收到 elementFromPoint 的真实活节点');
  assert.equal(hitX, 242, '重命中用续期后的当前坐标');
  assert.equal(opened, 1, '仍在条上 -> 打开统计卡');
  assert.equal(h.ctx.hoverTimer, 0, '回调内 hoverTimer 归零（不残留 timer id）');
});

test('v247 dwell: to-point bails when pointer left bar / pane open / generation stale / click mode toggled', () => {
  let opened = 0;
  const cases = [
    { label: 'mouseInBar=false', extra: { get mouseInBar() { return false; } } },
    { label: 'panel open', extra: { panel: { classList: { contains: () => true } } } },
    { label: 'sub pop open', extra: { subPopOpen: () => true } },
    { label: 'stale generation', extra: { inactive: () => true } },
    { label: 'click mode switched on mid-flight', extra: { state: { tipClick: 1 } } },
    { label: ':hover chain truncated to body', extra: { document: { querySelectorAll: () => [{ tagName: 'BODY' }], elementFromPoint: () => null }, bar: { contains: () => false } } },
  ];
  for (const c of cases) {
    const h = hoverChain(Object.assign({ showTipFor: () => { opened++; }, hitItemFor: () => ({}) }, c.extra));
    h.api.hoverSchedule(100, 200);
    if (h.timers.size) [...h.timers.values()][0].fn();
    assert.equal(opened, 0, c.label + ' 不得误弹');
  }
});

test('v247 dwell: sub-agent entry is opened by dwell (not instant) and respects the 500ms suppress', () => {
  let pops = 0;
  const sub = { tagName: 'BUTTON' };
  const h = hoverChain({
    document: {
      querySelectorAll: () => [{ tagName: 'SPAN' }],
      elementFromPoint: () => ({ closest: sel => sel === '.zu-sub' ? sub : null }),
    },
    subPopShow: () => { pops++; },
    hitItemFor: () => null,
    Date: { now: () => 10000 },
    subPopSuppressAt: 0,
  });
  h.api.hoverSchedule(100, 200);
  assert.equal(pops, 0, '停留未满 1 秒不预览子代理面板');
  [...h.timers.values()][0].fn();
  assert.equal(pops, 1);
  // 抑制期内不重开
  const h2 = hoverChain({
    document: {
      querySelectorAll: () => [{ tagName: 'SPAN' }],
      elementFromPoint: () => ({ closest: sel => sel === '.zu-sub' ? sub : null }),
    },
    subPopShow: () => { pops++; },
    hitItemFor: () => null,
    Date: { now: () => 10000 },
    subPopSuppressAt: 11000,
  });
  h2.api.hoverSchedule(100, 200);
  [...h2.timers.values()][0].fn();
  assert.equal(pops, 1, '500ms 抑制内不闪回');
});

/* ---------- 3. 点击模式：bar.click 接管 .it，停留模式不接管 ---------- */
test('v247 click mode: first click opens (focusin race), re-click closes; dwell mode ignores', () => {
  const clickSrc = extract('    bar.addEventListener("click", function (e) {', '    subPanel.addEventListener("click"');
  const focusSrc = extract('    main.addEventListener("focusin", function (e) {', '    main.addEventListener("focusout"');
  function session(tipClick) {
    let clickHandler = null, focusHandler = null, shown = 0, hidden = 0, cancels = 0;
    const it = { __tip: 'tip', closest(sel) { return sel === '.it' ? it : null; } };
    const st = {
      bar: { addEventListener: (t, fn) => { if (t === 'click') clickHandler = fn; } },
      main: { addEventListener: (t, fn) => { if (t === 'focusin') focusHandler = fn; }, contains: () => true },
      state: { tipClick, theme: 'default' },
      inactive: () => false, restoringFocus: false,
      subPopMode: 'closed', subPopClose: () => {}, subPopShow: () => {},
      hoverCancel: () => { cancels++; }, cancelTipGrace: () => {},
      mouseInBar: false, tipFor: null, focusTipAt: 0, api: null,
      showTipFor: el => { shown++; st.tipFor = el; },
      hideTip: () => { hidden++; st.tipFor = null; },
      panel: { classList: { contains: () => false } },
      Date,
    };
    vm.runInNewContext(clickSrc + '\n' + focusSrc, vm.createContext(st));
    const ev = { target: { closest: sel => sel === '.it' ? it : null }, stopPropagation() {} };
    // 真实点击 span[tabindex=0] 的事件序：focusin 先于 click
    function clickOnce() { focusHandler({ target: it }); clickHandler(ev); }
    return { st, it, ev, clickHandler, focusHandler, clickOnce, counts: () => ({ shown, hidden, cancels }) };
  }
  const s = session(1);
  s.clickOnce();                      // 首击：focusin 打开、click 不得抵消
  assert.equal(s.st.tipFor && s.st.tipFor.__tip, 'tip', '首击后 tooltip 保持打开');
  assert.equal(s.counts().hidden, 0, 'focusin 刚打开时 click 不按 re-click 关闭');
  s.st.focusTipAt = 0;               // 模拟距 focusin 已过 300ms（稳定的再点）
  s.clickHandler(s.ev);              // 再击：焦点已在该 .it，click 走 re-click 关闭
  assert.equal(s.counts().hidden, 1, '再击关闭');
  const off = session(0);
  // 停留模式：focusin（键盘/聚焦）仍可即时打开，但 bar.click 的 .it 分支不得接管
  off.focusHandler({ target: off.it });
  const before = off.counts();
  off.clickHandler(off.ev);
  assert.equal(off.counts().shown, before.shown, '停留模式 click 不打开');
  assert.equal(off.counts().hidden, before.hidden, '停留模式 click 不关闭');
});

/* ---------- 4. 节流吞采样（MAJOR）：滑入格子后静止，唯一一次 mousemove 被 150ms 节流吃掉仍能排程 ---------- */
test('v247 dwell: hover scheduling runs before the 150ms throttle (fast slide-in + freeze still opens)', () => {
  const start = source.indexOf('listenGlobal(document, "mousemove"');
  const end = source.indexOf('}, true);', start);
  const handlerSource = source.slice(start, end + '}, true);'.length);
  let handler = null, scheduled = 0;
  const cell = { __tip: 'tip', closest: () => null };
  const ctx = {
    listenGlobal: (t, type, fn) => { if (type === 'mousemove') handler = fn; },
    inactive: () => false,
    hoverCancel: () => {},
    hoverSchedule: () => { scheduled++; },
    hitItemFor: () => cell,
    fxTip: { style: { display: 'none' }, contains: () => false },
    subPopOpen: () => false,
    subPopMode: 'closed', subPopSuppressAt: 0,
    cancelTipGrace: () => {}, subPopCancelHide: () => {}, subPopScheduleHide: () => {},
    tipStats: { mv: 0, corridor: 0, grace: 0 },
    lastMoveAt: Date.now(),       // 关键：本次事件距上次采样 <150ms，节流将整段 return
    Date,
    mouseInBar: true, tipFor: null, tipSig: '', state: { tipClick: 0, theme: 'default' },
    panel: { classList: { contains: () => false } },
    bar: { contains: () => true },
    tip: { contains: () => false },
    document: {},
    hideTip: () => {}, drawTip: () => {}, showTipFor: () => {},
    inTipCorridor: () => false, inTipColumn: () => false,
    setTimeout: () => 1, clearTimeout: () => {},
  };
  vm.runInNewContext(handlerSource, vm.createContext(ctx));
  assert.ok(handler);
  handler({ target: { closest: () => null }, clientX: 100, clientY: 200 });
  assert.equal(scheduled, 1, '节流前的排程分支仍执行（否则静止后永不打开）');
  assert.equal(ctx.tipStats.mv, 1);
});

test('v247 dwell: source contract keeps hoverSchedule before the throttle return', () => {
  const start = source.indexOf('listenGlobal(document, "mousemove"');
  const end = source.indexOf('}, true);', start);
  const h = source.slice(start, end);
  const pre = h.indexOf('hoverSchedule(e.clientX, e.clientY, preEl)');
  const throttle = h.indexOf('lastMoveAt < 150');
  assert.ok(pre > 0 && throttle > 0 && pre < throttle, '排程先于节流');
  assert.match(h, /if \(inactive\(\)\) \{ hoverCancel\(\); return; \}/, '换代早退清计时');
});

test('v247 dwell: slide-in dropped by the throttle still sets mouseInBar, so the dwell fires after freeze', () => {
  /* review MAJOR 复现链：条外采样残留 mouseInBar=false → <150ms 内快速滑入格子后彻底
   * 静止（本次事件被节流整段丢弃）→ 1 秒到点 hoverCheck 若被 !mouseInBar 硬门拦下
   * 就永不打开。节流前排程块必须在命中条内时补置 mouseInBar=true（与 fxTip/条内
   * 主路径同款），这里用真实 mousemove 处理器 + 真实 hover 链全串验证。 */
  const start = source.indexOf('listenGlobal(document, "mousemove"');
  const end = source.indexOf('}, true);', start);
  const handlerSource = source.slice(start, end + '}, true);'.length);
  const body = extract('    var HOVER_OPEN_DELAY_MS = 1000;', '    /* 隐藏总闸（v33.3）');
  let now = 100000, tid = 0;
  const timers = new Map();
  const cell = { __tip: 'tip', closest: () => null };
  const outside = { closest: () => null };
  const inBarNode = { closest: s => s === '.it' ? cell : null };
  let opened = 0;
  const ctx = {
    listenGlobal: (t, type, fn) => { if (type === 'mousemove') ctx.__handler = fn; },
    __handler: null,
    inactive: () => false,
    hitItemFor: () => cell,
    showTipFor: () => { opened++; },
    fxTip: { style: { display: 'none' }, contains: () => false },
    subPopOpen: () => false, subPopMode: 'closed', subPopSuppressAt: 0,
    subPopShow: () => {},
    cancelTipGrace: () => {}, subPopCancelHide: () => {}, subPopScheduleHide: () => {},
    tipStats: { mv: 0, corridor: 0, grace: 0 },
    lastMoveAt: now - 500,
    Date: { now: () => now },
    mouseInBar: false,   // 场景起点：条外采样的残留
    tipFor: null, tipSig: '', tipGraceTimer: 0, focusTipAt: 0,
    state: { tipClick: 0, theme: 'default' },
    panel: { classList: { contains: () => false } },
    bar: { contains: n => n === inBarNode },
    tip: { contains: () => false, style: { display: 'none' } },
    main: { querySelectorAll: () => [] },
    document: { querySelectorAll: () => [{ tagName: 'SPAN' }], elementFromPoint: () => inBarNode },
    hideTip: () => {}, drawTip: () => {},
    inTipCorridor: () => false, inTipColumn: () => false,
    setTimeout: (fn, ms) => { timers.set(++tid, { fn, ms }); return tid; },
    clearTimeout: n => timers.delete(n),
  };
  vm.runInNewContext(handlerSource + '\n' + body, vm.createContext(ctx));
  assert.ok(ctx.__handler);
  ctx.__handler({ target: outside, clientX: 0, clientY: 0 });   // 条外事件：真实走 left-bar
  assert.equal(ctx.mouseInBar, false, '前置：条外采样把 mouseInBar 打回 false');
  now += 100;   // <150ms：滑入事件的节流后段将被整段丢弃
  ctx.__handler({ target: inBarNode, clientX: 240, clientY: 300 });
  assert.equal(ctx.mouseInBar, true, '节流前排程块补置 mouseInBar（修复点，缺了它下一行必红）');
  assert.equal(timers.size, 1, '滑入事件仍完成停留排程');
  now += 1000;
  [...timers.values()][0].fn();   // 到点 hoverCheck：静止 1 秒后触发
  assert.equal(opened, 1, '静止 1 秒后停留打开，不被残留的 !mouseInBar 硬门拦下');
});

test('v247 dwell: hoverStillOn decision table (:hover chain, coords fallback, exception bail)', () => {
  /* review MAJOR（V6 漏网）：此前该判定表只有被 null 桩短路的空转用例，恒 true 变异全绿。
   * 这里切片真函数，逐格断言判定表。 */
  let chain = [], point = null, onBar = true, boom = false;
  const bodyNode = { tagName: 'BODY' }, htmlNode = { tagName: 'HTML' };
  const h = hoverChain({
    document: {
      querySelectorAll: () => { if (boom) throw new Error('qs failed'); return chain; },
      elementFromPoint: () => point,
      body: bodyNode, documentElement: htmlNode,
    },
    bar: { contains: n => n === point && onBar },
  });
  const f = h.api.hoverStillOn;
  chain = [{ tagName: 'SPAN' }];
  assert.equal(f(1, 2), true, ':hover 最深元素是页面元素即视为停留（本层不做格子级判别）');
  chain = [bodyNode];   // 真实 DOM 里截断到 body 时最后元素就是 document.body 本身（同引用）
  assert.equal(f(1, 2), false, '截断到 body（甩出窗口）且坐标兜底也判负 -> 停留失效');
  chain = [htmlNode];
  assert.equal(f(1, 2), false, '截断到 documentElement 同样兜底判负');
  chain = [{ tagName: 'IFRAME' }];
  assert.equal(f(1, 2), false, '进入 IFRAME 子文档同样兜底判负');
  chain = [];
  assert.equal(f(1, 2), false, '无 :hover 链且坐标兜底判负 -> 停留失效');
  chain = [];
  point = { id: 'live' };
  assert.equal(f(1, 2), true, ':hover 截断时按坐标兜底复核，仍在条上则停留');
  onBar = false;
  assert.equal(f(1, 2), false, '坐标兜底发现指针已不在条上 -> 停留失效');
  boom = true;
  assert.equal(f(1, 2), false, 'querySelectorAll 异常按失效处理（不悬挂在途计时）');
});

/* ---------- 5. 取消出口与 dispose ---------- */
test('v247 lifecycle: hideTip cancels pending dwell; focusin keeps instant keyboard open; dispose clears timer', () => {
  const hide = extract('    function hideTip(force, cause) {', '    function positionTip(');
  let cancels = 0;
  const ctx2 = {
    hoverCancel: () => { cancels++; }, clearTimeout: () => {},
    tipStats: { hides: 0 }, tip: { style: { display: 'none' } },
    tipFor: null, tipGraceTimer: 0, tipSig: '', hideFxTip: () => {},
    mouseInBar: false, api: null,
  };
  vm.runInNewContext(hide + '\napi = hideTip;', vm.createContext(ctx2));
  ctx2.api(true, 'left-bar');
  assert.equal(cancels, 1, '任何真实收起路径都作废在途计时');

  assert.match(source, /hoverCancel\(\);   \/\/ v247：键盘 Tab 是明确动作，即时打开/, 'focusin 仍能即时打开');
  assert.match(source, /hoverCancel\(\);   \/\/ v247：1 秒停留计时随实例销毁/, 'dispose 清计时器');
  assert.match(source, /if \(inactive\(\) \|\| !mouseInBar \|\| state\.tipClick\) return;/, '到点回调查代际/指针/模式');
});
