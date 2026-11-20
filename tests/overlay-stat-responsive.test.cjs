const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');
const { sliceOverlay, getNamedSlice } = require('./helpers/overlay-extract.cjs');

/* v412 统计 Tooltip 响应式布局（specs/stat-tooltip-responsive.md）回归：
 * 每卡理想宽度、data-zu-mode 模式映射、:is 四卡作用域（tools/速度卡豁免）、
 * 模型明细三模式 DOM 支撑（zu-md-sub 常驻副行 / data-l 字段名 / zu-c-* 列类）、
 * statKpi title 完整值兜底、.tbody 滚动条可见化、@media 视口兜底、行一标记类。 */

const bandHelpers = sliceOverlay('  var TPS_BANDS = [', '  /* 返回 null = 调用方应把这当成');
const helpers = getNamedSlice('barOrderHelpers') +
  sliceOverlay('    function fmtStart(', '    function ioc(') +
  sliceOverlay('    function ttEsc(', '    function stubFor(');

const RENDER_CTX = {
  state: { lang: 'zh', cost: 1, show: { turn: true, win: true, today: true, proj: true } },
  L: (zh) => zh, fmt: v => String(v || 0), countFmt: v => String(v || 0),
  sec: v => String(v || 0), secLong: v => String(v || 0), cachePct: () => '',
  shrink: false, liveStatsCur: null, bridge: { handle: null }, subRate: { rate: null, at: 0 },
  zuBarSpeedView: () => null, zuIcoThinking: () => '<svg/>',
  lastView: { last: { tps: 0 } }, speedChartHover: -1, speedTipSess: '', speedTipRebuild: null,
  FXQ_ICON: '<svg class="tip-fxq"></svg>',
};

function renderStat(data, variant, statePatch) {
  const seed = Object.assign({}, RENDER_CTX, {
    state: Object.assign({}, RENDER_CTX.state, statePatch || {}),
  });
  const ctx = vm.createContext(seed);
  vm.runInContext(bandHelpers, ctx);
  vm.runInContext(helpers, ctx);
  // 项目卡根类串是 class="zu-project-tip zu-stat-tip zu-stat-tip--project"——用尾引号锚定；
  // 其余卡根类串恰为 class="zu-stat-tip zu-stat-tip--<variant>"
  const needle = variant === 'project' ? 'zu-stat-tip--project"' : 'class="zu-stat-tip zu-stat-tip--' + variant + '"';
  const tip = ctx.html(data).tips.filter(Boolean).find(t => t.includes(needle));
  assert.ok(tip, variant + ' card renders');
  return tip;
}

function turnFixture(over) {
  return {
    session: { turns: 3 }, last: { tps: 0 },
    last_turn: Object.assign({
      requests: 2, total: 1200, input: 1000, output: 200, cache_read: 900,
      started: 1, ended: 2,
      models: [
        { model: 'glm-big', requests: 1, total: 1000, cost_usd: 0.5, avg_tps: 66.6 },
        { model: 'glm-small', requests: 1, total: 200 },
      ],
    }, over || {}),
    today: { started: 1, last_at: 2 },
  };
}

test('v412 每卡理想宽度：turn 540 / session 600 / today 600 / project 760 / tools 450，恒 min(理想, vw-16)', () => {
  const want = { turn: 540, session: 600, today: 600, project: 760, tools: 450 };
  const data = turnFixture();
  data.session.project = { started: 1, last_at: 2, total: 1, input: 1, output: 1, cache_read: 1, sessions: 1, turns: 1, requests: 1, tool_calls: 1, retries: 1 };
  for (const variant of Object.keys(want)) {
    let tip;
    if (variant === 'tools') {
      const ctx = vm.createContext(Object.assign({}, RENDER_CTX, {
        state: Object.assign({}, RENDER_CTX.state, { show: { tools: true } }),
      }));
      vm.runInContext(bandHelpers, ctx); vm.runInContext(helpers, ctx);
      tip = ctx.html({ tools: { total: 1, errors: 0, list: [{ name: 'Bash', count: 1, duration_ms: 100, errors: 0 }] } })
        .tips.filter(Boolean).find(t => t.includes('class="zu-stat-tip zu-stat-tip--tools"'));
      assert.ok(tip, 'tools card renders');
    } else if (variant === 'project') {
      tip = renderStat(data, 'project');
    } else {
      tip = renderStat(data, variant);
    }
    const style = (tip.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
    const w = want[variant];
    assert.match(style,
      new RegExp('width:min\\(' + w + 'px,calc\\(100vw - 16px\\)\\)!important;max-width:min\\(' + w + 'px'),
      variant + ' 理想宽 ' + w);
    assert.match(style, /max-height:calc\(100vh - 24px\)!important/, variant + ' 视口钳高保留');
  }
});

test('v412 共享响应式核心只注入四卡：tools 卡无 :is 核心，四卡有且不含 --tools 字样', () => {
  const data = turnFixture();
  const turn = renderStat(data, 'turn');
  assert.match(turn, /:is\(\.zu-stat-tip--turn,\.zu-stat-tip--session,\.zu-stat-tip--today,\.zu-stat-tip--project\)/, '四卡 :is 核心');
  const ctx = vm.createContext(Object.assign({}, RENDER_CTX, {
    state: Object.assign({}, RENDER_CTX.state, { show: { tools: true } }),
  }));
  vm.runInContext(bandHelpers, ctx); vm.runInContext(helpers, ctx);
  const tools = ctx.html({ tools: { total: 1, errors: 0, list: [{ name: 'Bash', count: 1, duration_ms: 100, errors: 0 }] } })
    .tips.filter(Boolean).find(t => t.includes('class="zu-stat-tip zu-stat-tip--tools"'));
  const style = (tools.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
  assert.doesNotMatch(style, /:is\(/, 'tools 卡不注入共享核心');
  assert.doesNotMatch(style, /data-zu-mode/, 'tools 卡无模式规则');
});

test('v412 模式映射与幂等：理想宽 540 时 540→full 500→compact 430→narrow 359→tiny；同宽不重写、零宽保持现值', () => {
  const src = sliceOverlay('    function positionTip(el, keepTop) {', '    /* 实时速度 chip tooltip 的懒构建补建');
  function run(width) {
    let writes = 0, attr = null;
    const statRoot = {
      getBoundingClientRect: () => ({ width }),
      getAttribute: k => (k === 'data-zu-w' ? 540 : attr),
      setAttribute: (_, v) => { writes++; attr = v; },
    };
    const tip = {
      __zuSpeedSize: null, __zuModelFitWidth: 1280, __zuAlignLeft: false,
      style: { display: 'block', top: '' },
      querySelector: sel => sel === '.zu-stat-tip[data-zu-w]' ? statRoot : null,
      getBoundingClientRect: () => ({ width: width + 28, height: 300, left: 0, top: 0 }),
    };
    const ctx = vm.createContext({
      tip, innerWidth: 1280, innerHeight: 900,
      spdFitTip: () => {}, fitModelNames: () => {},
    });
    vm.runInContext(src + '\npositionTip({ getBoundingClientRect: () => ({ left: 0, width: 40, top: 0 }) }, true);', ctx);
    return { attr, writes };
  }
  assert.equal(run(540).attr, 'full');
  assert.equal(run(516).attr, 'full');
  assert.equal(run(515.4).attr, 'compact');
  assert.equal(run(440).attr, 'compact');
  assert.equal(run(439.6).attr, 'narrow');
  assert.equal(run(360).attr, 'narrow');
  assert.equal(run(359.6).attr, 'tiny');
  // 幂等：连续两次同宽只写一次
  {
    let writes = 0, attr = null;
    const statRoot = {
      getBoundingClientRect: () => ({ width: 540 }),
      getAttribute: k => (k === 'data-zu-w' ? 540 : attr),
      setAttribute: (_, v) => { writes++; attr = v; },
    };
    const tip = {
      __zuSpeedSize: null, __zuModelFitWidth: 1280, __zuAlignLeft: false,
      style: { display: 'block', top: '' },
      querySelector: sel => sel === '.zu-stat-tip[data-zu-w]' ? statRoot : null,
      getBoundingClientRect: () => ({ width: 728, height: 300, left: 0, top: 0 }),
    };
    const ctx = vm.createContext({
      tip, innerWidth: 1280, innerHeight: 900,
      spdFitTip: () => {}, fitModelNames: () => {},
    });
    const anchor = '{ getBoundingClientRect: () => ({ left: 0, width: 40, top: 0 }) }';
    vm.runInContext(src + `\npositionTip(${anchor}, true);\npositionTip(${anchor}, true);`, ctx);
    assert.equal(writes, 1, '同宽第二次不重写 DOM');
    assert.equal(attr, 'full');
  }
  // 隐藏态（display none）与零宽：不写模式（保持现值，不误降档）
  {
    let writes = 0;
    const statRoot = {
      getBoundingClientRect: () => ({ width: 0 }),
      getAttribute: () => 'narrow',
      setAttribute: () => { writes++; },
    };
    const tip = {
      __zuSpeedSize: null, __zuModelFitWidth: 1280, __zuAlignLeft: false,
      style: { display: 'none', top: '' },
      querySelector: sel => sel === '.zu-stat-tip[data-zu-w]' ? statRoot : null,
      getBoundingClientRect: () => ({ width: 100, height: 300, left: 0, top: 0 }),
    };
    const ctx = vm.createContext({
      tip, innerWidth: 1280, innerHeight: 900,
      spdFitTip: () => {}, fitModelNames: () => {},
    });
    vm.runInContext(src + '\npositionTip({ getBoundingClientRect: () => ({ left: 0, width: 40, top: 0 }) }, true);', ctx);
    assert.equal(writes, 0, 'display:none 时跳过（rect 不可信）');
  }
});

test('v412 模型明细三模式 DOM 支撑：副行常驻+段值取舍、data-l 字段名、zu-c-* 列类、表头列类', () => {
  const tip = renderStat(turnFixture(), 'turn');
  // 首行模型有速度有费用：副行两段；次行无速度无费用：无副行节点
  assert.match(tip, /<div class="zu-md-sub" title="66\.6 t\/s · \$0\.50">66\.6 t\/s · \$0\.50<\/div>/);
  assert.doesNotMatch(tip, /glm-small<div class="zu-md-sub"/, '全缺省不产副行节点');
  assert.match(tip, /<td class="zu-c-name zu-pj-mname zu-model-fit" title="glm-big">glm-big<div class="zu-md-sub"/);
  assert.match(tip, /<td class="zu-c-tok" data-l="Token 用量">1000<\/td>/);
  assert.match(tip, /<td class="zu-c-req" data-l="请求次数">1<\/td>/);
  assert.match(tip, /<th class="zu-c-name">模型<\/th><th class="zu-c-tok">/);
  assert.match(tip, /<th class="zu-c-spd">平均速度<\/th><th class="zu-c-cost">预估费用<\/th>/);
  // 费用开关关：副行只剩速度段，费用列不渲染
  const noCost = renderStat(turnFixture(), 'turn', { cost: 0 });
  assert.match(noCost, /<div class="zu-md-sub" title="66\.6 t\/s">66\.6 t\/s<\/div>/);
  // 模式 CSS：narrow 隐速度/费用列并显示副行；tiny 表格卡片化
  const style = (tip.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
  assert.match(style, /\[data-zu-mode="narrow"\] \.zu-c-spd,:is\([^)]*\)\[data-zu-mode="narrow"\] \.zu-c-cost\{display:none!important\}/);
  assert.match(style, /\[data-zu-mode="tiny"\] \.zu-stat-table thead,:is\([^)]*\)\[data-zu-mode="tiny"\] table\.zu-pj-table thead\{display:none!important\}/);
  // v412.1 级联修复：tiny 高特异性形态（tbody 中缀 + td.zu-c-* 加类）压过变体帽/列定义
  assert.match(style, /\[data-zu-mode="tiny"\] \.zu-turn-models \.zu-stat-table tbody td\.zu-c-spd,:is\([^)]*\)\[data-zu-mode="tiny"\][^{]*\.zu-c-cost\{display:none!important\}/);
  assert.match(style, /\[data-zu-mode="tiny"\] \.zu-turn-models \.zu-stat-table tbody td:first-child,[^{]*table\.zu-pj-table tbody td:first-child\{display:block!important;max-width:none!important\}/);
  assert.match(style, /\[data-zu-mode="tiny"\] \.zu-stat-table thead,:is\([^)]*\)\[data-zu-mode="tiny"\] table\.zu-pj-table thead\{display:none!important\}/);
  assert.match(style, /td\[data-l\]::before\{content:attr\(data-l\)/);
  assert.match(style, /@media \(max-width:375px\)\{/, '视口兜底档存在');
});

test('v412 statKpi title 完整值兜底：标签剥除+实体还原，&lt;¥0.01 不双重转义', () => {
  const tip = renderStat(turnFixture(), 'turn');
  assert.match(tip, /<div class="zu-stat-v" title="1200">1200<\/div>/);
  // 速度 KPI：值含 <b>/<small> 标签，title 拼纯文本
  const withTps = renderStat(turnFixture({ tps: 143.7 }), 'turn');
  assert.match(withTps, /<div class="zu-stat-v" title="143\.7 t\/s"><b class="[^"]*">143\.7<\/b> <small>t\/s<\/small><\/div>/);
  // 微小费用 &lt;¥0.01：title 还原为字面 <¥0.01 而非 &amp;lt;
  const ctx = vm.createContext(Object.assign({}, RENDER_CTX, {
    state: Object.assign({}, RENDER_CTX.state, { cost: 1 }),
    fxp: 1,
  }));
  vm.runInContext(bandHelpers, ctx);
  vm.runInContext(helpers +
    '\nstate.data = { fx: { rate: 7 } };' +
    '\n__out = statKpi("k", ttEsc(fmtMoney(0.001)));', ctx);
  assert.match(String(ctx.__out), /title="&lt;¥0\.01">&lt;¥0\.01</, '实体还原后一次转义');
});

test('v412 .tbody 滚动条可见化 + 行一标记类 + 页脚窄档换行', () => {
  const tip = renderStat(turnFixture(), 'turn');
  const style = (tip.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
  assert.match(style, /\.tbody\{[^}]*scrollbar-width:thin!important/, 'tbody 滚动条可见');
  assert.doesNotMatch(style, /scrollbar-width:none/, '隐藏滚动条形态废除');
  assert.doesNotMatch(style, /has\(\.zu-stat-tip--turn\) \.tbody::\S+\{display:none/, 'webkit 隐藏废除');
  assert.match(style, /\[data-zu-mode="narrow"\] \.zu-stat-time span\{flex:0 0 100%!important\}/);
  assert.match(style, /\[data-zu-mode="tiny"\] \.zu-stat-time span\{flex:0 0 100%!important;white-space:normal!important\}/);
  assert.match(tip, /<div class="zu-turn-kpis zu-krow-total">/);
  const sess = renderStat(Object.assign(turnFixture(), { session: { turns: 3, total: 1, input: 1, output: 1, cache_read: 1, requests: 1 } }), 'session');
  assert.match(sess, /<div class="zu-turn-kpis zu-krow-total">/);
  const today = renderStat(Object.assign(turnFixture(), { today: { total: 1, input: 1, output: 1, cache_read: 1, requests: 1, started: 1, last_at: 2 } }), 'today');
  assert.match(today, /<div class="zu-turn-kpis zu-krow-total">/);
});

test('v412 narrow/tiny KPI 降列规则：总用量整行、tiny 全两列、项目名换行、@media 兜底', () => {
  const tip = renderStat(turnFixture(), 'turn');
  const style = (tip.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
  assert.match(style, /\[data-zu-mode="narrow"\] \.zu-krow-total\{grid-template-columns:repeat\(2,1fr\)!important\}/);
  assert.match(style, /\[data-zu-mode="narrow"\] \.zu-krow-total \.zu-stat-kpi:first-child\{grid-column:1\/-1!important\}/);
  assert.match(style, /\[data-zu-mode="narrow"\] \.zu-krow-total \.zu-stat-kpi:nth-child\(2\)\{border-left:0!important;padding-left:0!important\}/);
  assert.match(style, /\[data-zu-mode="tiny"\] \.zu-turn-kpis\.zu-turn-kpis\{grid-template-columns:repeat\(2,1fr\)!important\}/);
  assert.match(style, /\[data-zu-mode="tiny"\] \.zu-turn-kpis--trio \.zu-stat-kpi:nth-child\(3\)\{grid-column:1\/-1!important\}/);
  assert.match(style, /\[data-zu-mode="narrow"\] \.zu-pj-title,\.zu-stat-tip--project\[data-zu-mode="tiny"\] \.zu-pj-title\{flex-wrap:wrap!important\}/);
  // @media 兜底段：四卡作用域、KPI 两列、表格卡片化
  const media = style.slice(style.indexOf('@media'));
  assert.ok(media.includes('@media (max-width:375px){'), '兜底断点 375');
  assert.ok(/:is\(\.zu-stat-tip--turn,\.zu-stat-tip--session,\.zu-stat-tip--today,\.zu-stat-tip--project\) \.zu-turn-kpis\.zu-turn-kpis\{grid-template-columns:repeat\(2,1fr\)/.test(media), '兜底 KPI 两列（双类特异体）');
  assert.ok(/\.zu-md-sub\{display:block!important\}/.test(media), '兜底副行显示');
  assert.ok(/\.zu-stat-table thead,/.test(media) && /table\.zu-pj-table thead\{display:none!important\}/.test(media), '兜底表头收起');
  assert.ok(/tbody td\.zu-c-spd,/.test(media) && /tbody td\.zu-c-cost\{display:none!important\}/.test(media), '兜底速度/费用列隐藏');
  assert.ok(/tbody td:first-child,/.test(media) && /\{display:block!important;max-width:none!important\}/.test(media), '兜底首列帽解除');
  assert.ok(media.includes('td[data-l]::before'), '兜底卡片化字段名');
});
