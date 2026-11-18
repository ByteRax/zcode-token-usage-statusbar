'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { readOverlayPart, sliceOverlay, readOverlaySource } = require('./helpers/overlay-extract.cjs');

// v384 速度 Tooltip V3 装配层（wire）：spd3RebuildOr 契约 + spdFitTip V3 分支 +
// 02 分片存活/V2 专属符号锁 + speed_days 粘性行为。V3 五分片（core/view/charts/
// heat/wire）整文进 VM；存活符号切片取自 overlay.js（边界对齐 overlay-speed-v3-core
// 等既有 V3 测试；`SPD_V2 尾块` = SPD_PORTAL/fitModelNames/spdFitTip，spdFitTip 已带
// V3 分支）。spd3RebuildOr 是 V3 的唯一集成入口：无轮表 → null（调用方回退 V1 旧卡），
// 有 → 闭包 (curHover, curSel) → "\x01"+整卡串。
const core = readOverlayPart('04-speed-v3-core.js');
const view = readOverlayPart('04-speed-v3-view.js');
const charts = readOverlayPart('04-speed-v3-charts.js');
const heat = readOverlayPart('04-speed-v3-heat.js');
const wire = readOverlayPart('04-speed-v3-wire.js');
const bands = sliceOverlay('  var TPS_BANDS = [', '  /* tooltip 颜色对照图例');
const spdHelpers = sliceOverlay('  var SPD_RANGES = [', '  var SPD_PORTAL = "";');
const v2Tail = sliceOverlay('  var SPD_PORTAL = "";', '  /* SPD_V2_BLOCK_END */');
const shard02 = readOverlayPart('02-store-bridge-and-speed-v2.js');

// 冻结时钟：spd3Analyze 的 today/week/month 窗与 month 日历都读 Date.now()（spec 同款
// 夹具纪律；真实 Date 是假绿灯）。
const FIXED_NOW = new Date(2026, 10, 5, 14, 0, 0).getTime();   // 2026-11-05 14:00 本地时
function makeCtx(fixed = FIXED_NOW, lang = 'zh') {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  }
  const ctx = vm.createContext({
    L: (zh, en) => (lang === 'en' ? en : zh),
    Date: FakeDate, Math, JSON, isFinite, parseInt, parseFloat, Object, Array, String, Number,
  });
  vm.runInContext(bands + '\n' + spdHelpers + '\n' + v2Tail + '\n' +
    core + '\n' + view + '\n' + charts + '\n' + heat + '\n' + wire, ctx);
  return ctx;
}

const HOUR = 3600000;
const KEYS = { a: 'prov_a\x1fglm-a', b: 'prov_b\x1fclaude-b' };
const host = x => JSON.parse(JSON.stringify(x));   // 跨沙箱对象先 JSON 往返再 deepEqual
const O = { fmtTok: String, fmtCnt: String, fmtMoney: u => '¥' + u.toFixed(2) };

// 主夹具：sess_main 三轮（100t/1s、混合轮 900t/3s、400t/8s）+ 他会话/他项目各一轮，
// msl 全四元组（模型级窗口齐全）。与 overlay-speed-v3-core.test.cjs 同构。
function fixture() {
  const d = (day, h) => new Date(2026, 10, day, h).getTime();
  const t0 = d(5, 9);
  const yester = d(4, 15);
  const lastMonth = d(9, 5, 10);
  const raw = [
    [0, lastMonth, lastMonth - 60000, 1000, 10000, 8000, 1000, 1, [[0, 1000, 10000, 1]], 0.1, 1],
    [1, yester, yester - 60000, 3000, 10000, 20000, 3000, 2, [[0, 3000, 10000, 2]], 0.3, 1],
    [0, t0, t0 - 60000, 100, 1000, 500, 100, 1, [[0, 100, 1000, 1]], 0.01, 1],
    [0, t0 + HOUR, t0 + HOUR - 60000, 900, 3000, 6000, 900, 2,
      [[0, 600, 2000, 1], [1, 300, 1000, 1]], 0.09, 1],
    [1, t0 + 2 * HOUR, t0 + 2 * HOUR - 60000, 400, 8000, 4000, 400, 1, [[1, 400, 8000, 1]], null, 0],
    [2, t0 + 3 * HOUR, t0 + 3 * HOUR - 60000, 500, 5000, 3000, 500, 1, [[0, 500, 5000, 1]], 0.05, 1],
  ];
  raw.sort((x, y) => x[1] - y[1]);
  let prev = 0;
  const turns = raw.map(r => {
    const o = { s: r[0], t: r[1] - prev, b: r[2], out: r[3], ms: r[4], i: r[5], o: r[6], n: r[7], msl: r[8] };
    prev = r[1];
    if (r[9] !== null) o.c = r[9];
    if (r[10]) o.cf = 1;
    return o;
  });
  return { sid: 'sess_main', source: 'local', truncated: false,
    sids: ['sess_main', 'sess_proj2', 'sess_other'],
    snames: ['本会话', '同项目另一会话', '别的项目'],
    pids: [['proj_a', '项目A'], ['proj_a', '项目A'], ['proj_b', '项目B']],
    mnames: ['GLM-A', 'Claude-B'], mkeys: [KEYS.a, KEYS.b], turns };
}

function rebuild(ctx, h, sel, hover, o, sess, sd) {
  ctx.__h = h === undefined ? null : h;
  ctx.__sd = sd === undefined ? null : sd;
  ctx.__sel = sel || { range: 'recent', period: 'recent', sid: 'sess_main' };
  ctx.__hi = typeof hover === 'number' ? hover : -1;
  ctx.__o = o || O;
  ctx.__sess = sess || { sid: 'sess_main' };
  return vm.runInContext('spd3RebuildOr(__h, __sd, __sel, __hi, null, __o, __sess)', ctx);
}
function cardOf(ctx, rb, curHover, curSel) {
  ctx.__rb = rb;
  ctx.__ch = typeof curHover === 'number' ? curHover : -1;
  ctx.__cs = curSel === undefined ? null : curSel;
  return vm.runInContext('__rb(__ch, __cs)', ctx);
}
const stripStyle = html => html.replace(/<style>[\s\S]*?<\/style>/g, '');

// ---------- ① wire 契约 ----------
test('spd3RebuildOr 契约: 无轮表→null；有轮表→闭包；闭包产物带 \x01 哨兵与 .zu-sv3-root', () => {
  const ctx = makeCtx();
  const sel = { range: 'session', period: 'all', sid: 'sess_main' };
  assert.equal(rebuild(ctx, null, sel), null, '无帧 → null（调用方回退 V1）');
  assert.equal(rebuild(ctx, { turns: [] }, sel), null, '空轮表 → null');
  // 含畸形轮（缺 t）的帧：unpack 整帧 fail-closed → 闭包返回 null → 调用方回退 V1
  // （产品裁定=严格 fail-closed：畸形 t 会让 delta 累加基准错位，不出错位统计的空态卡）
  const deadFrame = { sid: 'sess_main', source: 'local', truncated: false,
    sids: ['sess_main'], snames: ['S'], pids: [['p', 'P']], mnames: ['M'], turns: [{}] };
  const rbDead = rebuild(ctx, deadFrame, sel);
  assert.equal(typeof rbDead, 'function', '轮表长度守卫先过 → 返回闭包');
  assert.equal(cardOf(ctx, rbDead), null, '解包整帧拒绝 → 闭包返回 null（回退 V1）');
  // 鸭子类型轮表过守卫（'x'.length 是数字）但解包拒绝 → 闭包调用返回 null（不抛错）
  const rbDuck = rebuild(ctx, { turns: 'x' }, sel);
  assert.equal(typeof rbDuck, 'function', '长度型鸭子轮表过 null 守卫');
  assert.equal(cardOf(ctx, rbDuck), null, '解包拒绝 → 闭包返回 null');
  const rb = rebuild(ctx, fixture(), sel);
  assert.equal(typeof rb, 'function', '有轮表 → 返回闭包');
  const html = cardOf(ctx, rb);
  assert.equal(html.charCodeAt(0), 1, '整卡串以 \x01 结构化哨兵开头（消费方 slice(1)）');
  assert.ok(html.includes('class="zu-sv3-root"'), 'V3 卡根');
  assert.ok(stripStyle(html).includes('zu-sv-head'), 'V3 头部（范围/时间双 Tab）');
  assert.ok(html.includes('data-sv3-chart'), '图表占位容器（<!--CHART--> 已替换）');
  assert.ok(!html.includes('<!--CHART-->'), '占位符必须被图表产物替换（wire 装配职责）');
});

test('spd3RebuildOr: 闭包读显式 curHover/curSel；不传 curSel 回退外层 sel；缺 filt 默认 auto', () => {
  const ctx = makeCtx();
  const h = fixture();
  // 外层 sel=project/all：闭包不传 curSel 时沿用（sel 原地改属性后闭包立即生效的
  // V2 惯例由调用方保证——wire 只读传入对象）
  const sel = { range: 'project', period: 'all', sid: 'sess_main' };
  const rb = rebuild(ctx, h, sel);
  const html = cardOf(ctx, rb, -1, null);
  assert.match(html, /data-sv-group="range" data-sv-val="project" aria-pressed="true"/,
    '缺 curSel → 外层 sel 生效（project Tab 选中）');
  assert.match(html, /data-sv-key="project\|all\|auto"/, '卡根携带 range|period|筛选签名键');
  // 显式 curSel 覆盖外层 sel（悬停重编传当前选择包的 V3 契约）
  const html2 = cardOf(ctx, rb, -1, { range: 'all', period: 'month', sid: 'sess_main' });
  assert.match(html2, /data-sv-group="range" data-sv-val="all" aria-pressed="true"/);
  assert.match(html2, /zu3-hm-grid/, 'curSel.period=month 分发到月历热力');
  // curSel 缺 filt → spd3FilterAuto()（auto=全选，不伪装成显式空态）；计数行三语义
  // 统一（§11.5）：auto 时已选=池全量 2/2，本期有效=an.perModel.length=2
  const rb3 = rebuild(ctx, h, { range: 'session', period: 'all', sid: 'sess_main' });
  const html3 = cardOf(ctx, rb3, -1, { range: 'session', period: 'all', sid: 'sess_main' });
  assert.match(html3, /zu-sv3-fcount">已选 2\/2 · 本期有效 2</, '缺 filt → auto（计数=已选 2/2 · 本期有效 2）');
});

test('spd3RebuildOr: period 分发 recent/today/week→charts、month→月历、all→历史热力', () => {
  const ctx = makeCtx();
  const h = fixture();
  const disp = (period) => cardOf(ctx, rebuild(ctx, h, { range: 'all', period, sid: 'sess_main' }));
  const recent = stripStyle(disp('recent'));
  assert.match(recent, /zu-sv3-bars/, 'recent → 柱组');
  assert.match(recent, /zu-sc-col/, 'recent → 柱列');
  assert.doesNotMatch(recent, /zu3-hm-grid|zu3-hh-grid/, 'recent 不出热力');
  const today = stripStyle(disp('today'));
  assert.ok(/zu-sv3-svg|zu-sv3-bars/.test(today), 'today → 小时柱/折线形态');
  assert.match(today, /zu-sc-head/, 'today 共享图表标题栏');
  const week = stripStyle(disp('week'));
  assert.match(week, /zu-sv3-svg/, 'week → SVG 折线');
  assert.match(week, /zu-sv3-hit/, 'week 命中列');
  const month = stripStyle(disp('month'));
  assert.match(month, /zu3-hm-grid/, 'month → 月历热力网格');
  assert.match(month, /role="grid"/, 'month grid role');
  const all = stripStyle(disp('all'));
  assert.match(all, /zu3-hh-grid/, 'all → 历史热力网格');
  assert.match(all, /zu3-hh-wds/, 'all 行首星期列');
});

test('spd3RebuildOr: sel.filt=显式筛选时 SPD3_POOL 侧信道=未筛选池（「全选」依赖）', () => {
  const ctx = makeCtx();
  const h = fixture();
  const sel = { range: 'session', period: 'all', sid: 'sess_main',
    filt: { mode: 'sel', keys: [KEYS.b] } };
  const rb = rebuild(ctx, h, sel);
  const html = cardOf(ctx, rb, -1, sel);
  assert.match(html, /已选 1\/2/, '卡面筛选计数=已选 1/2');
  const pool = host(vm.runInContext('SPD3_POOL', ctx));
  assert.equal(pool.length, 2, 'SPD3_POOL=未筛选全量池（chips/弹出层可点回被筛掉模型）');
  assert.deepEqual(pool.map(m => m.key).sort(), [KEYS.a, KEYS.b].sort());
  // auto（默认）时池=筛选后池，同样是全量 2 个
  const sel2 = { range: 'session', period: 'all', sid: 'sess_main' };
  cardOf(ctx, rebuild(ctx, h, sel2), -1, sel2);
  assert.equal(host(vm.runInContext('SPD3_POOL', ctx)).length, 2, 'auto 池=全量');
});

// ---------- ①b 全选行为锁（B2）：data-sv3-all 取 SPD3_POOL key 串 ----------
test('全选行为锁: spd3FilterOnly 收到 key 字符串数组，签名不坍缩成 [object Object]', () => {
  const ctx = makeCtx();
  const sel = { range: 'session', period: 'all', sid: 'sess_main',
    filt: { mode: 'sel', keys: [KEYS.b] } };
  cardOf(ctx, rebuild(ctx, fixture(), sel), -1, sel);   // 重建一次 → SPD3_POOL=未筛选池
  // 行为级：复刻 06/01 委托同款取键路径（SPD3_POOL.map(m => m.key) → spd3FilterOnly），
  // 红队实测：对象直传会被 String() 成 "[object Object]"，全选退化成清空且签名坍缩
  const r = vm.runInContext(`(function () {
    var f = { mode: "sel", keys: [] };
    spd3FilterOnly(f, (typeof SPD3_POOL !== "undefined" && SPD3_POOL || []).map(function (pm) { return pm.key; }));
    return { keys: f.keys, sig: spd3FilterSig(f),
      allStrings: f.keys.every(function (k) { return typeof k === "string" && k.indexOf("[object") < 0; }) };
  })()`, ctx);
  assert.equal(r.allStrings, true, 'keys 全为身份键字符串');
  assert.deepEqual(host(r.keys).slice().sort(), [KEYS.a, KEYS.b].sort(), '全选=池内全部模型 key');
  assert.ok(!r.sig.includes('[object Object]'), '签名不坍缩');
  assert.equal(r.sig, 'sel:' + [KEYS.a, KEYS.b].slice().sort().join('\x1e'), '签名=排序 key 集合');
  // 源码锁：06/01 两处委托都取 key 串，直传对象数组不得回潮
  const src = readOverlaySource();
  const direct = (src.match(/spd3FilterOnly\([a-zA-Z3]*\.filt, *\(?\s*typeof SPD3_POOL/g) || []).length;
  const good = (src.match(/spd3FilterOnly\([a-zA-Z3]*\.filt, \(typeof SPD3_POOL !== "undefined" && SPD3_POOL \|\| \[\]\)\.map\(function \(pm\) \{ return pm\.key; \}\)/g) || []).length;
  assert.ok(direct >= 2 && direct === good, 'SPD3_POOL 进 spd3FilterOnly 必经 .map 取 key 串（'
    + good + '/' + direct + '）');
});

// ---------- ② spdFitTip V3 分支 ----------
function fitTipStub(opts = {}) {
  const props = {};
  const canRemove = opts.noRemoveProperty ? false : true;
  const style = {
    _p: props,
    setProperty(k, v) { props[k] = v; },
    ...(canRemove ? { removeProperty(k) { delete props[k]; } } : {}),
  };
  const root = { style: {}, getBoundingClientRect: () => ({ width: 920 }) };
  const tip = {
    offsetWidth: 960,
    __zuSpeedSize: 'stale',
    style,
    classList: { add() {}, remove() {} },
    querySelector: s => (s === '.zu-sv3-root' && !opts.legacyOnly ? root
      : s === '.zu-sv-root' && opts.legacyRoot ? opts.legacyRoot : null),
    getBoundingClientRect: () => ({ width: 960, height: 480 }),
  };
  return { tip, root, props };
}

test('spdFitTip V3 分支: .zu-sv3-root 在场清 zoom、钳视口 maxWidth/maxHeight、清 V2 遗留变量', () => {
  const ctx = makeCtx();
  ctx.window = { innerWidth: 1100, innerHeight: 700 };
  const st = fitTipStub();
  ctx.__tip = st.tip;
  vm.runInContext('spdFitTip(__tip, true)', ctx);
  assert.equal(st.root.style.zoom, '', 'V3 卡不吃 zoom（缩放交 --ui-font-size）');
  assert.equal(st.root.style.maxWidth, '1076px', 'maxWidth=视口-24');
  assert.equal(st.root.style.maxHeight, '684px', 'maxHeight=视口-16');
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.__tip.__zuSpeedSize)),
    { w: 0, h: 0, left: 0, vw: 1100, vh: 700, font: 0 }, '__zuSpeedSize 重置为视口探针');
  assert.ok(!('--zu-sv-width' in st.props) && !('--zu-sv-height' in st.props) &&
    !('--zu-sv-left-width' in st.props), 'V2 遗留 CSS 变量被清除');
  // 视口变化跟随
  ctx.window.innerWidth = 500; ctx.window.innerHeight = 320;
  vm.runInContext('spdFitTip(__tip, false)', ctx);
  assert.equal(st.root.style.maxWidth, '476px');
  assert.equal(st.root.style.maxHeight, '304px');
  // 非 V3 卡（无卡/仅旧卡无测量面）：不再量 V2 布局，__zuSpeedSize 置 null
  const legacy = fitTipStub({ legacyOnly: true });
  ctx.__tip = legacy.tip;
  legacy.props['--zu-sv-width'] = '760px';
  vm.runInContext('spdFitTip(__tip, true)', ctx);
  assert.equal(ctx.__tip.__zuSpeedSize, null, '无 V3 卡 → 测量缓存清空');
  assert.ok(!('--zu-sv-width' in legacy.props), 'V2 变量同样清除');
});

test('spdFitTip V3 分支: VM 桩 style 无 removeProperty 不炸（project-tip 夹具同款坑）', () => {
  const ctx = makeCtx();
  ctx.window = { innerWidth: 1100, innerHeight: 700 };
  const st = fitTipStub({ noRemoveProperty: true });
  ctx.__tip = st.tip;
  assert.doesNotThrow(() => vm.runInContext('spdFitTip(__tip, true)', ctx),
    'style 桩缺 removeProperty 必须被 typeof 守卫放行');
  assert.equal(st.root.style.maxWidth, '1076px', '守卫不影响 V3 兜底赋值');
});

// ---------- ③ 02 分片存活/V2 专属符号锁 ----------
test('02 分片符号锁: V3 依赖的存活符号仍在；V2 专属函数定义不复活（防回潮）', () => {
  // 存活（V3 与精简 chip/旧快照回退共用）
  for (const sym of ['var TPS_BANDS = [', 'function tpsBand(', 'function tpsBandText(',
    'function speedCardHTML(', 'function speedChartHTML(', 'function speedSegsOf(',
    'var SPD_RANGES = [', 'var SPD_PERIODS = [', 'var SPD_BARS_MAX = 18;',
    'function spdEsc(', 'function spdNum(', 'function spdDate(', 'function spdFull(',
    'function spdShort(', 'function spdRangeText(', 'function spdRangeFull(',
    'function spdBucket(', 'function spdNextBucket(', 'function spdLabel(',
    'function spdCompactRange(', 'var SPD_PORTAL = "";', 'function fitModelNames(',
    'function spdFitTip(', '/* SPD_V2_BLOCK_END */']) {
    assert.ok(shard02.includes(sym), '02 分片存活符号: ' + sym);
  }
  // V2 专属函数定义必须保持删除（按定义形态匹配，注释里的历史名称不算回潮）
  for (const gone of ['function spdAnalyze(', 'function speedCardV2HTML(',
    'function spdRebuildOr(', 'function spdChartHTML(', 'function spdChartFor(',
    'function spdCardHTML(', 'function spdLeftHTML(', 'function spdHeadHTML(',
    'function spdTabRow(', 'function spdChartLayout(', 'function spdMonthHeatmapHTML(',
    'function spdHistoryHeatmapHTML(', 'function spdDayCardHTML(']) {
    assert.ok(!shard02.includes(gone), '02 分片 V2 专属符号已删: ' + gone);
  }
  // overlay.js 全文同样不得复活 V2 整卡入口（V3 已是唯一重建链）
  const built = readOverlaySource();
  for (const gone of ['function speedCardV2HTML(', 'function spdRebuildOr(']) {
    assert.ok(!built.includes(gone), 'overlay.js V2 专属符号已删: ' + gone);
  }
});

// ---------- ④ speed_days 粘性（v384，__zusageSpdDaysSticky） ----------
// 切片同 overlay-speed-v255.test.cjs 的 stickyCtx（00 分片 __zusageUpdate 全函数），
// 额外声明 mobileMode/lastSpeedDays 供 v384 分支与移动帧用例注入。
function stickyCtx(mobile = false) {
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(
    'var state={data:null},instances=[],lastSpeedHistory=null,lastSpeedDays=null,FATAL={};' +
      'var mobileMode=' + mobile + ',mobileBinding="";' +
      'function stale(){return false}' +
      'function mobileContext(){return{taskId:"",binding:"",scopeKind:""}}' +
      sliceOverlay('  window.__zusageUpdate = function (d) {',
        '  window.__zusagePluginRequests = [];') +
      'var remoteTodayCache={},remoteCache={};',
    ctx,
  );
  return ctx;
}
const sdFrame = n => ({ v: 1, source: 'local', start: FIXED_NOW - n * 864e5,
  days: [[100, 1000, 1, 1, 0, []]], mnames: ['M'], truncated: 0 });
const hFrame = n => ({ sid: 's', source: 'local', truncated: false, sids: ['s'],
  snames: ['S'], pids: [['p', 'P']], mnames: ['M'],
  turns: Array.from({ length: n }, (_, i) => ({ s: 0, t: 60000, b: 1, out: 10, ms: 100, i: 1, o: 10, n: 1, msl: [[0, 10]] })) });

test('speed_days 粘性: 逐帧独立——全量帧也捕获；缺帧回填；空 days 不粘（M3/S10 修复语义）', () => {
  const ctx = stickyCtx();
  const sd1 = sdFrame(10), sd2 = sdFrame(20), h = hFrame(1);
  // 全量帧（轮表在场）：sd 粘性逐帧独立执行，全量帧同样捕获 + 写 window
  // （原实现挂在缺轮表分支，正常帧恒有轮表 → 捕获死代码化，已修）
  ctx.window.__zusageUpdate({ session: { sid: 's' }, speed_history: h, speed_days: sd1 });
  assert.equal(ctx.state.data.speed_days, sd1, '新帧有 speed_days → 直通');
  assert.equal(ctx.window.__zusageSpdDaysSticky, sd1, '全量帧同样写 sd 粘性（逐帧独立）');
  assert.equal(ctx.window.__zusageSpdSticky, h, '轮表粘性照常捕获');
  // 缺轮表帧 + sd 有值：sd 粘性更新 + 轮表回填
  ctx.window.__zusageUpdate({ session: { sid: 's' }, speed_days: sd2 });
  assert.equal(ctx.state.data.speed_days, sd2, '直通');
  assert.equal(ctx.window.__zusageSpdDaysSticky, sd2, '写入 window 粘性（跨代际）');
  assert.equal(ctx.state.data.speed_history, h, '缺轮表回填（v255 语义不变）');
  assert.equal(ctx.FATAL.spdFrame.sticky, 1, '粘性补帧记入帧级诊断');
  // 全缺帧（serve 重启窗口）→ 双帧各自回填
  ctx.window.__zusageUpdate({ session: { sid: 's' } });
  assert.equal(ctx.state.data.speed_days, sd2, '缺帧回填 speed_days');
  assert.equal(ctx.state.data.speed_history, h, '缺帧回填轮表');
  // 新 sd 帧覆盖旧粘性（不陈旧）
  const sd3 = sdFrame(30);
  ctx.window.__zusageUpdate({ session: { sid: 's' }, speed_days: sd3 });
  assert.equal(ctx.window.__zusageSpdDaysSticky, sd3);
  // 空 days 不粘性（不把「无数据」冒充历史），粘性保持上一份
  ctx.window.__zusageUpdate({ session: { sid: 's' }, speed_days: { v: 1, days: [] } });
  ctx.window.__zusageUpdate({ session: { sid: 's' } });
  assert.equal(ctx.state.data.speed_days, sd3, '空 days 帧不覆盖粘性');
});

test('speed_days 粘性: 移动帧不粘不回填（mobileMode 守卫）', () => {
  const ctx = stickyCtx(true);
  const sd = sdFrame(5);
  ctx.window.__zusageUpdate({ session: { sid: 's' }, speed_history: hFrame(1), speed_days: sd });
  assert.equal(ctx.window.__zusageSpdDaysSticky, undefined, '移动帧不写粘性');
  assert.equal(ctx.window.__zusageSpdSticky, undefined, '移动帧不写轮表粘性');
  ctx.window.__zusageUpdate({ session: { sid: 's' } });
  assert.equal(ctx.state.data.speed_days, undefined, '移动缺帧不回填');
  assert.equal(ctx.state.data.speed_history, undefined, '移动缺帧不回填轮表');
});

// ---------- ⑤ 粘性接线源锁（v268 四消费点，v384 起 spd3RebuildOr + speed_days 并行） ----------
test('粘性接线: window 级初始化/写回与 spd3RebuildOr/speed_days 兜底在场（v268/v384）', () => {
  const src = readOverlaySource();
  assert.match(src, /var lastSpeedHistory = \(typeof window !== "undefined" && window\.__zusageSpdSticky\) \|\| null;/);
  assert.match(src, /var lastSpeedDays = \(typeof window !== "undefined" && window\.__zusageSpdDaysSticky\) \|\| null;/,
    'v384 speed_days 粘性初始化');
  assert.match(src, /try \{ window\.__zusageSpdSticky = lastSpeedHistory; \} catch \(_\) \{ \}/);
  assert.match(src, /try \{ window\.__zusageSpdDaysSticky = lastSpeedDays; \} catch \(_\) \{ \}/,
    'speed_days 写回 window');
  // 消费点全部粘性兜底（buildLiveTip v2h/v2sd、html(d)、tpsTip 数据包、精简 chip）
  assert.match(src, /spd3RebuildOr\(d\.speed_history \|\|\n\s*\(typeof lastSpeedHistory !== "undefined" && lastSpeedHistory\),\n\s*d\.speed_days \|\| \(typeof lastSpeedDays !== "undefined" && lastSpeedDays\) \|\| null,/,
    'html(d) 消费点双帧兜底');
  assert.ok((src.match(/typeof lastSpeedHistory !== "undefined" && lastSpeedHistory/g) || []).length >= 3,
    '轮表消费点 typeof 守卫（v269 纪律）');
  assert.ok((src.match(/typeof lastSpeedDays !== "undefined" && lastSpeedDays/g) || []).length >= 3,
    'speed_days 消费点 typeof 守卫');
});
