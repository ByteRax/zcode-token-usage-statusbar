'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');
const { readOverlayPart, sliceOverlay } = require('./helpers/overlay-extract.cjs');

// v384 速度 Tooltip V3 图表分片：04-speed-v3-core.js（数据上游）+ 04-speed-v3-charts.js
// 全文进 VM，行为级验证三形态（recent 柱 / today 小时桶 / week 日折线）与 SPD_PORTAL
// 悬停卡侧信道。图表头 spd3ChartHeadHTML 属 view 分片（并行开发中），这里用桩替身；
// SPD_PORTAL 由桩声明（分片只赋值不声明，与集成时 02 分片一致）。
const core = readOverlayPart('04-speed-v3-core.js');
const charts = readOverlayPart('04-speed-v3-charts.js');
const bands = sliceOverlay('  var TPS_BANDS = [', '  /* tooltip 颜色对照图例');
const spdHelpers = sliceOverlay('  var SPD_RANGES = [', '  var SPD_PORTAL = "";');
const spdCompact = sliceOverlay('  function spdCompactRange(a, b) {', '  var SPD_PORTAL = "";');
// 桩带 data-head-sub 透传（v388 §12.5 week 覆盖提示走 head sub，测试可断言文案）
const VIEW_STUB = 'function spd3ChartHeadHTML(an,sub){return "<div class=\\"zu-sc-head\\" data-head-sub=\\""+String(sub==null?"":sub)+"\\">"+an.title+"</div";}';
const PORTAL_STUB = 'var SPD_PORTAL = "";';

// 冻结时钟：week 的 7 日本地日轴与 today 的小时桶都读 Date.now()，夹具必须钉死同一
// 时刻（2026-11-05 14:00 本地时，与 core 测试同点）。
const FIXED_NOW = new Date(2026, 10, 5, 14, 0, 0).getTime();
function makeCtx(lang = 'zh') {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [FIXED_NOW])); }
    static now() { return FIXED_NOW; }
  }
  const ctx = vm.createContext({
    L: (zh, en) => (lang === 'en' ? en : zh),
    Date: FakeDate, Math, JSON, isFinite, parseInt, parseFloat, Object, Array, String, Number,
  });
  vm.runInContext(bands + '\n' + spdHelpers + '\n' + spdCompact + '\n' + VIEW_STUB + '\n' +
    PORTAL_STUB + '\n' + core + '\n' + charts, ctx);
  return ctx;
}

const HOUR = 3600000;
// 键对经 FNV-1a 落不同调色板色（#f472b6 / #fbbf24），折线颜色断言才可区分两条线
const KEYS = { a: 'pa\x1fglm-a', b: 'pb\x1fclaude-b' };
const FMTS = { fmtTok: v => String(v), fmtCnt: v => String(v), fmtMoney: u => '¥' + u.toFixed(2) };
// VM 沙箱内对象与宿主原型不同，deepEqual 前先 JSON 往返成宿主对象
const host = x => JSON.parse(JSON.stringify(x));
// 剥掉头部 <style> 段再数类名：CSS 文本里的选择器与 DOM 类名互相污染会假计数
const domOf = html => html.slice(html.indexOf('</style>') + '</style>'.length);

function analyze(ctx, h, sel) {
  ctx.__h = h; ctx.__s = sel || {};
  return vm.runInContext('spd3Analyze(__h, null, __s)', ctx);
}
function chart(ctx, an, hoverIdx, o) {
  ctx.__an = an; ctx.__hi = hoverIdx === undefined ? -1 : hoverIdx; ctx.__o = o || FMTS;
  return vm.runInContext('spd3ChartHTML(__an, __hi, __o)', ctx);
}
function portal(ctx) { return vm.runInContext('SPD_PORTAL', ctx); }
function colorOf(ctx, key) {
  return vm.runInContext('spd3Color(' + JSON.stringify(key) + ')', ctx);
}
// 列切片：.zu-sc-col 内无嵌套 div，首个 </div> 即列尾
const colRe = /<div class="zu-sc-col[\s\S]*?<\/div>/g;
const colsOf = html => html.match(colRe) || [];

// 主夹具（与 core 测试同构）：3 会话 / 2 项目 / 跨日跨月；msl 全四元组。
function fixture() {
  const d = (day, h) => new Date(2026, 10, day, h).getTime();
  const t0 = d(5, 9);
  const yester = d(4, 15);
  const lastMonth = d(4, 10);
  const raw = [
    [0, lastMonth, lastMonth - 60000, 1000, 10000, 8000, 1000, 1, [[0, 1000, 10000, 1]], 0.1, 1],
    [1, yester, yester - 60000, 3000, 10000, 20000, 3000, 2, [[0, 3000, 10000, 2]], 0.3, 1],
    [0, t0, t0 - 60000, 100, 1000, 500, 100, 1, [[0, 100, 1000, 1]], 0.01, 1],            // 100 t/s
    [0, t0 + HOUR, t0 + HOUR - 60000, 900, 3000, 6000, 900, 2,
      [[0, 600, 2000, 1], [1, 300, 1000, 1]], 0.09, 1],                                    // 混合轮 300 t/s
    [1, t0 + 2 * HOUR, t0 + 2 * HOUR - 60000, 400, 8000, 4000, 400, 1, [[1, 400, 8000, 1]], null, 0], // 50 t/s 费用缺失
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

// 旧代夹具：msl 二元组（无模型级窗口，msAvail=false 降级模式），含一轮混合
function fixtureLegacyMixed() {
  const abs = new Date(2026, 10, 5, 9).getTime();
  return { sid: 's', source: 'local', truncated: false, sids: ['s'], snames: ['S'],
    pids: [['p', 'P']], mnames: ['GLM-A', 'Claude-B'], mkeys: [KEYS.a, KEYS.b],
    turns: [{ s: 0, t: abs, b: abs - 60000, out: 500, ms: 4000, i: 160, o: 500, n: 2,
      msl: [[0, 100], [1, 400]], c: 0.02, cf: 1 }] };
}

// 18 轮单模型夹具（数值稀疏化用）
function fixture18() {
  const t0 = new Date(2026, 10, 5, 8).getTime();
  let prev = 0;
  const turns = [];
  for (let i = 0; i < 18; i++) {
    const abs = t0 + i * 60000;
    turns.push({ s: 0, t: abs - prev, b: abs - 30000, out: 100 + i, ms: 1000, i: 80, o: 100,
      n: 1, msl: [[0, 100 + i, 1000, 1]], c: 0.01, cf: 1 });
    prev = abs;
  }
  return { sid: 's', source: 'local', truncated: false, sids: ['s'], snames: ['S'],
    pids: [['p', 'P']], mnames: ['GLM-A'], mkeys: [KEYS.a], turns };
}

// 转义夹具：模型名带 HTML/引号，无 mkeys（按名称退化身份）
function fixtureEvil() {
  const abs = new Date(2026, 10, 5, 9).getTime();
  return { sid: 's', source: 'local', truncated: false, sids: ['s'], snames: ['S'],
    pids: [['p', 'P']], mnames: ['<img src=x onerror=alert(1)>', 'B"b'],
    turns: [
      { s: 0, t: abs, b: abs - 60000, out: 100, ms: 1000, i: 80, o: 100, n: 1,
        msl: [[0, 100, 1000, 1]], c: 0.01, cf: 1 },
      { s: 0, t: HOUR, b: abs + HOUR - 60000, out: 300, ms: 3000, i: 80, o: 300, n: 2,
        msl: [[0, 100, 1000, 1], [1, 200, 2000, 1]], c: 0.02, cf: 1 },
    ] };
}

// ---------- ① Y 轴整洁刻度阶梯 ----------
test('spd3Ticks: 216 手算对照 V2 阶梯（yMax 250/step 50）；0 退化不炸；空数据走空态', () => {
  const ctx = makeCtx();
  const t = host(vm.runInContext('spd3Ticks(216)', ctx));
  // 手算：need=216×1.12=241.92 → K=1 档 st=50：×4=200 不足、×5=250 达标
  assert.deepEqual(t, { yMax: 250, step: 50, ticks: [0, 50, 100, 150, 200, 250] });
  const t2 = host(vm.runInContext('spd3Ticks(0)', ctx));
  assert.equal(t2.yMax, 4);
  assert.equal(t2.step, 1);
  assert.deepEqual(t2.ticks, [0, 1, 2, 3, 4]);
  // maxV=0 的图（无有效桶）→ 空态而非 0 轴假图
  const anE = analyze(ctx, fixture(), { range: 'session', period: 'today', sid: 'sess_main',
    filt: { mode: 'sel', keys: [] } });
  const htmlE = chart(ctx, anE, -1);
  assert.match(htmlE, /当前筛选无有效速度数据/);
  assert.ok(!htmlE.includes('zu-sc-bar'), '空态无柱');
  assert.equal(htmlE.indexOf('<style>'), -1, '空态不携带图表样式段');
  assert.equal(portal(ctx), '', '空态侧信道清空');
  // 未知 period（month/all 归 heat 分片）→ 空串显性暴露错接线
  ctx.__an2 = { period: 'month', items: [], perModel: [], real: [] };
  assert.equal(vm.runInContext('spd3ChartHTML(__an2, -1, __o)', ctx), '');
});

// ---------- ② recent 柱色规则 ----------
test('recent 柱色: 单模型行=模型色内联 background；混合行=.zu-sv3-mix 无模型色内联+title/aria 标混合', () => {
  const ctx = makeCtx();
  const an = analyze(ctx, fixture(), { range: 'session', period: 'recent', sid: 'sess_main' });
  assert.equal(an.items.length, 3, 'sess_main 三轮：A、A、混合（夹具首轮 11-04 已入会话池）');
  const html = chart(ctx, an, -1);
  const cols = colsOf(html);
  assert.equal(cols.length, 3);
  const colorA = colorOf(ctx, KEYS.a);
  // 柱 0/1：单模型 GLM-A → 内联 style background=模型色
  assert.match(cols[0], /style="height:[\d.]+%;background:#[0-9a-f]{6}"/);
  assert.ok(cols[0].includes('background:' + colorA), '单模型柱色=spd3Color(key)');
  assert.match(cols[0], /aria-label="10:00，100\.0 t\/s，GLM-A"/);
  assert.ok(!cols[0].includes('zu-sv3-mix'));
  assert.ok(cols[1].includes('background:' + colorA));
  // 柱 2：混合轮 → 中性灰类、无内联模型色、title 与 aria 都标「混合」
  assert.match(cols[2], /zu-sv3-mix/);
  assert.ok(!/background:#/.test(cols[2].split('class="zu-sc-bar')[1]), '混合柱无模型色内联');
  assert.match(cols[2], /title="混合（2 种模型）"/);
  assert.match(cols[2], /aria-label="10:00，300\.0 t\/s，混合"/);
  // 混合灰来自 CSS 类（不在内联 style 里），样式段含规则
  assert.match(html, /\.zu-sv3-chart \.zu-sc-bar\.zu-sv3-mix\{background:var\(--color-tooltip-tag-foreground/);
  // 最新柱（最右）latest 描边类
  assert.match(cols[2], /latest/);
  // CSS/包裹结构：样式段恰一次且在产物头部
  assert.equal(html.indexOf('<style>'), 0);
  assert.equal((html.match(/<style>/g) || []).length, 1);
  assert.match(html, /<div class="zu-speed-chart zu-sv3-chart">/);
  assert.match(html, /zu-sc-wrap"[^]*zu-sc-plot/);
});

// ---------- ③ recent 数值稀疏（§11.2 槽位满幅 + 估宽让位） ----------
test('recent 数值稀疏: n=18 恒显集=峰值/最低/最新（估宽让位）、悬停柱强制显示、槽位 flex 满幅', () => {
  const ctx = makeCtx();
  const an = analyze(ctx, fixture18(), { range: 'session', period: 'recent', sid: 's' });
  assert.equal(an.items.length, 18);
  const html = chart(ctx, an, -1);
  // 槽位满幅（§11.2）：每柱 .zu-sv3-slot 与 .zu-sc-col 共存；柱组 flex 平铺 CSS 在场；
  // 无 spacer/min-width 撑宽路径
  assert.equal((html.match(/zu-sv3-slot"/g) || []).length, 18, '每柱一槽（zu-sv3-slot 与 zu-sc-col 共存）');
  assert.match(html, /\.zu-sv3-bars\{position:absolute;inset:0;display:flex;width:100%;padding:0 5px;box-sizing:border-box\}/,
    '柱组 100% flex 平铺');
  assert.match(html, /\.zu-sv3-bars \.zu-sc-col\{flex:1 1 0;min-width:0;height:100%;position:relative\}/,
    '槽 flex:1 1 0 满幅均摊');
  assert.doesNotMatch(html, /zu-sv3-spacer|justify-content:flex-start/, 'spacer/挤左路径已删除');
  // 数值稀疏（§15.5）：n=18∈13–24 档全试显、估宽 5 字符×6+8=38px > 槽宽 620/18≈34.4px
  // → 非关键位全部让位；恒显集=峰值(17)/最低(0)/最新(17) → 恰 2 柱带读数
  const shown = (html.match(/zu-sc-val[^>"]*">[0-9]/g) || []).length;
  assert.equal(shown, 2, '恒显集=峰值/最低/最新（0 与 17）→ 2 柱，得到 ' + shown);
  assert.match(colsOf(html)[0], /zu-sc-val[^>]*">100\.0</, '最低柱读数在场');
  assert.match(colsOf(html)[17], /zu-sc-val[^>]*">117\.0</, '最新=峰值柱读数在场');
  // 悬停非采样位柱：读数强制显示（其自身让位 estW 38>34.4 → 左右邻非关键标签临时隐藏）
  const html2 = chart(ctx, an, 2);
  const shown2 = (html2.match(/zu-sc-val[^>"]*">[0-9]/g) || []).length;
  assert.equal(shown2, 3);
  const cols2 = colsOf(html2);
  assert.match(cols2[2], /zu-sc-val">102\.0</, '悬停柱数值在场');
  assert.match(cols2[2], /class="zu-sc-col cur zu-sv3-slot"/, '悬停柱 cur 类');
  assert.ok(!/zu-sc-val[^>"]*">1/.test(cols2[1]), '非采样位且未悬停不显');
  // 一位小数纪律
  assert.ok(!/zu-sc-val[^>"]*">\d+\.\d{2,}/.test(html2));
});

// ---------- ③b 柱标三档确定性（§15.5） ----------
// n 轮单模型夹具：值 100+i 递增（min=0 / peak=latest=n-1）、ms=1000（hover 耗时行）
function fixtureN(n) {
  const t0 = new Date(2026, 10, 5, 8).getTime();
  let prev = 0;
  const turns = [];
  for (let i = 0; i < n; i++) {
    const abs = t0 + i * 60000;
    turns.push({ s: 0, t: abs - prev, b: abs - 30000, out: 100 + i, ms: 1000, i: 80, o: 100,
      n: 1, msl: [[0, 100 + i, 1000, 1]], c: 0.01, cf: 1 });
    prev = abs;
  }
  return { sid: 's', source: 'local', truncated: false, sids: ['s'], snames: ['S'],
    pids: [['p', 'P']], mnames: ['GLM-A'], mkeys: [KEYS.a], turns };
}
function shownIdx(cols) {
  const out = [];
  for (let i = 0; i < cols.length; i++) if (/zu-sc-val[^>"]*">[0-9]/.test(cols[i])) out.push(i);
  return out;
}
test('柱标三档确定性: n=12 全显 / n=24 让位仅关键位 / n=30 步长抽样+首末钉边 / 悬停邻抑制 / hover 耗时行', () => {
  const ctx = makeCtx();
  // 生产柱图槽位上限：recent 帽 18（SPD_BARS_MAX）、today 小时桶 24 → >24 档为防御
  // 规则，直接以构建器单测（items 与 spd3Aggregate 输出同构：v/empty/label/models）
  const mk = n => { const a = []; for (let i = 0; i < n; i++)
    a.push({ v: 100 + i, empty: false, label: String(i), a: 0, b: 0, models: [] }); return a; };
  const barCols = (items, hover) => { ctx.__bi = items; ctx.__bh = hover === undefined ? -1 : hover;
    return vm.runInContext('spd3BarCols(__bi, __bh, 200)', ctx); };
  // n=12（1–12 档）：estW "111.0"=38 ≤ 槽宽 620/12≈51.7 → 全部非空柱显值，无钉边类
  const cols12 = colsOf(barCols(mk(12)));
  assert.deepEqual(shownIdx(cols12), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 'n=12 全显');
  assert.ok(!/zu-sv3-vpin-/.test(cols12.join('')), '估宽足够不出钉边类');
  // n=1/2/7 小样本同档全显（少量柱合理居中由 spd3BarDensityStyle 既有锁承担）
  for (const k of [1, 2, 7]) {
    const got = shownIdx(colsOf(barCols(mk(k))));
    assert.deepEqual(got, Array.from({ length: k }, (_, i) => i), 'n=' + k + ' 全显');
  }
  // n=24（13–24 档）：estW 38 > 槽宽 25.8 → 非关键位全部让位，恒显={min 0, peak/latest 23}
  const cols24 = colsOf(barCols(mk(24)));
  assert.deepEqual(shownIdx(cols24), [0, 23], 'n=24 让位仅关键位');
  // n=30（>24 档）：slotW≈20.7、maxLblW=30 → step=ceil(38/20.7)=2 → 偶数位抽样显值
  // （不再叠加 fits 门槛），关键位 29（peak/latest）并入 → 显值=偶数位 ∪ {29}
  const cols30 = colsOf(barCols(mk(30)));
  const want30 = [];
  for (let i = 0; i < 30; i += 2) want30.push(i);
  if (!want30.includes(29)) want30.push(29);
  assert.deepEqual(shownIdx(cols30), want30, 'n=30 步长抽样+关键位');
  // 首末钉边（estW>slotW）：idx0 → vpin-l、idx29 → vpin-r（不越出 plot 触发横滚）
  assert.match(cols30[0], /zu-sv3-vpin-l/, '首柱标签钉左');
  assert.match(cols30[29], /zu-sv3-vpin-r/, '末柱标签钉右');
  // 悬停位自身让位 → 左右邻非关键标签临时隐藏（关键位不受抑制）。hover=3：
  // 非采样位（自身恒显、estW 38>20.7 让位）→ 偶数采样邻位 2/4 被抑制
  const got30h = shownIdx(colsOf(barCols(mk(30), 3)));
  assert.ok(!got30h.includes(2) && !got30h.includes(4), '悬停邻（2/4）非关键标签隐藏（真抑制）');
  assert.ok(got30h.includes(3), '悬停柱恒显');
  // 悬停空槽/0 值槽不抑制邻位（审查 MINOR-1：自身无读数无避让收益）
  const items30 = mk(30); items30[5] = { v: 0, empty: true, label: '5', a: 0, b: 0, models: [] };
  const base30 = shownIdx(colsOf(barCols(items30)));
  const got30e = shownIdx(colsOf(barCols(items30, 5)));
  assert.deepEqual(got30e, base30, '悬停空槽不抑制邻位（显隐集合与无悬停一致）');
  // n=90（防御档）：slotW≈6.9 → step=ceil(38/6.9)=6 → 采样位 {0,6,…,84}=15 + keep{89}=16
  const got90 = shownIdx(colsOf(barCols(mk(90))));
  assert.equal(got90.length, 16, 'n=90 步长 6 抽样+关键位 → 16 读数，实得 ' + got90.length);
  assert.ok(got90.every((v, i2) => i2 === 0 || v >= got90[i2 - 1]), 'n=90 显值位升序（确定性）');
  // spd3PlotEstW 视口分支（审查缺口 7）：window.innerWidth=560 → est=clamp(536-328)=208
  vm.runInContext('var window = { innerWidth: 560 }', ctx);
  const colsNw = colsOf(barCols(mk(16)));
  assert.deepEqual(shownIdx(colsNw), [0, 15], '560 窄窗（est 208/slotW 13）：仅关键位在场（peak=latest 同柱）');
  vm.runInContext('window = undefined', ctx);
  // hover 悬停卡：生成耗时行（ms=1000 → 「1.0秒」；时间/速度/Token/费用齐）
  const an12 = analyze(ctx, fixtureN(12), { range: 'session', period: 'recent', sid: 's' });
  chart(ctx, an12, 3);
  const portal12 = portal(ctx);
  assert.match(portal12, /生成耗时<\/span><b>1\.0秒</, 'hover 生成耗时行（§15.5）');
  assert.match(portal12, /时间</);
  assert.match(portal12, /速度</);
  assert.match(portal12, /Token 总消耗/);
  assert.match(portal12, /预估价格/);
  // 耗时行三态（审查缺口 3）：ms=0 整行省略绝不造 0；ms<100 显 <0.1秒；槽位卡同款在场
  assert.equal(vm.runInContext('spd3DurTxt(0)', ctx), '');
  assert.equal(vm.runInContext('spd3DurTxt(40)', ctx), '<0.1秒');
  assert.equal(vm.runInContext('spd3DurTxt(178000)', ctx), '2分58秒');
  assert.equal(vm.runInContext('spd3DurTxt(3725000)', ctx), '1时2分5秒');
  const anNoMs = JSON.parse(JSON.stringify(an12));
  anNoMs.real.forEach(r => { r.ms = 0; });
  anNoMs.items.forEach(it => { it.ms = 0; });
  chart(ctx, anNoMs, 2);
  assert.ok(!portal(ctx).includes('生成耗时'), 'ms=0 降级帧耗时行整行省略');
  // today 槽位卡（spd3SlotCardHTML，§15.5 两处同款之二）生成耗时行
  const anToday = analyze(ctx, fixture(), { range: 'all', period: 'today', sid: 'sess_main',
    filt: { mode: 'sel', keys: [KEYS.a] } });
  const hit = anToday.items.findIndex(it => !it.empty && it.ms > 0);
  assert.ok(hit >= 0, '夹具存在有 ms 的 today 桶');
  chart(ctx, anToday, hit);
  assert.match(portal(ctx), /生成耗时<\/span><b>[\d.]+秒</, 'today 槽位卡生成耗时行在场');
});

// ---------- ④ today 单模型柱 ----------
test('today 单模型: focus full 15 桶全铺、空桶无柱无读数、实桶柱高>0 且柱色=模型色、X 轴时分', () => {
  const ctx = makeCtx();
  const an = analyze(ctx, fixture(), { range: 'all', period: 'today', sid: 'sess_main',
    focus: 'full', filt: { mode: 'sel', keys: [KEYS.a] } });
  assert.equal(an.perModel.length, 1, '筛选后池内仅 GLM-A');
  assert.equal(an.items.length, 15, '00:00..14:00 全桶');
  const html = chart(ctx, an, -1);
  const cols = colsOf(html);
  assert.equal(cols.length, 15);
  // 空桶（00:00）：占位、无读数、柱高 0
  assert.match(cols[0], /empty/);
  assert.match(cols[0], /style="height:0%"/);
  assert.match(cols[0], /zu-sc-val"><\/span>/);
  assert.match(cols[0], /aria-label="00:00，无数据"/);
  // 实桶（09:00）：柱高>0、模型色、每柱恒显时分
  const colorA = colorOf(ctx, KEYS.a);
  assert.match(cols[9], /height:(?!0%)[\d.]+%/);
  assert.ok(cols[9].includes('background:' + colorA));
  assert.match(cols[9], /zu-sc-x"><b>09:00<\/b>/);
  assert.match(cols[9], /aria-label="09:00，100\.0 t\/s，GLM-A"/);
  // 最新柱：当前小时（14:00，空桶）挂 latest，描边被 empty 规则压制
  assert.match(cols[14], /latest/);
  assert.equal((html.match(/<style>/g) || []).length, 1);
});

// ---------- ⑤ today 多模型折线（§11.2 满幅：width/height=100% + 百分比 x/y） ----------
test('today 多模型折线: 每模型一条 lineg 分组线（data-m）、缺小时断线、点色正确、命中列数=当前小时+1、svg 满幅 % 坐标', () => {
  const ctx = makeCtx();
  const an = analyze(ctx, fixture(), { range: 'all', period: 'today', sid: 'sess_main' });
  assert.equal(an.perModel.length, 2);
  assert.ok(an.msAvail);
  assert.equal(an.items.length, 15, '4 个有效小时 > 聚焦阈值 → 00..14 全轴');
  const html = chart(ctx, an, -1);
  const dom = domOf(html);
  const colorA = colorOf(ctx, KEYS.a), colorB = colorOf(ctx, KEYS.b);
  // 两条模型实线（v389 §13.2 lineg 分组：线+点同组、data-m=模型身份键、模型色 stroke）、
  // 无总体虚线（总体线是近 7 天形态专属）
  assert.equal((dom.match(/<g class="zu-sv3-lineg zu-sv3-line" data-m="[^"]*" stroke="/g) || []).length, 2);
  assert.ok(dom.includes('data-m="' + KEYS.a + '"'), 'A 线携带 data-m 模型键');
  assert.ok(dom.includes('data-m="' + KEYS.b + '"'), 'B 线携带 data-m 模型键');
  assert.equal((dom.match(/zu-sv3-oline/g) || []).length, 0);
  // 相邻非空点一连、缺口断线不插值：A 在 9,10,12 有分量 → 9→10 一段（11 缺口、
  // 12 单点不成段）；B 在 10,11 连续 → 一段
  const segsOf = c => (dom.match(new RegExp('<g class="zu-sv3-lineg zu-sv3-line" data-m="[^"]*" stroke="' + c + '">([\\s\\S]*?)</g>')) || ['', ''])[1];
  const segA = segsOf(colorA), segB = segsOf(colorB);
  assert.equal((segA.match(/<line /g) || []).length, 1, 'A 线恰一段（9→10）');
  assert.equal((segB.match(/<line /g) || []).length, 1, 'B 线恰一段（10→11）');
  // 满幅几何（§11.2 + v389 §13.1）：svg width/height 均 "100%" 无 viewBox 缩放、
  // 分段 line x/y 全百分比（yPct=2+(1−v/yMax)×98，顶部余量 2%）、命中列 x/width/
  // height 均 %；X 标签带独立 xsvg（高 16 恒定，text y=11 恒贴 plot 底）
  assert.match(html, /<svg class="zu-sv3-svg" width="100%" height="100%">/);
  assert.doesNotMatch(html, /<svg class="zu-sv3-svg"[^>]*viewBox/, '主 svg 无 viewBox 缩放');
  assert.match(segA, /<line x1="[\d.]+%" y1="[\d.]+%" x2="[\d.]+%" y2="[\d.]+%"\/>/, '分段 line：x/y 全百分比');
  assert.match(html, /<rect class="zu-sv3-hit" data-i="0" x="0%" y="0" width="6\.667%" height="100%"/,
    '命中列 % 几何（15 桶 → 6.667%/格，高 100% 随弹性值区）');
  assert.match(html, /<svg class="zu-sv3-xsvg" width="100%" height="16">/, 'X 标签带独立 xsvg 16px（§13.1）');
  assert.match(html, /<text class="zu-sv3-xtxt" x="[\d.]+%" y="11">/, 'xsvg 标签 y=11 恒贴 plot 底');
  assert.match(html, /<line class="zu-sv3-xline" x1="[\d.]+%" x2="[\d.]+%" y1="0" y2="100%"\/>/,
    '十字参考线纵线 y2=100%（值区满高）');
  assert.doesNotMatch(html, /height="148"|height="216"/, '固定 148/216 高已随 §13.1 弹性化退役');
  // §12.5 多模型端数值标签默认不画（today/week 同款）：perModel=2 → 0 枚 elabel
  assert.equal((html.match(/class="zu-sv3-elabel/g) || []).length, 0, 'today 多模型端标签 0（§12.5）');
  // 数据点：A 3 个 + B 2 个 = 5，点色=模型色、cy 随值区百分比
  assert.equal((html.match(/<circle class="zu-sv3-pt"/g) || []).length, 5);
  assert.match(html, /<circle class="zu-sv3-pt" cx="[\d.]+%" cy="[\d.]+%" r="2\.5" fill="/,
    '数据点 cy 百分比化（§13.1）、半径恒 px');
  assert.ok(html.includes('fill="' + colorA + '"'));
  assert.ok(html.includes('fill="' + colorB + '"'));
  // 悬停命中列（每小时一条）+ 同组十字参考线
  assert.equal((html.match(/class="zu-sv3-hit" data-i="/g) || []).length, 15);
  assert.equal((html.match(/class="zu-sv3-xline"/g) || []).length, 15);
  // 命中列 aria：空小时无数据、实小时逐模型速度
  assert.match(html, /aria-label="00:00，无数据"/);
  assert.match(html, /aria-label="11:00，Claude-B 50\.0 t\/s"/);
  assert.match(html, /aria-label="10:00，GLM-A 300\.0 t\/s、Claude-B 300\.0 t\/s"/);
  // 未悬停：侧信道空
  assert.equal(portal(ctx), '');
});

// ---------- ⑥ week 单/多模型（§16.1 单模型恒柱状 + §13.1 百分比 x/y + §12.5 多模型端标签不画） ----------
test('week 单/多: 单=7 日槽柱状（空日空位、模型色柱、无折线/面积/端标签）；多=逐模型线+总体虚线+端标签不画；缺失日断线+空槽轻卡+覆盖提示', () => {
  const ctx = makeCtx();
  // 单模型：只看 A —— v392 §16.1 起恒柱状（与 today 单模型对称；恒折线在单有效日退化为孤点）
  const w1 = analyze(ctx, fixture(), { range: 'all', period: 'week', sid: 'sess_main',
    filt: { mode: 'sel', keys: [KEYS.a] } });
  assert.equal(w1.perModel.length, 1);
  const h1 = chart(ctx, w1, -1);
  const colorA = colorOf(ctx, KEYS.a);
  assert.match(h1, /<span class="zu-sv3-bars zu-sv3-w14"/, '单模型周视图=柱状（7 槽 → w14 密度档，§16.1）');
  assert.equal((h1.match(/class="zu-sc-col/g) || []).length, 7, '恒 7 个日槽列');
  assert.equal((h1.match(/class="zu-sc-col[^"]*empty/g) || []).length, 5, '5 个空日槽（10-30..11-03）');
  assert.equal((h1.match(/class="zu-sc-x"><b>/g) || []).length, 7, 'X 轴 7 个日标签（含无数据日）');
  assert.equal((h1.match(new RegExp('<i class="zu-sc-bar" style="height:[\\d.]+%;background:' + colorA, 'g')) || []).length, 2,
    '两个有效日（11-04/11-05）各一根模型色柱');
  assert.equal((h1.match(/<g class="zu-sv3-lineg/g) || []).length, 0, '单模型不出折线');
  assert.doesNotMatch(h1, /<svg class="zu-sv3-asvg"/, '单模型无面积载体元素（折线专属；类名在 CSS 常量中恒存在不能整串匹配）');
  assert.equal((domOf(h1).match(/zu-sv3-oline/g) || []).length, 0, '单模型无总体虚线');
  assert.equal((h1.match(/class="zu-sv3-elabel/g) || []).length, 0, '柱状无折线端标签（数值走柱标 zu-sc-val）');
  // 槽列 a11y 与 data-i（与 recent 柱同构，hover 委托统一）
  const w1cols = h1.match(/<div class="zu-sc-col[^>]*>/g) || [];
  assert.equal(w1cols.length, 7);
  for (const col of w1cols) {
    assert.match(col, /data-i="\d+"/);
    assert.match(col, /role="img"/);
    assert.match(col, /aria-label="[^"]+"/);
  }
  assert.match(h1, /aria-label="[^"]*10\/30[^"]*无数据/, '空日槽 aria 报无数据');
  assert.match(h1, /data-head-sub="有效 2\/7 天"/, '单模型柱状同款覆盖提示');
  // 多模型：全池
  const w2 = analyze(ctx, fixture(), { range: 'all', period: 'week', sid: 'sess_main' });
  const h2 = chart(ctx, w2, -1);
  // 分段线按「相邻非空点一连」产出：A 两日连续 → 1 条线；B 周内仅 11-05 一个真实
  // 点（11-04 轮全 A 输出、无 B 分量）→ 单点不成段（v389 点归组：B 组只有 circle 无 line）
  assert.equal((h2.match(/<g class="zu-sv3-lineg zu-sv3-line" data-m="[^"]*" stroke="/g) || []).length, 2, 'A/B 两条模型 lineg 组（v389 圆点归入线组）');
  const gB = h2.match(new RegExp('<g class="zu-sv3-lineg zu-sv3-line" data-m="' + KEYS.b + '"[^>]*>([\\s\\S]*?)</g>'));
  assert.ok(gB && gB[1].indexOf('<line ') < 0 && gB[1].indexOf('<circle') >= 0, 'B 单点不成段：组内只有圆点无分段线');
  const gA = h2.match(new RegExp('<g class="zu-sv3-lineg zu-sv3-line" data-m="' + KEYS.a + '"[^>]*>([\\s\\S]*?)</g>'));
  assert.ok(gA && (gA[1].match(/<line /g) || []).length === 1, 'A 模型线恰一段（11-04→11-05）');
  assert.equal((h2.match(/class="zu-sv3-lineg zu-sv3-line zu-sv3-nline zu-sv3-oline"/g) || []).length, 1, '总体虚线仅多模型在场（无 data-m 身份键）');
  const ptB = new RegExp('<circle class="zu-sv3-pt" cx="[\\d.]+%" cy="[\\d.]+%" r="2\\.5" fill="' + colorOf(ctx, KEYS.b) + '"');
  assert.match(h2, ptB, 'B 单点仍落真实数据点（cy 百分比）');
  // §12.5（新契约）：week 多模型端数值标签默认不画——多线右缘堆叠实测重叠，
  // 数值经悬停十字卡承载；单模型保留端标签（上方 h1 已断言 1 枚）
  const labelYs = [];
  const re = /<text class="zu-sv3-elabel[^"]*" x="99\.2%" y="([-\d.]+)%"/g;
  let m;
  while ((m = re.exec(h2)) !== null) labelYs.push(parseFloat(m[1]));
  assert.equal(labelYs.length, 0, '多模型端标签 0（§12.5：perModel>1 不画端数值标签）');
  assert.equal((h2.match(/class="zu-sv3-elabel/g) || []).length, 0, 'A/B/总体三线均无端标签');
  // 缺失日（10-31..11-03）无点：总点数 = A2 + B1 + 总体不加 = 3
  assert.equal((h2.match(/<circle class="zu-sv3-pt"/g) || []).length, 3);
  // 缺失日命中列可悬停且报无数据；v389 §13.2 空槽不再静默——出「无有效速度记录」轻卡
  assert.match(h2, /aria-label="10\/31，无数据"/);
  chart(ctx, w2, 0);
  const p0 = portal(ctx);
  assert.match(p0, /zu-sv-card/, '缺失日悬停出轻卡（§13.2）');
  assert.match(p0, /10\/30（周五） · 无有效速度记录/, '空槽轻卡标题=日期+周几');
  assert.match(p0, /区间[^]*2026\/10\/30 · 全天/, '已结束空日区间=全天（§11.5）');
  // §12.5 week 覆盖提示：有效 X/7 天（head sub，数据=7 日槽非空数）；fixture 周内
  // 仅 10-30..11-05 中 11-04/11-05 有数据 → 「有效 2/7 天」；X<7 才追加
  assert.match(h2, /data-head-sub="有效 2\/7 天"/, '覆盖提示=有效 2/7 天');
  assert.match(h1, /data-head-sub="有效 2\/7 天"/, '单模型同款覆盖提示');
});

// ---------- ⑥b v388 §12.3/§12.5：plot 自适应宽 + 柱组密度分档 + 覆盖提示满档 ----------
// 近 7 天每天一轮单模型夹具（覆盖提示满档：X=7 不追加）
function fixtureWeek7() {
  const turns = [];
  let prev = 0;
  for (let i = 6; i >= 0; i--) {
    const abs = new Date(2026, 10, 5 - i, 10).getTime();
    turns.push({ s: 0, t: abs - prev, b: abs - 30000, out: 100, ms: 1000, i: 80, o: 100,
      n: 1, msl: [[0, 100, 1000, 1]], c: 0.01, cf: 1 });
    prev = abs;
  }
  return { sid: 's', source: 'local', truncated: false, sids: ['s'], snames: ['S'],
    pids: [['p', 'P']], mnames: ['GLM-A'], mkeys: [KEYS.a], turns };
}
// n 轮单模型夹具（密度分档产物级验证用）
function fixtureN(n) {
  const t0 = new Date(2026, 10, 5, 8).getTime();
  let prev = 0;
  const turns = [];
  for (let i = 0; i < n; i++) {
    const abs = t0 + i * 60000;
    turns.push({ s: 0, t: abs - prev, b: abs - 30000, out: 100 + i, ms: 1000, i: 80, o: 100,
      n: 1, msl: [[0, 100 + i, 1000, 1]], c: 0.01, cf: 1 });
    prev = abs;
  }
  return { sid: 's', source: 'local', truncated: false, sids: ['s'], snames: ['S'],
    pids: [['p', 'P']], mnames: ['GLM-A'], mkeys: [KEYS.a], turns };
}
test('v388 §12.3 + v389 §13.1: plot width:auto + 弹性高 flex 三值、柱组密度分档（n≤3→120/n≤8→140/n>8 无内联）、week 满 7 天无覆盖提示', () => {
  const ctx = makeCtx();
  // plot 串锁：width:auto（块级 + margin-left:30 自动填满剩余，§12.3 幻影溢出根除）；
  // v389 §13.1 高弹性 flex：flex:1 吸收左卡/档位拉伸、min-height 200 保底——
  // v393 §17 起 max-height:300 随五形态统一 450 废除，plot 吃满卡内剩余
  const an2 = analyze(ctx, fixtureN(2), { range: 'session', period: 'recent', sid: 's' });
  const html2 = chart(ctx, an2, -1);
  assert.match(html2,
    /\.zu-sv3-chart \.zu-sc-plot\{flex:1 1 auto;min-height:200px;margin-left:30px;min-width:0;width:auto;box-sizing:border-box\}/,
    'plot width:auto + 弹性高无上限（§12.3/§13.1/§17）');
  assert.doesNotMatch(html2, /\.zu-sv3-chart \.zu-sc-plot\{[^}]*max-height/, 'plot 300 上限已废除（§17）');
  assert.doesNotMatch(html2, /\.zu-sv3-chart \.zu-sc-plot\{[^}]*width:100%/, 'plot 100% 宽幻影溢出路径已除名');
  assert.doesNotMatch(html2, /\.zu-sv3-chart \.zu-sc-plot\{[^}]*[^-]height:\d+px/, 'plot 固定 px 高已退役（min/max-height 之外无 height 键，§13.1）');
  // 值区链同步弹性：网格/沟槽=plot−16px X 带；svg 高 calc(100%−16)（§13.1 折线）
  assert.match(html2, /\.zu-sv3-chart \.zu-sc-grid,\.zu-sv3-chart \.zu-sc-gutter\{height:calc\(100% - 16px\)\}/,
    '网格/沟槽高=值区（plot−X 带 16px）');
  assert.match(html2, /\.zu-sv3-svg\{display:block;overflow:visible;height:calc\(100% - 16px\)\}/,
    '折线 svg 高=值区百分比（§13.1）');
  // wrap flex 列 + justify-content:flex-end：plot 拉伸到 300 封顶后多余高度留在上方，
  // X 标签带恒贴 plot 底/卡底（PRD §2.4 距卡内边界 ≤28px）
  assert.match(html2, /\.zu-sv3-chart \.zu-sc-wrap\{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:flex-end;/,
    'wrap 底对齐（X 轴带恒贴底，§13.1）');
  // 柱组密度分档纯函数：n≤3→n×120、n≤8→n×140、n>8→无内联
  const density = n => vm.runInContext('spd3BarDensityStyle(' + n + ')', ctx);
  assert.equal(density(1), ' style="max-width:min(100%,120px);margin:0 auto"', 'n=1 → 120px 居中');
  assert.equal(density(2), ' style="max-width:min(100%,240px);margin:0 auto"', 'n=2 → 240px 居中分组');
  assert.equal(density(3), ' style="max-width:min(100%,360px);margin:0 auto"', 'n=3 → 360px');
  assert.equal(density(8), ' style="max-width:min(100%,1120px);margin:0 auto"', 'n=8 → 1120px（140 上限档）');
  assert.equal(density(9), '', 'n=9 无上限：不出内联（恒满幅）');
  // 产物级：n=2 柱组带 240px 内联居中；n=18 柱组无内联
  assert.match(html2, /<span class="zu-sv3-bars zu-sv3-w18" style="max-width:min\(100%,240px\);margin:0 auto">/,
    'n=2 柱组 max-width 240px + margin auto 居中（§12.3）');
  const an18 = analyze(ctx, fixture18(), { range: 'session', period: 'recent', sid: 's' });
  const html18 = chart(ctx, an18, -1);
  assert.match(html18, /<span class="zu-sv3-bars zu-sv3-w10">/, 'n=18 柱组无内联 style（紧凑满幅）');
  // §12.5 覆盖提示满档：周内 7 天全有数据 → 不追加 sub（不添噪）
  const w7 = analyze(ctx, fixtureWeek7(), { range: 'all', period: 'week', sid: 's' });
  const h7 = chart(ctx, w7, -1);
  assert.match(h7, /data-head-sub=""/, '满 7 天不追加覆盖提示');
  assert.doesNotMatch(h7, /有效 \d\/7 天/, '满档无覆盖提示文案');
});

// ---------- ⑦ SPD_PORTAL 悬停卡 ----------
test('SPD_PORTAL: 未悬停空串；混合轮组成行含每模型 tps+token；降级帧组成行无 t/s；费用三态', () => {
  const ctx = makeCtx();
  const an = analyze(ctx, fixture(), { range: 'all', period: 'recent', sid: 'sess_main' });
  // items: [A 上月] [A 昨日] [A] [混合] [B 费缺] [A]
  assert.equal(an.items[3].models.length, 2, 'idx3=混合轮');
  chart(ctx, an, -1);
  assert.equal(portal(ctx), '', '未悬停=空串');
  chart(ctx, an, 3);
  const p = portal(ctx);
  assert.match(p, /class="zu-sv-card[^"]*" role="tooltip" data-i="3"/, '卡根携带 data-i');
  assert.match(p, /混合（2 种模型）/);
  assert.match(p, /GLM-A[^]*?300\.0 t\/s[^]*?600 token/, 'A 组成行：tps+token');
  assert.match(p, /Claude-B[^]*?300\.0 t\/s[^]*?300 token/, 'B 组成行：tps+token');
  assert.match(p, /speed|速度/);
  assert.match(p, /Token 总消耗/);
  assert.match(p, /900 token/, 'Token 总消耗=i+o');
  // 费用三态之一：正常 + costFull
  assert.match(p, /¥0\.09</, '混合轮费用（cf=1 无兜底注记）');
  // 费用缺失（idx4 的 B 轮 c=null）
  chart(ctx, an, 4);
  assert.match(portal(ctx), /暂无估价/);
  // 费用显示关闭（fmtMoney 缺失）
  chart(ctx, an, 3, { fmtTok: String, fmtCnt: String });
  assert.match(portal(ctx), /费用显示已关闭/);
  // 兜底估价注记（合成 item costFull=false，直接调用构建器）
  ctx.__it = { v: 100, models: [{ key: KEYS.a, name: 'GLM-A', o: 100, ms: 1000, n: 1 }],
    i: 10, o: 100, n: 1, c: 0.5, costFull: false,
    a: new Date(2026, 10, 5, 9).getTime(), b: new Date(2026, 10, 5, 9, 1).getTime(),
    full: '2026-11-05 09:00:00 – 2026-11-05 09:01:00' };
  ctx.__o2 = FMTS;
  const partial = vm.runInContext('spd3HoverCardHTML(__it, __o2, 7)', ctx);
  assert.match(partial, /¥0\.50</);
  assert.match(partial, /含兜底估价/);
  // 降级帧（二元组 msl）：组成行只显名称+token，无 t/s 数值（主速度行除外）
  const anl = analyze(ctx, fixtureLegacyMixed(), { range: 'session', period: 'recent', sid: 's' });
  assert.equal(anl.msAvail, false);
  chart(ctx, anl, 0);
  const pl = portal(ctx);
  assert.match(pl, /混合（2 种模型）/);
  assert.match(pl, /GLM-A[^]*?100 token/);
  assert.match(pl, /Claude-B[^]*?400 token/);
  assert.equal((pl.match(/t\/s/g) || []).length, 1, '仅主速度行有 t/s，组成行不冒充模型速度');
  // 悬停切回未悬停：侧信道复位
  chart(ctx, an, -1);
  assert.equal(portal(ctx), '');
});

// ---------- ⑧ 转义 ----------
test('转义: 模型名 <img onerror> 不出现在任何输出；fmtMoney 内部格式串按 spdEsc 包裹', () => {
  const ctx = makeCtx();
  const an = analyze(ctx, fixtureEvil(), { range: 'session', period: 'recent', sid: 's' });
  const o = { fmtTok: String, fmtCnt: String, fmtMoney: u => '<b>¥' + u.toFixed(2) + '</b>' };
  const html = chart(ctx, an, -1, o);
  chart(ctx, an, 1, o);   // 悬停混合轮（两个恶意名）
  const p = portal(ctx);
  for (const out of [html, p]) {
    assert.ok(!out.includes('<img'), '无未转义 img 标签');
    assert.ok(!out.includes('<b>¥'), '费用串不被原样注入');
    assert.ok(!out.includes('B"b'), '引号不破坏属性');
  }
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(p, /&lt;b&gt;¥0\.02&lt;\/b&gt;/, 'fmtMoney 输出经 spdEsc 一次性转义');
  assert.match(p, /&quot;b/, '属性内引号转义');
});

// ---------- ⑨ 空态与 a11y ----------
test('空态串与 a11y: 柱 tabindex/aria/role、命中列同款、空态提示语', () => {
  const ctx = makeCtx();
  // 空态：显式空选
  const anE = analyze(ctx, fixture(), { range: 'session', period: 'week', sid: 'sess_main',
    filt: { mode: 'sel', keys: [] } });
  const htmlE = chart(ctx, anE, -1);
  assert.match(htmlE, /当前筛选无有效速度数据/);
  assert.match(htmlE, /尝试选择更长时间范围/);
  assert.match(htmlE, /zu-sv-empty-hint/);
  assert.equal((htmlE.match(/<style>/g) || []).length, 0);
  assert.equal(portal(ctx), '');
  // a11y：recent 柱
  const an = analyze(ctx, fixture(), { range: 'session', period: 'recent', sid: 'sess_main' });
  const html = chart(ctx, an, -1);
  for (const col of colsOf(html)) {
    assert.match(col, /tabindex="0"/);
    assert.match(col, /role="img"/);
    assert.match(col, /data-i="\d+"/);
    assert.match(col, /aria-label="[^"]+"/);
  }
  // a11y：week 命中列（含缺失日合成桶）
  const w = analyze(ctx, fixture(), { range: 'all', period: 'week', sid: 'sess_main' });
  const hw = chart(ctx, w, -1);
  const hits = hw.match(/<rect class="zu-sv3-hit"[\s\S]*?\/>/g) || [];
  assert.equal(hits.length, 7);
  for (const hit of hits) {
    assert.match(hit, /data-i="\d+"/);
    assert.match(hit, /tabindex="0"/);
    assert.match(hit, /role="img"/);
    assert.match(hit, /aria-label="[^"]+"/);
  }
});

// ---------- ⑩ 负向断言 ----------
test('负向: 无「功能说明」常驻块、无 V2 专属类残留、无口径/图例常驻段', () => {
  const ctx = makeCtx();
  const outs = [];
  const an = analyze(ctx, fixture(), { range: 'all', period: 'recent', sid: 'sess_main' });
  outs.push(chart(ctx, an, -1), chart(ctx, an, 0));
  const td = analyze(ctx, fixture(), { range: 'all', period: 'today', sid: 'sess_main' });
  outs.push(chart(ctx, td, -1));
  const tdBar = analyze(ctx, fixture(), { range: 'all', period: 'today', sid: 'sess_main',
    focus: 'full', filt: { mode: 'sel', keys: [KEYS.a] } });
  outs.push(chart(ctx, tdBar, -1));
  const w1 = analyze(ctx, fixture(), { range: 'all', period: 'week', sid: 'sess_main',
    filt: { mode: 'sel', keys: [KEYS.a] } });
  outs.push(chart(ctx, w1, -1));
  const w2 = analyze(ctx, fixture(), { range: 'all', period: 'week', sid: 'sess_main' });
  outs.push(chart(ctx, w2, -1));
  const anE = analyze(ctx, fixture(), { range: 'session', period: 'week', sid: 'sess_main',
    filt: { mode: 'sel', keys: [] } });
  outs.push(chart(ctx, anE, -1));
  for (const s of outs) {
    assert.ok(!s.includes('功能说明'), '无功能说明常驻块');
    assert.ok(!/统计口径|均值参考|zu-basis/.test(s), '无口径段残留');
    assert.ok(!s.includes('zu-sv-bars'), '无 V2 柱组类（V3 用 zu-sv3-bars）');
    assert.ok(!s.includes('zu-sv-plot') && !s.includes('zu-sv-gutcol') && !s.includes('zu-sv-spacer'),
      '无 V2 plot/gutter/spacer 类残留');
    assert.ok(!s.includes('spdChartHTML') && !s.includes('spdCardHTML'), '不引用 V2 函数名');
  }
  for (const s of outs.slice(0, 5)) assert.equal((s.match(/<style>/g) || []).length, 1, '样式段恰一次');
});

// ---------- ⑪ v389 §13.2 槽位卡（today/week 统一 spd3SlotCardHTML） ----------
test('v389 §13.2 槽位卡: today 空小时/week 空日出「无有效速度记录」轻卡；有数据卡=综合大字+模型明细+轮次/输出/费用三态+另有 N 个模型', () => {
  const ctx = makeCtx();
  // today 单模型（柱）：空小时槽悬停 → 轻卡（§13.2 不再静默；hourMode 区间文案）
  const tdBar = analyze(ctx, fixture(), { range: 'all', period: 'today', sid: 'sess_main',
    focus: 'full', filt: { mode: 'sel', keys: [KEYS.a] } });
  chart(ctx, tdBar, 0);
  const pBar = portal(ctx);
  assert.match(pBar, /zu-sv3-daycard/, '槽位卡根类（today 小时桶）');
  assert.match(pBar, /11\/05（周四） · 无有效速度记录/, '空槽轻卡标题');
  assert.match(pBar, /区间[^]*2026\/11\/05 00:00 – 01:00/, 'hourMode 已结束空槽区间=整小时');
  // today 进行中空槽（当前 14 时，b 钳 now=槽起）：区间含「截至」
  chart(ctx, tdBar, 14);
  assert.match(portal(ctx), /区间[^]*2026\/11\/05 14:00 – 截至 14:00/, '进行中小时槽区间（§11.5，b 钳 now）');
  // week 多模型：有数据日（今天）→ 综合日均大字 + 模型明细 + 轮次/输出/费用
  const w2 = analyze(ctx, fixture(), { range: 'all', period: 'week', sid: 'sess_main' });
  chart(ctx, w2, 6);
  const pDay = portal(ctx);
  assert.match(pDay, /zu-sv3-daycard/, 'week 日桶同走槽位卡');
  assert.match(pDay, /综合日均</, 'dayMode 主行标签');
  assert.match(pDay, /zu-sv-cval [\w-]+ zu-sv3-big">111\.8 t\/s/, '综合日均档位色大字（11.5 = 全天加权）');
  assert.match(pDay, /GLM-A<\/span><i class="zu-sv3-mv">150\.0 t\/s<\/i><i class="zu-sv3-mt">3 次/,
    '模型明细行：均速+请求数');
  assert.match(pDay, /Claude-B[^]*?77\.8 t\/s[^]*?2 次/, '多模型逐行（当日分量口径）');
  assert.match(pDay, /有效轮次<\/span><b>4 轮/, '有效轮次（fmtCnt 在场）');
  assert.match(pDay, /有效输出<\/span><b>1900 token/, '有效输出（fmtTok 在场）');
  assert.match(pDay, /区间<\/span><b>2026\/11\/05 · 00:00 – 截至 14:00/, '进行中日区间（b 钳 now）');
  assert.match(pDay, /预估费用[^]*?¥0\.15<i class="zu-sv-partial"> · 含兜底估价/, '预估费用=正常值+兜底注记（c=null 轮入日）');
  // 费用三态（槽位卡，直接调构建器锁纯函数契约）：fmtMoney 缺失=关闭、c=null=暂无估价
  ctx.__itC = { v: 100, empty: false, turns: 1, out: 100, c: null,
    a: new Date(2026, 10, 5).getTime(), b: new Date(2026, 10, 5, 14).getTime(),
    models: [{ key: KEYS.a, name: 'GLM-A', o: 100, ms: 1000, n: 1, tps: 100 }] };
  ctx.__oN = { fmtTok: String, fmtCnt: String };
  assert.match(vm.runInContext('spd3SlotCardHTML(__itC, __oN, 1, true)', ctx),
    /费用显示已关闭/, '槽位卡费用态一：显示关闭');
  ctx.__oF = FMTS;
  assert.match(vm.runInContext('spd3SlotCardHTML(__itC, __oF, 1, true)', ctx),
    /暂无估价/, '槽位卡费用态二：暂无估价（绝不显 0）');
  // >6 模型截断 +「另有 N 个模型」（直接调用构建器，纯字符串契约）
  const models = [];
  for (let i = 0; i < 8; i++) models.push({ key: 'k\x1fm' + i, name: 'M' + i, o: 100, ms: 1000, n: 1, tps: 100 });
  ctx.__it8 = { v: 100, empty: false, turns: 8, out: 800, c: 0.5, costFull: true,
    a: new Date(2026, 10, 5).getTime(), b: new Date(2026, 10, 5, 14).getTime(),
    models };
  ctx.__o3 = FMTS;
  const p8 = vm.runInContext('spd3SlotCardHTML(__it8, __o3, 2, true)', ctx);
  assert.equal((p8.match(/zu-sv3-mi"/g) || []).length, 6, '模型明细 ≤6 行');
  assert.match(p8, /zu-sv3-more">另有 2 个模型/, '截断汇总行');
  assert.match(p8, /data-i="2"/, '卡根携带悬停序号');
});

// ---------- ⑫ v389 §13.2/§13.3 折线两级 hover CSS 与 lineg 分组串锁 ----------
test('v389 §13.2/§13.3: lineg 分组（线+点同组 data-m）+ 四条纯 CSS hover 串在场（线级加粗/提亮/兄弟弱化/指针让位）', () => {
  const ctx = makeCtx();
  const an = analyze(ctx, fixture(), { range: 'all', period: 'today', sid: 'sess_main' });
  const html = chart(ctx, an, -1);
  // 四条 hover CSS（§13.2 两级 hover 的线级视觉，零 JS 监听）
  assert.match(html, /\.zu-sv3-lineg\{pointer-events:stroke\}/, '线体命中（pointer-events:stroke）');
  assert.match(html, /\.zu-sv3-lineg:hover\{stroke-width:2\.6\}/, 'hover 自身加粗 2.6px');
  assert.match(html, /\.zu-sv3-lineg:hover \.zu-sv3-pt\{filter:brightness\(1\.3\)\}/, 'hover 圆点提亮');
  assert.match(html, /\.zu-sv3-lines:hover \.zu-sv3-lineg:not\(:hover\)\{opacity:\.45\}/, '容器 hover 弱化兄弟线');
  // 标签/线不抢指针（线级 hover 让位）
  assert.match(html, /\.zu-sv3-xtxt\{[^}]*pointer-events:none\}/, 'X 标签不截获指针');
  // 分组结构：g.zu-sv3-lines 容器画在命中列上层（后绘），线+点同组（§13.3 三层层级）
  assert.match(html, /<g class="zu-sv3-lines">[\s\S]*<\/g><text class="zu-sv3-elabel|<g class="zu-sv3-lines">/,
    'lineg 容器在场');
  const orderHit = html.indexOf('class="zu-sv3-hit"');
  const orderLines = html.indexOf('<g class="zu-sv3-lines">');
  assert.ok(orderHit >= 0 && orderLines > orderHit, 'lineg 组绘制在命中列之后（上层，线级 hover 可命中）');
});
