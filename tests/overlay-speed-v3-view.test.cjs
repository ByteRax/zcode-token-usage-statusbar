'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');
const { readOverlayPart, sliceOverlay } = require('./helpers/overlay-extract.cjs');

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
  assert.match(dom, /zu-sv3-fcount">全部 2</);
  assert.doesNotMatch(dom, /zu-sv3-fsearch/, '<9 模型不渲染搜索按钮');
  // 多模型左卡：计数行 + 分布表，无「唯一模型」
  assert.match(dom, /已选 2 个模型 · 3 轮/);
  assert.match(dom, /zu-sv3-dtab/);
  assert.match(dom, /所选模型分布 · 按请求数/);
  assert.doesNotMatch(dom, /唯一模型/);
  assert.doesNotMatch(dom, /zu-sv3-cov/, '覆盖范围五值只在单模型态');
  // 图表占位原样保留（bare data-sv3-chart 属性，集成方经 [data-sv3-chart] 替换占位）
  assert.match(html, /class="zu-speed-chart zu-sv3-chart" data-sv3-chart><!--CHART--><\/div>/);
  // 无 notice 不渲染通知行
  assert.ok(!dom.includes('zu-sv3-notice'), '无通知不渲染常驻行');
  // 单模型态（只选 B）：互斥——无分布表/分布条，有唯一模型行
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
      month: /本月平均速度/, all: /全部历史平均速度/ }[period];
    assert.match(dom, want, 'period=' + period + ' 左卡标题');
    assert.match(dom, /zu-sv3-main-num/, 'period=' + period + ' 主数字在场');
    assert.match(dom, /唯一模型/);
    // m3：「本期统计」组标题 + 请求轮次/当前模型/覆盖范围三行 kv
    assert.match(dom, /zu-sv3-cov-h">本期统计</, 'period=' + period + ' 本期统计组标题');
    assert.match(dom, /请求轮次/);
    assert.match(dom, /当前模型/);
    assert.match(dom, /覆盖范围/, 'period=' + period + ' 覆盖范围块');
    assert.ok(!dom.includes('zu-sv3-cov-set'), 'period=' + period + ' 五值 set 已废除');
    // 覆盖范围=单值 kv，随 an.period 直读本视图（recent 的 N=items.length）
    assert.match(dom, new RegExp('覆盖范围</i><b>' + wantCov[period] + '</b>'),
      'period=' + period + ' 覆盖范围单值=' + wantCov[period]);
  }
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
test('多模型分布: share 数据级和=1、显示占比和=100%、行序按 share 降序、>6 折叠+展开、降级两列无 t/s', () => {
  const ctx = makeCtx();
  const h8 = multiFixture(8);
  const sel = { range: 'session', period: 'all', sid: 'sess_main' };
  const an = analyze(ctx, h8, sel);
  assert.equal(an.perModel.length, 8);
  let sum = 0;
  for (const e of an.perModel) sum += e.share;
  assert.ok(Math.abs(sum - 1) < 1e-9, '数据级 share 和恰为 1');
  // 折叠态：6 行 + 「展开全部 8 个模型」按钮（表格外）；chips 6 枚 + 「+2」；8<9 无搜索
  const dom = stripStyle(cardHTML(ctx, an, sel));
  const tab = dom.slice(dom.indexOf('zu-sv3-dtab'), dom.indexOf('</table>'));
  assert.equal((tab.match(/<tr>/g) || []).length, 7, '表头 + 6 行');
  assert.match(dom, /<button type="button" class="zu-sv3-more" data-sv3-more aria-expanded="false">展开全部 8 个模型</);
  assert.match(dom, /\+2<\/span>/, 'chips 超出收 +N');
  assert.doesNotMatch(dom, /zu-sv3-fsearch/);
  // 行序：share 降序；同 share 内保持 perModel（Σ输出降序）稳定序
  // （3/15 档：Model-5 out600 → Model-2 out300；2/15 档：Model-7 out800 → Model-4 out500）
  assert.ok(tab.indexOf('Model-5') >= 0 && tab.indexOf('Model-5') < tab.indexOf('Model-2') &&
    tab.indexOf('Model-2') < tab.indexOf('Model-7') && tab.indexOf('Model-7') < tab.indexOf('Model-4') &&
    tab.indexOf('Model-4') < tab.indexOf('Model-1'), '行序按请求数占比降序（同档稳定）');
  // 展开态：8 行全显 + 占比显示和 = 100%
  const domX = stripStyle(cardHTML(ctx, an, sel, { expanded: true }));
  const tabX = domX.slice(domX.indexOf('zu-sv3-dtab'), domX.indexOf('</table>'));
  assert.equal((tabX.match(/<tr>/g) || []).length, 9, '表头 + 8 行');
  assert.match(domX, /data-sv3-more/);
  assert.match(domX, /aria-expanded="true"/);
  const pcts = [...tabX.matchAll(/class="zu-sv3-pct">([\d.]+)%</g)].map(m => parseFloat(m[1]));
  assert.equal(pcts.length, 8);
  const pctSum = pcts.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(pctSum - 100) < 0.2, '显示占比和=100%，实得 ' + pctSum);
  // 表头三列：模型/均速/占比
  assert.match(dom, /<th>模型<\/th><th>均速<\/th><th>占比<\/th>/);
  // 降级模式（msAvail=false）：均速列隐藏（两列），表格内无 t/s
  const anL = analyze(ctx, fixtureLegacy(), { range: 'session', period: 'all', sid: 'sess_main' });
  assert.equal(anL.msAvail, false);
  const domL = stripStyle(cardHTML(ctx, anL, { range: 'session', period: 'all', sid: 'sess_main' }));
  const tabL = domL.slice(domL.indexOf('zu-sv3-dtab'), domL.indexOf('</table>'));
  assert.match(tabL, /<th>模型<\/th><th>占比<\/th>/, '降级两列：模型/占比');
  assert.ok(!tabL.includes('均速'), '降级无均速列');
  assert.ok(!tabL.includes('t/s'), '降级表格无 t/s 单位');
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
  assert.match(dom, /zu-sv3-fcount">All 2</, 'auto 计数');
  assert.match(dom, /2 models · 3 turns/, '多模型计数行');
  assert.match(dom, /Selected models · by requests/, '分布标题');
  assert.match(dom, /<th>Model<\/th><th>Avg speed<\/th><th>Share<\/th>/, '表头');
  // chips 显式选中英文计数
  const selAB = { range: 'session', period: 'all', sid: 'sess_main', filt: { mode: 'sel', keys: [KEYS.a, KEYS.b] } };
  const domAB = stripStyle(cardHTML(ctx, analyze(ctx, h, selAB), selAB));
  assert.match(domAB, /zu-sv3-fcount">Selected 2\/2</);
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
test('a11y: Tab/chips/搜索/展开全为 button+aria，弹出层 role=dialog 且搜索框带 aria-label', () => {
  const ctx = makeCtx();
  const h10 = multiFixture(10);
  const sel = { range: 'session', period: 'all', sid: 'sess_main' };
  const an = analyze(ctx, h10, sel);
  const dom = stripStyle(cardHTML(ctx, an, sel, { pop: { open: true, query: '' } }));
  // 9 枚 Tab 全是 button
  assert.equal((dom.match(/<button type="button" class="zu-sv-tab/g) || []).length, 9);
  assert.equal((dom.match(/<button type="button" class="zu-sv3-chip/g) || []).length, 6, 'chips 只显 6 枚且为 button');
  assert.equal((dom.match(/aria-pressed="(true|false)"/g) || []).length,
    (dom.match(/class="zu-sv-tab[ "]/g) || []).length + (dom.match(/class="zu-sv3-chip[ "]/g) || []).length +
    (dom.match(/class="zu-sv3-fpop-row/g) || []).length,
    'Tab+chips+弹出行全带 aria-pressed');
  // 搜索按钮（10 模型 ≥9）：button + aria-haspopup + aria-expanded 随弹出层开关
  assert.match(dom, /<button type="button" class="zu-sv3-fsearch" aria-haspopup="dialog" aria-expanded="true"/);
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
  assert.match(style, /width:var\(--zu-sv3-w,min\(920px,calc\(100vw - 24px\)\)\)/, '根定宽 920 基准');
  // 矮视口防纵滚：480 基准高钳进视口（min-height 不再暴露 --zu-sv3-h 变量）
  assert.match(style, /min-height:min\(480px,calc\(100vh - 16px\)\)/, '480 基准高钳视口');
  assert.ok(!style.includes('--zu-sv3-h'), '定高变量已废除');
  // tip 宽帽释放：宿主 .tip / .zusage-tps-tip 的 760 定宽对 V3 卡释放到 920 视口帽
  assert.match(style, /\.tip:has\(\.zu-sv3-root\),\.zusage-tps-tip:has\(\.zu-sv3-root\)\{width:min\(920px,calc\(100vw - 24px\)\)!important;max-width:min\(920px,calc\(100vw - 24px\)\)!important\}/,
    'tip 宽帽释放规则（920 视口钳）');
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
