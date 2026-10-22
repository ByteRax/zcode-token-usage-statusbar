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
    offsetWidth: 420, offsetHeight: 300,
    classList: { contains: () => true },
    style: { getPropertyValue: k => values[k], setProperty: (k, v) => { values[k] = v; } },
  };
  let rect = { left: 250, top: 600, width: 800.5 };
  const context = {
    panel, bar: { getBoundingClientRect: () => rect }, innerWidth: 1400,
    syncSettingsScroll: () => { syncs++; },
  };
  vm.runInNewContext(positionSource + '\npositionSettingsPanel();', context);
  assert.equal(values['--zu-settings-height'], '582px');
  assert.equal(panel.style.width, '800.5px');
  assert.equal(panel.style.left, '250px');   // v80 面板挂 body：视口坐标左缘随条
  assert.equal(panel.style.top, '290px');    // 条上沿 600 − 面板高 300 − 10px 缝
  assert.equal(syncs, 1);
  rect = { left: 10, top: 350, width: 320 };
  vm.runInNewContext('positionSettingsPanel();', context);
  assert.equal(panel.style.width, '320px');
  assert.equal(panel.style.left, '10px');
  assert.equal(panel.style.top, '40px');
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
  const checkboxes = ['turn', 'win', 'tools', 'today', 'sub'].map(k => ({ dataset: { k } }));
  const input = { value: '' };
  const context = {
    panel: {
      innerHTML: '',
      querySelector: selector => selector === '.zu-settings-body' ? oldBody : input,
      querySelectorAll: selector => selector === 'input[name=zu-lang]' ? radios : checkboxes,
    },
    state: { lang: 'zh', show: { turn: 0, win: 1, tools: 1, today: 0, sub: 1 }, ctxOv: '200000' },
    VERSION: 'v67', L: (zh, en) => context.state.lang === 'en' ? en : zh,
    syncUpdate: () => { oldBody = body; }, syncSettingsScroll: () => { syncs++; },
  };
  vm.runInNewContext(buildSource + '\nbuildPanel();', context);
  assert.equal(body.scrollTop, 0);
  assert.equal(input.value, '200000');
  assert.deepEqual(radios.map(r => r.checked), [true, false]);
  assert.deepEqual(checkboxes.map(cb => cb.checked), [false, true, true, false, true]);
  assert.match(context.panel.innerHTML, /状态条设置选项/);
  body.scrollTop = 250;
  context.state.lang = 'en';
  vm.runInNewContext('buildPanel();', context);
  assert.equal(body.scrollTop, 250);
  assert.equal(input.value, '200000');
  assert.deepEqual(radios.map(r => r.checked), [false, true]);
  assert.deepEqual(checkboxes.map(cb => cb.checked), [false, true, true, false, true]);
  assert.match(context.panel.innerHTML, /Status bar settings options/);
  assert.equal(syncs, 2);
});

test('context-window changes persist through the actual delegated handler', () => {
  const changeSource = extract('    panel.addEventListener("change",', '    listenGlobal(document, "mousedown",');
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
  for (const key of ['turn', 'win', 'tools', 'today', 'sub']) {
    assert.ok(source.includes('data-k="' + key + '"'));
  }
  for (const selector of ['zu-rate-line', 'zu-auto-update', 'zu-ctxov', 'zu-cn-num', 'data-update="check"', 'data-update="update"', 'name="zu-lang"', 'zu-settings-feedback']) {
    assert.ok(source.includes(selector));
  }
  assert.match(source, /\.zu-settings-body"\)\.scrollTop = scrollTop/);
  assert.match(source, /t2\.classList\.contains\("zu-ctxov"\)/);
  assert.match(source, /t2\.classList\.contains\("zu-cn-num"\)/);
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

/* ---------- v83：万/亿单位开关（默认开、仅中文）+ K/M/B 的 B 档 ---------- */
test('万/亿 preference defaults on, honours only an explicit "0" and round-trips through persist', () => {
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
  assert.equal(boot({}).context.state.cnNum, 1);
  assert.equal(boot({ 'zusage3.cnNum': '0' }).context.state.cnNum, 0);
  assert.equal(boot({ 'zusage3.cnNum': '1' }).context.state.cnNum, 1);
  assert.equal(boot({ 'zusage3.cnNum': 'false' }).context.state.cnNum, 1);   // 非 "0" 一律视为开启
  const { context, store } = boot({});
  context.state.cnNum = 0;
  vm.runInNewContext('persist();', context);
  assert.equal(store['zusage3.cnNum'], '0');
  context.state.cnNum = 1;
  vm.runInNewContext('persist();', context);
  assert.equal(store['zusage3.cnNum'], '1');
});

test('fmt renders 万/亿 by default in Chinese and K/M/B when disabled or in English', () => {
  const fmtSource = extract('  function cnUnits() {', '  function ls(') + extract('    function fmt(n) {', '    function sec(ms) {');
  const context = { state: { lang: 'zh', cnNum: 1 } };
  const fmt = vm.runInNewContext(fmtSource + '\nfmt;', context);
  const samples = [undefined, 0, 950, 9500, 582500, 1420000, 1e8, 123456789, 999000000, 1e9, 1.5e9];
  assert.deepEqual(samples.map(fmt),
    ['0', '0', '950', '9500', '58.25万', '142万', '1亿', '1.23亿', '9.99亿', '10亿', '15亿']);
  const kmb = ['0', '0', '950', '9.5K', '582.5K', '1.42M', '100.00M', '123.46M', '999.00M', '1.00B', '1.50B'];
  context.state.cnNum = 0;
  assert.deepEqual(samples.map(fmt), kmb);
  context.state.cnNum = 1;
  context.state.lang = 'en';
  assert.deepEqual(samples.map(fmt), kmb);   // 英文界面不展示开关，也不得生效
});

test('buildPanel shows the 万/亿 toggle only in Chinese and restores its checked state', () => {
  const buildSource = extract('    function settingRow(', '    function syncSettingsScroll() {');
  const body = { scrollTop: 0 };
  const cnBox = {};
  const context = {
    panel: {
      innerHTML: '',
      querySelector: selector => selector === '.zu-settings-body' ? body
        : selector === '.zu-cn-num' ? (context.panel.innerHTML.includes('zu-cn-num') ? cnBox : null)
        : { value: '' },
      querySelectorAll: () => [],
    },
    state: { lang: 'zh', show: {}, ctxOv: '', cnNum: 1 },
    L: (zh, en) => context.state.lang === 'en' ? en : zh,
    syncUpdate: () => {}, syncSettingsScroll: () => {},
  };
  vm.runInNewContext(buildSource + '\nbuildPanel();', context);
  assert.match(context.panel.innerHTML, /<input type="checkbox" class="zu-cn-num">/);
  assert.match(context.panel.innerHTML, /中文单位（万\/亿）/);
  assert.ok(context.panel.innerHTML.indexOf('zu-cn-num') > context.panel.innerHTML.indexOf('zu-ctxov'));
  assert.ok(context.panel.innerHTML.indexOf('zu-cn-num') < context.panel.innerHTML.indexOf('zu-settings-langs'));
  assert.equal(cnBox.checked, true);
  context.state.cnNum = 0;
  vm.runInNewContext('buildPanel();', context);
  assert.equal(cnBox.checked, false);
  context.state.lang = 'en';
  vm.runInNewContext('buildPanel();', context);   // 英文：整行不出现，回填守卫不得因控件缺席抛错
  assert.doesNotMatch(context.panel.innerHTML, /zu-cn-num/);
  assert.doesNotMatch(context.panel.innerHTML, /万\/亿/);
});

test('syncPanel restores the 万/亿 toggle and tolerates its absence in English', () => {
  const syncSource = extract('    function syncPanel() {', '    panel.addEventListener("click",');
  const cnBox = {}, ctxov = { value: '' };
  let present = true, updates = 0;
  const context = {
    panel: {
      querySelectorAll: () => [],
      querySelector: selector => selector === '.zu-cn-num' ? (present ? cnBox : null) : ctxov,
    },
    state: { show: {}, ctxOv: '128000', cnNum: 0 },
    syncUpdate: () => { updates++; },
  };
  vm.runInNewContext(syncSource + '\nsyncPanel();', context);
  assert.equal(cnBox.checked, false);
  assert.equal(ctxov.value, '128000');
  context.state.cnNum = 1;
  vm.runInNewContext('syncPanel();', context);
  assert.equal(cnBox.checked, true);
  present = false;
  vm.runInNewContext('syncPanel();', context);
  assert.equal(updates, 3);
});

test('万/亿 toggle change persists and re-renders without touching display items', () => {
  const changeSource = extract('    panel.addEventListener("change",', '    listenGlobal(document, "mousedown",');
  let handler, saved = 0, renders = 0;
  const context = {
    panel: { addEventListener: (_, fn) => { handler = fn; } },
    state: { ctxOv: '', show: { ctx: 1 }, cnNum: 1 },
    persist: () => { saved++; }, renderAll: () => { renders++; },
  };
  vm.runInNewContext(changeSource, context);
  const target = checked => ({ type: 'checkbox', checked, dataset: {}, classList: { contains: name => name === 'zu-cn-num' } });
  handler({ target: target(false) });
  assert.equal(context.state.cnNum, 0);
  assert.equal(saved, 1);
  assert.equal(renders, 1);
  assert.deepEqual(context.state.show, { ctx: 1 });   // 必须独立分支：落入 data-k 分支会写 show[undefined]
  handler({ target: target(true) });
  assert.equal(context.state.cnNum, 1);
  assert.equal(saved, 2);
  assert.equal(renders, 2);
  assert.deepEqual(context.state.show, { ctx: 1 });
});

test('the update section goes straight from the buttons to the status line without the retired reinstall prompt', () => {
  const buildSource = extract('    function settingRow(', '    function syncSettingsScroll() {');
  const body = { scrollTop: 0 };
  for (const lang of ['zh', 'en']) {
    const context = {
      panel: {
        innerHTML: '',
        querySelector: selector => selector === '.zu-settings-body' ? body : { value: '' },
        querySelectorAll: () => [],
      },
      state: { lang, show: {}, ctxOv: '', cnNum: 1 },
      L: (zh, en) => lang === 'en' ? en : zh,
      syncUpdate: () => {}, syncSettingsScroll: () => {},
    };
    vm.runInNewContext(buildSource + '\nbuildPanel();', context);
    const html = context.panel.innerHTML;
    /* v95：源码清单的仓库来源改由宿主插件管理器直接更新，v92 的重装口令提示块随之撤下 */
    assert.doesNotMatch(html, /zu-update-fallback|更新zcode 插件|更新装不上/);
    assert.match(html, /zu-update-actions">.*?<\/div><div class="pnote zu-update-status"/s);
  }
});

/* 更新进度条（v89）：用最小 DOM 替身驱动 syncUpdate → syncProgress。 */
function progressHarness(pluginUpdate, lang = 'zh') {
  const syncSource = extract('    function syncUpdate() {', '    function syncPanel() {');
  /* issue #55 后 PROGRESS_STAGES 的 var 赋值上移到 buildPanel 定义之前（先于 buildPanel()
   * 调用执行），切片区间里只剩函数声明；从新位置补进赋值行，切片其余不变 */
  const stagesSource = extract('    var PROGRESS_STAGES = ', '\n');
  const row = () => {
    const fill = { style: {}, classes: new Set(), classList: { toggle(name, on) { on ? this.owner.add(name) : this.owner.delete(name); } } };
    fill.classList.owner = fill.classes;
    const track = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
    const value = { textContent: '' };
    return { fill, track, value, querySelector: s => s === '.zu-progress-fill' ? fill : s === '.zu-progress-track' ? track : value };
  };
  const rows = { download: row(), install: row() };
  const box = { hidden: true, querySelector: s => rows[/data-progress="(\w+)"/.exec(s)[1]] };
  const status = {}, version = {}, controls = {};
  const context = {
    state: { pluginUpdate, rateLine: true },
    panel: { querySelector: s => s === '.zu-update-progress' ? box : s === '.zu-settings-version' ? version
      : s === '.zu-update-status' ? status : (controls[s] ||= {}) },
    L: (zh, en) => lang === 'en' ? en : zh,
  };
  vm.runInNewContext(stagesSource + '\n' + syncSource + '\nsyncUpdate();', context);
  const read = key => ({ width: rows[key].fill.style.width, active: rows[key].fill.classes.has('active'),
    now: rows[key].track.attrs['aria-valuenow'], text: rows[key].value.textContent });
  return { box, status, context, rows, read, rerun: () => vm.runInNewContext('syncUpdate();', context) };
}
const base = { supported: true, auto: true, currentVersion: '1.5.0', latestVersion: '1.5.1', channel: 'release' };

test('update source line names the market channel for repository-source catalogs and keeps release/local wording', () => {
  const market = progressHarness({ ...base, phase: 'current', channel: 'market', channelHost: 'github' });
  assert.match(market.status.textContent, /更新来源：GitHub 仓库源码（由插件管理器直接更新）/);
  assert.match(market.status.textContent, / · 市场版本：1\.5\.1/);
  assert.doesNotMatch(market.status.textContent, /Release/);
  const gitcode = progressHarness({ ...base, phase: 'current', channel: 'market', channelHost: 'gitcode' }, 'en');
  assert.match(gitcode.status.textContent, /Update source: GitCode repository source \(updated directly by the plugin manager\)/);
  const release = progressHarness({ ...base, phase: 'current', channelHost: 'github' });
  assert.match(release.status.textContent, /更新来源：GitHub 正式 Release（校验 ZIP 与 SHA256）/);
  const local = progressHarness({ ...base, phase: 'current', channel: 'local' });
  assert.match(local.status.textContent, /更新来源：本地目录市场/);
});

test('checking phase disables both buttons and announces the check in the status line', () => {
  const h = progressHarness({ ...base, phase: 'checking', busy: true });
  assert.match(h.status.textContent, /^正在检查更新…/);
  assert.equal(h.context.panel.querySelector('[data-update=check]').disabled, true);
  assert.equal(h.context.panel.querySelector('[data-update=update]').disabled, true);
  assert.equal(h.box.hidden, true);
});

test('download phase shows byte progress on the download bar and parks the install bar', () => {
  const h = progressHarness({ ...base, phase: 'downloading', busy: true,
    progress: { stage: 'download', loaded: 291040, total: 582080 } });
  assert.match(h.status.textContent, /^正在下载更新…/);
  assert.doesNotMatch(h.status.textContent, /正在检查更新/);
  assert.equal(h.box.hidden, false);
  assert.deepEqual(h.read('download'), { width: '50%', active: true, now: '50', text: '50% · 284 KB / 568 KB' });
  assert.deepEqual(h.read('install'), { width: '0%', active: false, now: '0', text: '等待下载完成' });
  assert.equal(h.context.panel.querySelector('[data-update=update]').disabled, true);   // 下载中不可重复点击
});

test('verify, install and sync stages complete the download bar and advance the install bar', () => {
  const h = progressHarness({ ...base, phase: 'downloading', busy: true, progress: { stage: 'verify' } });
  assert.deepEqual(h.read('download'), { width: '100%', active: false, now: '100', text: '100%' });
  assert.deepEqual(h.read('install'), { width: '15%', active: true, now: '15', text: '校验中' });
  h.context.state.pluginUpdate = { ...base, phase: 'updating', busy: true, progress: { stage: 'install' } };
  h.rerun();
  assert.match(h.status.textContent, /^正在安装更新…/);
  assert.deepEqual(h.read('install'), { width: '55%', active: true, now: '55', text: '安装中' });
  h.context.state.pluginUpdate = { ...base, phase: 'updating', busy: true, progress: { stage: 'sync' } };
  h.rerun();
  assert.deepEqual(h.read('install'), { width: '90%', active: true, now: '90', text: '同步中' });
  assert.equal(h.box.hidden, false);
});

test('progress block hides when the main process sends no progress, after completion, on error and when unsupported', () => {
  for (const update of [
    { ...base, phase: 'updating', busy: true },                       // 旧版主进程：无 progress 字段
    { ...base, phase: 'updated', progress: null },
    { ...base, phase: 'error', error: 'boom', progress: null },
    { ...base, phase: 'available', progress: { stage: 'download', loaded: 1, total: 2 } },   // 非进行中阶段忽略残留
    { ...base, supported: false, phase: 'downloading', progress: { stage: 'download', loaded: 1, total: 2 } },
    null,
  ]) {
    const h = progressHarness(update);
    assert.equal(h.box.hidden, true, JSON.stringify(update));
  }
  const old = progressHarness({ ...base, phase: 'updating', busy: true });
  assert.match(old.status.textContent, /^正在安装更新…/);   // 文案仍正常，只是没有进度条
});

test('progress labels and byte units localize', () => {
  const h = progressHarness({ ...base, phase: 'downloading', busy: true,
    progress: { stage: 'download', loaded: 1572864, total: 2097152 } }, 'en');
  assert.match(h.status.textContent, /^Downloading update…/);
  assert.deepEqual(h.read('download'), { width: '75%', active: true, now: '75', text: '75% · 1.5 MB / 2.0 MB' });
  assert.equal(h.read('install').text, 'Waiting for download');
  const unknown = progressHarness({ ...base, phase: 'downloading', busy: true, progress: { stage: 'download', loaded: 512 } });
  assert.deepEqual(unknown.read('download'), { width: '0%', active: true, now: '0', text: '512 B' });   // 无 total 时只报已下载字节
});

test('update source line names the host: GitHub, GitCode or the local directory', () => {
  const h = progressHarness({ ...base, phase: 'idle' });
  assert.match(h.status.textContent, /更新来源：GitHub 正式 Release/);
  h.context.state.pluginUpdate = { ...base, phase: 'idle', channelHost: 'gitcode' };
  h.rerun();
  assert.match(h.status.textContent, /更新来源：GitCode 正式 Release（校验 ZIP 与 SHA256）/);
  h.context.state.pluginUpdate = { ...base, phase: 'idle', channel: 'local' };
  h.rerun();
  assert.match(h.status.textContent, /更新来源：本地目录市场/);
  const en = progressHarness({ ...base, phase: 'idle', channelHost: 'gitcode' }, 'en');
  assert.match(en.status.textContent, /stable GitCode Release/);
});
