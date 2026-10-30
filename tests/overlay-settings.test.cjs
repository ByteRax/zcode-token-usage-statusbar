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
    panel, bar: { getBoundingClientRect: () => rect }, innerWidth: 1400, innerHeight: 900,
    state: { theme: 'default' }, syncSettingsScroll: () => { syncs++; },
  };
  vm.runInNewContext(positionSource + '\npositionSettingsPanel();', context);
  assert.equal(values['--zu-settings-height'], '582px');
  assert.equal(panel.style.height, '582px');   // v101：打开时按内容自然高锁定（stub 无 scrollHeight 退 offsetHeight）
  assert.equal(panel.style.width, '800.5px');
  assert.equal(panel.style.left, '250px');   // v80 面板挂 body：视口坐标左缘随条
  assert.equal(panel.style.top, '290px');    // 条上沿 600 − 面板高 300 − 10px 缝
  assert.equal(syncs, 1);
  rect = { left: 10, top: 350, width: 320 };
  vm.runInNewContext('positionSettingsPanel();', context);
  assert.equal(panel.style.width, '320px');
  assert.equal(panel.style.left, '10px');
  assert.equal(panel.style.top, '40px');
  assert.equal(panel.style.height, '332px');   // 已锁高度 < 收紧后的上限：保持不动
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
    slot: 0,
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

test('restart-notice toggle reflects pushed truth and posts through the delegated handler', () => {
  const syncSource = extract('    function syncUpdate() {', '    function syncPanel() {');
  const changeSource = extract('    panel.addEventListener("change",', '    listenGlobal(document, "mousedown",');
  let handler, requested = null;
  const rn = { checked: true };
  const stub = () => ({ textContent: '', hidden: true, disabled: false });
  const syncContext = {
    state: { pluginUpdate: { supported: true, auto: true, phase: 'idle' }, restartNotice: false },
    panel: { querySelector: selector => selector === '.zu-restart-notice' ? rn : stub() },
    L: (zh) => zh,
  };
  vm.runInNewContext(syncSource + '\nsyncUpdate();', syncContext);
  assert.equal(rn.checked, false);   // 主进程推送 restartNotice=false：回显关闭
  syncContext.state.restartNotice = undefined;
  vm.runInNewContext('syncUpdate();', syncContext);
  assert.equal(rn.checked, true);   // 缺省/异常值回显开启（与 Python 端 is not False 同向）
  vm.runInNewContext(changeSource, {
    panel: { addEventListener: (_, fn) => { handler = fn; } },
    state: {},
    pluginRequest: (action, enabled) => { requested = [action, enabled]; },
  });
  handler({ target: { classList: { contains: name => name === 'zu-restart-notice' }, checked: false } });
  assert.deepEqual(requested, ['restart-notice', false]);
});

test('panel retains all controls, scroll position and settings-only styling', () => {
  assert.match(source, /panel.className = "panel zu-settings"/);
  for (const key of ['turn', 'win', 'tools', 'today', 'sub']) {
    assert.ok(source.includes('data-k="' + key + '"'));
  }
  for (const selector of ['zu-rate-line', 'zu-auto-update', 'zu-restart-notice', 'zu-ctxov', 'zu-cn-num', 'data-update="check"', 'data-update="update"', 'name="zu-lang"', 'zu-settings-feedback']) {
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
    slot: 0,
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
    slot: 0,
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
      querySelector: selector => selector === '.zu-cn-num' ? (present ? cnBox : null) : selector === '.zu-ctxov' ? ctxov : { value: '' },   // v135：syncPanel 还会回填 .zu-rst-cdh，独立桩避免误写 ctxov
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
      slot: 0,
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

/* ---------- v100：设置面板分区导航（ZCode 设置侧栏同款） ---------- */
function buildHarness(state) {
  const buildSource = extract('    function settingRow(', '    function syncSettingsScroll() {');
  const body = { scrollTop: 0 };
  const context = {
    slot: 0,
    panel: { innerHTML: '', querySelector: () => body, querySelectorAll: () => [] },
    state: Object.assign({ lang: 'zh', show: {}, ctxOv: '' }, state),
    L: (zh, en) => context.state.lang === 'en' ? en : zh,
    syncUpdate: () => { }, syncSettingsScroll: () => { },
  };
  vm.runInNewContext(buildSource + '\nbuildPanel();', context);
  return context;
}

test('settings nav groups six sections under three captions with the active state inline', () => {
  const html = buildHarness({ settingsSec: 'quota' }).panel.innerHTML;
  assert.match(html, /class="zu-settings-nav" aria-label="设置分区"/);
  for (const cap of ['>基础</div>', '>数据与统计</div>', '>维护</div>']) assert.ok(html.includes(cap), cap);
  assert.match(html, /data-sec="quota" aria-current="page" title="套餐额度"/);
  assert.match(html, /<section class="zu-settings-section" data-sec="quota">/);
  assert.ok(html.includes('<section class="zu-settings-section" data-sec="display" hidden>'));
  assert.ok(html.includes('<section class="zu-settings-section" data-sec="about" hidden>'));
  const en = buildHarness({ settingsSec: 'quota', lang: 'en' }).panel.innerHTML;
  assert.match(en, /aria-label="Settings sections"/);
  assert.match(en, /data-sec="quota" aria-current="page" title="Plan quota"/);
  assert.match(en, /<span class="zu-nav-label">Plan quota<\/span>/);
});

test('an unknown stored section falls back to the first section instead of a blank panel', () => {
  const html = buildHarness({ settingsSec: 'nope' }).panel.innerHTML;
  assert.match(html, /data-sec="display" aria-current="page" title="状态条显示"/);
  assert.ok(html.includes('<section class="zu-settings-section" data-sec="display">'));
  assert.ok(html.includes('<section class="zu-settings-section" data-sec="quota" hidden>'));
});

test('nav clicks switch the visible section through the delegated handler, persist and reset scroll', () => {
  const clickSource = extract('    panel.addEventListener("click",', '    gear.addEventListener("click"');
  let handler;
  const ids = ['display', 'general', 'stats', 'quota', 'update', 'about'];
  const mk = id => ({
    id, hidden: true, cur: false, dataset: { sec: id },
    getAttribute: k => (k === 'data-sec' ? id : null),
    setAttribute(k) { if (k === 'aria-current') this.cur = true; },
    removeAttribute(k) { if (k === 'aria-current') this.cur = false; },
    hasAttribute: function (k) { return k === 'aria-current' && this.cur; },
  });
  const sections = ids.map(id => { const o = mk(id); o.hidden = id !== 'display'; return o; });
  const items = ids.map(id => { const o = mk(id); o.cur = id === 'display'; return o; });
  const body = { scrollTop: 250 };
  const context = {
    panel: {
      addEventListener: (_, fn) => { handler = fn; },
      classList: { remove() { }, toggle() { } },
      querySelectorAll: sel => (sel === '.zu-navitem' ? items : sections),
      querySelector: () => body,
    },
    state: { settingsSec: 'display' },
    persist: () => { context.saved = (context.saved || 0) + 1; },
    syncSettingsScroll: () => { context.synced = (context.synced || 0) + 1; },
    activeSettingsSec: () => context.state.settingsSec,
  };
  vm.runInNewContext(clickSource, context);
  const quota = items[3];
  handler({ target: { closest: sel => (sel === '.zu-navitem' ? quota : null) } });
  assert.equal(context.state.settingsSec, 'quota');
  assert.equal(context.saved, 1);
  assert.deepEqual(sections.map(s => !s.hidden), [false, false, false, true, false, false]);
  assert.deepEqual(items.map(b => b.cur), [false, false, false, true, false, false]);
  assert.equal(body.scrollTop, 0);
  assert.equal(context.synced, 1);
  handler({ target: { closest: sel => (sel === '.zu-navitem' ? quota : null) } });   // 重复点击当前分区：不重置滚动
  assert.equal(body.scrollTop, 0);
  assert.equal(context.synced, 1);
});

test('active section persists through LS and restores on boot', () => {
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
  assert.equal(boot({}).context.state.settingsSec, 'display');
  assert.equal(boot({ 'zusage3.sec': 'quota' }).context.state.settingsSec, 'quota');
  const { context, store } = boot({ });
  context.state.settingsSec = 'update';
  vm.runInNewContext('persist();', context);
  assert.equal(store['zusage3.sec'], 'update');
});

test('narrow panels collapse the nav to an icon rail by measured width', () => {
  function rail(width) {
    const body = { scrollHeight: 900, clientHeight: 400, scrollTop: 0 };
    const button = { textContent: '', disabled: false };
    const classes = {};
    const panel = {
      offsetWidth: width,
      querySelector: selector => selector === '.zu-settings-body' ? body : button,
      classList: { toggle: (name, on) => { classes[name] = on; } },
    };
    vm.runInNewContext(scrollSource + '\nsyncSettingsScroll();', { panel, L: (zh, en) => zh });
    return classes['zu-nav-icons'];
  }
  assert.equal(rail(520), true);
  assert.equal(rail(620), false);
  assert.equal(rail(undefined), false);   // 未挂载/存根环境：保持展开，不误收
});

test('settings keyboard handling supports Escape and nav arrow movement without trapping Tab', () => {
  const source = extract('    var previousPanelFocus = null;', '    buildPanel();');
  const buttons = [{ focus() { active = this; } }, { focus() { active = this; } }];
  let active = buttons[0], keydown, opened = true, modal = 'true', expanded = 'true';
  let focusTarget = null;
  const panel = {
    classList: { remove() { opened = false; } },
    setAttribute(name, value) { if (name === 'aria-modal') modal = value; },
    querySelector: () => ({ querySelectorAll: () => buttons }),
    addEventListener(type, fn) { if (type === 'keydown') keydown = fn; },
  };
  const gear = { setAttribute(name, value) { if (name === 'aria-expanded') expanded = value; }, focus() { focusTarget = this; } };
  const previousPanelFocus = null;
  const document = { activeElement: active };
  const context = { panel, gear, document, previousPanelFocus, closeSettings: undefined, Array, inactive: () => false,
    syncSettingsScroll() {} };
  vm.runInNewContext(source + '\n', context);
  keydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  assert.equal(active, buttons[1]);
  keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(opened, false);
  assert.equal(modal, 'false');
  assert.equal(expanded, 'false');
});

test('settings height uses the increased viewport cap, locks on open and only tightens', () => {
  const values = { };
  const panel = {
    offsetWidth: 420, offsetHeight: 300, scrollHeight: 850,
    classList: { contains: () => true },
    style: { getPropertyValue: k => values[k], setProperty: (k, v) => { values[k] = v; } },
  };
  let rect = { left: 250, top: 1000, width: 800.5 };
  const context = {
    panel, bar: { getBoundingClientRect: () => rect }, innerWidth: 1400, innerHeight: 900,
    state: { theme: 'default' }, syncSettingsScroll: () => { },
  };
  vm.runInNewContext(positionSource + '\npositionSettingsPanel();', context);
  assert.equal(values['--zu-settings-height'], '982px');
  assert.equal(panel.style.height, '810px');   // 视口与状态条上沿共同限制面板最大高度
  rect = { left: 10, top: 350, width: 320 };   // 可用上限收紧到 332
  vm.runInNewContext('positionSettingsPanel();', context);
  assert.equal(panel.style.height, '332px');
  rect = { left: 10, top: 1000, width: 320 };  // 上限放宽：保持已锁高度，不放大
  vm.runInNewContext('positionSettingsPanel();', context);
  assert.equal(panel.style.height, '332px');
});

/* ---------- v136 编辑项目弹窗完整路径（项目完整路径开关） ---------- */

test('the full-path rule is stylesheet-gated by data-zusage-pp and reads the row title', () => {
  // 规则挂在条样式表内：attr(title) 取每行各自完整路径，.truncate 限定本地行（fixedFolder 行 break-all 排除防重复）
  // 属性值必须带引号：CSS 属性选择器的未加引号值不能是数字（[pp=1] 会被整条丢弃，Chrome 实测）
  assert.match(source, /'\[data-zusage-pp="1"\] \[data-testid=virtual-project-root-name\]\.truncate::after\{content:attr\(title\);' \+/);
  // 用户规格：长路径自动换行不做省略号——宿主 truncate 的 nowrap 会继承进伪元素，必须显式恢复
  assert.ok(source.includes('"display:block;white-space:normal;word-break:break-all;" +'));
  const ruleText = source.match(/'\[data-zusage-pp="1"\][^]*?#8791a3\)\}" \+/)[0];
  assert.ok(!ruleText.includes('text-overflow'), 'rule must wrap, not ellipsize');
  assert.ok(source.includes('"font-size:var(--text-ui-sm,calc(var(--ui-font-size,14px) - 2px));line-height:1.45;" +'));
  assert.ok(source.includes('"color:var(--color-foreground-subtle,#8791a3)}" +'));
  // testid 出现处 = 样式表字符串 2 处（v136 路径行 + v137 cursor 规则）+ v137 点击委托 closest 选择器 1 处，无 DOM 创建/观察器
  assert.equal(source.split('virtual-project-root-name').length - 1, 3);
});

test('applyProjPath gates the path display on <html> and tolerates hostile documents', () => {
  const ppSource = source.match(/  function applyProjPath\(\) \{[\s\S]*?\n  \}/)[0];
  const attrs = {};
  const document = {
    documentElement: {
      setAttribute: (k, v) => { attrs[k] = v; },
      removeAttribute: k => { delete attrs[k]; },
    },
  };
  const context = { state: { projPath: 1 }, document };
  vm.runInNewContext(ppSource + '\napplyProjPath();', context);
  assert.equal(attrs['data-zusage-pp'], '1');
  context.state.projPath = 0;
  vm.runInNewContext('applyProjPath();', context);
  assert.ok(!('data-zusage-pp' in attrs));
  const broken = { state: { projPath: 1 }, document: null };
  vm.runInNewContext(ppSource + '\napplyProjPath();', broken);   // document 不可用时不抛
});

test('buildPanel shows the full-path toggle in both languages and restores its checked state', () => {
  const buildSource = extract('    function settingRow(', '    function syncSettingsScroll() {');
  const body = { scrollTop: 0 };
  const ppBox = {};
  const context = {
    slot: 0,
    panel: {
      innerHTML: '',
      querySelector: selector => selector === '.zu-settings-body' ? body
        : selector === '.zu-pp-enable' ? (context.panel.innerHTML.includes('zu-pp-enable') ? ppBox : null)
        : { value: '' },
      querySelectorAll: () => [],
    },
    state: { lang: 'zh', show: {}, ctxOv: '', cnNum: 1, projPath: 1 },
    L: (zh, en) => context.state.lang === 'en' ? en : zh,
    syncUpdate: () => {}, syncSettingsScroll: () => {},
  };
  vm.runInNewContext(buildSource + '\nbuildPanel();', context);
  assert.match(context.panel.innerHTML, /<input type="checkbox" class="zu-pp-enable">/);
  assert.match(context.panel.innerHTML, /项目完整路径/);
  assert.ok(context.panel.innerHTML.indexOf('zu-pp-enable') > context.panel.innerHTML.indexOf('zu-cn-num'));
  assert.ok(context.panel.innerHTML.indexOf('zu-pp-enable') < context.panel.innerHTML.indexOf('zu-settings-langs'));
  assert.equal(ppBox.checked, true);
  context.state.projPath = 0;
  vm.runInNewContext('buildPanel();', context);
  assert.equal(ppBox.checked, false);
  context.state.lang = 'en';
  vm.runInNewContext('buildPanel();', context);   // 英文：开关照常出现，不依赖中文单位行
  assert.match(context.panel.innerHTML, /Full project paths/);
  assert.equal(ppBox.checked, false);
});

test('syncPanel restores the full-path toggle and tolerates its absence', () => {
  const syncSource = extract('    function syncPanel() {', '    panel.addEventListener("click",');
  const ppBox = {}, ctxov = { value: '' };
  let present = true, updates = 0;
  const context = {
    panel: {
      querySelectorAll: () => [],
      querySelector: selector => selector === '.zu-pp-enable' ? (present ? ppBox : null) : selector === '.zu-ctxov' ? ctxov : { value: '' },
    },
    state: { show: {}, ctxOv: '', cnNum: 1, projPath: 0 },
    syncUpdate: () => { updates++; },
  };
  vm.runInNewContext(syncSource + '\nsyncPanel();', context);
  assert.equal(ppBox.checked, false);
  context.state.projPath = 1;
  vm.runInNewContext('syncPanel();', context);
  assert.equal(ppBox.checked, true);
  present = false;
  vm.runInNewContext('syncPanel();', context);
  assert.equal(updates, 3);
});

test('full-path toggle persists and flips the gate without re-rendering or touching display items', () => {
  const changeSource = extract('    panel.addEventListener("change",', '    listenGlobal(document, "mousedown",');
  let handler, saved = 0, gates = 0, renders = 0;
  const context = {
    panel: { addEventListener: (_, fn) => { handler = fn; } },
    state: { ctxOv: '', show: { ctx: 1 }, projPath: 1 },
    persist: () => { saved++; },
    applyProjPath: () => { gates++; },
    renderAll: () => { renders++; },
  };
  vm.runInNewContext(changeSource, context);
  const target = checked => ({ type: 'checkbox', checked, dataset: {}, classList: { contains: name => name === 'zu-pp-enable' } });
  handler({ target: target(false) });
  assert.equal(context.state.projPath, 0);
  assert.equal(saved, 1);
  assert.equal(gates, 1);
  assert.equal(renders, 0);   // 纯 CSS 门控即时生效，无需 renderAll
  assert.deepEqual(context.state.show, { ctx: 1 });   // 必须独立分支：落入 data-k 分支会写 show[undefined]
  handler({ target: target(true) });
  assert.equal(context.state.projPath, 1);
  assert.equal(saved, 2);
  assert.equal(gates, 2);
});

/* ---------- v137 点击源文件夹行在文件管理器中打开 ---------- */

function extractProjClickBlock() {
  const m = source.match(/  \/\* v137 点击源文件夹行[\s\S]*?\n  try \{/);
  assert.ok(m, 'v137 block missing');
  return m[0].replace(/\n  try \{$/, '');
}

test('projFileUrl builds file URLs for POSIX, Windows drives and UNC shares', () => {
  const context = { state: { projPath: 1 }, window: {}, document: { querySelector: () => null }, __args: [], __out: null };
  context.__args = ['/Users/a b/c#d?', 'C:\\work\\demo app', '\\\\srv\\share\\x', '/plain/path'];
  vm.runInNewContext(extractProjClickBlock() + '\n__out = __args.map(projFileUrl);', context);
  assert.deepEqual(context.__out, [
    'file:///Users/a%20b/c%23d%3F',
    'file:///C:/work/demo%20app',
    'file://srv/share/x',
    'file:///plain/path',
  ]);
});

test('openProjFolder prefers openInFileManager then falls back over the raw path', () => {
  const block = extractProjClickBlock();
  const calls = (zc) => {
    const context = { state: { projPath: 1 }, window: { zcode: zc }, document: { querySelector: () => null } };
    vm.runInNewContext(block + '\nopenProjFolder("/a b/c");', context);
    return zc;
  };
  calls({ openInFileManager: p => calls.got = ['fm', p] });
  assert.deepEqual(calls.got, ['fm', '/a b/c']);
  calls({ openExternalFile: p => calls.got = ['file', p] });
  assert.deepEqual(calls.got, ['file', '/a b/c']);
  calls({ openExternal: u => calls.got = ['ext', u] });
  assert.deepEqual(calls.got, ['ext', 'file:///a%20b/c']);
  const bare = { state: { projPath: 1 }, window: {}, document: { querySelector: () => null } };
  vm.runInNewContext(block + '\nopenProjFolder("/x");', bare);   // 无桥不抛（静默忽略）
  const broken = { state: { projPath: 1 }, window: { zcode: { openInFileManager: () => { throw new Error('x'); } } }, document: { querySelector: () => null } };
  vm.runInNewContext(block + '\nopenProjFolder("/x");', broken);   // 桥抛错不外冒
});

test('folder-row clicks open the file manager with gates: toggle, button, remote editor and dedup', () => {
  const block = extractProjClickBlock();
  const make = ({ projPath = 1, remote = false } = {}) => {
    const opened = [];
    const ctx = vm.createContext({
      state: { projPath },
      window: { zcode: { openInFileManager: p => opened.push(p) } },
      document: { querySelector: () => (remote ? {} : null) },
      Date,
    });
    vm.runInContext(block, ctx);   // 去重状态（projOpenAt/projOpenPath）须在同一 context 内跨点击延续
    const click = (button = 0, path = '/some/dir') => {
      ctx.__b = button;
      ctx.__t = { closest: sel => (sel === '[data-testid=virtual-project-root-name].truncate' ? { getAttribute: () => path } : null) };
      vm.runInContext('onProjRowClick({ button: __b, target: __t });', ctx);
    };
    return { opened, click };
  };
  const t = make();
  t.click();
  assert.deepEqual(t.opened, ['/some/dir']);
  t.click();                        // 500ms 内同路径（多实例重复委托）去重
  assert.equal(t.opened.length, 1);
  t.click(1);                       // 非左键不响应
  assert.equal(t.opened.length, 1);
  t.click(0, '/other/dir');         // 不同路径不受去重限制
  assert.deepEqual(t.opened, ['/some/dir', '/other/dir']);
  const off = make({ projPath: 0 });
  off.click();
  assert.deepEqual(off.opened, []);
  const remote = make({ remote: true });
  remote.click();
  assert.deepEqual(remote.opened, []);   // 远程项目编辑器：路径属于远端机器
});

test('the click delegate is bound per instance with the pointer cursor gated by data-zusage-pp', () => {
  assert.match(source, /listenGlobal\(document, "click", onProjRowClick\);/);
  assert.match(source, /data-zusage-pp=\\"1\\"\] \[data-testid=virtual-project-root-name\]\.truncate\{cursor:pointer\}/);
});
