const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* v95 Web 精简模式（与桌面 v146 同期、独立实现）：切片验证主题键/归一、chips 挂载锚与
 * 门控、tooltip 摘要与设置入口接线。Web/overlay.js 是独立实现（web.md），不与桌面共用
 * 夹具；此处只做源码切片级回归，端到端需自托管旁挂实机验收。 */
const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'overlay.js'), 'utf8');
function extract(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'anchor hit: ' + start);
  return source.slice(a, b);
}

test('theme key: default off, compact opt-in via localStorage, illegal values fall back', () => {
  const stateSource = extract('  var LS = {', '  /* ---------- 多实例注册表');
  function boot(stored) {
    const store = Object.assign({}, stored);
    const context = {
      window: {},
      localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
    };
    vm.runInNewContext(stateSource, context);
    return { context, store };
  }
  assert.equal(boot({}).context.state.theme, 'default');
  assert.equal(boot({ 'zusage3.theme': 'compact' }).context.state.theme, 'compact');
  assert.equal(boot({ 'zusage3.theme': 'pill' }).context.state.theme, 'default', 'web has no pill tier');
  assert.equal(boot({ 'zusage3.theme': 'bogus' }).context.state.theme, 'default');
  const { context, store } = boot({ 'zusage3.theme': 'compact' });
  context.state.theme = 'default';
  vm.runInNewContext('persist();', context);
  assert.equal(store['zusage3.theme'], 'default', 'persist round-trips the theme key');
});

test('setBarTheme normalizes and reapplies on every instance', () => {
  const fnSource = extract('  function setBarTheme(', '  var remoteCache = {};');
  const applied = [];
  const store = {};
  const ctx = {
    state: { theme: 'default' }, LS: { theme: 'zusage3.theme' },
    lsSet: (k, v) => { store[k] = v; },
    instances: [{ applyBarTheme: () => applied.push(1) }, { applyBarTheme: () => applied.push(2) }],
  };
  vm.runInNewContext(fnSource + '\nsetBarTheme("compact");', ctx);
  assert.equal(ctx.state.theme, 'compact');
  assert.equal(store['zusage3.theme'], 'compact');
  assert.deepEqual(applied, [1, 2]);
  vm.runInNewContext('setBarTheme("nonsense");', ctx);
  assert.equal(ctx.state.theme, 'default');
});

test('chips: toolbar anchor with trailing-actions fallback, gates, and signature-idempotent markup', () => {
  // 挂载锚：优先 data-composer-trailing-actions，缺失退行尾（insertBefore(el, null)）
  assert.match(source, /row\.querySelector\("\[data-composer-trailing-actions\]"\)/);
  assert.match(source, /insertBefore\(chip, anchor\)/);
  // 门控：非精简主题摘除；上下文 chip 跟随逐格开关
  assert.match(source, /if \(state\.theme !== "compact" \|\| inactive\(\)\) \{ restoreTpsChip\(\); return; \}/);
  assert.match(source, /state\.theme !== "compact" \|\| !state\.show\.ctx \|\| inactive\(\)/);
  // 无有效样本不渲染（与桌面口径一致）；速率视图同源 zuBarSpeedView / tpsBand 回退
  assert.match(source, /tpsChipData\(\)/);
  assert.match(source, /zuBarSpeedView\(liveStatsCur, bridge\.handle && bridge\.handle\.charsPerToken\)/);
  // 挤位兜回 + 复用遗留节点防双 chip
  assert.match(source, /chip\.nextElementSibling !== anchor/);
  assert.match(source, /indexOf\(cls\) >= 0/);
});

test('tooltip wiring: chip branch in the document mousemove, settings + sub-panel click delegates', () => {
  // 条外 chips 悬停接进实例 tip（document 捕获）
  assert.match(source, /t\.closest\("\.zu-tsb,\.zu-ctxb"\)/);
  // tip 内按钮/子代理行点击委托（先取 tipFor 再 hide，避免空引用）
  assert.match(source, /closest\("\.tps-cfg"\)/);
  assert.match(source, /closest\("\.tps-subrow"\)/);
  const delegate = extract('tip.addEventListener("click", function (e) {\n      if (inactive() || !tipFor) return;', '}, true);');
  assert.match(delegate, /hideTip\(true, "chip-cfg"\)/);
  assert.match(delegate, /panel\.classList\.add\("open"\)/);
  assert.match(delegate, /toggleSubPanel\(\)/);
});

test('compact plumbing: bar keep-alive in heavy, early return in track, panel anchors on the card', () => {
  assert.match(source, /if \(state\.theme === "compact"\) \{\s*\n\s*\/\* v95 精简模式：条常驻 body/);
  assert.match(source, /if \(state\.theme === "compact"\) \{ syncTpsChip\(\); return; \}/);
  assert.match(source, /v95：精简模式条 rect 为 0，几何\/宽度改锚输入卡/);
  assert.match(source, /state\.theme === "compact" && tpsChipCache && tpsChipCache\.isConnected/);
  // dispose 摘除 chips，全局清理选择器覆盖 tooltip（.tip .zusage-* 链）
  assert.match(source, /restoreTpsChip\(\);   \/\/ v95：摘除精简模式速率 chip/);
  assert.match(source, /restoreCtxChip\(\);   \/\/ v95：摘除上下文 chip/);
});

test('chip styles: explicit font spec (quota-chip parity) and hover hit area', () => {
  const css = extract('".zu-tsb,.zu-ctxb{', '.zu-ctxb .cbar');
  assert.match(css, /font-size:calc\(var\(--text-ui-base,var\(--ui-font-size,14px\)\) - 1px\)/);
  assert.match(css, /font-weight:700/);
  assert.match(css, /font-variant-numeric:tabular-nums/);
  assert.match(source, /\.zu-tsb:hover,\.zu-tsb:focus-visible,\.zu-ctxb:hover,\.zu-ctxb:focus-visible\{background:var\(--color-hover/);
});
