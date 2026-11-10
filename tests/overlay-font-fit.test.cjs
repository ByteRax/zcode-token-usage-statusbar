const test = require('node:test');
const assert = require('node:assert/strict');
const { readOverlaySource } = require('./helpers/overlay-extract.cjs');
const source = readOverlaySource();

/* v315 定稿：Windows 上宿主 --font-mono 首选 ui-monospace（Consolas，13px 数字墨迹约 8px）
 * 配雅黑回退（11~12px）混排中文显大 ~40%。size-adjust 缩放面路线三轮实机回退后整体废弃
 * （数字面 110% 光栅化发虚；CJK 面 90/82/76% 越调整条越小），定稿=条/chip/tooltip 全部
 * mono 字族换 var(--font-sans,…)+tabular-nums（Segoe tnum 实测等宽生效，配比 1.1=原生，
 * 零缩放零模糊零调参）。本文件锁定：缩放面不得回加、30 处 sans 前置齐全、tabular-nums
 * 保留、⚙ 设置面板域仍走 mono 不被波及。 */

const SANS = "font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif)";

function countOf(needle) {
  return source.split(needle).length - 1;
}

test('scaling faces must stay removed (size-adjust path rasterizes soft on real machines)', () => {
  assert.equal(countOf('@font-face{font-family:ZuCJKFit'), 0, 'CJK 缩放面定义不得回加');
  assert.equal(countOf('@font-face{font-family:ZuNumFit'), 0, '数字缩放面定义不得回加');
  assert.equal(countOf('font-family:ZuCJKFit'), 0, 'CJK 缩放面消费不得回加');
  assert.equal(countOf('font-family:ZuNumFit'), 0, '数字缩放面消费不得回加');
});

test('bar root and the four text-ui-base chips (ctxpct/ctxrst/quota/tsb) plus git chip use the sans token', () => {
  const LONG = SANS + ";font-size:calc(var(--text-ui-base,var(--ui-font-size,14px)) - 1px);font-weight:700";
  assert.equal(countOf(LONG), 4, 'text-ui-base 四件套应切 sans');
  assert.ok(source.includes('.zusage-root{position:fixed;box-sizing:border-box;" +\n      "' + SANS + ';" +'),
    '条根字族必须以 sans 令牌开头');
  assert.ok(source.includes('white-space:nowrap;outline:none;" +\n      "' + SANS + ';" +'),
    '.zu-git 应切 sans');
});

test('sans surfaces keep tabular-nums so per-second number updates do not jitter widths', () => {
  // Segoe tnum 是 sans 方案的宽度稳定前提（实测 13px 同 7 位任意数字恒 56.12px）
  assert.ok(source.includes('.zusage-root{position:fixed;box-sizing:border-box;" +\n      "' + SANS + ';" +\n      "font-size:var(--ui-font-size,14px);line-height:1.3;" +\n      "font-variant-numeric:tabular-nums'), '条根 tabular-nums 保留');
  for (const sel of ['.zu-ctxpct{', '.zu-ctxrst{', '.zu-quota{', '.zu-tsb{']) {
    const at = source.indexOf(sel);
    assert.ok(at >= 0, `${sel} missing`);
    const body = source.slice(at, source.indexOf('}', at));
    assert.ok(body.includes('font-variant-numeric:tabular-nums'), `${sel} tabular-nums 保留`);
    assert.ok(body.includes('var(--font-sans'), `${sel} 应走 sans`);
  }
  const tipAt = source.indexOf('.tip{position:fixed');
  const tipBody = source.slice(tipAt, source.indexOf('}', tipAt));
  assert.ok(tipBody.includes(SANS) && tipBody.includes('font-variant-numeric:tabular-nums'),
    '.tip 应切 sans 并带 tabular-nums');
});

test('tooltip surfaces (exc card/rateTip inline fallback and stat/project/sub/speed mono rows) use the sans token', () => {
  // 总数由 build 后 grep 校准；此处锁关键不可回退点
  assert.equal(countOf(SANS), 35, 'sans 令牌总数（原 5 + 本次 29 + rateTip 1；新增 sans 面时按惯例顺延并同步本断言）');
  assert.ok(source.includes('rateTip.style.cssText =\n    "position:fixed;display:none;background:var(--color-tooltip,#171717);" +\n    "border:1px solid var(--color-border,transparent);border-radius:10px;padding:10px 14px;" +\n    "' + SANS), 'rateTip 内联兜底应切 sans');
  for (const sel of ['.zu-sp-kpi .v{', '.zu-pj-v{', '.zu-stat-v{font-family:', '.zu-speed-main{', '.zu-sl-main{margin-top:8px;font-family:', '".panel{position:fixed']) {
    const at = source.indexOf(sel);
    assert.ok(at >= 0, `${sel} missing`);
    const body = source.slice(at, source.indexOf('}', at));
    assert.ok(body.includes('var(--font-sans'), `${sel} 应走 sans`);
    assert.ok(!body.includes('var(--font-mono'), `${sel} 不应残留 mono`);
  }
});

test('speed number/unit spacing: live path word-spacing + fallback face space (v319)', () => {
  // v319 双路径：①实时桥 .zu-live 文本 "… t/s" 有空格但切 sans 后 Segoe 空格变窄，加 word-spacing；
  // ②无桥回退 chipFace 原串「数字+'<span class="dim">t/s</span>'」无空格字符，word-spacing 对
  // 无空格文本无效（真机实测数字紧贴 t/s），必须保留补入的空格
  const liveAt = source.indexOf('.zu-live{');
  assert.ok(liveAt >= 0, '.zu-live missing');
  const liveBody = source.slice(liveAt, source.indexOf('}', liveAt));
  assert.ok(liveBody.includes('word-spacing:4px'), '.zu-live 实时桥路径必须保留 word-spacing:4px 加距');
  const at = source.indexOf('var chipFace = chipTps > 0');
  assert.ok(at >= 0, 'chipFace missing');
  const line = source.slice(at, source.indexOf(String.fromCharCode(10), at));
  assert.ok(line.includes(") + ' <span class=\"dim\">t/s</span>'"), 'chipFace 数字与单位间必须保留空格');
});

test('speed cell must stay exempt from the segment flex rule (flex strips trailing spaces)', () => {
  // v321：`.it>span:not(.eb)` 的 inline-flex 会把速度格数字态「数字+dim」两 item 结构的
  // 尾随空格剥离（spaceW=0），word-spacing 对不存在的空格无效——v319 贴字复发真根因。
  // 豁免选择器一旦被改掉/移除，数字态立刻回到 0 间隙。
  assert.ok(source.includes('.zusage-root .it>span:not(.eb):not(.zu-live){display:inline-flex'),
    '分段 flex 规则必须继续豁免 .zu-live（:not(.zu-live)），否则速度格数字态空格被 flex 剥离、贴字复发');
  assert.ok(!source.includes('.it>span:not(.eb){'),
    '分段 flex 规则不得回归为无豁免形态（.it>span:not(.eb){）');
});

test('settings domain keeps mono token (sans scope must not leak into ⚙ panel)', () => {
  for (const sel of ['.zu-src-field{', '.zu-mp-id{', '.zu-mp-meta{',
    '.zu-settings .zu-notes-body pre{', '.zu-settings .zu-notes-body code{', '.zu-settings .zu-notes-hist-ver{',
    '.zu-rot-textarea{', '.zu-rot-cp-chip{', '.zu-rot-cp-phitem code{']) {
    const at = source.indexOf(sel);
    assert.ok(at >= 0, `${sel} missing`);
    const body = source.slice(at, source.indexOf('}', at));
    assert.ok(body.includes('var(--font-mono'), `${sel} 应保持 mono 令牌`);
    assert.ok(!body.includes('var(--font-sans'), `${sel} 不应被 sans 波及`);
  }
});
