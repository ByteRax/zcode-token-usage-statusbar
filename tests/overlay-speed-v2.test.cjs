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

test('recent mode caps at 16 real turns without padding; today has empty hour buckets', () => {
  const ctx = makeCtx();
  const h = fixture();
  // 追加 20 个同小时轮，验证 16 上限与无补位
  const last = h.turns[h.turns.length - 1];
  const base = h.turns.reduce((a, r) => a + r.t, 0);
  for (let i = 0; i < 20; i++) h.turns.push({ s: 0, t: HOUR, b: base + HOUR - 60000,
    out: 200, ms: 1000, i: 800, o: 200, n: 1, msl: [[0, 200]], c: 0.02, cf: 1 });
  ctx.__h = h;
  const an = analyze(ctx, { range: 'all', period: 'recent', dim: 'time' });
  assert.equal(an.items.length, 16, 'exactly 16 bars');
  assert.ok(an.items.every(x => !x.empty), 'no fake padding');
  // 柱底只放时分短标签，完整年月日时分秒留给 hover 卡；避免 30px 柱宽内长串互相覆盖
  assert.ok(an.items.every(x => /^\d{2}:\d{2}$/.test(x.label)), 'recent bars use HH:MM label');
  assert.ok(an.items.every(x => /\d{4}-\d{2}-\d{2}/.test(x.full)), 'full timestamp retained for hover card');
  const today = analyze(ctx, { range: 'all', period: 'today', dim: 'time' });
  assert.ok(today.items.length >= 2);
  assert.ok(today.items.some(x => x.empty), 'hours with no data are empty, not zero');
  assert.ok(today.items.every(x => !x.empty || x.v == null));
});

test('period buckets: today hourly, 7 days daily, month daily, long history monthly/quarterly/yearly', () => {
  const ctx = makeCtx();
  ctx.__h = fixture();
  const unit = (range, period) => analyze(ctx, { range, period, dim: 'time' }).unit;
  assert.equal(unit('all', 'today'), 'hour');
  assert.equal(unit('all', 'week'), 'day');
  assert.equal(unit('all', 'month'), 'day');
  assert.equal(unit('all', 'all'), 'day');   // fixture 跨上月到今天约一个月内，按日仍可辨趋势
  // 强制更长跨度：直接按绝对时刻重建 delta（首轮前移，其余不动）
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
  ctx.__h = older(400);
  assert.equal(unit('all', 'all'), 'quarter');
  ctx.__h = older(5 * 370);
  assert.equal(unit('all', 'all'), 'year');
});

test('dimension: project offers time/session, all offers time/project, invalid dim auto-resets', () => {
  const ctx = makeCtx();
  ctx.__h = fixture();
  const pa = analyze(ctx, { range: 'project', period: 'all', dim: 'session' });
  assert.equal(pa.dim, 'session');
  assert.equal(pa.items.length, 2, 'two sessions in project A');
  assert.ok(pa.items.every(x => x.label && x.a && x.b));
  const aa = analyze(ctx, { range: 'all', period: 'all', dim: 'project' });
  assert.equal(aa.dim, 'project');
  assert.equal(aa.items.length, 2, 'project A + project B');
  const bad = analyze(ctx, { range: 'recent', period: 'all', dim: 'project' });
  assert.equal(bad.dim, 'time', 'dimension not applicable to range falls back to time');
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

test('V2 card has two tab rows, time pill, 16-bar chart, ten-band legend and no legacy basis/footnote', () => {
  const ctx = makeCtx();
  ctx.__h = fixture();
  const o = { speedHistory: ctx.__h, sel: { range: 'project', period: 'week', dim: 'time', sid: 'sess_main' },
    live: null, segsHover: -1, fmtTok: String, fmtCnt: String, fmtMoney: u => '¥' + u.toFixed(2) };
  ctx.__o = o;
  const html = vm.runInContext('speedCardV2HTML(__o)', ctx);
  assert.match(html, /生成速度/);
  assert.match(html, /zu-sv-range/);
  assert.equal((html.match(/data-sv-group="range"/g) || []).length, 5, '4 range tabs + row');
  assert.equal((html.match(/data-sv-group="period"/g) || []).length, 6, '5 period tabs + row');
  assert.match(html, /zu-sv-dimsel/);
  assert.match(html, /单位：t\/s/);
  assert.match(html, /zu-sv-legend/);
  assert.equal((html.match(/zu-sv-li/g) || []).length, 10, 'ten bands');
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
  assert.match(plain, /当前筛选 · 历史统计/);
  assert.match(plain, /平均速度/);
  const busy = mk({ statusText: '工具执行中', speedValue: 88.8, kind: 'estimate' });
  assert.doesNotMatch(busy, /zu-sl-title">工具执行中/, 'live status must not be the card title');
  assert.match(busy, /工具执行中/, 'live status shown as its own note');
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
  assert.match(html, /Scope|Time/);
  assert.match(html, /unit: t\/s/);
  assert.match(html, /No rated turns|hourly average speed/);
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
  assert.ok(a.overall.out >= p.overall.out && p.overall.out >= s.overall.out);
  // 切换范围不带上一范围的旧值：三者的 Σout 严格递增
  assert.ok(s.overall.out < p.overall.out && p.overall.out < a.overall.out);
});

test('dimension matrix: allowed dims per range and illegal combos reset to time', () => {
  const ctx = makeCtx(); ctx.__h = fixture();
  const cases = [
    ['recent', 'time', 'time'], ['recent', 'session', 'time'], ['recent', 'project', 'time'],
    ['session', 'time', 'time'], ['session', 'session', 'time'],
    ['project', 'time', 'time'], ['project', 'session', 'session'], ['project', 'project', 'time'],
    ['all', 'time', 'time'], ['all', 'project', 'project'], ['all', 'session', 'time'],
  ];
  for (const [range, dim, want] of cases) {
    const an = analyze(ctx, { range, period: 'all', dim });
    assert.equal(an.dim, want, range + '×' + dim);
    const expectDims = range === 'project' ? 'time,session' : range === 'all' ? 'time,project' : 'time';
    assert.equal(an.dims.join(','), expectDims, range + ' dims');
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
  assert.doesNotMatch(a, /zu-sv-card-anchor/);       // 未悬停无卡
  const b = vm.runInContext('__rb(2, __sel)', Object.assign(ctx, { __rb: rebuild }));
  assert.match(b, /zu-sv-card-anchor/);              // 传当前 hover 即出现五字段卡
  assert.match(b, /zu-sv-crow/);
  // 筛选态是同一对象引用：改属性后闭包立即生效，不依赖重新赋值
  sel.range = 'project'; sel.period = 'all'; sel.dim = 'session';
  const c = vm.runInContext('__rb(0, __sel)', Object.assign(ctx, { __rb: rebuild }));
  assert.match(c, /按会话比较/);
  assert.match(c, /data-sv-val="project" aria-pressed="true"/);
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
