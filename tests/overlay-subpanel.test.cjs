const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { getNamedSlice } = require('./helpers/overlay-extract.cjs');

const positionSource = getNamedSlice('positionSubPop');

/* v217：统一浮层定位——优先入口上方 12px，左右夹紧 12px；入口 rect 全零回退条锚；
 * 入口断连即关（无法确认归属）。 */
function position({ entryLeft = 800, entryWidth = 80, entryTop = 600, entryH = 20,
  panelWidth = 820, panelHeight = 500, viewportWidth = 1200, viewportHeight = 800,
  barLeft = 400, barTop = 600, entry = 'live', theme = 'default' } = {}) {
  const style = {};
  const rects = {
    entry: { left: entryLeft, width: entryWidth, top: entryTop, height: entryH },
    bar: { left: barLeft, width: 100, top: barTop, height: 20 },
  };
  const entryEl = entry === 'live' ? { isConnected: true, getBoundingClientRect: () => rects.entry }
    : entry === 'gone' ? { isConnected: false, getBoundingClientRect: () => rects.entry }
    : null;
  const context = {
    window: { innerWidth: viewportWidth, innerHeight: viewportHeight },
    subPopOpen: () => true,
    subPopEntry: entryEl,
    subPopClose: (r, cause) => { context.closed = cause; },
    subPanel: { offsetWidth: panelWidth, offsetHeight: panelHeight, style },
    bar: { getBoundingClientRect: () => rects.bar },
    state: { theme },
  };
  vm.runInNewContext(positionSource + '\npositionSubPop();', context);
  return { style, context };
}

test('popover centers above the entry and clamps to the left edge', () => {
  const { style } = position();
  assert.equal(style.left, '368px');   // 中心 840 − 410 = 430 → 钳右缘 1200−820−12
  assert.equal(style.top, '88px');     // 600 − 500 − 12
});

test('popover stays inside the viewport edges (12px)', () => {
  const { style } = position({ entryLeft: 1100 });
  assert.equal(style.left, '368px');   // 1200 − 820 − 12
  const l = position({ entryLeft: 10 });
  assert.equal(l.style.left, '12px');
});

test('popover flips below the entry when the space above is insufficient', () => {
  const { style } = position({ entryTop: 300 });   // 300 − 512 < 12 → 下方
  assert.equal(style.top, '288px');   // 332 + 500 > 788 → 钳底边 800−500−12
});

test('zero-rect entry falls back to the bar anchor; a detached entry closes the popover', () => {
  const fb = position({ entry: 'zero' });
  assert.equal(fb.style.left, '40px');   // bar 中心 450 − 410 = 40，未触边
  assert.equal(fb.style.top, '88px');
  const g = position({ entry: 'gone' });
  assert.equal(g.context.closed, 'entry-gone');
});

/* v217：buildSubPop 签名幂等——同数据重复推送不重建（保持滚动/焦点/选择），数据真变才重建 */
{
  const buildSource = getNamedSlice('buildSubPop');   // 从 subPopItems 起：状态变量（subPopSel/sig/mode）由 ctx 注入

  function makePanel() {
    const panel = { children: [], classList: { add() {}, remove() {}, toggle() {}, contains: () => false } };
    Object.defineProperty(panel, 'innerHTML', {
      get() { return ''; },
      set(v) { panel.children.length = 0; panel.__html = v; },   // 对齐真 DOM：赋值即清子节点
      configurable: true,
    });
    panel.querySelector = () => null;
    panel.querySelectorAll = () => [];
    return panel;
  }
  function runBuild(panel, sub, sel, over) {
    const ctx = {
      subPopSel: sel || '', subPopMode: 'pinned', subPopSig: panel.__zuSig || '',
      subPanel: panel, subRate: { slots: {} }, state: { cost: 1 },
      pickedSid: 'sid_main', subPopSess: 'sid_main',
      L: (a) => a, ttEsc: (a) => String(a), escAttr: (a) => String(a),
      fmt: () => '1', countFmt: () => '1', fmtMoney: () => '¥1', fmtTime: () => '12:00', fmtStartS: () => '2026-01-01 00:00:00',
      sec: (v) => v + 's', secLong: (v) => v + 'ms',   // v304 耗时行格式化桩（直出入参锁定接线）
      tpsBand: () => null, FXQ_ICON: '<svg class="tip-fxq"></svg>',
      fxqIcon: (models, scope) => '<svg class="tip-fxq" data-mcount="' + (models ? models.length : 0) + '" data-mscope="' + scope + '"></svg>',   // v248：KPI 问号随卡携带模型上下文（实例闭包函数，切片外桩）
      subPopIco: () => '<svg></svg>',
      kpiIco: (name) => '<svg class="zu-kpi-ico" data-ico="' + name + '"></svg>',   // v304 四行 KPI 图标（07 分片单源，桩记名断言用）
      subRateSlotText: () => 'est', JSON,
      ...(over || {}),
    };
    ctx.subPopSel = (panel.__zuSel = sel !== undefined ? sel : (panel.__zuSel || ''));
    ctx.sub = sub;
    vm.runInNewContext(buildSource + '\nbuildSubPop(sub);', ctx);
    panel.__zuSig = ctx.subPopSig;
    return ctx;
  }

  test('unified popover is not rebuilt while open when the pushed data is unchanged', () => {
    const sub = { total: 100, active: false, requests: 3, cost_usd: 0.5, models: [],
      list: [{ task: 'probe', title: 't', agent: 'zcode-gen', sid: 'sess_subagent_abcd1234',
        input: 1, output: 2, cache_read: 0, reasoning: 0, cache_write: 0, requests: 1, tps_avg: 10, last: 123 }] };
    const panel = makePanel();
    runBuild(panel, sub, '');
    assert.ok(panel.__html && panel.__html.includes('zu-spnav'), 'first build renders shell');
    const marker = { marker: true };
    panel.children.push(marker);
    runBuild(panel, sub, '');
    assert.ok(panel.children.includes(marker), 'same data → DOM untouched (sig early-return)');
    runBuild(panel, Object.assign({}, sub, { total: 200 }), '');
    assert.ok(!panel.children.includes(marker), 'changed data → rebuilt');
    assert.ok(panel.__html.includes('zu-spnav'), 'rebuilt popover renders shell');
  });

  test('unified popover renders summary KPIs, cost and model table from real fields', () => {
    const sub = { total: 100, active: false, requests: 3, cost_usd: 0.5, rate_avg: 90,
      input: 60, output: 30, cache_read: 40, models: [
        { model: 'glm-x', total: 100, requests: 3, cost_usd: 0.5 }] };
    const panel = makePanel();
    runBuild(panel, sub, '');
    const html = panel.__html;
    assert.ok(html.includes('zu-sp-kpis3'), 'primary KPI band');
    assert.ok(html.includes('预估费用'), 'cost KPI present');
    assert.ok(html.includes('预估费用<svg class="tip-fxq" data-mcount="1" data-mscope="子代理累计"'), 'v248 KPI ? icon carries card model context');
    assert.ok(html.includes('zu-sp-models'), 'model table present');
    assert.ok(html.includes('tip-fxq" data-model="glm-x"'), 'per-model ? icon carries data-model');
    assert.ok(!html.includes('查看子代理明细'), 'old CTA removed');
    assert.ok(!html.includes('Enter'), 'no Enter keycap');
  });

  test('v304 summary: four KPI rows, cache badge inline on input label, honest turns degradation', () => {
    const sub = { total: 100, active: false, requests: 3, cost_usd: 0.5, rate_avg: 90,
      turns: 2, avg_duration_ms: 1500, avg_ttft_ms: 800, duration_ms: 4200,
      input: 60, output: 30, cache_read: 40, cache_write: 5, reasoning: 6, models: [] };
    const panel = makePanel();
    runBuild(panel, sub, '');
    const html = panel.__html;
    // 行一：缓存徽标随输入标签右侧（v304 不再占独立副行/独立缓存命中格）
    assert.ok(html.includes('>输入<span class="hit">缓存67%</span>'), '缓存徽标随输入标签（40/60=67%）');
    assert.ok(!html.includes('缓存命中率'), '长文案与独立副行已退役');
    assert.ok(html.includes('含思考'), '输出辅助行=含思考');
    // 行二：请求规模三格（轮数/会话为真实字段）
    assert.ok(html.includes('请求轮数'), '行二轮数格');
    assert.ok(html.includes('请求会话'), '行二会话格');
    // 行三：耗时聚合（>0 门控渲染，mid 容器）
    assert.ok(html.includes('zu-sp-kpis3--mid'), '耗时行容器');
    assert.ok(html.includes('平均耗时') && html.includes('平均延迟') && html.includes('总耗时'), '耗时三格');
    // 行四：duo 速度+费用
    assert.ok(html.includes('zu-sp-kpis3--duo'), '速度行容器');
    assert.ok(!html.includes('zu-sp-usage') && !html.includes('zu-sp-rate'), '旧二行 KPI/速率行已退役');
    // 旧快照：轮数/耗时缺字段 → — / 行三收起（不伪造 0）
    const oldSnap = Object.assign({}, sub, { turns: undefined, avg_duration_ms: undefined, avg_ttft_ms: undefined, duration_ms: undefined });
    const p2 = makePanel();
    runBuild(p2, oldSnap, '');
    assert.ok(p2.__html.includes('>请求轮数</div><div class="v">—</div>'), '轮数缺失显 —');
    assert.ok(!p2.__html.includes('zu-sp-kpis3--mid'), '耗时字段缺失=行三收起');
  });

  test('v304 detail view: four rows keyed to this sub-session, estimate kept in subrate slot', () => {
    const sub = { total: 100, active: false, requests: 3, cost_usd: 0.5, models: [],
      list: [{ task: 'probe', title: 't', agent: 'zcode-gen', sid: 'sess_subagent_abcd1234',
        input: 60, output: 30, cache_read: 40, cache_write: 5, reasoning: 6, requests: 1, tps_avg: 88,
        turns: 1, avg_duration_ms: 900, avg_ttft_ms: 400, duration_ms: 1200, last: 123,
        models: [{ model: 'glm-x', total: 100, requests: 1 }] }] };
    const panel = makePanel();
    runBuild(panel, sub, 'sess_subagent_abcd1234', { tpsBand: () => ({ cls: 'tps-fast', zh: '快', en: 'fast' }) });
    const html = panel.__html;
    assert.ok(/tps-fast[^<]*<\/b><small> t\/s<\/small>/.test(html), '平均输出速度档色值 + t/s 单位（行四）');
    assert.equal((html.match(/平均输出速度/g) || []).length, 1, '明细页速度仅行四一处');
    assert.ok(html.includes('请求会话'), '行二会话格（本项=单子会话，计 1 为分组真值）');
    assert.ok(html.includes('总耗时'), '行三总耗时（secLong 入参）');
    assert.ok(html.includes('zu-sp-models'), '模型明细保留');
  });
}
