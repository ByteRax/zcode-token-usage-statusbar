const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');
const { sliceOverlay } = require('./helpers/overlay-extract.cjs');

/* v304「工具调用」tooltip 450 自适应紧凑布局（同四卡家族）：
 * 标题前置扳手 SVG（statHead 第 4 参）；双 KPI 走 zu-turn-kpis--duo（错误 >0 红/0 灰）；
 * 四列表格 table-layout:fixed + 长名省略（title 全文）+ sticky 表头 + 行 hover；
 * 累计耗时 secLong 换算（title 保留完整秒数）；表体独立滚动区；无记录空态。 */

const helpers = sliceOverlay('    function fmtStart(', '    function ioc(') +
  sliceOverlay('    function ttEsc(', '    function stubFor(');

function render(data, lang = 'zh', cost = 1) {
  const context = vm.createContext({
    state: { lang, cost, show: { turn: true, win: true, tools: true } },
    L: (zh, en) => lang === 'en' ? en : zh,
    fmt: value => String(value || 0), countFmt: value => String(value || 0),
    sec: value => String(value || 0), secLong: value => String(Math.round((value || 0) / 360000) / 10) + 'h',
    cachePct: () => '', shrink: false, liveStatsCur: null, bridge: { handle: null },
    subRate: { rate: null, at: 0 },
    zuBarSpeedView: value => value, zuIcoThinking: () => '<svg/>',
    lastView: { last: { tps: 102.2 } },
    speedChartHover: -1, speedTipSess: '', speedTipRebuild: null,
    FXQ_ICON: '<svg class="tip-fxq"></svg>',
  });
  vm.runInContext(helpers, context);
  return context.html(data).tips.filter(Boolean).find(t => t.includes('zu-stat-tip--tools'));
}

function toolsFixture(over) {
  const list = [
    { name: 'Bash', count: 985, duration_ms: 14718100, errors: 4 },
    { name: 'Read', count: 146, duration_ms: 44800, errors: 0 },
    { name: 'mcp__chrome-devtools__evaluate_script', count: 2, duration_ms: 500, errors: 0 },
  ];
  if (over && over.list) return { tools: Object.assign({ total: 0, errors: 0 }, over) };
  return { tools: Object.assign({ total: 1133, errors: 4, list }, over || {}) };
}
const noStyle = s => s.replace(/<style>[\s\S]*?<\/style>/g, '');
const stripAll = s => noStyle(s).replace(/<[^>]+>/g, '');
const ruleBodies = style => style.replace(/^<style>/, '').replace(/<\/style>$/, '').split('}');

test('v304 tools tip: 450 wide auto-height scoped style, tools-specific rules, per-rule hygiene', () => {
  const style = (render(toolsFixture()).match(/<style>[\s\S]*?<\/style>/) || [''])[0];
  assert.match(style, /zusage-tip-root:has\(\.zu-stat-tip--tools\)\{width:min\(450px,calc\(100vw - 16px\)\)!important/);
  assert.match(style, /max-height:calc\(100vh - 24px\)!important/);
  assert.doesNotMatch(style, /:has\(\.zu-stat-tip--tools\)\{[^}]*height:\d/);   // 高度自适应不写定高
  // tools 专属：定宽四列/长名省略/sticky 表头/行 hover
  assert.match(style, /\.zu-stat-tip--tools \.zu-stat-table\{table-layout:fixed/);
  assert.match(style, /\.zu-stat-tip--tools \.zu-stat-table td\.zu-pj-mname\{overflow:hidden[^}]*text-overflow:ellipsis/);
  assert.match(style, /\.zu-stat-tip--tools \.zu-stat-table thead th\{position:sticky/);
  assert.match(style, /\.zu-stat-tip--tools \.zu-stat-table tbody tr:hover\{background/);
  for (const r of ruleBodies(style)) {
    const sel = r.split('{')[0].trim();
    if (!sel) continue;
    assert.ok(/zu-turn-|^\.zu-stat-tip--tools|:has\(\.zu-stat-tip--tools\)/.test(sel), '越域选择器: ' + sel);
    if (/^\.zusage-tip-root:has\(\.zu-stat-tip--tools\)\{/.test(sel) ||
        /^\.zusage-tip-root:has\(\.zu-stat-tip--tools\) \.tbody\{/.test(sel)) {
      assert.doesNotMatch(r, /display/, 'tip/tbody 禁注入 display');
    }
  }
});

test('v304 tools tip: wrench SVG before title, duo KPI row with error coloring', () => {
  const raw = render(toolsFixture());
  // 扳手图标在标题文字之前（kpi-ico 外框 + tools 路径）
  assert.match(raw, /<svg class="zu-kpi-ico"[^]*?M14\.5 2\.5a6 6 0 0 0-5\.6 8\.1[^]*?<\/svg>工具调用</);
  assert.match(noStyle(raw), /zu-turn-kpis--duo/, '双列 KPI 容器');
  assert.match(noStyle(raw), /调用总数<\/div><div class="zu-stat-v">1133 <small>次<\/small>/);
  // 错误 >0：err 红档；0 时无 err 档
  assert.match(raw, /错误<\/div><div class="zu-stat-v err">4 <small>次<\/small>/);
  const noErr = render(toolsFixture({ total: 5, errors: 0, list: [{ name: 'Bash', count: 5, duration_ms: 100, errors: 0 }] }));
  assert.match(noErr, /错误<\/div><div class="zu-stat-v">0 <small>次<\/small>/, '零错误无红档');
  assert.doesNotMatch(noErr, /zu-stat-v err/);
});

test('v304 tools tip: fixed 4-col table, long MCP name ellipsized with full title, secLong + full seconds title', () => {
  const raw = noStyle(render(toolsFixture()));
  assert.match(raw, /zu-turn-models/, '表体独立滚动区');
  assert.match(raw, /<th>工具<\/th><th>调用次数<\/th><th>累计耗时<\/th><th>错误<\/th>/);
  // 长名：文本原样 + title 全文（省略由 CSS 承担）
  assert.match(raw, /<td class="zu-pj-mname" title="mcp__chrome-devtools__evaluate_script">mcp__chrome-devtools__evaluate_script<\/td>/);
  // secLong 换算（桩直出 h）+ title 完整秒数；错误行红、零错行 dim0
  assert.match(raw, /<td title="14718100">4\.1h<\/td><td class="err">4<\/td>/);   // 桩 secLong：14718100ms→4.1h
  assert.match(raw, /<td class="dim0">0<\/td>/, '零错误弱化灰');
  // 列序用表头行直证（strip 级 indexOf 会撞 KPI 行的同名词「错误」）
  assert.match(raw, /<thead><tr><th>工具<\/th><th>调用次数<\/th><th>累计耗时<\/th><th>错误<\/th><\/tr><\/thead>/);
});

test('v304 tools tip: empty state, EN locale', () => {
  const empty = noStyle(render({ tools: { total: 0, errors: 0, list: [] } }));
  assert.doesNotMatch(empty, /zu-turn-models|zu-stat-table/, '无记录不渲染表格');
  assert.match(empty, /无工具调用记录/);
  const en = stripAll(render(toolsFixture(), 'en'));
  assert.match(en, /Tool calls/);
  assert.match(en, /Total calls/);
  assert.match(en, /Total time/);
  assert.match(en, /Errors/);
});

test('review fix: sticky header pins via top:0 and first column keeps its 43% width (mutation-held assertions)', () => {
  const style = (render(toolsFixture()).match(/<style>[\s\S]*?<\/style>/) || [''])[0];
  assert.match(style, /\.zu-stat-tip--tools \.zu-stat-table thead th\{position:sticky[^}]*top:0/, 'sticky without top:0 does not pin — lock it');
  assert.match(style, /\.zu-stat-tip--tools \.zu-stat-table th:first-child,\.[^\{]*zu-stat-table td:first-child\{width:43%/, '43% first-column width locked');
});
