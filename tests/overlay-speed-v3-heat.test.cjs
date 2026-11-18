'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');
const { readOverlayPart, sliceOverlay, readOverlaySource } = require('./helpers/overlay-extract.cjs');

// v384 速度 Tooltip V3 热力图（本月日历 + 全部历史）：04-speed-v3-core.js（spd3 数据
// 上游）+ 04-speed-v3-heat.js 全文进 VM，纯字符串行为级验证。依赖的存活符号切片取自
// overlay.js（spec §0：TPS_BANDS/tpsBand + spd* 基础助手在 V3 集成后保留；切片边界
// 对齐 overlay-speed-v3-core.test.cjs）。spd3ChartHeadHTML 属 view 分片（并行开发中）
// ——用透传桩替代，经 data-head-sub 断言 sub 文案。SPD_PORTAL 桩=模块外侧信道变量。
const core = readOverlayPart('04-speed-v3-core.js');
const heat = readOverlayPart('04-speed-v3-heat.js');
const bands = sliceOverlay('  var TPS_BANDS = [', '  /* tooltip 颜色对照图例');
const spdHelpers = sliceOverlay('  var SPD_RANGES = [', '  var SPD_PORTAL = "";');

const viewStub = [
  'function spd3ChartHeadHTML(an, sub) {',
  '  return \'<div class="zu-sc-head" data-head-sub="\' + String(sub == null ? "" : sub) + \'"><span class="zu-sc-title">\' + ((an && an.title) || "") + \'</span>\';',
  '}',
].join('\n');

// 冻结时钟：2026-11-05（周四）14:00 本地时。2026-11-01 是周日（当月无前导补位）。
const FIXED_NOW = new Date(2026, 10, 5, 14, 0, 0).getTime();
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
  vm.runInContext('var SPD_PORTAL = "";', ctx);
  vm.runInContext(bands + '\n' + spdHelpers + '\n' + viewStub + '\n' + core + '\n' + heat, ctx);
  return ctx;
}

const DAY = 864e5;
const K = { a: 'prov_a\x1fglm-a', b: 'prov_b\x1fclaude-b', c: 'prov_c\x1fgemini-c', d: 'prov_d\x1fgpt-d' };
const tOf = (day, h) => new Date(2026, 10, day, h).getTime();

// 绝对时刻列表 → delta 编码轮表帧（纪律同 overlay-speed-heatmap.test.cjs 的 histFrom）
function frameFrom(abs, opts = {}) {
  abs.sort((a, b) => a.t - b.t);
  let prev = 0;
  const turns = abs.map(r => {
    const o = { s: 0, t: r.t - prev, b: r.b != null ? r.b : r.t - 60000,
      out: r.out, ms: r.ms, i: r.i != null ? r.i : r.out, o: r.out, n: r.n || 1, msl: r.msl };
    prev = r.t;
    if (r.c != null) o.c = r.c;
    return o;
  });
  return { sid: 'sess_main', source: 'local', truncated: false,
    sids: ['sess_main'], snames: ['本会话'], pids: [['proj_a', '项目A']],
    mnames: opts.mnames || ['GLM-A'], mkeys: opts.mkeys || [K.a], turns };
}

// 多模型月夹具：11-03 四模型日（400 t/s）、11-04 单模型日（300）、11-05 两轮混合
// （100/1s + 900/3s[600A+300B] → 加权 250 t/s，绝不等于算术平均）
function multiFrame() {
  return frameFrom([
    { t: tOf(3, 10), out: 4000, ms: 10000, n: 4,
      msl: [[0, 1000, 2500, 1, 1], [1, 1200, 3000, 1, 1], [2, 800, 2000, 1, 1], [3, 1000, 2500, 1, 1]] },
    { t: tOf(4, 15), out: 3000, ms: 10000, msl: [[0, 3000, 10000, 1, 1]] },
    { t: tOf(5, 9), out: 100, ms: 1000, msl: [[0, 100, 1000, 1, 1]] },
    { t: tOf(5, 10), out: 900, ms: 3000, msl: [[0, 600, 2000, 1, 1], [1, 300, 1000, 1, 1]] },
  ], { mnames: ['GLM-A', 'Claude-B', 'Gemini-C', 'GPT-D'], mkeys: [K.a, K.b, K.c, K.d] });
}

function singleFrame() {
  return frameFrom([
    { t: tOf(4, 15), out: 3000, ms: 10000, msl: [[0, 3000, 10000, 1, 1]] },
    { t: tOf(5, 9), out: 500, ms: 5000, msl: [[0, 500, 5000, 1, 1]] },
  ]);
}

// 550 天 speed_days（spec 上限）：每天 2 轮单模型，日均速度 (1000+i)/10 t/s 逐日递增
function days550(truncated) {
  const start = new Date(2026, 10, 5).getTime() - 549 * DAY;
  const days = [];
  for (let i = 0; i < 550; i++)
    days.push([1000 + i, 10000, 2, 2, 0, [[0, 1000 + i, 10000, 2, 2]]]);
  return { v: 1, source: 'local', start, days, mnames: ['GLM-A'], mkeys: [K.a], truncated };
}

function analyzeMonth(ctx) {
  return vm.runInContext('spd3Analyze(__h, null, {range:"all", period:"month", sid:"sess_main"})', ctx);
}
function analyzeAll(ctx, sdVar) {
  return vm.runInContext('spd3Analyze(null, ' + sdVar + ', {range:"all", period:"all", sid:""})', ctx);
}
function monthHTML(ctx, an, hoverIdx) {
  ctx.__an = an; ctx.__hi = typeof hoverIdx === 'number' ? hoverIdx : -1;
  return vm.runInContext('spd3MonthHTML(__an, __hi)', ctx);
}
function histHTML(ctx, an, sd, hoverIdx) {
  ctx.__an = an; ctx.__sdh = sd; ctx.__hi = typeof hoverIdx === 'number' ? hoverIdx : -1;
  return vm.runInContext('spd3HistHTML(__an, __sdh, __hi)', ctx);
}
const portal = ctx => vm.runInContext('SPD_PORTAL', ctx);

const count = (s, needle) => s.split(needle).length - 1;
// 结构断言只看 DOM 串：内联 <style> 携带同类名字符串，先剥掉
const dom = html => html.replace(/<style>[\s\S]*?<\/style>/g, '');
// 取 data-i=i 的格（开标签至首个 </div>；格内只有 span/i 无嵌套 div）
function cellOf(html, i) {
  const m = html.match(new RegExp('<div class="zu-hm-cell[^>]*data-i="' + i + '"[^>]*>'));
  assert.ok(m, 'cell data-i=' + i + ' exists');
  const end = html.indexOf('</div>', m.index);
  return html.slice(m.index, end + 6);
}

// ---------- ① month 网格数学 ----------
test('month 网格: 2026-11（01=周日）无补位 5 行；2026-06（01=周一）首格 1 枚 pad；2024-02 闰月前补 4 空 5 行', () => {
  const ctx = makeCtx();
  ctx.__h = multiFrame();
  const html = dom(monthHTML(ctx, analyzeMonth(ctx)));
  assert.match(html, /class="zu-speed-chart zu-sv-chart zu3-hm"/, 'month 图根类');
  assert.match(html, /--zu-hm-rows:5/, '行数经 --zu-hm-rows 下发（0 前导 + 30 天 = 5 行）');
  assert.equal(count(html, 'zu-hm-pad'), 0, '2026-11-01 是周日：无前导补位');
  assert.equal(count(html, 'role="gridcell"'), 30);
  assert.equal(count(html, 'role="row"'), 5);

  const ctx6 = makeCtx(new Date(2026, 5, 15, 10).getTime());
  ctx6.__h = frameFrom([{ t: new Date(2026, 5, 10, 9).getTime(), out: 500, ms: 5000, msl: [[0, 500, 5000, 1, 1]] }]);
  const html6 = dom(monthHTML(ctx6, analyzeMonth(ctx6)));
  assert.equal(count(html6, 'zu-hm-pad'), 1, '2026-06-01 是周一：首格 1 枚补位');
  assert.match(html6, /--zu-hm-rows:5/, '1 前导 + 30 天 = 5 行');

  const ctx2 = makeCtx(new Date(2024, 1, 15, 10).getTime());
  ctx2.__h = frameFrom([{ t: new Date(2024, 1, 10, 9).getTime(), out: 500, ms: 5000, msl: [[0, 500, 5000, 1, 1]] }]);
  const html2 = dom(monthHTML(ctx2, analyzeMonth(ctx2)));
  assert.equal(count(html2, 'zu-hm-pad'), 4, '2024-02-01 是周四：前补 4 空');
  assert.equal(count(html2, 'role="gridcell"'), 29, '闰年 2 月 29 天');
  assert.match(html2, /--zu-hm-rows:5/, '4 前导 + 29 天 = 5 行');
});

// ---------- ② 格状态类 ----------
test('month 格状态: 今天档位混底+描边、未来遮罩 aria-hidden、无记录灰、有值格挂档位类，绝不 0 t/s', () => {
  const ctx = makeCtx();
  ctx.__h = multiFrame();
  const html = dom(monthHTML(ctx, analyzeMonth(ctx)));
  const today = cellOf(html, 4);   // 11-05 加权 1000t/4s = 250 t/s → zu-sky
  assert.match(today, /zu-hm-data/);
  assert.match(today, /zu-sky/);
  assert.match(today, /zu-hm-today/);
  assert.match(today, /zu3-v">250</);
  assert.match(cellOf(html, 3), /zu-azure/, '11-04 = 300 t/s → zu-azure');
  const void1 = cellOf(html, 0);   // 11-01 无记录
  assert.match(void1, /zu-hm-void/);
  assert.match(void1, /无有效速度记录/);
  assert.ok(!/zu-hm-data/.test(void1), '无记录日不挂档位类');
  const fut = cellOf(html, 5);     // 11-06 未来
  assert.match(fut, /zu-hm-fut/);
  assert.match(fut, /aria-hidden="true"/);
  assert.equal(count(html, 'zu-hm-fut'), 25, '11-06..30 共 25 个未来日');
  assert.ok(!/均速 0 t\/s|>0<\/span>/.test(html), '绝不伪造 0 t/s');
});

// ---------- ③ 模型点 ----------
test('month 模型点: 多模型日 ≤3 点 + 「+N」、单模型日 1 点、单模型视图无点、点色=spd3Color(key)', () => {
  const ctx = makeCtx();
  ctx.__h = multiFrame();
  const html = dom(monthHTML(ctx, analyzeMonth(ctx)));
  assert.equal(count(cellOf(html, 4), '<span class="zu3-mdot"'), 2, '11-05 两个模型 → 2 点');
  const d3 = cellOf(html, 2);      // 11-03 四模型
  assert.equal(count(d3, '<span class="zu3-mdot"'), 3, '超过 3 个模型取 out 前 3');
  assert.match(d3, /zu3-mmore">\+1</, '剩余 +N');
  const d4 = cellOf(html, 3);
  assert.equal(count(d4, '<span class="zu3-mdot"'), 1, '多模型月内的单模型日仍标身份点');
  const colA = vm.runInContext('spd3Color(' + JSON.stringify(K.a) + ')', ctx);
  assert.ok(d4.includes('background:' + colA), '点色=spd3Color(模型 key)');
  assert.ok(!/zu3-mmore/.test(d4), '单模型日无 +N');

  const ctxS = makeCtx();
  ctxS.__h = singleFrame();
  const htmlS = dom(monthHTML(ctxS, analyzeMonth(ctxS)));
  assert.ok(!htmlS.includes('zu3-mdot'), '单模型视图（perModel=1）不渲染重复色点');
});

// ---------- ④ 图例（§11.5：较低/较高渐变段移除，保留右侧模型身份行） ----------
test('month 图例: 较低/较高渐变段已移除（档位说明归标题 ⓘ），右侧模型身份行单/多模型两态', () => {
  const ctx = makeCtx();
  ctx.__h = multiFrame();
  const html = dom(monthHTML(ctx, analyzeMonth(ctx)));
  assert.doesNotMatch(html, /较低|较高/, '替代档位体系的渐变图例不复存在（PRD 6.3）');
  assert.doesNotMatch(html, /linear-gradient/, '无渐变段');
  assert.doesNotMatch(html, /#ff6b57/, '无最低档实色块');
  assert.match(html, /class="zu3-lg"><span class="zu3-lg-r">颜色标记代表模型<\/span><\/div>/,
    '多模型=右侧身份行（颜色标记代表模型）');

  const ctxS = makeCtx();
  ctxS.__h = singleFrame();
  const htmlS = dom(monthHTML(ctxS, analyzeMonth(ctxS)));
  assert.match(htmlS, /GLM-A · 单模型/, '单模型文案带模型名');
});

// 550 天（周数阈值边界内/外两态）：26 列内=日粒度周格；>26 周=月聚合
function daysN(n) {
  const start = new Date(2026, 10, 5).getTime() - (n - 1) * DAY;
  const days = [];
  for (let i = 0; i < n; i++)
    days.push([1000 + i, 10000, 2, 2, 0, [[0, 1000 + i, 10000, 2, 2]]]);
  return { v: 1, source: 'local', start, days, mnames: ['GLM-A'], mkeys: [K.a], truncated: 0 };
}

// ---------- ⑤ hist（§11.6：>26 周切月聚合、列宽帽、截断披露） ----------
test('hist: 550 天 → 19 月列月聚合（根类 zu3-hh-mo、YYYY/MM 列帽、按月聚合副题、月格 aria）、26 列内日粒度两态', () => {
  const ctx = makeCtx();
  ctx.__sd = days550(1);
  const an = analyzeAll(ctx, '__sd');
  const raw = histHTML(ctx, an, ctx.__sd);
  const html = dom(raw);
  // 月聚合分支（周列数 79 > SPD3_HIST_MONTH_COLS=26）：2025/05..2026/11 恰 19 月列
  assert.match(html, /class="zu-speed-chart zu-sv-chart zu3-hh zu3-hh-mo"/, '月聚合根类（zu3-hh-mo）');
  assert.match(html, /--zu3-cols:19/, '550 日 ≤19 月列（无横滚，替代原 110 列硬帽）');
  assert.equal(count(html, 'zu-hm-cell'), 19, '每月一列竖条格');
  assert.equal(count(html, 'zu-hm-pad'), 0, '月分支无补位');
  assert.equal(count(html, 'role="row"'), 19, '每列一个 row 块');
  assert.equal(count(html, '<span>周'), 0, '月粒度无星期语义：行首标签列不渲染');
  // 列头 YYYY/MM：首列与跨年 1 月列带年加亮（2025/05=col1、2026/01=col9），末列 2026/11
  assert.match(html, /zu3-cl zu3-cl-mo" style="grid-column:1">2025\/05</, '首列带年（YYYY/MM）');
  assert.match(html, /zu3-cl zu3-cl-mo" style="grid-column:9">2026\/01</, '跨年 1 月列带年加亮');
  assert.match(html, /class="zu3-cl" style="grid-column:19">11</, '普通月列裸 MM');
  assert.match(html, /data-head-sub="按月聚合 · 已截断 · 仅显示最近 550 天"/, '按月聚合副题 + 截断随 sub 透传');
  assert.match(html, /data-sv-end="1"/, '首开由宿主滚到最新（V2 契约沿用）');
  assert.match(raw, /\.zu3-hh-mo \.zu3-hh-grid\{grid-auto-columns:minmax\(18px,64px\)\}/,
    '月粒度列宽 18px 下限（19 列铺满无横滚，样式段）');
  // 今天月列（data-i=18）：月 v=Σout÷Σms 加权 = 7735t/50s = 154.7（≠ 日均 154.9）
  const mo = cellOf(html, 18);
  assert.match(mo, /zu-hm-data/, '有数据月挂档位混底');
  assert.match(mo, /zu3-v">154\.7</, '月加权均速一位小数');
  assert.match(mo, /aria-label="2026年11月，均速 154\.7 t\/s，较快，5 天有记录，10 次请求"/,
    '月格 aria=年月+均速+档位+天数/请求数');
  assert.ok(!html.includes('zu-hm-today'), '月粒度无日级今天描边');
  assert.match(html, /GLM-A · 单模型/, '单模型图例（右行身份行保留）');

  const ctxN = makeCtx();
  ctxN.__sd = days550(0);
  const htmlN = dom(histHTML(ctxN, analyzeAll(ctxN, '__sd'), ctxN.__sd));
  assert.ok(!htmlN.includes('已截断'), '未截断无披露');

  // 阈值两态（SPD3_HIST_MONTH_COLS=26）：26 周内=日粒度周格（列帽 minmax(34px,64px)）
  const ctxB = makeCtx();
  ctxB.__sd = daysN(177);   // lead=3 → cols=ceil(180/7)=26（边界内，不切月）
  const rawB = histHTML(ctxB, analyzeAll(ctxB, '__sd'), ctxB.__sd);
  const htmlB = dom(rawB);
  assert.match(htmlB, /class="zu-speed-chart zu-sv-chart zu3-hh"/, '边界内仍日粒度（无 zu3-hh-mo）');
  assert.ok(!htmlB.includes('zu3-hh-mo'), '26 列不切月');
  assert.match(htmlB, /data-head-sub="按日聚合"/, '日粒度副题');
  assert.match(htmlB, /--zu3-cols:26/);
  assert.equal(count(htmlB, 'zu-hm-cell'), 177, '每天一格');
  assert.equal(count(htmlB, 'zu-hm-pad'), 5, '周对齐补位（3 前导 + 2 末列）');
  assert.equal(count(htmlB, '<span>周'), 7, '行首固定 7 行（周日..周六）');
  assert.equal(count(htmlB, 'class="zu3-cl'), 13, '>14 列时隔列显标签防挤');
  assert.match(rawB, /grid-template-columns:repeat\(var\(--zu3-cols,1\),minmax\(34px,64px\)\)/,
    '日粒度列宽帽 minmax(34px,64px)（去 1fr 拉伸，样式段）');

  // 边界外一步（181 天、lead=6 → 27 列 > 26）切月聚合
  const ctxB2 = makeCtx();
  ctxB2.__sd = daysN(181);
  const htmlB2 = dom(histHTML(ctxB2, analyzeAll(ctxB2, '__sd'), ctxB2.__sd));
  assert.match(htmlB2, /zu3-hh-mo/, '27 列 > 26 → 切月聚合');
  assert.match(htmlB2, /data-head-sub="按月聚合"/);

  // 短历史：列数=1、逐列显标签（不稀疏）、空日=灰格如实显示
  const ctxS = makeCtx();
  ctxS.__sd = { v: 1, source: 'local', start: new Date(2026, 10, 3).getTime(),
    days: [[300, 1000, 1, 1, 0, [[0, 300, 1000, 1, 1]]], [0, 0, 0, 0, 0, 0],
      [500, 5000, 1, 1, 0, [[0, 500, 5000, 1, 1]]]],
    mnames: ['GLM-A'], mkeys: [K.a], truncated: 0 };
  const htmlS = dom(histHTML(ctxS, analyzeAll(ctxS, '__sd'), ctxS.__sd));
  assert.match(htmlS, /--zu3-cols:1/);
  assert.equal(count(htmlS, 'zu-hm-cell'), 3);
  assert.equal(count(htmlS, 'zu-hm-pad'), 4, '周首对齐前后补位');
  assert.equal(count(htmlS, 'class="zu3-cl'), 1, '≤14 列逐列显标签');
  assert.match(cellOf(htmlS, 1), /zu-hm-void/, '中间空日=灰格（空=无数据）');
});

// ---------- ⑥ aria / role ----------
test('aria/role: grid/row/gridcell、data-i 唯一、roving tabindex（首格 0 其余 -1）、en 桩文案', () => {
  const ctx = makeCtx();
  ctx.__h = multiFrame();
  const html = dom(monthHTML(ctx, analyzeMonth(ctx)));
  assert.equal(count(html, 'role="grid"'), 1);
  assert.equal(count(html, 'role="row"'), 5);
  assert.equal(count(html, 'role="gridcell"'), 30);
  const idxs = [...html.matchAll(/data-i="(\d+)"/g)].map(m => +m[1]);
  assert.equal(new Set(idxs).size, 30, 'data-i 唯一');
  assert.deepEqual(idxs.slice().sort((a, b) => a - b), [...Array(30).keys()], '日序 0..29');
  // v384 M1 roving tabindex：每网格首个可交互格 0、其余 -1（方向键移动由 06/01
  // keydown 委托翻转，host 侧形状由 overlay-speed-v2 测试锁）；void/未来格无 tabindex
  assert.match(cellOf(html, 2), /tabindex="0"/, '首个有值格（11-03）可聚焦');
  assert.match(cellOf(html, 3), /tabindex="-1"/, '后续有值格 -1（roving）');
  assert.match(cellOf(html, 4), /tabindex="-1"/, '今天格 -1（roving）');
  assert.equal(count(html, 'tabindex="0"'), 1, '每网格恰一枚 tabindex=0');
  assert.equal(count(html, 'tabindex="-1"'), 2, '其余可交互格全 -1');
  assert.ok(!cellOf(html, 0).includes('tabindex'), '无记录格不进 Tab 序（aria 保留）');
  assert.ok(!cellOf(html, 5).includes('tabindex'), '未来格 aria-hidden 不进 Tab 序');
  assert.match(cellOf(html, 4), /aria-label="2026年11月5日 周四，均速 250 t\/s，快速，2 个模型"/);

  const ctxH = makeCtx();
  ctxH.__sd = days550(0);
  const hist = dom(histHTML(ctxH, analyzeAll(ctxH, '__sd'), ctxH.__sd));
  assert.equal(count(hist, 'role="grid"'), 1);
  assert.equal(count(hist, 'role="gridcell"'), 19, '550 天月聚合 → 19 月格（非 550 日格）');
  const hidx = [...hist.matchAll(/data-i="(\d+)"/g)].map(m => +m[1]);
  assert.equal(new Set(hidx).size, 19, 'hist data-i 唯一（月序）');
  assert.deepEqual(hidx.slice().sort((a, b) => a - b), [...Array(19).keys()], '月序 0..18');
  // hist 网格同样 roving：首列有数据格 0（data-i=0），其余 -1
  assert.match(cellOf(hist, 0), /tabindex="0"/, 'hist 首个有值格可聚焦');
  assert.match(cellOf(hist, 1), /tabindex="-1"/, 'hist 后续格 -1');
  assert.equal(count(hist, 'tabindex="0"'), 1, 'hist 恰一枚 tabindex=0');
  assert.equal(count(hist, 'tabindex="-1"'), 18, '其余 18 个月格全 -1');
  // 方向键 roving 翻转委托在宿主两链（06 全量 tip / 01 tpsTip）在场
  const built = readOverlaySource();
  assert.equal((built.match(/ac3\.setAttribute\("tabindex", "-1"\);\s*\n\s*nu3\.setAttribute\("tabindex", "0"\);/g) || []).length, 2,
    '06/01 keydown 委托都接 roving 翻转');

  const ctxEn = makeCtx(FIXED_NOW, 'en');
  ctxEn.__h = multiFrame();
  const htmlEn = dom(monthHTML(ctxEn, analyzeMonth(ctxEn)));
  assert.match(cellOf(htmlEn, 4), /aria-label="Thu, Nov 5 2026, avg 250 t\/s, Fast, 2 models"/, 'en aria');
  assert.match(htmlEn, /<span>Sun<\/span>/, 'en 星期表头');
  assert.match(htmlEn, /aggregated by day/, 'en 聚合粒度 sub');
});

// ---------- ⑦ 日悬停卡 ----------
test('spd3DayCardHTML: 多模型明细行（点+名+轮次+均速）、降级只显轮次、capped 尾注、转义、空 item 不出卡', () => {
  const ctx = makeCtx();
  function dayCard(item) { ctx.__it = item; return vm.runInContext('spd3DayCardHTML(__it)', ctx); }
  const item = { t: tOf(5, 0), di: 4, capped: true,
    tn: { [K.a]: 2, [K.b]: 1 },
    agg: { v: 250, modelCount: 2, models: [
      { key: K.a, name: 'GLM-A', o: 700, ms: 2000, n: 2, tps: 350 },
      { key: K.b, name: 'Claude-B', o: 300, ms: 2000, n: 1, tps: 150 }] } };
  const card = dayCard(item);
  assert.match(card, /class="zu-sv-card zu-sv3-card" role="tooltip" data-i="4"/);
  assert.match(card, /11\/5（周四） · 模型明细/, '多模型标题');
  assert.match(card, /日均速度/);
  assert.match(card, /zu-sv3-cval zu-sky">250 t\/s/, '行1 日均速度带档位色');
  assert.match(card, /GLM-A/);
  assert.match(card, /2 轮/);
  assert.match(card, /350 t\/s/, '每模型均速');
  assert.match(card, /1 轮/);
  assert.match(card, /150 t\/s/);
  assert.match(card, /另有更多模型未列入/, 'capped 日尾注');

  const card1 = dayCard({ t: tOf(5, 0), agg: { v: 100, modelCount: 1,
    models: [{ key: K.a, name: 'GLM-A', o: 100, ms: 1000, n: 1, tps: 100 }] } });
  assert.match(card1, />11\/5（周四）</, '单模型标题无「模型明细」');
  assert.ok(!card1.includes('模型明细'));

  const cardD = dayCard({ t: tOf(5, 0), tn: { [K.a]: 2 }, agg: { v: 100, modelCount: 1,
    models: [{ key: K.a, name: 'GLM-A', o: 100, ms: 0, n: 0, tps: null }] } });
  assert.ok(!/zu3-mtps/.test(cardD), '模型分量无窗口（ms=0）不出均速');
  assert.match(cardD, /2 轮/, '降级模式只显轮次');

  const cardE = dayCard({ t: tOf(5, 0), agg: { v: 100, modelCount: 1,
    models: [{ key: 'k\x1fx', name: 'A<b>&"', o: 1, ms: 1, n: 1, tps: 1 }] } });
  assert.ok(cardE.includes('A&lt;b&gt;&amp;&quot;'), '模型名 spdEsc 转义');
  assert.ok(!cardE.includes('A<b>'), '原始 HTML 不落串');

  assert.equal(dayCard(null), '', '空 item 不出卡');
  assert.equal(dayCard({ t: tOf(5, 0), agg: { v: null, modelCount: 0, models: [] } }), '', '无有效速度不出卡');
});

// ---------- ⑧ SPD_PORTAL 纪律 ----------
test('SPD_PORTAL: 构建前清空、有悬停写 zu-sv-card+data-i、未悬停/无数据日/越界=空串、消费即清不残留', () => {
  const ctx = makeCtx();
  ctx.__h = multiFrame();
  const an = analyzeMonth(ctx);
  assert.equal(portal(ctx), '', '初始稳态空串');
  monthHTML(ctx, an, -1);
  assert.equal(portal(ctx), '', '未悬停=空串');
  monthHTML(ctx, an, 4);
  const p = portal(ctx);
  assert.match(p, /class="zu-sv-card zu-sv3-card"/);
  assert.match(p, /data-i="4"/);
  assert.match(p, /250 t\/s/);
  assert.match(p, /GLM-A/, '月内日卡带每模型轮次');
  assert.match(p, /2 轮/);
  monthHTML(ctx, an, 0);
  assert.equal(portal(ctx), '', '无记录日不出卡');
  monthHTML(ctx, an, 99);
  assert.equal(portal(ctx), '', '越界序号不出卡');

  const ctxH = makeCtx();
  ctxH.__sd = days550(0);
  const anH = analyzeAll(ctxH, '__sd');
  // 月聚合分支：悬停末月列（data-i=18 → 2026-11）出月卡（YYYY 年 M 月 · 月度统计，
  // 月加权均速 + N 天有记录/M 次请求 + 构成占比；月卡不带日序 data-i）
  histHTML(ctxH, anH, ctxH.__sd, 18);
  const pMo = portal(ctxH);
  assert.match(pMo, /class="zu-sv-card zu-sv3-card" role="tooltip"/);
  assert.match(pMo, /2026年11月 · 月度统计/, '月卡标题');
  assert.match(pMo, /月均速度/);
  assert.match(pMo, /154\.7 t\/s/, '月加权均速（Σout÷Σms）');
  assert.match(pMo, /5 天有记录 \/ 10 次请求/);
  assert.match(pMo, /GLM-A/, '月构成行（Σout 占比）');
  assert.match(pMo, /100%/);
  assert.ok(!pMo.includes('data-i='), '月卡不带 data-i（消费方按悬停定位）');
  histHTML(ctxH, anH, ctxH.__sd, 99);
  assert.equal(portal(ctxH), '', '越界序号不出卡');
  // 日粒度（≤26 周）分支：悬停仍出日卡带 data-i
  const ctxD = makeCtx();
  ctxD.__sd = daysN(177);
  histHTML(ctxD, analyzeAll(ctxD, '__sd'), ctxD.__sd, 176);
  const pDay = portal(ctxD);
  assert.match(pDay, /class="zu-sv-card zu-sv3-card" role="tooltip" data-i="176"/, '日粒度悬停出日卡');
  assert.match(pDay, /117\.6 t\/s/, '今天日均速度（(1000+176)/10）');
  histHTML(ctxD, analyzeAll(ctxD, '__sd'), ctxD.__sd, -1);
  assert.equal(portal(ctxD), '', 'hist 未悬停回空串');
});

// ---------- ⑨ 负向与拼接卫生 ----------
test('负向: 无「功能说明」常驻块；heat 源码无「引号-换行-引号」断链形态', () => {
  const ctx = makeCtx();
  ctx.__h = multiFrame();
  const html = monthHTML(ctx, analyzeMonth(ctx));
  ctx.__sd = days550(0);
  const hist = histHTML(ctx, analyzeAll(ctx, '__sd'), ctx.__sd);
  for (const s of [html, hist]) {
    assert.ok(!s.includes('功能说明'), 'PRD 禁止常驻功能说明条');
    assert.ok(!s.includes('口径说明'), '口径文案不常驻（档位说明走标题栏入口）');
  }
  const hits = [];
  const re = /['"][ \t]*\r?\n[ \t]*['"]/g;
  let m;
  while ((m = re.exec(heat)) !== null) hits.push(heat.slice(Math.max(0, m.index - 40), m.index + 20));
  assert.deepEqual(hits, [], '字符串拼接链断链（丢行尾 +）会经 ASI 静默通过 node --check');
});
