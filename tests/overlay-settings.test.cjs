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
const scrollSource = extract('    function syncSettingsScroll() {', '    function positionSettingsPanel() {');
const positionSource = extract('    function positionSettingsPanel() {', '    panel.addEventListener("scroll"');

function scroll(height, client, top, lang = 'zh') {
  const body = { scrollHeight: height, clientHeight: client, scrollTop: top };
  const button = { textContent: '', disabled: false };
  const classes = {};
  const panel = {
    querySelector: selector => selector === '.zu-settings-body' ? body : button,
    classList: { toggle: (name, on) => { classes[name] = on; } },
  };
  vm.runInNewContext(scrollSource + '\nsyncSettingsScroll();', { panel, L: (zh, en) => lang === 'en' ? en : zh });
  return { body, button, classes };
}

test('scroll hint is actionable only while real content remains below', () => {
  const r = scroll(900, 400, 0);
  assert.equal(r.button.disabled, false);
  assert.match(r.button.textContent, /下方还有设置/);
  assert.equal(r.classes['zu-settings-more'], true);
});
test('bottom removes fading and disables paging with a truthful end label', () => {
  for (const top of [500, 499, 510]) {
    const r = scroll(900, 400, top);
    assert.equal(r.button.disabled, true);
    assert.match(r.button.textContent, /已到底部/);
    assert.equal(r.classes['zu-settings-more'], false);
  }
});
test('no overflow does not pretend more settings exist', () => {
  const r = scroll(400, 400, 0);
  assert.equal(r.button.textContent, '所有设置已展示');
  assert.equal(r.button.disabled, true);
  assert.equal(r.classes['zu-settings-more'], false);
});
test('scroll hint is localized', () => {
  assert.match(scroll(900, 400, 0, 'en').button.textContent, /More settings below/);
  assert.match(scroll(900, 400, 500, 'en').button.textContent, /End of settings/);
});
test('settings geometry matches the bar outer width and edges only when open', () => {
  const values = {};
  let syncs = 0;
  const panel = {
    offsetWidth: 420,
    classList: { contains: () => true },
    style: { getPropertyValue: k => values[k], setProperty: (k, v) => { values[k] = v; } },
  };
  let rect = { left: 250, top: 600, width: 800.5 };
  const context = {
    panel, bar: { clientLeft: 1, getBoundingClientRect: () => rect },
    syncSettingsScroll: () => { syncs++; },
  };
  vm.runInNewContext(positionSource + '\npositionSettingsPanel();', context);
  assert.equal(values['--zu-settings-height'], '582px');
  assert.equal(panel.style.width, '800.5px');
  assert.equal(panel.style.left, '-1px');
  assert.equal(syncs, 1);
  rect = { left: 10, top: 350, width: 320 };
  vm.runInNewContext('positionSettingsPanel();', context);
  assert.equal(panel.style.width, '320px');
  assert.equal(panel.style.left, '-1px');
  assert.equal(values['--zu-settings-height'], '332px');
  panel.classList.contains = () => false;
  vm.runInNewContext('positionSettingsPanel();', context);
  assert.equal(syncs, 2);
});
test('buildPanel initializes and rebuilds controls without losing state or scroll position', () => {
  const buildSource = extract('    function settingRow(', '    function syncSettingsScroll() {');
  let oldBody = null, syncs = 0;
  const body = { scrollTop: 0 };
  const radios = [{ value: 'zh' }, { value: 'en' }];
  const checkboxes = ['ctx', 'turn', 'win', 'tools', 'today', 'sub'].map(k => ({ dataset: { k } }));
  const input = { value: '' };
  const context = {
    panel: {
      innerHTML: '',
      querySelector: selector => selector === '.zu-settings-body' ? oldBody : input,
      querySelectorAll: selector => selector === 'input[name=zu-lang]' ? radios : checkboxes,
    },
    state: { lang: 'zh', show: { ctx: 1, turn: 0, win: 1, tools: 1, today: 0, sub: 1 }, ctxOv: '200000' },
    VERSION: 'v67', L: (zh, en) => context.state.lang === 'en' ? en : zh,
    syncUpdate: () => { oldBody = body; }, syncSettingsScroll: () => { syncs++; },
  };
  vm.runInNewContext(buildSource + '\nbuildPanel();', context);
  assert.equal(body.scrollTop, 0);
  assert.equal(input.value, '200000');
  assert.deepEqual(radios.map(r => r.checked), [true, false]);
  assert.deepEqual(checkboxes.map(cb => cb.checked), [true, false, true, true, false, true]);
  assert.match(context.panel.innerHTML, /状态条设置选项/);
  body.scrollTop = 250;
  context.state.lang = 'en';
  vm.runInNewContext('buildPanel();', context);
  assert.equal(body.scrollTop, 250);
  assert.equal(input.value, '200000');
  assert.deepEqual(radios.map(r => r.checked), [false, true]);
  assert.deepEqual(checkboxes.map(cb => cb.checked), [true, false, true, true, false, true]);
  assert.match(context.panel.innerHTML, /Status bar settings options/);
  assert.equal(syncs, 2);
});

test('context-window changes persist through the actual delegated handler', () => {
  const changeSource = extract('    panel.addEventListener("change",', '    document.addEventListener("mousedown",');
  let handler, saved = 0, renders = 0;
  const context = {
    panel: { addEventListener: (_, fn) => { handler = fn; } },
    state: { ctxOv: '', show: {} },
    persist: () => { saved++; }, renderAll: () => { renders++; },
  };
  vm.runInNewContext(changeSource, context);
  handler({ target: { type: 'text', value: ' 200000 ', classList: { contains: name => name === 'zu-ctxov' } } });
  assert.equal(context.state.ctxOv, '200000');
  assert.equal(saved, 1);
  assert.equal(renders, 1);
  handler({ target: { type: 'text', value: '', classList: { contains: name => name === 'zu-ctxov' } } });
  assert.equal(context.state.ctxOv, '');
  assert.equal(saved, 2);
});

test('settings title uses the same current plugin version as the update section', () => {
  const syncSource = extract('    function syncUpdate() {', '    function syncPanel() {');
  const version = {}, status = {};
  const controls = {};
  const context = {
    state: { pluginUpdate: { supported: true, auto: true, phase: 'available', currentVersion: '1.2.3', latestVersion: '1.4.0' }, rateLine: true },
    panel: { querySelector: selector => selector === '.zu-settings-version' ? version : selector === '.zu-update-status' ? status : (controls[selector] ||= {}) },
    L: (zh, en) => zh,
  };
  vm.runInNewContext(syncSource + '\nsyncUpdate();', context);
  assert.equal(version.textContent, '1.2.3');
  assert.equal(version.hidden, false);
  assert.match(status.textContent, /当前版本：1\.2\.3/);
  context.state.pluginUpdate.currentVersion = '1.4.1';
  vm.runInNewContext('syncUpdate();', context);
  assert.equal(version.textContent, '1.4.1');
  assert.match(status.textContent, /当前版本：1\.4\.1/);
  context.state.pluginUpdate = null;
  vm.runInNewContext('syncUpdate();', context);
  assert.equal(version.textContent, '');
  assert.equal(version.hidden, true);
  assert.doesNotMatch(status.textContent, /当前版本：/);
});

test('panel retains all controls, scroll position and settings-only styling', () => {
  assert.match(source, /panel.className = "panel zu-settings"/);
  for (const key of ['ctx', 'turn', 'win', 'tools', 'today', 'sub']) {
    assert.ok(source.includes('data-k="' + key + '"'));
  }
  for (const selector of ['zu-rate-line', 'zu-auto-update', 'zu-ctxov', 'data-update="check"', 'data-update="update"', 'name="zu-lang"', 'zu-settings-feedback']) {
    assert.ok(source.includes(selector));
  }
  assert.match(source, /\.zu-settings-body"\)\.scrollTop = scrollTop/);
  assert.match(source, /t2\.classList\.contains\("zu-ctxov"\)/);
  assert.match(source, /panel\.addEventListener\("scroll", syncSettingsScroll, true\)/);
  assert.match(source, /body\.scrollTop \+= Math\.max\(1, Math\.round\(body\.clientHeight \* \.8\)\)/);
  assert.match(source, /positionSettingsPanel\(\);\s*positionSubPanel\(\);\s*everMounted = true/);
});

const ISSUES_URL = 'https://github.com/ByteRax/zcode-token-usage-statusbar/issues';
test('feedback button sits in the footer with localized copy', () => {
  const buildSource = extract('    function settingRow(', '    function syncSettingsScroll() {');
  const body = { scrollTop: 0 };
  const context = {
    panel: {
      innerHTML: '',
      querySelector: () => body, querySelectorAll: () => [],
    },
    state: { lang: 'zh', show: {}, ctxOv: '' },
    L: (zh, en) => context.state.lang === 'en' ? en : zh,
    syncUpdate: () => {}, syncSettingsScroll: () => {},
  };
  vm.runInNewContext(buildSource + '\nbuildPanel();', context);
  assert.match(context.panel.innerHTML, /class="zu-settings-feedback">反馈问题<\/button>/);
  assert.ok(context.panel.innerHTML.indexOf('zu-settings-feedback') > context.panel.innerHTML.indexOf('zu-settings-scroll'));
  context.state.lang = 'en';
  vm.runInNewContext('buildPanel();', context);
  assert.match(context.panel.innerHTML, /class="zu-settings-feedback">Report an issue<\/button>/);
});
test('footer feedback click prefers the zcode openExternal bridge over window.open', () => {
  const clickSource = extract('    panel.addEventListener("click",', '    gear.addEventListener("click"');
  let handler;
  const opened = [], bridged = [];
  let pluginCalls = 0;
  const context = {
    panel: {
      addEventListener: (_, fn) => { handler = fn; },
      classList: { remove: () => {} },
      querySelector: () => ({ scrollTop: 0 }),
    },
    window: { open: (...args) => { opened.push(args); }, zcode: { openExternal: url => { bridged.push(url); } } },
    syncSettingsScroll: () => {},
    pluginRequest: () => { pluginCalls++; },
  };
  vm.runInNewContext(clickSource, context);
  handler({ target: { closest: sel => sel === '.zu-settings-feedback' ? {} : null } });
  assert.deepEqual(bridged, [ISSUES_URL]);
  assert.deepEqual(opened, []);
  assert.equal(pluginCalls, 0);
});
test('footer feedback click falls back to window.open when the bridge is absent', () => {
  const clickSource = extract('    panel.addEventListener("click",', '    gear.addEventListener("click"');
  let handler;
  const opened = [];
  let pluginCalls = 0;
  const context = {
    panel: {
      addEventListener: (_, fn) => { handler = fn; },
      classList: { remove: () => {} },
      querySelector: () => ({ scrollTop: 0 }),
    },
    window: { open: (...args) => { opened.push(args); }, zcode: { openExternal: 'broken' } },
    syncSettingsScroll: () => {},
    pluginRequest: () => { pluginCalls++; },
  };
  vm.runInNewContext(clickSource, context);
  handler({ target: { closest: sel => sel === '.zu-settings-feedback' ? {} : null } });
  assert.deepEqual(opened, [[ISSUES_URL, '_blank', 'noopener']]);
  assert.equal(pluginCalls, 0);
  handler({ target: { closest: sel => sel === '[data-update]' ? { dataset: { update: 'check' } } : null } });
  assert.equal(pluginCalls, 1);
  assert.equal(opened.length, 1);
});
