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
  assert.equal(countOf(LONG), 5, 'text-ui-base 四件套应切 sans（v356 起 +1：.zu-sysm 系统状态 chip 同规格）');
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
  assert.equal(countOf(SANS), 38, 'sans 令牌总数（原 36 + v356 sysmon 两面：.zu-sysm chip 与 .zu-sys-tip 内联卡；新增 sans 面时按惯例顺延并同步本断言）');
  assert.ok(source.includes('rateTip.style.cssText =\n    "position:fixed;display:none;background:var(--color-tooltip,#171717);" +\n    "border:1px solid var(--color-border,transparent);border-radius:10px;padding:10px 14px;" +\n    "' + SANS), 'rateTip 内联兜底应切 sans');
  for (const sel of ['.zu-sp-kpi .v{', '.zu-pj-v{', '.zu-stat-v{font-family:', '.zu-speed-main{', '.zu-sl-main{margin-top:8px;font-family:', '".panel{position:fixed']) {
    const at = source.indexOf(sel);
    assert.ok(at >= 0, `${sel} missing`);
    const body = source.slice(at, source.indexOf('}', at));
    assert.ok(body.includes('var(--font-sans'), `${sel} 应走 sans`);
    assert.ok(!body.includes('var(--font-mono'), `${sel} 不应残留 mono`);
  }
});

test('speed number/unit spacing: gap:5px mechanism + zero-space faces (v326)', () => {
  // v326 定稿：数字与 t/s 间距唯一机制 = .zu-live inline-flex+gap:5px+baseline；
  // 完成态（chipFace）与动态态（zuLiveFaceHtml）都是「数字+dim」两 item、无空格字符。
  // word-spacing 全链移除（对无空格完成态、单文本动态态均无视觉效果），不得回加。
  const liveAt = source.indexOf('.zu-live{');
  assert.ok(liveAt >= 0, '.zu-live missing');
  const liveBody = source.slice(liveAt, source.indexOf('}', liveAt));
    assert.ok(liveBody.includes('display:inline-flex') && liveBody.includes('gap:5px') && liveBody.includes('align-items:baseline'),
    '.zu-live 须 inline-flex+gap:5px+baseline（v326 数字与 t/s 间距唯一机制）');
  assert.ok(!liveBody.includes('word-spacing'), '.zu-live 不得回加 word-spacing（完成态无空格、动态态单文本均无视觉效果，v326 已除）');
  assert.ok(source.includes('+ zuLiveFaceHtml(speedView.text)'), '动态态整条渲染须走 zuLiveFaceHtml 拆「数字+dim」两 item（gap 需两 item）');
  assert.ok(source.includes('zuLiveFaceHtml(view.text)'), '原地更新须写拆分后结构（textContent 会转义成纯文本）');
  const at = source.indexOf('var chipFace = chipTps > 0');
  assert.ok(at >= 0, 'chipFace missing');
  const line = source.slice(at, source.indexOf(String.fromCharCode(10), at));
  assert.ok(line.includes(") + '<span class=\"dim\">t/s</span>'"), 'chipFace 数字与单位间必须零间隔（v324 用户定稿：不得回加空格字符）');
});

test('zuLiveFaceHtml behaviour lock: splits exactly the " t/s" suffix into number+dim (v326)', () => {
  // 行为级锁（字符串存在性断言抓不住「函数被改成 no-op」——变异实验实证）：
  // 从产物提取真函数体在隔离函数里执行，锁定拆分输出与转义边界
  const fnSrc = source.slice(source.indexOf('function zuLiveFaceHtml(text)'),
    source.indexOf('ttEsc(text);\n    }', source.indexOf('function zuLiveFaceHtml(text)')) + 'ttEsc(text);\n    }'.length);
  assert.ok(fnSrc.includes('return typeof text === "string"'), '提取到的是完整函数体');
  const ttEsc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const f = new Function('ttEsc', fnSrc + ';\nreturn zuLiveFaceHtml;')(ttEsc);
  assert.equal(f('160.6 t/s'), '160.6<span class="dim">t/s</span>', 't/s 结尾拆两 item');
  assert.equal(f('思考中…59秒'), '思考中…59秒', '状态词态不拆');
  assert.equal(f('—'), '—', '无数据态不拆');
  assert.equal(f('a<b&c t/s'), 'a&lt;b&amp;c<span class="dim">t/s</span>', '数字部分转义保留');
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

/* v371 其它 tooltip 长动态文本防护批（同 v370 会话名根因排查）：ellipsis/断行/收缩声明
 * 是纯 CSS 行为，VM/stub 测不出渲染效果，此处锁声明不可回退；实机几何另经 CDP 量测。 */
test('v371 long-text guards: eh-phase / rt-models key cap / spsub / qt-h / data-tip bubbles / speed fit scopes', () => {
  const bodyOf = sel => {
    const at = source.indexOf(sel);
    assert.ok(at >= 0, sel + ' missing');
    return source.slice(at, source.indexOf('}', at));
  };
  // 增强历史小浮层相位：可含上游错误原文（长 URL），nowrap 必须配收缩+省略号
  const phase = bodyOf('.zusage-enhance-tip .zu-eh-phase{');
  assert.ok(phase.includes('min-width:0') && phase.includes('overflow:hidden') && phase.includes('text-overflow:ellipsis'),
    'zu-eh-phase 须可收缩截断（长错误文案曾撑破头部）');
  // 精简摘要 rt-models 键列：table-cell 的 ellipsis 须有 max-width 帽才成立
  const key = bodyOf('.tip .rt-models .rt-row b{');
  assert.ok(key.includes('max-width:300px'), 'rt-models 键列宽度帽（auto 布局 cell 随内容长宽，无帽则省略号与缩字号兜底双失效）');
  // 子代理任务页 agent 名：不可收缩 nowrap 改可收缩+省略号+上限
  const spsub = bodyOf('.zu-spsub{');
  assert.ok(spsub.includes('flex:0 1 auto') && spsub.includes('min-width:0') && spsub.includes('text-overflow:ellipsis') && spsub.includes('max-width:'),
    'zu-spsub 须可收缩截断（长 agent 名曾把任务名 h3 挤成逐字折行）');
  assert.ok(!spsub.includes('flex:0 0 auto'), 'zu-spsub 不得锁死不收缩');
  // 额度 tooltip 标题：远端可控套餐/供应商名，无空格长串须可断行
  assert.ok(bodyOf('.zusage-quota-tip .qt-h{').includes('overflow-wrap:anywhere'), 'qt-h 断行');
  // data-tip 伪元素气泡：pre-line/normal 都不断无空格长 token（URL/模型 id）
  assert.ok(bodyOf('.zu-mp-tst[data-tip]:hover::after{').includes('overflow-wrap:anywhere'), '探测气泡断行');
  assert.ok(bodyOf('.zu-sv-left .zu-sl-model[data-tip]:hover::after{').includes('overflow-wrap:anywhere'), '模型胶囊气泡断行');
  assert.ok(bodyOf('.zu-rot-tipt:hover::after{').includes('overflow-wrap:anywhere'), '轮播编辑气泡断行');
  assert.ok(bodyOf('.zu-rot-livetip:hover::after{').includes('overflow-wrap:anywhere'), '轮播实时气泡断行');
  // 词包弹窗标题：packId 回退长名
  const pkt = bodyOf('.zu-rot-pk-title{');
  assert.ok(pkt.includes('min-width:0') && pkt.includes('text-overflow:ellipsis'), '词包标题收缩截断');
  // v372：标题行垂直居中——baseline 曾把范围胶囊/Tab 中心拖低 ~2.5px（用户实机指认）
  assert.ok(bodyOf('.zu-stat-head{').includes('align-items:center'), 'stat-head 垂直居中');
  assert.ok(bodyOf('.zu-pj-head{').includes('align-items:center'), 'pj-head 垂直居中');
  // 速度 V1 估宽分级：fit2/fit3 必须同时覆盖 legacy hero（长 MCP 工具动词曾永不命中而溢出）
  for (const fit of ['fit2', 'fit3']) {
    const at = source.indexOf('.zu-speed-left .zu-speed-' + fit + ',.zu-speed-hero .zu-speed-' + fit + '{');
    assert.ok(at >= 0, 'zu-speed-' + fit + ' 双作用域（.zu-speed-left + .zu-speed-hero）');
  }
});

/* v373：项目卡紧凑样式内部标题容器也须 center（baseline!important 曾把项目名压低 1.7px）。
 * 独立于 v371 聚合守卫，失败时能直接定位到本修复点。 */
test('v373 project card inner title aligns center with project name', () => {
  const at = source.indexOf('.zu-stat-tip--project .zu-pj-title{');
  assert.ok(at >= 0, '项目卡标题规则存在');
  const body = source.slice(at, source.indexOf('}', at));
  assert.ok(body.includes('align-items:center!important'), '项目卡标题+项目名垂直居中');
  assert.ok(!body.includes('align-items:baseline'), '项目卡标题内部不得回到 baseline');
  // 收缩/省略链不受对齐改动影响
  assert.ok(body.includes('min-width:0!important') && body.includes('white-space:nowrap!important'), '标题容器收缩链不变');
  const pname = source.slice(source.indexOf('.zu-stat-tip--project .zu-pj-pname{'));
  assert.ok(pname.slice(0, pname.indexOf('}')).includes('text-overflow:ellipsis!important'), '项目名省略链不变');
});
