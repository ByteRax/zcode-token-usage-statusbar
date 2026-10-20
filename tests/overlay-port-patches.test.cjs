/* 移植补丁的功能验证（自 fix/statusbar-panel-and-settings 端口）：
 * 1) 设置页（MCP 配置等）框架内的编辑框不再被派发/选为聊天输入框；
 * 2) 权限确认面板/批准框内输入框的锚点改判面板视觉卡（cardOf 高度熔断的修复）；
 * 3) 普通输入框（含弹窗）行为与补丁前完全一致（回归）。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
const pluginSource = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'zcode-token-usage-statusbar', 'overlay.js'), 'utf8');
function extract(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `提取失败: ${start}`);
  return source.slice(a, b);
}

/* ---------- 最小 DOM 替身：closest 只按属性存在性匹配（本测试用到的选择器均如此） ---------- */
function makeEl(tag, opts = {}) {
  const el = {
    tagName: tag,
    markers: new Set(opts.markers || []),
    rect: Object.assign({ width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 }, opts.rect),
    css: opts.css || {},
    attrs: opts.attrs || {},
    parentElement: null,
    children: [],
    getBoundingClientRect() { return this.rect; },
    closest(sel) {
      for (const wanted of sel.split(',').map(s => s.trim())) {
        const m = /^\[([\w-]+)(?:=["'][^"']*["'])?\]$/.exec(wanted);
        if (!m) continue;
        for (let p = this; p; p = p.parentElement) if (p.markers.has(m[1])) return p;
      }
      return null;
    },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
    getAttribute(k) { return this.attrs[k]; },
  };
  for (const child of opts.children || []) append(el, child);
  return el;
}
function append(parent, child) { child.parentElement = parent; parent.children.push(child); return child; }
const computedStyle = el => ({
  borderTopWidth: el.css.border || '0px',
  backgroundColor: el.css.bg || 'rgba(0, 0, 0, 0)',
});
const VISIBLE = el => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 8 && r.bottom > 0 && r.top < 900; };

/* ---------- 1) inSettingsView ---------- */
test('inSettingsView 只认设置框架，弹窗/普通节点不受影响', () => {
  const src = extract('  function inSettingsView(el) {', '  function coordinator() {');
  const body = makeEl('body');
  const ctx = { document: { body } };
  const inSettingsView = vm.runInNewContext(src + '\ninSettingsView;', ctx);
  const section = append(body, makeEl('section', { markers: ['data-settings-content-frame'] }));
  const panel = append(section, makeEl('div', { markers: ['data-settings-panel-frame'] }));
  assert.equal(inSettingsView(append(panel, makeEl('textarea'))), true);
  assert.equal(inSettingsView(append(section, makeEl('textarea'))), true);   // 只在外层 section 内也算
  const dialogTa = append(append(body, makeEl('div', { markers: ['role'] })), makeEl('textarea'));
  assert.equal(inSettingsView(dialogTa), false);   // 弹窗不在设置框架内，行为不受影响
  assert.equal(inSettingsView(append(body, makeEl('textarea'))), false);
});

/* ---------- 2) 协调器派发：设置页/弹窗编辑框不派实例 ---------- */
function runCoordinator(candidates) {
  const src = extract('  function inSettingsView(el) {', '  /* ---------- 实例工厂（v61.1）');  const instances = [];
  const ctx = {
    document: { body: makeEl('body'), querySelectorAll: () => candidates },
    innerHeight: 900,
    stale: () => false,
    instances,
    nextSlot: 0,
    spawnInstance: (pid, slot) => {
      const inst = {
        pid, slot, attached: [], disposed: false,
        attach(el, sid) { this.attached.push({ el, sid }); },
        dispose() { this.disposed = true; },
        getSid: () => '',
      };
      instances.push(inst);
      return inst;
    },
    refreshWants: () => {},
    FATAL: {},
    setInterval: () => 1,
    coordinatorTimer: 0,
  };
  vm.runInNewContext(src + '\ncoordinator();', ctx);   // 调用点在定义之前（提升），不在提取区域内，需显式调用
  return instances;
}
test('协调器不把设置页/弹窗里的编辑框派发给实例（修复：条冒在设置页底部）', () => {
  const pane = makeEl('div', { attrs: { 'data-pane-id': 'p1', 'data-session-id': 'sess-abcdef123456' } });
  const composer = append(pane, makeEl('textarea', { rect: { width: 600, height: 40, top: 700, bottom: 740 } }));
  const settings = append(
    append(append(makeEl('body'), makeEl('section', { markers: ['data-settings-content-frame'] })), makeEl('div', { markers: ['data-settings-panel-frame'] })),
    makeEl('textarea', { rect: { width: 500, height: 80, top: 780, bottom: 860 } }));
  const dialogTa = append(append(makeEl('body'), makeEl('div', { markers: ['role'] })), makeEl('textarea', { rect: { width: 400, height: 60, top: 750, bottom: 810 } }));
  const insts = runCoordinator([settings, dialogTa, composer]);
  assert.equal(insts.length, 1);
  assert.equal(insts[0].pid, 'p1');
  assert.deepEqual(insts[0].attached, [{ el: composer, sid: 'sess-abcdef123456' }]);
});
test('只有设置页/弹窗编辑框时协调器不挂任何输入框（auto 兜底也不锚它们）', () => {
  const settings = append(
    append(append(makeEl('body'), makeEl('section', { markers: ['data-settings-content-frame'] })), makeEl('div', { markers: ['data-settings-panel-frame'] })),
    makeEl('textarea', { rect: { width: 500, height: 80, top: 780, bottom: 860 } }));
  const dialogTa = append(append(makeEl('body'), makeEl('div', { markers: ['role'] })), makeEl('textarea', { rect: { width: 400, height: 60, top: 750, bottom: 810 } }));
  const insts = runCoordinator([settings, dialogTa]);
  assert.equal(insts.length, 1);
  assert.equal(insts[0].pid, 'auto');
  assert.deepEqual(insts[0].attached.map(a => a.el), [null]);
});

/* ---------- 3) findComposer / deepFind ---------- */
function findComposerOf(candidates) {
  const src = extract('  function inSettingsView(el) {', '  function coordinator() {')
    + extract('    function findComposer() {', '    function collectDiag(extra) {');
  const ctx = {
    document: { querySelectorAll: sel => (sel === 'textarea' ? candidates : []) },
    reallyVisible: () => true,
    innerHeight: 900,
    deepFind: () => null,
  };
  const findComposer = vm.runInNewContext(src + '\nfindComposer;', ctx);
  return findComposer();
}
function deepFindOf(candidates) {
  const src = extract('  function inSettingsView(el) {', '  function coordinator() {')
    + extract('    function deepFind() {', '    /* 输入框是否真的露在屏幕上');
  const COMPOSER_SEL = 'textarea, [contenteditable="true"], [role="textbox"], .ProseMirror, .ql-editor';
  const ctx = {
    COMPOSER_SEL,
    visible: VISIBLE,
    reallyVisible: () => true,
    innerHeight: 900,
    deepCache: { el: null, at: 0 },
    document: { body: makeEl('body'), querySelectorAll: sel => (sel === COMPOSER_SEL ? candidates : []) },
  };
  const deepFind = vm.runInNewContext(src + '\ndeepFind;', ctx);
  return deepFind();
}
function settingsTa() {
  return append(
    append(append(makeEl('body'), makeEl('section', { markers: ['data-settings-content-frame'] })), makeEl('div', { markers: ['data-settings-panel-frame'] })),
    makeEl('textarea', { rect: { width: 500, height: 80, top: 780, bottom: 860 } }));
}
test('findComposer 跳过设置页与弹窗编辑框，仍选普通聊天输入框', () => {
  const composer = makeEl('textarea', { rect: { width: 600, height: 40, top: 600, bottom: 640 } });
  const dialogTa = append(append(makeEl('body'), makeEl('div', { markers: ['role'] })), makeEl('textarea', { rect: { width: 400, height: 60, top: 800, bottom: 860 } }));
  assert.equal(findComposerOf([settingsTa(), dialogTa, composer]), composer);
  assert.equal(findComposerOf([settingsTa(), dialogTa]), null);   // 没有候选时不得退回设置页编辑框
});
test('deepFind 浅层扫描同样跳过设置页编辑框', () => {
  const composer = makeEl('textarea', { rect: { width: 600, height: 40, top: 600, bottom: 640 } });
  assert.equal(deepFindOf([settingsTa(), composer]), composer);
  assert.equal(deepFindOf([settingsTa()]), null);
});

/* ---------- 4) 面板锚点改判 ---------- */
function anchorCtx() {
  const src = extract('    /* 从 textarea 向上找视觉卡片容器', '    /* 读原生 UI 的上下文总量');
  const body = makeEl('body');
  const ctx = { document: { body }, getComputedStyle: computedStyle };
  vm.runInNewContext(src, ctx);
  return ctx;
}
const CARD_CSS = { border: '1px', bg: 'rgb(30, 30, 30)' };
test('批准框/权限面板内输入框改锚面板视觉卡（修复：条冒进面板里）', () => {
  const ctx = anchorCtx();
  /*  elicitation 卡片自带标记：直接锚卡片 */
  const card = makeEl('div', { markers: ['data-elicitation-dialog-card'], css: CARD_CSS, rect: { width: 480, height: 500, top: 200, bottom: 700 } });
  const ta = append(append(card, makeEl('div', { rect: { width: 440, height: 120, top: 560, bottom: 680 } })), makeEl('textarea', { rect: { width: 420, height: 36, top: 620, bottom: 656 } }));
  assert.equal(ctx.anchorCardOf(ta), card);
  /*  无卡片标记时走 data-permission-* 路径：跳过只有背景的选项行，锚 rounded-2xl 面板卡 */
  const panel = makeEl('div', { css: CARD_CSS, rect: { width: 480, height: 500, top: 200, bottom: 700 } });
  const optionRow = append(panel, makeEl('div', { markers: ['data-permission-feedback-option'], css: { bg: 'rgb(50, 50, 50)' }, rect: { width: 440, height: 120, top: 560, bottom: 680 } }));
  const fbTa = append(append(optionRow, makeEl('div', { rect: { width: 420, height: 60, top: 600, bottom: 660 } })), makeEl('textarea', { rect: { width: 400, height: 36, top: 620, bottom: 656 } }));
  assert.equal(ctx.anchorCardOf(fbTa), panel);
  assert.notEqual(ctx.cardOf(fbTa), panel);   // 旧 cardOf 落进面板内部（高度熔断先 break），即移植前的 bug
});
test('普通聊天输入框与无标记弹窗：anchorCardOf 与 cardOf 完全一致（回归）', () => {
  const ctx = anchorCtx();
  const composerCard = makeEl('div', { css: CARD_CSS, rect: { width: 600, height: 200, top: 640, bottom: 840 } });
  const composer = append(append(composerCard, makeEl('div', { rect: { width: 560, height: 60, top: 780, bottom: 840 } })), makeEl('textarea', { rect: { width: 540, height: 40, top: 790, bottom: 830 } }));
  assert.equal(ctx.anchorCardOf(composer), composerCard);
  assert.equal(ctx.anchorCardOf(composer), ctx.cardOf(composer));
  const tallCard = makeEl('div', { css: CARD_CSS, rect: { width: 480, height: 500, top: 200, bottom: 700 } });
  const dialogTa = append(tallCard, makeEl('textarea', { rect: { width: 420, height: 36, top: 620, bottom: 656 } }));
  assert.equal(ctx.panelCardOf(dialogTa), null);           // 无 permission/elicitation 标记不改判
  assert.equal(ctx.anchorCardOf(dialogTa), ctx.cardOf(dialogTa));
});
test('isCardLike 要求边框与背景同时俱全', () => {
  const ctx = anchorCtx();
  assert.equal(ctx.isCardLike(makeEl('div', { css: CARD_CSS })), true);
  assert.equal(ctx.isCardLike(makeEl('div', { css: { border: '1px' } })), false);
  assert.equal(ctx.isCardLike(makeEl('div', { css: { bg: 'rgb(50, 50, 50)' } })), false);
  assert.equal(ctx.isCardLike(makeEl('div')), false);
});

/* ---------- 5) 源码结构与插件副本漂移 ---------- */
test('补丁落到三处派发点与两处锚点，插件副本同步', () => {
  for (const guard of [
    'if (inSettingsView(el)) return;   // 设置页（MCP 配置等）的编辑框不是聊天输入框，不派实例',
    'if (inSettingsView(el)) return;   // 设置页（MCP 配置等）的编辑框不是聊天输入框',
    'if (inSettingsView(ta)) return;   // 设置页（MCP 配置等）的编辑框不是聊天输入框',
  ]) assert.ok(source.includes(guard), guard);
  assert.equal(source.split('if (inSettingsView(').length - 1, 3);   // 协调器 tick / deepFind / findComposer 各一处
  assert.equal(source.split('function inSettingsView(').length - 1, 1);
  assert.match(source, /var c = anchorCardOf\(composer\);/);
  assert.doesNotMatch(source, /var c = cardOf\(composer\);/);       // 旧锚点调用不得残留
  assert.equal(pluginSource, source);                               // 插件打包副本与根文件一致
});
