const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');
const { sliceOverlay } = require('./helpers/overlay-extract.cjs');

/* v299「本轮」tooltip 500×350 紧凑布局（用户 /goal）专用回归：
 * 三行 KPI 固定顺序、缓存命中/工具调用保留、速度档位色文字、费用开关、
 * 多模型区内滚、诚实降级、作用域隔离（不影响会话/今日/项目/工具/速度卡）。 */

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
  return context.html(data).tips.filter(Boolean).find(t => t.includes('zu-stat-tip--turn'));
}

function fixture(over, proj) {
  const start = new Date(2026, 10, 8, 20, 42, 28).getTime();
  const end = new Date(2026, 10, 8, 20, 46, 14).getTime();
  return {
    session: Object.assign({ started: start, last_at: end, turns: 628 },
      proj ? { project: Object.assign({ total: 1, requests: 1 }, proj) } : {}),
    last: { tps: 147.8, startedAt: start, endedAt: end },
    last_turn: Object.assign({
      requests: 17, total: 4601400, input: 4593200, output: 8172, cache_read: 4593200,
      reasoning: 300, tps: 147.8, avg_duration_ms: 6500, avg_ttft_ms: 3200, duration_ms: 226500,
      cost_usd: 2.7, tool_calls: 16, retries: 1, tool_errors: 0,
      started: start, ended: end,
      models: [{ model: 'GLM-5.3-FlashX', requests: 17, total: 4601400, cost_usd: 2.7, rates: {} }],
    }, over || {}),
    today: { started: start, last_at: end },
  };
}
const stripAll = s => s.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '');
const noStyle = s => s.replace(/<style>[\s\S]*?<\/style>/g, '');   /* 剥 style 留标签：类名/结构切片用 */

test('v299 turn tip: 450 wide auto-height scoped style with hygiene guards', () => {
  const tip = render(fixture());
  const style = (tip.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
  assert.match(style, /zusage-tip-root:has\(\.zu-stat-tip--turn\)\{width:min\(450px,calc\(100vw - 16px\)\)!important/);
  assert.match(style, /max-height:calc\(100vh - 24px\)!important/);
  assert.doesNotMatch(style, /\.zusage-tip-root:has\(\.zu-stat-tip--turn\)\{[^}]*height:\d/);   // 高度自适应：不写定高
  assert.match(style, /box-sizing:border-box!important/);
  // 作用域隔离：每条规则的选择器都必须锚定本轮卡（zu-turn-* 自有类或 --turn/:has 作用域），
  // 裸 .zu-stat-* / .tip / .tbody 选择器会波及其余五张统计卡=红
  for (const rule of style.replace(/^<style>/, '').replace(/<\/style>$/, '').split('}')) {
    const sel = rule.split('{')[0].trim();
    if (!sel) continue;
    assert.ok(
      /zu-turn-|^\.zu-stat-tip--turn|:has\(\.zu-stat-tip--turn\)/.test(sel),
      '越域选择器: ' + sel);
  }
  // tip 本体/滚动层禁注入 display（inline display:none 被压死=永不消失的既有事故形态）。
  // v299.1：逐规则匹配（[^{] 可跨 }，宽泛形态会误命中后续 ::-webkit-scrollbar 的 display）
  const ruleBodies = style.replace(/^<style>/, '').replace(/<\/style>$/, '').split('}');
  for (const r of ruleBodies) {
    if (/^\.zusage-tip-root:has\(\.zu-stat-tip--turn\)\{/.test(r.trim()) ||
        /^\.zusage-tip-root:has\(\.zu-stat-tip--turn\) \.tbody\{/.test(r.trim())) {
      assert.doesNotMatch(r, /display/, 'tip/tbody 禁注入 display: ' + r.trim().slice(0, 60));
    }
  }
});

test('v302 turn tip: four KPI rows in fixed order with request scale row', () => {
  const tip = stripAll(render(fixture()));
  const labels = ['总用量', '输入', '输出', '请求次数', '请求轮数', '请求会话',
    '平均耗时', '平均延迟', '总耗时', '平均输出速度', '预估费用'];
  const idx = labels.map(k => tip.indexOf(k));
  for (let i = 0; i < idx.length - 1; i++) assert.ok(idx[i] >= 0 && idx[i] < idx[i + 1], '行序错: ' + labels[i]);
  const raw = noStyle(render(fixture()));
  assert.match(raw, /zu-turn-kpis--mid/, '耗时行容器');
  assert.match(raw, /zu-turn-kpis--duo/, '速度行容器');
  // 行二数值：请求次数=本轮 17、请求轮数=会话累计 628、请求会话=项目缺失诚实显 —
  assert.match(raw, /请求次数<\/div><div class="zu-stat-v">17<\/div>/);
  assert.match(raw, /请求轮数<\/div><div class="zu-stat-v">628<\/div>/);
  assert.match(raw, /请求会话<\/div><div class="zu-stat-v">—</);
  const withProj = noStyle(render(fixture({}, { sessions: 24 })));
  assert.match(withProj, /请求会话<\/div><div class="zu-stat-v">24<\/div>/, '项目会话数可用时真实显示');
});

test('v302 turn tip: 11 KPI label icons aligned with today/session cards', () => {
  const raw = render(fixture());
  assert.equal((noStyle(raw).match(/zu-kpi-ico/g) || []).length, 11, '本轮卡图标恰 11 枚（3+3+3+2）');
  // 规模行新图标：请求=纸飞机、会话=文件夹；耗时行沙漏/速度表盘/费用硬币沿用
  for (const sig of ['M5 22h14', 'm22 2-7 20-4-9-9-4Z', 'M7.5 3h12a2 2 0 0 1 2 2v10',
    'M4.9 19a9 9 0 1 1', 'ellipse cx="12" cy="5"']) {
    assert.ok(raw.includes(sig), '图标路径缺失: ' + sig);
  }
  // 图标在标签文字之前（k + 文本顺序）
  assert.match(raw, /zu-kpi-ico[^]*?<\/svg>总用量</, '图标紧贴标签文字之前');
});

test('v299 turn tip: cache hit under input cell, reasoning under output', () => {
  const raw = noStyle(render(fixture()));   // 剥 style 留标签：选择器文本会污染 indexOf
  const inputKpi = raw.slice(raw.indexOf('>输入<'), raw.indexOf('>输出<'));
  // v299.1：缓存改「缓存 N%」内联在输入值右侧（.zu-stat-v 内，不在 dsub 辅助行）
  assert.match(inputKpi, /<span class="hit zu-turn-hit">缓存100%<\/span>/);   // v299.1：zh 无空格（间距由 margin 提供）
  assert.doesNotMatch(inputKpi, /缓存命中/);
  const outKpi = raw.slice(raw.indexOf('>输出<'), raw.indexOf('zu-turn-kpis--mid'));
  assert.match(outKpi, /含思考/);
});

test('v299 turn tip: speed value banded by TPS_BANDS, plain text emphasis only', () => {
  const raw = render(fixture());
  // 147.8 t/s ∈ 流畅档 70–150 → cls "ok"（全局 .ok{color} 文字色，无背景）
  assert.match(raw, /<b class="ok">147\.8<\/b> <small>t\/s<\/small>/);
  assert.match(raw, /输出速度/);
  assert.doesNotMatch(raw, /zu-speed-bandtag/, '不使用速度胶囊');
});

test('v299 turn tip: tool calls merged into models head right, scale row gone', () => {
  const tip = render(fixture());
  assert.match(tip, /zu-pj-mhead[^㎡]*?模型明细[\s\S]*?工具调用 16 次/);
  assert.match(tip, /重试 1 次/);
  assert.doesNotMatch(stripAll(tip).replace(/工具调用 16 次[\s\S]*$/, ''), /工具调用/, 'scale 行已删（仅标题行右侧一处）');
  assert.doesNotMatch(tip, /zu-stat-scale/, 'scale 行容器不再输出');
  // 无工具信息回退「按用量排序」；无 models 时整块不渲染
  const noTools = render(fixture({ tool_calls: 0, retries: 0, tool_errors: 0 }));
  assert.match(noTools, /按用量排序/);
  const noModels = render(fixture({ models: [] }));
  assert.doesNotMatch(noModels.replace(/<style>[\s\S]*?<\/style>/g, ''), /模型明细|zu-pj-mhead/);
});

test('v299 turn tip: cost gating leaves no empty card', () => {
  const off = noStyle(render(fixture(), 'zh', 0));
  assert.doesNotMatch(off, /预估费用/, '费用关：KPI 格与模型表费用列一并消失');
  assert.doesNotMatch(off, /tip-fxq/);
  assert.match(off, /zu-turn-kpis--duo/, '行三仍在');
  const duo = off.slice(off.indexOf('zu-turn-kpis--duo'), off.indexOf('zu-turn-models'));
  assert.match(duo, /输出速度/, '速度格存在');
  assert.equal((duo.match(/zu-stat-kpi"?/g) || []).length, 1, 'duo 行仅剩速度一格（无空费用占位）');
  // 快照缺 cost_usd：KPI 格不渲染（不显假 0）；费用开关开时模型表费用列保留（行内缺价显 —）
  const noFee = noStyle(render(fixture({ cost_usd: undefined })));
  const duoN = noFee.slice(noFee.indexOf('zu-turn-kpis--duo'), noFee.indexOf('zu-turn-models'));
  assert.doesNotMatch(duoN, /tip-fxq|¥|\$/, 'KPI 费用格不渲染');
});

test('v299 turn tip: multi-model table sorted desc inside scroll zone', () => {
  const many = Array.from({ length: 10 }, (_, i) => (
    { model: 'model-' + i, requests: 1, total: 1000 - i, cost_usd: 0.1 }));
  const raw = noStyle(render(fixture({ models: many })));
  assert.match(raw, /zu-turn-models/, '模型区独立滚动容器');
  const zone = raw.slice(raw.indexOf('zu-turn-models'), raw.indexOf('zu-stat-time'));
  assert.equal((zone.match(/<tr>/g) || []).length, 11, '表头+10 行全渲染（区内滚动承载）');
  const names = [...stripAll(zone).matchAll(/model-\d/g)].map(m => m[0]);
  assert.deepEqual(names.slice(0, 3), ['model-0', 'model-1', 'model-2'], '按 Token 用量降序');
  // 长模型名：title 属性完整名可访问
  const longRaw = render(fixture({ models: [{ model: 'x'.repeat(80), requests: 1, total: 5, cost_usd: 0.01 }] }));
  assert.match(longRaw, /title="x{20}/, '完整名进 title');
});

test('v299 turn tip: honest degradation without fake zeros', () => {
  const noTps = noStyle(render(fixture({ tps: undefined })));
  assert.match(noTps, /输出速度<\/div><div class="zu-stat-v">—</);
  const noTiming = noStyle(render(fixture({ avg_duration_ms: 0, avg_ttft_ms: 0, duration_ms: 0 })));
  assert.doesNotMatch(noTiming, /zu-turn-kpis--mid/, '耗时全缺=整行不渲染（不伪造 0s）');
  const partial = noStyle(render(fixture({ avg_duration_ms: 0 })));
  const mid = partial.slice(partial.indexOf('zu-turn-kpis--mid'), partial.indexOf('zu-turn-kpis--duo'));
  assert.doesNotMatch(mid, /平均耗时/, '缺失格不渲染');
  assert.match(mid, /平均延迟/, '存在格照常');
  assert.match(partial, /2026-11-08 20:42:28 — 2026-11-08 20:46:14/, '秒级时间范围');
});

test('v299 turn tip: long value shrink buckets', () => {
  const raw = render(fixture({ total: 123456789012, input: 123456789012 }));
  assert.match(raw, /zu-turn-l2/, '>14 字符降 2 档字号');
  const mid = render(fixture({ total: 1234567890 }));
  assert.match(mid, /zu-turn-l1/, '>10 字符降 1 档字号');
});

test('v299 turn tip: english locale', () => {
  const en = render(fixture(), 'en');
  assert.match(en, /Latest turn/);
  assert.match(en, /Total tokens/);
  assert.match(en, /cache 100%/);   // v299.1：内联短文案
  assert.match(en, /tools 16 calls/);
});

test('review fix: explicit zeros degrade honestly (turn avg_tps/duration 0 → — or collapse, never fake 0)', () => {
  const zeroTps = noStyle(render(fixture({ tps: 0 })));
  assert.match(zeroTps, /平均输出速度<\/div><div class="zu-stat-v">—</, 'avg_tps 0 renders — (real zusage zero-rated-segments shape)');
  assert.doesNotMatch(zeroTps, />0(\.0)?<\/b> <small>t\/s</, 'no fake 0 t/s reading');
  const zeroDur = noStyle(render(fixture({ avg_duration_ms: 0, avg_ttft_ms: 0, duration_ms: 0 })));
  assert.doesNotMatch(zeroDur, /zu-turn-kpis--mid/, 'all-zero durations collapse the mid row');
  assert.match(noStyle(render(fixture({ avg_duration_ms: 0 }))), /zu-turn-kpis--mid/, 'partial zero keeps the row for remaining fields');
});
