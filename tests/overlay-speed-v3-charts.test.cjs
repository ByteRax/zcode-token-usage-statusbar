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
const VIEW_STUB = 'function spd3ChartHeadHTML(an,sub){return "<div class=\\"zu-sc-head\\">"+an.title+"</div>";}';
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

// ---------- ③ recent 数值稀疏 ----------
test('recent 数值稀疏: n=18 按 valEvery=3 抽稀、首/末恒显、悬停柱强制显示', () => {
  const ctx = makeCtx();
  const an = analyze(ctx, fixture18(), { range: 'session', period: 'recent', sid: 's' });
  assert.equal(an.items.length, 18);
  const html = chart(ctx, an, -1);
  const shown = (html.match(/zu-sc-val">[0-9]/g) || []).length;
  assert.equal(shown, 7, 'idx 0,3,6,9,12,15 + 末柱 17，得到 ' + shown);
  // 悬停非采样位柱：读数恒显
  const html2 = chart(ctx, an, 2);
  const shown2 = (html2.match(/zu-sc-val">[0-9]/g) || []).length;
  assert.equal(shown2, 8);
  const cols2 = colsOf(html2);
  assert.match(cols2[2], /zu-sc-val">102\.0</, '悬停柱数值在场');
  assert.match(cols2[2], /class="zu-sc-col cur"/, '悬停柱 cur 类');
  assert.ok(!cols2[1].includes('zu-sc-val">1'), '非采样位且未悬停不显');
  // 一位小数纪律
  assert.ok(!/zu-sc-val">\d+\.\d{2,}</.test(html2));
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

// ---------- ⑤ today 多模型折线 ----------
test('today 多模型折线: 每模型一条线、缺小时断线分段、点色正确、命中列数=当前小时+1', () => {
  const ctx = makeCtx();
  const an = analyze(ctx, fixture(), { range: 'all', period: 'today', sid: 'sess_main' });
  assert.equal(an.perModel.length, 2);
  assert.ok(an.msAvail);
  assert.equal(an.items.length, 15, '4 个有效小时 > 聚焦阈值 → 00..14 全轴');
  const html = chart(ctx, an, -1);
  const dom = domOf(html);
  const colorA = colorOf(ctx, KEYS.a), colorB = colorOf(ctx, KEYS.b);
  // 两条模型实线（带模型色 stroke）、无总体虚线（总体线是近 7 天形态专属）
  assert.equal((dom.match(/<path class="zu-sv3-line" stroke="/g) || []).length, 2);
  assert.equal((dom.match(/<path class="zu-sv3-line[^"]*zu-sv3-oline"/g) || []).length, 0);
  // A: 小时 9,10,12 有分量 → 10 与 12 之间缺口断线（一条 path 内两段 M…L…）
  const pathA = dom.match(new RegExp('<path class="zu-sv3-line" stroke="' + colorA + '" d="([^"]+)"'));
  assert.ok(pathA, 'A 线在场');
  assert.equal((pathA[1].match(/M /g) || []).length, 2, 'A 线断为两段');
  const pathB = dom.match(new RegExp('<path class="zu-sv3-line" stroke="' + colorB + '" d="([^"]+)"'));
  assert.ok(pathB, 'B 线在场');
  assert.equal((pathB[1].match(/M /g) || []).length, 1, 'B 线 10,11 连续一段');
  // 数据点：A 3 个 + B 2 个 = 5，点色=模型色
  assert.equal((html.match(/<circle class="zu-sv3-pt"/g) || []).length, 5);
  assert.ok(html.includes('fill="' + colorA + '"'));
  assert.ok(html.includes('fill="' + colorB + '"'));
  // 悬停命中列（每小时一条）+ 同组十字参考线
  assert.equal((html.match(/class="zu-sv3-hit" data-i="/g) || []).length, 15);
  assert.equal((html.match(/class="zu-sv3-xline"/g) || []).length, 15);
  // 命中列 aria：空小时无数据、实小时逐模型速度
  assert.match(html, /aria-label="00:00，无数据"/);
  assert.match(html, /aria-label="11:00，Claude-B 50\.0 t\/s"/);
  assert.match(html, /aria-label="10:00，GLM-A 300\.0 t\/s、Claude-B 300\.0 t\/s"/);
  // SVG 绘图区定高（148+16+顶部 8）
  assert.match(html, /<svg class="zu-sv3-svg" width="\d+" height="172" viewBox="0 0 \d+ 172">/);
  // 未悬停：侧信道空
  assert.equal(portal(ctx), '');
});

// ---------- ⑥ week 单/多模型 ----------
test('week 单/多: 单=线+面积+端标签且无总体虚线；多=逐模型线+总体虚线+端标签错开≥12px；缺失日断线', () => {
  const ctx = makeCtx();
  // 单模型：只看 A
  const w1 = analyze(ctx, fixture(), { range: 'all', period: 'week', sid: 'sess_main',
    filt: { mode: 'sel', keys: [KEYS.a] } });
  assert.equal(w1.perModel.length, 1);
  const h1 = chart(ctx, w1, -1);
  const colorA = colorOf(ctx, KEYS.a);
  assert.equal((h1.match(/class="zu-sv3-hit" data-i="/g) || []).length, 7, '恒 7 个本地日命中列');
  assert.equal((h1.match(/class="zu-sv3-xtxt"/g) || []).length, 7, 'X 轴 7 个日标签（含无数据日）');
  assert.equal((h1.match(/<path class="zu-sv3-line" stroke="/g) || []).length, 1, '单条模型线');
  assert.equal((h1.match(/<path class="zu-sv3-line[^"]*zu-sv3-oline"/g) || []).length, 0, '单模型无总体虚线');
  assert.match(h1, new RegExp('<path class="zu-sv3-area" fill="' + colorA + '"'), '单模型面积填充');
  assert.equal((h1.match(/<circle class="zu-sv3-pt"/g) || []).length, 2, '11-04 与 11-05 两个真实日点');
  assert.equal((h1.match(/class="zu-sv3-elabel/g) || []).length, 1, '单个末端数值标签');
  assert.match(h1, /zu-sv3-elabel[^>]*>1\d\d\.0</, '端标签为一位小数速度值');
  // 多模型：全池
  const w2 = analyze(ctx, fixture(), { range: 'all', period: 'week', sid: 'sess_main' });
  const h2 = chart(ctx, w2, -1);
  assert.equal((h2.match(/<path class="zu-sv3-line" stroke="/g) || []).length, 2, '两条模型线');
  assert.equal((h2.match(/<path class="zu-sv3-line[^"]*zu-sv3-oline"/g) || []).length, 1, '总体虚线仅多模型在场');
  // 端标签 3 个（A、B、总体），y 两两 ≥12px
  const labelYs = [];
  const re = /<text class="zu-sv3-elabel[^"]*" x="[-\d.]+" y="([-\d.]+)"/g;
  let m;
  while ((m = re.exec(h2)) !== null) labelYs.push(parseFloat(m[1]));
  assert.equal(labelYs.length, 3);
  labelYs.sort((x, y) => x - y);
  assert.ok(labelYs[1] - labelYs[0] >= 12 && labelYs[2] - labelYs[1] >= 12,
    '端标签错开 ≥12px：' + labelYs.join(','));
  // 缺失日（10-31..11-03）无点：总点数 = A2 + B1 + 总体不加 = 3
  assert.equal((h2.match(/<circle class="zu-sv3-pt"/g) || []).length, 3);
  // 缺失日命中列可悬停且报无数据（悬停无卡）
  assert.match(h2, /aria-label="10\/31，无数据"/);
  const h2h = chart(ctx, w2, 0);
  assert.equal(portal(ctx), '', '缺失日悬停不产卡');
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
