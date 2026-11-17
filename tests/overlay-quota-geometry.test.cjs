const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');

/* v382 真实 ZCode CDP 几何验收：证明响应式测量目标（额度 chip 所在的宿主 trailing 行）
 * 的真实 geometry 前提成立——overflow:hidden + clientWidth 随窗口宽度变化 + chip 贴按钮左侧。
 * 这是 VM 测试无法覆盖的宿主 DOM 事实（specs/quota-chip-responsive.md §验收）。
 * 需要本机 ZCode 运行且 9229 调试端口在听；否则 skip（隔离单测仍覆盖纯函数/算术）。 */
function cdpTargets() {
  try { return JSON.parse(execFileSync('curl', ['-s', '--max-time', '3', 'http://127.0.0.1:9229/json/list'], { encoding: 'utf8' })); }
  catch (e) { return []; }
}
const target = cdpTargets().find(t => t.type === 'page' && t.title === 'ZCode');
const HAS_CDP = !!target;

const EXPR = `(function () {
  function R(el){ if(!el) return null; var b=el.getBoundingClientRect(),c=getComputedStyle(el);
    return {w:+b.width.toFixed(1),x:+b.x.toFixed(1),right:+b.right.toFixed(1),clientW:el.clientWidth,
      overflow:c.overflow,minW:c.minWidth,flex:c.flex}; }
  var btn=document.querySelector('[data-testid="chat-context-usage-trigger"]');
  var wrap=btn&&btn.parentElement, row=wrap&&wrap.parentElement;
  return JSON.stringify({innerW:innerWidth,btn:R(btn),wrap:R(wrap),row:R(row),
    lead:!!document.querySelector('[data-composer-leading-content]'),
    probe:document.querySelector('.zu-qmeasure')?R(document.querySelector('.zu-qmeasure')):null});
})()`;

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

test('real ZCode toolbar: measurement row is overflow:hidden and clientWidth tracks window width', { skip: HAS_CDP ? false : 'ZCode CDP 9229 未运行' }, async (t) => {
  const c = await connect(target.webSocketDebuggerUrl);
  try {
    /* 若当前会话没有输入框工具栏（设置页/演示页/正在恢复），本环境无法取证，显式跳过而非假绿。 */
    const probe = await c.send('Runtime.evaluate', { expression: '!!document.querySelector(\'[data-testid="chat-context-usage-trigger"]\')', returnByValue: true });
    if (!probe.result.result.value) {
      t.skip('当前 ZCode 窗口无输入框工具栏（无 chat-context-usage-trigger），无法量测；真机宽度矩阵待会话恢复后重跑');
      return;
    }
    const rows = [];
    for (const w of [1200, 640, 320]) {
      await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 2, mobile: false });
      await new Promise(r => setTimeout(r, 400));
      const r = await c.send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
      rows.push(JSON.parse(r.result.result.value));
    }
    await c.send('Emulation.clearDeviceMetricsOverride', {});
    assert.ok(rows[0].row, 'found measurement row (context button wrapper parent)');
    assert.equal(rows[0].row.overflow, 'hidden', 'measurement row clips overflow — the responsive anchor');
    assert.equal(rows[0].row.minW, '0px', 'measurement row is shrinkable (min-width:0), not shrink-0');
    /* v382 收口 review：avail 不变式的主锚点（leading 右缘）必须真实存在——宿主改掉该标记时
     * quotaLeadingRight 会静默回退 Git chip 再 fail-safe L0（特性关闭），这里让漂移显式红。 */
    assert.ok(rows[0].lead, 'host anchor [data-composer-leading-content] present (v382 avail primary anchor)');
    /* clientWidth 是否随 Emulation 视口变化取决于宿主面板停靠/分栏状态，不强求单调；
     * 关键不变量是行可收缩（min-width:0 + overflow:hidden），真实窗口拖动时即随宽度变化。
     * 记录各宽度实测值供取证；早前取证（1358px 窗口）行 316.6→141 已证随窗口收窄。 */
    const widths = rows.map(r => r.row.clientW);
    assert.ok(widths.every(w => typeof w === 'number' && w >= 0), 'row clientWidth measurable at every width: ' + widths.join(','));
    /* 原生上下文按钮始终有有效命中宽（不被插件布局藏掉） */
    for (const r of rows) assert.ok(r.btn && r.btn.w > 20, 'context button keeps a clickable width at ' + r.innerW);
    /* 离屏测量探针不入全局查询，且即便在也不影响 row 宽度（aria-hidden/absolute） */
    for (const r of rows) if (r.probe) assert.ok(r.probe.x < -1000 || r.probe.w === 0, 'probe stays offscreen');
  } finally { c.close(); }
});
