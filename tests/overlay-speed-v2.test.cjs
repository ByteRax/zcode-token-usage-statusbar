const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

// v254 速度 Tooltip 重构：切片取自 TPS_BANDS 到 zuBarSpeedView 之前（含全部 spd* 纯函数）。
// 夹具只注入 L/state/stub，不执行整 IIFE——纯函数行为级验证，不用源码字符串匹配冒充。
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
// V2 纯函数块 + 同源的 TPS_BANDS/tpsBand/tpsBandText：按唯一标记切片，
// 不依赖与旧 bandHelpers 相同的区间（旧测试切片必须保持逐字不变）。
const bandHelpers = source.slice(source.indexOf('  var TPS_BANDS = ['), source.indexOf('  /* 返回 null = 调用方应把这当成')) +
  '\n' + source.slice(source.indexOf('  /* ---------- v254 生成速度 Tooltip 重构'), source.indexOf('  /* SPD_V2_BLOCK_END */'));

// 冻结时钟：spdAnalyze 用 Date.now() 做 today/week/month 过滤，夹具必须钉死同一
// 时刻，否则 08:00 / 月末 / 跨年会间歇性变红（真实 Date 是假绿灯）。
const FIXED_NOW = new Date(2026, 10, 5, 14, 0, 0).getTime();   // 2026-11-05 14:00 本地时
function makeCtx(lang = 'zh') {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [FIXED_NOW])); }
    static now() { return FIXED_NOW; }
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

const HOUR = 3600000, DAY = 86400000;
// 用冻结时钟的本地时区固定点造真值轮表：3 个会话 / 2 个项目 / 跨日与跨月
function fixture() {
  const d = (y, m, day, h) => new Date(y, m, day, h).getTime();
  const y = 2026, mo = 10, day = 5;
  const t0 = d(y, mo, day, 9);
  const yester = d(y, mo, day - 1, 15);
  const lastMonth = d(y, mo - 1, 5, 10);
  const sids = ['sess_main', 'sess_proj2', 'sess_other'];
  const snames = ['本会话', '同项目另一会话', '别的项目'];
  const pids = [['proj_a', '项目A'], ['proj_a', '项目A'], ['proj_b', '项目B']];
  const mnames = ['GLM-5.3-FlashX', 'Claude-Sonnet'];
  // 轮：s, t(绝对), b, out, ms, i, o, n, msl, c, cf
  const raw = [
    [0, lastMonth, lastMonth - 60000, 1000, 10000, 8000, 1000, 1, [[0, 1000]], 0.1, 1],
    [1, yester, yester - 60000, 3000, 10000, 20000, 3000, 2, [[0, 3000]], 0.3, 1],
    [0, t0, t0 - 60000, 100, 1000, 500, 100, 1, [[0, 100]], 0.01, 1],          // 100 t/s
    [0, t0 + HOUR, t0 + HOUR - 60000, 900, 3000, 6000, 900, 2, [[0, 600], [1, 300]], 0.09, 1], // 300 t/s 多模型
    [1, t0 + 2 * HOUR, t0 + 2 * HOUR - 60000, 400, 8000, 4000, 400, 1, [[1, 400]], null, 0],   // 50 t/s 费用缺失
    [2, t0 + 3 * HOUR, t0 + 3 * HOUR - 60000, 500, 5000, 3000, 500, 1, [[0, 500]], 0.05, 1],  // 100 t/s 别的项目
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
  return {
    sid: 'sess_main', source: 'local', truncated: false,
    sids, snames, pids, mnames, turns,
  };
}

function analyze(ctx, sel) {
  const s = Object.assign({ sid: 'sess_main' }, sel);
  return vm.runInContext('spdAnalyze(' + JSON.stringify(ctx.__h) + ',' + JSON.stringify(s) + ')', ctx);
}

test('history unpack restores delta timestamps, index tables and model names', () => {
  const ctx = makeCtx();
  ctx.__h = fixture();
  const u = vm.runInContext('spdUnpack(__h)', ctx);
  assert.equal(u.turns.length, 6);
  assert.equal(u.turns[0].t, new Date(new Date().getFullYear(), new Date().getMonth() - 1, 5, 10).getTime());
  assert.equal(u.turns[3].models.length, 2);
  assert.equal(u.turns[3].models[0].m, 'GLM-5.3-FlashX');
  assert.equal(u.turns[4].c, null);
  assert.equal(u.turns[3].pid, 'proj_a');
  assert.equal(u.turns[5].pid, 'proj_b');
});

test('weighted average is Σout/Σms, never the arithmetic mean of per-turn speeds', () => {
  const ctx = makeCtx();
  ctx.__h = fixture();
  const an = analyze(ctx, { range: 'session', period: 'all', dim: 'time' });
  // 本会话 3 轮 in-scope（会话范围只 sess_main）: 100/1s, 900/3s, 100/10s(上月)
  // 但 period=all 跨月 => 按月桶聚合；overall 仍按全部轮 Σout/Σms
  const ov = an.overall;
  assert.ok(ov, 'overall exists');
  // 会话范围：sess_main 三轮 out=100+900+1000=2000, ms=1000+3000+10000=14000 => 142.857 t/s
  assert.ok(Math.abs(ov.v - 2000 / 14) < 0.001, 'weighted ' + ov.v);
  // 逐轮算术平均 (100+300+100)/3=166.7 —— 绝不等于加权结果
  assert.ok(Math.abs(ov.v - (100 + 300 + 100) / 3) > 1);
  assert.equal(ov.n, 4);   // 1+2+1 请求
  assert.equal(ov.turns, 3);
});

test('all 20 range × period combinations analyze without stale data or zero-speed placeholders', () => {
  const ctx = makeCtx();
  ctx.__h = fixture();
  for (const range of ['recent', 'session', 'project', 'all']) {
    for (const period of ['recent', 'today', 'week', 'month', 'all']) {
      const an = analyze(ctx, { range, period, dim: 'time' });
      assert.ok(an, range + '×' + period);
      assert.equal(an.range, range);
      assert.equal(an.period, period);
      for (const it of an.items) {
        if (it.empty) { assert.ok(it.v == null, 'empty bucket carries no speed'); continue; }
        assert.ok(it.v > 0, 'no misleading 0 t/s');
        assert.ok(isFinite(it.v));
      }
      // 切换后不留上一范围的旧数据：overall 与该范围轮集一致
      // 会话范围随 period 过滤：today/week/month 只留今天两轮，all 含上月一轮
      if (range === 'session' && period === 'all' && an.overall) assert.equal(an.overall.turns, 3);
      if (range === 'session' && period !== 'all') assert.ok(an.overall.turns <= 3);
      if (range === 'recent') assert.ok(an.overall.turns <= 3);
    }
  }
});

test('recent mode caps at 18 real turns without padding; today has empty hour buckets', () => {
  const ctx = makeCtx();
  const h = fixture();
  // 追加 20 个同小时轮，验证 18 上限与无补位
  const last = h.turns[h.turns.length - 1];
  const base = h.turns.reduce((a, r) => a + r.t, 0);
  for (let i = 0; i < 20; i++) h.turns.push({ s: 0, t: HOUR, b: base + HOUR - 60000,
    out: 200, ms: 1000, i: 800, o: 200, n: 1, msl: [[0, 200]], c: 0.02, cf: 1 });
  ctx.__h = h;
  const an = analyze(ctx, { range: 'all', period: 'recent', dim: 'time' });
  assert.equal(an.items.length, 18, 'exactly 18 bars（2026-11-09 用户规格 16→18）');
  assert.ok(an.items.every(x => !x.empty), 'no fake padding');
  // 柱底只放时分短标签，完整年月日时分秒留给 hover 卡；避免 30px 柱宽内长串互相覆盖
  assert.ok(an.items.every(x => /^\d{2}:\d{2}$/.test(x.label)), 'recent bars use HH:MM label');
  assert.ok(an.items.every(x => /\d{4}-\d{2}-\d{2}/.test(x.full)), 'full timestamp retained for hover card');
  const today = analyze(ctx, { range: 'all', period: 'today', dim: 'time' });
  assert.ok(today.items.length >= 2);
  assert.ok(today.items.some(x => x.empty), 'hours with no data are empty, not zero');
  assert.ok(today.items.every(x => !x.empty || x.v == null));
});

test('period buckets: today hourly, 7 days/this month/all-history always daily (v291 heatmap granularity)', () => {
  const ctx = makeCtx();
  ctx.__h = fixture();
  const unit = (range, period) => analyze(ctx, { range, period, dim: 'time' }).unit;
  assert.equal(unit('all', 'today'), 'hour');
  assert.equal(unit('all', 'week'), 'day');
  assert.equal(unit('all', 'month'), 'day');
  assert.equal(unit('all', 'all'), 'day');
  // v291：全部历史切热力图，日粒度恒定——长跨度不再降档月/季/年（旧柱状图自适应分档退役）。
  // 仍验证长跨度下 items 全部是日桶（天数有界、无月/季/年桶混入）。
  function older(days) {
    const h = fixture();
    const abs = [];
    let prev = 0;
    for (const r of h.turns) { prev += r.t; abs.push(prev); }
    abs[0] -= days * DAY;
    abs.sort((x, y) => x - y);
    prev = 0;
    h.turns = h.turns.map((r, i) => {
      const d = abs[i] - prev; prev = abs[i];
      return Object.assign({}, r, { t: d, b: abs[i] - 60000 });
    });
    return h;
  }
  const an = analyze(ctx, (ctx.__h = older(400), { range: 'all', period: 'all', dim: 'time' }));
  assert.equal(an.unit, 'day', 'long history stays daily for heatmap');
  assert.ok(an.items.length >= 1);
  assert.ok(an.items.every(x => x.a > 0 && new Date(x.a).getHours() === 0 && new Date(x.a).getMinutes() === 0),
    'every bucket key is a local midnight day start');
  const an2 = analyze(ctx, (ctx.__h = older(5 * 370), { range: 'all', period: 'all', dim: 'time' }));
  assert.equal(an2.unit, 'day', 'multi-year history stays daily for heatmap');
});

test('project range = current project (proj_a, 5 turns), always time dimension (v272)', () => {
  const ctx = makeCtx();
  ctx.__h = fixture();
  const pd = analyze(ctx, { range: 'project', period: 'all' });
  assert.equal(pd.dim, 'time');
  assert.equal(pd.overall.turns, 5, 'proj_a: main + proj2 turns only');
  assert.match(pd.title, /当前项目/);
  assert.ok(!source.includes('zu-sv-dimsel'), 'dimension select removed from UI');
  assert.ok(!source.includes('SPD_DIMS'), 'SPD_DIMS table removed');
});

test('remote identity fails closed: all-history downgrades to local session with a notice', () => {
  const ctx = makeCtx();
  ctx.__h = fixture();
  const an = analyze(ctx, { range: 'all', period: 'all', dim: 'project', remote: true });
  assert.equal(an.range, 'session');
  assert.match(an.notice, /远端|Remote/);
  assert.equal(an.overall.turns, 3, 'no local data mixed in as remote history');
});

test('hover card renders five fields with full interval, multi-model, token split and cost fallback', () => {
  const ctx = makeCtx();
  ctx.__h = fixture();
  const an = analyze(ctx, { range: 'recent', period: 'recent', dim: 'time' });
  const o = { fmtTok: v => String(v), fmtCnt: v => String(v), fmtMoney: u => '¥' + u.toFixed(2) };
  ctx.__o = o;
  const card = vm.runInContext('spdCardHTML(__it, 0, __o)', Object.assign(ctx, { __it: an.items[0] }));
  assert.match(card, /时间/);
  assert.match(card, /速度/);
  assert.match(card, /模型型号/);
  assert.match(card, /Token 总消耗/);
  assert.match(card, /预估价格/);
  assert.match(card, /t\/s/);
  // 多模型桶显示「多模型（N 种）」而非冒充唯一模型
  const multi = an.items.find(x => x.models && x.models.length > 1);
  if (multi) {
    ctx.__it = multi;
    const c2 = vm.runInContext('spdCardHTML(__it, 0, __o)', ctx);
    assert.match(c2, /多模型/);
  }
  // 费用缺失
  const noCost = { v: 50, models: [{ m: 'x', o: 1 }], modelCount: 1, i: 1, o: 1, c: null, costFull: false, full: 'A – B' };
  ctx.__it = noCost;
  assert.match(vm.runInContext('spdCardHTML(__it, 0, __o)', ctx), /暂无估价/);
  // 费用显示关闭
  ctx.__o = Object.assign({}, o, { fmtMoney: null });
  assert.match(vm.runInContext('spdCardHTML(__it, 0, __o)', ctx), /费用显示已关闭/);
});

test('text escaping: model/session names cannot break out of card attributes', () => {
  const ctx = makeCtx();
  const evil = { v: 100, models: [{ m: '"><img src=x onerror=1>', o: 10 }], modelCount: 1,
    i: 1, o: 1, c: 0.1, costFull: true, full: '"><b>x</b>' };
  ctx.__it = evil; ctx.__o = { fmtTok: String, fmtCnt: String, fmtMoney: u => String(u) };
  const card = vm.runInContext('spdCardHTML(__it, 0, __o)', ctx);
  assert.doesNotMatch(card, /<img/);
  assert.match(card, /&lt;img/);
  assert.doesNotMatch(card, /<b>x<\/b>/);
  assert.match(card, /&quot;&gt;&lt;b&gt;x&lt;\/b&gt;/);
});

test('V2 header is a single row (title left, dual tab groups right); stats time lives in chart head; legend intact (v278)', () => {
  const ctx = makeCtx();
  ctx.__h = fixture();
  const o = { speedHistory: ctx.__h, sel: { range: 'project', period: 'week', dim: 'time', sid: 'sess_main' },
    live: null, segsHover: -1, fmtTok: String, fmtCnt: String, fmtMoney: u => '¥' + u.toFixed(2) };
  ctx.__o = o;
  const html = vm.runInContext('speedCardV2HTML(__o)', ctx);
  // v295：注入 <style> 含 .zu-speed-body/.zu-sv-filter 等选择器字符串——计数/切片一律
  // 在剥离 style 后的 DOM 串上进行，不与 CSS 文本互相污染
  const dom = html.replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.match(html, /生成速度/);
  assert.equal((dom.match(/data-sv-group="range"/g) || []).length, 5, '4 range tabs + row');
  assert.equal((dom.match(/data-sv-group="period"/g) || []).length, 6, '5 period tabs + row');
  assert.doesNotMatch(html, /zu-sv-dimsel/, 'dimension select removed (v272)');
  // 单行 Header：标题与双 Tab 组同容器（范围在前、时间在后），旧独立筛选行删除
  const bodyStart = dom.indexOf('zu-speed-body');
  assert.ok(bodyStart > 0, 'body marker present');
  const head = dom.slice(0, bodyStart);
  const body = dom.slice(bodyStart);
  assert.match(head, /zu-sv-head[^]*zu-sv-title">生成速度/, 'title inside the header row');
  assert.match(head, /zu-sv-head[^]*data-sv-group="range"[^]*data-sv-group="period"/,
    'scope group before period group, both inside the header');
  assert.equal((dom.match(/zu-sv-filter/g) || []).length, 1, 'standalone filter row removed (v278)');
  assert.doesNotMatch(head, /zu-sv-range/, 'no time capsule in the header (v278)');
  // 统计时间：唯一 .zu-sv-range 位于图表标题栏右端，title 挂完整格式区间
  assert.equal((dom.match(/zu-sv-range/g) || []).length, 1, 'single range element, in chart head only');
  assert.match(body, /zu-sc-head[^]*?zu-sv-range/, 'range sits in the chart title bar');
  assert.match(body, /zu-sv-range" title="\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} – /,
    'hover shows full YYYY-MM-DD HH:mm:ss range');
  assert.match(html, /zu-sc-unit">t\/s<\//, 'lightweight unit badge without 单位： prefix (v286)');
  assert.match(html, /zu-sv-legend-btn[^>]*aria-label="查看速度档位说明"/, 'dedicated bands entry label (v286)');
  assert.match(html, /<circle cx="10" cy="10" r="8\.15"/, 'speed-bands SVG ring (v286)');
  assert.equal((html.match(/<path d="M(6\.35|10|13\.65) 13\.2V/g) || []).length, 3, 'three ascending speed bars');
  assert.ok(body.indexOf('zu-sc-unit') >= 0 && body.indexOf('zu-sc-unit') < body.indexOf('zu-sv-range'),
    'unit follows the chart title; range is the far-right element');
  // v282：底部常驻图例移除，改图表标题栏问号按钮 + 浮层（.zu-sv-li 移入浮层内容构建器）
  assert.doesNotMatch(html, /zu-sv-legend"|zu-sv-legend-t|zu-sv-legend-items/, 'persistent bottom legend removed (v282)');
  assert.doesNotMatch(html, /zu-sv-li[ "]/, 'band chips live in the popup builder now');
  assert.match(html, /zu-sv-legend-btn/, 'question button sits in the chart head');
  assert.match(html, /data-sv-band="/, 'button carries the current band for the popup highlight');
  const lg = vm.runInContext('spdLegendCardHTML(tpsBand(138.4).cls)', ctx);
  assert.equal((lg.match(/zu-sv-li[ "]/g) || []).length, 10, 'ten bands in the popup');
  assert.ok(lg.indexOf('&lt;40') >= 0 && lg.indexOf('&lt;40') < lg.indexOf('70–150') &&
    lg.indexOf('70–150') < lg.indexOf('≥2000'), 'ascending order');
  assert.equal((lg.match(/zu-sv-li cur/g) || []).length, 1, 'exactly one highlighted band');
  assert.match(lg, /70–150/, '138.4 t/s highlights 70–150');
  assert.doesNotMatch(vm.runInContext('spdLegendCardHTML("")', ctx), /zu-sv-li cur/, 'no speed: no highlight');
  assert.match(lg, /档位说明/, 'popup title');
  assert.doesNotMatch(html, /zu-basis|统计口径|均值参考|zu-pj-time/);
  assert.doesNotMatch(html, /zu-sc-lead|zu-sc-new/);
});

test('live status is a note, not the history card title; estimate stays separate from weighted avg', () => {
  const ctx = makeCtx();
  ctx.__h = fixture();
  const mk = live => {
    ctx.__o = { speedHistory: ctx.__h, sel: { range: 'session', period: 'recent', dim: 'time', sid: 'sess_main' },
      live, segsHover: -1, fmtTok: String, fmtCnt: String, fmtMoney: u => '¥' + u.toFixed(2) };
    return vm.runInContext('speedCardV2HTML(__o)', ctx);
  };
  const plain = mk(null);
  assert.ok(!plain.includes('历史统计'), 'hist tag removed (v298.2)');
  assert.match(plain, /最近18轮平均速度/, 'per-tab left title (recent)');
  assert.doesNotMatch(plain, /不含进行中请求/, 'wording removed per user spec (v273)');
  assert.match(plain, /平均速度/);
  assert.match(plain, /zu-sl-title">最近18轮平均速度<\/span>/,
    'v278 title layer: 平均速度 as card title + small history tag');
  assert.doesNotMatch(plain, /zu-sl-k[ "]/, '.zu-sl-k label row removed (v278)');
  const busy = mk({ statusText: '工具执行中', speedValue: 88.8, kind: 'estimate' });
  assert.doesNotMatch(busy, /zu-sl-title">工具执行中/, 'live status must not be the card title');
  assert.doesNotMatch(busy, /Σ有效输出/, 'formula line removed in v263');
  assert.match(busy, /zu-sl-sub">工具执行中/, 'live status as lightweight header badge (v273)');
  assert.match(busy, /生成中估 88\.8 t\/s/);
  assert.match(busy, /平均速度/);
});

test('old snapshots without speed_history fall back to null rebuild (legacy layout preserved)', () => {
  const ctx = makeCtx();
  const fn = vm.runInContext('spdRebuildOr(null, {range:"recent",period:"recent",dim:"time"}, -1, null, {})', ctx);
  assert.equal(fn, null);
  const fn2 = vm.runInContext('spdRebuildOr({turns:[]}, {range:"recent",period:"recent",dim:"time"}, -1, null, {})', ctx);
  assert.equal(fn2, null);
});

test('bilingual labels follow the instance language', () => {
  const ctx = makeCtx('en');
  ctx.__h = fixture();
  const an = analyze(ctx, { range: 'all', period: 'today', dim: 'time' });
  ctx.__o = { speedHistory: ctx.__h, sel: { range: 'all', period: 'today', dim: 'time', sid: 'sess_main' },
    live: null, segsHover: -1, fmtTok: String, fmtCnt: String, fmtMoney: String };
  const html = vm.runInContext('speedCardV2HTML(__o)', ctx);
  assert.match(html, /Generation speed/);
  assert.match(html, /View speed bands/, 'en legend entry label (v286)');
  assert.match(html, /Scope|Time/);
  assert.match(html, /zu-sc-unit">t\/s<\//, 'unit badge is language-neutral (v286)');
  assert.match(html, /No rated turns|· average speed/, 'en title drops granularity word (v292)');
});

// ---- Review 补强：范围隔离 / 维度矩阵 / 重建链路 / 局部费用 / 空态 ----
test('range isolation: session/project/all keep disjoint turn sets (no stale data)', () => {
  const ctx = makeCtx(); ctx.__h = fixture();
  const by = (range) => analyze(ctx, { range, period: 'all', dim: 'time' });
  const s = by('session'), p = by('project'), a = by('all');
  assert.ok(s.overall && p.overall && a.overall);
  // 会话=3 轮（sess_main），项目=5 轮（proj_a 的 main+proj2），全部=6 轮（含 proj_b）
  assert.equal(s.overall.turns, 3);
  assert.equal(p.overall.turns, 5);
  assert.equal(a.overall.turns, 6);
  assert.ok(s.overall.out < p.overall.out && p.overall.out < a.overall.out);
});

test('dimension switch removed: dim is always time regardless of requested dim (v272)', () => {
  const ctx = makeCtx(); ctx.__h = fixture();
  for (const range of ['recent', 'session', 'project', 'all']) {
    for (const dim of ['time', 'session', 'project']) {
      const an = analyze(ctx, { range, period: 'all', dim });
      assert.equal(an.dim, 'time', range + ' always time');
      assert.equal(an.dims.join(','), 'time', range + ' dims');
    }
  }
});

test('rebuild closure reads explicit current hover and sel (no instance-symbol dependency)', () => {
  const ctx = makeCtx(); ctx.__h = fixture();
  const sel = { range: 'recent', period: 'recent', dim: 'time', sid: 'sess_main' };
  ctx.__sel = sel; ctx.__o = { fmtTok: String, fmtCnt: String, fmtMoney: u => '¥' + u.toFixed(2) };
  const rebuild = vm.runInContext('spdRebuildOr(__h, __sel, -1, null, __o, {sid:"sess_main"})', ctx);
  assert.equal(typeof rebuild, 'function');
  const a = vm.runInContext('__rb(-1, __sel)', Object.assign(ctx, { __rb: rebuild }));
  assert.match(a, /zu-sv-root/);
  assert.doesNotMatch(a, /zu-sv-card/);              // 未悬停无卡（v281 起卡经 SPD_PORTAL 侧信道，不进整卡 HTML）
  assert.equal(vm.runInContext('SPD_PORTAL', ctx), '', 'no hover: portal channel empty');
  const b = vm.runInContext('__rb(2, __sel)', Object.assign(ctx, { __rb: rebuild }));
  assert.doesNotMatch(b, /zu-sv-card/);              // 整卡 HTML 不含信息卡（v281 Portal 化）
  const portal = vm.runInContext('SPD_PORTAL', ctx); // 传当前 hover：侧信道产出五字段卡
  assert.match(portal, /zu-sv-card/);
  assert.match(portal, /zu-sv-crow/);
  // 筛选态是同一对象引用：改属性后闭包立即生效，不依赖重新赋值
  sel.range = 'project'; sel.period = 'all';
  const c = vm.runInContext('__rb(0, __sel)', Object.assign(ctx, { __rb: rebuild }));
  assert.match(c, /当前项目/);
  assert.match(c, /data-sv-val="project" aria-pressed="true"/);
  // 时间胶囊 v270 带年
  assert.match(c, /\d{4}\/\d{2}\/\d{2}/, 'range pill carries year');
});

test('partial cost is marked, missing cost shows unavailable, cost-off hides the estimate', () => {
  const ctx = makeCtx();
  const base = { v: 100, models: [{ m: 'glm', o: 1 }], modelCount: 1, i: 10, o: 1,
    c: 0.5, costFull: false, full: 'A – B' };
  ctx.__it = base; ctx.__o = { fmtTok: String, fmtCnt: String, fmtMoney: u => '¥' + u.toFixed(2) };
  assert.match(vm.runInContext('spdCardHTML(__it, 0, __o)', ctx), /含兜底估价/);
  const html = vm.runInContext('speedCardV2HTML({speedHistory: __h, sel:{range:"recent",period:"recent",dim:"time",sid:"sess_main"}, live:null, segsHover:0, fmtTok:String, fmtCnt:String, fmtMoney:String})', Object.assign(ctx, { __h: fixture() }));
  assert.match(html, /zu-sv-root/);
});

test('empty history yields an empty V2 state, never a crash or a 0 t/s chart', () => {
  const ctx = makeCtx();
  ctx.__h = { source: 'local', sids: [], snames: [], pids: [], mnames: [], turns: [], truncated: false };
  const an = analyze(ctx, { range: 'all', period: 'today', dim: 'time' });
  assert.ok(an);
  assert.equal(an.overall, null);
  assert.equal(an.peak, null);
  ctx.__o = { speedHistory: ctx.__h, sel: { range: 'all', period: 'today', dim: 'time', sid: '' },
    live: null, segsHover: -1, fmtTok: String, fmtCnt: String, fmtMoney: String };
  const html = vm.runInContext('speedCardV2HTML(__o)', ctx);
  assert.match(html, /当前筛选无有效速度数据/);
  assert.doesNotMatch(html, /zu-sc-bar/);
});

test('today buckets cover 00:00 to current hour and cap at 16 bars', () => {
  const ctx = makeCtx(); ctx.__h = fixture();
  const an = analyze(ctx, { range: 'all', period: 'today', dim: 'time' });
  assert.equal(an.unit, 'hour');
  assert.equal(an.items.length, 15, '00:00..14:00 = 15 hourly buckets');
  assert.ok(an.items.filter(x => x.empty).length >= 10, 'no-data hours are empty');
  assert.ok(an.items.every(x => x.empty || x.v > 0));
});

// ---------- v263 行为级：Tab 点击竞态与交互冻结 ----------
// 用户实报「范围/时间 Tab 点击无效」：生成中 updateLive 每 100ms 重编整卡（tipSig 每 tick
// 变化），mousedown 命中的按钮在 mouseup 前被 innerHTML 替换，click 落到共同祖先、
// closest(".zu-sv-tab") 为 null。v263 把 Tab 切换提前到 pointerdown（重建窗口前同步生效）。
// 切片取 speedTabActivate 函数本体（含 stopPropagation/重建调用），不跑整 IIFE。
const tabFn = source.slice(source.indexOf('    function speedTabActivate(e) {'),
  source.indexOf('      return true;\n    }\n    /* 任何按下交互') + '      return true;\n    }\n'.length);

function makeTabCtx() {
  const ctx = makeCtx();
  // 实例闭包符号 + 可观测桩：drawTip 记录调用，tipFor.__tip 承接重建串
  const st = vm.runInContext(`(() => {
    const calls = { draw: [], stop: 0 };
    let speedSel = { range: "recent", period: "recent", dim: "time" };
    let speedChartHover = -1, speedInteractAt = 0;
    const tipFor = { __tip: null };
    const tip = { innerHTML: "" };
    function drawTip(el, keepTop) { calls.draw.push([el === tipFor, keepTop]); tip.innerHTML = String(el.__tip || ""); }
    function speedRebuildNow() {
      if (tipFor && typeof speedTipRebuild === "function") {
        tipFor.__tip = speedTipRebuild(speedChartHover, speedSel);
        drawTip(tipFor, true);
      }
    }
    function scheduleSpeedRebuild() { speedRebuildNow(); }   // v275 切片：无 rAF，同步等价（与源码 fallback 同契约）
    const speedTipRebuild = (curHover, curSel) => {
      const out = speedCardV2HTML({ speedHistory: ${JSON.stringify(fixture())},
        sel: Object.assign({ sid: "sess_main" }, curSel), live: null, segsHover: curHover,
        fmtTok: String, fmtCnt: String, fmtMoney: u => "¥" + u.toFixed(2) });
      return "\\u0001" + out;
    };
    ${tabFn}
    return { calls, get speedSel() { return speedSel; }, set speedSel(v) { speedSel = v; },
      get speedChartHover() { return speedChartHover; }, set speedChartHover(v) { speedChartHover = v; },
      get speedInteractAt() { return speedInteractAt; }, set speedInteractAt(v) { speedInteractAt = v; },
      tipFor, tip, drawTip, speedTipRebuild, speedTabActivate };
  })()`, ctx);
  ctx.__st = st;
  return ctx;
}

function fakeTab(group, val) {
  return { closest: () => null, getAttribute: k => (k === "data-sv-group" ? group : k === "data-sv-val" ? val : null) };
}
function tabNode(group, val) {
  const node = fakeTab(group, val);
  node.closest = sel => sel === ".zu-sv-tab" ? node : null;
  return node;
}
function fire(st, type, target) {
  const e = { target, stopPropagation: () => { st.calls.stop++; }, preventDefault: () => {} };
  st.speedTabActivate(e);
  return e;
}

test('pointerdown tab activation lands before any innerHTML rebuild (v263 root-cause contract)', () => {
  const ctx = makeTabCtx();
  const st = ctx.__st;
  fire(st, "pointerdown", tabNode("range", "project"));
  assert.equal(st.speedSel.range, "project");
  assert.equal(st.speedChartHover, -1);
  assert.ok(st.speedInteractAt > 0, "interaction freeze armed");
  assert.ok(st.tipFor.__tip && st.tipFor.__tip.charCodeAt(0) === 1, "rebuild string installed");
  assert.match(st.tip.innerHTML, /data-sv-val="project" aria-pressed="true"/);
  // 竞态契约：pointerdown 之后不再有 click（重建吞掉），切换也必须已经生效——
  // 修复前等价实现只挂 click，这条序列下 speedSel 永远不会变（回归即红）。
  assert.equal(st.calls.draw.length, 1);
  assert.equal(st.calls.draw[0][0], true, 'drawTip ran on the live cell');
  assert.equal(st.calls.draw[0][1], true, 'keepTop preserved');
});

test('click-only fallback stays idempotent and refuses invalid tabs', () => {
  const ctx = makeTabCtx();
  const st = ctx.__st;
  fire(st, "click", tabNode("period", "week"));
  assert.equal(st.speedSel.period, "week");
  const draws = st.calls.draw.length;
  fire(st, "click", tabNode("period", "week"));   // 同值重按：幂等不炸
  assert.equal(st.speedSel.period, "week");
  assert.ok(st.calls.draw.length >= draws);
  const before = st.speedSel.range;
  fire(st, "click", tabNode("range", "bogus"));   // 非法值拒绝
  assert.equal(st.speedSel.range, before);
  const sel2 = { closest: () => null };           // 非 Tab 目标不误触
  fire(st, "click", sel2);
  assert.equal(st.speedSel.range, before);
});

test('cross-tab range switches keep dim at time (v272, no dimension feature)', () => {
  const ctx = makeTabCtx();
  const st = ctx.__st;
  for (const r of ["project", "all", "recent", "session"]) {
    fire(st, "pointerdown", tabNode("range", r));
    assert.equal(st.speedSel.range, r, 'range switched to ' + r);
    assert.equal(st.speedSel.dim, "time", 'dim stays time on ' + r);
  }
});

test('x-axis labels: HH:mm only, cross-day MM/DD day row removed (2026-11-09 user spec)', () => {
  const ctx = makeCtx();
  ctx.__h = fixture();
  const an = analyze(ctx, { range: 'session', period: 'recent', dim: 'time' });
  assert.ok(an.items.length >= 2, 'fixture spans multiple days');
  assert.ok(an.items.every(x => x.dayLabel === undefined), 'day labels removed from bar bottoms');
  assert.ok(an.items.every(x => /^\d{2}:\d{2}$/.test(x.label)), 'time labels stay HH:mm');
  const html = vm.runInContext(`speedCardV2HTML({ speedHistory: ctx.__h,
    sel: { range: "session", period: "recent", dim: "time", sid: "sess_main" },
    live: null, segsHover: 1, fmtTok: String, fmtCnt: String, fmtMoney: u => "¥" + u.toFixed(2) })`
    .replace('ctx.__h', JSON.stringify(fixture())), ctx);
  assert.doesNotMatch(html, /zu-sv-card/, 'hover card lives in the portal, not the card HTML (v281)');
  assert.match(vm.runInContext('SPD_PORTAL', ctx), /zu-sv-card/, 'portal channel carries the hovered bar card');
  assert.match(html, /aria-label="09:00，/, 'bar aria carries time only, no date');
  assert.doesNotMatch(html, /aria-label="\d{2}\/\d{2} /, 'no date prefix in bar aria');
});

test('left card: history-only wording, no formula line, soft selected tab and ultra star', () => {
  const ctx = makeCtx();
  ctx.__h = fixture();
  const html = vm.runInContext(`speedCardV2HTML({ speedHistory: ${JSON.stringify(fixture())},
    sel: { range: "session", period: "recent", dim: "time", sid: "sess_main" },
    live: { statusText: "工具执行中", speedValue: 88.8, kind: "estimate" },
    segsHover: -1, fmtTok: String, fmtCnt: String, fmtMoney: u => "¥" + u.toFixed(2) })`, ctx);
  assert.match(html, /最近18轮平均速度/, 'per-tab left title (recent period)');
  assert.ok(!html.includes('历史统计'), 'hist tag removed (v298.2)');
  assert.doesNotMatch(html, /Σ有效输出/, 'formula line removed (VIS-002)');
  assert.doesNotMatch(html, /当前筛选/, 'old title wording gone (VIS-009)');
  assert.match(html, /生成中估 88\.8/, 'live estimate stays a note');
  assert.doesNotMatch(html, /zu-sv-tab\.on\{background:var\(--color-brand/, 'no solid brand fill (VIS-001)');
  assert.doesNotMatch(html, /≥2000 Ultra/, 'ultra text label replaced by star (VIS-007)');
});

// v263 第二根因：tip 内控件点击 → 重编 innerHTML → 被点按钮 detach → 焦点跌落 body
// → focusout（relatedTarget=null）曾无条件 hideTip(true,"focus-leave") 强制关 tooltip，
// 切换生效了用户也看不见。鼠标悬停中（mouseInBar）必须降级非 force 交总闸拦截。
const focusOutFn = source.slice(source.indexOf('    main.addEventListener("focusout"'),
  source.indexOf('    /* v117 悬停命中区扩到整栏'));
test('focus-out from a rebuilt tab keeps the tooltip while the pointer stays on the bar (v263)', () => {
  // 切片是 addEventListener 调用，提取其中的 handler 供直接派发
  const ctx = makeCtx();
  const st = vm.runInContext(`(() => {
    const calls = { hide: [] };
    let mouseInBar = true;
    const tipFor = { id: "cell" };
    const tip = { contains: () => false };
    const main = { contains: () => false, addEventListener: (type, fn) => { mainFocusOutHandler = fn; } };
    function hideTip(force, cause) { calls.hide.push([force, cause]); }
    ${focusOutFn}
    mainFocusOutHandler({ relatedTarget: null });   // 焦点跌落 body（按钮被重编 detach）
    mouseInBar = false;
    mainFocusOutHandler({ relatedTarget: null });   // 纯键盘/鼠标已离场：维持强制关
    return { calls };
  })()`, ctx);
  assert.deepEqual(Array.from(st.calls.hide[0]), [false, "focus-leave"], 'pointer on bar: downgraded, total-gate decides');
  assert.deepEqual(Array.from(st.calls.hide[1]), [true, "focus-leave"], 'no pointer: force close kept');
});

// v268 跨代际粘性：serve 空闲回收/重启窗口的帧缺 speed_history，新代际粘性（模块级）
// 为空即闪回旧版整卡。粘性写 window.__zusageSpdSticky、四消费点 lastSpeedHistory 兜底。
test('sticky turn-table survives generation reload via window.__zusageSpdSticky (v268)', () => {
  const src = source;
  // 1) 粘性初始化继承 window 缓存（新实例/新代际直接拿到上一代的轮表）
  assert.match(src, /var lastSpeedHistory = \(typeof window !== "undefined" && window\.__zusageSpdSticky\) \|\| null;/);
  // 2) 帧带轮表时写回 window（热重载不丢）
  assert.match(src, /try \{ window\.__zusageSpdSticky = lastSpeedHistory; \} catch \(_\) \{ \}/);
  // 3) 三个 V2 消费点全部粘性兜底（buildLiveTip v2h / html(d) / tpsTip 数据包）
  assert.ok(src.includes('(typeof lastSpeedHistory !== "undefined" && lastSpeedHistory) || null'), 'buildLiveTip v2h sticky fallback (typeof-guarded)');
  assert.ok(src.includes('spdRebuildOr(d.speed_history ||'), 'html(d) sticky fallback arg');
  assert.ok((src.match(/typeof lastSpeedHistory !== "undefined" && lastSpeedHistory/g) || []).length >= 3, 'three consumer sites typeof-guarded');
  assert.ok(src.includes('speedHistory: (state.data && state.data.speed_history) || (prevT && prevT.speedHistory) ||'), 'tpsTip data package head');
  assert.ok(src.includes('(typeof lastSpeedHistory !== "undefined" && lastSpeedHistory) || null,'), 'tpsTip data package sticky fallback');
  // 4) 行为级：spdRebuildOr 对「缺失帧 + 有粘性」的组合——兜底逻辑在调用点，
  //    这里锁 spdRebuildOr 对真空值仍回 null（fb 分支契约不因兜底而消失）
  const ctx = makeCtx();
  const fn = vm.runInContext('spdRebuildOr(undefined, {range:"recent",period:"recent",dim:"time"}, -1, null, {})', ctx);
  assert.equal(fn, null);
});

// v271 点击任意位置关闭根治：tip 内按压后 1.2s 硬保活窗——hideTip 对非
// win-leave/escape 的 force 一律降级交总闸；focusout 在窗内直接不关。
test('press-keepalive window: any force hide within 1.2s of a tip press is downgraded (v271)', () => {
  const s = source;
  assert.ok(s.includes('var lastTipDownAt = 0;'), 'press timestamp state');
  assert.ok(s.includes('lastTipDownAt = Date.now();'), 'pointerdown stamps the window');
  assert.match(s, /if \(force && cause !== "win-leave" && cause !== "escape" &&\n          typeof lastTipDownAt !== "undefined" && lastTipDownAt &&\n          Date\.now\(\) - lastTipDownAt < 1200\) force = false;/);
  assert.match(s, /if \(typeof lastTipDownAt !== "undefined" && lastTipDownAt &&\n          Date\.now\(\) - lastTipDownAt < 1200\) return;/, 'focusout short-circuit in window');
});

// ---------- v274 完整规格补齐：布局引擎/数值稀疏/横滚/单点与空态说明 ----------
test('spdChartLayout centralizes density-driven params (§5.1)', () => {
  const ctx = makeCtx();
  const L = n => vm.runInContext('spdChartLayout(' + n + ')', ctx);
  assert.deepEqual([L(1).spacerW, L(8).spacerW, L(24).spacerW], [240, 240, 588]);   // v295.17：pitch 24px（≤9 柱走 240 下限）
  assert.equal(L(1).xEvery, undefined); assert.equal(L(16).xEvery, undefined, 'xEvery removed: every bar labeled (v290)');
  assert.equal(L(8).valEvery, 1); assert.equal(L(16).valEvery, 2);
  assert.equal(L(1).single, true); assert.equal(L(6).single, false);
});

test('bar value labels thin out for n>8, first/last/hovered always shown (§4.7)', () => {
  const ctx = makeCtx(); ctx.__h = fixture();
  // 构造 12 个有效小时桶（当天 00:00–11:00，超出 n<=8 全显阈值；12>3 不触发聚焦）
  const h = fixture();
  const dayStart = new Date(2026, 10, 5, 0, 0, 0).getTime();
  const turns = [];
  for (let i = 0; i < 12; i++) turns.push({ s: 0, t: i ? HOUR : dayStart, b: dayStart + i * HOUR - 60000,
    out: 300, ms: 1000, i: 500, o: 300, n: 1, msl: [[0, 300]] });
  h.turns = turns;
  ctx.__h = h;
  const an = analyze(ctx, { range: 'all', period: 'today', dim: 'time' });
  // 完整模式：00:00..14:00 全桶保留（15 桶 >16 上限不截、12 有效 + 3 空桶），不丢桶
  assert.equal(an.items.length, 15, 'full-timeline keeps all elapsed hour buckets');
  assert.ok(an.items.filter(x => !x.empty).length === 12, '12 real buckets intact');
  ctx.__o = { fmtTok: String, fmtCnt: String, fmtMoney: u => '¥' + u.toFixed(2) };
  ctx.__an = an;
  const html = vm.runInContext('spdChartHTML(__an, -1, __o)', ctx);
  const vals = (html.match(/zu-sc-val">[\d.]+</g) || []).length;
  assert.ok(vals >= 4 && vals <= 7, 'value labels thinned to ~n/2, got ' + vals);
  assert.match(html, /zu-sc-col[^"]*latest/, 'latest bar carries the soft outline class');
  // 悬停柱恒显数值：hover 第 1 柱（非稀疏采样位）
  const h2 = vm.runInContext('spdChartHTML(__an, 1, __o)', ctx);
  assert.ok((h2.match(/zu-sc-val">[\d.]+</g) || []).length >= vals, 'hovered bar value forced on');
});

test('cov/focus header texts removed entirely (2026-11-07 用户规格)', () => {
  const ctx = makeCtx(); ctx.__h = fixture();
  const an = analyze(ctx, { range: 'session', period: 'week', dim: 'time' });
  assert.equal(an.cov, undefined, 'cov field removed from analyze result');
  assert.equal(an.focus, undefined, 'focus metadata removed from analyze result');
  const ct = analyze(ctx, { range: 'all', period: 'today', dim: 'time' });
  assert.equal(ct.cov, undefined, 'today cov removed');
  ctx.__o = { fmtTok: String, fmtCnt: String, fmtMoney: null };
  ctx.__an = an;
  const html = vm.runInContext('spdChartHTML(__an, -1, __o)', ctx);
  assert.doesNotMatch(html, /zu-sc-cov|zu-sv-focus|暂无足够数据|显示完整时间轴|仅显示有记录时段/,
    'chart head renders neither cov nor focus toggle');
});

test('empty state carries the longer-range hint (§4.2)', () => {
  const ctx = makeCtx();
  ctx.__h = { sid: 'x', source: 'local', sids: ['x'], snames: ['x'], pids: [['p', 'p']],
    mnames: ['m'], turns: [] };
  const html = vm.runInContext(`speedCardV2HTML({ speedHistory: ${JSON.stringify(ctx.__h)},
    sel: { range: 'session', period: 'week', dim: 'time', sid: 'x' },
    live: null, segsHover: -1, fmtTok: String, fmtCnt: String, fmtMoney: null })`, ctx);
  assert.match(html, /尝试选择更长时间范围/, 'empty state suggests a longer range');
  assert.match(html, /zu-sv-empty-hint/);
});

// v275：快速来回切 Tab 的 rAF 合并——同步重编风暴（用户实报「卡死」）与
// pointermove 保活（mousemove 节流盲区让 mouseInBar 停留 false）。
test('rapid tab ping-pong stays synchronous (v276: rAF coalescing reverted for occluded windows)', () => {
  const ctx = makeCtx();
  const rst = vm.runInContext(`(() => {
    const calls = { draw: 0 };
    let speedSel = { range: "recent", period: "recent", dim: "time", focus: "" };
    let speedChartHover = -1, speedInteractAt = 0;
    const tipFor = { __tip: null };
    function speedRebuildNow() { drawTip(tipFor, true); }   // v276：同步重编（源码同款）
    function drawTip(el) { calls.draw++; el && (el.__tip = speedTipRebuild(speedChartHover, speedSel)); }
    const speedTipRebuild = (ch, cs) => "\u0001" + speedCardV2HTML({ speedHistory: ${JSON.stringify(fixture())},
      sel: Object.assign({ sid: "sess_main" }, cs), live: null, segsHover: ch,
      fmtTok: String, fmtCnt: String, fmtMoney: u => "¥" + u.toFixed(2) });
    ${tabFn}
    const activate = (grp, val) => {
      const node = { closest: sel => sel === ".zu-sv-tab" ? { getAttribute: k => k === "data-sv-group" ? grp : val } : null };
      speedTabActivate({ target: node, stopPropagation: () => {} });
    };
    activate("range", "project"); activate("range", "all");
    activate("range", "session"); activate("period", "week");
    activate("period", "month"); activate("range", "recent");
    return { draws: calls.draw, sel: speedSel };
  })()`, ctx);
  // 被遮挡窗口 rAF 冻结会让异步重编永不执行（用户实报卡死），同步落地是唯一可靠路径
  assert.equal(rst.draws, 6, 'every switch lands synchronously');
  assert.equal(rst.sel.range, 'recent', 'last state wins');
  assert.equal(rst.sel.period, 'month', 'period switch not lost');
});

// v277 win-leave 降级可取消宽限：hideSeq 铁证「点击 tab 自动关闭」= win-leave
// （合成 mouseleave/瞬态 blur 与真离开在触发点不可分）。立即 force 关打死正常交互，
// 改 400ms 可取消宽限（真离开半秒后收，指针落回即取消）。
test('win-leave downgrades to a cancellable 400ms grace instead of force-hide (v277)', () => {
  const ctx = makeCtx();
  const rst = vm.runInContext(`(() => {
    const calls = { hide: [], timers: [] };
    let mouseInBar = true;
    const tipFor = { id: "cell" };
    let tipGraceTimer = 0;
    function cancelTipGrace() { if (tipGraceTimer) { tipGraceTimer = 0; } }
    function hideTip(force, cause) { calls.hide.push([force, cause]); }
    function tipBoundaryHide(src) {
      if (!tipFor) return;
      mouseInBar = false;
      const cause = "win-leave:" + (src || "?");
      cancelTipGrace();
      tipGraceTimer = setTimeout(function () { tipGraceTimer = 0; hideTip(true, cause); }, 400);
    }
    const fns = [];
    const setTimeout = function (fn, ms) { calls.timers.push(ms); fns.push(fn); return fns.length; };
    const clearTimeout = function () {};
    tipBoundaryHide("blur");
    const armed = { timers: calls.timers.slice(), hides: calls.hide.length };   // 排宽限、未立即关
    cancelTipGrace();                                                          // 指针落回 tip/条面：取消
    tipBoundaryHide("edge");                                                   // 真离开：再排并到期
    fns[fns.length - 1]();                                                     // 模拟 400ms 到期
    return { armed, tofire: calls.timers.slice(), fired: calls.hide.slice() };
  })()`, ctx);
  // 瞬态 blur 不立即 force 关：进 400ms 宽限定时器（真离开半秒后收）
  assert.equal(rst.armed.hides, 0, 'no immediate force-hide');
  assert.equal(rst.armed.timers.join(','), '400', 'grace timer armed at 400ms');
  // 指针落回取消后，真离开（edge）重新排宽限并到期收起——cause 带来源取证
  assert.equal(rst.tofire.join(','), '400,400');
  assert.equal(rst.fired.length, 1, 'grace expiry fires once');
  assert.equal(rst.fired[0][0], true);
  assert.match(rst.fired[0][1], /win-leave:edge/);
});

test('chart head carries the stats time at the far end with full-format hover title (v278 §5)', () => {
  const ctx = makeCtx(); ctx.__h = fixture();
  const an = analyze(ctx, { range: 'session', period: 'recent', dim: 'time' });
  ctx.__an = an;
  ctx.__o = { fmtTok: String, fmtCnt: String, fmtMoney: u => '¥' + u.toFixed(2) };
  const html = vm.runInContext('spdChartHTML(__an, -1, __o)', ctx);
  assert.match(html, /zu-sc-head[^]*zu-sv-range/, 'range rendered inside the chart title bar');
  assert.match(html, /zu-sv-range" title="\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} – /,
    'hover title carries the full YYYY-MM-DD HH:mm:ss range');
  assert.ok(html.indexOf('zu-sc-unit') >= 0 && html.indexOf('zu-sc-unit') < html.indexOf('zu-sv-range'),
    'unit sits next to the chart title; stats time is the far-right element');
});

test('v278 CSS: header wraps as a unit, filter right-aligned, stats time pill-free', () => {
  const css = source.slice(source.indexOf('.zu-sv-head{display:flex'),
    source.indexOf('/* v232 速度柱状图：左读数卡'));
  assert.match(css, /\.zu-sv-head\{[^}]*flex-wrap:wrap/, 'narrow-width header degrades by wrapping (§4.2)');
  assert.match(css, /\.zu-sv-filter\{[^}]*margin-left:auto/, 'dual tab groups right-aligned as one block');
  assert.match(css, /\.zu-sv-filter\{[^}]*justify-content:flex-end/, 'wrapped tab row stays right-aligned');
  assert.doesNotMatch(css, /\.zu-sv-range\{[^}]*border-radius:999px/, 'capsule pill styling removed (v278)');
  assert.match(css, /\.zu-sv-range\{[^}]*margin-left:auto/, 'range pushed to the chart-head far end');
  assert.ok(!css.includes('.zu-sv-root .zu-sl-hist'), 'hist tag CSS removed (v298.2)');
});

test('stats-time compact format follows §5.4: no year within same month, years across months (v278)', () => {
  const ctx = makeCtx();
  const r = vm.runInContext(`(() => {
    const T = (y, mo, d, h, m) => new Date(y, mo, d, h, m).getTime();
    return {
      sameDay: spdRangeText(T(2026, 10, 6, 15, 26), T(2026, 10, 6, 18, 7)),
      sameMonth: spdRangeText(T(2026, 10, 5, 16, 33), T(2026, 10, 6, 17, 29)),
      crossMonth: spdRangeText(T(2026, 9, 31, 16, 33), T(2026, 10, 6, 17, 29)),
      crossYear: spdRangeText(T(2025, 11, 31, 23, 0), T(2026, 0, 2, 1, 0))
    };
  })()`, ctx);
  assert.equal(r.sameDay, '11/06 15:26 – 18:07', 'same day: no year');
  assert.equal(r.sameMonth, '11/05 16:33 – 11/06 17:29', 'same-month cross-day: no year on either end');
  assert.equal(r.crossMonth, '2026/10/31 16:33 – 2026/11/06 17:29', 'cross-month: year on both ends');
  assert.equal(r.crossYear, '2025/12/31 23:00 – 2026/01/02 01:00', 'cross-year: year on both ends');
});

test('V2 card root carries the selection key; both rebuild paths preserve h-scroll per key (v281)', () => {
  const ctx = makeCtx();
  ctx.__h = fixture();
  const o = { speedHistory: ctx.__h, sel: { range: 'project', period: 'week', dim: 'time', sid: 'sess_main' },
    live: null, segsHover: -1, fmtTok: String, fmtCnt: String, fmtMoney: u => '¥' + u.toFixed(2) };
  ctx.__o = o;
  const html = vm.runInContext('speedCardV2HTML(__o)', ctx);
  assert.match(html, /zu-sv-root" data-sv-key="project\|week"/, 'root carries range|period key');
  // tpsTip 重编分支：捕获旧 DOM 横滚 + 同键回填（结构锁，行为由 drawTip v232 同款机制佐证）
  const showFn = source.slice(source.indexOf('  function showTpsTip(el) {'),
    source.indexOf('  function hideTpsTip() {'));
  assert.match(showFn, /zu-sc-wrap[\s\S]*zu-sv-root[\s\S]*data-sv-key[\s\S]*scrollLeft/,
    'showTpsTip captures scrollLeft with the selection key before rebuild');
  assert.match(showFn, /scrollLeft = st0\.x/, 'restore only when key matches');
  // 全量 tip：横滚保留扩展到重开路径（keepTop 不再是捕获前提）+ 同键守卫
  const drawFn = source.slice(source.indexOf('    function drawTip(el, keepTop) {'),
    source.indexOf('    function showTipFor(el) {'));
  assert.match(drawFn, /oldChartKey/, 'drawTip carries the old selection key');
  // v291 起捕获行带三态注释（0 也是有效记忆），形状锁放宽为语义锁：
  // 捕获必须发生在 innerHTML 重建之前（v281 重开路径不按 keepTop 门控）
  assert.match(drawFn, /oldChartL = oc\.scrollLeft;/,
    'capture not gated on keepTop (v281 reopen path)');
  assert.ok(drawFn.indexOf('oldChartL = oc.scrollLeft;') >= 0 &&
    drawFn.indexOf('oldChartL = oc.scrollLeft;') < drawFn.indexOf('tip.innerHTML'),
    'scroll capture happens before rebuild');
});

test('v281 P1: fixed tooltip width + stable chart column (width stops tracking content)', () => {
  const ctx = makeCtx(); ctx.__h = fixture();
  ctx.__o = { speedHistory: ctx.__h, sel: { range: 'recent', period: 'recent', dim: 'time', sid: 'sess_main' },
    live: null, segsHover: -1, fmtTok: String, fmtCnt: String, fmtMoney: u => '¥' + u.toFixed(2) };
  const html = vm.runInContext('speedCardV2HTML(__o)', ctx);
  // tip 定宽：width 与 max-width 同值 !important（不再只钳 max-width 让内容反向撑缩）
  assert.match(html,
    /width:min\(760px,calc\(100vw - 24px\)\)!important;max-width:min\(760px,calc\(100vw - 24px\)\)!important;height:300px!important;box-sizing:border-box/,
    'tooltip pinned at 800x390 (v284 width + v292/v294.2 height), not content-driven');
  // v285：V2 卡左缘对齐锚元素（.it 速度格）左缘——positionTip 消费 __zuAlignLeft
  assert.match(source, /tip\.__zuAlignLeft = !!\(tip\.querySelector\("\.zu-sv-root"\) \|\| tip\.querySelector\("\.zu-stat-tip--turn"\)\);/,
    'full tip marks V2 content for left alignment');
  // v304.1：宽窗仍贴锚左缘；窗口富余 <100px 改居中（左右 padding 一致，用户实报窄窗右缘被顶）
  assert.match(source, /if \(tip\.__zuAlignLeft\) \{\n        \/\* v304\.1[\s\S]*?var slackW = innerWidth - tr\.width;\n        left = slackW < 100 \? Math\.max\(4, slackW \/ 2\)\n          : Math\.max\(8, Math\.min\(ar\.left, Math\.max\(8, innerWidth - tr\.width - 8\)\)\);\n      \}/,
    'positionTip left-aligns on wide viewports, centers when the window can barely fit the card');
  const codeNoLedger = source.split('\n').filter(l => !l.includes('var VERSION =')).join('\n');
  assert.doesNotMatch(codeNoLedger, /conversation-bottom-dock-transition/,
    'v284 host-class dependency removed (did not apply on real host; ledger text exempt)');
  assert.doesNotMatch(codeNoLedger, /__zuDockLeft/, 'dock machinery fully removed');
  // 右图表列：flex:1 1 0 + min-width:0（列宽只由 tip 定宽决定）
  assert.match(source, /\.zu-sv-root \.zu-speed-chart\{flex:1 1 0;min-width:0;max-width:100%\}/);
  // 滚动容器：定宽 + 保留横向滚动（不允许用关 overflow 修裁剪）
  assert.match(source, /\.zu-sv-chart \.zu-sc-wrap\{overflow-x:auto;overflow-y:hidden;width:100%;min-width:0;max-width:100%\}/);
});

test('v281 P0: hover card portal — body-level singleton, viewport-aware placement, lifecycle hooks', () => {
  // Portal 单例：pointer-events none、与 tooltip 同层 z-index、类名进 boot 清理链
  assert.match(source, /var spdHoverPortal = document\.createElement\("div"\);\n  spdHoverPortal\.className = "zusage-quota-tip zu-sv-portal";/);
  assert.match(source, /spdHoverPortal\.style\.cssText = "position:fixed;display:none;z-index:2147483646;pointer-events:none;";/);
  // 定位：渲染后量真实尺寸（不假设固定宽高），右上→翻左→钳边，柱滚出 wrap 视口即收
  const place = source.slice(source.indexOf('  function spdHoverPortalPlace(tipEl, idx) {'),
    source.indexOf('  function spdHoverPortalSync(tipEl, idx) {'));
  assert.match(place, /getBoundingClientRect/, 'placement measures real rects');
  assert.match(place, /cr\.right \+ 6/, 'default: right of the bar');
  assert.match(place, /cr\.left - pr\.width - 6/, 'flip left when right side runs out');
  assert.match(place, /zu-sc-wrap/, 'hide when the bar scrolls out of the chart viewport');
  // 生命周期：收起路径全联动，不留孤儿 Portal
  assert.match(source, /spdHoverPortalSync\(tip, speedChartHover\);/, 'tab switch invalidates the old card via empty channel');
  assert.match(source, /function hideTpsTip\(\) \{[^}]*spdHoverPortalHide\(\)/, 'compact tip close hides portal');
  // dispose/热更：Portal 进 cleanupRateTip 同链清理（boot 自清旧代 + __zusageDispose 摘除）
  assert.match(source, /hideFxTip\(\);\n    fxTip\.remove\(\);[^]*?spdHoverPortalHide\(\);\n    spdHoverPortal\.remove\(\);/,
    'portal removed by the dispose chain');
  // 侧信道纪律：消费即清，跨帧不串
  const sync = source.slice(source.indexOf('  function spdHoverPortalSync(tipEl, idx) {'),
    source.indexOf('  /* v176：子代理行内速率 chip'));
  assert.match(sync, /SPD_PORTAL = "";/, 'channel consumed-and-cleared');
  // B1（review）：显示时幂等 appendChild 移到 body 末尾——实例 tip 晚于 Portal 挂载，
  // 同 z 层按树序后者在上，不移尾会被全量 tip 整片盖住（fxTip 1296 行同款实测先例）
  // M-2（review 二轮）：移尾必须在缓存分支之外——同内容 re-show 遇分屏晚挂 tip 也要移尾
  assert.ok(sync.indexOf('__zuHtml !== html') < sync.indexOf('lastElementChild !== spdHoverPortal') &&
    sync.indexOf('lastElementChild !== spdHoverPortal') < sync.indexOf('style.display = "block"'),
    'move-to-end runs on every show, outside the content-change branch');
  assert.match(sync, /document\.body\.appendChild\(spdHoverPortal\);/, 'portal moved to body end on show (layering)');
  assert.match(sync, /spdHoverPortal\.__zuHtml !== html/, 'same-content resync only repositions (no 10Hz innerHTML)');
  // m2（review）：frozen=悬停中心跳冻结，新信道与冻结图错位必须丢弃
  assert.match(source, /if \(frozen\) SPD_PORTAL = "";/, 'frozen path discards the fresh channel');
  // m1（review）：滚出即收后滚回恢复（交叠判定先行，可视区外不做显隐 churn）
  assert.ok(place.indexOf('.zu-sc-wrap') < place.indexOf('style.display !== "block"'),
    'overlap gate runs before the restore branch');
  assert.match(place, /spdHoverPortal\.__zuHtml/, 'restore reuses the cached card');
  // M1（review）：hideTip 的 Portal 收起必须在按压保活 blocked-return 之后
  const hideTip = source.slice(source.indexOf('    function hideTip(force, cause) {'),
    source.indexOf('    function hideTip(force, cause) {') + 1400);   // v297.3 起头部含 dev-keep 总闸，取窗放大
  const blocked = hideTip.indexOf('blocked:');
  const portalHide = hideTip.indexOf('spdHoverPortalHide()');
  assert.ok(blocked >= 0 && portalHide > blocked, 'portal hide comes after the press-keepalive early return');
  // 无障碍：body 级游离节点挂 role
  assert.match(source, /spdHoverPortal\.setAttribute\("role", "tooltip"\)/);
  // 两条重建链路都接了 sync
  assert.match(source, /spdHoverPortalSync\(tpsTip, el\.__zuT \? el\.__zuT\.speedHover : -1\)/);
  assert.match(source, /spdHoverPortalSync\(tip, idx\); +\/\* v281/);
  // 横向滚动 capture 相重定位（两条链路）
  assert.match(source, /tpsTip\.addEventListener\("scroll", function \(\) \{\n    if \(tpsTipFor && tpsTipFor\.__zuT\) spdHoverPortalPlace\(tpsTip, tpsTipFor\.__zuT\.speedHover\);\n  \}, true\)/);
  assert.match(source, /tip\.addEventListener\("scroll", function \(\) \{\n      if \(tipFor\) spdHoverPortalPlace\(tip, speedChartHover\);\n    \}, true\)/);
});

test('v282: tabs drop the saturated blue selection for a hover-aligned low-contrast style', () => {
  assert.doesNotMatch(source, /\.zu-sv-tab\.on\{background:rgba\(87,200,255/, 'blue selection removed');
  assert.match(source, /\.zu-sv-tab\.on\{background:rgba\(255,255,255,\.07\);color:var\(--color-foreground,#e9edf4\);box-shadow:inset 0 0 0 1px rgba\(255,255,255,\.08\)\}/);
  assert.match(source, /\.zu-light \.zu-sv-tab\.on\{background:rgba\(0,0,0,\.06\)/, 'light theme variant');
  assert.match(source, /\.zu-sv-tab\.on:hover\{background:rgba\(255,255,255,\.09\)\}/, 'selected+hover only a slight lift');
  // 两组 Tab 同一套规则（无第二个 on 规则分支）
  assert.equal((source.match(/"\.zu-sv-tab\.on\{background:/g) || []).length, 1, 'single selection rule for both groups');
  // 字重恒 600 未回退（v263 防选中加宽跳动）
  assert.match(source, /\.zu-sv-tab\{appearance:none;border:0;background:transparent;[^}]*font-weight:600/);
});

test('v282: legend popup — hover/focus opens, mutual exclusion, escape, full lifecycle', () => {
  // 模块单例 + 复用 boot 清理类 + role
  assert.match(source, /var spdLegendTip = document\.createElement\("div"\);\n  spdLegendTip\.className = "tip zusage-quota-tip zu-sv-legend-tip";/);
  assert.match(source, /spdLegendTip\.setAttribute\("role", "tooltip"\)/);
  assert.match(source, /spdLegendTip\.style\.cssText = "position:fixed;display:none;z-index:2147483646;";/);
  // 显示即移尾（B1 同款，不挂内容变化条件）
  const show = source.slice(source.indexOf('  function spdLegendTipShow(btn) {'),
    source.indexOf('  spdLegendTip.addEventListener("mouseenter"'));
  assert.match(show, /lastElementChild !== spdLegendTip/, 'move-to-end on every show');
  assert.match(show, /spdHoverPortalHide\(\);/, 'bar-hover portal closes when legend opens');
  // 两条宿主链路都接了 hover/focus 打开
  assert.equal((source.match(/spdLegendTipShow\(lb\)/g) || []).length, 4, 'tpsTip + full tip, hover + focus');
  assert.equal((source.match(/spdLegendTipScheduleHide\(\);/g) || []).length, 4, 'scheduled hides wired (mouseout/focusout both hosts)');
  // 互斥反向：Portal 显示时收档位说明
  assert.match(source, /spdLegendTipHide\(\); {2,3}\/\/ v28\d 互斥/, 'portal show closes legend popup');
  // Escape 行为语义（MAJOR-1 review）：全量 tip 链并入 v254 既存 keydown——legend 分支
  // 必须先于 fxTip 分支与 hideTip(true,"escape")，且独立 dead 监听已删。
  // 注意：两侧断言均锚「代码形状」而非注释文案。
  const escStart = source.indexOf('    /* 项目卡内部 Escape：先收档位说明浮层');
  const escEnd = source.indexOf('restoringFocus = true;');
  const fullEsc = source.slice(escStart, escEnd);
  assert.ok(fullEsc.includes('spdLegendTip.style.display === "block"') &&
    fullEsc.indexOf('spdLegendTipHide()') < fullEsc.indexOf('hideFxTip()') &&
    fullEsc.indexOf('hideFxTip()') < fullEsc.indexOf('hideTip(true, "escape")'),
    'escape precedence: legend, fxTip, then close tip');
  assert.ok(!/tip\.addEventListener\("keydown", function \(e\) \{\n      if \(e\.key === "Escape" && spdLegendTip/.test(source),
    'no dead standalone escape listener on the full tip');
  assert.ok(/tpsTip\.addEventListener\("keydown"[\s\S]{0,300}spdLegendTip\.style\.display === "block"/.test(source),
    'compact chain keeps its own escape listener');
  // 生命周期：主 tooltip 收起与 dispose 链
  assert.match(source, /function hideTpsTip\(\) \{[^}]*spdLegendTipHide\(\)/, 'compact tip close hides legend popup');
  assert.match(source, /spdHoverPortalHide\(\); {2,3}\/\* v281：Portal 随 tooltip 收起[^]*?spdLegendTipHide\(\); +\/\* v282/, 'full tip close hides legend popup');
  assert.match(source, /spdLegendTip\.remove\(\); {2,5}\/\/ v281：档位说明浮层同链清理/, 'dispose chain removes legend popup');
  // 内容构建器：升序 + 当前档来自 data-sv-band
  const build = source.slice(source.indexOf('  function spdLegendCardHTML(curCls) {'),
    source.indexOf('  /* 纯函数桥：三处 speedTipRebuild 调用共用。'));
  assert.match(build, /for \(var i = TPS_BANDS\.length - 1; i >= 0; i--\)/,
    'descending storage looped backwards = ascending display (single source)');
  assert.match(build, /b\.cls === curCls/, 'highlight by band cls');
});

test('v287: legend popup content-adaptive width, shown to the right of the bands button', () => {
  assert.match(source, /\.zu-sv-legend-tip\{max-width:calc\(100vw - 24px\)/,
    'content-adaptive width, narrow-viewport clamp only (supersedes fixed 430 / v283 cap 800)');
  const show = source.slice(source.indexOf('  function spdLegendTipShow(btn) {'),
    source.indexOf('  spdLegendTip.addEventListener("mouseenter"'));
  assert.match(show, /var left = br\.right \+ 8;/, 'first choice: right of the button, top-aligned');
  assert.match(show, /left = br\.left - lr\.width - 8;/, 'flip to button-left when right side runs out of viewport');
  assert.match(show, /Math\.min\(Math\.max\(m, left\), Math\.max\(m, vw - m - lr\.width\)\)/, 'viewport clamp still applies');
});

test('v290: chart wheel scrolls the horizontal scrollbar (both tip chains)', () => {
  // 两条链各一个 wheel 委托：全量实例链（06 spawnInstance）+ 精简链（01 tpsTip）
  const delegations = source.match(/addEventListener\("wheel", function \(e\) \{[^}]*\}, \{ passive: false \}\)/g) || [];
  assert.equal(delegations.length, 2, 'exactly one wheel delegation per tip chain');
  for (const d of delegations) {
    assert.match(d, /closest\("\.zu-sc-wrap"\)/, 'delegate targets the chart scroll container');
    assert.match(d, /scrollWidth <= wrap\.clientWidth \+ 1/, 'no-op unless the wrap actually overflows');
    assert.match(d, /scrollLeft \+= d/, 'wheel delta converts to horizontal scroll');
    assert.match(d, /preventDefault\(\)/, 'page vertical scroll suppressed only while horizontal scrolling');
  }
  assert.match(source, /\.zu-sv-chart \.zu-sc-wrap::-webkit-scrollbar\{display:none\}/,
    'V2 hides the horizontal scrollbar (V1 shared rule untouched, wheel still scrolls)');
});

test('v286: chart title bar — weight 600 title, t/s badge, speed-bands SVG entry', () => {
  assert.match(source, /\.zu-sv-chart \.zu-sc-title\{font-weight:600;font-size:calc\(var\(--ui-font-size,14px\) \+ 2px\);line-height:1\.3\}/,
    'title weight 600 at ~16px (V2 scope only, V1 untouched)');
  assert.match(source, /\.zu-sv-chart \.zu-sc-unit\{margin-left:9px;background:rgba\(255,255,255,\.05\)/, 'unit badge styling');
  assert.match(source, /\.zu-light \.zu-sv-chart \.zu-sc-unit\{background:rgba\(0,0,0,\.05\)\}/, 'light variant');
  // B1（review）：26px/4px 并入基础规则单点声明（重复规则会被同特异性后声明覆盖成假绿）
  assert.match(source, /"\.zu-sv-legend-btn\{appearance:none;[^}]*width:26px;height:26px;padding:0;margin-left:4px;[^}]*align-self:center/,
    '26px hit area declared once in the base rule (no cascade shadowing)');
  assert.equal((source.match(/\.zu-sv-legend-btn\{appearance:none;/g) || []).length, 1,
    'single declaration site for the legend button');
  assert.match(source, /\.zu-sv-legend-btn svg\{width:18px;height:18px\}/, '18px icon centered in 26px hit area');
  // V1 旧图共享类不受影响：.zu-sc-title 基础规则仍为 700/+1
  assert.match(source, /"\.zu-sc-title\{font-weight:700;font-size:calc\(var\(--ui-font-size,14px\) \+ 1px\)/);
});
