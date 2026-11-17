const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/quota-chip-harness.cjs');

/* v382 套餐额度芯片四级响应式：纯函数与 DOM 行为测试。
 * 复用 overlay-quota-chip.test.cjs 的成熟整 IIFE 夹具（含 instances 接缝）；纯函数经
 * window.__zusageQuotaFns 访问。真实 CSS 几何由 CDP/Chrome 套件覆盖，此处不冒充几何验收。 */
function booted(prefs = {}) {
  const h = harness({ prefs });
  h.inject(); h.boot(); h.tick();
  return h;
}
const F = h => h.window.__zusageQuotaFns.all();
const band = (b, p) => p >= 100 ? 'zu-qb-exc' : p >= 90 ? 'zu-qb-crit' : p >= 50 ? 'zu-qb-mid' : 'zu-qb-calm';
const Q = windows => ({ status: 'ok', providerId: 'account:bigmodel-individual-coding-plan', fetchedAt: Date.now(),
  stale: false, error: '', level: 'max', windows, plan: { productName: 'P' }, tools: {}, models: [] });

test('pickQuotaPrimary: default prefers short-period window in original order', () => {
  const f = F(booted());
  assert.ok(f, 'pure-function seam exposed');
  const segs = [
    { key: 'monthly', label: '月', pct: 5 },
    { key: 'fiveHour', label: '5时', pct: 3 },
    { key: 'weekly', label: '7天', pct: 1 },
  ];
  assert.equal(f.pickQuotaPrimary(segs).key, 'fiveHour');
  assert.equal(f.pickQuotaPrimary([{ key: 'plan', label: '套餐', pct: 2 }]).key, 'plan');
  assert.equal(f.pickQuotaPrimary([]), null);
});

test('pickQuotaPrimary: danger window wins, severity then original order, stable on tremor', () => {
  const pick = F(booted()).pickQuotaPrimary;
  const segs = [
    { key: 'fiveHour', label: '5时', pct: 3 },
    { key: 'weekly', label: '7天', pct: 92 },
    { key: 'monthly', label: '月', pct: 2 },
  ];
  assert.equal(pick(segs).key, 'weekly', '92% weekly outranks calm short window');
  const tremor = segs.map(s => s.key === 'weekly' ? { ...s, pct: 90 } : s);
  assert.equal(pick(tremor).key, 'weekly', 'still weekly on 92→90 tremor');
  const exc = segs.map(s => s.key === 'monthly' ? { ...s, pct: 105 } : s);
  assert.equal(pick(exc).key, 'monthly', 'exc(>=100) outranks crit(90)');
  const twoCrit = [{ key: 'fiveHour', label: '5时', pct: 95 }, { key: 'weekly', label: '7天', pct: 91 }];
  assert.equal(pick(twoCrit).key, 'fiveHour', 'same severity → original order');
});

test('quotaCandidates: L0 full, L1 short labels, L2 primary+N, L3 icon+value, L3I icon-only; aria keeps all windows', () => {
  const f = F(booted());
  const mode = { kind: 'value', segs: [
    { key: 'fiveHour', label: '5时', pct: 26 }, { key: 'weekly', label: '7天', pct: 92 }, { key: 'monthly', label: '月', pct: 8 },
  ], rem: false, warn: '' };
  const c = f.quotaCandidates(mode, 'zh', false, f.QUOTA_BANDS, band);
  assert.match(c.L0.html, /5时/); assert.match(c.L0.html, /7天/); assert.match(c.L0.html, /月/);
  assert.match(c.L1.html, /5时/); assert.match(c.L1.html, /7天/); assert.match(c.L1.html, /月/);
  assert.match(c.L2.html, /7天/); assert.match(c.L2.html, /92%/); assert.match(c.L2.html, /\+2/);
  assert.doesNotMatch(c.L2.html, /5时/);
  assert.match(c.L3.html, /zu-qico/); assert.match(c.L3.html, /7天/); assert.match(c.L3.html, /92%/);
  assert.match(c.L3I.html, /zu-qico/); assert.doesNotMatch(c.L3I.html, /92%/); assert.doesNotMatch(c.L3I.html, /5时/);
  for (const k of ['L0','L1','L2','L3','L3I']) {
    assert.match(c[k].aria, /5时 26%/);
    assert.match(c[k].aria, /7天 92%/);
    assert.match(c[k].aria, /月 8%/);
  }
});

test('quotaCandidates: L2 +N counts only hidden valid windows; single window has no +N', () => {
  const f = F(booted());
  const one = f.quotaCandidates({ kind: 'value', segs: [{ key: 'fiveHour', label: '5时', pct: 5 }], rem: false, warn: '' }, 'zh', false, f.QUOTA_BANDS, band);
  assert.doesNotMatch(one.L2.html, /\+N|\+1|\+0/);
  const three = f.quotaCandidates({ kind: 'value', segs: [
    { key: 'fiveHour', label: '5时', pct: 5 }, { key: 'weekly', label: '7天', pct: 6 }, { key: 'monthly', label: '月', pct: 7 },
  ], rem: false, warn: '' }, 'zh', false, f.QUOTA_BANDS, band);
  assert.match(three.L2.html, /\+2/);
});

test('quotaCandidates: quotaRemain flips numbers but never band or primary selection', () => {
  const f = F(booted());
  const mode = { kind: 'value', segs: [{ key: 'fiveHour', label: '5时', pct: 26 }, { key: 'weekly', label: '7天', pct: 92 }], rem: true, warn: '' };
  const remain = f.quotaCandidates(mode, 'zh', true, f.QUOTA_BANDS, band);
  assert.match(remain.L0.html, /74%/); assert.match(remain.L0.html, /8%/);
  assert.match(remain.L2.html, /7天/); assert.match(remain.L2.html, /8%/);
  assert.match(remain.L2.html, /zu-qb-crit/, 'band follows raw used 92, not remaining 8');
});

test('quotaCandidates: non-window modes keep original html/aria verbatim (balance/info/team/error)', () => {
  const f = F(booted());
  const m = { kind: 'balance', html: '<span class="zu-qseg zu-qb-calm">余额 ¥100.00</span>', aria: '余额 ¥100.00' };
  const c = f.quotaCandidates(m, 'zh', false, f.QUOTA_BANDS, band);
  for (const k of ['L0','L1','L2','L3']) {
    assert.equal(c[k].html, m.html); assert.equal(c[k].aria, m.aria);
  }
  assert.match(c.L3I.html, /zu-qico/);
  assert.equal(c.L3I.aria, m.aria, 'icon-only mode keeps full aria');
});

test('pickQuotaDisplayLevel: shrinks immediately, expands with hysteresis, never below order', () => {
  const { pickQuotaDisplayLevel: pick, QUOTA_ORDER: order } = F(booted());
  const widths = { L0: 200, L1: 140, L2: 90, L3: 60, L3I: 20 };
  const measure = k => widths[k];
  assert.equal(pick(order, 220, measure, null, 20), 'L0');
  assert.equal(pick(order, 120, measure, 'L0', 20), 'L2', 'shrink no hysteresis');
  assert.equal(pick(order, 205, measure, 'L2', 20), 'L1', 'expand toward L0 needs +hyst: L1 fits, L0 does not');
  assert.equal(pick(order, 225, measure, 'L2', 20), 'L0', '225 passes');
  assert.equal(pick(order, 100, measure, 'L2', 20), 'L2', 'more compact level fits without hysteresis');
  assert.equal(pick(order, 10, measure, null, 20), 'hidden', 'below smallest → hidden (extreme degrade)');
  assert.equal(pick(order, 225, measure, 'hidden', 20), 'L0', 'hidden expands back with same hysteresis');
  assert.equal(pick(order, 22, measure, 'hidden', 20), 'hidden', 'hidden→L3I needs 20px hysteresis: 22 < 20+20 stays hidden');
  assert.equal(pick(order, 45, measure, 'hidden', 20), 'L3I', '45 >= 20+20 expands to L3I');
});

test('DOM behavior: level switching keeps __zuQ raw data, aria full, level applied idempotently', () => {
  const h = booted();
  const ui = h.buildComposer('workspace-main', 'sid_main');
  const f = F(h);
  /* VM 无真实布局：注入测量函数模拟收窄到 L2，验证等级切换不改原始数据/aria */
  const measure = (mode, lang, remain, bands, bandOf, current) => ({
    candidates: f.quotaCandidates(mode, lang, remain, bands, bandOf),
    level: 'L2',
  });
  /* 首帧先让协调器完成实例生成（会重建测试缝），再注入 override 触发次帧 */
  h.window.__zusageUpdate(h.payload({ quota: Q({ fiveHour: { percent: 26 }, weekly: { percent: 92 }, monthly: { percent: 8 } }) })); h.tick();
  h.window.__zusageQuotaFns.setMeasureOverride(measure);
  h.window.__zusageUpdate(h.payload({ quota: Q({ fiveHour: { percent: 26 }, weekly: { percent: 92 }, monthly: { percent: 8 } }) })); h.tick();
  let chip = h.chipOf(ui.wrap);
  assert.ok(chip);
  assert.equal(chip.getAttribute('data-zusage-qlevel'), 'L2', 'injected narrow width selects summary level');
  assert.match(chip.innerHTML, /7天/); assert.match(chip.innerHTML, /\+2/);
  assert.equal(chip.__zuQ.q.windows.weekly.percent, 92, 'raw quota data intact');
  assert.match(chip.getAttribute('aria-label'), /5时 26%/);
  assert.match(chip.getAttribute('aria-label'), /7天 92%/);
  assert.match(chip.getAttribute('aria-label'), /月 8%/, 'aria keeps all windows at L2');
  /* 恢复宽度：撤掉 override 回到 L0，同一节点幂等更新 */
  h.window.__zusageQuotaFns.setMeasureOverride(null);
  h.window.__zusageUpdate(h.payload({ quota: Q({ fiveHour: { percent: 26 }, weekly: { percent: 92 }, monthly: { percent: 8 } }) })); h.tick();
  chip = h.chipOf(ui.wrap);
  assert.equal(chip.getAttribute('data-zusage-qlevel'), 'L0', 'width restored → full level');
  assert.match(chip.innerHTML, /5时/);
  assert.equal(ui.wrap.children.filter(c => c.classList.contains('zu-quota')).length, 1, 'no duplicate chip');
});

test('DOM behavior: disabled quota still removes chip with no placeholder', () => {
  const h = harness({ quotaOn: false }); h.inject(); h.boot(); h.tick();
  const ui = h.buildComposer('workspace-main', 'sid_main');
  h.window.__zusageUpdate(h.payload({ quota: Q({ fiveHour: { percent: 26 } }) })); h.tick();
  assert.equal(h.chipOf(ui.wrap), undefined);
});

test('DOM behavior: React re-order re-inserts chip left of button; idempotent level no dup', () => {
  const h = booted();
  const ui = h.buildComposer('workspace-main', 'sid_main');
  h.window.__zusageUpdate(h.payload({ quota: Q({ fiveHour: { percent: 26 }, weekly: { percent: 12 } }) })); h.tick();
  const chip = h.chipOf(ui.wrap);
  assert.ok(chip);
  // simulate React moving button after chip
  ui.wrap.children = [ui.btn, chip];
  h.tick();
  assert.equal(h.chipOf(ui.wrap), chip, 'same chip node reused');
  assert.equal(ui.wrap.children.filter(c => c.classList.contains('zu-quota')).length, 1, 'no duplicate chip');
});

test('REAL measurement path: quotaMeasureAvail invariant (guards the self-referential row-width regression)', () => {
  const f = F(booted());
  /* 合成几何：leading 右缘=100。不变式 chipW+G 恒定——chip 增宽时左缘等量左移，avail 不变；
   * v382 首版用 trailing 行自身 clientWidth 相减恒得 ≈0（chip 摘除后永久隐藏），此用例锁死该回归。 */
  const mk = (rect) => ({ classList: { contains: () => false }, getAttribute: () => null,
    getBoundingClientRect: () => rect, children: [], className: '', isConnected: true, parentElement: null });
  const btn = mk({ left: 150, width: 70, right: 220 });
  const chip = mk({ left: 150, width: 50, right: 200 });
  const wrap = mk(null); const row = mk(null);
  row.clientWidth = 600; row.classList.contains = k => k === 'overflow-hidden' || k === 'min-w-0';
  btn.parentElement = wrap; wrap.parentElement = row;
  /* chip 在显：50 + (150-100) - 8 = 92 */
  assert.equal(f.quotaMeasureAvail(btn, chip, 100), 92);
  /* chip 增宽到 200、左缘移到 0：200 + (0-100) - 8 = 92 —— 不变式成立，不随自身宽度坍缩 */
  chip.getBoundingClientRect = () => ({ left: 0, width: 200, right: 200 });
  assert.equal(f.quotaMeasureAvail(btn, chip, 100), 92);
  /* chip 已摘除：纯空隙 (150-100) - 8 = 42（不得再加按钮宽虚高） */
  assert.equal(f.quotaMeasureAvail(btn, null, 100), 42);
  /* 宽布局大空隙：btn.left=800 → 700-8=692 → 足以容纳 L0(约207px) */
  btn.getBoundingClientRect = () => ({ left: 800, width: 70, right: 870 });
  assert.equal(f.quotaMeasureAvail(btn, null, 100), 692);
  /* 未知行结构 → null（fail-safe L0，绝不盲目隐藏） */
  const plainRow = mk(null); plainRow.clientWidth = 600; wrap.parentElement = plainRow;
  assert.equal(f.quotaMeasureAvail(btn, chip, 100), null);
  /* leading 右缘找不到 → null（fail-safe L0） */
  wrap.parentElement = row;
  assert.equal(f.quotaMeasureAvail(btn, chip, null), null);
});

test('quotaLeadingRight: ancestor anchor wins, bad rects skipped, double-miss null + measure fail-safe (v382 review)', () => {
  const f = F(booted());
  const mkNode = (lead) => ({ querySelector: sel => sel === '[data-composer-leading-content]' ? lead : null, parentElement: null });
  /* (a) 祖先 8 层内命中宿主标记：取其 rect.right */
  const deep = mkNode(null); deep.parentElement = mkNode(null);
  deep.parentElement.parentElement = mkNode({ getBoundingClientRect: () => ({ width: 457, right: 457.2 }) });
  assert.equal(f.quotaLeadingRight(deep), 457.2);
  /* (b) 标记 rect 坏（width 0 / 非有限）视为缺失，逐层继续；git chip 缺席 → null */
  const bad = mkNode({ getBoundingClientRect: () => ({ width: 0, right: 10 }) });
  bad.parentElement = mkNode({ getBoundingClientRect: () => ({ width: 12, right: NaN }) });
  assert.equal(f.quotaLeadingRight(bad), null, 'bad lead rects skipped; gitChipCache absent in VM');
  /* (c) 双缺失 → null；quotaMeasureAvail 不传 leadingRight 时走解析链，null → fail-safe */
  assert.equal(f.quotaLeadingRight(mkNode(null)), null);
  const mk = (rect) => ({ classList: { contains: () => false }, getAttribute: () => null,
    getBoundingClientRect: () => rect, children: [], className: '', isConnected: true, parentElement: null });
  const btn = mk({ left: 150, width: 70, right: 220 });
  const wrap = mk(null); const row = mk(null);
  row.clientWidth = 600; row.classList.contains = k => k === 'overflow-hidden' || k === 'min-w-0';
  btn.parentElement = wrap; wrap.parentElement = row;
  btn.querySelector = sel => sel === '[data-composer-leading-content]' ? null : null;
  assert.equal(f.quotaMeasureAvail(btn, null, undefined), null, 'unresolved leadingRight → fail-safe null (never guess)');
  /* 常量接线（spec 钉展开迟滞 16–24px）：变异漂移到 0（hidden↔L0 震荡）或 200（展开迟钝）须红 */
  assert.ok(f.QUOTA_HYST >= 16 && f.QUOTA_HYST <= 24, 'QUOTA_HYST stays in 16–24px spec band, got ' + f.QUOTA_HYST);
});

test('quotaShortLabel: full-file unified short labels match the user-final table (今日/5时/7天/月/套餐)', () => {
  const f = F(booted());
  /* 用户拍板终态=全档统一短标签；daily/plan 不再额外缩成「今/套」（未拍板项不得抢先实现） */
  for (const [key, zh, en] of [['daily', '今日', '1d'], ['fiveHour', '5时', '5h'], ['weekly', '7天', '7d'], ['monthly', '月', '1mo'], ['plan', '套餐', 'plan']]) {
    assert.equal(f.quotaShortLabel({ key }, 'zh'), zh, key + ' zh short label');
    assert.equal(f.quotaShortLabel({ key }, 'en'), en, key + ' en short label');
  }
  assert.equal(f.quotaShortLabel({ key: 'unknown', label: '原样' }, 'zh'), '原样', 'unknown key falls back to seg.label');
});

test('quotaCandidates: warn marker survives into L3/L3I (v382 review)', () => {
  const f = F(booted());
  const warn = '<span class="zu-qwarn">⚠</span>';
  const c = f.quotaCandidates({ kind: 'value', segs: [{ key: 'fiveHour', label: '5时', pct: 26 }], rem: false, warn }, 'zh', false, f.QUOTA_BANDS, band);
  assert.match(c.L3.html, /zu-qwarn/);
  assert.match(c.L3I.html, /zu-qwarn/, 'error/stale marker must survive icon-only level');
});

test('DOM behavior: hidden extreme degrade removes chip on a calibrated row; probe level wiring (v382 review)', () => {
  const h = booted();
  const ui = h.buildComposer('workspace-main', 'sid_main');
  /* 标定行结构（宿主同款双类）+ 默认桩几何：chipW=500、chip.left=20、lead 右缘 520
   * → avail = 500+(20-520)-8 钳 0 → hidden：极限降级摘除 chip，绝不遮挡原生控件。
   * 回归后果曾无覆盖：摘除分支坏掉时 shown.html 抛 TypeError 中断当拍后续 chip 对账，测试恒绿放行。 */
  ui.row.classList.add('overflow-hidden');   // harness 的 classList.add 只收单参（标准 DOM 多参行为不拟真）
  ui.row.classList.add('min-w-0');
  ui.row.clientWidth = 600;
  h.window.__zusageUpdate(h.payload({ quota: Q({ fiveHour: { percent: 26 } }) })); h.tick();
  assert.equal(h.chipOf(ui.wrap), undefined, 'avail 0 → hidden removes chip (native controls unobstructed)');
  const probe = h.body.children.find(c => c.className === 'zu-qmeasure');
  assert.ok(probe, 'offscreen probe created by real measurement path');
  assert.equal(probe.getAttribute('data-zusage-qlevel'), 'L3I', 'probe level attr tracks last measured candidate (L3I = final loop key on hidden)');
});

test('DOM behavior: quota fn seam dispose — owner removes, foreign token survives (v382 review)', () => {
  const h1 = booted();
  assert.ok(h1.window.__zusageQuotaFns, 'instance seam created on boot');
  h1.window.quotaTest.instances()[0].dispose();
  assert.equal(h1.window.__zusageQuotaFns, undefined, 'owner dispose removes its seam');
  const h2 = booted();
  const foreign = { __zuInst: {} };
  h2.window.__zusageQuotaFns = foreign;
  h2.window.quotaTest.instances()[0].dispose();
  assert.equal(h2.window.__zusageQuotaFns, foreign, 'seam overwritten by a foreign owner must survive this instance dispose');
});

const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
test('CSS: quota icon has band color incl. exc in both themes', () => {
  assert.match(src, /\.zu-quota \.zu-qico\.zu-qb-exc\{color:var\(--color-destructive/);
  assert.match(src, /data-zusage-light\] \.zu-qico\.zu-qb-exc/);
});
