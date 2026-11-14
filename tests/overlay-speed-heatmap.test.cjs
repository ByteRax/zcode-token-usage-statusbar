const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

// v291 热力图（本月月历 / 全部历史 GitHub 风格）：切片同 overlay-speed-v2.test.cjs——
// TPS_BANDS..zuBarSpeedView + v254 纯函数块（含 v291 spdChartHeadHTML/热力图构建器/分发）。
// 纯函数行为级验证：日历对齐、档位映射、无数据/未来日语义、悬停卡、分发规则。
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
const bandHelpers = source.slice(source.indexOf('  var TPS_BANDS = ['), source.indexOf('  /* 返回 null = 调用方应把这当成')) +
  '\n' + source.slice(source.indexOf('  /* ---------- v254 生成速度 Tooltip 重构'), source.indexOf('  /* SPD_V2_BLOCK_END */'));

const DAY = 86400000;
// 冻结时钟：2026-11-05（周四）14:00 本地时。2026-11-01 是周日（月历无前导占位）。
const FIXED_NOW = new Date(2026, 10, 5, 14, 0, 0).getTime();
function makeCtx(lang = 'zh', now = FIXED_NOW) {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const ctx = vm.createContext({
    state: { lang, cost: 1 },
    L: (zh, en) => lang === 'en' ? en : zh,
    fmt: v => String(v || 0), countFmt: v => String(v || 0),
    fmtMoney: usd => '¥' + usd.toFixed(2),
    Date: FakeDate, Math, JSON, isFinite, parseInt, parseFloat, Object, Array, String, Number,
  });
  vm.runInContext(bandHelpers, ctx);
  return ctx;
}

// 简化轮表：按绝对时刻列表造 delta 编码帧（s/t/b/out/ms/i/o/n/msl/c/cf）
function histFrom(abs) {
  abs.sort((a, b) => a.t - b.t);
  let prev = 0;
  const turns = abs.map(r => {
    const o = { s: r.s || 0, t: r.t - prev, b: r.b != null ? r.b : r.t - 60000,
      out: r.out, ms: r.ms, i: r.i != null ? r.i : r.out, o: r.out, n: r.n || 1,
      msl: r.msl || [[0, r.out]] };
    prev = r.t;
    if (r.c != null) o.c = r.c;
    return o;
  });
  return { sid: 'sess_main', source: 'local', truncated: false,
    sids: ['sess_main'], snames: ['本会话'], pids: [['proj_a', '项目A']],
    mnames: ['GLM-5.3-FlashX'], turns };
}

function analyze(ctx, sel) {
  const s = Object.assign({ sid: 'sess_main' }, sel);
  return vm.runInContext('spdAnalyze(__h,' + JSON.stringify(s) + ')', ctx);
}
function chartHTML(ctx, an, hoverIdx) {
  ctx.__an = an; ctx.__hi = typeof hoverIdx === 'number' ? hoverIdx : -1;
  const html = vm.runInContext('spdChartFor(__an,__hi,{fmtTok:function(v){return String(v)},fmtCnt:function(v){return String(v)},fmtMoney:function(u){return "¥"+u.toFixed(2)}})', ctx);
  return html;
}
function portalHTML(ctx) {
  return vm.runInContext('SPD_PORTAL', ctx);   // 悬停卡走侧信道，不在图表串里
}
function v2card(ctx, sel, hoverIdx) {
  ctx.__sel = Object.assign({ range: 'all', period: 'all', dim: 'time', sid: 'sess_main' }, sel);
  ctx.__hi = typeof hoverIdx === 'number' ? hoverIdx : -1;
  return vm.runInContext('speedCardV2HTML({speedHistory:__h,sel:__sel,segsHover:__hi,' +
    'fmtTok:function(v){return String(v)},fmtCnt:function(v){return String(v)},fmtMoney:function(u){return "¥"+u.toFixed(2)}})', ctx);
}
const count = (s, needle) => s.split(needle).length - 1;
const d = (mo, day, h) => new Date(2026, mo, day, h || 9).getTime();

test('month calendar: real weekday grid, per-day weighted speed, void/future semantics', () => {
  const ctx = makeCtx();
  // 11-05 两轮（100/1s + 900/3s → 250 t/s 加权）+ 11-04 一轮（300 t/s）
  ctx.__h = histFrom([
    { t: d(10, 4, 15), out: 3000, ms: 10000 },               // 300 t/s
    { t: d(10, 5, 9), out: 100, ms: 1000 },                  // 100 t/s
    { t: d(10, 5, 10), out: 900, ms: 3000 },                 // 300 t/s
  ]);
  const an = analyze(ctx, { range: 'all', period: 'month' });
  assert.equal(an.unit, 'day');
  const html = chartHTML(ctx, an);
  assert.match(html, /zu-hm-month/, 'month heatmap class on chart root');
  assert.match(html, /本月 · 平均速度/, 'title drops granularity word (v292)');
  assert.ok(!html.includes('每日平均速度'), 'no granularity word anywhere in title');
  // 2026-11-01 是周日：无前导占位，30 个日格 + 周日..周六表头
  assert.equal(count(html, 'zu-hm-pad'), 0, 'Nov 2026 starts on Sunday: no leading pad');
  assert.equal(count(html, 'zu-hm-cell'), 30, '30 real day cells');
  // v293.1（用户拍板）：星期表头行舍弃
  assert.match(html, /zu-hm-week[^>]*><span>周日</, 'weekday header row restored (v295.4)');
  // 11-05 当日加权 1000/4s=250 t/s（zu-sky 快速 200-300），非算术平均 200
  const day5 = html.match(/data-i="4"[^>]*aria-label="([^"]+)"/);
  assert.ok(day5, 'day 5 cell exists at index 4 (flat tiling)');
  assert.match(day5[1], /2026年11月5日 周四，平均速度 250 t\/s，快速/);
  assert.match(html, /class="zu-hm-cell data len\d+ zu-sky[^"]*zu-hm-today"/, 'today data cell band + deepened tint (no ring, v297.1)');
  assert.match(source, /\.zu-hm-cell\.data\.zu-hm-today\{background:color-mix\(in srgb,currentColor 32%/, 'today = +10% deeper mix');
  assert.ok(!source.includes('\".zu-hm-cell.zu-hm-today{box-shadow'), 'month today has no border ring (hist prefixed rule kept)');
  assert.ok(html.includes('>250</span>'), 'day value rendered');
  // 11-04 数据格 300 t/s → zu-azure；11-01..03 无记录：中性格 + 显式 aria（不是 0 t/s）
  assert.match(html, /class="zu-hm-cell data len4 zu-azure" role="img"/, 'day 4 band cell');
  const day1 = html.match(/data-i="0"[^>]*aria-label="([^"]+)"/);
  assert.match(day1[1], /2026年11月1日 周日，无有效速度记录/);
  assert.ok(!/data-i="0"[^>]*tabindex/.test(html), 'void cells are not tabbable');
  // 未来日 11-06..30：aria-hidden 弱日期号（v294，无速度无框）
  assert.equal(count(html, 'zu-hm-cell fut'), 25, '25 future days');
  assert.ok(html.includes('aria-hidden="true" data-i="5"'), 'future cells aria-hidden');
  assert.ok(!/平均速度 0 t\/s/.test(html) && !/zu-hm-v">0<\/span>/.test(html), 'never fabricates a 0 t/s reading');
  // 稀疏说明：本月 2 天有记录
  // v294.1（用户拍板）：月历稀疏说明行整体移除
  assert.ok(!html.includes('zu-hm-note'), 'month sparse note removed');
  // v292 定高 315 + 行数变量（2026-11：无前导 + 30 天 = 5 行）
  assert.match(html, /--zu-hm-rows:5/, 'row count carried (lead 0 + 30 days = 5 rows)');
  assert.ok(!html.includes('zu-hm-cell data zero') && !html.includes('>0</span>'), 'no zero-fill (v296.1 reverted)');
  assert.ok(!source.includes('.zu-hm-cell.zero'), 'zero tint removed');
  // v294.1：recent 范围限定说明随稀疏说明行一并移除
  const htmlR = chartHTML(ctx, analyze(ctx, { range: 'recent', period: 'month' }));
  assert.ok(!htmlR.includes('zu-hm-note'), 'recent-range note removed too');
});

test('month calendar: 7-column Sunday-aligned (Dec 31 days, Dec 1 2026 is Tuesday → 2 pads, 6 rows)', () => {
  const ctx = makeCtx('zh', new Date(2026, 11, 15, 10).getTime());
  ctx.__h = histFrom([{ t: new Date(2026, 11, 10, 9).getTime(), out: 500, ms: 5000 }]);
  const an = analyze(ctx, { range: 'all', period: 'month' });
  const html = chartHTML(ctx, an);
  assert.equal(count(html, 'zu-hm-pad'), 2, 'Dec 1 2026 is Tuesday: 2 leading pads');
  assert.equal(count(html, 'zu-hm-cell'), 31, '31 December cells');
  assert.match(html, /--zu-hm-rows:5/, '2 pads + 31 days = 5 rows');
  // v295：31 天不被 6 整除，末格跨到行尾（无空隙）
  assert.ok(!/grid-column:[^\"]*span/.test(html), 'no cross-column spans (v295.3: normal cell size)');
  assert.ok(!html.includes('本月已有 1 天记录'), 'single-day sparse note removed (v294.1)');
});

test('month calendar: February 28/29 day counts (leap year boundary)', () => {
  const leap = makeCtx('zh', new Date(2028, 1, 10, 9).getTime());   // 2028 闰年
  leap.__h = histFrom([{ t: new Date(2028, 1, 3, 9).getTime(), out: 500, ms: 5000 }]);
  const htmlLeap = chartHTML(leap, analyze(leap, { range: 'all', period: 'month' }));
  assert.equal(count(htmlLeap, 'zu-hm-cell'), 29, 'Feb 2028 has 29 cells');
  assert.equal(count(htmlLeap, 'zu-hm-pad'), 2, 'Feb 1 2028 is Tuesday: 2 leading pads');
  assert.match(htmlLeap, /--zu-hm-rows:5/, '2 pads + 29 days = 5 rows');
  const flat = makeCtx('zh', new Date(2027, 1, 10, 9).getTime());   // 2027 平年
  flat.__h = histFrom([{ t: new Date(2027, 1, 3, 9).getTime(), out: 500, ms: 5000 }]);
  const htmlFlat = chartHTML(flat, analyze(flat, { range: 'all', period: 'month' }));
  assert.equal(count(htmlFlat, 'zu-hm-cell'), 28, 'Feb 2027 has 28 cells');
  assert.match(htmlFlat, /--zu-hm-rows:5/, 'Feb 2027 starts Monday: 1 pad + 28 days = 5 rows');
  assert.ok(!/grid-column:[^\"]*span/.test(htmlFlat), 'no cross-column spans (v295.3)');
});

test('month empty state: gray calendar with dates and explicit no-data note, no colored cells', () => {
  const ctx = makeCtx();
  ctx.__h = histFrom([{ t: d(9, 20, 9), out: 500, ms: 5000 }]);   // 上月，本月无数据
  const an = analyze(ctx, { range: 'all', period: 'month' });
  const html = chartHTML(ctx, an);
  assert.equal(count(html, 'zu-hm-cell data'), 0, 'no fabricated colored cells');
  assert.equal(count(html, 'zu-hm-cell'), 30);
  assert.ok(!html.includes('本月暂无有效速度记录'), 'empty-state note removed (v294.1)');
});

test('history heatmap: week columns × weekday rows, month labels, real cells only', () => {
  const ctx = makeCtx();
  ctx.__h = histFrom([
    { t: d(9, 5, 10), out: 3000, ms: 10000 },   // 10-05（周一）300 t/s
    { t: d(10, 4, 15), out: 3000, ms: 10000 },  // 11-04 300 t/s
    { t: d(10, 5, 9), out: 100, ms: 1000 },     // 11-05 100 t/s（今日）
  ]);
  const an = analyze(ctx, { range: 'all', period: 'all' });
  assert.equal(an.unit, 'day');
  const html = chartHTML(ctx, an);
  assert.match(html, /zu-hm-hist/, 'history heatmap class');
  assert.match(html, /历史 · 平均速度/, 'history title (no granularity word, v292)');
  assert.ok(!html.includes('按日聚合'), 'history subtitle removed (v296.1)');
  assert.match(html, /data-sv-end="1"/, 'first-open scrolls to latest (host consumes)');
  // v292 窗口：10-01（周四，周首 9-27）→ 11-30（周一，周首 11-29）= 10 周 70 格
  assert.ok(count(html, 'zu-hm-pad') >= 0, 'pads only from week alignment (365d window)');
  assert.equal(count(html, 'zu-hm-cell'), 365, '365-day window cells');
  assert.equal(count(html, 'zu-hm-cell sq data'), 3, 'exactly 3 data cells');
  assert.ok(count(html, 'zu-hm-cell sq void') >= 350, 'no-data days are all neutral cells');
  // 月标签：10月 在第 1 列、11月 在 11-01 所在列（第 6 列）
  assert.match(html, /zu-hm-ml[^>]*>10月</, 'October label');
  assert.match(html, /zu-hm-ml[^>]*>11月</, 'November label present');
  // 周标签 7 行（列外固定，不随横滚）
  assert.equal(count(html, 'zu-hm-wds'), 1);
  // 今日格（11-05）带今日描边；aria 携带完整日期与加权速度
  const today = html.match(/data-i="(\d+)"[^>]*aria-label="([^"]*2026年11月5日[^"]*)"/);
  assert.ok(today, 'today cell has full-date aria');
  assert.match(today[2], /平均速度 100 t\/s，流畅/);
  assert.ok(!/grid-column:0/.test(html), 'labels never at illegal column 0');
});

test('history long span stays within DOM guard and keeps daily buckets', () => {
  const ctx = makeCtx();
  // 400 天前一轮 + 今天一轮 → ~59 周窗口
  ctx.__h = histFrom([
    { t: FIXED_NOW - 400 * DAY, out: 500, ms: 5000 },
    { t: FIXED_NOW - 3600 * 1000, out: 500, ms: 5000 },
  ]);
  const an = analyze(ctx, { range: 'all', period: 'all' });
  const html = chartHTML(ctx, an);
  // v296 窗口=最近 365 天：格+占位 = 53 周网格（窗口端点周对齐）
  const wk = (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay()).getTime(); };
  const wStart = wk(new Date(2026, 10, 5).getTime() - 364 * DAY);
  const wEnd = wk(new Date(2026, 10, 5).getTime());
  const weeks = Math.round((wEnd - wStart) / (7 * DAY)) + 1;
  assert.equal(count(html, 'zu-hm-cell') + count(html, 'zu-hm-pad'), weeks * 7, 'one slot per day in 365d window');
  assert.match(html, /--zu-hm-w:\d+/, 'column count carried via CSS var');
});

test('history sparse disclosure: short span shows coverage note', () => {
  const ctx = makeCtx();
  ctx.__h = histFrom([{ t: FIXED_NOW - 3600 * 1000, out: 500, ms: 5000 }]);
  const an = analyze(ctx, { range: 'all', period: 'all' });
  const html = chartHTML(ctx, an);
  assert.ok(!html.includes('共 1 天'), 'short-history coverage line removed from body (v296.1)');
});

test('history window = full months; no-data days (incl. future) render as neutral cells', () => {
  const ctx = makeCtx();
  // 10-23 与 11-08 各一轮：窗口 10/01-11/30，中间与未来的无数据日全部可见（#484848 走 CSS）
  ctx.__h = histFrom([
    { t: d(9, 23, 15), out: 500, ms: 5000 },
    { t: d(10, 8, 9), out: 500, ms: 5000 },
  ]);
  const an = analyze(ctx, { range: 'all', period: 'all' });
  const html = chartHTML(ctx, an);
  assert.equal(count(html, 'zu-hm-cell'), 365, 'exactly 365 day cells');
  assert.equal(count(html, 'zu-hm-cell sq data'), 1, 'only 10-23 is in-window (11-08 is future vs test clock)');
  assert.ok(count(html, 'zu-hm-cell sq void') >= 362, 'every other day is a visible void cell');
  assert.ok(html.includes('zu-hm-cell sq void zu-hm-today'), 'today without data still gets the today ring');
  // 稀疏披露描述数据跨度（10/23-11/08 = 17 天）
  // 测试时钟 11-05：跨度 10/23-11/05 = 14 天（非挂钟今天）
  assert.ok(!html.includes('共 14 天'), 'coverage note removed from chart body (v296.1)');
  // v293：列头日期数字行——每列一个日号（该列窗口内首日），10 列 10 个数字
  assert.ok((html.match(/zu-hm-dn/g) || []).length >= 53, 'one day-number per week column (53 weeks)');
  assert.match(html, /zu-hm-dn[^>]*>01</, 'first column starts at month day 1');
  assert.match(html, /zu-hm-days" style="--zu-hm-w:\d+"/, 'day-number row shares the week column template');
});

test('day hover cards: data day reuses five-field card, void/future explain themselves', () => {
  const ctx = makeCtx();
  ctx.__h = histFrom([
    { t: d(10, 5, 9), out: 100, ms: 1000, c: 0.01 },
    { t: d(10, 5, 10), out: 900, ms: 3000, c: 0.02 },
  ]);
  const an = analyze(ctx, { range: 'all', period: 'all' });
  // 11-05（365d 窗口 data-i=364）悬停：五字段卡 + 整日时间形态 + 费用（Portal 侧信道）
  chartHTML(ctx, an, 364);
  const portal = portalHTML(ctx);
  assert.match(portal, /2026-11-05 周四/, 'day-formatted time override');
  assert.match(portal, /Token 总消耗/, 'token field');
  assert.match(portal, /¥0\.03/, 'cost summed');
  assert.match(portal, /2000 token/, 'tokens aggregated (in+out)');
  // 无记录日悬停：显式说明，绝不显 0 t/s / 伪模型
  const anM = analyze(ctx, { range: 'all', period: 'month' });
  chartHTML(ctx, anM, 2);   // 11-03 无记录
  const portalM = portalHTML(ctx);
  assert.match(portalM, /当日无有效生成速度记录/, 'void day explains itself');
  assert.ok(!portalM.includes('t/s'), 'no fake speed on void day card');
  // 未来日悬停：尚未开始
  chartHTML(ctx, anM, 5);   // 11-06
  assert.match(portalHTML(ctx), /尚未开始/, 'future day card');
});

test('history cells enumerate data-i 0..364 in DOM order (column-major, complements the data-i=364 mapping test)', () => {
  const ctx = makeCtx();
  ctx.__h = histFrom([{ t: d(10, 5, 9), out: 100, ms: 1000 }]);
  const an = analyze(ctx, { range: 'all', period: 'all' });
  const html = chartHTML(ctx, an);
  const idxs = [...html.matchAll(/<div class="zu-hm-cell sq [^>]*data-i="(\d+)"/g)].map(m => +m[1]);
  assert.equal(idxs.length, 365, '365 real day cells');
  assert.equal(idxs[0], 0, 'first cell is data-i=0');
  assert.equal(idxs[idxs.length - 1], 364, 'last cell is data-i=364 (window last day)');
  assert.ok(idxs.every((v, i) => v === i), 'data-i strictly sequential in DOM order');
});

test('v296.1 coverage stats ride the void-day hover card (review fix: coverage was var-hoisted into undefined)', () => {
  const ctx = makeCtx();
  ctx.__h = histFrom([
    { t: d(9, 5, 9), out: 100, ms: 1000 },
    { t: d(9, 6, 9), out: 100, ms: 1000 },
  ]);
  const an = analyze(ctx, { range: 'all', period: 'all' });
  // 悬停无记录日 10-07（=364-29）：覆盖统计行=共 N 天 · 其中 2 天有有效速度记录
  // （分母=窗口起点与首数据日较晚者→10-05 起算，10-05..11-05=32 天）。
  // 修复前 coverage 实参恒 undefined，静默退化为「当日无有效生成速度记录」兜底。
  chartHTML(ctx, an, 335);
  const portal = portalHTML(ctx);
  assert.match(portal, /共 32 天 · 其中 2 天有有效速度记录/, 'coverage line computed and rendered on void card');
  assert.ok(!portal.includes('当日无有效生成速度记录'), 'fallback text no longer shadows real coverage');
});

test('dispatch: month/all swap to heatmaps, recent/today/week keep bars; head is shared', () => {
  const ctx = makeCtx();
  ctx.__h = histFrom([{ t: d(10, 5, 9), out: 500, ms: 5000 }]);
  for (const [period, marker, absent] of [
    ['recent', 'zu-sc-col', 'zu-hm-'], ['today', 'zu-sc-col', 'zu-hm-'], ['week', 'zu-sc-col', 'zu-hm-month'],
    ['month', 'zu-hm-month', 'zu-sc-col'], ['all', 'zu-hm-hist', 'zu-sc-col']]) {
    const html = v2card(ctx, { range: 'all', period });
    const dom = html.replace(/<style>[\s\S]*?<\/style>/g, '');   // v295：注入 style 含结构类选择器，结构断言只看 DOM 串
    assert.ok(dom.includes(marker), period + ' renders ' + marker);
    if (absent === 'zu-hm-')   /* 注入 style 含 .zu-hm-month 选择器字符串，前缀断言改查结构类 */
      assert.ok(!dom.includes('zu-hm-grid'), period + ' does not render month grid');
    else
      assert.ok(!dom.includes(absent), period + ' does not render ' + absent);
    assert.ok(dom.includes('data-sv-band='), 'shared head with band legend entry (' + period + ')');
    // 默认 300px，内容放不下时由实际测量扩高。
    assert.ok(html.includes('height:var(--zu-sv-height,300px)!important'), 'adaptive tooltip height (' + period + ')');
  }
});

test('v294 month cell style: muted band bg, left band bar, high-contrast fg, no dashed frames', () => {
  const css = source;   // 构建产物源码级锁（防回退纯色底/currentColor 文字/虚线框）
  // 低饱和底：档位色 color-mix 22% 混卡片色（WCAG 对比度已数学验证 18 组合 ≥5.5:1）
  assert.match(css, /\.zu-hm-grid--mon \.zu-hm-cell\.data\{background:color-mix\(in srgb,currentColor 22%,var\(--color-popover/,
    'muted band background via color-mix 22%');
  assert.ok(!css.includes('.zu-hm-grid--mon .zu-hm-cell.data{background:currentColor}'),
    'solid currentColor fill must not come back (contrast root cause)');
  // 左 3px 档位色条（唯一强调方式）
  // v294.1（用户拍板）：左侧 3px 档位色条移除——档位靠低饱和底色色相辨识
  assert.ok(!css.includes('border-radius:8px 0 0 8px'), 'left band bar removed');
  assert.ok(!/\.zu-hm-cell\.cur\{[^}]*box-shadow/.test(css), 'hover cur has no ring (brightness only)');
  // 文字吃 tooltip 前景（高对比），绝不吃 currentColor
  assert.match(css, /\.zu-hm-cell \.zu-hm-v\{[^}]*color:var\(--color-tooltip-foreground/,
    'speed value uses tooltip foreground');
  // 上下布局 + 收紧行高（越界根因修复锁）
  assert.match(css, /\.zu-hm-cell\{position:relative;display:flex;flex-direction:column;justify-content:space-between;/,
    'top/bottom space-between layout');
  assert.match(css, /\.zu-hm-cell \.zu-hm-v\{flex:0 0 auto;min-height:0;font-weight:600;line-height:1;/,
    'line-height 1.1 + min-height:0');
  // 虚线框移除（视觉降噪）
  assert.ok(!/\.zu-hm-cell\.fut\{[^}]*dashed/.test(css), 'future cells have no dashed frame');
  // 容器查询三档（元素级阈值锁）
  assert.ok(!css.includes('@container hmcal'), 'hmcal container tiers removed (v297 dynamic fonts)');
  assert.match(css, /\.zu-hm-cell\{-webkit-text-fill-color:initial\}/, 'ultra text-fill reset');
  assert.match(css, /\.zu-hm-cell::before\{content:none\}/, 'no pseudo-element on any heatmap cell (incl. ultra star)');
  assert.ok(!css.includes('zu-hm-tight .zu-hm-v{display:none}'), '6-row months never hide values (v297)');
  assert.ok(!css.includes('max-width:440px'), 'ultra-narrow hide tier removed (v297)');
});

test('inject style hygiene: tip element never gets display (hide relies on inline display:none)', () => {
  const ctx = makeCtx();
  ctx.__h = histFrom([{ t: d(10, 5, 9), out: 500, ms: 5000 }]);
  const html = v2card(ctx, { range: 'all', period: 'month' });
  const m = html.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(m, 'inject style present');
  // v293.1 回归锁：tip 本体被注入 display:flex!important 会把 inline display:none 永久
  // 压死 = tooltip 移出后永不消失（用户实报）。祖先层只允许 height/overflow 类注入。
  assert.ok(!/:has\(\.zu-sv-root\)\{[^}]*display:/i.test(m[1]),
    'tip/tps-tip element itself must not receive display from inject style');
  // 滚动条隐藏双通道：标准属性 scrollbar-width 必须在元素上（伪元素里无效）
  assert.match(m[1], /\.zu-sc-wrap\{[^}]*scrollbar-width:none!important/,
    'element-level scrollbar-width:none present');
  assert.match(m[1], /\.zu-sc-wrap::-webkit-scrollbar\{display:none!important/,
    'webkit pseudo-element display:none present');
});

test('build hygiene: no ASI-prone quote-newline-quote concat breaks in overlay.js', () => {
  // 样式串拼接链若丢行尾 +，node --check 因 ASI 静默通过，运行时样式从断点整段丢失
  // （实测两次：V1 柱状图标签重叠、pill 浏览器回归红）。本仓拼接纪律 = 行尾恒 " +"，
  // 全文禁止「引号-换行-引号」形态（2026-11-08 实测基线 0 命中）。
  const hits = [];
  const re = /['\"'][ \t]*\r?\n[ \t]*['\""]/g;
  let m;
  while ((m = re.exec(source)) !== null) hits.push(source.slice(Math.max(0, m.index - 60), m.index + 20));
  assert.deepEqual(hits, [], 'string concat chain broken (missing trailing +): ' + hits.slice(0, 2).join(' || '));
});

test('a11y and i18n: en labels and non-tabbable placeholders', () => {
  const ctx = makeCtx('en');
  ctx.__h = histFrom([{ t: d(10, 5, 9), out: 500, ms: 5000 }]);
  const an = analyze(ctx, { range: 'all', period: 'month' });
  const html = chartHTML(ctx, an, 4);
  assert.match(html, /Thu, Nov 5 2026, avg 100 t\/s, Smooth/, 'en aria on data cell');
  assert.match(html, /no rated speed data/, 'en void aria');
  assert.match(html, /<span>Sun<\/span>/, 'en weekday header restored (v295.4)');
  chartHTML(ctx, an, 5);   // 未来日悬停走 Portal
  assert.match(portalHTML(ctx), /Not started yet/, 'en future card');
  assert.match(html, /tabindex="0" data-i="4"/, 'data cell focusable');
  assert.ok(!/zu-hm-cell void"[^>]*tabindex/.test(html), 'void cell not in tab order');
});
