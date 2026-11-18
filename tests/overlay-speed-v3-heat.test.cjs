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

// ---------- ④ 图例（v388 §12.6/PRD 10.5：整行删除——身份说明并入日/月悬停卡构成行） ----------
test('month 图例: 较低/较高渐变段与右侧模型身份行整行删除（zu3-lg 不再出现在任何产物），档位说明归标题 ⓘ', () => {
  const ctx = makeCtx();
  ctx.__h = multiFrame();
  const html = dom(monthHTML(ctx, analyzeMonth(ctx)));
  assert.doesNotMatch(html, /较低|较高/, '替代档位体系的渐变图例不复存在（PRD 6.3）');
  assert.doesNotMatch(html, /linear-gradient/, '无渐变段');
  assert.doesNotMatch(html, /#ff6b57/, '无最低档实色块');
  // §12.6 负向锁：底部图例整行删除（多模型身份行「颜色标记代表模型」随之退场，
  // 模型身份色点说明并入日悬停卡构成行），产物不得再出现 zu3-lg 结构
  assert.doesNotMatch(html, /zu3-lg/, '多模型 month 产物无 zu3-lg 图例行');
  assert.doesNotMatch(html, /颜色标记代表模型/, '身份行文案已删除（说明走悬停卡）');

  const ctxS = makeCtx();
  ctxS.__h = singleFrame();
  const htmlS = dom(monthHTML(ctxS, analyzeMonth(ctxS)));
  assert.doesNotMatch(htmlS, /zu3-lg/, '单模型 month 产物无 zu3-lg 图例行');
  assert.doesNotMatch(htmlS, /· 单模型/, '单模型身份行文案已删除');
  // 负向锁放大到分片样式与拼接产物：spd3LegendHTML 已删除、.zu3-lg 规则不存在
  assert.ok(!heat.includes('spd3LegendHTML'), '图例构建函数已从 heat 分片删除');
  assert.ok(!heat.includes('zu3-lg'), 'heat 分片源码无 zu3-lg 选择器');
  assert.ok(!readOverlaySource().includes('zu3-lg'), '拼接产物 overlay.js 无 zu3-lg 残留');
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
  assert.doesNotMatch(html, /zu3-lg|· 单模型/, '§12.6 月聚合分支同样无图例行（整行删除）');

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

  // 短历史（池覆盖 11-03..11-05 = 3 天 ≤7）→ v389 §13.4 紧凑日卡形态（.zu3-dc），
  // 不再走周网格：每日一卡（含空日「无记录」灰卡）、无星期行/列头/补位
  const ctxS = makeCtx();
  ctxS.__sd = { v: 1, source: 'local', start: new Date(2026, 10, 3).getTime(),
    days: [[300, 1000, 1, 1, 0, [[0, 300, 1000, 1, 1]]], [0, 0, 0, 0, 0, 0],
      [500, 5000, 1, 1, 0, [[0, 500, 5000, 1, 1]]]],
    mnames: ['GLM-A'], mkeys: [K.a], truncated: 0 };
  const rawS = histHTML(ctxS, analyzeAll(ctxS, '__sd'), ctxS.__sd);
  const htmlS = dom(rawS);
  assert.match(htmlS, /class="zu-speed-chart zu-sv-chart zu3-dc"/, '覆盖 ≤7 天切紧凑日卡（v389 §13.4）');
  assert.match(rawS, /data-head-sub="按日 · 覆盖 3 天"/, '日卡形态副题=覆盖天数');
  assert.equal(count(htmlS, 'zu-hm-cell'), 3, '11-03..11-05 每日一卡（含空日）');
  assert.equal(count(htmlS, 'zu3-dcw'), 3, '每卡周几副标');
  assert.equal(count(htmlS, '<span>周'), 0, '无周列星期行');
  assert.equal(count(htmlS, 'zu-hm-pad'), 0, '日卡形态无补位');
  assert.doesNotMatch(htmlS, /zu3-hh-grid|zu3-cl|--zu3-cols/, '不走周网格（无列头/列数下发）');
  assert.match(cellOf(htmlS, 0), /zu3-dcv">300</, '首日速度大字');
  assert.match(cellOf(htmlS, 1), /zu-hm-void/, '中间空日=灰卡（空=无数据）');
  assert.match(cellOf(htmlS, 1), /zu3-dcnone">无记录</, '空日「无记录」轻字');
  assert.match(cellOf(htmlS, 2), /zu-hm-today/, '今天卡描边');
});

// ---------- ⑤b v388 §12.6 热力密度：≤14 列整块水平居中（zu3-hh-c），>14 列左对齐 ----------
// v390 §14.3：10 天已切日历式（zu3-cal），周列式短档样本改用 57 天（>56 恒周列式、
// 9 列 ≤14）——≤14 居中分档契约本身不变，只换入档样本
test('hist §12.6 列数分档对齐: 短周史（≤14 列）根挂 zu3-hh-c（cols/grid 同规则居中）、>14 列维持 flex-start、短月史同款（8–42/低行数归 §14.3 日历式）', () => {
  const ctx = makeCtx();
  // 短周史 57 天（覆盖 >56 恒周列式）→ 9 列 ≤14：根挂 zu3-hh-c；样式段含居中规则
  ctx.__sd = daysN(57);
  const rawS = histHTML(ctx, analyzeAll(ctx, '__sd'), ctx.__sd);
  assert.match(rawS, /class="zu-speed-chart zu-sv-chart zu3-hh zu3-hh-c"/, '短周史（9 列）根挂 zu3-hh-c');
  assert.doesNotMatch(dom(rawS), /zu3-dc-grid|zu3-cal/, '57 天不走日卡/日历式（归 §13.4/§14.3 边界用例）');
  assert.match(rawS, /\.zu-sv3-root \.zu3-hh-c \.zu3-hh-cols,\.zu-sv3-root \.zu3-hh-c \.zu3-hh-grid\{justify-content:center\}/,
    '居中规则：cols 与 grid 同步 justify-content:center');
  // 26 列（177 天）>14：不挂居中类（flex-start 左对齐，横滚有意义）
  const ctxB = makeCtx();
  ctxB.__sd = daysN(177);
  const rawB = histHTML(ctxB, analyzeAll(ctxB, '__sd'), ctxB.__sd);
  assert.match(rawB, /class="zu-speed-chart zu-sv-chart zu3-hh">/, '26 列不挂 zu3-hh-c（flex-start）');
  // 月聚合短月史：181 天 → 7 月列 ≤14 → 挂 zu3-hh-c；550 天 19 月列 >14 → 不挂
  const ctxM = makeCtx();
  ctxM.__sd = daysN(181);
  const rawM = histHTML(ctxM, analyzeAll(ctxM, '__sd'), ctxM.__sd);
  assert.match(rawM, /zu3-hh-mo zu3-hh-c"/, '短月史（7 月列）同挂 zu3-hh-c');
  const ctxL = makeCtx();
  ctxL.__sd = days550(0);
  const htmlL = dom(histHTML(ctxL, analyzeAll(ctxL, '__sd'), ctxL.__sd));
  // 边界断言（zu3-hh-cols 含 zu3-hh-c 前缀子串，须跟引号/空格才算独立类名）
  assert.doesNotMatch(htmlL, /zu3-hh-c(?=[ "])/, '550 天 19 月列 >14：DOM 不挂居中类');
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

// ---------- v387 MINOR-4：区间文案「全天 / 截至 HH:mm」边界 ----------
test('v387 区间文案: 已结束日=全天；进行中=截至 HH:mm；距末 ≤2 分钟归全天', () => {
  const ctx = makeCtx();
  const day = 24 * 3600000;
  const d0 = new Date(2026, 10, 5).getTime();
  // 已结束：b=次日零点 → 全天
  assert.match(vm.runInContext(`spd3DaySpanTxt(${d0}, ${d0 + day})`, ctx), /全天|All day/);
  // 进行中：b=10:53 → 截至 10:53
  const b2 = d0 + 10 * 3600000 + 53 * 60000;
  assert.match(vm.runInContext(`spd3DaySpanTxt(${d0}, ${b2})`, ctx), /截至 10:53|until 10:53/);
  // 距末 ≤2 分钟：b=23:59:10 → 全天
  const b3 = d0 + day - 50000;
  assert.match(vm.runInContext(`spd3DaySpanTxt(${d0}, ${b3})`, ctx), /全天|All day/);
  // b 缺席/越界（≥次日零点）按全天处理，绝不猜进行中
  assert.match(vm.runInContext(`spd3DaySpanTxt(${d0})`, ctx), /全天|All day/);
});

// ---------- v389 §13.4 day-cards 判定边界（覆盖跨度 7/8 天两态） ----------
test('v389 §13.4/v390 §14.3 day-cards 边界: 池覆盖 7 自然日→紧凑日卡、8 天→七列日历式（轴末恒钳今天，日历跨度判定）', () => {
  // 7 天覆盖（10-30..11-05，含今天）→ zu3-dc：恰 7 卡、无星期行、副题=覆盖 7 天
  const ctx7 = makeCtx();
  ctx7.__sd = daysN(7);
  const raw7 = histHTML(ctx7, analyzeAll(ctx7, '__sd'), ctx7.__sd);
  const html7 = dom(raw7);
  assert.match(html7, /class="zu-speed-chart zu-sv-chart zu3-dc"/, '覆盖 7 天 → 紧凑日卡');
  assert.match(raw7, /data-head-sub="按日 · 覆盖 7 天"/, '副题=覆盖 7 天');
  assert.equal(count(html7, 'zu-hm-cell'), 7, '每天一卡（逐日递增均速）');
  assert.equal(count(html7, 'zu-hm-pad'), 0, '日卡无补位');
  assert.equal(count(html7, '<span>周'), 0, '无周列星期行');
  assert.match(cellOf(html7, 0), /zu3-dcd">10\/30</, '首卡=轴首日（今天−6）');
  assert.match(cellOf(html7, 6), /zu-hm-today/, '末卡=今天描边');
  // 8 天覆盖（10-29..11-05）→ v390 §14.3 七列日历式（zu3-cal），不切日卡也不走周列式
  const ctx8 = makeCtx();
  ctx8.__sd = daysN(8);
  const raw8 = histHTML(ctx8, analyzeAll(ctx8, '__sd'), ctx8.__sd);
  const html8 = dom(raw8);
  assert.match(html8, /class="zu-speed-chart zu-sv-chart zu3-cal"/, '覆盖 8 天 → 七列日历式（§14.3）');
  assert.doesNotMatch(html8, /zu3-dc/, '8 天不切日卡');
  assert.doesNotMatch(html8, /zu3-hh[ "]/, '8 天不走周列式');
  assert.match(raw8, /data-head-sub="按日 · 日历视图"/, '日历式副题');
  assert.match(html8, /--zu-hm-rows:2/, '10-29 周四起 lead=4 → ceil(12/7)=2 行');
  assert.equal(count(html8, 'zu-hm-pad'), 4, '首周 4 补位（10-25..10-28）');
  assert.equal(count(html8, 'zu-hm-cell'), 8, '每天一格');
  assert.equal(count(html8, '<span>周'), 7, '周头 7 列（周日..周六）');
});

// ---------- v389 §13.4 axisA 优先：day-cards 判定读未筛选池时间轴（PRD 5.5 形态稳定） ----------
test('v389 §13.4/v390 §14.3 axisA 优先: spanA 随筛选收缩但 axisA（全池 10 天）在场 → 仍 8–42 天日历式不收缩成日卡；老帧缺 axisA 退化读 spanA → 日卡', () => {
  const ctx = makeCtx();
  // A 模型 10-27..11-05 每天一轮（全池覆盖 10 天）；B 模型只 11-04/11-05 各一轮（2 天）
  const raw = [];
  for (let i = 0; i < 10; i++) {
    const at = new Date(2026, 9, 27 + i, 10).getTime();
    raw.push({ t: at, out: 200, ms: 2000, msl: [[0, 200, 2000, 1, 1]] });
  }
  for (const dd of [4, 5]) {
    const at = new Date(2026, 10, dd, 11).getTime();
    raw.push({ t: at, out: 100, ms: 1000, msl: [[1, 100, 1000, 1, 1]] });
  }
  ctx.__h = frameFrom(raw, { mnames: ['GLM-A', 'Claude-B'], mkeys: [K.a, K.b] });
  // axisA 前提自检：spd3Analyze 产物 axisA=全池首日（10-27）、spanA=筛选后池首日（11-04）
  const anF = vm.runInContext(
    'spd3Analyze(__h, null, {range:"all", period:"all", sid:"", filt:{mode:"sel",keys:[' +
    JSON.stringify(K.b) + ']}})', ctx);
  assert.equal(anF.axisA, new Date(2026, 9, 27, 9, 59).getTime(),
    'axisA=未筛选池首轮 b（10-27 09:59，筛选不收缩时间轴）');
  assert.equal(anF.spanA, new Date(2026, 10, 4, 10, 59).getTime(),
    'spanA=筛选后展示轴首日（11-04，池收缩）');
  // 行为锁：判定读 axisA（10-27..今天 = 10 天，落 §14.3 8–42 档）→ 仍日历式，
  // 不随筛选收缩成日卡（PRD 5.5 覆盖=池时间轴，形态稳定语义 v390 延续）
  const htmlF = dom(histHTML(ctx, anF, ctx.__sd));
  assert.match(htmlF, /class="zu-speed-chart zu-sv-chart zu3-cal"/, 'axisA 宽（10 天）→ 日历式（8–42 天档）');
  assert.doesNotMatch(htmlF, /zu3-dc-grid/, '不随筛选收缩成日卡（PRD 5.5 覆盖=池时间轴）');
  assert.doesNotMatch(htmlF, /zu3-hh[ "]/, '10 天不走周列式');
  assert.equal(count(htmlF, 'zu-hm-data'), 2, '着色仍按筛选：只 11-04/11-05 两格有数据');
  // 老帧缺 axisA/axisB（旧版本快照）：退化读 spanA（11-04 起 2 天 ≤7）→ 日卡
  ctx.__ANF = anF;
  const anNA = vm.runInContext(
    '(function () { var c = JSON.parse(JSON.stringify(__ANF)); delete c.axisA; delete c.axisB; return c; })()', ctx);
  const htmlNA = dom(histHTML(ctx, anNA, ctx.__sd));
  assert.match(htmlNA, /class="zu-speed-chart zu-sv-chart zu3-dc"/, '老帧缺 axisA → 退化读 spanA（2 天）→ 日卡');
  assert.equal(count(htmlNA, 'zu-hm-cell'), 2, '轴首=11-04、轴末=今天 → 2 卡');
  // 再退化（spanA/spanB 也缺）：回退 items 首日（11-04）→ 同为 2 天日卡（旧行为轴）
  const anLegacy = vm.runInContext(
    '(function () { var c = JSON.parse(JSON.stringify(__ANF)); delete c.axisA; delete c.axisB;' +
    ' delete c.spanA; delete c.spanB; return c; })()', ctx);
  const htmlLG = dom(histHTML(ctx, anLegacy, ctx.__sd));
  assert.match(htmlLG, /zu3-dc-grid/, '全缺回退 items 首日（旧行为轴）仍稳定出日卡');
});

// ---------- v390 §14.3 hist 日历式结构（.zu3-cal，8–42 天七列满幅） ----------
test('v390 §14.3 hist 日历式: zu3-cal 结构（7 列 minmax(0,1fr) 满幅、行数 ceil、跨月标记、span 外不渲染、hover/roving 既有契约）', () => {
  const ctx = makeCtx();
  ctx.__sd = daysN(10);   // 10-27(周二)..11-05，lead=2 → rows=2
  const an = analyzeAll(ctx, '__sd');
  const raw = histHTML(ctx, an, ctx.__sd);
  const html = dom(raw);
  assert.match(html, /class="zu-speed-chart zu-sv-chart zu3-cal"/, '日历式根类');
  assert.match(raw, /data-head-sub="按日 · 日历视图"/, '副题=按日 · 日历视图');
  assert.match(html, /--zu-hm-rows:2/, '行数=ceil((lead+跨度)/7)=ceil(12/7)=2');
  // 7 列满幅：网格=month 同款 repeat(7,minmax(0,1fr))（无周列式 34–64px 列帽形态）
  assert.match(raw, /\.zu-sv3-root \.zu3-hm-grid\{[^}]*grid-template-columns:repeat\(7,minmax\(0,1fr\)\)/,
    '7 列 minmax(0,1fr) 满幅（消除列帽下短跨度两侧大空白）');
  assert.equal(count(html, '<span>周'), 7, '周头 7 列（周日..周六）');
  assert.ok(!html.includes('zu3-cl'), '无周列式列头（64px 列帽形态不回归）');
  assert.ok(!html.includes('--zu3-cols'), '无周列式列数下发');
  // 格账本：2 前导补位 + 10 span 内格（全有数据）+ 末行 2 未来槽留白（span 外不渲染）
  assert.equal(count(html, 'zu-hm-pad'), 2, '首周前 2 格补位（10-25/10-26，邻周占位不可交互）');
  assert.equal(count(html, 'zu-hm-cell'), 10, 'span 内逐格渲染');
  assert.equal(count(html, 'zu-hm-void'), 0, 'daysN 逐日有数据');
  assert.equal(count(html, 'role="row"'), 2, '每自然周一行');
  // 跨月标记：11-01（data-i=5）日号带月前缀；普通日裸日号
  assert.match(cellOf(html, 5), /zu3-d">11\/1</, '跨月首日带 M/D 标记');
  assert.match(cellOf(html, 0), /zu3-d">27</, '普通日裸日号');
  assert.match(cellOf(html, 9), /zu-hm-today/, '末格=今天描边');
  // roving tabindex：首个数据格 0、其余 -1（方向键由宿主 keydown 委托承担）
  assert.match(cellOf(html, 0), /tabindex="0"/);
  assert.match(cellOf(html, 1), /tabindex="-1"/);
  assert.match(cellOf(html, 9), /tabindex="-1"/);
  // aria 沿既有契约：完整日期 + 均速档位（绝不 0 t/s）
  assert.match(cellOf(html, 9), /aria-label="2026年11月5日 周四，均速 [\d.]+ t\/s，[^"]+"/);
  // 悬停日卡：SPD_PORTAL 侧信道（无数据日/越界序号=空串，既有契约）
  ctx.__an = an; ctx.__sdh = ctx.__sd; ctx.__hi = 5;
  vm.runInContext('spd3HistHTML(__an, __sdh, __hi)', ctx);
  assert.match(portal(ctx), /data-i="5"/, '悬停出日卡（data-i 平铺序，补位不占号）');
  assert.match(portal(ctx), /<b>11\/1（周日）<\/b>/, '日卡=跨月首日（标题紧凑日期）');
  assert.match(portal(ctx), /2026\/11\/1 · 全天/, '日卡日期行=完整日期');
  vm.runInContext('spd3HistHTML(__an, __sdh, -1)', ctx);
  assert.equal(portal(ctx), '', '未悬停回空串');
  vm.runInContext('spd3HistHTML(__an, __sdh, 99)', ctx);
  assert.equal(portal(ctx), '', '越界序号不出卡');
});

// ---------- v390 §14.3 密度选择器阈值（四档 + 月聚合不变） ----------
test('v390 §14.3 密度选择器阈值: ≤7 日卡 / 8–42 日历 / 43–56 按覆盖周数（≤8 日历否则周列）/ >56 周列 / >26 周列月聚合', () => {
  // 夹具轴末恒钳今天（2026-11-05 周四）：各跨度首日星期确定 → 周数/形态确定
  // 43 天=09-24 周四 lead4 → 7 行；50 天=09-17 周四 lead4 → 8 行（≤8 上沿）；
  // 55 天=09-12 周六 lead6 / 56 天=09-11 周五 lead5 → 9 行 >8 → 周列式
  const shapeOf = n => {
    const c = makeCtx();
    c.__sd = daysN(n);
    const h = dom(histHTML(c, analyzeAll(c, '__sd'), c.__sd));
    if (h.includes('zu3-dc')) return 'dc';
    if (h.includes('zu3-cal')) return 'cal';
    if (h.includes('zu3-hh-mo')) return 'mo';
    if (h.includes('zu3-hh')) return 'hh';
    return '?';
  };
  assert.equal(shapeOf(7), 'dc', '≤7 → 紧凑日卡（§13.4）');
  assert.equal(shapeOf(8), 'cal', '8 → 日历式（SPD3_HIST_CAL_MAX_DAYS 档下沿）');
  assert.equal(shapeOf(42), 'cal', '42 → 日历式（跨度上沿）');
  assert.equal(shapeOf(43), 'cal', '43 → 覆盖自然周 7 行 ≤8 仍日历（防纵挤）');
  assert.equal(shapeOf(50), 'cal', '50 → 覆盖自然周 8 行（SPD3_HIST_CAL_WEEKS 上沿）仍日历');
  assert.equal(shapeOf(55), 'hh', '55 → 覆盖自然周 9 行 >8 → 周列式');
  assert.equal(shapeOf(56), 'hh', '56 → 覆盖自然周 9 行 → 周列式');
  assert.equal(shapeOf(57), 'hh', '57 → 恒周列式');
  assert.equal(shapeOf(177), 'hh', '177 → 周列式 26 列（既有，§12.6 样本）');
  assert.equal(shapeOf(181), 'mo', '181 → 27 列 >26 切月聚合（既有）');
  assert.equal(shapeOf(550), 'mo', '550 → 月聚合（既有，spec 上限）');
});
