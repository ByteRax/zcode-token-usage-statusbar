const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

// v232 速度 tooltip 柱状图（v240 现役 10 段）：切片夹具沿 overlay-tooltip-span 同款
// （bandHelpers 含 TPS_BANDS/tpsBand/speedCardHTML/speedChartHTML/speedSegsOf，
// helpers 含 html() 的 DB 回退速度卡路径）。悬停状态种子对应实例闭包初值。
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
const helpers = source.slice(source.indexOf('    function fmtStart('), source.indexOf('    function ioc(')) +
  source.slice(source.indexOf('    function ttEsc('), source.indexOf('    function stubFor('));
const bandHelpers = source.slice(source.indexOf('  var TPS_BANDS = ['), source.indexOf('  /* 返回 null = 调用方应把这当成'));

function makeCtx(lang = 'zh') {
  return vm.createContext({
    state: { lang, cost: 1, show: { turn: true, win: true, today: true } },
    L: (zh, en) => lang === 'en' ? en : zh,
    fmt: v => String(v || 0), countFmt: v => String(v || 0), sec: v => String(v || 0),
    cachePct: () => '', shrink: false, liveStatsCur: null, bridge: { handle: null },
    subRate: { rate: null, at: 0 },
    zuBarSpeedView: v => v, zuIcoThinking: () => '<svg/>',
    lastView: { last: { tps: 102.2 } },
    speedChartHover: -1, speedTipSess: '', speedTipRebuild: null,
    FXQ_ICON: '<svg class="tip-fxq"></svg>',
  });
}

function render(data, lang = 'zh') {
  const context = makeCtx(lang);
  vm.runInContext(bandHelpers, context);
  vm.runInContext(helpers, context);
  return context.html(data).tips.filter(Boolean);
}

function speedTip(tips) { return tips.find(t => t.includes('zu-stat-tip--speed')); }
function chartOf(tip) {
  const i = tip.indexOf('zu-speed-chart'), j = tip.indexOf('zu-legend-row');
  if (i < 0 || j < 0 || j <= i) throw new Error('chart/zu-legend-row 标记缺失，图例结构回归会污染切片');
  return tip.slice(i, j);
}

// 20 段真实形态：2026-11-03 13:40 起，每分钟一段，速度 100+i*2（…132…138）
function segs(n, base = 100, stepMs = 60000) {
  const t0 = new Date(2026, 10, 3, 13, 40).getTime();
  return Array.from({ length: n }, (_, i) => ({ v: base + i * 2, t: t0 + i * stepMs }));
}

function fixture(speedSegs) {
  const t0 = new Date(2026, 10, 3, 13, 40).getTime();
  const data = {
    session: { sid: 'sid_main', started: t0, last_at: t0 + 19 * 60000, avg_tps: 130.3 },
    last: { tps: 102.2, startedAt: t0, endedAt: t0 + 60000 },
    last_turn: { requests: 2, output: 452, duration_ms: 16173, tps: 102.2, unrated_output: 11, started: t0, ended: t0 + 60000 },
    today: { started: t0, last_at: t0 + 19 * 60000 },
  };
  if (speedSegs !== undefined) data.session.speed_segs = speedSegs;
  return data;
}

test('14 segments render as 14 bars with one-decimal top labels and latest highlighted', () => {
  const tip = speedTip(render(fixture(segs(17))));
  assert.ok(tip, 'speed tip renders');
  const chart = chartOf(tip);
  assert.match(chart, /最近 10 段/);
  assert.match(chart, /按完成顺序 · 从旧到新/);
  assert.match(chart, /单位：t\/s/);
  assert.equal((chart.match(/class="zu-sc-col/g) || []).length, 10, '柱数=10');
  const vals = chart.match(/class="zu-sc-val[^"]*">(\d+\.\d)</g) || [];
  assert.equal(vals.length, 10, '每柱一枚柱顶读数');
  assert.doesNotMatch(chart, /zu-sc-val[^"]*">\d+\.\d\d/, '读数恒一位小数（全文契约）');
  // 最新段：latest 描边 + 加粗读数；v240：默认不渲染信息卡（仅悬停/聚焦才显示）
  assert.match(chart, /zu-sc-col latest"/);
  assert.doesNotMatch(chart, /zu-sc-card|zu-sc-col[^"]* cur"/);
  assert.match(chart, /zu-sc-val latest">132\.0</);
  assert.doesNotMatch(chart, /zu-sc-lead|zu-sc-card/, 'v240 未悬停无引线无卡');
  // 柱高与 Y 轴：maxV=132 → 阶梯刻度 yMax=200，最高柱 66%；顶档刻度数字挂线内侧
  assert.match(chart, /zu-sc-bar ok" style="height:66%/);
  assert.match(chart, /<i style="bottom:0%" data-base="1"><\/i>/);
  assert.match(chart, /<i class="top" style="bottom:calc\(100% - 13px\)">200<\/i>/);
  // 柱顶读数不带单位；可见 t/s 仅表头「单位：t/s」（v240 默认无信息卡），aria-label 里的 t/s 不计
  assert.equal((chart.replace(/aria-label="[^"]*"/g, "").match(/t\/s/g) || []).length, 1);
});

test('x axis shows MM-DD HH:mm labels from real completion times, first and last kept', () => {
  const tip = speedTip(render(fixture(segs(17))));
  const chart = chartOf(tip);
  // v240：10 柱 pitch≈50 > 阈值 44 → 全部 10 个两行标签；首标签=第 1 段 13:47、末标签=第 10 段 13:56
  assert.equal((chart.match(/<b>11-03<\/b>/g) || []).length, 10);
  assert.match(chart, /<b>11-03<\/b><b>13:47<\/b>/);
  assert.match(chart, /<b>11-03<\/b><b>13:56<\/b>/);
  assert.doesNotMatch(chart, /2026/);            // 不显示年份
  assert.doesNotMatch(chart, /\d\d:\d\d:\d\d/);  // 不显示秒
});

test('cap at 10 keeps the most recent segments in completion order', () => {
  const tip = speedTip(render(fixture(segs(25))));
  const chart = chartOf(tip);
  assert.equal((chart.match(/class="zu-sc-col/g) || []).length, 10);
  // 最旧 15 段被滚出：第 1 柱 = 原第 16 段（v=130，13:55）
  assert.match(chart, /aria-label="第 1 段，130\.0 t\/s，11-03 13:55/);
  assert.doesNotMatch(chart, /100\.0/);
});

test('invalid readings are dropped and identical segments deduped', () => {
  const raw = [
    { v: 100, t: new Date(2026, 10, 3, 13, 40).getTime() },
    { v: NaN, t: new Date(2026, 10, 3, 13, 41).getTime() },   // NaN 不进
    { v: -5, t: new Date(2026, 10, 3, 13, 42).getTime() },    // 负数不进
    { v: 0, t: new Date(2026, 10, 3, 13, 43).getTime() },     // 零不进
    { v: 120 },                                                // 缺完成时间不进
    { v: 'x', t: new Date(2026, 10, 3, 13, 44).getTime() },    // 非数字不进
    { v: 130, t: new Date(2026, 10, 3, 13, 45).getTime() },    // 有效
    { v: 130, t: new Date(2026, 10, 3, 13, 45).getTime() },    // 同刻同值去重
    { v: 140, t: new Date(2026, 10, 3, 13, 46).getTime() },    // 有效
  ];
  const tip = speedTip(render(fixture(raw)));
  const chart = chartOf(tip);
  assert.match(chart, /最近 3 段/);
  assert.equal((chart.match(/class="zu-sc-col/g) || []).length, 3);
  assert.match(chart, /aria-label="第 1 段，100\.0 t\/s，11-03 13:40/);
  assert.match(chart, /aria-label="第 2 段，130\.0 t\/s，11-03 13:45/);
  assert.match(chart, /aria-label="第 3 段，140\.0 t\/s，11-03 13:46/);
});

test('4-digit readings switch to horizontal-scroll wide mode with ultra band bar', () => {
  const raw = segs(4, 2500, 60000).map((s, i) => ({ v: 2500 + i * 100, t: s.t }));
  const tip = speedTip(render(fixture(raw)));
  const chart = chartOf(tip);
  assert.match(chart, /zu-sc-wrap wide/, '≥1000 t/s 读数 6 字符 → 横滚保读数不叠');
  assert.match(chart, /zu-sc-bar zu-ultra/);
  assert.match(chart, /zu-sc-val[^"]*">2500\.0</);
  assert.match(chart, /aria-label="[^"]*Ultra · ≥2000/);
});

test('band classes follow the raw value per bar (unrounded), incl. ultra gradient bar', () => {
  const t = new Date(2026, 10, 3, 13, 40).getTime();
  const raw = [{ v: 30.04, t }, { v: 45.04, t: t + 60000 }, { v: 100.04, t: t + 120000 }, { v: 250.04, t: t + 180000 }];
  const chart = chartOf(speedTip(render(fixture(raw))));
  assert.match(chart, /zu-sc-bar hot" style="height:/);    // <40 低速红
  assert.match(chart, /zu-sc-bar warm" style="height:/);   // 40–70 一般黄
  assert.match(chart, /zu-sc-bar ok" style="height:/);     // 70–150 流畅绿
  assert.match(chart, /zu-sc-bar zu-sky" style="height:/); // 200–300 快速
  // 档位按原始值判断：30.04 显示 "30.0" 仍落 <40 档（不是四舍五入后再分档）
  assert.match(chart, /aria-label="第 1 段，30\.0 t\/s[^]*?低速/);
});

test('old snapshots without speed_segs keep the structured hero without chart', () => {
  for (const empty of [undefined, []]) {
    const tip = speedTip(render(fixture(empty)));
    assert.ok(tip);
    assert.doesNotMatch(tip, /zu-speed-chart/);
    assert.match(tip, /zu-speed-hero/);
    // v235：fallback 走结构化左卡（生成完成 + 数值 + 来源说明），无图表不画柱
    assert.match(tip, /zu-sl-status"><svg class="ico ok"[^]*?<span class="zu-sl-title ok">生成完成<\/span>/);
    assert.match(tip, /zu-sl-val ok">130\.3</);
    assert.match(tip, /zu-sl-note">会话加权平均</);
  }
});

test('chart layout swaps in leftNote caption and drops the redundant sub KPI', () => {
  const tip = speedTip(render(fixture(segs(6))));
  assert.match(tip, /zu-speed-body/);
  assert.match(tip, /zu-speed-left/);
  assert.match(tip, /zu-sl-note">会话加权平均</);   // v235：leftNote 由结构化 noteText 承接
  assert.match(tip, /最近 6 段/);
  assert.doesNotMatch(tip, /zu-speed-sub/);   // 最近一段读数由最新柱承载
  // 统计口径与刷新说明
  assert.match(tip, /最近 10 段：每个已完成有效分段的真实速度/);
  assert.doesNotMatch(tip, /柱顶数字保留一位小数/);   // v239：设计图口径无此句
  assert.doesNotMatch(tip, /每段完成后更新/);   // v233 删该脚注
  // v241/v242 左卡与结构契约
  assert.match(tip, /<small class="zu-sl-pre">均<\/small><span class="zu-sl-val ok">130\.3</);
  assert.match(tip, /<i>峰值<\/i><b class="ok">110\.0<\/b><\/span><span class="zu-sl-stat"><i>最低<\/i><b class="ok">100\.0<\/b><\/span><span class="zu-sl-stat"><i>最新<\/i><b class="ok">110\.0<\/b>/);
  assert.match(tip, /<div class="zu-legend-row"><div class="zu-legend-title">颜色对照<\/div>/);
  assert.equal((tip.match(/zu-pj-time/g) || []).length, 1, '时间范围仅嵌入 zu-basis 一处');
  assert.doesNotMatch(tip, /每段完成后刷新/, '带图不渲染脚注');
});

test('hover index is baked into the string and the fallback tip is rebuildable', () => {
  const context = makeCtx('zh');
  vm.runInContext(bandHelpers, context);
  vm.runInContext(helpers, context);
  context.html(fixture(segs(6)));
  // v240：默认未悬停 → 无 cur、无信息卡；悬停后 cur 编进串
  let tip = vm.runInContext('speedTipRebuild()', context);
  assert.doesNotMatch(chartOf(tip), /zu-sc-col[^"]* cur"|zu-sc-card/);
  // 悬停第 3 根（下标 2）→ cur 迁移、信息卡切第 3 段
  context.speedChartHover = 2;
  tip = vm.runInContext('speedTipRebuild()', context);
  const chart = chartOf(tip);
  assert.equal((chart.match(/zu-sc-col cur"/g) || []).length, 1, 'cur 唯一');
  assert.match(chart, /class="zu-sc-col cur" role="img" tabindex="0" data-i="2"/);
  assert.match(chart, /第 3 段 · 11-03 13:42/);
  assert.match(chart, /104\.0/);
  assert.doesNotMatch(chart, /zu-sc-col latest cur"/);
});

test('info card renders only while hovering/focusing a bar (v236)', () => {
  const tip = speedTip(render(fixture(segs(6))));
  assert.doesNotMatch(chartOf(tip), /zu-sc-card|zu-sc-col[^"]* cur"/);   // v240：默认无信息卡、无 cur
  assert.match(tip, /zu-sc-col latest"/);
  // 悬停第 6 根（下标 5）→ 信息卡出现且切到该段
  const ctx2 = makeCtx('zh');
  vm.runInContext(bandHelpers, ctx2);
  vm.runInContext(helpers, ctx2);
  ctx2.html(fixture(segs(6)));
  ctx2.speedChartHover = 5;
  const hovered = vm.runInContext('speedTipRebuild()', ctx2);
  assert.match(hovered, /zu-sc-card-k">第 6 段 · 11-03 13:45/);
  assert.match(hovered, /zu-sc-card-v ok">110\.0 t\/s<i>（最新）<\/i></, '悬停最新段带（最新）角标');
  ctx2.speedChartHover = 2;   // 非最新段：角标让位档位名
  const hovered2 = vm.runInContext('speedTipRebuild()', ctx2);
  assert.match(hovered2, /zu-sc-card-v ok">104\.0 t\/s<i>流畅<\/i></);
  // 信息卡不拦截指针（pointer-events:none 是 CSS 契约，VM 只能锁源码规则存在）
  assert.match(source, /\.zu-sc-card\{[^}]*pointer-events:none/);
  // 柱体可键盘聚焦，aria-label 携带段号/读数/时间/档位
  assert.match(tip, /tabindex="0" data-i="0" aria-label="第 1 段，100\.0 t\/s，11-03 13:40[^]*?流畅/);
});

test('bilingual labels follow the instance language', () => {
  const tip = speedTip(render(fixture(segs(17)), 'en'));
  const chart = chartOf(tip);
  assert.match(chart, /Last 10/);
  assert.match(chart, /completion order · old → new/);
  assert.match(chart, /unit: t\/s/);
  assert.match(tip, /Weighted average/);
  assert.match(chart, /aria-label="Seg 1，114.0 t\/s，11-03 13:47[^]*?Smooth/);
});

test('speed_segs from the session row reach the chart through the full fallback path', () => {
  const data = fixture(segs(3));
  data.session.avg_tps = 0;   // 无会话均：主读数回退最近一段，图表照常
  const tip = speedTip(render(data));
  assert.match(tip, /zu-speed-chart/);
  assert.match(tip, /最近 3 段/);
  assert.match(tip, /zu-sl-val ok">102\.2<\/span><small class="zu-sl-unit">t\/s<\/small>/);
  assert.match(tip, /zu-sl-note">最近一段 · 实际值</);   // v235：noteText 随主读数口径切换
});

test('speedCardHTML contract: width cap widened to 860px for the chart era', () => {
  const ctx = makeCtx('zh');
  vm.runInContext(bandHelpers, ctx);
  const card = vm.runInContext('speedCardHTML({ scope: "x", main: "1", basisText: [] })', ctx);
  assert.match(card, /max-width:min\(860px,calc\(100vw - 24px\)\)!important/);
});

// v241/v242 八态左卡：标题行/前缀/胶囊/说明行按设计图（状态机字段直喂，不经 zuBarSpeedView）
test('left card renders the eight states per the design (titles, prefixes, pills, notes)', () => {
  const ctx = makeCtx('zh');
  vm.runInContext(bandHelpers, ctx);
  const card = st => vm.runInContext('speedCardHTML({ scope: "x", status: ' + JSON.stringify(st) + ', basisText: [] })', ctx);
  const ok = { cls: 'ok', lo: 70, hi: 150, zh: '流畅', en: 'Smooth' };
  // 工具：标题=动词+title 兜底；计时主读数
  assert.match(card({ kind: 'tool', statusText: '工具执行中', nameText: '写入中', elapsedText: '4.3s', noteText: '工具 · 正在执行' }),
    /title="写入中">写入中<\/span>.*zu-sl-val">4\.3s/s);
  // 工具组：标题=nameText+·执行中（无空格）
  assert.match(card({ kind: 'toolgroup', statusText: '工具组执行中', nameText: '查阅', elapsedText: '12.3s', noteText: '工具组 · 正在执行' }),
    /class="zu-sl-title">查阅·执行中<\/span>/);
  // Skill：两行省略类 + title=全名·执行中
  const sk = card({ kind: 'skill', statusText: 'Skill 执行中', nameText: 'zcode-github-rel…', nameFull: 'zcode-github-release', elapsedText: '5.2s', noteText: 'Skill · 正在执行' });
  assert.match(sk, /zu-sl-status--wrap/);
  assert.match(sk, /title="zcode-github-release·执行中"/);
  // 思考：标题=statusText+...；计时
  assert.match(card({ kind: 'thinking', statusText: '思考中', elapsedText: '47秒', noteText: '生成尚未开始' }), /<span class="zu-sl-title">思考中\.\.\.<\/span>/);
  // 子代理：×N 徽标 + 「估」前缀 + dim 数值；无速率时 estdim
  const sa = card({ kind: 'subagent', statusText: '子代理运行中', activeCount: 2, speedValue: 268.1, speedIsEstimated: true, noteText: '2 个子代理合计（估算）' });
  assert.match(sa, /zu-sl-count">×2</);
  assert.match(sa, /<small class="zu-sl-pre">估<\/small><span class="zu-sl-val dim">268\.1</);
  assert.match(card({ kind: 'subagent', statusText: '子代理运行中', activeCount: 1, speedValue: null }),
    /zu-sl-estdim">估算中…</);
  // 估算：档位色标题/数值 + 胶囊
  const est = card({ kind: 'estimate', statusText: '生成中（估算）', speedValue: 268.1, band: ok, noteText: '按进度估算' });
  assert.match(est, /class="zu-sl-title ok"/);
  assert.match(est, /zu-speed-bandtag/);
  // 会话均：「均」前缀 + 胶囊
  assert.match(card({ kind: 'avg', statusText: '生成完成', speedValue: 127.6, band: ok, noteText: '会话加权平均' }),
    /zu-sl-pre">均<\/small>.*zu-speed-bandtag/s);
  // real：数值档位色但无胶囊（v242）
  const re = card({ kind: 'real', statusText: '生成完成', speedValue: 152.7, band: ok, noteText: '本轮实际速度' });
  assert.match(re, /zu-sl-val ok">152\.7</);
  assert.doesNotMatch(re, /zu-speed-bandtag/);
  // 无有效数值：不挂「当前读数」空标签（v242 守卫）
  assert.doesNotMatch(card({ kind: 'avg', statusText: '生成完成', speedValue: 0, band: ok }), /zu-sl-k/);
});

// v233 估宽分级：数字读数不加类；中文估算词 fit2；「子代理运行中 ×2 · …」长状态词 fit3
test('speedCardHTML tiers the main reading by estimated width (fit2/fit3)', () => {
  const ctx = makeCtx('zh');
  vm.runInContext(bandHelpers, ctx);
  const card = main => vm.runInContext('speedCardHTML({ scope: "x", main: ' + JSON.stringify(main) + ', basisText: [] })', ctx);
  assert.doesNotMatch(card('130.8'), /zu-speed-fit/, '数字读数保持默认单行大字');
  assert.doesNotMatch(card('估 268.1 t/s'), /zu-speed-fit/, '5.8em：250px 左卡大字单行（v235 阈值）');
  assert.match(card('思考中…1时2分10秒'), /zu-speed-main[^"]*zu-speed-fit2/);   // 9.0em
  assert.match(card('子代理运行中 ×2 · 估 268.1 t/s'), /zu-speed-main[^"]*zu-speed-fit3/);
});

test('single segment renders one bar that is both latest and cur with its label', () => {
  const tip = speedTip(render(fixture(segs(1))));
  const chart = chartOf(tip);
  assert.match(chart, /最近 1 段/);
  assert.equal((chart.match(/class="zu-sc-col/g) || []).length, 1);
  assert.match(chart, /zu-sc-col latest"/);   // 单柱=最新段（v240 未悬停无 cur）
  assert.match(chart, /aria-label="第 1 段，100\.0 t\/s，11-03 13:40/);
  assert.match(chart, /<b>11-03<\/b><b>13:40<\/b>/);   // xEvery=1：唯一柱带时间标签
});

test('speed_segs null behaves like missing field (no chart, legacy layout)', () => {
  const data = fixture(segs(6));
  data.session.speed_segs = null;
  const tip = speedTip(render(data));
  assert.doesNotMatch(tip, /zu-speed-chart/);
  assert.match(tip, /zu-speed-hero/);
  assert.match(tip, /zu-sl-status"><svg class="ico ok"[^]*?<span class="zu-sl-title ok">生成完成<\/span>/);
  assert.match(tip, /zu-sl-note">会话加权平均</);
});

// v232 桥态（buildLiveTip）图表分支：lastView.session.speed_segs 非空时 live 卡同带
// 图表、sub 右格让位、口径追加；切会话重置悬停；旧快照保留 v218「最近一段」右格。
test('buildLiveTip renders the chart from lastView.session.speed_segs and suppresses the sub KPI', () => {
  const blStart = source.indexOf('    function buildLiveTip(speedView) {');
  const blEnd = source.indexOf('      function escHtml(s)', blStart);
  const blClose = source.indexOf('\n    }', blEnd);
  assert.ok(blStart >= 0 && blEnd > blStart && blClose > blEnd, '提取失败: buildLiveTip');
  const sandbox = {
    L: (zh) => zh,
    lastView: { session: { sid: 'sa', speed_segs: segs(6) }, last: { tps: 110 } },
    speedChartHover: -1, speedTipSess: '', speedTipRebuild: null,
    speedSpan: (s, e) => s ? { start: 'S', end: e ? 'E' : '' } : null,
    Date,   // 图表 tParts 要 new Date(t)（子代理槽位空、freshness 不依赖 now 桩）
    subRate: { slots: {}, sum: { rate: null, at: 0, count: 0 } },
    zuIcoThinking: () => '<svg/>',
  };
  const buildTip = vm.runInNewContext(
    bandHelpers + '\n' + source.slice(blStart, blClose + 6) + '\nbuildLiveTip;', sandbox);
  const view = { cls: 'ok', text: '130.3 t/s', phase: null, band: null };
  const html = buildTip(view);
  assert.match(html, /zu-speed-chart/);
  assert.match(html, /最近 6 段/);
  assert.doesNotMatch(html, /zu-speed-sub/);   // sub 右格由最新柱承载（v218 行为仅旧快照保留）
  assert.match(html, /最近 10 段：每个已完成有效分段的真实速度/);
  assert.doesNotMatch(html, /每段完成后更新/);   // v233 删该脚注
  // 会话切换重置悬停：悬停第 3 根后 sid 变为 sb → 悬停回未悬停（v236：无信息卡、无 cur）
  sandbox.speedChartHover = 2;
  assert.match(buildTip(view), /zu-sc-card-k">第 3 段 · 11-03 13:42/);
  sandbox.lastView.session.sid = 'sb';
  const after = buildTip(view);
  assert.doesNotMatch(after, /zu-sc-card/);   // v240：悬停重置回未悬停（无信息卡）
  assert.match(after, /class="zu-sc-col latest" role="img" tabindex="0" data-i="5"/);
  assert.doesNotMatch(after, /class="zu-sc-col cur" role="img" tabindex="0" data-i="2"/);
  // 旧快照（session 无 speed_segs）：无图表且 v218「最近一段」右格保留
  sandbox.lastView = { session: { sid: 'sc' }, last: { tps: 110 } };
  const legacy = buildTip(view);
  assert.doesNotMatch(legacy, /zu-speed-chart/);
  assert.match(legacy, /最近一段/);
  assert.match(legacy, /zu-speed-sub">110 <small>t\/s<\/small>/);
  // v233 估宽分级：tool 相长状态词 → fit3；noUnit 链路不带 <small> 单位后缀
  const toolTip = buildTip({ cls: 'dim', text: '子代理运行中 ×2 · 估 268.1 t/s', phase: 'tool', band: null });
  assert.match(toolTip, /zu-speed-main[^"]*zu-speed-fit3/);
  assert.doesNotMatch(toolTip, /子代理运行中[^<]*<small>/);
});
