const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

/* v383 真实 ZCode CDP 几何验收（specs/git-chip-responsive.md §测试与验收）：
 * 证明 Git chip 响应式测量的宿主前提在真实 DOM 成立——
 *   1) 前导预算纯窗口驱动：leadA.width ≈ row.width − trail.width − gap（flex-1 min-w-0）；
 *   2) avail 公式与几何直测一致且与 chip 当前等级无关（反自指，无 v382 额度首版黑洞）；
 *   3) 各视口宽度下 chip 不与 CUA/尾随区重叠，等级属性可读。
 * 需要本机 ZCode 运行且 9229 调试端口在听；否则 skip（VM 测试覆盖纯函数/算术，不冒充几何）。 */
function cdpTargets() {
  try { return JSON.parse(execFileSync('curl', ['-s', '--max-time', '3', 'http://127.0.0.1:9229/json/list'], { encoding: 'utf8' })); }
  catch (e) { return []; }
}
const target = cdpTargets().find(t => t.type === 'page' && t.title === 'ZCode');
const HAS_CDP = !!target;

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pending = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    ws.onerror = reject;
    ws.onopen = () => resolve({
      send(method, params) { return new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }); },
      close() { ws.close(); }
    });
  });
}

const GEO_EXPR = `(function () {
  var leadA = document.querySelector('[data-composer-leading-actions]');
  var row = leadA && leadA.parentElement && leadA.parentElement.closest('[class*="group/toolbar"]');
  if (!row) row = document.querySelector('[class*="group/toolbar"]');
  /* 同 pane 配对（review m3）：chip/cua/leadC/trail 一律从 leadA 所在行内取，防多分栏跨 pane 混测 */
  var chip = row ? row.querySelector('.zu-git') : document.querySelector('.zu-git');
  var leadC = row ? row.querySelector('[data-composer-leading-content]') : null;
  var trail = row ? row.querySelector('[data-composer-trailing-actions]') : null;
  var cua = row ? row.querySelector('[data-testid="v4-composer-cua-entry"]') : null;
  function R(el) { if (!el) return null; var b = el.getBoundingClientRect();
    return { w: +b.width.toFixed(1), x: +b.x.toFixed(1), right: +b.right.toFixed(1) }; }
  var cs = leadA ? getComputedStyle(leadA) : null;
  var avail = null, availErr = null;
  try {
    var fns = window.__zusageGitFns && window.__zusageGitFns.all();
    if (fns && chip && leadC) {
      avail = fns.gitMeasureAvail({ wrap: leadC, btn: cua, after: cua }, chip);
    }
  } catch (e) { availErr = String(e && e.message || e); }
  var gap = 0;
  try { gap = parseFloat(getComputedStyle(row).columnGap) || 0; } catch (e) { }
  return JSON.stringify({
    innerW: innerWidth,
    chip: R(chip), glevel: chip ? chip.getAttribute('data-zusage-glevel') : null,
    leadA: R(leadA), leadAflex: cs && cs.flex, leadAminW: cs && cs.minWidth,
    leadC: R(leadC), trail: R(trail), row: R(row), cua: R(cua), gap: gap,
    avail: avail, availErr: availErr, seam: !!(window.__zusageGitFns && window.__zusageGitFns.all)
  });
})()`;

test('real ZCode toolbar: leading budget is window-driven and git chip avail matches geometry', { skip: HAS_CDP ? false : 'ZCode CDP 9229 未运行' }, async (t) => {
  const c = await connect(target.webSocketDebuggerUrl);
  try {
    const probe = await c.send('Runtime.evaluate', { expression: '!!document.querySelector(\'[data-composer-leading-content]\')', returnByValue: true });
    if (!probe.result.result.value) {
      t.skip('当前 ZCode 窗口无输入框工具行（无 leading-content），无法量测；真机几何待会话恢复后重跑');
      return;
    }
    const rows = [];
    for (const w of [1200, 900, 640]) {
      await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 2, mobile: false });
      await new Promise(r => setTimeout(r, 450));   // 留出插件 render/heavy 对账拍
      const r = await c.send('Runtime.evaluate', { expression: GEO_EXPR, returnByValue: true });
      rows.push(JSON.parse(r.result.result.value));
    }
    const full = rows[0];
    /* 标定结构前提：前导预算容器存在且可收缩（flex-1 min-w-0）——多级收缩只在此结构启用 */
    if (!full.leadA) {
      t.skip('宿主无 [data-composer-leading-actions]（旧版结构未标定）——多级收缩本就不启用，无几何可验');
      return;
    }
    assert.equal(full.leadAminW, '0px', 'leading-actions is shrinkable (min-width:0)');
    assert.ok(/1\b/.test(String(full.leadAflex)), 'leading-actions flex-grow=1 (window-driven budget), got ' + full.leadAflex);
    if (!full.seam) {
      t.skip('运行目录尚未部署 v383（window.__zusageGitFns 缝缺席）——结构/恒等式断言已过；avail/等级/重叠断言待部署后重跑');
    }
    /* 恒等式：leadA.width ≈ row.width − trail.width − gap（前导预算与 chip 内容无关，反自指前提） */
    const expect = +(full.row.w - full.trail.w - full.gap).toFixed(1);
    assert.ok(Math.abs(full.leadA.w - expect) <= 1.5,
      'leadA.width (' + full.leadA.w + ') ≈ row − trail − gap (' + expect + ') at ' + full.innerW + 'px');
    if (!full.seam) return;   // 缝缺席（旧版运行目录）：以下依赖 v383 行为，已显式 skip
    /* avail 公式 == 几何直测：avail ≈ leadA.width − (leadC.width − chipW)，且 == leadA.right − chip.right + chipW */
    const chipW = full.chip ? full.chip.w : 0;
    const formula = +(full.leadA.w - (full.leadC.w - chipW)).toFixed(1);
    const geometric = +(full.leadA.right - full.chip.right + chipW).toFixed(1);
    assert.ok(Math.abs(formula - geometric) <= 1.5,
      'avail formula (' + formula + ') == geometric measure (' + geometric + ') — no self-reference');
    assert.ok(full.avail != null && Math.abs(full.avail - formula) <= 2,
      'seam gitMeasureAvail (' + full.avail + ') matches formula (' + formula + ')');
    /* 各视口宽度：chip 可读等级、不与 CUA 重叠、不越过前导预算右缘 */
    for (const r of rows) {
      if (!r.chip) continue;   // 非 git 仓库/远端 pane 环境下 chip 不挂载（其余断言仍覆盖结构前提）
      assert.ok(r.glevel && r.glevel !== 'hidden', 'chip level readable at ' + r.innerW + 'px: ' + r.glevel);
      assert.ok(r.chip.x >= r.cua.right - 1, 'chip does not overlap the CUA button at ' + r.innerW + 'px (' + r.chip.x + ' < ' + r.cua.right + ')');
      assert.ok(r.chip.right <= r.leadA.right + 1, 'chip stays inside the leading budget at ' + r.innerW + 'px (' + r.chip.right + ' > ' + r.leadA.right + ')');
    }
    /* 各宽度实测值留档：leadA 随窗口伸缩（值不强求单调，取决于宿主分栏停靠状态） */
    assert.ok(rows.every(r => typeof r.leadA.w === 'number' && r.leadA.w >= 0),
      'leadA width measurable at every viewport: ' + rows.map(r => r.innerW + '→' + r.leadA.w).join(', '));
  } finally {
    try { await c.send('Emulation.clearDeviceMetricsOverride', {}); } catch (e) { }
    c.close();
  }
});
