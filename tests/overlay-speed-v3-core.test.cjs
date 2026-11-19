'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { readOverlayPart, sliceOverlay } = require('./helpers/overlay-extract.cjs');

// v384 速度 Tooltip V3 统计核心：04-speed-v3-core.js 全文进 VM，纯函数行为级验证。
// 依赖的存活符号切片取自 overlay.js（V3 集成前的旧构建产物；这些函数按
// specs/speed-tooltip-v3.md §0 在 V3 集成后保留：TPS_BANDS/tpsBand/tpsBandText +
// spd* 基础助手。切片边界对齐 overlay-speed-v2.test.cjs 的手写锚点纪律）。
const core = readOverlayPart('04-speed-v3-core.js');
const bands = sliceOverlay('  var TPS_BANDS = [', '  /* tooltip 颜色对照图例');
const spdHelpers = sliceOverlay('  var SPD_RANGES = [', '  var SPD_PORTAL = "";');
const spdCompact = sliceOverlay('  function spdCompactRange(a, b) {', '  var SPD_PORTAL = "";');

// 冻结时钟：spd3Analyze 的 today/week/month 窗与 month 日历都读 Date.now()，夹具必须
// 钉死同一时刻，否则 08:00/月末/跨年会间歇性变红（真实 Date 是假绿灯）。
const FIXED_NOW = new Date(2026, 10, 5, 14, 0, 0).getTime();   // 2026-11-05 14:00 本地时
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
  vm.runInContext(bands + '\n' + spdHelpers + '\n' + spdCompact + '\n' + core, ctx);
  return ctx;
}

const HOUR = 3600000, DAY = 86400000;
const KEYS = { a: 'prov_a\x1fglm-a', b: 'prov_b\x1fclaude-b' };
// VM 沙箱内的对象/数组与宿主原型不同，deepEqual（按原型严格比较）会假失败——
// 跨沙箱比较一律先 JSON 往返成宿主对象。
const host = x => JSON.parse(JSON.stringify(x));

// 主夹具：3 会话 / 2 项目 / 跨日跨月；轮字段 s,t(绝对),b,out,ms,i,o,n,msl,c,cf。
// msl 全四元组（模型级窗口齐全）；opts.mkeys=false 时去掉帧级身份表（按名称识别）。
function fixture(opts = {}) {
  const d = (day, h) => new Date(2026, 10, day, h).getTime();
  const t0 = d(5, 9);
  const yester = d(4, 15);
  const lastMonth = new Date(2026, 9, 5, 10).getTime();
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
  const h = { sid: 'sess_main', source: 'local', truncated: false,
    sids: ['sess_main', 'sess_proj2', 'sess_other'],
    snames: ['本会话', '同项目另一会话', '别的项目'],
    pids: [['proj_a', '项目A'], ['proj_a', '项目A'], ['proj_b', '项目B']],
    mnames: ['GLM-A', 'Claude-B'], turns };
  if (opts.mkeys !== false) h.mkeys = [KEYS.a, KEYS.b];
  return h;
}

// 旧代夹具：msl 二元组（无模型级窗口）→ msAvail=false 降级模式
function fixtureLegacy(models = 2) {
  const t0 = new Date(2026, 10, 5, 9).getTime();
  const raw = [
    [0, t0, t0 - 60000, 100, 1000, 500, 100, 1, [[0, 100]], 0.01, 1],
    [0, t0 + HOUR, t0 + HOUR - 60000, 400, 8000, 4000, 400, 1, models > 1 ? [[1, 400]] : [[0, 400]], 0.04, 1],
  ];
  let prev = 0;
  const turns = raw.map(r => {
    const o = { s: r[0], t: r[1] - prev, b: r[2], out: r[3], ms: r[4], i: r[5], o: r[6], n: r[7], msl: r[8] };
    prev = r[1];
    o.c = r[9]; o.cf = 1;
    return o;
  });
  const h = { sid: 'sess_main', source: 'local', truncated: false, sids: ['sess_main'], snames: ['S'],
    pids: [['p', 'P']], mnames: ['GLM-A', 'Claude-B'], turns, mkeys: [KEYS.a, KEYS.b] };
  return h;
}

function daysFixture(truncated = 0) {
  const start = new Date(2026, 7, 1).getTime();   // 2026-08-01 本地零点
  const days = [];
  for (let i = 0; i < 10; i++) days.push([0, 0, 0, 0, 0, 0]);      // 空日
  days[2] = [1000, 10000, 3, 2, 0, [[0, 600, 7000, 2, 1], [1, 400, 3000, 1, 1]]];
  days[9] = [500, 5000, 1, 1, 1, [[0, 500, 5000, 1, 1]]];          // capFlag=1
  return { v: 1, source: 'local', start, days,
    mnames: ['GLM-A', 'Claude-B'], mkeys: [KEYS.a, KEYS.b], truncated };
}

function analyze(ctx, h, sd, sel) {
  ctx.__h = h === undefined ? null : h;
  ctx.__sd = sd === undefined ? null : sd;
  ctx.__s = sel || {};
  return vm.runInContext('spd3Analyze(__h, __sd, __s)', ctx);
}

// ---------- ① 轮表解包 ----------
test('spd3Unpack: 四元组/二元组兼容、mkeys 有无两种身份、畸形丢弃、行 msAvail 标记', () => {
  const ctx = makeCtx();
  ctx.__h = fixture();
  const u = vm.runInContext('spd3Unpack(__h)', ctx);
  assert.equal(u.turns.length, 6);
  const mixed = u.turns[3];
  assert.equal(mixed.models.length, 2);
  assert.deepEqual(host(mixed.models[0]),
    { key: KEYS.a, name: 'GLM-A', pid: 'prov_a', mid: 'glm-a', o: 600, ms: 2000, n: 1, tn: 0 });
  assert.equal(mixed.msAvail, true, '四元组帧行级 msAvail=true');
  // 帧级 mkeys 缺席：key = "n\x1f"+name，pid 空、mid=名称（spec §1.3 名称退化）
  ctx.__hn = fixture({ mkeys: false });
  const un = vm.runInContext('spd3Unpack(__hn)', ctx);
  assert.equal(un.turns[0].models[0].key, 'n\x1fGLM-A');
  assert.equal(un.turns[0].models[0].pid, '');
  assert.equal(un.turns[0].models[0].mid, 'GLM-A');
  assert.equal(un.turns[0].msAvail, true, '四元组即使无 mkeys 也有模型级窗口');
  // 二元组（旧帧）：条目 ms=0/n=0，行 msAvail=false；行级 ms 保持整轮窗口
  ctx.__hl = fixtureLegacy();
  const ul = vm.runInContext('spd3Unpack(__hl)', ctx);
  assert.equal(ul.turns.length, 2);
  assert.deepEqual(host(ul.turns[0].models[0]),
    { key: KEYS.a, name: 'GLM-A', pid: 'prov_a', mid: 'glm-a', o: 100, ms: 0, n: 0, tn: 0 });
  assert.equal(ul.turns[0].ms, 1000, '行级窗口不受 msl 代际影响');
  assert.equal(ul.turns[0].msAvail, false);
  // 畸形：t 缺失/非法 → 整帧 fail-closed（minor3：t 是 delta 累加基准，跳行续跑会让
  // 后续所有轮时间整体位移，宁可整体降级 V1 也不出错位统计）
  ctx.__hbT = { sid: 's', source: 'local', truncated: false, sids: ['s'], snames: ['S'],
    pids: [['p', 'P']], mnames: ['GLM-A'], mkeys: ['pa\x1fa'],
    turns: [
      { s: 0, t: 60000, b: 1, out: 100, ms: 1000, i: 1, o: 1, n: 1, msl: [[0, 100, 1000, 1]] },
      { s: 0, t: 'x', b: 1, out: 100, ms: 1000, i: 1, o: 1, n: 1, msl: [[0, 100, 1000, 1]] },
      { s: 0, t: 60000, b: 1, out: 100, ms: 1000, i: 1, o: 1, n: 1, msl: [[0, 100, 1000, 1]] },
    ] };
  assert.equal(vm.runInContext('spd3Unpack(__hbT)', ctx), null,
    '任一轮 t 非法 → 整帧 null（fail-closed，不跳行续跑）');
  ctx.__hbMiss = { sid: 's', source: 'local', truncated: false, sids: ['s'], snames: ['S'],
    pids: [['p', 'P']], mnames: ['GLM-A'], mkeys: ['pa\x1fa'],
    turns: [{ s: 0, b: 1, out: 100, ms: 1000, i: 1, o: 1, n: 1, msl: [[0, 100, 1000, 1]] }] };
  assert.equal(vm.runInContext('spd3Unpack(__hbMiss)', ctx), null, 't 缺失同整帧拒绝');
  // 其余核心字段（out<=0 / ms=0 / s 越界）非法仍整轮丢弃；模型条目非法只跳条目不弃轮
  const t0 = new Date(2026, 10, 5, 9).getTime();
  ctx.__hb = { sid: 's', source: 'local', truncated: false, sids: ['s'], snames: ['S'],
    pids: [['p', 'P']], mnames: ['GLM-A'], mkeys: ['pa\x1fa'],
    turns: [
      { s: 0, t: t0, b: 1, out: 0, ms: 1000, i: 1, o: 1, n: 1, msl: [[0, 100, 1000, 1]] },
      { s: 0, t: 60000, b: 1, out: 100, ms: 0, i: 1, o: 1, n: 1, msl: [[0, 100, 1000, 1]] },
      { s: 9, t: 60000, b: 1, out: 100, ms: 1000, i: 1, o: 1, n: 1, msl: [[0, 100, 1000, 1]] },
      { s: 0, t: 60000, b: 1, out: 100, ms: 1000, i: 1, o: 1, n: 1, msl: [[9, 100, 1000, 1]] },  // mnames[9] 缺
      { s: 0, t: 60000, b: 1, out: 100, ms: 1000, i: 1, o: 1, n: 1, msl: [[0, 100, 1000, 1]] },
    ] };
  const ub = vm.runInContext('spd3Unpack(__hb)', ctx);
  assert.equal(ub.turns.length, 2, 'out/ms/s 非法的轮整轮丢弃（t 在场的帧不整帧拒绝）');
  assert.equal(ub.turns[0].models.length, 0, '非法模型条目只跳条目');
  assert.equal(ub.turns[0].msAvail, false);
  assert.equal(ub.turns[1].models.length, 1);
  // 帧结构非法 → null（调用方回退 V1）
  assert.equal(vm.runInContext('spd3Unpack(null)', ctx), null);
  assert.equal(vm.runInContext('spd3Unpack({turns: []})', ctx), null);
  assert.equal(vm.runInContext('spd3Unpack({turns: [], sids: null, snames: []})', ctx), null);
});

test('spd3Unpack 按帧引用缓存：同引用复用、轮数变化失效、新引用重算但结果逐字段一致', () => {
  const ctx = makeCtx();
  ctx.__h = fixture();
  const a = vm.runInContext('spd3Unpack(__h)', ctx);
  assert.equal(vm.runInContext('spd3Unpack(__h)', ctx), a, '同一引用返回同一结果对象');
  ctx.__h2 = JSON.parse(JSON.stringify(fixture()));
  const b = vm.runInContext('spd3Unpack(__h2)', ctx);
  assert.notEqual(b, a);
  assert.deepEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)));
  ctx.__h.turns.push({ s: 0, t: 60000, b: 1, out: 100, ms: 1000, i: 1, o: 1, n: 1, msl: [[0, 100, 1000, 1]] });
  const c = vm.runInContext('spd3Unpack(__h)', ctx);
  assert.equal(c.turns.length, a.turns.length + 1, '原地追加一轮后轮数守卫使缓存失效');
});

// ---------- ② speed_days 解包 ----------
test('spd3UnpackDays: 空日跳过、索引→本地日界换算、非法 v/结构整帧拒绝、同引用缓存', () => {
  const ctx = makeCtx();
  ctx.__sd = daysFixture();
  const res = vm.runInContext('spd3UnpackDays(__sd)', ctx);
  assert.equal(res.rows.length, 2, '空日不产行');
  const d2 = res.rows[0];
  assert.equal(d2.t0, new Date(2026, 7, 3).getTime());
  assert.equal(d2.t1, new Date(2026, 7, 4).getTime());
  assert.equal(d2.t, d2.t1 - 1, '日行 t=当日最后一毫秒（与轮表行同形）');
  assert.equal(d2.b, d2.t0);
  assert.equal(d2.out, 1000);
  assert.equal(d2.ms, 10000);
  assert.equal(d2.n, 3);
  assert.equal(d2.turns, 2);
  assert.equal(d2.capped, false);
  assert.equal(d2.sid, '');
  assert.equal(d2.pid, '');
  assert.equal(d2.models[0].key, KEYS.a);
  assert.equal(d2.models[1].tn, 1, '日行模型分量携带 tn');
  const d9 = res.rows[1];
  assert.equal(d9.t0, new Date(2026, 7, 10).getTime());
  assert.equal(d9.capped, true, 'capFlag 透传');
  // 非法帧：v≠1 / days 非数组 / start 缺失
  ctx.__bad1 = Object.assign({}, daysFixture(), { v: 2 });
  assert.equal(vm.runInContext('spd3UnpackDays(__bad1)', ctx), null);
  ctx.__bad2 = Object.assign({}, daysFixture(), { days: 'x' });
  assert.equal(vm.runInContext('spd3UnpackDays(__bad2)', ctx), null);
  ctx.__bad3 = { v: 1, days: [] };
  assert.equal(vm.runInContext('spd3UnpackDays(__bad3)', ctx), null);
  // 同引用缓存
  assert.equal(vm.runInContext('spd3UnpackDays(__sd)', ctx), res);
});

// ---------- ③ 筛选状态机 ----------
test('spd3Filter: auto 首点=只看该模型、toggle 增删、空集=显式空态、all 复位、签名稳定', () => {
  const ctx = makeCtx();
  const r = vm.runInContext(`(() => {
    const f = spd3FilterAuto();
    const out = { init: JSON.stringify(f), sameRef: true };
    spd3FilterToggle(f, 'k1');
    out.first = JSON.stringify(f);
    spd3FilterToggle(f, 'k2');
    out.second = JSON.stringify(f);
    spd3FilterToggle(f, 'k2');
    out.removed = JSON.stringify(f);
    spd3FilterToggle(f, 'k1');
    out.empty = JSON.stringify(f);
    out.emptyIsEmpty = spd3FilterIsEmpty(f);
    out.emptySig = spd3FilterSig(f);
    out.onlyRet = spd3FilterOnly(f, ['b', 'a', 'b']) === f;
    out.only = JSON.stringify(f);
    spd3FilterAll(f);
    out.all = JSON.stringify(f);
    out.allIsEmpty = spd3FilterIsEmpty(f);
    out.autoSig = spd3FilterSig(spd3FilterAuto());
    spd3FilterOnly(f, ['k2', 'k1']);
    out.sig1 = spd3FilterSig(f);
    spd3FilterAll(f);
    spd3FilterOnly(f, ['k1', 'k2']);
    out.sig2 = spd3FilterSig(f);
    spd3FilterToggle(null, 'x');
    out.nullSafe = true;
    return out;
  })()`, ctx);
  assert.deepEqual(JSON.parse(r.init), { mode: 'auto', keys: null });
  assert.deepEqual(JSON.parse(r.first), { mode: 'sel', keys: ['k1'] }, 'auto 首次点击=只看该模型');
  assert.deepEqual(JSON.parse(r.second), { mode: 'sel', keys: ['k1', 'k2'] });
  assert.deepEqual(JSON.parse(r.removed), { mode: 'sel', keys: ['k1'] });
  assert.deepEqual(JSON.parse(r.empty), { mode: 'sel', keys: [] }, '清空到 0 个保持 sel 空数组=显式空态');
  assert.equal(r.emptyIsEmpty, true);
  assert.equal(r.emptySig, 'sel:', '显式空态与 auto 签名不同');
  assert.equal(r.onlyRet, true, '原地改属性返回同引用');
  assert.deepEqual(JSON.parse(r.only), { mode: 'sel', keys: ['b', 'a'] }, 'only 去重');
  assert.deepEqual(JSON.parse(r.all), { mode: 'auto', keys: null }, 'all=恢复 auto');
  assert.equal(r.allIsEmpty, false);
  assert.equal(r.autoSig, 'auto');
  assert.equal(r.sig1, r.sig2, '签名与 toggle 顺序无关（排序稳定）');
  assert.ok(r.nullSafe);
});

// ---------- ④ 聚合器 ----------
test('spd3Aggregate/spd3PerModel: Σout/Σms 加权、按 key 累计模型分量、绝不算术平均', () => {
  const ctx = makeCtx();
  const r = vm.runInContext(`(() => {
    const rows = [
      { t: 1000, b: 0, out: 100, ms: 1000, i: 1, o: 2, n: 1, models: [
        { key: 'a', name: 'A', pid: '', mid: 'A', o: 60, ms: 400, n: 1 },
        { key: 'b', name: 'B', pid: '', mid: 'B', o: 40, ms: 600, n: 1 }] },
      { t: 2000, b: 1500, out: 300, ms: 3000, i: 1, o: 2, n: 2, models: [
        { key: 'b', name: 'B', pid: '', mid: 'B', o: 300, ms: 3000, n: 2 }] }
    ];
    return { agg: spd3Aggregate(rows, true), pm: spd3PerModel(rows), empty: spd3Aggregate([]) };
  })()`, ctx);
  assert.equal(r.empty, null);
  assert.equal(r.agg.v, 400 / 4, '整体=Σ400/Σ4s=100 t/s');
  assert.equal(r.agg.turns, 2);
  assert.deepEqual(host(r.agg.modelNames), ['B', 'A'], 'withNames 全量名单按 Σ输出降序');
  assert.equal(r.agg.models.length, 2, '模型分量不截断（悬停合成明细需完整组成）');
  assert.ok(Math.abs(r.agg.models[0].tps - 340 / 3.6) < 1e-9, 'B: 340out/3.6s');
  assert.ok(Math.abs(r.agg.models[1].tps - 150) < 1e-9, 'A: 60out/0.4s');
  assert.equal(r.agg.models[0].key, 'b');
  assert.equal(r.pm[0].name, 'B', 'perModel 按 out 降序');
  assert.ok(Math.abs(r.pm[0].tps - 340 / 3.6) < 1e-9);
  assert.ok(Math.abs(r.pm[1].tps - 150) < 1e-9);
  assert.equal(r.pm[0].n, 3);
  assert.equal(r.pm[0].tn, 2, '轮表行每含该模型一轮计 1');
});

// ---------- ⑤ 黄金用例（PRD 16.4）----------
test('黄金用例: A=100t/1s、B=100t/10s → A 100 t/s、B 10 t/s、综合 200/11≈18.18 ≠ (100+10)/2', () => {
  const ctx = makeCtx();
  const t0 = new Date(2026, 10, 5, 9).getTime();
  const build = turns => ({ sid: 's', source: 'local', truncated: false, sids: ['s'], snames: ['S'],
    pids: [['p', 'P']], mnames: ['ModelA', 'ModelB'], mkeys: ['pa\x1fa', 'pb\x1fb'], turns });
  // 形态一：两轮各单模型
  const h1 = build([
    { s: 0, t: t0, b: t0 - 60000, out: 100, ms: 1000, i: 80, o: 100, n: 1, msl: [[0, 100, 1000, 1]], c: 0.01, cf: 1 },
    { s: 0, t: HOUR, b: t0 + HOUR - 60000, out: 100, ms: 10000, i: 80, o: 100, n: 1, msl: [[1, 100, 10000, 1]], c: 0.01, cf: 1 },
  ]);
  const an1 = analyze(ctx, h1, null, { range: 'session', period: 'all', sid: 's' });
  assert.ok(Math.abs(an1.overall.v - 200 / 11) < 1e-9, '综合=200t/11s');
  assert.ok(Math.abs(an1.overall.v - 55) > 1, '绝不等于算术平均 (100+10)/2=55');
  const pm1 = {};
  for (const e of an1.perModel) pm1[e.key] = e;
  assert.ok(Math.abs(pm1['pa\x1fa'].tps - 100) < 1e-9, 'A=100 t/s');
  assert.ok(Math.abs(pm1['pb\x1fb'].tps - 10) < 1e-9, 'B=10 t/s');
  assert.equal(pm1['pa\x1fa'].share, 0.5);
  assert.equal(pm1['pb\x1fb'].share, 0.5, 'share=请求数占比');
  const om1 = {};
  for (const e of an1.overall.models) om1[e.key] = e;
  assert.ok(Math.abs(om1['pa\x1fa'].tps - 100) < 1e-9, 'overall.models 同口径带每模型 tps');
  assert.ok(Math.abs(om1['pb\x1fb'].tps - 10) < 1e-9);
  // 形态二：同一混合轮（行窗口=Σ模型窗口=11s），结果必须一致
  const h2 = build([
    { s: 0, t: t0, b: t0 - 60000, out: 200, ms: 11000, i: 160, o: 200, n: 2,
      msl: [[0, 100, 1000, 1], [1, 100, 10000, 1]], c: 0.02, cf: 1 },
  ]);
  const an2 = analyze(ctx, h2, null, { range: 'session', period: 'recent', sid: 's' });
  assert.ok(Math.abs(an2.overall.v - 200 / 11) < 1e-9, '混合轮综合同为 200/11');
  const pm2 = {};
  for (const e of an2.perModel) pm2[e.key] = e;
  assert.ok(Math.abs(pm2['pa\x1fa'].tps - 100) < 1e-9);
  assert.ok(Math.abs(pm2['pb\x1fb'].tps - 10) < 1e-9);
  assert.equal(an2.items[0].models.length, 2, '混合轮在 items 上可判');
});

// ---------- ⑥ 20 组合 + 范围隔离 + 远端降级 + 空池 ----------
test('20 组合无崩溃、无 0 t/s 假值；范围隔离；远端 all 降级+通知；h/sd 双缺回 null', () => {
  const ctx = makeCtx();
  const h = fixture();
  for (const range of ['recent', 'session', 'project', 'all']) {
    for (const period of ['recent', 'today', 'week', 'month', 'all']) {
      const an = analyze(ctx, h, null, { range, period, sid: 'sess_main' });
      assert.ok(an, range + '×' + period);
      assert.ok(Array.isArray(an.items));
      for (const it of an.items) {
        if (it.empty) assert.equal(it.v, null, '空桶不携带速度');
        else assert.ok(it.v > 0 && isFinite(it.v), '无 0/假 t/s: ' + range + '×' + period);
      }
      if (an.overall) assert.ok(an.overall.v > 0);
      assert.equal(typeof an.title, 'string');
      assert.ok(an.title.length > 0);
    }
  }
  // 范围隔离：同帧不同 sid / 不同范围结果不同（session 3 / project 5 / all 6 轮）
  const s = analyze(ctx, h, null, { range: 'session', period: 'all', sid: 'sess_main' });
  const p = analyze(ctx, h, null, { range: 'project', period: 'all', sid: 'sess_main' });
  const a = analyze(ctx, h, null, { range: 'all', period: 'all', sid: 'sess_main' });
  const so = analyze(ctx, h, null, { range: 'session', period: 'all', sid: 'sess_other' });
  assert.equal(s.overall.turns, 3);
  assert.equal(p.overall.turns, 5);
  assert.equal(a.overall.turns, 6);
  assert.equal(so.overall.turns, 1, '同帧不同 sid 结果不同');
  // 远端 all：fail-closed 降级本会话 + 通知
  const rm = analyze(ctx, h, null, { range: 'all', period: 'all', sid: 'sess_main', remote: true });
  assert.equal(rm.range, 'session');
  assert.match(rm.notice, /远端/);
  assert.equal(rm.overall.turns, 3, '不把本地库冒充远端历史');
  // 空轮表：items 空数组而非 null 崩溃
  const empty = { sid: 'sess_main', source: 'local', truncated: false,
    sids: ['sess_main'], snames: ['S'], pids: [['p', 'P']], mnames: ['GLM-A'],
    mkeys: ['pa\x1fa'], turns: [] };
  const an2 = analyze(ctx, empty, null, { range: 'all', period: 'week', sid: 'sess_main' });
  assert.ok(an2);
  assert.equal(an2.items.length, 0);
  assert.equal(an2.overall, null);
  assert.equal(an2.peak, null);
  // h 与 sd 都缺 → null（调用方回退 V1）；h 畸形且无 sd → 同样 null
  assert.equal(analyze(ctx, null, null, { range: 'all', period: 'all', sid: '' }), null);
  assert.equal(analyze(ctx, { turns: [] }, null, { range: 'all', period: 'all', sid: '' }), null);
  // today 空小时桶：保留空位不显 0（00:00..14:00 = 15 桶）
  const td = analyze(ctx, h, null, { range: 'all', period: 'today', sid: 'sess_main' });
  assert.equal(td.unit, 'hour');
  assert.equal(td.items.length, 15);
  assert.ok(td.items.some(x => x.empty), '无数据小时=空桶');
  assert.ok(td.items.every(x => x.empty || x.v > 0));
});

// ---------- ⑦ recent N 轮窗口固定 ----------
test('recent 窗口固定: 先取最近 18 轮再筛分量，span 不缩出原窗口、不向更早补轮', () => {
  const ctx = makeCtx();
  const t0 = new Date(2026, 10, 5, 9).getTime();
  const turns = [];
  let prev = 0;
  for (let i = 0; i < 20; i++) {
    const abs = t0 + i * 60000;
    turns.push({ s: 0, t: abs - prev, b: abs - 30000, out: 100, ms: 1000, i: 80, o: 100, n: 1,
      msl: i % 2 ? [[1, 100, 1000, 1]] : [[0, 100, 1000, 1]], c: 0.01, cf: 1 });
    prev = abs;
  }
  const h = { sid: 's', source: 'local', truncated: false, sids: ['s'], snames: ['S'],
    pids: [['p', 'P']], mnames: ['A', 'B'], mkeys: ['k\x1fa', 'k\x1fb'], turns };
  const base = analyze(ctx, h, null, { range: 'recent', period: 'recent', sid: 's' });
  assert.equal(base.items.length, 18, '20 轮取最近 18（SPD_BARS_MAX）');
  const an = analyze(ctx, h, null, { range: 'recent', period: 'recent', sid: 's',
    filt: { mode: 'sel', keys: ['k\x1fa'] } });
  assert.equal(an.items.length, 9, '窗口内只剩 A 的 9 轮');
  assert.ok(an.items.every(it => it.models.length === 1 && it.models[0].key === 'k\x1fa'),
    '每根柱只剩选中分量');
  assert.ok(an.spanA >= base.spanA && an.spanB <= base.spanB, '筛选后 span 仍在原 18 轮窗口内');
  assert.ok(an.spanB < base.spanB, '最新轮是 B 独占 → spanB 收缩（不向更早补轮）');
  // 20 组合下 recent+month 交叉：时间窗先行、18 轮上限在后（沿用 V2 顺序）
  const an2 = analyze(ctx, h, null, { range: 'all', period: 'recent', sid: 's',
    filt: { mode: 'sel', keys: ['k\x1fb'] } });
  assert.equal(an2.items.length, 9);
});

// ---------- ⑧ 混合轮识别 ----------
test('混合轮识别: models.length>1 的轮在 recent items 上可判，单模型轮可判', () => {
  const ctx = makeCtx();
  const an = analyze(ctx, fixture(), null, { range: 'session', period: 'recent', sid: 'sess_main' });
  const mixed = an.items.filter(it => it.models && it.models.length > 1);
  assert.equal(mixed.length, 1, 'fixture 恰一轮 [A,B] 混合');
  assert.deepEqual(host(mixed[0].models.map(m => m.key)), [KEYS.a, KEYS.b]);
  assert.ok(mixed[0].models.every(m => m.ms > 0), '混合轮分量携带各自窗口（悬停给真实组成）');
  assert.ok(an.items.some(it => it.models && it.models.length === 1), '单模型轮 models.length===1');
});

// ---------- ⑨ 降级模式 ----------
test('降级模式: 全二元组帧 msAvail=false+通知；单模型不提示；整轮速度照常；fms=0 models 清空', () => {
  const ctx = makeCtx();
  const an = analyze(ctx, fixtureLegacy(), null, { range: 'session', period: 'all', sid: 'sess_main' });
  assert.equal(an.msAvail, false);
  assert.match(an.notice, /模型级生成耗时/);
  assert.ok(an.overall.v > 0, '整轮速度仍按行窗口正常出（图/柱仍画整轮值）');
  assert.ok(an.perModel.every(e => e.tps === null), '无窗口分量的模型 tps=null，绝不冒充');
  // 单模型二元组帧：msAvail=false 但原始池模型数=1（无第二个模型可比），不加降级通知
  const an1 = analyze(ctx, fixtureLegacy(1), null, { range: 'session', period: 'all', sid: 'sess_main' });
  assert.equal(an1.msAvail, false);
  assert.doesNotMatch(an1.notice, /模型级生成耗时/, '单模型无需比较速度不提示');
  // 降级帧内筛选：行级单模型整行选中（fm===models）原行直通，msAvail 判据不变
  const anF = analyze(ctx, fixtureLegacy(), null, { range: 'session', period: 'recent', sid: 'sess_main',
    filt: { mode: 'sel', keys: [KEYS.b] } });
  assert.equal(anF.items.length, 1);
  assert.ok(anF.items[0].v > 0 && isFinite(anF.items[0].v));
  assert.deepEqual(host(anF.items[0].models.map(m => m.key)), [KEYS.b], '单模型行整行选中原样保留');
  // 降级通知判据=未筛选原始池模型数>1（M1/S8）：筛选到单模型不再抑制披露
  const anNotice = analyze(ctx, fixtureLegacy(), null, { range: 'session', period: 'recent', sid: 'sess_main',
    filt: { mode: 'sel', keys: [KEYS.b] } });
  assert.match(anNotice.notice, /模型级生成耗时/, '原始池有第二个模型可比，筛选后仍披露降级');
  // 降级帧混合轮部分选中：fm<全部分量且 fms=0 → 整行 out/ms 保留入聚合（画整轮值），
  // models 清空（身份不入 perModel/悬停组成，绝不拿「分量输出 ÷ 整轮窗口」冒充模型速度）
  const t0m = new Date(2026, 10, 5, 9).getTime();
  ctx.__hm = { sid: 's', source: 'local', truncated: false, sids: ['s'], snames: ['S'],
    pids: [['p', 'P']], mnames: ['GLM-A', 'Claude-B'], mkeys: [KEYS.a, KEYS.b],
    turns: [{ s: 0, t: t0m, b: t0m - 60000, out: 500, ms: 4000, i: 1, o: 1, n: 2,
      msl: [[0, 100], [1, 400]] }] };
  const anM = analyze(ctx, ctx.__hm, null, { range: 'session', period: 'recent', sid: 's',
    filt: { mode: 'sel', keys: [KEYS.a] } });
  assert.equal(anM.items.length, 1);
  assert.equal(anM.items[0].out, 500, '整行 out 保留（降级模式画整轮值）');
  assert.equal(anM.items[0].ms, 4000);
  assert.deepEqual(host(anM.items[0].models), [], 'fms=0 → models 置空数组（柱走中性色）');
  assert.equal(anM.pool[0].msAvail, false, '行级 msAvail 同步翻 false');
  assert.equal(anM.perModel.length, 0, '清空身份不入 perModel（左卡不冒充单模型态）');
  assert.equal(anM.msAvail, false);
  assert.match(anM.notice, /模型级生成耗时/, '原始池模型数=2 > 1 → 降级披露在场');
  assert.ok(Math.abs(anM.overall.v - 125) < 1e-9, '速度=整轮 500t/4s，不是 100t/4s 的假模型速度');
});

// ---------- ⑩ month daysGrid ----------
test('month daysGrid 覆盖当月全部日: 11 月 30 天、闰年 2 月 29 天、未来日 agg=null', () => {
  const ctx = makeCtx();
  const an = analyze(ctx, fixture(), null, { range: 'all', period: 'month', sid: 'sess_main' });
  assert.ok(an.daysGrid, 'month 组合输出 daysGrid');
  assert.equal(an.daysGrid.length, 30, '11 月 30 天');
  assert.equal(an.daysGrid[0].t0, new Date(2026, 10, 1).getTime());
  assert.equal(an.daysGrid[0].t1, new Date(2026, 10, 2).getTime());
  assert.equal(an.daysGrid[29].t0, new Date(2026, 10, 30).getTime());
  assert.ok(an.daysGrid[3].agg, '11-04 有数据 → agg 非空');
  assert.ok(an.daysGrid[4].agg, '今天（11-05）有数据 → agg 非空');
  assert.equal(an.daysGrid[5].agg, null, '未来日无聚合');
  assert.equal(an.daysGrid[29].agg, null);
  // 闰年：另起沙箱冻结 2024-02-15
  const ctx2 = makeCtx(new Date(2024, 1, 15, 10).getTime());
  const tab = new Date(2024, 1, 10, 9).getTime();
  const h = { sid: 's', source: 'local', truncated: false, sids: ['s'], snames: ['S'],
    pids: [['p', 'P']], mnames: ['GLM-A'], mkeys: ['pa\x1fa'],
    turns: [{ s: 0, t: tab, b: tab - 60000, out: 100, ms: 1000, i: 80, o: 100, n: 1, msl: [[0, 100, 1000, 1]] }] };
  const an2 = analyze(ctx2, h, null, { range: 'all', period: 'month', sid: 's' });
  assert.equal(an2.daysGrid.length, 29, '2024 闰年 2 月 29 天');
  assert.equal(an2.daysGrid[9].t0, new Date(2024, 1, 10).getTime());
  assert.ok(an2.daysGrid[9].agg && an2.daysGrid[9].agg.v > 0);
  assert.equal(an2.daysGrid[28].agg, null, '2-29 相对冻结时刻是未来日');
  // 非 month 组合不产 daysGrid
  const wk = analyze(ctx, fixture(), null, { range: 'all', period: 'week', sid: 'sess_main' });
  assert.equal(wk.daysGrid, undefined);
});

// ---------- ⑪ all+sd 合并池 ----------
test('all+sd 合并池: speed_days 全历史 + 晚于覆盖末日的轮表行，按 t 分界无重叠无遗漏', () => {
  const ctx = makeCtx();
  const start = new Date(2026, 5, 1).getTime();   // 2026-06-01 本地零点，覆盖 06-01..06-10
  const days = [];
  for (let i = 0; i < 10; i++) days.push([100, 1000, 1, 1, 0, [[0, 100, 1000, 1, 1]]]);
  const sd = { v: 1, source: 'local', start, days,
    mnames: ['GLM-A'], mkeys: ['pa\x1fa'], truncated: 1 };
  // h：1 轮落在覆盖期内（必须丢弃）+ 1 轮恰在分界（>= 并入）+ 1 轮更晚（并入）
  const inCover = new Date(2026, 5, 3, 8).getTime();
  const atBoundary = start + 10 * DAY;
  const after = new Date(2026, 5, 15, 9).getTime();
  const h = { sid: 'sess_main', source: 'local', truncated: false, sids: ['sess_main'], snames: ['S'],
    pids: [['p', 'P']], mnames: ['GLM-A'], mkeys: ['pa\x1fa'],
    turns: [
      { s: 0, t: inCover, b: inCover - 60000, out: 999, ms: 9990, i: 1, o: 1, n: 1, msl: [[0, 999, 9990, 1]] },
      { s: 0, t: atBoundary - inCover, b: atBoundary - 60000, out: 200, ms: 2000, i: 1, o: 1, n: 1, msl: [[0, 200, 2000, 1]] },
      { s: 0, t: after - atBoundary, b: after - 60000, out: 300, ms: 3000, i: 1, o: 1, n: 1, msl: [[0, 300, 3000, 1]] },
    ] };
  const an = analyze(ctx, h, sd, { range: 'all', period: 'all', sid: 'sess_main' });
  assert.equal(an.pool.length, 12, '10 日行 + 2 轮行（覆盖期内轮丢弃）');
  assert.equal(an.overall.turns, 12, '日行 turns=1/天 + 轮行');
  assert.equal(an.overall.out, 10 * 100 + 200 + 300, '无重叠无遗漏：999 的覆盖期内轮未混入');
  assert.match(an.notice, /已截断 · 仅显示最近 10 天/, 'sd 截断提示带实际覆盖天数');
  assert.equal(an.items.length, 12, '日桶：06-01..06-10 + 06-11 + 06-15');
  assert.ok(an.items.every(it => !it.empty || it.v === null));
  assert.ok(an.items.filter(it => !it.empty && it.a < atBoundary).every(it => it.out === 100),
    '覆盖期桶只含日行值');
  // sd-only（h 缺）：纯日行池
  const anSd = analyze(ctx, null, sd, { range: 'all', period: 'all', sid: '' });
  assert.equal(anSd.pool.length, 10);
  assert.equal(anSd.overall.out, 1000);
  // 非 all×all 组合不吃 sd（会话范围回到轮表行）
  const anSess = analyze(ctx, h, sd, { range: 'session', period: 'all', sid: 'sess_main' });
  assert.equal(anSess.pool.length, 3, '会话范围=轮表 3 轮，日行无 sid 天然剔除');
});

// ---------- ⑫ 筛选 × 分析集成 ----------
test('筛选 × 分析: selMissing/无数据通知、显式空态、share 恒 1、部分筛选重算分量', () => {
  const ctx = makeCtx();
  const h = fixture();
  // 只看 B：sess_main 里 B 只出现在混合轮（300t/1s），单模型轮全是 A → 被整行剔除
  const an = analyze(ctx, h, null, { range: 'session', period: 'all', sid: 'sess_main',
    filt: { mode: 'sel', keys: [KEYS.b] } });
  assert.ok(Math.abs(an.overall.v - 300) < 1e-9, 'B 分量 Σ300t/Σ1s=300 t/s（有窗口分量按 spec §4 重算）');
  assert.equal(an.overall.turns, 1, '纯 A 轮整行剔除');
  const pm = {};
  for (const e of an.perModel) pm[e.key] = e;
  assert.equal(Object.keys(pm).length, 1);
  assert.ok(Math.abs(pm[KEYS.b].tps - 300) < 1e-9);
  assert.equal(pm[KEYS.b].out, 300);
  assert.equal(pm[KEYS.b].ms, 1000);
  assert.equal(pm[KEYS.b].share, 1, '筛选后占比仍恰好 1');
  // sel 中含池外模型 → selMissing + 通知
  const anMiss = analyze(ctx, h, null, { range: 'session', period: 'week', sid: 'sess_main',
    filt: { mode: 'sel', keys: [KEYS.b, 'ghost\x1fmodel'] } });
  assert.deepEqual(host(anMiss.selMissing), ['ghost\x1fmodel']);
  assert.match(anMiss.notice, /2 个模型中 1 个在当前范围无数据/);
  // 显式空态：sel 空 keys → 池清空、不崩、无 selMissing
  const anEmpty = analyze(ctx, h, null, { range: 'session', period: 'all', sid: 'sess_main',
    filt: { mode: 'sel', keys: [] } });
  assert.equal(anEmpty.items.length, 0);
  assert.equal(anEmpty.overall, null);
  assert.deepEqual(host(anEmpty.selMissing), []);
  // auto（默认）不过滤
  const anAuto = analyze(ctx, h, null, { range: 'session', period: 'all', sid: 'sess_main',
    filt: { mode: 'auto', keys: null } });
  assert.equal(anAuto.overall.turns, 3);
});

// ---------- ⑬ 颜色与身份键 ----------
test('spd3Color/spd3ModelKey: FNV-1a 稳定取色、恒落 10 色调色板、模型 key 兜底', () => {
  const ctx = makeCtx();
  const r = vm.runInContext(`(() => {
    const c1 = spd3Color('prov_a\\x1fglm-a');
    const stable = [...Array(50)].every((_, i) => spd3Color('k' + i) === spd3Color('k' + i));
    const inPal = [...Array(300)].every((_, i) => SPD3_PALETTE.includes(spd3Color('x' + i)));
    const unihit = new Set([...Array(300)].map((_, i) => spd3Color('x' + i))).size;
    return { len: SPD3_PALETTE.length, c1, stable, inPal, unihit,
      mk1: spd3ModelKey({ key: 'a\\x1fb', name: 'n' }),
      mk2: spd3ModelKey({ name: 'only-name' }),
      mk3: spd3ModelKey(null),
      mk4: spd3ModelKey({}) };
  })()`, ctx);
  assert.equal(r.len, 10);
  assert.ok(r.stable, '同 key 恒同色');
  assert.ok(r.inPal, '取值恒在调色板内');
  assert.ok(r.unihit >= 6 && r.unihit <= 10, '300 个 key 至少命中 6 色（不塌缩到单色）');
  assert.equal(r.mk1, 'a\x1fb');
  assert.equal(r.mk2, 'n\x1fonly-name');
  assert.equal(r.mk3, 'n\x1f');
  assert.equal(r.mk4, 'n\x1f');
});

// ---------- ⑭ memo（spd3AnalyzeCached） ----------
test('spd3AnalyzeCached: 同帧同签名复用同对象、sel 原地变化/新 sd 帧即重算、与纯函数逐字段一致', () => {
  const ctx = makeCtx();
  ctx.__h = fixture();
  ctx.__sd = null;
  ctx.__s1 = { range: 'session', period: 'all', sid: 'sess_main' };
  const r1 = vm.runInContext('spd3AnalyzeCached(__h, __sd, __s1)', ctx);
  const r2 = vm.runInContext('spd3AnalyzeCached(__h, __sd, __s1)', ctx);
  assert.equal(r1, r2, '同帧+同 sel 签名返回同一结果对象');
  // sel 原地改属性（V2 惯例）→ 签名变 → 重算
  vm.runInContext('__s1.range = "all"', ctx);
  const r3 = vm.runInContext('spd3AnalyzeCached(__h, __sd, __s1)', ctx);
  assert.notEqual(r3, r1);
  assert.equal(r3.range, 'all');
  // 缓存不改变语义：与纯函数结果逐字段一致
  const pure = vm.runInContext('spd3Analyze(__h, __sd, __s1)', ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(r3)), JSON.parse(JSON.stringify(pure)));
  // filt 原地 toggle → 签名变
  ctx.__s2 = { range: 'session', period: 'all', sid: 'sess_main', filt: { mode: 'auto', keys: null } };
  const c1 = vm.runInContext('spd3AnalyzeCached(__h, __sd, __s2)', ctx);
  vm.runInContext('spd3FilterToggle(__s2.filt, ' + JSON.stringify(KEYS.b) + ')', ctx);
  const c2 = vm.runInContext('spd3AnalyzeCached(__h, __sd, __s2)', ctx);
  assert.notEqual(c2, c1, 'filt 原地变化即重算');
  // sd 换新帧（同内容新对象）→ sdId 变 → 重算。每帧多槽 memo（S10/B1）：sdA 被 sdB
  // 写入后 sdA 槽位仍在——wire 筛选激活时同帧连续算 sel/auto 两签名，单槽会逐拍互踢
  ctx.__s3 = { range: 'all', period: 'all', sid: '' };
  ctx.__sdA = daysFixture();
  ctx.__sdB = daysFixture();
  const d1 = vm.runInContext('spd3AnalyzeCached(__h, __sdA, __s3)', ctx);
  const d2 = vm.runInContext('spd3AnalyzeCached(__h, __sdB, __s3)', ctx);
  assert.notEqual(d1, d2, '新 sd 帧不命中旧缓存（sdId 进签名）');
  const d1again = vm.runInContext('spd3AnalyzeCached(__h, __sdA, __s3)', ctx);
  assert.equal(d1again, d1, '多槽：sdB 写入不挤掉 sdA，同签名命中同对象');
  assert.equal(vm.runInContext('spd3AnalyzeCached(__h, __sdB, __s3)', ctx), d2, 'sdB 槽位同样保留');
  // 槽容量 ≤8（SPD3_MEMO_CAP）：第 9 个签名整清后只剩当前——同帧 8 个互异签名全部
  // 命中，第 9 个写入后首个签名丢失、重算出新对象（结果仍逐字段一致）。
  // 用全新帧对象：memo 按帧引用分桶，避免与本用例前段的槽位混桶。
  ctx.__h2 = fixture();
  const sigs = [];
  for (let i = 0; i < 8; i++) {
    vm.runInContext('__sf = { range: "all", period: "all", sid: "", focus: "f' + i + '" }', ctx);
    sigs.push(vm.runInContext('spd3AnalyzeCached(__h2, null, __sf)', ctx));
  }
  assert.equal(new Set(sigs).size, 8, '8 个互异签名各占一槽（对象互异）');
  for (let i = 0; i < 8; i++) {
    vm.runInContext('__sf = { range: "all", period: "all", sid: "", focus: "f' + i + '" }', ctx);
    assert.equal(vm.runInContext('spd3AnalyzeCached(__h2, null, __sf)', ctx), sigs[i],
      '槽位 ' + i + ' 在容量内持续命中');
  }
  vm.runInContext('__sf = { range: "all", period: "all", sid: "", focus: "f9" }', ctx);
  const ninth = vm.runInContext('spd3AnalyzeCached(__h2, null, __sf)', ctx);
  vm.runInContext('__sf = { range: "all", period: "all", sid: "", focus: "f0" }', ctx);
  const afterClear = vm.runInContext('spd3AnalyzeCached(__h2, null, __sf)', ctx);
  assert.notEqual(afterClear, sigs[0], '超限整清：第 9 个签名写入后首个槽位丢失重算');
  assert.equal(JSON.stringify(afterClear), JSON.stringify(sigs[0]), '整清重算结果逐字段一致');
  vm.runInContext('__sf = { range: "all", period: "all", sid: "", focus: "f9" }', ctx);
  assert.equal(vm.runInContext('spd3AnalyzeCached(__h2, null, __sf)', ctx), ninth,
    '整清后仅当前签名（f9）在槽');
});

// ---------- DST 回归（B）：主进程改 TZ 不可靠，用 TZ 子进程验日历日界三件事 ----------
// ①spd3UnpackDays 每日 t0 恒本地日历零点（跨 2026-11-01 美东回退日 25h，固定 864e5
//   步长会把日桶键推离日历零点 ±1h 累计）；②sd+轮表合并接缝=覆盖末日次日**日历零点**
//   （覆盖末日内 23:30 晚轮不双重计数——固定步长接缝在跨 DST 帧会漂进覆盖末日）；
//   ③周窗口 weekStart 日历化（today-6 个本地日，回退周内固定毫秒差会多切 1h）。
test('DST 回归（America/New_York 子进程）: sd 日行 t0 日历零点、接缝 23:30 轮不双计、week 窗日历化', t => {
  const childSrc = [
    "'use strict';",
    'const fs = require("fs"), path = require("path"), vm = require("vm");',
    'const ROOT = ' + JSON.stringify(path.join(__dirname, '..')) + ';',
    'const overlay = fs.readFileSync(path.join(ROOT, "overlay.js"), "utf8");',
    'const core = fs.readFileSync(path.join(ROOT, "src", "overlay", "04-speed-v3-core.js"), "utf8");',
    'const bands = overlay.slice(overlay.indexOf("  var TPS_BANDS = ["), overlay.indexOf("  /* tooltip 颜色对照图例"));',
    'const helpers = overlay.slice(overlay.indexOf("  var SPD_RANGES = ["), overlay.indexOf("  var SPD_PORTAL = \\"\\";"));',
    // 冻结时钟：2026-11-05 14:00 本地时（美东，DST 回退 11-01 之后）
    'const FIXED = new Date(2026, 10, 5, 14, 0, 0).getTime();',
    'const RealDate = Date;',
    'class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [FIXED])); } static now() { return FIXED; } }',
    'const ctx = vm.createContext({ L: (zh) => zh, Date: FakeDate, Math, JSON, isFinite, parseInt, parseFloat, Object, Array, String, Number });',
    'vm.runInContext(bands + "\\n" + helpers + "\\n" + core, ctx);',
    'const out = { tz: process.env.TZ };',
    // DST 前提自检：2026-11-01 美东回退日 = 25h；平台无 TZdb 则 hasDST=false 由父进程 skip
    'out.dayLenNov1 = new Date(2026, 10, 2).getTime() - new Date(2026, 10, 1).getTime();',
    'out.hasDST = out.dayLenNov1 === 25 * 3600000;',
    'if (out.hasDST) {',
    '  // ① sd 日行：start=10-30 起连续 7 天（跨回退日 11-01），t0 必须逐一等于本地日历零点',
    '  const start = new Date(2026, 9, 30).getTime();',
    '  const days = []; for (let i = 0; i < 7; i++) days.push([100, 1000, 1, 1, 0, []]);',
    '  ctx.__sd = { v: 1, source: "local", start, days, mnames: ["M"], mkeys: ["k\\u001fm"], truncated: 0 };',
    '  const u = vm.runInContext("spd3UnpackDays(__sd)", ctx);',
    '  out.dayT0s = u.rows.map(r => r.t0);',
    '  out.expectT0s = []; for (let i = 0; i < 7; i++) out.expectT0s.push(new Date(2026, 9, 30 + i).getTime());',
    '  out.dayTDeltas = []; for (let i = 0; i < 6; i++) out.dayTDeltas.push(u.rows[i + 1].t0 - u.rows[i].t0);',
    '  // ② 合并接缝：sd 覆盖 10-30..11-04（end=11-05 日历零点）；11-04 23:30 轮在覆盖内',
    '  //    （其值已计入日行，再并入即双重计数）；11-05 09:00 轮 >= end 正常并入',
    '  const tIn = new Date(2026, 10, 4, 23, 30).getTime();',
    '  const tAfter = new Date(2026, 10, 5, 9).getTime();',
    '  ctx.__h2 = { sid: "s2", source: "local", truncated: false, sids: ["s2"], snames: ["S2"],',
    '    pids: [["p", "P"]], mnames: ["M"], mkeys: ["k\\u001fm"],',
    '    turns: [ { s: 0, t: tIn, b: tIn - 60000, out: 100, ms: 1000, i: 1, o: 100, n: 1, msl: [[0, 100, 1000, 1]] },',
    '             { s: 0, t: tAfter - tIn, b: tAfter - 60000, out: 100, ms: 1000, i: 1, o: 100, n: 1, msl: [[0, 100, 1000, 1]] } ] };',
    '  const days2 = []; for (let i = 0; i < 6; i++) days2.push([100, 1000, 1, 1, 0, []]);',
    '  ctx.__sd2 = { v: 1, source: "local", start, days: days2, mnames: ["M"], mkeys: ["k\\u001fm"], truncated: 0 };',
    '  const an = vm.runInContext("spd3Analyze(__h2, __sd2, {range:\\"all\\", period:\\"all\\", sid:\\"\\"})", ctx);',
    '  out.mergePool = an.pool.length;',
    '  out.mergeTurns = an.overall ? an.overall.turns : -1;',
    '  out.mergeOut = an.overall ? an.overall.out : -1;',
    '  out.mergeEnd = vm.runInContext("spd3UnpackDays(__sd2).end", ctx);',
    '  out.expectEnd = new Date(2026, 10, 5).getTime();',
    '  // ③ week 窗日历化：weekStart=今天-6 个本地日（10-30 日历零点）——10-30 00:30 的轮',
    '  //    必须入窗（固定毫秒差在回退周会把它切掉），10-29 23:30 的轮必须出窗',
    '  const calOct30 = new Date(2026, 9, 30).getTime();',
    '  const tA = calOct30 + 30 * 60000, tB = calOct30 - 30 * 60000;',
    '  ctx.__h3 = { sid: "s3", source: "local", truncated: false, sids: ["s3"], snames: ["S3"],',
    '    pids: [["p", "P"]], mnames: ["M"], mkeys: ["k\\u001fm"],',
    '    turns: [ { s: 0, t: tB, b: tB - 60000, out: 100, ms: 1000, i: 1, o: 100, n: 1, msl: [[0, 100, 1000, 1]] },',
    '             { s: 0, t: tA - tB, b: tA - 60000, out: 200, ms: 2000, i: 1, o: 200, n: 1, msl: [[0, 200, 2000, 1]] } ] };',
    '  const wk = vm.runInContext("spd3Analyze(__h3, null, {range:\\"all\\", period:\\"week\\", sid:\\"\\"})", ctx);',
    '  out.wkItems = wk.items.length;',
    '  out.wkLabel = wk.items.length ? wk.items[0].label : null;',
    '  out.wkKey = wk.items.length ? wk.items[0].a : null;',
    '  out.expectWkKey = calOct30;',
    '  out.wkPool = wk.pool.length;',
    '}',
    'console.log(JSON.stringify(out));',
  ].join('\n');
  const res = spawnSync(process.execPath, ['-e', childSrc], { encoding: 'utf8',
    env: { ...process.env, TZ: 'America/New_York' }, timeout: 30000 });
  if (res.error || res.status !== 0) {
    if (res.error && res.error.code === 'ETIMEDOUT') t.skip('TZ 子进程超时（平台调度异常）');
    else assert.fail('TZ 子进程失败: ' + (res.stderr || res.error));
    return;
  }
  const out = JSON.parse(res.stdout.trim().split('\n').pop());
  if (!out.hasDST) {
    t.skip('平台缺 America/New_York 时区库或 2026-11-01 非 25h 日（无 DST 可验）');
    return;
  }
  // ① 日行 t0 = 本地日历零点（回退日 11-01 步长 25h，固定 864e5 会从 11-02 起漂 -1h 累计）
  assert.deepEqual(out.dayT0s, out.expectT0s, 'sd 每日 t0 恒本地日历零点');
  assert.equal(out.dayTDeltas.filter(d => d === 25 * 3600000).length, 1, '回退日步长 25h（日历推进证据）');
  assert.equal(out.dayTDeltas.filter(d => d === 24 * 3600000).length, 5, '其余日步长 24h');
  // ② 接缝 = 覆盖末日次日日历零点；覆盖末日内 23:30 轮不双计（池=6 日行+1 轮行）
  assert.equal(out.mergeEnd, out.expectEnd, 'end=覆盖末日次日日历零点（非固定 864e5 漂移值）');
  assert.equal(out.mergePool, 7, '23:30 覆盖内晚轮不并入（6 日行 + 11-05 轮）');
  assert.equal(out.mergeTurns, 7, 'turns 无双重计数');
  assert.equal(out.mergeOut, 700, 'out 无双重计数（6×100 日行 + 100 轮行）');
  // ③ week 窗含 10-30 00:30 轮、不含 10-29 23:30 轮（weekStart 日历化）
  assert.equal(out.wkItems, 1, 'week 池只含 10-30 的轮（回退周固定毫秒差会把它切掉）');
  assert.equal(out.wkLabel, '10/30');
  assert.equal(out.wkKey, out.expectWkKey, '日桶键=10-30 日历零点');
  assert.equal(out.wkPool, 1);
});

// ---------- 打平形态（C）：zusage 生产端 speed_days msl 已改打平五元组序列 ----------
// 嵌套（旧）与打平（新，[mIdx,out,ms,n,tn] × N 连续排列，Array.isArray(msl[0])===false）
// 必须解出逐字段一致的模型分量。当前 spd3UnpackDaysRaw 只按嵌套条目迭代（打平元素被
// spd3ModelOf 按数字入参整条拒绝 → models 静默丢失），src 已补逐元素嗅探（数组=嵌套
// 步长 1 / 数字=打平步长 5，残缺尾丢弃），skip 解除转实（v384 收口）。
test('speed_days msl 双形态: 打平五元组与嵌套条目解包逐字段一致（含 wire 端 perModel）', () => {
  const ctx = makeCtx();
  const start = new Date(2026, 10, 4).getTime();
  const base = { v: 1, source: 'local', start, truncated: 0,
    mnames: ['GLM-A', 'Claude-B'], mkeys: [KEYS.a, KEYS.b] };
  const flatSd = Object.assign({}, base, { days: [
    [1000, 10000, 3, 2, 0, [0, 600, 7000, 2, 1, 1, 400, 3000, 1, 1]],
    [500, 5000, 1, 1, 0, [0, 500, 5000, 1, 1]] ] });
  const nestedSd = Object.assign({}, base, { days: [
    [1000, 10000, 3, 2, 0, [[0, 600, 7000, 2, 1], [1, 400, 3000, 1, 1]]],
    [500, 5000, 1, 1, 0, [[0, 500, 5000, 1, 1]]] ] });
  ctx.__flat = flatSd;
  ctx.__nest = nestedSd;
  const uf = vm.runInContext('spd3UnpackDays(__flat)', ctx);
  const un = vm.runInContext('spd3UnpackDays(__nest)', ctx);
  assert.deepEqual(host(uf.rows[0].models), host(un.rows[0].models),
    '打平五元组与嵌套条目解出同模型分量（key/out/ms/n/tn 逐字段一致）');
  assert.equal(uf.rows[0].msAvail, true);
  // wire 端：两形态 all 热力 perModel/dots 同产物
  const anF = vm.runInContext('spd3Analyze(null, __flat, {range:"all", period:"all", sid:""})', ctx);
  const anN = vm.runInContext('spd3Analyze(null, __nest, {range:"all", period:"all", sid:""})', ctx);
  assert.deepEqual(host(anF.perModel), host(anN.perModel), '打平形态 perModel 与嵌套一致');
  /* daysGrid 仅 month 期产出（spec §4）：双形态各跑一次 month 对比日格模型数 */
  const anFM = vm.runInContext('spd3Analyze(null, __flat, {range:"all", period:"month", sid:""})', ctx);
  const anNM = vm.runInContext('spd3Analyze(null, __nest, {range:"all", period:"month", sid:""})', ctx);
  assert.deepEqual(host(anFM.daysGrid.map(d => d.agg && d.agg.modelCount)),
    host(anNM.daysGrid.map(d => d.agg && d.agg.modelCount)), '打平形态 daysGrid 模型数与嵌套一致');
});

// ---------- ⑮ 性能基线（spec §8：6000 轮任意 20 组合重算 ≤8ms 为目标量级） ----------
test('6000 轮 20 组合重算性能基线（打印实测，宽上界防 CI 抖动）', () => {
  const ctx = makeCtx();
  const N = 6000;
  const t0 = new Date(2026, 10, 5, 9).getTime() - N * 60000;
  let prev = 0;
  const turns = [];
  for (let i = 0; i < N; i++) {
    const abs = t0 + i * 60000;
    turns.push({ s: i % 3, t: abs - prev, b: abs - 30000, out: 300, ms: 1000 + (i % 5) * 500,
      i: 800, o: 300, n: 1, msl: [[i % 3, 300, 1000 + (i % 5) * 500, 1]] });
    prev = abs;
  }
  ctx.__big = { sid: 's0', source: 'local', truncated: true,
    sids: ['s0', 's1', 's2'], snames: ['a', 'b', 'c'],
    pids: [['p0', 'P0'], ['p0', 'P0'], ['p1', 'P1']],
    mnames: ['m0', 'm1', 'm2'], mkeys: ['x\x1fm0', 'x\x1fm1', 'x\x1fm2'], turns };
  let worst = 0, worstCombo = '', total = 0;
  for (const range of ['recent', 'session', 'project', 'all']) {
    for (const period of ['recent', 'today', 'week', 'month', 'all']) {
      ctx.__bs = { range, period, sid: 's0' };
      vm.runInContext('spd3Analyze(__big, null, __bs)', ctx);   // 预热（JIT + 解包缓存）
      const t1 = process.hrtime.bigint();
      vm.runInContext('spd3Analyze(__big, null, __bs)', ctx);
      const ms = Number(process.hrtime.bigint() - t1) / 1e6;
      total += ms;
      if (ms > worst) { worst = ms; worstCombo = range + '×' + period; }
    }
  }
  console.log('    [perf] 6000 轮 20 组合 avg=' + (total / 20).toFixed(2) +
    'ms worst=' + worst.toFixed(2) + 'ms (' + worstCombo + ')');
  assert.ok(worst < 200, '最重组合也须远低于一次悬停重编预算，实测 ' + worst.toFixed(2) + 'ms');
});

// ---------- v387 MINOR-4：进行日/时桶 b 钳 now（hover 不显未来区间） ----------
test('v387 进行桶钳 now: today 最后一小时 item.b=now 而非下一整点；已过桶不受影响', () => {
  const ctx = makeCtx();
  // FakeDate 冻结 2026-11-05 14:00 本地（FIXED_NOW）；today 桶 00..14，末桶下一整点=15:00 > now
  const base = new Date(2026, 10, 5, 9, 30).getTime();
  const h = { sid: 's0', source: 'local', truncated: false,
    sids: ['s0'], snames: ['a'], pids: [['p0', 'P0']],
    mnames: ['m0'], mkeys: ['p\x1fm0'],
    turns: [{ s: 0, t: base, b: base - 20000, out: 300, ms: 1000, i: 100, o: 300, n: 1,
      msl: [[0, 300, 1000, 1]] }] };
  // focus:"full"=完整 00..当前小时轴；默认聚焦形态 realKeys 只含 9 点桶（同样受钳）
  const an = analyze(ctx, h, null, { range: 'session', period: 'today', sid: 's0', focus: 'full' });
  assert.ok(an && an.items.length === 15, 'today 全轴 15 桶（00..14 时）');
  const last = an.items[an.items.length - 1];
  assert.equal(last.b, FIXED_NOW, '进行中小时桶（14 时）b 钳到 now 而非 15:00');
  assert.ok(!/15:00:00/.test(last.full), 'full 区间不含下一整点');
  for (const it of an.items) assert.ok(it.b <= FIXED_NOW, '所有桶 b ≤ now');
  const anF = analyze(ctx, h, null, { range: 'session', period: 'today', sid: 's0' });
  assert.equal(anF.items[anF.items.length - 1].b, new Date(2026, 10, 5, 10).getTime(),
    '聚焦形态末桶（9 时）b=10:00（钳后桶末）');
});

// ---------- v389 §13.4 axisA/axisB：未筛选池时间轴（heat 形态判定消费） ----------
test('v389 §13.4 axisA/axisB: 未筛选池时间轴在场——全池 10 天/筛选后 2 天，axisA/axisB 恒=全池首末日、spanA/spanB 仍=筛选后展示轴；unfiltered 两轴重合', () => {
  const ctx = makeCtx();
  // A 模型 10-27..11-05 每天一轮（全池覆盖 10 天）；B 模型只 11-04/11-05 各一轮（2 天）
  const raw = [];
  for (let i = 0; i < 10; i++) {
    const at = new Date(2026, 9, 27 + i, 10).getTime();
    raw.push([0, at, at - 60000, 200, 2000, 100, 200, 1, [[0, 200, 2000, 1]], 0.01, 1]);
  }
  for (const dd of [4, 5]) {
    const at = new Date(2026, 10, dd, 11).getTime();
    raw.push([0, at, at - 60000, 100, 1000, 50, 100, 1, [[1, 100, 1000, 1]], 0.01, 1]);
  }
  raw.sort((x, y) => x[1] - y[1]);
  let prev = 0;
  const turns = raw.map(r => {
    const o = { s: r[0], t: r[1] - prev, b: r[2], out: r[3], ms: r[4], i: r[5], o: r[6], n: r[7], msl: r[8] };
    prev = r[1];
    o.c = r[9]; o.cf = 1;
    return o;
  });
  const h = { sid: 's', source: 'local', truncated: false, sids: ['s'], snames: ['S'],
    pids: [['p', 'P']], mnames: ['GLM-A', 'Claude-B'], mkeys: [KEYS.a, KEYS.b], turns };
  const firstB = new Date(2026, 9, 27, 9, 59).getTime();   // 全池首轮 b（10-27 09:59）
  const lastT = new Date(2026, 10, 5, 11).getTime();       // 全池末轮 t（11-05 11:00，B）
  // 筛选只看 B：展示轴收缩到 2 天，未筛选时间轴保持全池 10 天跨度
  const anB = analyze(ctx, h, null, { range: 'all', period: 'all', sid: 's',
    filt: { mode: 'sel', keys: [KEYS.b] } });
  assert.equal(anB.pool.length, 2, '筛选后池=2 行（B 的两轮）');
  assert.equal(anB.axisA, firstB, 'axisA=未筛选池首轮 b（10-27，筛选不收缩时间轴）');
  assert.equal(anB.axisB, lastT, 'axisB=未筛选池末轮 t（11-05）');
  assert.equal(anB.spanA, new Date(2026, 10, 4, 10, 59).getTime(), 'spanA=筛选后展示轴首日（11-04）');
  assert.equal(anB.spanB, new Date(2026, 10, 5, 11).getTime(), 'spanB=筛选后展示轴末轮');
  assert.ok(anB.axisA < anB.spanA, 'axisA 严格早于收缩后的 spanA（覆盖判定不随筛选跳变的输入前提）');
  // 无筛选：两轴重合（未筛选池自身）
  const anAll = analyze(ctx, h, null, { range: 'all', period: 'all', sid: 's' });
  assert.equal(anAll.axisA, firstB, '无筛选时 axisA=池首日');
  assert.equal(anAll.axisB, lastT, '无筛选时 axisB=池末日');
  assert.equal(anAll.spanA, anAll.axisA, 'auto 池 spanA 与 axisA 重合');
  // 显式空筛选（清空）：池清空但未筛选时间轴仍在（形态判定仍有稳定输入）
  const anEmpty = analyze(ctx, h, null, { range: 'all', period: 'all', sid: 's',
    filt: { mode: 'sel', keys: [] } });
  assert.equal(anEmpty.axisA, firstB, '空筛选 axisA 仍=全池首日');
  assert.equal(anEmpty.axisB, lastT, '空筛选 axisB 仍=全池末日');
});
