'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');
const { readOverlayPart, sliceOverlay, readOverlaySource } = require('./helpers/overlay-extract.cjs');

// v384 速度 Tooltip V3 视图层：04-speed-v3-view.js 全文 + 04-speed-v3-core.js 全文进 VM，
// 存活符号切片取自 worktree 根 overlay.js（specs/speed-tooltip-v3.md §0：这些函数在 V3
// 集成后保留——TPS_BANDS/tpsBand/tpsBandText + spd* 基础助手）。切片边界对齐
// overlay-speed-v3-core.test.cjs 的手写锚点纪律。
const core = readOverlayPart('04-speed-v3-core.js');
const view = readOverlayPart('04-speed-v3-view.js');
const bands = sliceOverlay('  var TPS_BANDS = [', '  /* tooltip 颜色对照图例');
const spdHelpers = sliceOverlay('  var SPD_RANGES = [', '  var SPD_PORTAL = "";');
const spdCompact = sliceOverlay('  function spdCompactRange(a, b) {', '  var SPD_PORTAL = "";');

// 冻结时钟 2026-11-05 14:00 本地：视图自身不读 Date，但 core 的 today/week/month 窗与
// month 日历都依赖 Date.now()，夹具必须钉死同一时刻（真实 Date 是假绿灯）。
const FIXED_NOW = new Date(2026, 10, 5, 14, 0, 0).getTime();
function makeCtx(lang = 'zh') {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [FIXED_NOW])); }
    static now() { return FIXED_NOW; }
  }
  const ctx = vm.createContext({
    // SPD_L 桩直接实现真实 L 逻辑（zh/en 按实例语言二选一）
    L: (zh, en) => (lang === 'en' ? en : zh),
    Date: FakeDate, Math, JSON, isFinite, parseInt, parseFloat, Object, Array, String, Number,
  });
  vm.runInContext(bands + '\n' + spdHelpers + '\n' + spdCompact + '\n' + core + '\n' + view, ctx);
  return ctx;
}

const HOUR = 3600000;
const KEYS = { a: 'prov_a\x1fglm-a', b: 'prov_b\x1fclaude-b' };
const host = x => JSON.parse(JSON.stringify(x));
const stripStyle = html => html.replace(/<style>[\s\S]*?<\/style>/g, '');

// 主夹具（与 core 测试同形）：3 会话 / 2 项目 / 跨日跨月；msl 全四元组。
function fixture(opts = {}) {
  const d = (day, h) => new Date(2026, 10, day, h).getTime();
  const t0 = d(5, 9);
  const yester = d(4, 15);
  const lastMonth = new Date(2026, 9, 5, 10).getTime();
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
  const h = { sid: 'sess_main', source: 'local', truncated: false,
    sids: ['sess_main', 'sess_proj2', 'sess_other'],
    snames: ['本会话', '同项目另一会话', '别的项目'],
    pids: [['proj_a', '项目A'], ['proj_a', '项目A'], ['proj_b', '项目B']],
    mnames: ['GLM-A', 'Claude-B'], turns };
  if (opts.mkeys !== false) h.mkeys = [KEYS.a, KEYS.b];
  if (opts.names) { h.mnames = opts.names; h.mkeys = opts.keys; }
  return h;
}

// 旧代夹具：msl 二元组 → msAvail=false 降级模式
function fixtureLegacy() {
  const t0 = new Date(2026, 10, 5, 9).getTime();
  const raw = [
    [0, t0, t0 - 60000, 100, 1000, 500, 100, 1, [[0, 100]], 0.01, 1],
    [0, t0 + HOUR, t0 + HOUR - 60000, 400, 8000, 4000, 400, 1, [[1, 400]], 0.04, 1],
  ];
  let prev = 0;
  const turns = raw.map(r => {
    const o = { s: 0, t: r[1] - prev, b: r[2], out: r[3], ms: r[4], i: r[5], o: r[6], n: r[7], msl: r[8] };
    prev = r[1];
    o.c = r[9]; o.cf = 1;
    return o;
  });
  return { sid: 'sess_main', source: 'local', truncated: false, sids: ['sess_main'], snames: ['S'],
    pids: [['p', 'P']], mnames: ['GLM-A', 'Claude-B'], turns, mkeys: [KEYS.a, KEYS.b] };
}

// 多模型夹具：count 个模型各一轮，请求数 (i%3)+1 → 互异 share（1/15、2/15、3/15 档）。
function multiFixture(count) {
  const t0 = new Date(2026, 10, 5, 9).getTime();
  const mnames = [], mkeys = [], turns = [];
  let prev = 0;
  for (let i = 0; i < count; i++) { mnames.push('Model-' + i); mkeys.push('p\x1fm' + i); }
  for (let i = 0; i < count; i++) {
    const abs = t0 + i * 60000, nreq = (i % 3) + 1;
    turns.push({ s: 0, t: abs - prev, b: abs - 30000, out: 100 * (i + 1), ms: 1000,
      i: 80, o: 100 * (i + 1), n: nreq, msl: [[i, 100 * (i + 1), 1000, nreq]] });
    prev = abs;
  }
  return { sid: 'sess_main', source: 'local', truncated: false, sids: ['sess_main'], snames: ['S'],
    pids: [['p', 'P']], mnames, mkeys, turns };
}

function analyze(ctx, h, sel) {
  ctx.__h = h;
  ctx.__s = sel || {};
  return vm.runInContext('spd3Analyze(__h, null, __s)', ctx);
}
function cardHTML(ctx, an, sel, extra = {}) {
  ctx.__an = an;
  ctx.__c = Object.assign({ sel: sel || {}, hover: -1, live: null, o: {}, expanded: false, pop: null }, extra);
  return vm.runInContext('spd3CardHTML(__an, __c)', ctx);
}

// ---------- ① 整卡结构锁 ----------
test('spd3CardHTML 结构锁: 根类/data-sv-key/双 Tab 组/chips/单多左卡互斥/CHART 占位/通知行按需渲染', () => {
  const ctx = makeCtx();
  const h = fixture();
  const sel = { range: 'session', period: 'all', sid: 'sess_main' };
  const an = analyze(ctx, h, sel);
  const html = cardHTML(ctx, an, sel);
  assert.match(html, /class="zu-sv3-root" data-sv-key="session\|all\|auto"/, '根类 + 范围|时间|筛选签名键');
  const dom = stripStyle(html);
  // 头部双 Tab 组：range 4 枚 + 容器、period 5 枚 + 容器；各组恰一枚 on
  assert.equal((dom.match(/data-sv-group="range"/g) || []).length, 5);
  assert.equal((dom.match(/data-sv-group="period"/g) || []).length, 6);
  assert.equal((dom.match(/class="zu-sv-tab on"/g) || []).length, 2, 'range/period 各恰一枚选中');
  assert.match(dom, /data-sv-val="session" aria-pressed="true"/);
  assert.match(dom, /data-sv-val="all" aria-pressed="true"/);
  assert.match(dom, /data-sv-val="recent" aria-pressed="false"/);
  // auto 筛选：2 枚 chips 全部非 on
  assert.equal((dom.match(/class="zu-sv3-chip"/g) || []).length, 2, 'auto 下 chips 无选中态');
  // 计数行三语义统一（§11.5）：已选 X/Y（auto 时 X=Y）· 本期有效 N（an.perModel.length）
  assert.match(dom, /zu-sv3-fcount">已选 2\/2 · 本期有效 2</);
  /* §14.1：搜索按钮整链退役（入口=「模型筛选」标签 + +N 两枚 fopen button） */
  assert.doesNotMatch(dom, /zu-sv3-fsearch/, 'fsearch 按钮不渲染（§14.1 退役）');
  // 多模型左卡（§11.3）：主数字恒在 → 档位胶囊 → 本期有效计数行 → 分布表，无「唯一模型」
  assert.match(dom, /zu-sv3-main-num"><span class="[a-z-]+">\d/, '多模型主数字恒在（非 —）');
  assert.match(dom, /本期有效 2 个模型 · 3 轮/);
  assert.doesNotMatch(dom, /已选 \d+ 个模型/, '旧「已选 N 个模型」计数行已被本期有效语义替换');
  assert.match(dom, /zu-sv3-dtab/);
  assert.match(dom, /所选模型分布 · 按请求数/);
  assert.doesNotMatch(dom, /唯一模型/);
  assert.doesNotMatch(dom, /zu-sv3-cov/, '覆盖范围五值只在单模型态');
  // 图表占位原样保留（bare data-sv3-chart 属性，集成方经 [data-sv3-chart] 替换占位）
  assert.match(html, /class="zu-speed-chart zu-sv3-chart" data-sv3-chart><!--CHART--><\/div>/);
  // 无 notice 不渲染通知行
  assert.ok(!dom.includes('zu-sv3-notice'), '无通知不渲染常驻行');
  // 单模型态（只选 B）：互斥——无分布表/分布条，有唯一模型行。本层直调的 chips 池
  // 缺省=an.perModel（恰 B 一个）→ poolSingle=true；wire 集成传全量池时筛选缩到
  // 单模型不冒充「唯一模型」（§11.5 真单模型池语义，wire/v2 测试锁另一态）。
  const selB = { range: 'session', period: 'all', sid: 'sess_main', filt: { mode: 'sel', keys: [KEYS.b] } };
  const anB = analyze(ctx, h, selB);
  const domB = stripStyle(cardHTML(ctx, anB, selB));
  assert.match(domB, /唯一模型/);
  assert.match(domB, /zu-sv3-main-num/);
  assert.doesNotMatch(domB, /zu-sv3-dtab/, '单模型态无分布表（PRD 6.3）');
  assert.doesNotMatch(domB, /zu-sv3-dbar/, '单模型态无分布条');
  assert.doesNotMatch(domB, /已选 \d+ 个模型/, '单模型态无多模型计数行');
  // 通知行：远端降级提示只在有 notice 时出现
  const selR = { range: 'all', period: 'all', sid: 'sess_main', remote: true };
  const anR = analyze(ctx, h, selR);
  const domR = stripStyle(cardHTML(ctx, anR, selR));
  assert.match(domR, /class="zu-sv3-notice">[^]*远端会话仅显示本会话历史/);
  // chips on 态：显式选 A + 全量 chips 池（ctx.pool，集成方契约）→ A on、B 可点回、计数「已选 1/2」
  const selA = { range: 'session', period: 'all', sid: 'sess_main', filt: { mode: 'sel', keys: [KEYS.a] } };
  const anA = analyze(ctx, h, selA);
  const fullPool = [{ key: KEYS.a, name: 'GLM-A', n: 3 }, { key: KEYS.b, name: 'Claude-B', n: 1 }];
  const domA = stripStyle(cardHTML(ctx, anA, selA, { pool: fullPool }));
  assert.match(domA, /class="zu-sv3-chip on" data-k="prov_a\x1fglm-a" aria-pressed="true"/, 'A chip on');
  assert.match(domA, /data-k="prov_b\x1fclaude-b" aria-pressed="false"/, 'B chip 可点回');
  assert.equal((domA.match(/class="zu-sv3-chip on"/g) || []).length, 1, '恰一枚 chip on');
  assert.match(domA, /已选 1\/2/, '计数按全量池分母');
  // §11.4 空态：real 空 → view 接管图表区（<!--CHART--> 占位被替换、charts 空态退场），
  // emptyReason 按 core 分类，data-sv3-act 动作按钮按门控出现
  const selGhost = { range: 'session', period: 'today', sid: 'sess_main',
    filt: { mode: 'sel', keys: ['ghost\x1fmodel'] } };
  const domG = stripStyle(cardHTML(ctx, analyze(ctx, h, selGhost), selGhost));
  assert.match(domG, /class="zu-sv3-empty" role="status"/, 'view 空态接管 charts 空态');
  assert.doesNotMatch(domG, /<!--CHART-->/, '空态不保留图表占位（wire replace 自然落空）');
  assert.doesNotMatch(domG, /当前筛选无有效速度数据/, 'charts 层空态文案随接管退场');
  assert.match(domG, /zu-sv3-empty-t">暂无生成速度数据/);
  assert.match(domG, /zu-sv3-empty-r">已选模型在当前范围暂无有效速度记录/, 'emptyReason 按池构成分类');
  assert.match(domG, /data-sv3-act="clear-filter">清除模型筛选</);
  assert.match(domG, /data-sv3-act="all-time">查看全部时间</, 'period≠all → all-time 在场');
  // 门控矩阵：period=all → 只 clear-filter；无筛选时间窗空 → 只 all-time
  const selGA = { range: 'session', period: 'all', sid: 'sess_main',
    filt: { mode: 'sel', keys: ['ghost\x1fmodel'] } };
  const domGA = stripStyle(cardHTML(ctx, analyze(ctx, h, selGA), selGA));
  assert.match(domGA, /data-sv3-act="clear-filter"/);
  assert.doesNotMatch(domGA, /data-sv3-act="all-time"/, 'period=all 无 all-time 动作');
  const y2 = new Date(2026, 10, 4, 15).getTime();
  const hPast = { sid: 'sess_main', source: 'local', truncated: false, sids: ['sess_main'],
    snames: ['本会话'], pids: [['proj_a', '项目A']], mnames: ['GLM-A'], mkeys: [KEYS.a],
    turns: [{ s: 0, t: y2, b: y2 - 60000, out: 500, ms: 5000, i: 400, o: 500, n: 1,
      msl: [[0, 500, 5000, 1]], c: 0.03, cf: 1 }] };
  const selPast = { range: 'session', period: 'today', sid: 'sess_main' };
  const domP = stripStyle(cardHTML(ctx, analyze(ctx, hPast, selPast), selPast));
  assert.match(domP, /zu-sv3-empty-r">当前会话暂无已完成请求/, '无筛选空态 reason=会话无已完成请求');
  assert.match(domP, /data-sv3-act="all-time"/);
  assert.doesNotMatch(domP, /data-sv3-act="clear-filter"/, '无显式筛选无 clear-filter');
  // 两链源码锁（§11.4）：06 全量链与 01 精简链的 closest 白名单、mousedown 名单、
  // 委托分支（clear-filter → spd3FilterAll；all-time → period="all"）
  const src = readOverlaySource();
  assert.equal((src.match(/\[data-sv3-more\],\[data-sv3-act\]/g) || []).length, 2,
    '06/01 两链 closest 白名单补 data-sv3-act');
  assert.equal((src.match(/closest\("\.zu-sv3-empty-wrap"\)/g) || []).length, 2,
    '06/01 两链 mousedown 名单补空态块');
  assert.equal((src.match(/act\d === "clear-filter"\) spd3FilterAll\(/g) || []).length, 2,
    '06/01 委托分支 clear-filter → spd3FilterAll');
  assert.equal((src.match(/act\d === "all-time"\) \{\s*\n\s*\w+\.period = "all";/g) || []).length, 2,
    '06/01 委托分支 all-time → period="all"');
});

// ---------- ② 单模型五态标题 + 本期统计（覆盖范围单值 kv，M4/m3） ----------
test('单模型左卡: 五 period 标题文案、主数字/档位/模型行/本期统计组、覆盖范围单值 kv、日均标签切换', () => {
  const ctx = makeCtx();
  const h = fixture();
  const wantCov = { recent: '最近 \\d+ 轮', today: '今天', week: '近 7 天', month: '本月', all: '全部历史' };
  for (const period of ['recent', 'today', 'week', 'month', 'all']) {
    const sel = { range: 'session', period, sid: 'sess_main', filt: { mode: 'sel', keys: [KEYS.a] } };
    const dom = stripStyle(cardHTML(ctx, analyze(ctx, h, sel), sel));
    const want = { recent: /最近 \d+ 轮平均速度/, today: /今天平均速度/, week: /近 7 天平均速度/,
      month: /本月平均速度/, all: /历史平均速度/ }[period];
    assert.match(dom, want, 'period=' + period + ' 左卡标题');
    assert.match(dom, /zu-sv3-main-num/, 'period=' + period + ' 主数字在场');
    assert.match(dom, /唯一模型/);
    // m3：「本期统计」组标题 + 请求轮次/覆盖范围 kv（§12.2「当前模型」行去重见 fmtTok 用例）
    assert.match(dom, /zu-sv3-cov-h">本期统计</, 'period=' + period + ' 本期统计组标题');
    assert.match(dom, /请求轮次/);
    assert.match(dom, /覆盖范围/, 'period=' + period + ' 覆盖范围块');
    assert.ok(!dom.includes('zu-sv3-cov-set'), 'period=' + period + ' 五值 set 已废除');
    // 覆盖范围=单值 kv，随 an.period 直读本视图（recent 的 N=items.length）
    assert.match(dom, new RegExp('覆盖范围</i><b>' + wantCov[period] + '</b>'),
      'period=' + period + ' 覆盖范围单值=' + wantCov[period]);
    // §12.2「当前模型」行去重：真单模型池与模型行 Chip 恒完全同名；本层 ctx 无 fmtTok
    // （cardHTML 默认 o={}）→ 整行省略，不虚构格式化值
    assert.ok(!dom.includes('当前模型'), 'period=' + period + ' 无 fmtTok：当前模型行整行省略');
    assert.ok(!dom.includes('有效输出'), 'period=' + period + ' 无 fmtTok：不出现有效输出行');
  }
  // §12.2 wire 夹具带 fmtTok（spd3CardHTML ctx.o 透传 spd3LeftHTML 第 5 参）：
  // 「当前模型」行替换为「有效输出 Σ有效输出 token」（值=overall.out 经 fmtTok）
  const selFmt = { range: 'session', period: 'all', sid: 'sess_main', filt: { mode: 'sel', keys: [KEYS.a] } };
  const anFmt = analyze(ctx, h, selFmt);
  const domFmt = stripStyle(cardHTML(ctx, anFmt, selFmt, { o: { fmtTok: v => 'T' + v } }));
  assert.ok(!domFmt.includes('当前模型'), '真单模型池+fmtTok：当前模型行被去重替换');
  assert.match(domFmt, /有效输出<\/i><b>T1700<\/b>/, '有效输出=overall.out（A 池 Σout=1700）经 fmtTok');
  // 非真单模型池（筛选缩到单模型，ctx.pool 全量池）→ 保留「当前模型」原名不去重
  const fullPool2 = [{ key: KEYS.a, name: 'GLM-A', n: 3 }, { key: KEYS.b, name: 'Claude-B', n: 1 }];
  const domKeep = stripStyle(cardHTML(ctx, anFmt, selFmt, { pool: fullPool2, o: { fmtTok: v => 'T' + v } }));
  assert.match(domKeep, /当前模型<\/i><b title="GLM-A">GLM-A<\/b>/, '筛选缩到单模型不冒充真单模型池，保留原名');
  // 请求轮次 = overall.turns（session/all A 恰 3 轮；zh 文案无前导空格）
  const selA = { range: 'session', period: 'all', sid: 'sess_main', filt: { mode: 'sel', keys: [KEYS.a] } };
  const domTurns = stripStyle(cardHTML(ctx, analyze(ctx, h, selA), selA));
  assert.match(domTurns, /请求轮次<\/i><b>3轮<\/b>/, '请求轮次=overall.turns');
  // an.cov 契约废除：残留 cov 字段不被消费（不渲染任何数值）
  const anCov = Object.assign({}, analyze(ctx, h, selA), { cov: { recent: 18, all: 42 } });
  const domCov = stripStyle(cardHTML(ctx, anCov, selA));
  assert.ok(!domCov.includes('zu-sv3-cov-set'), 'an.cov 不再消费（无 cov-set 结构）');
  assert.ok(!/<b>42<\/b>/.test(domCov), 'plant 的 cov 数值不落串');
  // unit=day → 日均标签；unit=turn → 峰值/最低/最新
  const selAll = { range: 'session', period: 'all', sid: 'sess_main', filt: { mode: 'sel', keys: [KEYS.a] } };
  const domDay = stripStyle(cardHTML(ctx, analyze(ctx, h, selAll), selAll));
  assert.match(domDay, /最高日均/);
  assert.match(domDay, /最低日均/);
  assert.match(domDay, /最近日均/);
  const selRec = { range: 'session', period: 'recent', sid: 'sess_main', filt: { mode: 'sel', keys: [KEYS.b] } };
  const domTurn = stripStyle(cardHTML(ctx, analyze(ctx, h, selRec), selRec));
  assert.match(domTurn, /zu-sv3-stat"><i>峰值<\/i>/);
  assert.match(domTurn, /zu-sv3-stat"><i>最低<\/i>/);
  assert.match(domTurn, /zu-sv3-stat"><i>最新<\/i>/);
  assert.ok(!domTurn.includes('日均'), 'turn 粒度不出现日均词');
  // 主数字档位色：filt[B] 会话/全部 = 300 t/s → zu-azure
  assert.match(domTurn, /zu-sv3-main-num"><span class="zu-azure">300<\/span>/);
  // 实时状态词 = 标题行右侧轻量徽标
  const domLive = stripStyle(cardHTML(ctx, analyze(ctx, h, selRec), selRec, { live: { statusText: '生成中' } }));
  assert.match(domLive, /zu-sv3-sub">生成中<\/span>/);
});

// ---------- ③ 多模型分布 ----------
// §12.2 分布表切片：table→div Grid 后无 </table>，取 zu-sv3-dtab 起、到其后首个
// zu-sv3-stats（峰/低/新组恒在场）止——只含表头 + 数据行
const tabSlice = d => d.slice(d.indexOf('zu-sv3-dtab'), d.indexOf('zu-sv3-stats'));
test('多模型分布: share 数据级和=1、显示占比和=100%、行序按 share 降序、>6 折叠+展开、降级两列无 t/s', () => {
  const ctx = makeCtx();
  const h8 = multiFixture(8);
  const sel = { range: 'session', period: 'all', sid: 'sess_main' };
  const an = analyze(ctx, h8, sel);
  assert.equal(an.perModel.length, 8);
  let sum = 0;
  for (const e of an.perModel) sum += e.share;
  assert.ok(Math.abs(sum - 1) < 1e-9, '数据级 share 和恰为 1');
  // 折叠态（§11.3）：默认 ≤4 行 + 「查看全部 8 个模型」；主数字恒在；chips 3 枚 + 「+5」（§12.4 预算 3）
  const dom = stripStyle(cardHTML(ctx, an, sel));
  const tab = tabSlice(dom);
  assert.equal((tab.match(/zu-sv3-drow/g) || []).length, 5, 'Grid 表头 + 4 行（DEF_ROWS=4）');
  assert.match(dom, /<button type="button" class="zu-sv3-more" data-sv3-more aria-expanded="false">查看全部 8 个模型</);
  assert.match(dom, /zu-sv3-main-num"><span class="[a-z-]+">\d/, '多模型主数字恒在（§11.3 折叠态）');
  assert.match(dom, /本期有效 8 个模型 · 8 轮/, '本期有效计数行');
  // §14.1：+N 为弹出层入口真 button（data-sv3-fopen，关闭态 aria-expanded=false）
  assert.match(dom,
    /<button type="button" class="zu-sv3-chip-more" data-sv3-fopen aria-haspopup="dialog" aria-expanded="false" title="其余 5 个模型，可搜索查看" aria-label="还有 5 个未展示模型，点击查看和筛选">\+5<\/button>/,
    'chips 常驻 3 枚超出收 +N button（§12.4/§14.1）');
  assert.ok(!dom.includes('zu-sv3-fsearch'), 'fsearch 放大镜按钮已退役（§14.1：入口=+N/模型筛选标签）');
  // 行序：share 降序；同 share 内保持 perModel（Σ输出降序）稳定序。
  // 折叠窗只看前 4 行（3/15 档：Model-5 out600 → Model-2 out300；2/15 档前两枚）
  assert.ok(tab.indexOf('Model-5') >= 0 && tab.indexOf('Model-5') < tab.indexOf('Model-2') &&
    tab.indexOf('Model-2') < tab.indexOf('Model-7') && tab.indexOf('Model-7') < tab.indexOf('Model-4'),
    '折叠态前 4 行按请求数占比降序（同档稳定）');
  // 展开态：8 行全显（dwrap 150px 内滚不撑高）+ 占比显示和 = 100%
  const domX = stripStyle(cardHTML(ctx, an, sel, { expanded: true }));
  const tabX = tabSlice(domX);
  assert.equal((tabX.match(/zu-sv3-drow/g) || []).length, 9, 'Grid 表头 + 8 行');
  assert.match(domX, /data-sv3-more/);
  assert.match(domX, /aria-expanded="true"/);
  assert.match(domX, /zu-sv3-more"[^>]*>收起</, '展开态按钮切「收起」');
  // 完整行序（8 行）：3/15 档 → 2/15 档 → 1/15 档，档内按 Σ输出降序稳定
  assert.ok(tabX.indexOf('Model-5') < tabX.indexOf('Model-2') &&
    tabX.indexOf('Model-2') < tabX.indexOf('Model-7') && tabX.indexOf('Model-7') < tabX.indexOf('Model-4') &&
    tabX.indexOf('Model-4') < tabX.indexOf('Model-1') && tabX.indexOf('Model-1') < tabX.indexOf('Model-6') &&
    tabX.indexOf('Model-6') < tabX.indexOf('Model-3') && tabX.indexOf('Model-3') < tabX.indexOf('Model-0'),
    '展开态 8 行完整降序（同档稳定）');
  const pcts = [...tabX.matchAll(/zu-sv3-pct"[^>]*>([\d.]+)%</g)].map(m => parseFloat(m[1]));   // v388 M1 role 属性插在 class 后
  assert.equal(pcts.length, 8);
  const pctSum = pcts.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(pctSum - 100) < 0.2, '显示占比和=100%，实得 ' + pctSum);
  // §12.2 div Grid 串锁：三列模板 minmax(0,1fr) 64px 44px（名称可收缩+ellipsis → 行恒
  // 不溢出，根除旧 table 23px 横向溢出）+ role=table + 全产物无 tr/th/td 语义
  const styleOf = html => html.match(/<style>[\s\S]*?<\/style>/)[0];
  assert.match(styleOf(cardHTML(ctx, an, sel)),
    /\.zu-sv3-drow\{display:grid;grid-template-columns:minmax\(0,1fr\) 64px 44px/,
    '分布表三列 Grid 模板（§12.2）');
  assert.match(dom, /<div class="zu-sv3-dtab" role="table">/, 'Grid 表带 role=table');
  assert.doesNotMatch(dom, /<tr>|<th>|<td>/, '旧 table 语义已由 div Grid 替代');
  // 表头三列 dcell：模型/均速/占比（数字列右对齐 zu-sv3-dnum）
  assert.match(dom,
    /<span class="zu-sv3-dcell" role="columnheader">模型<\/span><span class="zu-sv3-dcell zu-sv3-dnum" role="columnheader">均速<\/span><span class="zu-sv3-dcell zu-sv3-dnum" role="columnheader">占比<\/span>/,
    'Grid 表头三列：模型/均速/占比（v388 M1 ARIA 角色）');
  // 降级模式（msAvail=false）：均速列隐藏（两列变体 .zu-sv3-dtab-noms），表格内无 t/s
  const anL = analyze(ctx, fixtureLegacy(), { range: 'session', period: 'all', sid: 'sess_main' });
  assert.equal(anL.msAvail, false);
  const htmlL = cardHTML(ctx, anL, { range: 'session', period: 'all', sid: 'sess_main' });
  const domL = stripStyle(htmlL);
  const tabL = tabSlice(domL);
  assert.match(htmlL, /\.zu-sv3-dtab\.zu-sv3-dtab-noms \.zu-sv3-drow\{grid-template-columns:minmax\(0,1fr\) 44px\}/,
    'msAvail=false 两列 Grid 变体（去均速列）');
  assert.match(domL, /zu-sv3-dtab zu-sv3-dtab-noms/, '降级表挂两列变体类');
  assert.match(tabL, /<span class="zu-sv3-dcell" role="columnheader">模型<\/span><span class="zu-sv3-dcell zu-sv3-dnum" role="columnheader">占比<\/span>/,
    '降级两列表头：模型/占比（含 ARIA 角色）');
  assert.ok(!tabL.includes('均速'), '降级无均速列');
  assert.ok(!tabL.includes('t/s'), '降级表格无 t/s 单位');
  // §11.3 主数字恒在（任何模型数）：2/7/20 模型夹具均为「主数字 → 档位胶囊 → 本期有效」结构
  for (const n of [2, 7, 20]) {
    const anN = analyze(ctx, multiFixture(n), { range: 'session', period: 'all', sid: 'sess_main' });
    const domN = stripStyle(cardHTML(ctx, anN, { range: 'session', period: 'all', sid: 'sess_main' }));
    assert.match(domN, /zu-sv3-main-num"><span class="[a-z-]+">\d/, 'n=' + n + ' 主数字恒在（非 —）');
    assert.match(domN, /zu-sv3-band">/, 'n=' + n + ' 档位胶囊随主数字在场');
    assert.match(domN, new RegExp('本期有效 ' + n + ' 个模型 · \\d+ 轮'), 'n=' + n + ' 本期有效计数');
    assert.doesNotMatch(domN, /class="dim">—/, 'n=' + n + ' 多模型态不显空读数');
  }
});

// ---------- ④ i18n ----------
test('i18n: lang=en 关键文案切英文（SPD_L 桩实现真实 L 逻辑）', () => {
  const ctx = makeCtx('en');
  const h = fixture();
  const sel = { range: 'session', period: 'all', sid: 'sess_main' };
  const an = analyze(ctx, h, sel);
  const dom = stripStyle(cardHTML(ctx, an, sel));
  assert.match(dom, /Generation speed/, '标题');
  assert.match(dom, /zu-sv-flabel">Scope</, '范围标签');
  assert.match(dom, /zu-sv-flabel">Time</, '时间标签');
  assert.match(dom, /Model filter/, '筛选标签');
  assert.match(dom, /zu-sv3-fcount">Selected 2\/2 · 2 active</, 'auto 计数（已选=池全量）');
  assert.match(dom, /2 active models · 3 turns/, '多模型计数行（本期有效语义）');
  assert.match(dom, /Selected models · by requests/, '分布标题');
  assert.match(dom,
    /<span class="zu-sv3-dcell" role="columnheader">Model<\/span><span class="zu-sv3-dcell zu-sv3-dnum" role="columnheader">Avg speed<\/span><span class="zu-sv3-dcell zu-sv3-dnum" role="columnheader">Share<\/span>/,
    'Grid 表头 en 三列（含 ARIA 角色）');
  // chips 显式选中英文计数
  const selAB = { range: 'session', period: 'all', sid: 'sess_main', filt: { mode: 'sel', keys: [KEYS.a, KEYS.b] } };
  const domAB = stripStyle(cardHTML(ctx, analyze(ctx, h, selAB), selAB));
  assert.match(domAB, /zu-sv3-fcount">Selected 2\/2 · 2 active</, '显式选中英文计数（三语义统一）');
  // 单模型英文
  const selB = { range: 'session', period: 'recent', sid: 'sess_main', filt: { mode: 'sel', keys: [KEYS.b] } };
  const domB = stripStyle(cardHTML(ctx, analyze(ctx, h, selB), selB));
  assert.match(domB, /Only model/);
  assert.match(domB, /zu-sv3-stat"><i>Peak<\/i>/);
  assert.match(domB, /Coverage/);
  assert.match(domB, /Last \d+ turns · average speed/, 'recent 英文标题');
  assert.match(domB, /turns<\/b>/, '请求轮次英文');
  // 弹出层英文
  ctx.__pool = [{ key: KEYS.a, name: 'GLM-A', n: 3 }, { key: KEYS.b, name: 'Claude-B', n: 1 }];
  ctx.__filt = { mode: 'sel', keys: [KEYS.a] };
  const pop = vm.runInContext('spd3FilterPopHTML(__pool, __filt, "")', ctx);
  assert.match(pop, /aria-label="Search models"/);
  assert.match(pop, /Select all/);
  assert.match(pop, /Clear/);
  assert.match(pop, /Reset/);
});

// ---------- ⑤ 转义 ----------
test('转义: 模型名/身份键含 <script>/引号 → spdEsc 后输出，data-k 属性不被裸引号破坏', () => {
  const ctx = makeCtx();
  const h = fixture({ names: ['Goo<script>alert(1)</script>', 'Evil">Model'], keys: ['p\x1fgood', 'p\x1fe"vil'] });
  const sel = { range: 'session', period: 'all', sid: 'sess_main' };
  const an = analyze(ctx, h, sel);
  const html = cardHTML(ctx, an, sel);
  const dom = stripStyle(html);
  assert.doesNotMatch(html, /<script>|<w>|Evil">/, '无裸 HTML/脚本进输出');
  assert.match(dom, /Goo&lt;script&gt;alert\(1\)&lt;\/script&gt;/, '脚本片段转义');
  assert.match(dom, /Evil&quot;&gt;Model/, '引号转义');
  // data-k 恒为引号闭合的合法属性（值内引号已转义，[^"]* 可吃满整个值）
  const ks = dom.match(/data-k="[^"]*"/g) || [];
  assert.equal(ks.length, 2, '两枚 chip 的 data-k 均闭合');
  assert.doesNotMatch(dom, /data-k="p\x1fe"vil"/, '裸引号键必转义');
  assert.match(dom, /data-k="p\x1fe&quot;vil"/, '键内引号 → &quot;');
  assert.match(dom, /data-k="p\x1fgood"/);
  // 弹出行同样转义
  ctx.__pool = [{ key: 'p\x1fe"vil', name: 'Evil">Model', n: 1 }];
  const pop = vm.runInContext('spd3FilterPopHTML(__pool, spd3FilterAuto(), "")', ctx);
  assert.doesNotMatch(pop, /Evil">/);
  assert.match(pop, /Evil&quot;&gt;Model/);
  assert.match(pop, /data-k="p\x1fe&quot;vil"/);
});

// ---------- ⑥ 可达性 ----------
test('a11y: Tab/chips/入口/展开全为 button+aria，弹出层 role=dialog 且搜索框带 aria-label', () => {
  const ctx = makeCtx();
  const h10 = multiFixture(10);
  const sel = { range: 'session', period: 'all', sid: 'sess_main' };
  const an = analyze(ctx, h10, sel);
  const dom = stripStyle(cardHTML(ctx, an, sel, { pop: { open: true, query: '' } }));
  // 9 枚 Tab 全是 button
  assert.equal((dom.match(/<button type="button" class="zu-sv-tab/g) || []).length, 9);
  // §12.4 常驻 chips 预算 6→3：10 模型只显 3 枚 button chip + 「+7」入口
  // （[ ] 尾哨兵：zu-sv3-chip-more 是另一类名，不并入 chip 计数）
  assert.equal((dom.match(/<button type="button" class="zu-sv3-chip[ "]/g) || []).length, 3, 'chips 常驻 3 枚且为 button（§12.4）');
  assert.match(dom,
    /<button type="button" class="zu-sv3-chip-more" data-sv3-fopen aria-haspopup="dialog" aria-expanded="true" title="其余 7 个模型，可搜索查看" aria-label="还有 7 个未展示模型，点击查看和筛选">\+7<\/button>/,
    '10 模型 → 3 枚 + 「+7」button（打开态 aria-expanded=true，§14.1）');
  assert.equal((dom.match(/aria-pressed="(true|false)"/g) || []).length,
    (dom.match(/class="zu-sv-tab[ "]/g) || []).length + (dom.match(/class="zu-sv3-chip[ "]/g) || []).length +
    (dom.match(/class="zu-sv3-fpop-row/g) || []).length,
    'Tab+chips+弹出行全带 aria-pressed');
  // §14.1：弹出层入口恰两枚 data-sv3-fopen button（「模型筛选」标签 + +N），
  // aria-haspopup=dialog、aria-expanded 随弹出层开关（本例 open=true）
  assert.equal((dom.match(/data-sv3-fopen/g) || []).length, 2, '入口恰两枚：标签 + +N');
  assert.match(dom, /<button type="button" class="zu-sv3-flabel" data-sv3-fopen aria-haspopup="dialog" aria-expanded="true">模型筛选</,
    '「模型筛选」标签为 fopen button（§14.1）');
  // 展开按钮 aria-expanded
  assert.match(dom, /class="zu-sv3-more" data-sv3-more aria-expanded="false"/);
  // 弹出层：role=dialog + aria-label；输入框 aria-label；三个动作按钮
  assert.match(dom, /class="zu-sv3-fpop" role="dialog" aria-label="模型筛选"/);
  assert.match(dom, /<input type="text" class="zu-sv3-fpop-input" aria-label="搜索模型"/);
  assert.match(dom, /data-sv3-all>/);
  assert.match(dom, /data-sv3-none>/);
  assert.match(dom, /data-sv3-reset>/);
  // 无数据 chip：aria-label 带「无数据」
  const h = fixture();
  const selMiss = { range: 'session', period: 'all', sid: 'sess_main',
    filt: { mode: 'sel', keys: [KEYS.a, 'ghost\x1fmodel'] } };
  const anMiss = analyze(ctx, h, selMiss);
  const domMiss = stripStyle(cardHTML(ctx, anMiss, selMiss));
  assert.match(domMiss, /zu-sv3-chip-empty/);
  assert.match(domMiss, /aria-label="model（无数据）"/, '缺失模型 chip aria 标注无数据');
  assert.match(domMiss, /zu-sv3-chip-miss">无数据</);
  assert.match(domMiss, /class="zu-sv3-notice">[^]*2 个模型中 1 个在当前范围无数据/);
});

// ---------- ⑦ CSS 锁 ----------
test('CSS 锁: .zu-sv3-root 定宽变量、.zu-light 浅色覆写、focus-visible 焦点环、无功能说明常驻块', () => {
  const ctx = makeCtx();
  const an = analyze(ctx, fixture(), { range: 'session', period: 'all', sid: 'sess_main' });
  const html = cardHTML(ctx, an, { range: 'session', period: 'all', sid: 'sess_main' });
  const style = html.match(/<style>[\s\S]*?<\/style>/)[0];
  // §11.1 根宽：920 基准 + 视口余量 60px，max-width:100% 窄窗不反向撑大 tip
  assert.match(style, /width:min\(920px,calc\(100vw - 60px\)\);max-width:100%/, '根定宽 920 基准（视口余量 60px）');
  assert.ok(!style.includes('--zu-sv3-w'), '根定宽变量已废除');
  // §12.1 高度档位：CSS 恒定 480 基准高废除，改 root 内联 min-height + data-h-tier
  assert.ok(!style.includes('min-height:min(480px'), '480 恒定基准高已废除（§12.1）');
  assert.ok(!style.includes('--zu-sv3-h'), '定高变量已废除');
  assert.match(html, /class="zu-sv3-root" data-sv-key="[^"]+" data-h-tier="[^"]+" style="min-height:\d+px"/,
    'root 携带 data-h-tier + 内联 min-height（§12.1）');
  assert.ok(!/\.zu-sv3-root\{[^}]*overflow/.test(style), '根容器无 overflow 裁切路径（§11.1）');
  // §12.4 筛选栏恒单行：fbar/chips 双层 nowrap，chips 区 overflow:hidden 视觉收纳
  assert.match(style, /\.zu-sv3-fbar\{display:flex;align-items:center;flex-wrap:nowrap/, 'fbar nowrap 恒单行（§12.4）');
  assert.match(style, /\.zu-sv3-chips\{display:flex;flex:1 1 auto;flex-wrap:nowrap;gap:4px;min-width:0;overflow:hidden\}/,
    'chips nowrap + overflow:hidden（§12.4）');
  // §13.5 stats 恢复 Footer 语义（推翻 §12.2「禁 auto」：分布表 Grid 化后断层根除）——
  // margin-top:auto 内容少时贴底、分布表长时 auto=0 自然紧贴；分隔线节奏保留
  assert.match(style, /\.zu-sv3-root \.zu-sv3-stats\{display:flex;gap:10px;margin-top:auto;padding-top:10px;border-top:1px solid var\(--color-popover-border/,
    'stats margin-top:auto Footer 语义（§13.5）');
  // §13.5 卡底呼吸：左卡 padding-bottom ≥12（stats 贴底后仍与卡缘保持距离）
  assert.match(style, /\.zu-sv3-root \.zu-sv3-left\{[^}]*padding:10px 12px 12px\}/,
    '左卡 padding-bottom 12px（§13.5 呼吸）');
  // tip 宽帽释放（§11.1 唯一权威方案）：border-box + 952 帽 → 两链内容区 ≥922 ≥ 根 920
  assert.match(style,
    /\.tip:has\(\.zu-sv3-root\),\.zusage-tps-tip:has\(\.zu-sv3-root\)\{box-sizing:border-box!important;width:min\(952px,calc\(100vw - 24px\)\)!important;max-width:calc\(100vw - 24px\)!important\}/,
    'tip 释放规则（border-box + 952 帽 + 纯视口 max-width）');
  assert.ok(style.includes('.zu-light .zu-sv3-root'), '浅色主题覆写段在场');
  assert.ok(style.includes(':focus-visible'), '焦点环在场');
  assert.match(style, /@media \(max-width:760px\)\{\.zu-sv3-root \.zu-sv3-left\{flex:0 0 220px\}\}/, '窄窗左卡收 220px');
  assert.match(style, /\.zu-sv3-root \.zu-sv3-left\{flex:0 0 250px/, '左卡 250px 固定');
  assert.match(style, /\.zu-sv3-root \.zu-sv3-chart\{flex:1 1 0;min-width:0/, '右图表自适应列');
  // 颜色走宿主变量
  assert.ok(style.includes('var(--color-foreground,'), '前景色走宿主变量');
  assert.ok(style.includes('var(--color-popover-border,'), '描边走宿主变量');
  assert.ok(style.includes('var(--ui-font-size,14px)'), '字号走 ui-font-size 缩放');
  // 无常驻功能说明/图例块（档位说明只经标题栏按钮入口）
  assert.ok(!html.includes('功能说明'), '无功能说明文案');
  const dom = stripStyle(html);
  assert.ok(!dom.includes('zu-sv3-help') && !dom.includes('zu-sv3-note') && !dom.includes('zu-sv-li'),
    '无常驻说明/图例类块');
});

// ---------- ⑦b 高度档位（§12.1）：root min-height 离散档 ----------
test('spd3HeightTier: empty 320 / recent 三档 340/360/390 / today/week 400 / month 行数档 / all 日桶档；root 内联下发', () => {
  const ctx = makeCtx();
  const tier = a => host(vm.runInContext('spd3HeightTier(' + JSON.stringify(a) + ')', ctx));
  // empty 判据与 spd3CardHTML 同源：real 空 / overall 缺
  assert.deepEqual(tier({}), { tier: 'empty', px: 320 });
  assert.deepEqual(tier({ real: [], overall: { v: 1 } }), { tier: 'empty', px: 320 });
  assert.deepEqual(tier({ real: [1], overall: null, period: 'today' }), { tier: 'empty', px: 320 });
  // recent：n≤3→340、n≤8→360、else→390
  assert.deepEqual(tier({ real: [1, 2], overall: {}, period: 'recent' }), { tier: 'recent-s', px: 340 });
  assert.deepEqual(tier({ real: [1, 2, 3, 4, 5, 6, 7, 8], overall: {}, period: 'recent' }), { tier: 'recent-m', px: 360 });
  assert.deepEqual(tier({ real: new Array(10).fill(1), overall: {}, period: 'recent' }), { tier: 'recent-l', px: 390 });
  // today/week 恒 400
  assert.deepEqual(tier({ real: [1], overall: {}, period: 'today' }), { tier: 'today', px: 400 });
  assert.deepEqual(tier({ real: new Array(9).fill(1), overall: {}, period: 'week' }), { tier: 'week', px: 400 });
  // month：行数从 daysGrid 推（首日 getDay() 前导 + 当月日数 ceil÷7）；
  // 2026-11（01=周日）：0 前导 + 30 天 = 5 行 → 450；2026-02（01=周日，28 天）= 4 行 → 430；
  // 2026-08（01=周六）：1 前导 + 31 天 = 6 行 → 470；daysGrid 缺席按 6 行兜底 470
  const dgrid = (y, m) => [...Array(new Date(y, m + 1, 0).getDate()).keys()]
    .map(i => ({ t0: new Date(y, m, i + 1).getTime() }));
  assert.deepEqual(tier({ real: [1], overall: {}, period: 'month', daysGrid: dgrid(2026, 10) }),
    { tier: 'month-r5', px: 450 }, '2026-11：0 前导 + 30 天 = 5 行 → 450');
  assert.deepEqual(tier({ real: [1], overall: {}, period: 'month', daysGrid: dgrid(2026, 1) }),
    { tier: 'month-r4', px: 430 }, '2026-02：0 前导 + 28 天 = 4 行 → 430');
  assert.deepEqual(tier({ real: [1], overall: {}, period: 'month', daysGrid: dgrid(2026, 7) }),
    { tier: 'month-r6', px: 470 }, '2026-08：1 前导 + 31 天 = 6 行 → 470');
  assert.deepEqual(tier({ real: [1], overall: {}, period: 'month' }), { tier: 'month-r6', px: 470 }, 'daysGrid 缺席兜底 6 行');
  // all：items 日桶数（逐日一桶）≤56→380、≤112→420、else→460
  assert.deepEqual(tier({ real: [1], overall: {}, period: 'all', items: new Array(30).fill(1) }), { tier: 'all-s', px: 380 });
  assert.deepEqual(tier({ real: [1], overall: {}, period: 'all', items: new Array(56).fill(1) }), { tier: 'all-s', px: 380 });
  assert.deepEqual(tier({ real: [1], overall: {}, period: 'all', items: new Array(112).fill(1) }), { tier: 'all-m', px: 420 });
  assert.deepEqual(tier({ real: [1], overall: {}, period: 'all', items: new Array(200).fill(1) }), { tier: 'all-l', px: 460 });
  // 真 an 产物 root 内联下发：data-h-tier 与 min-height 与纯函数一致
  const selAll = { range: 'session', period: 'all', sid: 'sess_main' };
  const anAll = analyze(ctx, fixture(), selAll);
  assert.match(cardHTML(ctx, anAll, selAll),
    new RegExp('data-h-tier="' + tier(anAll).tier + '" style="min-height:' + tier(anAll).px + 'px"'),
    '真 an 的档位经 data-h-tier + 内联 min-height 下发');
  // empty 视图（ghost 筛选）→ empty 档
  const selGhost = { range: 'session', period: 'today', sid: 'sess_main', filt: { mode: 'sel', keys: ['ghost\x1fmodel'] } };
  const domG = cardHTML(ctx, analyze(ctx, fixture(), selGhost), selGhost);
  assert.match(domG, /data-h-tier="empty" style="min-height:320px"/, '空态视图 empty 档 320');
});

// ---------- ⑧ 图表标题栏 ----------
test('spd3ChartHeadHTML: 标题/t-s 徽章/data-sv-band=当前档位类/区间文本/可选副题', () => {
  const ctx = makeCtx();
  const sel = { range: 'session', period: 'recent', sid: 'sess_main' };
  const an = analyze(ctx, fixture(), sel);
  ctx.__an = an;
  const head = vm.runInContext('spd3ChartHeadHTML(__an, "")', ctx);
  assert.match(head, /<div class="zu-sc-head"><span class="zu-sc-title">[^]*<\/span><span class="zu-sc-unit">t\/s<\/span>/,
    '标题 + t/s 单位徽章');
  assert.match(head, new RegExp('data-sv-band="' + vm.runInContext('tpsBand(__an.overall.v).cls', ctx) + '"'),
    'data-sv-band 携带当前档位类');
  assert.match(head, /zu-sv-legend-btn[^]*aria-label="查看速度档位说明"/, '档位说明入口');
  assert.match(head, /<circle cx="10" cy="10" r="8\.15"/, 'Speed Bands SVG');
  assert.match(head, /zu-sv-range" title="\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} – \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}"/,
    'title 挂完整区间');
  assert.match(head, /zu-sv-range" title="[^"]*"><svg[^]*<\/svg><span>2026\/10\/05 09:59 – 2026\/11\/05 10:00<\/span>/,
    '可见紧凑区间（跨月两端带年）');
  assert.ok(!head.includes('zu-sc-sub'), '无副题不渲染');
  // 可选副题（历史热力「按日聚合」形态）
  const headSub = vm.runInContext('spd3ChartHeadHTML(__an, "按日聚合 · 自适应密度")', ctx);
  assert.match(headSub, /zu-sc-sub zu-hm-sub">按日聚合 · 自适应密度/);
  // overall 缺席：band 空串不高亮
  ctx.__an2 = Object.assign({}, an, { overall: null });
  assert.match(vm.runInContext('spd3ChartHeadHTML(__an2)', ctx), /data-sv-band=""/);
});

// ---------- ⑨ v390 §14.1 筛选入口统一 ----------
test('v390 §14.1 入口统一: fsearch 分片+产物双废；+N/「模型筛选」双 fopen 入口 aria 随开关；06/01 白名单/pop.top/Esc 归还源码锁', () => {
  const ctx = makeCtx();
  const sel = { range: 'session', period: 'all', sid: 'sess_main' };
  const an = analyze(ctx, multiFixture(10), sel);
  // 负向双查：view 分片与 overlay.js 的 SPD_V3_VIEW 产物段均无 fsearch 功能物
  // （按钮/CSS 规则/图标常量全删；分片头注释「fsearch 退役」的记录性提及不计；
  // 01/06 委托里的 zu-sv3-fsearch 字样是防旧缓存帧的有意兼容分支，不在 view 产物内）
  const noFsearchFn = s => !/var SPD3_SVG_SEARCH/.test(s) &&
    !/<button[^>]*zu-sv3-fsearch/.test(s) && !/\.zu-sv3-root \.zu-sv3-fsearch\{/.test(s);
  assert.ok(noFsearchFn(view), 'view 分片无 fsearch 按钮/CSS/图标常量');
  const srcAll = readOverlaySource();
  const viewSec = srcAll.slice(srcAll.indexOf('/* SPD_V3_VIEW_BEGIN */'), srcAll.indexOf('/* SPD_V3_VIEW_END */'));
  assert.ok(viewSec.includes('SPD_V3_VIEW_BEGIN') && noFsearchFn(viewSec),
    'overlay.js 的 SPD_V3_VIEW 产物段无 fsearch 功能物');
  // 打开/关闭两态：两枚 fopen 入口（标签 + +N）aria-haspopup=dialog、aria-expanded 随 pop.open
  const domOpen = stripStyle(cardHTML(ctx, an, sel, { pop: { open: true, query: '' } }));
  assert.equal((domOpen.match(/aria-haspopup="dialog"/g) || []).length, 2, '两枚入口均 aria-haspopup=dialog');
  assert.equal((domOpen.match(/data-sv3-fopen aria-haspopup="dialog" aria-expanded="true"/g) || []).length, 2,
    '打开态两入口 aria-expanded=true');
  const domClosed = stripStyle(cardHTML(ctx, an, sel));
  assert.equal((domClosed.match(/data-sv3-fopen aria-haspopup="dialog" aria-expanded="false"/g) || []).length, 2,
    '关闭态两入口 aria-expanded=false');
  // 06/01 两链源码锁：closest 白名单收纳入口类名、fopen 分支实测 fbar 底缘写 pop.top、
  // Esc 关闭后焦点归还 [data-sv3-fopen] 触发按钮
  const shard06 = readOverlayPart('06-instance-dom-and-styles.js');
  const shard01 = readOverlayPart('01-git-and-doc-tooltips.js');
  for (const [tag, shard] of [['06', shard06], ['01', shard01]]) {
    assert.match(shard, /\.zu-sv3-chip,\.zu-sv3-chip-more,\.zu-sv3-fopen,/, tag + ' 委托白名单含 chip-more/fopen 入口');
    assert.match(shard, /hasAttribute\("data-sv3-fopen"\)/, tag + ' fopen 打开分支在场');
    assert.match(shard, /pop\.top = Math\.round\(/, tag + ' fopen 打开时实测 fbar 底缘写 pop.top');
    assert.match(shard, /querySelector\("\[data-sv3-fopen\]"\)/, tag + ' Esc 关闭焦点归还 fopen 触发按钮');
  }
});

// ---------- ⑩ v390 §14.1 fpop 锚定 ----------
test('v390 §14.1 fpop 锚定: CSS 默认 top:87px/右缘 10px/宽 340 无 bottom；pop.top 内联覆写 style="top:Npx"', () => {
  const ctx = makeCtx();
  const sel = { range: 'session', period: 'all', sid: 'sess_main' };
  const an = analyze(ctx, fixture(), sel);
  const style = cardHTML(ctx, an, sel).match(/<style>[\s\S]*?<\/style>/)[0];
  const fpopRule = style.match(/\.zu-sv3-root \.zu-sv3-fpop\{[^}]*\}/)[0];
  assert.match(fpopRule, /position:absolute;right:10px;top:87px/, '默认锚定筛选栏正下方（头部 ~45 + fbar ~34 + 8px）');
  assert.match(fpopRule, /width:340px/, '宽 340px');
  assert.ok(!fpopRule.includes('bottom'), 'bottom:10px 废除（卡右下角锚定不再用）');
  // pop.top 内联覆写：06/01 fopen 分支实测 fbar 底缘写入 ctx.pop.top → spd3CardHTML replace
  const dom95 = stripStyle(cardHTML(ctx, an, sel, { pop: { open: true, query: '', top: 95 } }));
  assert.match(dom95, /class="zu-sv3-fpop" style="top:95px" role="dialog"/, 'pop.top=95 → 内联 style="top:95px"');
  const domDefault = stripStyle(cardHTML(ctx, an, sel, { pop: { open: true, query: '' } }));
  assert.match(domDefault, /class="zu-sv3-fpop" role="dialog"/, '无 pop.top → 纯 CSS 默认 87px（无内联 style）');
});

// ---------- ⑪ v390 §14.2 dbar 轨道契约 + Top6+其他 ----------
test('v390 §14.2 dbar 轨道: 段 min-width:0/stretch 废除 2px 下限；8 模型→7 段其他灰、计数差宽、占比和=100、<0.1% 显示、aria 概况', () => {
  const ctx = makeCtx();
  const sel = { range: 'session', period: 'all', sid: 'sess_main' };
  const an8 = analyze(ctx, multiFixture(8), sel);
  const style = cardHTML(ctx, an8, sel).match(/<style>[\s\S]*?<\/style>/)[0];
  // 轨道：flex + align-items:stretch 恒 8px；段 height:100%/align-self:stretch/min-width:0
  assert.match(style, /\.zu-sv3-root \.zu-sv3-dbar\{display:flex;align-items:stretch;height:8px;/, '轨道 flex+stretch 恒 8px');
  const segRule = style.match(/\.zu-sv3-root \.zu-sv3-dbar i\{[^}]*\}/)[0];
  assert.match(segRule, /height:100%;align-self:stretch;flex-shrink:0;min-width:0/, '段宽=真实 share（min-width:0）');
  assert.ok(!segRule.includes('min-width:2px'), 'min-width:2px 下限废除（19 段碎片化/比例失真根源）');
  const dom = stripStyle(cardHTML(ctx, an8, sel));
  // Top6+其他：8 模型 → 6 真实段 + 1 中性灰其他段（无 19 段碎片），Σ段宽=100%
  const bar = dom.slice(dom.indexOf('zu-sv3-dbar'), dom.indexOf('zu-sv3-dwrap'));
  assert.equal((bar.match(/<i style=/g) || []).length, 7, '8 模型 → 7 段（Top6+其他）');
  const widths = [...bar.matchAll(/width:([\d.]+)%/g)].map(m => parseFloat(m[1]));
  const wSum = widths.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(wSum - 100) < 0.01, '段宽和=100%（其他段按原始计数差），实得 ' + wSum);
  assert.match(bar, /background:var\(--color-tooltip-tag-foreground,#a6a6a6\)/, '其他段=中性灰');
  assert.match(bar, /title="其他 2 个模型 · 2 次请求 · 13\.3%"/, '其他段 title=名 · 请求数 · 占比（计数差 15−13=2）');
  // aria 简化为概况（完整数据由下方表格承载）
  assert.match(dom, /zu-sv3-dbar" role="img" aria-label="模型分布：8 个模型"/, 'dbar aria=「模型分布：N 个模型」');
  // <0.1%：share<0.001 显「&lt;0.1%」不显 0%（表占比列与段 title 同口径）
  const t0 = new Date(2026, 10, 5, 9).getTime();
  const turns = [];
  let prev = 0;
  const mkTurn = (abs, idx, out, n) => {
    turns.push({ s: 0, t: abs - prev, b: abs - 30000, out, ms: 1000, i: out, o: out, n, msl: [[idx, out, 1000, n]] });
    prev = abs;
  };
  mkTurn(t0, 0, 999, 2000);
  mkTurn(t0 + 60000, 1, 100, 1);
  const hSk = { sid: 'sess_main', source: 'local', truncated: false, sids: ['sess_main'], snames: ['S'],
    pids: [['p', 'P']], mnames: ['Big', 'Tiny'], mkeys: ['p\x1fbig', 'p\x1ftiny'], turns };
  const domSk = stripStyle(cardHTML(ctx, analyze(ctx, hSk, sel), sel));
  assert.match(domSk, /zu-sv3-pct" role="cell">&lt;0\.1%</, '占比列显 <0.1%（1/2001≈0.05%，不显 0%）');
  assert.match(domSk, /title="Tiny · 1 次请求 · &lt;0\.1%"/, '段 title 同步 <0.1%');
  assert.match(domSk, /zu-sv3-dbar" role="img" aria-label="模型分布：2 个模型"/);
});
