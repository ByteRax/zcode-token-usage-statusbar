'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');
const { readOverlayPart, sliceOverlay } = require('./helpers/overlay-extract.cjs');

// v384 生成速度 Tooltip V3 集成测试（本文件由 V2 时代整卡测试重写而来，文件名保留）。
// V2 双 Tab 卡（speedCardV2HTML/spdAnalyze/spdRebuildOr 等）已随 V3 上线整体删除，V2
// 专属 DOM 结构锁由 tests/overlay-speed-v3-view.test.cjs 承接；本文件把 V2 老用例中
// 仍然成立的行为逐条移植到 V3 语义，测试入口 = wire 分片 spd3RebuildOr（V3 唯一集成
// 入口）：无轮表 → null（调用方回退 V1 旧卡），有 → 闭包 (curHover, curSel) →
// "\x01"+整卡串。聚焦跨分片端到端串（core→view→charts/heat→wire），纯函数级行为
// 已由 overlay-speed-v3-core/charts/heat/view 各测试锁定，不在此重复。
const core = readOverlayPart('04-speed-v3-core.js');
const view = readOverlayPart('04-speed-v3-view.js');
const charts = readOverlayPart('04-speed-v3-charts.js');
const heat = readOverlayPart('04-speed-v3-heat.js');
const wire = readOverlayPart('04-speed-v3-wire.js');
const bands = sliceOverlay('  var TPS_BANDS = [', '  /* tooltip 颜色对照图例');
const spdHelpers = sliceOverlay('  var SPD_RANGES = [', '  var SPD_PORTAL = "";');
const v2Tail = sliceOverlay('  var SPD_PORTAL = "";', '  /* SPD_V2_BLOCK_END */');

// 冻结时钟：spd3Analyze 的 today/week/month 窗与 month 日历都读 Date.now()，夹具必须
// 钉死同一时刻，否则 08:00 / 月末 / 跨年会间歇性变红（真实 Date 是假绿灯）。
const FIXED_NOW = new Date(2026, 10, 5, 14, 0, 0).getTime();   // 2026-11-05 14:00 本地时
function makeCtx(lang = 'zh') {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [FIXED_NOW])); }
    static now() { return FIXED_NOW; }
  }
  const ctx = vm.createContext({
    L: (zh, en) => lang === 'en' ? en : zh,
    Date: FakeDate, Math, JSON, isFinite, parseInt, parseFloat, Object, Array, String, Number,
  });
  vm.runInContext(bands + '\n' + spdHelpers + '\n' + v2Tail + '\n' +
    core + '\n' + view + '\n' + charts + '\n' + heat + '\n' + wire, ctx);
  return ctx;
}

const HOUR = 3600000, DAY = 86400000;
const KEYS = { a: 'prov_a\x1fglm-a', b: 'prov_b\x1fclaude-b' };
const host = x => JSON.parse(JSON.stringify(x));   // 跨沙箱对象先 JSON 往返再 deepEqual
const O = { fmtTok: String, fmtCnt: String, fmtMoney: u => '¥' + u.toFixed(2) };

// 用冻结时钟的本地时区固定点造真值轮表：3 个会话 / 2 个项目 / 跨日与跨月。
// msl 全四元组（v384 轮表契约：[mIdx,out,ms,n]）。
function fixture(opts = {}) {
  const d = (y, m, day, h) => new Date(y, m, day, h).getTime();
  const y = 2026, mo = 10, day = 5;
  const t0 = d(y, mo, day, 9);
  const yester = d(y, mo, day - 1, 15);
  const lastMonth = d(y, mo - 1, 5, 10);
  const mnames = opts.mnames || ['GLM-5.3-FlashX', 'Claude-Sonnet'];
  const raw = [
    [0, lastMonth, lastMonth - 60000, 1000, 10000, 8000, 1000, 1, [[0, 1000, 10000, 1]], 0.1, 1],
    [1, yester, yester - 60000, 3000, 10000, 20000, 3000, 2, [[0, 3000, 10000, 2]], 0.3, 1],
    [0, t0, t0 - 60000, 100, 1000, 500, 100, 1, [[0, 100, 1000, 1]], 0.01, 1],               // 100 t/s
    [0, t0 + HOUR, t0 + HOUR - 60000, 900, 3000, 6000, 900, 2,
      [[0, 600, 2000, 1], [1, 300, 1000, 1]], 0.09, 1],                                        // 300 t/s 混合轮
    [1, t0 + 2 * HOUR, t0 + 2 * HOUR - 60000, 400, 8000, 4000, 400, 1, [[1, 400, 8000, 1]], null, 0], // 50 t/s 费用缺失
    [2, t0 + 3 * HOUR, t0 + 3 * HOUR - 60000, 500, 5000, 3000, 500, 1, [[0, 500, 5000, 1]], 0.05, 1],
  ];
  raw.sort((a, b) => a[1] - b[1]);
  let prev = 0;
  const turns = raw.map(r => {
    const o = { s: r[0], t: r[1] - prev, b: r[2], out: r[3], ms: r[4], i: r[5], o: r[6],
      n: r[7], msl: r[8] };
    prev = r[1];
    if (r[9] !== null) o.c = r[9];
    if (r[10]) o.cf = 1;
    return o;
  });
  const h = { sid: 'sess_main', source: 'local', truncated: false,
    sids: ['sess_main', 'sess_proj2', 'sess_other'],
    snames: ['本会话', '同项目另一会话', '别的项目'],
    pids: [['proj_a', '项目A'], ['proj_a', '项目A'], ['proj_b', '项目B']],
    mnames, turns };
  if (opts.mkeys !== false) h.mkeys = [KEYS.a, KEYS.b];
  return h;
}

// wire 入口封装：spd3RebuildOr(...) → 闭包 → (curHover, curSel) → "\x01"+html
function build(ctx, h, sel, opts = {}) {
  ctx.__h = h === undefined ? fixture() : h;
  ctx.__sd = opts.sd === undefined ? null : opts.sd;
  ctx.__sel = Object.assign({ range: 'recent', period: 'recent', sid: 'sess_main' }, sel);
  ctx.__hi = typeof opts.hover === 'number' ? opts.hover : -1;
  ctx.__live = opts.live || null;
  ctx.__o = opts.o || O;
  ctx.__sess = Object.assign({ sid: 'sess_main' }, opts.sess);
  return vm.runInContext('spd3RebuildOr(__h, __sd, __sel, __hi, __live, __o, __sess)', ctx);
}
function htmlOf(ctx, rb, curHover, curSel) {
  ctx.__rb = rb;
  ctx.__ch = typeof curHover === 'number' ? curHover : -1;
  ctx.__cs = curSel === undefined ? null : curSel;
  return vm.runInContext('__rb(__ch, __cs)', ctx);
}
function card(ctx, sel, opts = {}) {
  const rb = build(ctx, opts.h, sel, opts);
  return rb ? htmlOf(ctx, rb, opts.hover, opts.curSel || null) : null;
}
const dom = html => html.replace(/<style>[\s\S]*?<\/style>/g, '');   // 结构断言剥离内联 CSS
const count = (s, needle) => s.split(needle).length - 1;

// ---------- 加权口径（V2 黄金行为移植） ----------
test('weighted average is Σout/Σms, never the arithmetic mean of per-turn speeds', () => {
  const ctx = makeCtx();
  // 只看模型 A（filt=sel → 左卡单模型态带主读数）：A 的会话三轮 100t/1s + 600t/2s +
  // 1000t/10s → Σout=1700、Σms=13s → 130.8；逐轮算术平均 (100+300+100)/3=166.7 绝不出现
  const sel = { range: 'session', period: 'all', sid: 'sess_main',
    filt: { mode: 'sel', keys: [KEYS.a] } };
  const html = dom(card(ctx, sel, { curSel: sel }));
  assert.ok(html.includes('130.8'), 'main number = weighted 1700t/13s');
  assert.ok(!html.includes('166.7'), 'arithmetic mean of per-turn speeds must not appear');
  assert.ok(html.includes('唯一模型'), 'filtered to a single model');
  // 多模型态（无筛选）无主大数字：分布表每模型 tps 仍是 Σout/Σms 口径（B=1000t/11s…）
  const multi = dom(card(ctx, { range: 'session', period: 'all' }));
  assert.match(multi, /2 个模型/, 'multi-model count row');
  assert.match(multi, /zu-sv3-dtab/, 'distribution table present');
});

// ---------- 范围隔离（无串数据） ----------
test('range isolation: session/project/all keep disjoint turn sets (no stale data)', () => {
  const ctx = makeCtx();
  const h = fixture();
  const left = (range) => dom(card(ctx, { range, period: 'all' }, { h }));
  // 会话=3 轮（sess_main）、项目=5 轮（proj_a 的 main+proj2）、全部=6 轮（含 proj_b）
  const s = left('session'), p = left('project'), a = left('all');
  assert.match(s, /3 轮/);
  assert.match(p, /5 轮/);
  assert.match(a, /6 轮/);
  // 切换后不留上一范围旧数据：左卡标题行随范围 Tab 同步（选中态唯一）
  for (const [html, range] of [[s, 'session'], [p, 'project'], [a, 'all']]) {
    const on = html.match(/data-sv-group="range" data-sv-val="([a-z]+)" aria-pressed="true"/);
    assert.equal(on[1], range, 'exactly one range tab selected: ' + range);
  }
});

// ---------- 20 组合经 wire 端到端无崩溃、无 0 t/s 假值 ----------
test('all 20 range × period combinations rebuild through the wire without zero-speed placeholders', () => {
  const ctx = makeCtx();
  const h = fixture();
  for (const range of ['recent', 'session', 'project', 'all']) {
    for (const period of ['recent', 'today', 'week', 'month', 'all']) {
      const html = card(ctx, { range, period }, { h });
      assert.equal(html.charCodeAt(0), 1, range + '×' + period + ' sentinel');
      assert.ok(html.includes('zu-sv3-root'), range + '×' + period + ' V3 root');
      assert.ok(!/[>，]0 t\/s/.test(dom(html)), range + '×' + period + ' no fake 0 t/s');
    }
  }
});

// ---------- recent 18 轮上限 + X 轴 HH:mm（V2 2026-11-09 用户规格移植） ----------
test('recent mode caps at 18 real turns without padding; bar aria keeps HH:mm only', () => {
  const ctx = makeCtx();
  const h = fixture();
  for (let i = 0; i < 20; i++) {
    h.turns.push({ s: 0, t: HOUR, b: 1, out: 200, ms: 1000, i: 800, o: 200, n: 1,
      msl: [[0, 200, 1000, 1]], c: 0.02, cf: 1 });
  }
  const html = dom(card(ctx, { range: 'all', period: 'recent' }, { h }));
  assert.equal(count(html, 'class="zu-sc-col'), 18, 'exactly 18 bars（SPD_BARS_MAX）');
  assert.ok(!/class="zu-sc-col empty"/.test(html), 'no fake padding');
  const aria = html.match(/aria-label="(\d{2}:\d{2})，[\d.]+ t\/s/);
  assert.ok(aria, 'bar aria carries time only: ' + (aria || [])[1]);
  assert.doesNotMatch(html, /aria-label="\d{2}\/\d{2} /, 'no date prefix in bar aria');
  // 悬停信息卡才携带完整年月日时分秒区间（full 字段），柱底只有 HH:mm
  assert.match(html, /title="\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} – /, 'full range in chart head title');
});

// ---------- 远端 fail-closed（V2 v287 语义移植：本地 scoped 行不误降级） ----------
test('remote identity fails closed: all-history downgrades to session with a notice; local scoped rows stay "all"', () => {
  const ctx = makeCtx();
  const h = fixture();
  // 真 remote 标：all 降级本会话 + 通知
  const remote = dom(card(ctx, { range: 'all', period: 'all' },
    { h, sess: { sid: 'sess_main', workspace_identity: 'remote:h1/a', remote: true } }));
  assert.match(remote, /data-sv-group="range" data-sv-val="session" aria-pressed="true"/,
    'remote pane downgrades to session range');
  assert.match(remote, /远端会话仅显示本会话历史/, 'downgrade notice present');
  // 本地 scoped 行（zusage 对本地行也写 workspace_identity，无 remote 标）不误降级
  const local = dom(card(ctx, { range: 'all', period: 'all' },
    { h, sess: { sid: 'sess_main', workspace_identity: '/Users/x/work/proj-a' } }));
  assert.match(local, /data-sv-group="range" data-sv-val="all" aria-pressed="true"/,
    'local scoped rows keep "all"');
  assert.doesNotMatch(local, /远端会话仅显示本会话历史|Remote pane: local session history only/,
    'no false remote notice');
});

// ---------- 悬停卡侧信道（SPD_PORTAL，v281 契约移植） ----------
test('hover card rides the SPD_PORTAL side channel with five fields and cost fallbacks', () => {
  const ctx = makeCtx();
  const h = fixture();
  // 未悬停：整卡 HTML 无信息卡、侧信道空串
  const plain = card(ctx, { range: 'recent', period: 'recent' }, { h });
  assert.doesNotMatch(dom(plain), /zu-sv-card/, 'no hover: no card in the card HTML');
  assert.equal(vm.runInContext('SPD_PORTAL', ctx), '', 'no hover: portal channel empty');
  // 悬停第 3 轮（混合轮，recent 顺序：上月/09:00/10:00）：侧信道产出五字段卡
  const hovered = card(ctx, { range: 'recent', period: 'recent' }, { h, hover: 2 });
  assert.doesNotMatch(dom(hovered), /zu-sv-card/, 'hovered: card stays out of the card HTML');
  const portal = vm.runInContext('SPD_PORTAL', ctx);
  assert.match(portal, /zu-sv-card/, 'portal channel carries the hovered bar card');
  for (const field of ['时间', '速度', '模型型号', 'Token 总消耗', '预估价格']) {
    assert.ok(portal.includes(field), 'five-field card has ' + field);
  }
  assert.match(portal, /t\/s/);
  assert.match(portal, /混合（2 种模型）/, 'multi-model bucket labels the mix, not a fake single model');
  // 费用缺失 → 暂无估价（绝不显示 0）；费用显示关闭 → 专用文案
  ctx.__anItem = null;
  const noCost = vm.runInContext(
    'spd3HoverCardHTML({ v: 50, models: [{ key: ' + JSON.stringify(KEYS.a) + ', name: "x", o: 1, ms: 1000 }], ' +
    'i: 1, o: 1, c: null, costFull: false, full: "A – B", a: 1, b: 2, label: "x" }, __o)', ctx);
  assert.match(noCost, /暂无估价/);
  ctx.__o2 = Object.assign({}, O, { fmtMoney: null });
  ctx.__noMoney = noCost;
  const off = vm.runInContext(
    'spd3HoverCardHTML({ v: 50, models: [{ key: ' + JSON.stringify(KEYS.a) + ', name: "x", o: 1, ms: 1000 }], ' +
    'i: 1, o: 1, c: 0.1, costFull: true, full: "A – B", a: 1, b: 2, label: "x" }, __o2)', ctx);
  assert.match(off, /费用显示已关闭/);
});

// ---------- 转义（模型名不可逃逸属性） ----------
test('text escaping: model/session names cannot break out of chip or card attributes', () => {
  const ctx = makeCtx();
  const evil = 'M"odel<X>&Y';
  const h = fixture({ mnames: [evil, 'Claude-Sonnet'] });
  const html = dom(card(ctx, { range: 'session', period: 'recent' }, { h }));
  assert.doesNotMatch(html, /<img/, 'no injected element');
  assert.match(html, /M&quot;odel&lt;X&gt;&amp;Y/, 'attribute-safe escaping on chips');
  // 悬停卡同样转义
  card(ctx, { range: 'session', period: 'recent' }, { h, hover: 0 });
  const portal = vm.runInContext('SPD_PORTAL', ctx);
  assert.ok(portal.includes('M&quot;odel&lt;X&gt;&amp;Y'), 'portal card escapes the model name');
  assert.ok(!portal.includes('<img'), 'portal card injects nothing');
});

// ---------- 双语 ----------
test('bilingual labels follow the instance language', () => {
  const ctx = makeCtx('en');
  const html = dom(card(ctx, { range: 'all', period: 'today' }));
  assert.match(html, /Generation speed/);
  assert.match(html, /Scope|Time/, 'scope/time labels');
  assert.match(html, /View speed bands/, 'en bands entry label');
  assert.match(html, /All \d/, 'en filter count (auto)');
});

// ---------- 空态（有效轮表 + 筛选/时间窗内无数据） ----------
test('empty selection yields the V3 empty state, never a crash or a 0 t/s chart', () => {
  const ctx = makeCtx();
  const h = fixture();
  // 显式筛选只含池外模型：池清空 → 图表空态 + 提示 + 无数据通知
  const sel = { range: 'session', period: 'today', sid: 'sess_main',
    filt: { mode: 'sel', keys: ['ghost\x1fmodel'] } };
  const html = dom(card(ctx, sel, { h, curSel: sel }));
  assert.match(html, /当前筛选无有效速度数据/, 'empty chart state');
  assert.match(html, /尝试选择更长时间范围/, 'empty state suggests a longer range');
  assert.ok(!/class="zu-sc-bar/.test(html), 'no bars without data');
  assert.match(html, /无数据/, 'selMissing notice rides the notice row');
  // 左卡显 em dash（绝不造 0 t/s 主读数）
  assert.match(html, /class="dim">—</, 'left card shows an em dash, not 0');
  // 真空轮表走 null 回退 V1（wire 契约，不属于空态卡）
  assert.equal(build(ctx, { source: 'local', sids: ['x'], snames: ['x'], pids: [['p', 'p']],
    mnames: ['m'], mkeys: ['k\x1fm'], sid: 'x', truncated: false, turns: [] },
    { range: 'session', period: 'week', sid: 'x' }), null);
});

// ---------- today 空小时桶（多模型折线命中列 / 单模型柱空桶两形态） ----------
test('today buckets cover 00:00 to current hour; no-data hours are empty, not zero', () => {
  const ctx = makeCtx();
  // 多模型（A+B 混合）→ 折线形态：命中列 = 00..14 共 15 列
  const line = dom(card(ctx, { range: 'all', period: 'today' }));
  assert.equal(count(line, 'class="zu-sv3-hit"'), 15, '00:00..14:00 = 15 hourly hit columns');
  assert.ok(!/[>，]0 t\/s/.test(line), 'no zero readings for empty hours');
  // 只看 B（sess_main 今天仅 10:00 混合轮有 B）→ 单模型柱形态 + 聚焦：
  // 有效桶 ≤3 默认聚焦有效时段（sel.focus 缺省，V2 行为沿用）→ 1 柱
  const sel = { range: 'session', period: 'today', sid: 'sess_main',
    filt: { mode: 'sel', keys: [KEYS.b] } };
  const bars = dom(card(ctx, sel, { curSel: sel }));
  assert.equal(count(bars, 'class="zu-sc-col'), 1, 'focused real hour buckets only (≤3 collapse)');
  assert.ok(!/[>，]0 t\/s/.test(bars), 'columns carry no fake zero');
  assert.match(bars, /aria-label="10:00，300\.0 t\/s，Claude-Sonnet"/,
    'single-model bar aria: HH:mm + per-model weighted speed');
});

// ---------- 横滚记忆 data-sv-key（v281 契约移植：选择键 + 首开滚到最新） ----------
test('V3 card root carries the selection key; both host chains keep h-scroll per key (v281)', () => {
  const ctx = makeCtx();
  const html = card(ctx, { range: 'project', period: 'week' });
  assert.match(html, /zu-sv3-root" data-sv-key="project\|week\|auto"/,
    'root carries range|period|filterSig key');
  assert.match(html, /data-sv-end="1"/, 'first-open scrolls to latest (host consumes)');
  // 精简链 showTpsTip：重建前从旧 DOM 连同选择键捕获 scrollLeft，键同才回填（01 分片）
  const { sliceOverlay: _s, readOverlaySource } = require('./helpers/overlay-extract.cjs');
  const src = readOverlaySource();
  const showFn = src.slice(src.indexOf('  function showTpsTip(el) {'),
    src.indexOf('  function hideTpsTip() {'));
  assert.match(showFn, /\.zu-sc-wrap[\s\S]*?zu-sv3-root[\s\S]*?data-sv-key[\s\S]*?scrollLeft/,
    'showTpsTip captures scrollLeft with the V3 selection key before rebuild');
  assert.match(showFn, /scrollLeft = st0\.x/, 'restore only when key matches');
  // 全量链 drawTip（08 分片）：捕获行带三态注释、回填同键守卫
  const drawBlock = src.slice(src.indexOf('var oldChartL = null, oldChartKey = "";'),
    src.indexOf('var oldChartL = null, oldChartKey = "";') + 2600);
  assert.match(drawBlock, /oldChartKey = or0 \? \(or0\.getAttribute\("data-sv-key"\) \|\| ""\) : "";/,
    'drawTip captures the old V3 selection key');
  assert.match(drawBlock, /savedChart && savedChart\.key === oldChartKey \? savedChart\.x/,
    'hidden card restores the saved scroll position');
});

// ---------- V2 布局量测过渡：spdFitTip 旧卡分支保留（热更过渡期防呆） ----------
test('spdFitTip V3 branch: viewport clamp only; legacy V2 card path still nulls the size cache', () => {
  const ctx = makeCtx();
  // 行为级断言在 tests/overlay-speed-v3-wire.test.cjs（V3 分支全量）；
  // 这里只锁源码形状：V3 分支先行、zoom 清理与 --zu-sv-* 清除成对出现
  const fn = sliceOverlay('  function spdFitTip(tip, reset) {', '  /* SPD_V2_BLOCK_END */');
  const v3Branch = fn.slice(fn.indexOf('.zu-sv3-root'), fn.indexOf('root = tip.querySelector(".zu-sv-root")'));
  assert.match(v3Branch, /root\.style\.zoom = "";/, 'V3 card never gets zoom');
  assert.match(v3Branch, /maxWidth = Math\.max\(1, vw0 - 24\) \+ "px";/);
  assert.match(v3Branch, /maxHeight = Math\.max\(1, vh0 - 16\) \+ "px";/);
  assert.match(v3Branch, /typeof tip\.style\.removeProperty === "function"/, 'VM stub guard kept');
  assert.match(v3Branch, /removeProperty\("--zu-sv-width"\);/);
});

// ---------- 生产接线（删 V2 后 V3 必须是唯一重建链） ----------
test('production wiring: spd3RebuildOr is wired at all three rebuild sites (live/html/chip)', () => {
  const { readOverlaySource } = require('./helpers/overlay-extract.cjs');
  const src = readOverlaySource();
  assert.match(src, /speedTipRebuild = \(typeof spd3RebuildOr === "function"\n\s*\? spd3RebuildOr\(v2h, v2sd, v2selL, speedChartHover, speedView,/,
    'buildLiveTip wiring');
  assert.match(src, /var v2fn = \(typeof spd3RebuildOr === "function"\n\s*\? spd3RebuildOr\(d\.speed_history \|\|/,
    'html(d) wiring');
  assert.match(src, /var cv2 = \(typeof spd3RebuildOr === "function"\n\s*\? spd3RebuildOr\(t && t\.speedHistory,/,
    'compact chip wiring');
  assert.doesNotMatch(src, /speedCardV2HTML\(/, 'V2 card entry point is gone');
  assert.doesNotMatch(src, /spdRebuildOr\(/, 'V2 rebuild entry point is gone');
});
