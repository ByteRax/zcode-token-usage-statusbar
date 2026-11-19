'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');
const { readOverlayPart, sliceOverlay } = require('./helpers/overlay-extract.cjs');

// v384 速度 Tooltip V3 热力集成测试（本文件由 v291 V2 热力图测试重写而来，文件名保留）。
// V2 热力构建器（spdMonthHeatmapHTML/spdHistoryHeatmapHTML/spdDayCardHTML）已随 V3 块
// 删除，纯函数级行为由 tests/overlay-speed-v3-heat.test.cjs 锁定；本文件聚焦「经
// spd3RebuildOr 的端到端分发与 DOM 串」：month/all 分发（spd3MonthHTML/spd3HistHTML）、
// 月历数学（补位/闰月/今天/未来/void）、模型色点、截断提示（speed_days.truncated →
// 「已截断」notice）、spd3DayCardHTML 日卡与 SPD_PORTAL 写入纪律——全部走 wire 闭包
// 产物（整卡串含通知行/筛选条/左卡，不只是图表串）。
const core = readOverlayPart('04-speed-v3-core.js');
const view = readOverlayPart('04-speed-v3-view.js');
const charts = readOverlayPart('04-speed-v3-charts.js');
const heat = readOverlayPart('04-speed-v3-heat.js');
const wire = readOverlayPart('04-speed-v3-wire.js');
const bands = sliceOverlay('  var TPS_BANDS = [', '  /* tooltip 颜色对照图例');
const spdHelpers = sliceOverlay('  var SPD_RANGES = [', '  var SPD_PORTAL = "";');

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
  vm.runInContext(bands + '\n' + spdHelpers + '\n' + core + '\n' + view + '\n' +
    charts + '\n' + heat + '\n' + wire, ctx);
  return ctx;
}

const DAY = 864e5;
const K = { a: 'prov_a\x1fglm-a', b: 'prov_b\x1fclaude-b', c: 'prov_c\x1fgemini-c', d: 'prov_d\x1fgpt-d' };
const tOf = (day, h) => new Date(2026, 10, day, h).getTime();

// 绝对时刻列表 → delta 编码轮表帧（纪律同旧 heatmap 测试 histFrom / v3-heat frameFrom）
function frameFrom(abs, opts = {}) {
  abs.sort((a, b) => a.t - b.t);
  let prev = 0;
  const turns = abs.map(r => {
    const o = { s: 0, t: r.t - prev, b: r.b != null ? r.b : r.t - 60000,
      out: r.out, ms: r.ms, i: r.i != null ? r.i : r.out, o: r.out, n: r.n || 1, msl: r.msl };
    prev = r.t;
    if (r.c != null) o.c = r.c;
    if (r.capped) o.capped = 1;
    return o;
  });
  return { sid: 'sess_main', source: 'local', truncated: false,
    sids: ['sess_main'], snames: ['本会话'], pids: [['proj_a', '项目A']],
    mnames: opts.mnames || ['GLM-A'], mkeys: opts.mkeys || [K.a], turns };
}

// 多模型月夹具：11-03 四模型日（400 t/s）、11-04 单模型日（300）、11-05 两轮混合
// （100/1s + 900/3s[600A+300B] → 加权 250 t/s）
function multiFrame() {
  return frameFrom([
    { t: tOf(3, 10), out: 4000, ms: 10000, n: 4,
      msl: [[0, 1000, 2500, 1, 1], [1, 1200, 3000, 1, 1], [2, 800, 2000, 1, 1], [3, 1000, 2500, 1, 1]] },
    { t: tOf(4, 15), out: 3000, ms: 10000, msl: [[0, 3000, 10000, 1, 1]] },
    { t: tOf(5, 9), out: 100, ms: 1000, msl: [[0, 100, 1000, 1, 1]] },
    { t: tOf(5, 10), out: 900, ms: 3000, msl: [[0, 600, 2000, 1, 1], [1, 300, 1000, 1, 1]] },
  ], { mnames: ['GLM-A', 'Claude-B', 'Gemini-C', 'GPT-D'], mkeys: [K.a, K.b, K.c, K.d] });
}

// 550 天 speed_days（spec 上限）：每天 2 轮单模型，日均速度逐日递增
function days550(truncated) {
  const start = new Date(2026, 10, 5).getTime() - 549 * DAY;
  const days = [];
  for (let i = 0; i < 550; i++)
    days.push([1000 + i, 10000, 2, 2, 0, [[0, 1000 + i, 10000, 2, 2]]]);
  return { v: 1, source: 'local', start, days, mnames: ['GLM-A'], mkeys: [K.a], truncated };
}

// wire 入口：spd3RebuildOr → 闭包 → "\x01"+整卡串（含通知行/筛选条/左卡/图表）
function card(ctx, { h, sd, sel, hover, sess, o } = {}) {
  ctx.__h = h === undefined ? null : h;
  ctx.__sd = sd === undefined ? null : sd;
  ctx.__sel = Object.assign({ range: 'all', period: 'month', sid: 'sess_main' }, sel);
  ctx.__hi = typeof hover === 'number' ? hover : -1;
  ctx.__o = o || { fmtTok: String, fmtCnt: String, fmtMoney: u => '¥' + u.toFixed(2) };
  ctx.__sess = Object.assign({ sid: 'sess_main' }, sess);
  const rb = vm.runInContext('spd3RebuildOr(__h, __sd, __sel, __hi, null, __o, __sess)', ctx);
  assert.equal(typeof rb, 'function', 'wire returned a closure');
  ctx.__rb = rb;
  return vm.runInContext('__rb(__hi, __sel)', ctx);
}
const dom = html => html.replace(/<style>[\s\S]*?<\/style>/g, '');
const count = (s, needle) => s.split(needle).length - 1;
const portal = ctx => vm.runInContext('SPD_PORTAL', ctx);
// 取 data-i=i 的格（开标签至首个 </div>；格内只有 span/i 无嵌套 div）
function cellOf(html, i) {
  const m = html.match(new RegExp('<div class="zu-hm-cell[^>]*data-i="' + i + '"[^>]*>'));
  assert.ok(m, 'cell data-i=' + i + ' exists');
  const end = html.indexOf('</div>', m.index);
  return html.slice(m.index, end + 6);
}

// ---------- ① month 经 wire 的网格数学与格状态 ----------
test('month 经 wire: 2026-11 无补位 5 行、今天=档位混底+描边、未来遮罩、void 灰、绝不 0 t/s', () => {
  const ctx = makeCtx();
  const html = dom(card(ctx, { h: multiFrame(), sel: { range: 'all', period: 'month' } }));
  assert.match(html, /class="zu-speed-chart zu-sv-chart zu3-hm"/, 'month 图根类（经 wire 分发）');
  assert.match(html, /--zu-hm-rows:5/, '行数变量（0 前导 + 30 天 = 5 行）');
  assert.equal(count(html, 'zu-hm-pad'), 0, '2026-11-01 周日：无前导补位');
  assert.equal(count(html, 'role="gridcell"'), 30);
  // 今天 11-05 加权 250 t/s（zu-sky 快速档）+ 描边；绝不等于算术平均 200
  const today = cellOf(html, 4);
  assert.match(today, /zu-hm-data/);
  assert.match(today, /zu-sky/);
  assert.match(today, /zu-hm-today/);
  assert.match(today, /zu3-v">250</);
  assert.ok(!/200</.test(today), '加权 250 ≠ 算术平均 200');
  const void1 = cellOf(html, 0);
  assert.match(void1, /zu-hm-void/);
  assert.match(void1, /无有效速度记录/);
  const fut = cellOf(html, 5);
  assert.match(fut, /zu-hm-fut/);
  assert.match(fut, /aria-hidden="true"/);
  assert.equal(count(html, 'zu-hm-fut'), 25, '11-06..30 共 25 个未来日');
  assert.ok(!/均速 0 t\/s|>0<\/span>/.test(html), '绝不伪造 0 t/s');
  // 头部经 wire 同卡输出；v388 §12.6 底部图例整行删除（身份说明并入悬停卡构成行）
  assert.match(html, /zu-sc-head/, '共享图表标题栏');
  assert.match(html, /本月 · 日均生成速度/, 'V3 month 标题');
  assert.doesNotMatch(html, /zu3-lg|颜色标记代表模型/, '多模型产物无图例行（§12.6 整行删除）');
});

test('month 经 wire: 补位/闰月数学（2026-06 首格 1 pad；2024-02 闰月前补 4 空 29 格）', () => {
  const ctx6 = makeCtx(new Date(2026, 5, 15, 10).getTime());
  ctx6.__h = frameFrom([{ t: new Date(2026, 5, 10, 9).getTime(), out: 500, ms: 5000, msl: [[0, 500, 5000, 1, 1]] }]);
  const html6 = dom(card(ctx6, { h: ctx6.__h, sel: { range: 'all', period: 'month' } }));
  assert.equal(count(html6, 'zu-hm-pad'), 1, '2026-06-01 周一：首格 1 枚补位');
  assert.match(html6, /--zu-hm-rows:5/);

  const ctx2 = makeCtx(new Date(2024, 1, 15, 10).getTime());
  ctx2.__h = frameFrom([{ t: new Date(2024, 1, 10, 9).getTime(), out: 500, ms: 5000, msl: [[0, 500, 5000, 1, 1]] }]);
  const html2 = dom(card(ctx2, { h: ctx2.__h, sel: { range: 'all', period: 'month' } }));
  assert.equal(count(html2, 'zu-hm-pad'), 4, '2024-02-01 周四：前补 4 空');
  assert.equal(count(html2, 'role="gridcell"'), 29, '闰年 2 月 29 格');
  assert.match(html2, /--zu-hm-rows:5/);
});

test('month 模型色点经 wire: 四模型日 ≤3 点 + 「+1」、单模型视图整月无点', () => {
  const ctx = makeCtx();
  const html = dom(card(ctx, { h: multiFrame(), sel: { range: 'all', period: 'month' } }));
  const d3 = cellOf(html, 2);
  assert.equal(count(d3, '<span class="zu3-mdot"'), 3, '四模型取 out 前 3');
  assert.match(d3, /zu3-mmore">\+1</, '剩余 +N');
  const today = cellOf(html, 4);
  assert.equal(count(today, '<span class="zu3-mdot"'), 2, '11-05 两模型 → 2 点');

  const ctxS = makeCtx();
  const single = frameFrom([
    { t: tOf(4, 15), out: 3000, ms: 10000, msl: [[0, 3000, 10000, 1, 1]] },
    { t: tOf(5, 9), out: 500, ms: 5000, msl: [[0, 500, 5000, 1, 1]] },
  ]);
  const htmlS = dom(card(ctxS, { h: single, sel: { range: 'all', period: 'month' } }));
  assert.ok(!htmlS.includes('zu3-mdot'), '单模型视图不渲染重复色点');
  assert.ok(!htmlS.includes('zu3-lg') && !htmlS.includes('· 单模型'),
    '单模型产物无图例行（§12.6 整行删除）');
});

// ---------- ② all 经 wire：截断披露 + 通知行（§11.6 月聚合） ----------
test('all 经 wire: 550 天 → 19 月列月聚合，speed_days.truncated → 「已截断」notice 行 + 图表 sub 双披露', () => {
  const ctx = makeCtx();
  // wire 守卫要求轮表在场（h 缺失回退 V1）；sd 与 h 同帧供给（生产门控同源）
  const h = frameFrom([{ t: tOf(5, 9), out: 100, ms: 1000, msl: [[0, 100, 1000, 1, 1]] }]);
  const html = dom(card(ctx, { h, sd: days550(1), sel: { range: 'all', period: 'all' } }));
  assert.match(html, /zu3-hh-mo/, 'all → 历史热力月聚合分支（经 wire 分发）');
  assert.match(html, /zu-sv3-notice">已截断 · 仅显示最近 550 天/,
    '截断经 an.notice 进通知行（spd3NoticeHTML 透传）');
  assert.match(html, /zu-sc-sub zu-hm-sub">按月聚合 · 已截断 · 仅显示最近 550 天</,
    'head sub 同步披露（按月聚合副题，真实图表头）');
  assert.match(html, /data-sv-end="1"/, '首开滚到最新');
  assert.equal(count(html, 'zu-hm-cell'), 19, '月聚合：每月一列（≤19 列无横滚）');
  const lastMo = cellOf(html, 18);
  assert.match(lastMo, /zu-hm-data/, '今天所在月列有数据混底');
  assert.match(lastMo, /zu3-v">154\.7</, '今天月加权均速（Σout÷Σms）一位小数');

  const htmlN = dom(card(ctx, { h, sd: days550(0), sel: { range: 'all', period: 'all' } }));
  assert.ok(!htmlN.includes('已截断'), '未截断无披露');
});

// ---------- ③ 日悬停卡与 SPD_PORTAL 纪律（经 wire 悬停重编） ----------
test('经 wire 悬停: month/all 数据日出日卡（模型明细+轮次+capped）、无数据/越界不出卡', () => {
  const ctx = makeCtx();
  const frame = frameFrom([
    { t: tOf(4, 15), out: 3000, ms: 10000, msl: [[0, 2000, 5000, 2, 2], [1, 1000, 5000, 1, 1]] },
    { t: tOf(5, 9), out: 100, ms: 1000, msl: [[0, 100, 1000, 1, 1]] },
  ], { mnames: ['GLM-A', 'Claude-B'], mkeys: [K.a, K.b] });
  const sel = { range: 'all', period: 'month' };
  // 未悬停：构建即清空侧信道（不残留上一张卡）
  card(ctx, { h: frame, sel });
  assert.equal(portal(ctx), '', '未悬停 = 空串（写入侧每次构建先清）');
  // 悬停今天（11-05 单模型 100 t/s）
  card(ctx, { h: frame, sel, hover: 4 });
  const pToday = portal(ctx);
  assert.match(pToday, /class="zu-sv-card zu-sv3-card" role="tooltip" data-i="4"/, '日卡带 data-i');
  assert.match(pToday, /11\/5（周四）</, '单模型标题无「模型明细」');
  assert.match(pToday, /日均速度/, '行1 日均速度');
  assert.match(pToday, /100 t\/s/);
  // 悬停 11-04（两模型日）：模型明细 + 逐模型轮次
  card(ctx, { h: frame, sel, hover: 3 });
  const p4 = portal(ctx);
  assert.match(p4, /11\/4（周三） · 模型明细/, '多模型标题');
  assert.match(p4, /GLM-A/, '模型行');
  assert.match(p4, /2 轮/, '逐模型轮次（spd3DayMeta tnByDay）');
  // 无数据日/越界序号：不出卡（保持空串）
  card(ctx, { h: frame, sel, hover: 0 });
  assert.equal(portal(ctx), '', 'void 日不出卡');
  card(ctx, { h: frame, sel, hover: 99 });
  assert.equal(portal(ctx), '', '越界序号不出卡');
  // capped 尾注只在 all×all 的日行池可达（capFlag=speed_days 契约 e[4]，轮表行不携带）：
  // 11-04 日行 capFlag=1 → hist 悬停该日出「另有更多模型未列入」
  const start = new Date(2026, 10, 1).getTime();
  const sdCap = { v: 1, source: 'local', start, truncated: 0,
    mnames: ['GLM-A', 'Claude-B'], mkeys: [K.a, K.b],
    days: [
      [100, 1000, 1, 1, 0, [[0, 100, 1000, 1, 1]]],
      [100, 1000, 1, 1, 0, [[0, 100, 1000, 1, 1]]],
      [100, 1000, 1, 1, 0, [[0, 100, 1000, 1, 1]]],
      [3000, 10000, 3, 2, 1, [[0, 2000, 5000, 2, 2], [1, 1000, 5000, 1, 1]]],
      [100, 1000, 1, 1, 0, [[0, 100, 1000, 1, 1]]],
    ] };
  const selAll = { range: 'all', period: 'all' };
  card(ctx, { h: frame, sd: sdCap, sel: selAll, hover: 3 });
  const pCap = portal(ctx);
  assert.match(pCap, /11\/4（周三） · 模型明细/, 'capped 日多模型标题');
  assert.match(pCap, /另有更多模型未列入/, 'capped 日尾注');
  // 550 天月聚合分支：悬停末月列（data-i=18 → 2026-11）出月卡（不带日序 data-i）
  card(ctx, { h: frame, sd: days550(0), sel: selAll, hover: 18 });
  const pMo = portal(ctx);
  assert.match(pMo, /2026年11月 · 月度统计/, '月聚合悬停出月卡');
  assert.match(pMo, /月均速度/);
  assert.match(pMo, /154\.7 t\/s/);
  assert.match(pMo, /5 天有记录 \/ 10 次请求/);
  card(ctx, { h: frame, sd: days550(0), sel: selAll, hover: 99 });
  assert.equal(portal(ctx), '', '月分支越界序号不出卡');
  card(ctx, { h: frame, sd: days550(0), sel: selAll, hover: -1 });
  assert.equal(portal(ctx), '', 'hist 未悬停回空串');
});

// ---------- ④ a11y / i18n（en 桩文案经 wire） ----------
test('a11y 与 i18n: en aria、星期表头、roving tabindex（首格 0 其余 -1，经 wire 整卡）', () => {
  const ctx = makeCtx(FIXED_NOW, 'en');
  const html = dom(card(ctx, { h: multiFrame(), sel: { range: 'all', period: 'month' } }));
  assert.match(cellOf(html, 4), /aria-label="Thu, Nov 5 2026, avg 250 t\/s, Fast, 2 models"/, 'en data-cell aria');
  assert.match(cellOf(html, 0), /no rated speed data/, 'en void aria');
  assert.match(html, /<span>Sun<\/span>/, 'en weekday header');
  // v384 M1 roving tabindex：首个可交互格（11-03, data-i=2）0、其余 -1（方向键移动
  // 由 06/01 keydown 委托承担）；void/未来格不进 Tab 序
  assert.match(cellOf(html, 2), /tabindex="0"/, 'first data cell focusable');
  assert.match(cellOf(html, 4), /tabindex="-1"/, 'later data cells are roving -1');
  assert.equal(count(html, 'tabindex="0"'), 1, 'exactly one tabindex=0 per grid');
  assert.ok(!cellOf(html, 0).includes('tabindex'), 'void cell not in tab order');
  assert.ok(!cellOf(html, 5).includes('tabindex'), 'future cell not in tab order');
  assert.match(html, /aggregated by day/, 'en 聚合粒度 sub');
});
