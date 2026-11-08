const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');
const { sliceOverlay } = require('./helpers/overlay-extract.cjs');

/* v301「今日合计」tooltip 450 自适应紧凑布局（同本轮 v299 / 会话 v300 三行 KPI 形态）：
 * 行一 总用量|输入(缓存命中率副行)|输出(含思考)；行二 平均耗时|平均延迟|重试次数
 * （前两者 zusage 今日聚合 >0 门控，重试 0 也中性显示）；行三 输出速度(今日加权均
 * avg_tps 档色)|预估费用；八枚 KPI SVG 图标随标签；模型表独立滚动区；时间行钉底。
 * 样式 statCompactStyle("today") + today 专属规则（图标居中/副行绿/单格占满）。 */

const helpers = sliceOverlay('    function fmtStart(', '    function ioc(') +
  sliceOverlay('    function ttEsc(', '    function stubFor(');
const bandHelpers = sliceOverlay('  var TPS_BANDS = [', '  /* 返回 null = 调用方应把这当成');

function render(data, lang = 'zh', cost = 1) {
  const context = vm.createContext({
    state: { lang, cost, show: { turn: true, win: true, today: true } },
    L: (zh, en) => lang === 'en' ? en : zh,
    fmt: value => String(value || 0), countFmt: value => String(value || 0), sec: value => String(value || 0), secLong: value => String(value || 0),
    cachePct: () => '', shrink: false, liveStatsCur: null, bridge: { handle: null },
    subRate: { rate: null, at: 0 },
    zuBarSpeedView: value => value, zuIcoThinking: () => '<svg/>',
    lastView: { last: { tps: 102.2 } },
    speedChartHover: -1, speedTipSess: '', speedTipRebuild: null,
    FXQ_ICON: '<svg class="tip-fxq"></svg>',
  });
  vm.runInContext(bandHelpers, context);
  vm.runInContext(helpers, context);
  return context.html(data).tips.filter(Boolean).find(t => t.includes('zu-stat-tip--today'));
}

function todayFixture(over) {
  const start = new Date(2026, 10, 8, 0, 49, 45).getTime();
  const end = new Date(2026, 10, 8, 22, 36, 40).getTime();
  const today = {
    requests: 1457, input: 619000000, output: 1044300, cache_read: 613000000, total: 620000000,
    reasoning: 300000, retries: 7, cache_write: 0, turns: 631, sessions: 109, tool_calls: 1127,
    avg_duration_ms: 8700, avg_ttft_ms: 2100, avg_tps: 151.6, duration_ms: 12301150,
    started: start, last_at: end, cost_usd: 52.3,
    models: [{ model: 'GLM-5.3-FlashX', requests: 1457, total: 620000000, cost_usd: 52.3,
      rates: { input: 0.002, output: 0.008 } }],
  };
  if (over) Object.assign(today, over);
  return {
    session: { project: 'Demo 项目', total: 1, started: start, last_at: end },
    last: { tps: 156.1, startedAt: start, endedAt: end },
    recent: [{ sid: 'sess_main', total: 1, started: start, last_at: end }],
    today,
  };
}
const noStyle = s => s.replace(/<style>[\s\S]*?<\/style>/g, '');
const stripAll = s => noStyle(s).replace(/<[^>]+>/g, '');
const ruleBodies = style => style.replace(/^<style>/, '').replace(/<\/style>$/, '').split('}');

test('v301 today tip: 450 wide auto-height scoped style, today-specific rules, per-rule hygiene', () => {
  const style = (render(todayFixture()).match(/<style>[\s\S]*?<\/style>/) || [''])[0];
  assert.match(style, /zusage-tip-root:has\(\.zu-stat-tip--today\)\{width:min\(450px,calc\(100vw - 16px\)\)!important/);
  assert.match(style, /max-height:calc\(100vh - 24px\)!important/);
  assert.doesNotMatch(style, /:has\(\.zu-stat-tip--today\)\{[^}]*height:\d/);   // 高度自适应不写定高
  // 图标规则（v301.1 三卡共享，随 today 变体同样生效）：baseline 行内 align-self:center
  assert.match(style, /\.zu-stat-tip--today \.zu-stat-k \.zu-kpi-ico\{flex:none[^}]*align-self:center/);
  // today 专属：缓存副行绿 + 行内单格占满
  assert.match(style, /\.zu-stat-tip--today \.zu-stat-dsub \.hit\{color:#4ade80/);
  assert.match(style, /\.zu-stat-tip--today \.zu-stat-dsub \.hit\{color:#4ade80/);
  assert.match(style, /\.zu-stat-tip--today \.zu-turn-kpis \.zu-stat-kpi:only-child\{grid-column:1\/-1/);
  for (const r of ruleBodies(style)) {
    const sel = r.split('{')[0].trim();
    if (!sel) continue;
    assert.ok(/zu-turn-|^\.zu-stat-tip--today|:has\(\.zu-stat-tip--today\)/.test(sel), '越域选择器: ' + sel);
    if (/^\.zusage-tip-root:has\(\.zu-stat-tip--today\)\{/.test(sel) ||
        /^\.zusage-tip-root:has\(\.zu-stat-tip--today\) \.tbody\{/.test(sel)) {
      assert.doesNotMatch(r, /display/, 'tip/tbody 禁注入 display');
    }
  }
});

test('v302.2 today tip: four KPI rows in fixed order with 11 label icons', () => {
  const raw = render(todayFixture());
  const text = stripAll(raw);
  const labels = ['总用量', '输入', '输出', '请求次数', '请求轮数', '请求会话',
    '平均耗时', '平均延迟', '总耗时', '平均输出速度', '预估费用'];
  const idx = labels.map(k => text.indexOf(k));
  for (let i = 0; i < idx.length - 1; i++) assert.ok(idx[i] >= 0 && idx[i] < idx[i + 1], '行序错: ' + labels[i]);
  assert.match(noStyle(raw), /zu-turn-kpis--mid/, '耗时行容器');
  assert.match(noStyle(raw), /zu-turn-kpis--duo/, '速度行容器');
  // 规模行数值（同本轮/会话口径）
  const raw2 = noStyle(raw);
  assert.match(raw2, /请求次数<\/div><div class="zu-stat-v">1457<\/div>/);
  assert.match(raw2, /请求轮数<\/div><div class="zu-stat-v">631<\/div>/);
  assert.match(raw2, /请求会话<\/div><div class="zu-stat-v">109<\/div>/);
  // 11 枚图标：计数（剥 style 防 CSS 选择器文本计入）+ 逐一路径签名
  assert.equal((noStyle(raw).match(/zu-kpi-ico/g) || []).length, 11, 'KPI 图标恰 11 枚');
  for (const sig of ['m12 3-9 5', 'M12 3v13', 'M12 21V8', 'M12 7v5l3 2', 'M13 2 4 13h7l-1 9',
    'm22 2-7 20-4-9-9-4Z', 'M7.9 20A9 9 0 1 0 4 16.1L2 22Z', 'M7.5 3h12a2 2 0 0 1 2 2v10',
    'M5 22h14', 'M4.9 19a9 9 0 1 1', 'ellipse cx="12" cy="5"']) {
    assert.ok(raw.includes(sig), '图标路径缺失: ' + sig);
  }
  // 图标通用属性：16px / currentColor / aria-hidden，无事件属性
  assert.equal((raw.match(/<svg class="zu-kpi-ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">/g) || []).length, 11);
});

test('v301 today tip: cache hit sub-line under input, thinking sub under output', () => {
  const raw = noStyle(render(todayFixture()));
  assert.match(raw, /<div class="zu-stat-dsub"><span class="hit">缓存命中率 99%<\/span><\/div>/, '缓存命中率=输入格副行');
  const inIdx = raw.indexOf('>输入<'), hitIdx = raw.indexOf('缓存命中率');
  assert.ok(inIdx >= 0 && inIdx < hitIdx, '副行在输入格之后');
  assert.match(raw, /<div class="zu-stat-dsub">含思考 300000<\/div>/, '输出含思考副行保留');
});

test('v301 today tip: weighted speed banded, retry row2, models scroll zone, seconds time', () => {
  const tip = noStyle(render(todayFixture()));
  assert.match(tip, /<b class="zu-teal">151\.6<\/b> <small>t\/s<\/small>/, '今日加权速度档色（151.6∈较快档 zu-teal）');
  // VM 桩 secLong 直出：锁定接线（真实 s/m/h 换算由 v300.2 切片验证覆盖）
  assert.match(tip, /总耗时<\/div><div class="zu-stat-v">12301150<\/div>/, '总耗时=Σ生成耗时（secLong 换算入参）');
  assert.match(tip, /zu-turn-models/, '模型表在独立滚动区');
  assert.match(tip, /zu-pj-mhead[^]*?模型明细/, '标题行固定在滚动区外');
  // v302.3：标题行右侧工具调用/重试（同本轮/会话形态），不再显「按用量排序」
  assert.match(tip, /工具调用 1127 次<i class="zu-turn-sep">·<\/i>重试 7 次/, 'mhead 右=工具调用·重试');
  assert.doesNotMatch(tip, /按用量排序/);
  const noTools = noStyle(render(todayFixture({ tool_calls: 0, retries: 0 })));
  assert.match(noTools, /按用量排序/, '均无时回退按用量排序');
  const oldSnap = noStyle(render(todayFixture({ tool_calls: undefined })));
  assert.match(oldSnap, /重试 7 次/, '旧快照缺 tool_calls 只显重试段');
  assert.match(tip, /2026-11-08 00:49:45 — 2026-11-08 22:36:40/, '秒级时间范围');
});

test('v302.2 today tip: honest degradation for missing aggregates, empty models', () => {
  const bare = noStyle(render(todayFixture({
    avg_duration_ms: undefined, avg_ttft_ms: undefined, avg_tps: undefined, duration_ms: undefined,
  })));
  assert.doesNotMatch(bare, /平均耗时|平均延迟|总耗时/, '耗时字段缺失=行三整行收起不伪造');
  assert.match(bare, /请求会话<\/div><div class="zu-stat-v">109<\/div>/, '规模行不随耗时降级');
  assert.match(bare, /平均输出速度<\/div><div class="zu-stat-v">—</, '速度缺失显 —');
  const noModels = noStyle(render(todayFixture({ models: [] })));
  assert.doesNotMatch(noModels, /模型明细|zu-pj-mhead|zu-turn-models/, '无模型不渲染空表');
  const noData = noStyle(render(todayFixture({ sessions: 0 })));
  assert.match(noData, /请求会话<\/div><div class="zu-stat-v">0<\/div>/, '0 会话=真实计数非伪造');
});

test('v301 today tip: cost gating collapses fee; EN locale stable', () => {
  const off = stripAll(render(todayFixture(), 'zh', 0));
  assert.doesNotMatch(off, /预估费用/);
  assert.match(off, /输出速度/, '速度格仍在');
  const en = stripAll(render(todayFixture(), 'en'));
  assert.match(en, /Today/);
  assert.match(en, /All sessions today/);
  assert.match(en, /Avg time/);
  assert.match(en, /Avg TTFT/);
  assert.match(en, /Sessions/);
  assert.match(en, /Avg output rate/);   // v302.2 改名（小写 o，非旧 Output rate）
  assert.match(en, /cache hit 99%/);
});

test('review fix: explicit zeros degrade honestly (today avg_tps 0 → —, duration 0 → mid row collapses)', () => {
  const zeroTps = noStyle(render(todayFixture({ avg_tps: 0 })));
  assert.match(zeroTps, /平均输出速度<\/div><div class="zu-stat-v">—</, 'avg_tps 0 renders — (real zusage zero-rated-segments shape)');
  assert.doesNotMatch(zeroTps, />0(\.0)?<\/b> <small>t\/s</, 'no fake 0 t/s reading');
  const zeroDur = noStyle(render(todayFixture({ avg_duration_ms: 0, avg_ttft_ms: 0, duration_ms: 0 })));
  assert.doesNotMatch(zeroDur, /zu-turn-kpis--mid/, 'all-zero durations collapse the mid row (undefined-only coverage before)');
  const oldRemote = noStyle(render(todayFixture({ turns: undefined, sessions: undefined })));
  assert.match(oldRemote, /请求轮数<\/div><div class="zu-stat-v">—</, 'missing turns field (old remote snapshot) renders — not fake 0');
  assert.match(oldRemote, /请求会话<\/div><div class="zu-stat-v">—</, 'missing sessions field renders — not fake 0');
});
