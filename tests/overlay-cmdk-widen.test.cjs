const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
function extract(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}

/* ---------- v146 宿主命令中心（⌘K 搜索弹框）加宽开关 ---------- */

test('the widen rule is stylesheet-gated by data-zusage-cmdk and targets cmdk dialogs only', () => {
  // 属性值必须带引号：CSS 属性选择器的未加引号数字值会被 Chrome 整条丢弃（v136 实测）
  assert.match(source, /"\[data-zusage-cmdk=\\"1\\"\] div\[data-slot=dialog-content\]:has\(>\[data-slot=command\]\[cmdk-root\]\)"/);
  // 用户规格：宽度=窗口 80%；max(32rem,…) 小窗不缩水（弹框基础类自带 w-full，原生上限 512px）
  // 高度=窗口 90%（用户规格 2026-10-30）：根不低于原生 sm:max-h（任何窗口不缩矮），列表 440px 硬顶放宽并保底
  assert.ok(source.includes('"{max-width:max(32rem,80vw)!important;max-height:max(90dvh,calc(100dvh - 6rem))!important}" +'));
  assert.ok(source.includes('"{max-height:max(440px,calc(90dvh - 15rem))!important}" +'));
  assert.ok(source.includes('"[data-zusage-cmdk=\\"1\\"] [data-slot=dialog-content] [cmdk-list]" +'));
  // 门控规则字符串在源码只出现一次（注释与 applyCmdkW 内的属性名不构成第二条规则），无 DOM 创建/观察器
  assert.equal(source.indexOf('[data-zusage-cmdk=\\"1\\"] div[data-slot=dialog-content]'), source.lastIndexOf('[data-zusage-cmdk=\\"1\\"] div[data-slot=dialog-content]'));
  assert.ok(!/cmdk[\s\S]{0,80}createElement\("style"\)|cmdk[\s\S]{0,80}MutationObserver/.test(source));
  // 规则必须带 !important：宿主 Tailwind 原子类同级特异性，覆盖靠声明强度
  const rule = source.match(/"\[data-zusage-cmdk=\\"1\\"\][^]*?\{max-width[^}]+\}" \+/)[0];
  assert.ok(rule.includes('!important'));
});

test('applyCmdkW gates the width on <html> and tolerates hostile documents', () => {
  const fnSource = source.match(/  function applyCmdkW\(\) \{[\s\S]*?\n  \}/)[0];
  const attrs = {};
  const document = {
    documentElement: {
      setAttribute: (k, v) => { attrs[k] = v; },
      removeAttribute: k => { delete attrs[k]; },
    },
  };
  const context = { state: { cmdkW: 1 }, document };
  vm.runInNewContext(fnSource + '\napplyCmdkW();', context);
  assert.equal(attrs['data-zusage-cmdk'], '1');
  context.state.cmdkW = 0;
  vm.runInNewContext('applyCmdkW();', context);
  assert.ok(!('data-zusage-cmdk' in attrs));
  const broken = { state: { cmdkW: 1 }, document: null };
  vm.runInNewContext(fnSource + '\napplyCmdkW();', broken);   // document 不可用时不抛
});

test('the toggle defaults to on, reads an explicit "0" and persists both ways', () => {
  // 缺省开启：仅显式 "0" 关闭（缺字段/其它值不动缺省 1）
  assert.match(source, /if \(ls\(LS\.cmdkW, ""\) === "0"\) state\.cmdkW = 0;/);
  assert.match(source, /cmdkW: "zusage3\.cmdkW"/);
  assert.ok(source.includes('cmdkW: 1,'));
  assert.match(source, /lsSet\(LS\.cmdkW, state\.cmdkW \? "1" : "0"\);/);
  assert.ok(source.includes('applyCmdkW();   // v146：同款初载挂属性'));
});

test('buildPanel shows the widen toggle in both languages and restores its checked state', () => {
  const buildSource = extract('    function settingRow(', '    function syncSettingsScroll() {');
  const body = { scrollTop: 0 };
  const cwBox = {};
  const context = {
    slot: 0,
    panel: {
      innerHTML: '',
      querySelector: selector => selector === '.zu-settings-body' ? body
        : selector === '.zu-cmdk-widen' ? (context.panel.innerHTML.includes('zu-cmdk-widen') ? cwBox : null)
        : { value: '' },
      querySelectorAll: () => [],
    },
    state: { lang: 'zh', show: {}, ctxOv: '', cnNum: 1, projPath: 1, cmdkW: 1 },
    L: (zh, en) => context.state.lang === 'en' ? en : zh,
    syncUpdate: () => {}, syncSettingsScroll: () => {},
  };
  vm.runInNewContext(buildSource + '\nbuildPanel();', context);
  assert.match(context.panel.innerHTML, /<input type="checkbox" class="zu-cmdk-widen">/);
  assert.match(context.panel.innerHTML, /命令中心加宽/);
  // 位置：紧跟「项目完整路径」之后、语言选择之前（通用区尾部）
  assert.ok(context.panel.innerHTML.indexOf('zu-cmdk-widen') > context.panel.innerHTML.indexOf('zu-pp-enable'));
  assert.ok(context.panel.innerHTML.indexOf('zu-cmdk-widen') < context.panel.innerHTML.indexOf('zu-settings-langs'));
  assert.equal(cwBox.checked, true);
  context.state.cmdkW = 0;
  vm.runInNewContext('buildPanel();', context);
  assert.equal(cwBox.checked, false);
  context.state.lang = 'en';
  vm.runInNewContext('buildPanel();', context);
  assert.match(context.panel.innerHTML, /Wider command center/);
  assert.equal(cwBox.checked, false);
});

test('syncPanel restores the widen toggle and tolerates its absence', () => {
  const syncSource = extract('    function syncPanel() {', '    panel.addEventListener("click",');
  const cwBox = {}, ctxov = { value: '' };
  let present = true, updates = 0;
  const context = {
    panel: {
      querySelectorAll: () => [],
      querySelector: selector => selector === '.zu-cmdk-widen' ? (present ? cwBox : null) : selector === '.zu-ctxov' ? ctxov : { value: '' },
    },
    state: { show: {}, ctxOv: '', cnNum: 1, projPath: 1, cmdkW: 0 },
    syncUpdate: () => { updates++; },
  };
  vm.runInNewContext(syncSource + '\nsyncPanel();', context);
  assert.equal(cwBox.checked, false);
  context.state.cmdkW = 1;
  vm.runInNewContext('syncPanel();', context);
  assert.equal(cwBox.checked, true);
  present = false;
  vm.runInNewContext('syncPanel();', context);
  assert.equal(updates, 3);
});

test('widen toggle persists and flips the gate without re-rendering or touching display items', () => {
  const changeSource = extract('    panel.addEventListener("change",', '    listenGlobal(document, "mousedown",');
  let handler, saved = 0, gates = 0, renders = 0;
  const context = {
    panel: { addEventListener: (_, fn) => { handler = fn; } },
    state: { ctxOv: '', show: { ctx: 1 }, projPath: 1, cmdkW: 1 },
    persist: () => { saved++; },
    applyCmdkW: () => { gates++; },
    renderAll: () => { renders++; },
  };
  vm.runInNewContext(changeSource, context);
  const target = checked => ({ type: 'checkbox', checked, dataset: {}, classList: { contains: name => name === 'zu-cmdk-widen' } });
  handler({ target: target(false) });
  assert.equal(context.state.cmdkW, 0);
  assert.equal(saved, 1);
  assert.equal(gates, 1);
  assert.equal(renders, 0);   // 纯 CSS 门控即时生效，无需 renderAll
  assert.deepEqual(context.state.show, { ctx: 1 });   // 必须独立分支：落入 data-k 分支会写 show[undefined]
  handler({ target: target(true) });
  assert.equal(context.state.cmdkW, 1);
  assert.equal(saved, 2);
  assert.equal(gates, 2);
});
