const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');
const { readOverlaySource, sliceOverlay, getNamedSlice } = require('./helpers/overlay-extract.cjs');

// v232 速度 tooltip 柱状图（v240 现役 10 段）：切片夹具沿 overlay-tooltip-span 同款
// （bandHelpers 含 TPS_BANDS/tpsBand/speedCardHTML/speedChartHTML/speedSegsOf，
// helpers 含 html() 的 DB 回退速度卡路径）。悬停状态种子对应实例闭包初值。
const source = readOverlaySource();
const helpers = sliceOverlay('    function fmtStart(', '    function ioc(') +
  sliceOverlay('    function ttEsc(', '    function stubFor(');
const bandHelpers = getNamedSlice('tpsBandsTable');

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

function render(data, lang = 'zh', hover = -1) {
  const context = makeCtx(lang);
  context.speedChartHover = hover;   // v232：html() 读写实例闭包的悬停态，切片按种子注入
  if (hover >= 0) context.speedTipSess = (data.session && data.session.sid) || 'sid_main';   // 会话归属守卫：不匹配会被重置回未悬停
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
  assert.match(chart, /最近 10 轮/);
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

test('x axis shows MM-DD HH:mm labels on every shown column, first and last kept', () => {
  const tip = speedTip(render(fixture(segs(17))));
  const chart = chartOf(tip);
  // v250（用户规格）：每个显示标签都带月日两行，不再同日去重
  assert.equal((chart.match(/<b>11-03<\/b>/g) || []).length, 10);
  assert.match(chart, /<b>11-03<\/b><b>13:47<\/b>/);
  assert.match(chart, /<span class="zu-sc-x"><b>11-03<\/b><b>13:56<\/b><\/span>/);
  assert.doesNotMatch(chart, /2026/);            // X 轴不显示年份（悬停卡除外）
});

test('cap at 10 keeps the most recent segments in completion order', () => {
  const tip = speedTip(render(fixture(segs(25))));
  const chart = chartOf(tip);
  assert.equal((chart.match(/class="zu-sc-col/g) || []).length, 10);
  // 最旧 15 轮被滚出：第 1 柱 = 原第 16 轮（v=130，13:55）
  assert.match(chart, /aria-label="第 1 轮，130\.0 t\/s，11-03 13:55/);
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
  assert.match(chart, /最近 3 轮/);
  assert.equal((chart.match(/class="zu-sc-col/g) || []).length, 3);
  assert.match(chart, /aria-label="第 1 轮，100\.0 t\/s，11-03 13:40/);
  assert.match(chart, /aria-label="第 2 轮，130\.0 t\/s，11-03 13:45/);
  assert.match(chart, /aria-label="第 3 轮，140\.0 t\/s，11-03 13:46/);
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
  assert.match(chart, /aria-label="第 1 轮，30\.0 t\/s[^]*?低速/);
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
  assert.match(tip, /zu-sl-note">会话加权平均</);
  assert.match(tip, /最近 6 轮/);
  assert.doesNotMatch(tip, /zu-speed-sub/);   // 最近一段读数由最新柱承载
  // 统计口径与刷新说明
  assert.match(tip, /最近 10 轮：每轮（一次提问的全部模型请求）按 Σ有效输出 ÷ Σ生成耗时加权的真实速度/);
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
  // 悬停第 3 根（下标 2）→ cur 迁移、信息卡切第 3 轮
  context.speedChartHover = 2;
  tip = vm.runInContext('speedTipRebuild()', context);
  const chart = chartOf(tip);
  assert.equal((chart.match(/zu-sc-col cur"/g) || []).length, 1, 'cur 唯一');
  assert.match(chart, /class="zu-sc-col cur" role="img" tabindex="0" data-i="2"/);
  assert.match(chart, /第 3 轮 · 2026-11-03 13:42:00/);
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
  assert.match(hovered, /zu-sc-card-k">第 6 轮 · 2026-11-03 13:45:00/);
  assert.match(hovered, /zu-sc-card-v ok">110\.0 t\/s<i>（最新）<\/i></, '悬停最新段带（最新）角标');
  // {v,t} 旧形态：无轮明细行（模型/Token/请求·费用整组省略）
  assert.doesNotMatch(hovered, /zu-sc-card-m/);
  ctx2.speedChartHover = 2;   // 非最新段：角标让位档位名
  const hovered2 = vm.runInContext('speedTipRebuild()', ctx2);
  assert.match(hovered2, /zu-sc-card-v ok">104\.0 t\/s<i>流畅<\/i></);
  // 信息卡不拦截指针（pointer-events:none 是 CSS 契约，VM 只能锁源码规则存在）
  assert.match(source, /\.zu-sc-card\{[^}]*pointer-events:none/);
  // v250 柱宽契约：柱白=0.8×pitch−12=旧白（pitch−15）×0.8，任意列宽恒精确收紧 20%
  assert.match(source, /\.zu-sc-bar\{[^}]*max-width:calc\(20% \+ 12px\)/);
  // 柱体可键盘聚焦，aria-label 携带轮号/读数/时间/档位
  assert.match(tip, /tabindex="0" data-i="0" aria-label="第 1 轮，100\.0 t\/s，11-03 13:40[^]*?流畅/);
});

test('bilingual labels follow the instance language', () => {
  const tip = speedTip(render(fixture(segs(17)), 'en'));
  const chart = chartOf(tip);
  assert.match(chart, /Last 10/);
  assert.match(chart, /completion order · old → new/);
  assert.match(chart, /unit: t\/s/);
  assert.match(tip, /Weighted average/);
  assert.match(chart, /aria-label="Turn 1，114.0 t\/s，11-03 13:47[^]*?Smooth/);
});

test('speed_segs from the session row reach the chart through the full fallback path', () => {
  const data = fixture(segs(3));
  data.session.avg_tps = 0;   // 无会话均：主读数回退最近一段，图表照常
  const tip = speedTip(render(data));
  assert.match(tip, /zu-speed-chart/);
  assert.match(tip, /最近 3 轮/);
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
  assert.match(chart, /最近 1 轮/);
  assert.equal((chart.match(/class="zu-sc-col/g) || []).length, 1);
  assert.match(chart, /zu-sc-col latest"/);   // 单柱=最新段（v240 未悬停无 cur）
  assert.match(chart, /aria-label="第 1 轮，100\.0 t\/s，11-03 13:40/);
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
  const sandbox = {
    L: (zh) => zh,
    lastView: { session: { sid: 'sa', speed_segs: segs(6) }, last: { tps: 110 } },
    speedChartHover: -1, speedTipSess: '', speedTipRebuild: null,
    speedSpan: (s, e) => s ? { start: 'S', end: e ? 'E' : '' } : null,
    Date,   // 图表 tParts 要 new Date(t)（子代理槽位空、freshness 不依赖 now 桩）
    subRate: { slots: {}, sum: { rate: null, at: 0, count: 0 } },
    zuIcoThinking: () => '<svg/>',
    state: { cost: 1 },   // v250：opts 携带费用门控与明细格式化回调
    fmt: v => String(v || 0), countFmt: v => String(v || 0), fmtMoney: usd => '$' + usd.toFixed(2),
  };
  const buildTip = vm.runInNewContext(
    bandHelpers + '\n' + getNamedSlice('buildLiveTip') + '\nbuildLiveTip;', sandbox);
  const view = { cls: 'ok', text: '130.3 t/s', phase: null, band: null };
  const html = buildTip(view);
  assert.match(html, /zu-speed-chart/);
  assert.match(html, /最近 6 轮/);
  assert.doesNotMatch(html, /zu-speed-sub/);   // sub 右格由最新柱承载（v218 行为仅旧快照保留）
  assert.match(html, /最近 10 轮：每轮（一次提问的全部模型请求）按 Σ有效输出 ÷ Σ生成耗时加权的真实速度/);
  assert.doesNotMatch(html, /每段完成后更新/);   // v233 删该脚注
  // 会话切换重置悬停：悬停第 3 根后 sid 变为 sb → 悬停回未悬停（v236：无信息卡、无 cur）
  sandbox.speedChartHover = 2;
  assert.match(buildTip(view), /zu-sc-card-k">第 3 轮 · 2026-11-03 13:42:00/);
  // v250：桥接态（buildLiveTip 主站点）同样透传轮明细回调——主站点 fmt 三回调整体删除即红
  sandbox.lastView.session.speed_segs = segs(6).map((sg, i) =>
    Object.assign({}, sg, i === 2 ? { m: 'glm-5.3', i: 102000, o: 21000, n: 3, c: 0.85 } : {}));
  const withMeta = buildTip(view);
  assert.match(withMeta, /zu-sc-card-m" title="glm-5\.3">模型 glm-5\.3</);
  assert.match(withMeta, /Token 123000（输入 102000 · 输出 21000）</);
  assert.match(withMeta, /请求 3 次 · 预估 \$0\.85</);
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

test('unhovered bars size to reading clearance only, hovering restores the card clearance (v246)', () => {
  const flat = Array.from({ length: 10 }, (_, i) => ({ v: 150, t: new Date(2026, 10, 3, 13, 40 + i).getTime() }));
  const chart = chartOf(speedTip(render(fixture(flat))));
  // 未悬停不渲染信息卡：need=maxV/capOut=166.7 → yMax=200 → 75%；
  // 旧式恒按卡预留 spanMax/capIn=222 → yMax=400 → 37.5%（M7：删 hoverIdx 条件即红）
  assert.doesNotMatch(chart, /zu-sc-card/);
  assert.match(chart, /<i class="top" style="bottom:calc\(100% - 13px\)">200<\/i>/);
  assert.match(chart, /style="height:75%"/);
  assert.doesNotMatch(chart, /height:37\.5%/);
  const hovered = chartOf(speedTip(render(fixture(flat), 'zh', 9)));
  // 悬停：信息卡回归，spanMax/capIn 约束随之回归 → need=222.2 → yMax=250（div5）→ 60%
  assert.match(hovered, /zu-sc-card/);
  assert.match(hovered, /<i class="top" style="bottom:calc\(100% - 13px\)">250<\/i>/);
  assert.match(hovered, /style="height:60%"/);
  assert.doesNotMatch(hovered, /height:75%/);
});

test('scale ladder adds 6/7.5 steps so a 250 t/s reading no longer jumps to a 400 top tick (v246)', () => {
  const flat = Array.from({ length: 10 }, (_, i) => ({ v: 250, t: new Date(2026, 10, 3, 13, 40 + i).getTime() }));
  const chart = chartOf(speedTip(render(fixture(flat))));
  // need=277.8：旧阶梯 [1,2,2.5,5] 在 250 之上只能跳 yMax=400（顶刻度翻倍、柱高 62.5%）；
  // 新阶梯 mant 6 → st=60 → yMax=300 → 83.3%（M5：mant 删 6/7.5 即红）
  assert.match(chart, /<i class="top" style="bottom:calc\(100% - 13px\)">300<\/i>/);
  assert.match(chart, /style="height:83\.3%"/);
  assert.doesNotMatch(chart, /height:62\.5%/);
});

test('x axis shows the date on every shown label across day boundaries (v250)', () => {
  const t0 = new Date(2026, 10, 3, 23, 57).getTime();
  const cross = [
    { v: 100, t: t0 }, { v: 110, t: t0 + 60000 }, { v: 120, t: t0 + 120000 },
    { v: 130, t: new Date(2026, 10, 4, 0, 0).getTime() },
  ];
  const chart = chartOf(speedTip(render(fixture(cross))));
  assert.equal((chart.match(/<b>11-03<\/b>/g) || []).length, 3, '同日各柱都带月日（v250 同日去重废止）');
  assert.equal((chart.match(/<b>11-04<\/b>/g) || []).length, 1, '跨日柱显新日期');
  assert.match(chart, /<span class="zu-sc-x"><b>11-04<\/b><b>00:00<\/b><\/span>/);
  assert.match(chart, /<span class="zu-sc-x"><b>11-03<\/b><b>23:58<\/b><\/span>/);
});

// v250 悬停卡轮明细：模型/Token 用量（含输入·输出拆分）/请求次数/预估费用逐行判空渲染，
// 时间全格式；明细行数参与 CARD_H 校准（悬停净空随之收紧）
test('hover card renders per-turn details (model/tokens/requests/cost) with full timestamp', () => {
  const meta = { m: 'glm-5.3-flashx', i: 102000, o: 21000, n: 3, c: 0.85 };
  const raw = segs(6).map((s2, i) => Object.assign({ m: null }, s2, i === 2 ? meta : {}));
  const ctx2 = makeCtx('zh');
  vm.runInContext(bandHelpers, ctx2);
  vm.runInContext(helpers, ctx2);
  ctx2.html(fixture(raw));
  ctx2.speedChartHover = 2;
  const chart = chartOf(vm.runInContext('speedTipRebuild()', ctx2));
  assert.match(chart, /zu-sc-card-k">第 3 轮 · 2026-11-03 13:42:00/);
  assert.match(chart, /class="zu-sc-card-m" title="glm-5\.3-flashx">模型 glm-5\.3-flashx</);
  // title 属性转义契约：模型名含引号/尖括号时不破坏属性边界（对抗性断言）
  const xss = segs(6).map((sg, i) => Object.assign({}, sg, i === 2 ? { m: '"><x>evil' } : {}));
  const ctx3 = makeCtx('zh');
  vm.runInContext(bandHelpers, ctx3);
  vm.runInContext(helpers, ctx3);
  ctx3.html(fixture(xss));
  ctx3.speedChartHover = 2;
  const chart3 = chartOf(vm.runInContext('speedTipRebuild()', ctx3));
  assert.match(chart3, /title="&quot;&gt;&lt;x&gt;evil"/, 'title 内引号/尖括号已实体化');
  assert.doesNotMatch(chart3, /title="[^"]*<x>/, 'title 内无原始尖括号');
  // 模型名 200 字符封顶：超长名整行省略（speedSegsOf 校验）
  const long = segs(6).map((sg, i) => Object.assign({}, sg, i === 2 ? { m: "x".repeat(201) } : {}));
  const ctx4 = makeCtx('zh');
  vm.runInContext(bandHelpers, ctx4);
  vm.runInContext(helpers, ctx4);
  ctx4.html(fixture(long));
  ctx4.speedChartHover = 2;
  assert.doesNotMatch(chartOf(vm.runInContext('speedTipRebuild()', ctx4)), /模型 x{20}/, '超长模型名整行省略');
  assert.match(chart, /zu-sc-card-m" title="Token 123000（输入 102000 · 输出 21000）">Token 123000（输入 102000 · 输出 21000）</);
  assert.match(chart, /zu-sc-card-m" title="请求 3 次 · 预估 \$0\.85">请求 3 次 · 预估 \$0\.85</);
  // 其余轮无明细（m=null 缺字段）：悬停它们不产生明细行
  ctx2.speedChartHover = 1;
  assert.doesNotMatch(chartOf(vm.runInContext('speedTipRebuild()', ctx2)), /zu-sc-card-m/);
  // 明细行数参与悬停净空校准：flat 150×10 全轮带 3 行明细 → CARD_H 36+3×14=78 →
  // capIn=(160-78-16)/160 → need=363.6 → yMax=375（阶梯 75×5，无明细时 250）；柱高 40%
  const flat = Array.from({ length: 10 }, (_, i) => Object.assign({ v: 150, t: new Date(2026, 10, 3, 13, 40 + i).getTime() }, meta));
  const hoveredChart = chartOf(speedTip(render(fixture(flat), 'zh', 9)));
  assert.match(hoveredChart, /<i class="top" style="bottom:calc\(100% - 13px\)">375<\/i>/);
  assert.match(hoveredChart, /style="height:40%"/);
});

test('cost line in the hover card follows the state.cost gate (fmtMoney withheld)', () => {
  const meta = { m: 'glm-5.3', i: 1000, o: 500, n: 2, c: 0.5 };
  const raw = segs(3).map((s2, i) => Object.assign({}, s2, i === 1 ? meta : {}));
  const context = makeCtx('zh');
  context.state.cost = 0;   // ⚙ 费用显示关：调用点不传 fmtMoney → 明细行无预估费用
  vm.runInContext(bandHelpers, context);
  vm.runInContext(helpers, context);
  context.html(fixture(raw));
  context.speedChartHover = 1;
  const chart = chartOf(vm.runInContext('speedTipRebuild()', context));
  assert.match(chart, /zu-sc-card-m[^>]*>请求 2 次</);
  assert.doesNotMatch(chart, /预估/);
});
