const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');
const { readOverlaySource, readOverlayPart, getNamedSlice } = require('./helpers/overlay-extract.cjs');

const source = readOverlaySource();
const rotatorSlice = getNamedSlice('statusRotator');
// 词包纯数据已拆分至独立分片（拼接产物中位于 statusRotator 切片起点之前），测试环境须显式载入
const packDataSlice = readOverlayPart('04-rotator-builtin-packs.js');

function makeFakeElement(tag = 'div') {
  const attrs = {};
  const classes = new Set();
  const children = [];
  const styleProps = {};
  const listeners = {};
  let innerHTMLVal = '';
  let textContentVal = '';

  const el = {
    tagName: String(tag).toUpperCase(),
    parentElement: null,
    isConnected: true,
    checked: false,
    hidden: false,
    value: '',
    title: '',
    style: new Proxy(styleProps, {
      get(target, prop) {
        if (prop === 'setProperty') return (k, v) => { target[k] = v; };
        return target[prop] || '';
      },
      set(target, prop, val) {
        target[prop] = String(val);
        return true;
      }
    }),
    classList: {
      add: (...list) => list.forEach(c => c && classes.add(c)),
      remove: (...list) => list.forEach(c => classes.delete(c)),
      contains: c => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      }
    },
    get className() { return Array.from(classes).join(' '); },
    set className(v) {
      classes.clear();
      String(v || '').split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
    },
    get textContent() { return textContentVal; },
    set textContent(v) { textContentVal = String(v == null ? '' : v); },
    get innerHTML() { return innerHTMLVal; },
    set innerHTML(v) {
      innerHTMLVal = String(v == null ? '' : v);
      children.length = 0;
      if (innerHTMLVal.includes('zu-whale-tail')) {
        const svg = makeFakeElement('svg');
        svg.className = 'zu-whale-tail';
        const vb = /viewBox="([^"]*)"/.exec(innerHTMLVal);
        if (vb) svg.setAttribute('viewBox', vb[1]);
        const pathEl = makeFakeElement('path');
        const m = /<path d="([^"]*)"/.exec(innerHTMLVal);
        if (m) pathEl.setAttribute('d', m[1]);
        svg.appendChild(pathEl);
        if (el.classList.contains('zu-whale-tail-wrap')) {
          el.appendChild(svg);
        } else {
          const wrap = makeFakeElement('span');
          wrap.className = 'zu-whale-tail-wrap';
          wrap.appendChild(svg);
          el.appendChild(wrap);
        }
      }
      if (innerHTMLVal.includes('zu-rotator-active-label')) {
        const re = /<span class="([^"]*zu-rotator-active-label[^"]*)">([^<]*)<\/span>/g;
        let m2;
        while ((m2 = re.exec(innerHTMLVal))) {
          const lbl = makeFakeElement('span');
          lbl.className = m2[1];
          lbl.textContent = m2[2];
          el.appendChild(lbl);
        }
      }
    },
    get firstChild() { return children[0] || null; },
    children,
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k); },
    removeAttribute(k) { delete attrs[k]; },
    appendChild(child) {
      if (!child) return null;
      if (child.parentElement) {
        const oldIdx = child.parentElement.children.indexOf(child);
        if (oldIdx >= 0) child.parentElement.children.splice(oldIdx, 1);
      }
      child.parentElement = el;
      child.isConnected = true;
      children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      if (!child) return null;
      if (child.parentElement) {
        const oldIdx = child.parentElement.children.indexOf(child);
        if (oldIdx >= 0) child.parentElement.children.splice(oldIdx, 1);
      }
      child.parentElement = el;
      child.isConnected = true;
      const idx = children.indexOf(ref);
      if (idx >= 0) children.splice(idx, 0, child);
      else children.unshift(child);
      return child;
    },
    /* v347 附加时长 span 的判位（nextElementSibling）与插入（insertAdjacentElement）走真实兄弟序 */
    get nextElementSibling() {
      const p = el.parentElement;
      if (!p) return null;
      const idx = p.children.indexOf(el);
      if (idx < 0) return null;
      return p.children[idx + 1] || null;
    },
    insertAdjacentElement(pos, node) {
      if (!node) return null;
      const p = el.parentElement;
      if (!p) return null;
      if (node.parentElement) {
        const oldIdx = node.parentElement.children.indexOf(node);
        if (oldIdx >= 0) node.parentElement.children.splice(oldIdx, 1);
      }
      const idx = p.children.indexOf(el);
      if (idx >= 0) p.children.splice(idx + 1, 0, node);
      else p.children.push(node);
      node.parentElement = p;
      node.isConnected = true;
      return node;
    },
    remove() {
      el.isConnected = false;
      if (el.parentElement) {
        const idx = el.parentElement.children.indexOf(el);
        if (idx >= 0) el.parentElement.children.splice(idx, 1);
      }
    },
    closest(sel) {
      let cur = el;
      while (cur) {
        if (sel.startsWith('.') && cur.classList && cur.classList.contains(sel.slice(1))) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
    dispatchEvent(type, ev = {}) {
      (listeners[type] || []).forEach(fn => fn(ev));
    },
    getBoundingClientRect() { return { width: 200, height: 100, top: 0, left: 0 }; },
    querySelectorAll(sel) {
      const out = [];
      function matchOne(node, s) {
        s = s.trim();
        if (s === 'path') return node.tagName === 'PATH';
        if (s === 'span.grid') return node.tagName === 'SPAN' && node.classList.contains('grid');
        if (s === 'span.animated-gradient-text') return node.tagName === 'SPAN' && node.classList.contains('animated-gradient-text');   // 宿主 3.18.0 新 label
        if (s === '[data-chat-loading-icon]') return node.hasAttribute('data-chat-loading-icon');   // 宿主 3.18.0 新 spinner 图标位
        if (s === 'svg.ico') return node.tagName === 'SVG' && node.classList.contains('ico');
        if (s === '.zu-whale-tail path') return node.tagName === 'PATH';
        if (s === '.zusage-root .zu-main') return node.classList.contains('zu-main');
        if (s === '[data-testid="chat-loading"]') return node.getAttribute('data-testid') === 'chat-loading';
        if (s === '[data-zusage-rotator-slot]') return node.hasAttribute('data-zusage-rotator-slot');
        if (s.startsWith('.')) return node.classList.contains(s.slice(1));
        return false;
      }
      const selectors = String(sel).split(',');
      function walk(node) {
        for (const c of node.children) {
          if (selectors.some(s => matchOne(c, s))) out.push(c);
          walk(c);
        }
      }
      walk(el);
      return out;
    },
    querySelector(sel) {
      return el.querySelectorAll(sel)[0] || null;
    }
  };
  return el;
}

function makeRotatorEnv(lang = 'zh', savedCfg = null, legacyCfg = null) {
  const storage = {};
  if (savedCfg) storage['zusage3.rotator2'] = JSON.stringify(savedCfg);
  if (legacyCfg) storage['zusage3.rotator'] = JSON.stringify(legacyCfg);   // 求值前预置，loadRotatorConfig 真实读到
  const body = makeFakeElement('body');
  const docEl = makeFakeElement('html');
  docEl.classList.add('dark');

  let NOW = 1700000000000;
  class FakeDate extends Date {
    constructor(...args) { super(args.length === 0 ? NOW : args[0]); }
    static now() { return NOW; }
  }

  const docListeners = new Map();
  const document = {
    title: 'ZCode Host Title',
    body,
    documentElement: docEl,
    createElement: tag => makeFakeElement(tag),
    querySelectorAll: sel => body.querySelectorAll(sel),
    querySelector: sel => body.querySelector(sel),
    addEventListener(type, fn, capture) {
      const key = capture ? 'cap:' + type : type;
      (docListeners.get(key) || docListeners.set(key, []).get(key)).push(fn);
    },
    removeEventListener(type, fn, capture) {
      const list = docListeners.get(capture ? 'cap:' + type : type);
      if (list) { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }
    },
    dispatchDocument(type, ev, capture) {
      (docListeners.get(capture ? 'cap:' + type : type) || []).forEach(fn => fn(ev));
    }
  };
  const window = {
    innerWidth: 1280,
    innerHeight: 800
  };
  const state = { lang, data: { session: { model: 'DeepSeek-V3' } } };
  const instances = [];
  const timers = new Map();
  let tid = 0;
  const ctx = vm.createContext({
    window,
    document,
    navigator: { clipboard: { writeText: () => {} } },
    state,
    instances,
    FATAL: {},
    L: (zh, en) => (state.lang === 'en' ? en : zh),
    ls: (k, d) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : d),
    lsSet: (k, v) => { storage[k] = String(v); },
    stale: () => false,
    zuToolVerb: name => (name === 'Bash' ? '执行命令' : name),
    setInterval: (fn, ms) => { timers.set(++tid, { fn, ms, interval: true }); return tid; },
    clearInterval: n => timers.delete(n),
    setTimeout: (fn, ms) => { timers.set(++tid, { fn, ms, interval: false }); return tid; },
    clearTimeout: n => timers.delete(n),
    Date: FakeDate, Math, JSON, Number, String, Array, Object, RegExp, Infinity, isFinite, parseInt, parseFloat
  });
  vm.runInContext(packDataSlice, ctx);
  vm.runInContext(rotatorSlice, ctx);
  return {
    ctx, window, document, body, storage, state, instances, timers,
    advanceNow: ms => { NOW += ms; },
    now: () => NOW
  };
}

function buildChatRow(body, labelText = '工作中...') {
  const chatRow = makeFakeElement('div');
  chatRow.setAttribute('data-testid', 'chat-loading');
  const pixelGrid = makeFakeElement('span');
  pixelGrid.className = 'grid';
  const label = makeFakeElement('span');
  label.className = 'zcode-loading-label';
  label.textContent = labelText;
  const clock = makeFakeElement('span');
  clock.className = 'font-mono tabular-nums';
  clock.textContent = '12.3s';
  chatRow.appendChild(pixelGrid);
  chatRow.appendChild(label);
  chatRow.appendChild(clock);
  body.appendChild(chatRow);
  return { chatRow, pixelGrid, label, clock };
}

function buildFakeSpeedBar(body) {
  const barMain = makeFakeElement('div');
  barMain.className = 'zu-main';
  const speedIt = makeFakeElement('span');
  speedIt.className = 'it';
  speedIt.setAttribute('tabindex', '0');
  const ico = makeFakeElement('svg');
  ico.className = 'ico';
  const live = makeFakeElement('span');
  live.className = 'zu-live ok';
  live.textContent = '144.1';
  const dimUnit = makeFakeElement('span');
  dimUnit.className = 'dim';
  dimUnit.textContent = 't/s';
  speedIt.appendChild(ico);
  speedIt.appendChild(live);
  speedIt.appendChild(dimUnit);
  barMain.appendChild(speedIt);
  body.appendChild(barMain);
  return { barMain, speedIt, ico, live };
}

test('compressed whale tail SVG dataset stays strictly under 100 KB and decodes 150 frames for all 4 poses', () => {
  const { window } = makeRotatorEnv();
  const api = window.__zusageStatusRotator;
  assert.ok(api, 'window.__zusageStatusRotator exposed');

  const bytes = api.tailDataBytes();
  assert.ok(bytes > 10000 && bytes < 100 * 1024, `expected < 102400 bytes, got ${bytes}`);

  for (const act of ['wag', 'sway', 'twist', 'official']) {
    const poses = api.decodeWhaleTailPoses(act);
    assert.equal(poses.length, 150, `${act} has 150 frames`);
    assert.match(poses[0], /^M-?\d+(?:\.\d+)? -?\d+(?:\.\d+)?(?: L-?\d+(?:\.\d+)? -?\d+(?:\.\d+)?)+ Z$/);
    assert.match(poses[75], /^M-?\d+(?:\.\d+)? -?\d+(?:\.\d+)?(?: L-?\d+(?:\.\d+)? -?\d+(?:\.\d+)?)+ Z$/);
  }

  const wag0 = api.decodeWhaleTailPoses('wag')[0];
  const twist0 = api.decodeWhaleTailPoses('twist')[0];
  const bridge = api.whaleTailBridgeFrames(wag0, twist0);
  assert.equal(bridge.length, 6, 'bridge transition produces 6 frames');
  assert.equal(bridge[0], wag0);
  assert.equal(bridge[5], twist0);
});

test('custom phrase line parser and 17 live placeholders format accurately', () => {
  const { window } = makeRotatorEnv('zh');
  const api = window.__zusageStatusRotator;

  const parsed = api.parsePhraseLine('正在编译 {model} ({tps} t/s) | 3.5 | when:tool=Bash,retry=1,firstTurn | rarity:0.4');
  assert.equal(parsed.text, '正在编译 {model} ({tps} t/s)');
  assert.equal(parsed.weight, 3.5);
  assert.equal(parsed.rarity, 0.4);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.when)), { tool: 'Bash', retry: 1, firstTurn: true });

  const now = new Date(2026, 3, 20, 9, 5, 8);
  const rendered = api.formatPlaceholders(
    '{elapsed}|{phase}|{phaseLabel}|{model}|{provider}|{tps}|{pending}|{tools}|{running}|{retry}/{retryMax}|{retryProvider}:{retryCode}|{detail}|{locale}|{date}|{time}',
    {
      now,
      elapsedMs: 75000,
      phase: 'thinking',
      model: 'DeepSeek-R1',
      provider: 'BigModel',
      tps: 68.42,
      pendingCount: 2,
      toolsCount: 7,
      runningToolVerb: '读取文件',
      retryCount: 1,
      retryMax: 4,
      retryProvider: 'OpenRouter',
      retryCode: '503',
      detail: 'retry-backoff'
    }
  );
  assert.equal(
    rendered,
    '1m 15s|thinking|深度思考|DeepSeek-R1|BigModel|68.4|2|7|读取文件|1/4|OpenRouter:503|retry-backoff|zh|2026-04-20|09:05:08'
  );
});

test('builtin pack pool flows through the id map (regression: packs were indexed as an object and never reached the pool)', () => {
  const { ctx } = makeRotatorEnv('zh');
  const pool = vm.runInContext('getMergedPhrasePool("running", "zh", new Date())', ctx);
  assert.ok(pool.length >= 50, `default packs feed the pool, got ${pool.length}`);
  assert.ok(pool.every(p => p.pack !== 'fallback'), 'builtin phrases present, not just the fallback line');
  const poolLong = vm.runInContext('getMergedPhrasePool("long", "en", new Date())', ctx);
  assert.ok(poolLong.length > 0 && poolLong.every(p => p.pack !== 'fallback'), 'en long pool populated');

  // 保存过词包选择：旧版 `id in 数组` 恒 false 把选择清空，现在必须保留合法 id、丢弃未知 id。
  // 无 knownPackIds 的存量配置以拆分前 14 个 legacy id 作 seen 种子：曾显式关掉的旧包不被
  // 补回，只补拆分后新增的 id（review 修复：旧「升级即全开」会覆盖用户的关包选择），未知 id 仍被剔除
  const env2 = makeRotatorEnv('zh', { enabledPacks: ['deepseek', 'bogus-pack'], mountTarget: 'bar' });
  const upgraded = vm.runInContext('rotatorCfg.enabledPacks.slice().sort().join(",")', env2.ctx);
  const metaJoined = vm.runInContext('ZU_ROTATOR_PACK_META.map(function (m) { return m.id; }).sort().join(",")', env2.ctx);
  assert.equal(upgraded, 'chairman-mao,deepseek,programming-pearls', 'legacy config keeps explicit opt-outs, adds only split-era packs, unknown id dropped');
  assert.notEqual(upgraded, metaJoined, 'disabled legacy packs are not force-re-enabled');
  assert.equal(vm.runInContext('rotatorCfg.mountTarget', env2.ctx), undefined, 'bar mount config is gone');
});

test('new builtin packs are force-enabled for existing configs once, then respect explicit opt-outs (knownPackIds)', () => {
  const env0 = makeRotatorEnv('zh');
  const metaJoined = vm.runInContext('ZU_ROTATOR_PACK_META.map(function (m) { return m.id; }).sort().join(",")', env0.ctx);

  // 旧配置（无 knownPackIds）：以 legacy 14 包为 seen 种子——只补拆分后新增 id，
  // 曾显式关掉的旧包不被补回（review 修复：原「升级即全开」覆盖用户关包选择）
  const legacy = makeRotatorEnv('zh', { enabledPacks: ['deepseek'] });
  const upgradedLegacy = vm.runInContext('rotatorCfg.enabledPacks.slice().sort().join(",")', legacy.ctx);
  assert.equal(upgradedLegacy, 'chairman-mao,deepseek,programming-pearls', 'legacy config adds only split-era packs');
  assert.ok(vm.runInContext('rotatorCfg.enabledPacks.indexOf("programming-pearls")', legacy.ctx) >= 0, 'new pack enabled');
  assert.ok(vm.runInContext('rotatorCfg.enabledPacks.indexOf("coding")', legacy.ctx) < 0, 'explicitly disabled legacy pack stays disabled');
  assert.equal(vm.runInContext('rotatorCfg.knownPackIds.slice().sort().join(",")', legacy.ctx), metaJoined, 'seen set recorded');
  // 全新安装（无任何配置）：落 META 全集默认
  const fresh = makeRotatorEnv('zh', { enabledPacks: undefined });
  assert.equal(vm.runInContext('rotatorCfg.enabledPacks.slice().sort().join(",")', fresh.ctx), metaJoined, 'fresh install defaults to full META set');

  // 升级后用户显式关掉新包（knownPackIds 已含全部 META）：不再被补回
  const optedOut = makeRotatorEnv('zh', {
    enabledPacks: ['deepseek'],
    knownPackIds: metaJoined.split(','),
  });
  assert.deepEqual(vm.runInContext('rotatorCfg.enabledPacks.slice()', optedOut.ctx), ['deepseek'], 'explicit opt-out survives reload');
});

test('65ms rotator timer drives the typewriter past the first character (regression: stuck at 「长」)', () => {
  const env = makeRotatorEnv('zh');
  const { ctx, window, body, timers, advanceNow } = env;

  const ivs = [...timers.values()].filter(t => t.interval && t.ms === 65);
  assert.equal(ivs.length, 1, 'module-level ensureRotatorTimer schedules exactly one 65ms interval');

  buildChatRow(body);
  vm.runInContext('rotatorCfg.enabled = true;', ctx);   // 2026-11-09 起默认关闭：直改不触发 masterTick，保持首帧开始打字
  api_typeZero(ctx);
  advanceNow(1000);
  ivs[0].fn();
  const label = body.querySelector('.zcode-loading-label');
  const first = label.textContent;
  assert.equal(first.length, 1, `starts typing at character 1, got "${first}"`);

  advanceNow(400);
  ivs[0].fn();
  const later = label.textContent;
  assert.ok(later.length > first.length, `typewriter advances across interval ticks, got "${later}"`);

  window.__zusageRotatorDispose();
  assert.equal(timers.size, 0, 'dispose clears the rotator interval');
});

function api_typeZero(ctx) {
  // typeSpeedMs=0 → 整句立即可见；这里保持 28ms 打字机以便验证逐字推进
  vm.runInContext('rotatorCfg.typeSpeedMs = 28; rotatorRuntime.turnStartedAt = 0;', ctx);
}

test('chat mount replaces the label, hides the host elapsed clock in phrases mode, restores everything on disable', () => {
  const { ctx, window, body } = makeRotatorEnv('zh');
  const api = window.__zusageStatusRotator;
  const { chatRow, pixelGrid, label, clock } = buildChatRow(body, '工作中...');

  api.setConfig({ enabled: true, whaleTail: true, typeSpeedMs: 0 });
  assert.equal(chatRow.getAttribute('data-zusage-rotator-slot'), '1');
  assert.equal(label.getAttribute('data-zu-host-label'), '工作中...');
  assert.notEqual(label.textContent, '工作中...');
  assert.equal(pixelGrid.style.display, 'none', 'pixel grid hidden while whale tail is on');
  assert.equal(clock.style.display, 'none', 'host elapsed clock hidden while phrases embed {elapsed}');

  // host 文案模式：耗时格照常显示
  api.setConfig({ labelSource: 'host' });
  assert.equal(label.textContent, '工作中...');
  assert.equal(clock.style.display, '', 'host mode keeps the native clock visible');

  // 关闭还原
  api.setConfig({ enabled: false });
  assert.equal(label.textContent, '工作中...');
  assert.equal(label.hasAttribute('data-zu-host-label'), false);
  assert.equal(label.hasAttribute('data-zu-last-text'), false, 'write-baseline attribute cleaned on restore');
  assert.equal(pixelGrid.style.display, '', 'pixel grid restored');
  assert.equal(clock.style.display, '', 'clock restored');
  assert.equal(chatRow.querySelector('.zu-whale-tail-wrap'), null, 'whale tail removed');
  assert.equal(chatRow.hasAttribute('data-zusage-rotator-slot'), false);
});

/* 宿主 3.18.0 loading 行新结构：label 类 .animated-gradient-text、spinner 图标位带
 * data-chat-loading-icon 属性（.font-mono 耗时格未变）——轮播挂载/还原双兼容（v330）。 */
function buildChatRow3180(body, labelText = '工作中') {
  const chatRow = makeFakeElement('div');
  chatRow.setAttribute('data-testid', 'chat-loading');
  const pixelGrid = makeFakeElement('span');
  pixelGrid.className = 'flex size-4 shrink-0 items-center justify-center';
  pixelGrid.setAttribute('data-chat-loading-icon', 'true');
  const label = makeFakeElement('span');
  label.className = 'animated-gradient-text animated-gradient-text-foreground text-ui-base font-normal';
  label.textContent = labelText;
  const clock = makeFakeElement('span');
  clock.className = 'font-mono text-ui-caption tabular-nums text-foreground-subtle';
  clock.textContent = '1 分 32 秒';
  chatRow.appendChild(pixelGrid);
  chatRow.appendChild(label);
  chatRow.appendChild(clock);
  body.appendChild(chatRow);
  return { chatRow, pixelGrid, label, clock };
}

test('chat mount works on the 3.18.0 loading row structure (label class renamed, v330)', () => {
  const { ctx, window, body } = makeRotatorEnv('zh');
  const api = window.__zusageStatusRotator;
  const { chatRow, pixelGrid, label, clock } = buildChatRow3180(body, '工作中');

  api.setConfig({ enabled: true, whaleTail: true, typeSpeedMs: 0 });
  assert.equal(chatRow.getAttribute('data-zusage-rotator-slot'), '1', 'row claimed as rotator slot');
  assert.equal(label.getAttribute('data-zu-host-label'), '工作中', 'host label snapshotted on the new node');
  assert.notEqual(label.textContent, '工作中', 'phrase replaces the new label text');
  assert.ok(label.classList.contains('zu-rotator-active-label'), 'active label class applied');
  assert.equal(pixelGrid.style.display, 'none', 'new spinner icon slot hidden while whale tail is on');
  assert.equal(clock.style.display, 'none', 'host elapsed clock hidden in phrases mode');

  api.setConfig({ labelSource: 'host' });
  assert.equal(label.textContent, '工作中', 'host mode restores native text on the new node');
  assert.equal(clock.style.display, '', 'host mode keeps the native clock visible');

  api.setConfig({ enabled: false });
  assert.equal(label.textContent, '工作中');
  assert.equal(label.hasAttribute('data-zu-host-label'), false);
  assert.equal(label.hasAttribute('data-zu-last-text'), false, 'write-baseline attribute cleaned on restore');
  assert.equal(pixelGrid.style.display, '', 'new spinner icon slot restored');
  assert.equal(clock.style.display, '', 'clock restored');
  assert.equal(chatRow.querySelector('.zu-whale-tail-wrap'), null, 'whale tail removed');
  assert.equal(chatRow.hasAttribute('data-zusage-rotator-slot'), false);
});

/* v330：多个 loading 行并存（多分栏并发请求）时「我方最后写入」基准挂 label 自身
 * data-zu-last-text，行间互不干扰。基准若是模块级单例，先处理的行每拍改写它，后处理的行
 * 上一拍写入的打字文本就被误判成「宿主改写」而覆盖 data-zu-host-label 快照——只有显示文本
 * 逐拍变化（打字推进/换词）时才暴露，所以必须驱动多拍，单拍整句显示测不出来。 */
function driveConcurrentRows(env, a, b, hostA, hostB) {
  const { window, timers, advanceNow } = env;
  const api = window.__zusageStatusRotator;
  api.setConfig({ enabled: true, typeSpeedMs: 28, whaleTail: false });
  const ivs = [...timers.values()].filter(t => t.interval && t.ms === 65);
  const tick = ivs[ivs.length - 1].fn;
  const intact = (when) => {
    assert.equal(a.label.getAttribute('data-zu-host-label'), hostA, `first row snapshot intact ${when}`);
    assert.equal(b.label.getAttribute('data-zu-host-label'), hostB, `second row snapshot intact ${when}`);
  };
  const shown = new Set([b.label.textContent]);
  for (let i = 0; i < 8; i++) { advanceNow(150); tick(); shown.add(b.label.textContent); intact(`at typing beat ${i + 1}`); }
  advanceNow(4000); tick(); advanceNow(150); tick();   // 越过轮换间隔：换下一条词组再打一拍
  shown.add(b.label.textContent);
  intact('after phrase rotation');
  assert.ok(shown.size >= 2, `displayed text really changed across beats (distinct: ${shown.size})`);   // 文本变一次就足以暴露共享基准；短词组 + 换词撞同文时只有 2~3 种
  assert.equal(a.label.textContent, b.label.textContent, 'both rows show the same phrase text');

  api.setConfig({ enabled: false });
  assert.equal(a.label.textContent, hostA, 'first row restored to its own host text');
  assert.equal(b.label.textContent, hostB, 'second row restored to its own host text');
  for (const row of [a, b]) {
    assert.equal(row.label.hasAttribute('data-zu-host-label'), false);
    assert.equal(row.label.hasAttribute('data-zu-last-text'), false, 'write-baseline attribute cleaned on restore');
  }
}

test('two concurrent loading rows keep independent host snapshots across typing beats (legacy + 3.18.0 structure)', () => {
  const env = makeRotatorEnv('zh');
  driveConcurrentRows(env, buildChatRow(env.body, '工作中...'), buildChatRow3180(env.body, 'Thinking'), '工作中...', 'Thinking');
});

test('two concurrent loading rows of the same structure keep independent host snapshots across typing beats', () => {
  const legacy = makeRotatorEnv('zh');
  driveConcurrentRows(legacy, buildChatRow(legacy.body, '工作中...'), buildChatRow(legacy.body, '正在思考...'), '工作中...', '正在思考...');
  const modern = makeRotatorEnv('zh');
  driveConcurrentRows(modern, buildChatRow3180(modern.body, '工作中'), buildChatRow3180(modern.body, 'Working'), '工作中', 'Working');
});

test('legacy selectors win when one row carries both structures (no comma-selector document order)', () => {
  const { window, body } = makeRotatorEnv('zh');
  const api = window.__zusageStatusRotator;
  const chatRow = makeFakeElement('div');
  chatRow.setAttribute('data-testid', 'chat-loading');
  const iconDecoy = makeFakeElement('span');
  iconDecoy.setAttribute('data-chat-loading-icon', 'true');
  const grid = makeFakeElement('span');
  grid.className = 'grid';
  const decoy = makeFakeElement('span');
  decoy.className = 'animated-gradient-text';
  decoy.textContent = 'decoy';
  const legacy = makeFakeElement('span');
  legacy.className = 'zcode-loading-label';
  legacy.textContent = '工作中...';
  chatRow.appendChild(iconDecoy);   // 新结构的节点都排在前面：合并成逗号选择器会先命中它们
  chatRow.appendChild(grid);
  chatRow.appendChild(decoy);
  chatRow.appendChild(legacy);
  body.appendChild(chatRow);

  api.setConfig({ enabled: true, whaleTail: true, typeSpeedMs: 0 });
  assert.equal(legacy.getAttribute('data-zu-host-label'), '工作中...', 'legacy node is the mounted label');
  assert.notEqual(legacy.textContent, '工作中...');
  assert.equal(decoy.textContent, 'decoy', 'later-structure label untouched');
  assert.equal(decoy.hasAttribute('data-zu-host-label'), false);
  assert.equal(grid.style.display, 'none', 'legacy icon slot is the one hidden');
  assert.equal(iconDecoy.style.display, '', 'later-structure icon slot untouched');
  api.setConfig({ enabled: false });
  assert.equal(legacy.textContent, '工作中...');
  assert.equal(grid.style.display, '');
});

test('label not found: the host elapsed clock stays visible instead of losing both phrase and timer', () => {
  const { window, body } = makeRotatorEnv('zh');
  const api = window.__zusageStatusRotator;
  const chatRow = makeFakeElement('div');
  chatRow.setAttribute('data-testid', 'chat-loading');
  const unknownLabel = makeFakeElement('span');
  unknownLabel.className = 'some-future-label-class';
  unknownLabel.textContent = '工作中';
  const clock = makeFakeElement('span');
  clock.className = 'font-mono tabular-nums';
  clock.textContent = '12.3s';
  chatRow.appendChild(unknownLabel);
  chatRow.appendChild(clock);
  body.appendChild(chatRow);

  api.setConfig({ enabled: true, typeSpeedMs: 0 });
  assert.equal(chatRow.getAttribute('data-zusage-rotator-slot'), '1', 'row still claimed');
  assert.equal(unknownLabel.textContent, '工作中', 'unrecognised label left alone');
  assert.equal(clock.style.display, '', 'native clock kept when the phrase cannot be shown');
  api.setConfig({ enabled: false });
  assert.equal(clock.style.display, '');
});

test('speed cell is fully native — no rotator pill, no whale svg, no flow theme (user revert 2026-11-06)', () => {
  const { ctx, window, body } = makeRotatorEnv('zh');
  const api = window.__zusageStatusRotator;
  buildChatRow(body);   // 激活轮播
  const { barMain, speedIt, ico } = buildFakeSpeedBar(body);

  api.setConfig({ enabled: true, whaleTail: true, typeSpeedMs: 0 });
  assert.equal(barMain.querySelector('.zu-rotator-bar'), null, 'rotator pill never injected into the bar');
  assert.equal(barMain.querySelector('.zu-whale-tail-wrap'), null, 'whale svg never injected into the bar');
  assert.equal(ico.style.display, '', 'native lightning icon untouched');
  // 用户改定（2026-11-06 晚）：速度格不跟随轮播设置——无 zu-flow-num 类、无流光 CSS、档位色保持
  assert.equal(speedIt.classList.contains('zu-flow-num'), false, 'speed .it never carries the flow class');
  assert.ok(!rotatorSlice.includes('syncBarAppearance'), 'bar appearance sync removed');
  assert.ok(!rotatorSlice.includes('.zu-main .it.zu-flow-num .zu-live{'), 'flow CSS on speed cell removed');
  const css = vm.runInContext('rotatorStyleEl.textContent', ctx);
  assert.ok(!css.includes('zu-flow-num') && !css.includes('zuRotIcoFlow'), 'no speed-cell flow CSS in the rotator stylesheet');
  assert.ok(css.includes('.zu-main .it.zu-flow-num .zu-live{') === false, 'flow-num gradient rules gone');
  assert.ok(css.includes(".zu-settings-section[data-sec='rotator'] .zu-rot-prev-fix{position:sticky;bottom:0"), 'preview bar pinned to the bottom of the settings scroll area');

  api.setConfig({ enabled: false });
  assert.equal(speedIt.classList.contains('zu-flow-num'), false, 'still no flow class when rotator disabled');

  // 旧版本遗留注入节点的清理路径仍然可用
  const legacy = makeFakeElement('span');
  legacy.className = 'zu-rotator-bar';
  speedIt.appendChild(legacy);
  speedIt.classList.add('zu-it-rotator', 'zu-flow-num');
  vm.runInContext('restoreBarSpeedCell(document.querySelector(".zu-main"))', ctx);
  assert.equal(speedIt.querySelector('.zu-rotator-bar'), null, 'legacy bar pill cleaned');
  assert.equal(speedIt.classList.contains('zu-it-rotator'), false, 'legacy .it class cleaned');
  assert.equal(speedIt.classList.contains('zu-flow-num'), false, 'flow class cleaned');
});

test('whale tail advances by elapsed frames, not one step per call', () => {
  const { ctx, window, body, advanceNow } = makeRotatorEnv('zh');
  const api = window.__zusageStatusRotator;
  buildChatRow(body);
  api.setConfig({
    enabled: true, whaleTail: true, typeSpeedMs: 0,
    whaleTailMotion: { enabled: true, action: 'twist', speedMode: 'fixed', fixedSpeedHz: 1 }
  });
  // twist 150 帧 @1Hz → 帧间隔 max(12, round(1000/150))=12ms
  vm.runInContext('currentWhaleTailPath(Date.now(), 0)', ctx);   // 初始化 lastTailStepAt
  assert.equal(vm.runInContext('rotatorRuntime.tailFrameIndex', ctx), 0);
  advanceNow(120);
  vm.runInContext('currentWhaleTailPath(Date.now(), 0)', ctx);
  assert.equal(vm.runInContext('rotatorRuntime.tailFrameIndex', ctx), 10, '120ms elapsed → 10 frames at 12ms interval');
});

test('danmaku engine is fully removed; settings render pack counts and themeable previews instead', () => {
  const { ctx, window } = makeRotatorEnv('zh');
  const api = window.__zusageStatusRotator;

  assert.equal(api.sendDanmaku, undefined, 'sendDanmaku removed from the public api');
  assert.ok(!rotatorSlice.includes('sendRotatorDanmaku'), 'no danmaku engine in the rotator slice');
  assert.ok(!rotatorSlice.includes('zu-dm-item'), 'no danmaku DOM/CSS in the rotator slice');

  assert.ok(source.includes('zuRotatorSectionHtml(secOpen("rotator") === "")'), 'buildPanel wires zuRotatorSectionHtml');
  const html = vm.runInContext('zuRotatorSectionHtml(true)', ctx);
  assert.match(html, /data-sec="rotator"/);
  assert.match(html, /zu-rot-whaletail/);
  assert.match(html, /zu-rot-tail-action/);
  assert.doesNotMatch(html, /zu-rot-dm/, 'no danmaku controls');
  assert.doesNotMatch(html, /zu-rot-title-enable/, 'no window-title rotation switch (removed)');
  assert.ok(!rotatorSlice.includes('syncRotatorWindowTitle'), 'window-title engine fully removed');
  assert.doesNotMatch(html, /zu-rot-mount/, 'no mount selector (bar mount removed)');
  assert.doesNotMatch(html, /zu-rot-bar-always/, 'no bar-always switch');
  assert.match(html, /zu-rot-pack-preview/, 'preview container rendered (kept hidden)');
  assert.match(html, /<small>[1-9]/, 'pack phrase counts are real numbers now (were all 0)');
  assert.doesNotMatch(html, /zu-rot-pack-prev"/, 'per-pack preview buttons removed (container name is a prefix, quote-bound the match)');
  assert.doesNotMatch(html, /zu-rot-prev-info/, 'preview info line removed');
  assert.doesNotMatch(html, /zu-rot-prev-next/, 'next-phrase button removed (auto-rotation only)');
});

test('pack view dialog: view buttons precede checkboxes, dialog lists deduped phrases at 500px/80vh, closes on demand', () => {
  const { ctx, window, document } = makeRotatorEnv('zh');
  const html = vm.runInContext('zuRotatorSectionHtml(true)', ctx);
  // 每包一个查看按钮，且位于其 checkbox 之前（「开启按钮前面」）
  assert.equal(html.split('zu-rot-pack-view').length - 1, 16, 'one view button per pack');
  const firstItem = html.slice(html.indexOf('zu-rot-pack-item'));
  assert.ok(firstItem.indexOf('zu-rot-pack-cb') < firstItem.indexOf('zu-rot-pack-view'), 'view button follows the pack title (right side)');
  // 毛选包在首位（PACK_META 首项）
  assert.ok(html.indexOf('data-pack="chairman-mao"') >= 0 && html.indexOf('data-pack="chairman-mao"') < html.indexOf('data-pack="deepseek"'), 'chairman-mao listed first');

  // 打开毛选包：429 条去重平铺（三相同池去重后 429）
  vm.runInContext('openRotPackDlg("chairman-mao")', ctx);
  assert.ok(document.body.querySelector('.zu-rot-pk-dlg'), 'dialog appended to body');
  assert.equal(vm.runInContext('rotPkDlg.querySelectorAll(".zu-rot-pk-item").length', ctx), 429, 'deduped phrase list');
  assert.ok(vm.runInContext('rotPkDlg.querySelector(".zu-rot-pk-txt").textContent', ctx).includes('没有调查'), 'first phrase rendered');
  assert.equal(vm.runInContext('rotPkDlg.querySelector(".zu-rot-pk-no").textContent', ctx), '1.', 'serial number starts at 1');
  const maoNos = vm.runInContext('rotPkDlg.querySelectorAll(".zu-rot-pk-no")', ctx);
  assert.equal(maoNos[maoNos.length - 1].textContent, String(maoNos.length) + '.', 'last serial equals item count');
  assert.ok(vm.runInContext('rotPkDlg.querySelector(".zu-rot-pk-card").className', ctx).includes('zu-rot-pk-card'), 'card node present');

  // 再开其他包先关旧的（单例），珠玑包 24 条
  vm.runInContext('openRotPackDlg("programming-pearls")', ctx);
  assert.equal(vm.runInContext('rotPkDlg.querySelectorAll(".zu-rot-pk-item").length', ctx), 24, 'singleton: old dialog replaced');

  // Escape keydown 关闭（捕获监听）
  const escapeHandler = vm.runInContext('rotPkKey', ctx);
  assert.equal(typeof escapeHandler, 'function', 'capture keydown handler installed');
  vm.runInContext('rotPkKey({ key: "Escape", preventDefault() {}, stopPropagation() {} })', ctx);
  assert.equal(vm.runInContext('rotPkDlg', ctx), null, 'Escape closes the dialog');

  // dispose 清理
  vm.runInContext('openRotPackDlg("coding")', ctx);
  vm.runInContext('zuRotatorDisposeAll()', ctx);
  assert.equal(vm.runInContext('rotPkDlg', ctx), null, 'dispose removes the dialog');

  // 尺寸规格在样式表：500px 宽 + 80vh 高
  const css = vm.runInContext('rotatorStyleEl.textContent', ctx);
  assert.ok(/\.zu-rot-pk-card\{[^}]*width:600px/.test(css), 'fixed 600px width');
  assert.ok(/\.zu-rot-pk-card\{[^}]*height:80vh/.test(css), '80vh height');
});

test('live preview card: last card of the section, follows every setting, self-cleans its timer', () => {
  const env = makeRotatorEnv('zh');
  const { ctx, window, timers, advanceNow } = env;
  const api = window.__zusageStatusRotator;

  const html = vm.runInContext('zuRotatorSectionHtml(true)', ctx);
  assert.ok(html.indexOf('zu-rot-prev-stage') > html.indexOf('zu-rot-custom-long'), 'preview card is the last card of the rotator section');
  assert.ok(html.indexOf('zu-rot-prev-fix') < html.indexOf('zu-rot-prev-stage'), 'sticky wrapper encloses the preview card');
  assert.ok(html.indexOf('zu-rot-pack-grid') < html.indexOf('zu-rot-prev-stage'), 'pack card precedes the bottom preview card');
  assert.equal(html.split('zu-rot-pack-preview').length - 1, 1, 'exactly one preview container, hosted by the bottom card');
  assert.ok(!html.includes('<100KB'), 'whale card title no longer carries the size suffix');
  // 用户 keep-list：钉底卡只保留 stage（鲸鱼+短语）与隐藏定点容器，无按钮/信息行/标题
  const fixIdx = html.indexOf('zu-rot-prev-fix');
  assert.ok(fixIdx >= 0 && html.slice(fixIdx, html.indexOf('</section>')).indexOf('zu-rot-prev-next') < 0, 'no button inside the pinned preview card');

  // 构造带 stage/info 的假面板并接线（面板打开路径）
  const panel = makeFakeElement('div');
  const stage = makeFakeElement('div'); stage.className = 'zu-rot-prev-stage';
  const strip = makeFakeElement('div'); strip.className = 'zu-rot-pack-preview'; strip.hidden = true;
  panel.appendChild(stage); panel.appendChild(strip);
  panel.classList.add('open');   // 真实面板打开态：closeSettings 只摘 .open，节点常挂 body
  env.state.settingsSec = 'rotator';   // 分区可见性事实源（activateSettingsSec 单一出口维护）
  window.__pvPanel = panel;
  vm.runInContext('zuRotatorSyncPanel(window.__pvPanel)', ctx);

  const iv65 = [...timers.values()].filter(t => t.interval && t.ms === 65);
  assert.equal(iv65.length, 2, 'preview timer joins the module rotator timer while the panel is open');

  advanceNow(1000);
  iv65[iv65.length - 1].fn();   // 预览 tick：立即取第一条短语（来自开启的词包池）
  const label = stage.querySelector('.zu-rotator-active-label');
  assert.ok(label && label.textContent.length >= 1 && label.textContent !== '…', `preview label shows an enabled-pack phrase, got "${label && label.textContent}"`);
  assert.ok(stage.querySelector('.zu-whale-tail path'), 'whale shown in preview while whaleTail is on');

  // 联动：关闭鲸鱼（走真实变更尾部）→ 预览重建为无鲸鱼
  api.setConfig({ whaleTail: false });
  assert.equal(stage.querySelector('.zu-whale-tail'), null, 'preview rebuilds without whale after the change tail');
  api.setConfig({ whaleTail: true });

  // 词包勾选变化联动：全部停用 → 词池只剩兜底句（仍出词，不空白）
  vm.runInContext('rotatorCfg.enabledPacks = []; rotPreview.raw = ""; rotPreview.pickAt = 0;', ctx);
  advanceNow(200);
  iv65[iv65.length - 1].fn();
  assert.ok(stage.querySelector('.zu-rotator-active-label').textContent.length >= 1, 'fallback phrase still shows when every pack is unchecked');
  assert.ok(strip.hidden, 'pack sample strip stays hidden (no pin buttons anymore)');

  // 真实关闭模型：closeSettings 只摘 .open（节点常挂）→ tick 每拍跳过、label 冻结，定时器由 closeSettings/切分区清除
  panel.classList.remove('open');
  advanceNow(200);
  const frozenLabel = stage.querySelector('.zu-rotator-active-label').textContent;
  iv65[iv65.length - 1].fn();
  advanceNow(200);
  iv65[iv65.length - 1].fn();
  assert.equal(stage.querySelector('.zu-rotator-active-label').textContent, frozenLabel, 'closed panel (no .open) freezes the preview');

  // getClientRects 空列表=display:none → 跳过；非空/方法缺失 → 推进（offsetParent 不可用于 fixed 面板后代）
  panel.classList.add('open');
  panel.getClientRects = () => [];
  advanceNow(200);
  iv65[iv65.length - 1].fn();
  assert.equal(stage.querySelector('.zu-rotator-active-label').textContent, frozenLabel, 'empty getClientRects hides the preview');
  panel.getClientRects = () => [{}];
  advanceNow(400);
  iv65[iv65.length - 1].fn();
  assert.notEqual(stage.querySelector('.zu-rotator-active-label').textContent, frozenLabel, 'non-empty getClientRects resumes the preview');
  delete panel.getClientRects;

  // 面板脱离 DOM → 预览定时器下一拍自清
  panel.remove();
  advanceNow(100);
  iv65[iv65.length - 1].fn();
  assert.equal([...timers.values()].filter(t => t.interval && t.ms === 65).length, 1, 'preview timer self-clears when the panel detaches');

  window.__zusageRotatorDispose();
  assert.equal(timers.size, 0, 'dispose clears every rotator timer');
});

test('appearance theme 「无」 disables gradient and whale rainbow; colorful themes restore rainbow', () => {
  const { ctx, window } = makeRotatorEnv('zh');
  const api = window.__zusageStatusRotator;

  const html = vm.runInContext('zuRotatorSectionHtml(true)', ctx);
  assert.match(html, /<option value="none">无<\/option>/, 'none theme is the first dropdown option');

  vm.runInContext('applyAppearanceThemePreset("none"); updateRotatorStylesheet()', ctx);   // 真实链路：变更尾部重生成样式表
  const cfgNone = JSON.parse(JSON.stringify(vm.runInContext('rotatorCfg', ctx)));
  assert.equal(cfgNone.appearance.theme, 'none');
  assert.equal(cfgNone.appearance.gradient.enabled, false, 'flowing gradient off');
  assert.equal(cfgNone.whaleTailRainbow, false, 'whale tail rainbow fill off');
  assert.equal(cfgNone.appearance.glow, false, 'no glow');
  assert.equal(cfgNone.appearance.animation, 'none', 'no animation');

  // 样式表：渐变关 → 标签规则不带 background-image 渐变与 zuRotFlow 动画
  const cssNone = vm.runInContext('rotatorStyleEl.textContent', ctx);
  assert.ok(!cssNone.includes('animation:zuRotFlow'), 'no flow animation applied when gradient disabled (static keyframes definition is unconditional)');
  assert.ok(cssNone.includes('.zu-whale-tail path{fill:currentColor!important}'), 'whale tail falls back to currentColor');

  // 彩色主题反向恢复炫彩
  vm.runInContext('applyAppearanceThemePreset("neon"); updateRotatorStylesheet()', ctx);
  const cfgNeon = JSON.parse(JSON.stringify(vm.runInContext('rotatorCfg', ctx)));
  assert.equal(cfgNeon.appearance.gradient.enabled, true, 'colorful theme re-enables gradient');
  assert.equal(cfgNeon.whaleTailRainbow, true, 'colorful theme restores rainbow fill');
  assert.ok(vm.runInContext('rotatorStyleEl.textContent', ctx).includes('zuRotFlow'), 'flow rule back for colorful theme');
});

test('rotator defaults follow the 2026-11-06 user spec (2026-11-09: master switch defaults off); v2 storage key ignores the legacy one', () => {
  const { ctx, storage } = makeRotatorEnv('zh');
  const cfg = JSON.parse(JSON.stringify(vm.runInContext('rotatorCfg', ctx)));
  assert.equal(cfg.enabled, false, 'rotator master switch defaults off for fresh users (2026-11-09 用户规格)');
  assert.equal(cfg.labelSource, 'phrases', 'phrase packs as source');
  assert.equal(cfg.whaleTail, true, 'whale tail icon on');
  assert.equal(cfg.whaleTailRainbow, false, 'rainbow fill off (「无」theme semantics)');
  assert.equal(cfg.whaleTailMotion.action, 'random', 'random tail motion');
  assert.equal(cfg.whaleTailMotion.speedMode, 'tps', 'tps-scaled tail speed');
  assert.equal(cfg.whaleTailMotion.toolSwitchEnabled, true, 'tool switch on');
  assert.equal(cfg.appearance.theme, 'none', 'none theme by default (2026-11-06 晚二次改定)');
  assert.equal(cfg.appearance.animation, 'none', 'no animation by default');
  assert.equal(cfg.appearance.glow, false, 'no glow by default');
  assert.equal(cfg.appearance.gradient.enabled, false, 'no flowing gradient by default');
  assert.equal(cfg.enabledPacks.length, 16, 'all 16 packs enabled by default');
  assert.equal(cfg.enabledPacks.slice().sort().join(','), vm.runInContext('ZU_ROTATOR_PACK_META.map(function (m) { return m.id; })', ctx).sort().join(','), 'every pack id enabled');
  assert.equal('zusage3.rotator' in storage, false, 'legacy v1 key untouched on fresh load');

  // 旧键内容不再被读取（求值前预置才有真实读路径）；新键保存值照常生效
  const legacy = makeRotatorEnv('zh', null, { appearance: { theme: 'glitch' } });
  assert.equal(vm.runInContext('rotatorCfg.appearance.theme', legacy.ctx), 'none', 'legacy v1 key is ignored');
  const saved = makeRotatorEnv('zh', { appearance: { theme: 'none' } });
  assert.equal(vm.runInContext('rotatorCfg.appearance.theme', saved.ctx), 'none', 'v2 saved config honored');

  // 已显式开启/关闭的存量配置不被默认值翻转（布尔覆盖原样保留）
  const optedIn = makeRotatorEnv('zh', { enabled: true });
  assert.equal(vm.runInContext('rotatorCfg.enabled', optedIn.ctx), true, 'persisted explicit opt-in survives the new default');
  const optedOut = makeRotatorEnv('zh', { enabled: false });
  assert.equal(vm.runInContext('rotatorCfg.enabled', optedOut.ctx), false, 'persisted explicit opt-out survives');
});

test('「换一条」 button is fully removed from the rotator settings (user spec)', () => {
  const { ctx, window } = makeRotatorEnv('zh');
  const html = vm.runInContext('zuRotatorSectionHtml(true)', ctx);
  assert.doesNotMatch(html, /zu-rot-next-btn/, 'no next-phrase button in card 1');
  assert.ok(!rotatorSlice.includes('zu-rot-next-btn'), 'no button handler branch in the slice');
  assert.ok(rotatorSlice.includes('forceNextRotatorPhrase'), 'phrase picking internals stay (phase change/interval still rotate)');
});

test('preview keeps the whale animating in host-label mode and the fixed Hz input is wired', () => {
  const env = makeRotatorEnv('zh');
  const { ctx, window, timers, advanceNow } = env;
  const api = window.__zusageStatusRotator;

  const html = vm.runInContext('zuRotatorSectionHtml(true)', ctx);
  assert.ok(html.includes('zu-rot-fixedhz'), 'fixed Hz input rendered');
  assert.ok(!html.includes('另套流光主题') && !html.includes('wears the same flowing theme'), 'enable row copy no longer claims speed-cell theming');

  const panel = makeFakeElement('div');
  const stage = makeFakeElement('div'); stage.className = 'zu-rot-prev-stage';
  panel.appendChild(stage);
  panel.classList.add('open');
  env.state.settingsSec = 'rotator';
  window.__pvPanel = panel;
  vm.runInContext('zuRotatorSyncPanel(window.__pvPanel)', ctx);

  // host 文案模式：鲸鱼照常摆动（回归 MAJOR-1）
  api.setConfig({ labelSource: 'host', typeSpeedMs: 0, whaleTailMotion: { enabled: true, action: 'twist', speedMode: 'fixed', fixedSpeedHz: 1 } });
  const pathEl = stage.querySelector('.zu-whale-tail path');
  const d1 = pathEl.getAttribute('d');
  advanceNow(200);
  vm.runInContext('rotPreviewTick()', ctx);   // 首拍初始化 lastFrameAt（steps=0，不推进）
  advanceNow(200);
  vm.runInContext('rotPreviewTick()', ctx);   // 第二拍按 elapsed 补帧
  const d2 = pathEl.getAttribute('d');
  assert.notEqual(d2, d1, 'whale tail keeps advancing while labelSource=host');
  assert.equal(stage.querySelector('.zu-rotator-active-label').textContent, '工作中...', 'host label shown');

  // fixedHz 数字输入 → change 委托写入配置
  const input = makeFakeElement('input');
  input.className = 'zu-rot-num zu-rot-fixedhz';
  input.value = '2';
  window.__hzInput = input;   // 跨 realm：元素经 window 引用传入 VM
  vm.runInContext('zuRotatorPanelChange({ target: window.__hzInput }, window.__pvPanel)', ctx);
  const cfg = api.getConfig();
  assert.equal(cfg.whaleTailMotion.fixedSpeedHz, 2, 'fixed Hz change handler writes the config');
  assert.equal(cfg.whaleTailMotion.speedMode, 'fixed', 'speed mode unchanged by Hz input');

  // theme 白名单：手改 LS 脏值回落默认
  const dirty = makeRotatorEnv('zh', { appearance: { theme: 'bogus-theme' } });
  assert.equal(vm.runInContext('rotatorCfg.appearance.theme', dirty.ctx), 'none', 'invalid saved theme falls back to default');
});

test('host label snapshot survives multi-beat typing (regression: snapshot degraded every typing beat)', () => {
  const env = makeRotatorEnv('zh');
  const { ctx, window, body, timers, advanceNow } = env;
  const api = window.__zusageStatusRotator;
  const { label } = buildChatRow(body, '正在思考...');

  api.setConfig({ enabled: true, typeSpeedMs: 28, whaleTail: false });
  const ivs = [...timers.values()].filter(t => t.interval && t.ms === 65);
  const tick = ivs[ivs.length - 1].fn;

  // 多拍打字：快照必须始终是宿主原文案，不得退化为部分打字文本
  for (let i = 0; i < 6; i++) { advanceNow(150); tick(); }
  assert.equal(label.getAttribute('data-zu-host-label'), '正在思考...', `snapshot intact across typing beats, got "${label.getAttribute('data-zu-host-label')}"`);
  assert.ok(label.textContent.length > 1, 'typing is actually progressing');

  // 关闭轮播 → 还原宿主原文案（非残句）
  api.setConfig({ enabled: false });
  assert.equal(label.textContent, '正在思考...', 'restore writes the original host text, not a degraded snapshot');
});

test('panel claim follows real open order: closed syncPanel does not claim, .open before syncPanel does', () => {
  const env = makeRotatorEnv('zh');
  const { ctx, window, body, timers, advanceNow } = env;
  const api = window.__zusageStatusRotator;
  buildChatRow(body);

  // 关闭态 syncPanel（buildPanel 预构建路径）：不得认领
  const panel = makeFakeElement('div');
  const stage = makeFakeElement('div'); stage.className = 'zu-rot-prev-stage';
  panel.appendChild(stage);
  env.state.settingsSec = 'rotator';
  window.__pvPanel2 = panel;
  vm.runInContext('zuRotatorSyncPanel(window.__pvPanel2)', ctx);
  assert.equal(vm.runInContext('rotPreview.panelEl === window.__pvPanel2', ctx), false, 'closed panel is not claimed');

  // 真实打开顺序：先 .open 后 syncPanel → 认领并出词
  panel.classList.add('open');
  vm.runInContext('zuRotatorSyncPanel(window.__pvPanel2)', ctx);
  assert.equal(vm.runInContext('rotPreview.panelEl === window.__pvPanel2', ctx), true, 'open panel is claimed');
  const ivs = [...timers.values()].filter(t => t.interval && t.ms === 65);
  advanceNow(500);
  ivs[ivs.length - 1].fn();
  const lbl = stage.querySelector('.zu-rotator-active-label');
  assert.ok(lbl && lbl.textContent !== '…', `first-open preview picks a phrase, got "${lbl && lbl.textContent}"`);

  window.__zusageRotatorDispose();
});

/* ---------- v286+ 自定义短语可视化编辑器 ---------- */

function buildCpRow(ph, i, vals = {}) {
  const row = makeFakeElement('div');
  row.className = 'zu-rot-cp-row';
  row.setAttribute('data-cp-ph', ph);
  row.setAttribute('data-cp-i', String(i));
  const mk = (cls, value) => {
    const c = makeFakeElement('input');
    c.className = cls;
    if (value !== undefined) c.value = value;
    return c;
  };
  const text = mk('zu-rot-cp-text', vals.text || '');
  const weight = mk('zu-rot-cp-weight', vals.weight != null ? vals.weight : '1');
  const rarity = mk('zu-rot-cp-rarity', vals.rarity != null ? vals.rarity : '100');
  const toolcb = mk('zu-rot-cp-cb zu-rot-cp-toolcb'); toolcb.checked = !!vals.tool;
  const toolname = mk('zu-rot-cp-toolname', vals.toolName || '');
  const firstcb = mk('zu-rot-cp-cb zu-rot-cp-firstcb'); firstcb.checked = !!vals.first;
  const retrycb = mk('zu-rot-cp-cb zu-rot-cp-retrycb'); retrycb.checked = !!vals.retry;
  if (vals.retryNum) retrycb.setAttribute('data-num', vals.retryNum);
  [text, weight, rarity, toolcb, toolname, firstcb, retrycb].forEach(c => row.appendChild(c));
  return { row, text, weight, rarity, toolcb, toolname, firstcb, retrycb };
}

test('visual custom-phrase card renders rows, add buttons, chips, and the hidden full placeholder table by default', () => {
  const env = makeRotatorEnv('zh');
  const { ctx } = env;
  vm.runInContext('rotatorCfg.customPhrases.zh.running.push({ text: "冲鸭 {tps}", weight: 2.5, rarity: 0.5, when: { tool: "Bash" } })', ctx);

  const html = vm.runInContext('zuRotatorSectionHtml(true)', ctx);
  assert.ok(html.indexOf('zu-rot-cp-card') > 0, 'visual card container present');
  assert.ok(html.indexOf('zu-rot-cp-mode') > 0, 'mode toggle button present');
  assert.ok(html.indexOf('文本编辑（高级）') > 0, 'mode button offers text mode');
  assert.ok(html.indexOf('data-cp-add="thinking"') > 0 && html.indexOf('data-cp-add="running"') > 0 && html.indexOf('data-cp-add="long"') > 0, 'per-phase add buttons');
  assert.ok(html.indexOf('zu-rot-cp-text') > 0 && html.indexOf('冲鸭 {tps}') > 0, 'saved phrase rendered as a row');
  assert.ok(html.indexOf('value="2.5"') > 0, 'weight control mirrors stored weight');
  assert.ok(html.indexOf('value="50"') > 0, 'rarity shown as percent');
  assert.ok(html.indexOf('zu-rot-cp-toolcb" checked') > 0 && html.indexOf('value="Bash"') > 0, 'when.tool mirrored');
  assert.ok(html.indexOf('data-cp-chip="{elapsed}"') > 0 && html.indexOf('data-cp-chip="{tps}"') > 0, 'common placeholder chips present');
  assert.ok(html.indexOf('zu-rot-cp-phall') > 0, 'full placeholder table present');
  for (const k of ['retryMax', 'retryProvider', 'retryCode', 'phaseLabel', 'locale', 'detail']) {
    assert.ok(html.indexOf('{' + k + '}') > 0, `placeholder table lists {${k}}`);
  }
  assert.ok(html.indexOf('zu-rot-textarea') < 0, 'no textarea in default visual mode');

  // 文本模式切回 textarea，双视图同源
  assert.equal(vm.runInContext('rotCpTextMode = true; zuRotatorSectionHtml(true)', ctx).indexOf('zu-rot-custom-running') > 0, true, 'text mode renders textareas');
  const textHtml = vm.runInContext('zuRotatorSectionHtml(true)', ctx);
  assert.ok(textHtml.indexOf('返回可视化编辑') > 0, 'mode button flips in text mode');
  assert.ok(textHtml.indexOf('文案 | 权重 | when:tool=Bash | rarity:0.5') > 0, 'line syntax hint moves into text mode');
  assert.ok(textHtml.indexOf('zu-rot-cp-text') < 0, 'no visual rows in text mode');
  vm.runInContext('rotCpTextMode = false', ctx);

  // 预览卡仍是 rotator 分区最后一张卡（既有契约）
  assert.ok(html.indexOf('zu-rot-prev-stage') > html.indexOf('zu-rot-cp-card'), 'preview card stays last');
});

test('rotCpBuildItem maps visual controls to stored objects and round-trips through the line syntax', () => {
  const env = makeRotatorEnv('zh');
  const { ctx } = env;

  const full = vm.runInContext(`rotCpBuildItem({}, {
    text: '  编译中 {model}  ', weight: '2.5', rarity: '50',
    tool: true, toolName: ' Bash ', first: true, retry: true, retryNum: ''
  })`, ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(full)), {
    text: '编译中 {model}', weight: 2.5, rarity: 0.5,
    when: { tool: 'Bash', retry: true, firstTurn: true }
  });

  // 默认值不写字段；数字 retry 保留；透传键保留
  const minimal = vm.runInContext(`rotCpBuildItem(
    { text: 'x', when: { pending: 2, hour: '9-18', phase: 'thinking', retry: 2 } },
    { text: 'x', weight: '1', rarity: '100', tool: false, toolName: '', first: false, retry: true, retryNum: '2' }
  )`, ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(minimal)), {
    text: 'x',
    when: { pending: 2, hour: '9-18', phase: 'thinking', retry: 2 }
  }, 'weight 1 / rarity 100 omitted; extra when keys passed through; numeric retry kept');

  // buildItem 产物经行语法序列化再解析，语义无损（文本模式往返）
  const line = vm.runInContext('formatPhraseLines([{ text: "编译中 {model}", weight: 2.5, rarity: 0.5, when: { tool: "Bash", retry: true, firstTurn: true } }])', ctx);
  assert.equal(line, '编译中 {model} | 2.5 | when:tool=Bash,retry=true,firstTurn=true | rarity:0.5');
  const back = vm.runInContext(`parsePhraseLine(${JSON.stringify(line)})`, ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(back)), JSON.parse(JSON.stringify(full)));
});

test('rotCpSaveRow reads a visual row back into customPhrases', () => {
  const env = makeRotatorEnv('zh');
  const { ctx } = env;
  vm.runInContext('rotatorCfg.customPhrases.zh.thinking.push({ text: "旧文案", weight: 1 })', ctx);
  const r = buildCpRow('thinking', 0, { text: '新文案 {elapsed}', weight: '3', rarity: '25', tool: true, toolName: 'Read' });
  env.window.__cpRow = r.row;
  const out = vm.runInContext('rotCpSaveRow(window.__cpRow)', ctx);
  assert.ok(out && out.ph === 'thinking' && out.i === 0, 'save reports which row it wrote');
  const item = vm.runInContext('rotatorCfg.customPhrases.zh.thinking[0]', ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(item)), {
    text: '新文案 {elapsed}', weight: 3, rarity: 0.25, when: { tool: 'Read' }
  });
  // 保存写回了存储（rotCpSaveRow 内部直接改 cfg；saveRotatorConfig 由调用方 change 链执行）
});

test('panel click delegates: add appends an empty row, delete splices and clears the preview anchor', () => {
  const env = makeRotatorEnv('zh');
  const { ctx, window } = env;
  vm.runInContext('rotatorCfg.customPhrases.zh.running.push({ text: "要被删的", weight: 1 })', ctx);

  const panel = makeFakeElement('div');
  const card = makeFakeElement('div'); card.className = 'zu-rot-cp-card';
  const list = makeFakeElement('div'); list.className = 'zu-rot-cp-list'; list.setAttribute('data-cp-ph', 'running');
  const addBtn = makeFakeElement('button'); addBtn.className = 'zu-rot-btn zu-rot-cp-add'; addBtn.setAttribute('data-cp-add', 'running');
  card.appendChild(addBtn);
  card.appendChild(list);
  const r0 = buildCpRow('running', 0, { text: '要被删的' });
  list.appendChild(r0.row);
  panel.appendChild(card);
  window.__cpPanel = panel;

  // add：push 空草稿行并局部重建列表
  assert.equal(vm.runInContext('zuRotatorPanelClick({ target: (function(){ var b = null; return b })() }, null)', ctx), false, 'non-matching click falls through');
  const addTarget = addBtn;
  assert.equal(vm.runInContext(`zuRotatorPanelClick({ target: window.__cpPanel.querySelector('.zu-rot-cp-add') }, window.__cpPanel)`, ctx), true);
  void addTarget;
  assert.equal(vm.runInContext('rotatorCfg.customPhrases.zh.running.length', ctx), 2, 'add appends a draft row');
  assert.equal(vm.runInContext('rotatorCfg.customPhrases.zh.running[1].text', ctx), '', 'draft row starts empty');

  // del：splice + 预览锚清理
  vm.runInContext('rotCpPreview = { ph: "running", i: 0, text: "要被删的" }', ctx);
  const delBtn = makeFakeElement('button'); delBtn.className = 'zu-rot-btn zu-rot-cp-del';
  r0.row.appendChild(delBtn);
  assert.equal(vm.runInContext(`zuRotatorPanelClick({ target: (window.__cpRow0 = window.__cpRow0 || null) }, window.__cpPanel)`, ctx) === undefined, false, 'sanity');
  window.__cpDelBtn = delBtn;
  assert.equal(vm.runInContext('zuRotatorPanelClick({ target: window.__cpDelBtn }, window.__cpPanel)', ctx), true);
  assert.equal(vm.runInContext('rotatorCfg.customPhrases.zh.running.length', ctx), 1, 'delete splices the row');
  assert.equal(vm.runInContext('rotCpPreview', ctx), null, 'preview anchor cleared when its row is deleted');
});

test('per-phrase preview: ▶ forces the bottom card to play that phrase and survives the rotation interval', () => {
  const env = makeRotatorEnv('zh', { typeSpeedMs: 0 });
  const { ctx, window, timers, advanceNow } = env;
  vm.runInContext('rotatorCfg.customPhrases.zh.running.push({ text: "冲鸭 {tps} t/s", weight: 1 })', ctx);

  const panel = makeFakeElement('div');
  const stage = makeFakeElement('div'); stage.className = 'zu-rot-prev-stage';
  panel.appendChild(stage);
  const list = makeFakeElement('div'); list.className = 'zu-rot-cp-list'; list.setAttribute('data-cp-ph', 'running');
  const r0 = buildCpRow('running', 0, { text: '冲鸭 {tps} t/s' });
  const playBtn = makeFakeElement('button'); playBtn.className = 'zu-rot-btn zu-rot-cp-play';
  r0.row.appendChild(playBtn);
  list.appendChild(r0.row);
  panel.appendChild(list);
  window.__cpPrevPanel = panel;
  env.state.settingsSec = 'rotator';
  panel.classList.add('open');
  vm.runInContext('zuRotatorSyncPanel(window.__cpPrevPanel)', ctx);

  // ▶：定向预览立刻接管（打字机 typeSpeedMs=0 → 一拍全显，占位符按预览 ctx 替换）
  assert.equal(vm.runInContext('zuRotatorPanelClick({ target: (window.__cpPrevPanel.querySelector(".zu-rot-cp-play")) }, window.__cpPrevPanel)', ctx), true);
  // 跨 realm 对象不能与字面量 deepEqual（原型不同）：逐字段断言
  const anchor = vm.runInContext('rotCpPreview', ctx);
  assert.ok(anchor && anchor.ph === 'running' && anchor.i === 0 && anchor.text === '冲鸭 {tps} t/s', 'preview anchor set');
  advanceNow(200);
  const ivs = [...timers.values()].filter(t => t.interval && t.ms === 65);
  ivs[ivs.length - 1].fn();
  const lbl = stage.querySelector('.zu-rotator-active-label');
  assert.equal(lbl.textContent, '冲鸭 42.5 t/s', `forced preview renders the phrase with live placeholders, got "${lbl.textContent}"`);

  // 驻留：超过轮播间隔也不被随机换条顶掉
  advanceNow(8000);
  ivs[ivs.length - 1].fn();
  assert.equal(stage.querySelector('.zu-rotator-active-label').textContent, '冲鸭 42.5 t/s', 'forced preview persists past the interval');

  // ■：再点同一条恢复随机轮播（按钮符号已翻回 ▶）
  assert.equal(playBtn.textContent, '■', 'playing row shows the stop glyph');
  assert.equal(vm.runInContext('zuRotatorPanelClick({ target: window.__cpPrevPanel.querySelector(".zu-rot-cp-play") }, window.__cpPrevPanel)', ctx), true);
  assert.equal(vm.runInContext('rotCpPreview', ctx), null, 'second click stops the forced preview');
  assert.equal(playBtn.textContent, '▶', 'glyph flips back to play');

  // 失配自清：数据被改后锚失效，不再强制
  vm.runInContext('rotCpPreview = { ph: "running", i: 0, text: "冲鸭 {tps} t/s" }; rotatorCfg.customPhrases.zh.running[0].text = "改掉了"', ctx);
  assert.equal(vm.runInContext('rotCpPreviewValid()', ctx), null, 'anchor invalidated when the phrase text no longer matches');
  window.__zusageRotatorDispose();
});

test('clicking a placeholder chip inserts the token into the last edited text box at the cursor', () => {
  const env = makeRotatorEnv('zh');
  const { ctx, window } = env;
  const panel = makeFakeElement('div');
  const r0 = buildCpRow('thinking', 0, { text: '思考中 ' });
  r0.text.selectionStart = r0.text.value.length;
  r0.text.selectionEnd = r0.text.value.length;
  const chip = makeFakeElement('button'); chip.className = 'zu-rot-cp-chip'; chip.setAttribute('data-cp-chip', '{elapsed}');
  panel.appendChild(r0.row);
  panel.appendChild(chip);
  window.__cpChipPanel = panel;

  // 未 change 过：兜底取面板内第一个文案框
  assert.equal(vm.runInContext('zuRotatorPanelClick({ target: window.__cpChipPanel.querySelector(".zu-rot-cp-chip") }, window.__cpChipPanel)', ctx), true);
  assert.equal(r0.text.value, '思考中 {elapsed}', 'chip token appended to the focused text box');

  // 文本模式切换往返：卡片重渲染后模式按钮与视图同步
  const modeBtn = makeFakeElement('button'); modeBtn.className = 'zu-rot-btn zu-rot-cp-mode';
  const card = makeFakeElement('div'); card.className = 'zu-rot-cp-card';
  panel.appendChild(modeBtn);
  panel.appendChild(card);
  assert.equal(vm.runInContext('zuRotatorPanelClick({ target: window.__cpChipPanel.querySelector(".zu-rot-cp-mode") }, window.__cpChipPanel)', ctx), true);
  assert.equal(vm.runInContext('rotCpTextMode', ctx), true, 'mode toggled to text');
  assert.equal(modeBtn.textContent, '返回可视化编辑', 'mode button label flipped');
  assert.ok(card.innerHTML.indexOf('zu-rot-custom-thinking') >= 0, 'card re-rendered as textareas');
  assert.equal(vm.runInContext('zuRotatorPanelClick({ target: window.__cpChipPanel.querySelector(".zu-rot-cp-mode") }, window.__cpChipPanel)', ctx), true);
  assert.equal(vm.runInContext('rotCpTextMode', ctx), false, 'mode toggled back to visual');
});

test('visual drafts with empty text never reach the rotation pool', () => {
  const env = makeRotatorEnv('zh');
  const { ctx } = env;
  vm.runInContext('rotatorCfg.customPhrases.zh.running.push({ text: "", weight: 1 })', ctx);
  const pool = vm.runInContext('getMergedPhrasePool("running", "zh", new Date())', ctx);
  assert.ok(pool.every(p => p.text !== ''), 'empty draft rows are filtered from the pool');
});

test('quick hover tips: pure CSS hover pseudo-element on data-tip targets (host event interception cannot break CSS hover)', () => {
  const env = makeRotatorEnv('zh');
  const { ctx } = env;
  const html = vm.runInContext('zuRotatorSectionHtml(true)', ctx);
  assert.ok(html.indexOf('data-tip=') > 0, 'data-tip attributes present');
  assert.ok(html.indexOf('zu-rot-tipt') > 0, 'tooltip target marks present');
  assert.equal(html.indexOf(' title='), -1, 'no native title attributes left in the section');

  // 纯 CSS 契约：hover 伪元素以 data-tip 为内容源（零事件监听，宿主 stopPropagation 拦不住 CSS hover）
  const css = vm.runInContext('rotatorStyleEl.textContent', ctx);
  assert.ok(css.indexOf('.zu-rot-tipt{position:relative}') >= 0, 'anchor positioning rule present');
  assert.ok(css.indexOf('.zu-rot-tipt:hover::after{content:attr(data-tip)') >= 0, 'hover pseudo-element rule present');
  assert.ok(css.indexOf('bottom:calc(100% + 6px)') >= 0, 'tooltip pops upward (scroll-container bottom clipping)');
  assert.ok(css.indexOf('pointer-events:none') >= 0, 'pseudo-element never traps the pointer');
  assert.ok(css.indexOf('.zu-rot-cp-row .zu-rot-tipt:hover::after') >= 0 && css.indexOf('.zu-settings .cap .zu-rot-tipt:hover::after') >= 0, 'right-aligned variants for row/cap targets');
  // cap 行贴 .zu-settings-body（overflow:auto）顶缘：气泡必须翻到触发元素下方，向上弹被滚动区裁剪（v315 用户实报）
  assert.ok(css.indexOf('.zu-settings .cap .zu-rot-tipt:hover::after{left:auto;right:0;bottom:auto;top:calc(100% + 6px)}') >= 0, 'cap tips flip below the trigger to dodge scroll-container top clipping');
  assert.equal(css.indexOf('.zu-rot-tip{'), -1, 'JS tooltip float layer removed');
  assert.equal(vm.runInContext('typeof rotTipShow', ctx), 'undefined', 'no JS tooltip chain left');
});

test('header credit button: CSS-only hint and upstream repo link via openExternal bridge', () => {
  const env = makeRotatorEnv('zh');
  const { ctx, window } = env;
  const html = vm.runInContext('zuRotatorSectionHtml(true)', ctx);
  assert.ok(html.indexOf('class="zu-rot-btn zu-rot-credit zu-rot-tipt"') > 0, 'credit button present in the section header');
  assert.ok(html.indexOf('>原作者<') > 0, 'zh label present');
  assert.ok(html.indexOf('https://github.com/01Virex/dsh-status-rotator') === -1, 'URL not inlined into section HTML');

  window.__creditBtn = { closest: sel => (sel === '.zu-rot-credit' ? window.__creditBtn : null) };
  const seen = [];
  window.zcode = { openExternal: u => { seen.push(u); } };
  assert.equal(vm.runInContext('zuRotatorPanelClick({ target: window.__creditBtn }, null)', ctx), true, 'credit click handled');
  assert.deepEqual(seen, ['https://github.com/01Virex/dsh-status-rotator'], 'opens the upstream repo via the openExternal bridge');

  delete window.zcode;
  const opened = [];
  window.open = (u, target, feat) => { opened.push([u, target, feat]); return null; };
  assert.equal(vm.runInContext('zuRotatorPanelClick({ target: window.__creditBtn }, null)', ctx), true, 'credit click handled without bridge');
  assert.deepEqual(opened, [['https://github.com/01Virex/dsh-status-rotator', '_blank', 'noopener']], 'falls back to window.open without the bridge');
});

test('review fix: handwritten explicit-false conditions survive visual-mode save and render unchecked', () => {
  const env = makeRotatorEnv('zh');
  const { ctx } = env;
  // 显式 false（tool=false=仅无工具时 / firstTurn=false / retry=false）：勾选框不勾，保存保留原值
  const kept = vm.runInContext(`rotCpBuildItem(
    { text: 'x', when: { tool: false, firstTurn: false, retry: false, pending: 1 } },
    { text: 'x', weight: '1', rarity: '100', tool: false, toolName: '', first: false, retry: false, retryNum: '' }
  )`, ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(kept.when)), { tool: false, firstTurn: false, retry: false, pending: 1 },
    'unchecked visual boxes must NOT flip/delete explicit false conditions (old build silently dropped them)');
  // 勾选态渲染：false 不渲染为已勾选（旧 !== undefined 判定把 tool=false 画成勾选并翻转语义）
  const row = vm.runInContext(`rotCpRowHtml('thinking', 0)`, ctx);
  void row;
  const ctx2 = env.ctx;
  vm.runInContext(`rotatorCfg.customPhrases.zh.thinking = [{ text: 'x', when: { tool: false, retry: false } }]`, ctx2);
  const html = vm.runInContext(`rotCpRowHtml('thinking', 0)`, ctx2);
  assert.ok(!html.includes('zu-rot-cp-toolcb" checked') && !html.includes('zu-rot-cp-toolcb checked'), 'tool=false renders unchecked');
  assert.ok(!html.includes('zu-rot-cp-retrycb" checked') && !html.includes('zu-rot-cp-retrycb checked'), 'retry=false renders unchecked');
  assert.match(html, /tool=false、retry=false|tool=false/, 'false conditions listed in the advanced-conditions note');
});

test('review fix: phrase when: keys are whitelisted and unknown keys never reach the note HTML unescaped', () => {
  const env = makeRotatorEnv('zh');
  const { ctx } = env;
  // 白名单：未知键直接丢弃（matchesPhraseWhen 消费集之外的键无语义，只会经提示行进 innerHTML）
  const parsed = vm.runInContext(`parsePhraseLine('x | when:<img src=x onerror=alert(1)>=1,hour=9-18')`, ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.when || {})), { hour: '9-18' }, 'unknown when-key dropped by whitelist');
  // 纵深防御：存量畸形键（白名单前已入库）经提示行必须转义，不产生可执行标签
  vm.runInContext(`rotatorCfg.customPhrases.zh.thinking = [{ text: 'x', when: { '<img src=x onerror=alert(1)>': 1 } }]`, ctx);
  const html = vm.runInContext(`rotCpRowHtml('thinking', 0)`, ctx);
  assert.ok(!html.includes('<img src=x'), 'raw tag from stored key never reaches innerHTML');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, 'stored key is entity-escaped in the note');
});

test('rotator 关闭态（默认）：65ms 定时器的帧步降到 1s 一次；开启后恢复 65ms（perf-lag-reduction §7）', () => {
  const env = makeRotatorEnv('zh');
  const { ctx, timers, advanceNow } = env;
  let ticks = 0;
  ctx.rotatorMasterTick = () => { ticks++; };                       // 帧步的唯一下游：计数即可，不执行整文档还原扫描
  const iv = [...timers.values()].find(t => t.interval && t.ms === 65);
  assert.equal(vm.runInContext('rotatorCfg.enabled', ctx), false, '主开关默认关闭');
  advanceNow(5000); iv.fn();
  assert.equal(ticks, 1, '首拍执行');
  for (let i = 0; i < 14; i++) { advanceNow(65); iv.fn(); }          // 约 0.9s 内的 65ms 心跳
  assert.equal(ticks, 1, '关闭态 1s 内心跳全部跳过');
  advanceNow(200); iv.fn();
  assert.equal(ticks, 2, '满 1s 后再执行一次');
  advanceNow(999); iv.fn();
  assert.equal(ticks, 2, '距上次 999ms：仍跳过');
  advanceNow(1); iv.fn();
  assert.equal(ticks, 3, '距上次恰 1000ms：执行');
  vm.runInContext('rotatorCfg.enabled = true;', ctx);
  for (let i = 0; i < 5; i++) { advanceNow(70); iv.fn(); }           // 开启后恢复 65ms 节奏：每个心跳都执行
  assert.equal(ticks, 8);
});

/* ---------- 宿主中途改写同节点文案：重拍分支与还原路径（v330 之后补的设防） ---------- */
test('host rewrites the mounted label: snapshot re-takes; host mode A→B→A ends on A; empty beat is not a rewrite', () => {
  const env = makeRotatorEnv('zh');
  const { window, body, timers, advanceNow } = env;
  const api = window.__zusageStatusRotator;
  const { label } = buildChatRow(body, '工作中...');
  api.setConfig({ enabled: true, typeSpeedMs: 0 });
  const tick = [...timers.values()].filter(t => t.interval && t.ms === 65).pop().fn;

  // phrases 模式：宿主改写文案（≠我方最后写入、≠已存快照）→ 快照重拍为新文案，显示仍写回词组
  advanceNow(100); tick();
  label.textContent = '换个说法';
  advanceNow(100); tick();
  assert.equal(label.getAttribute('data-zu-host-label'), '换个说法', 'snapshot follows the host rewrite');
  assert.notEqual(label.textContent, '换个说法', 'phrases mode keeps showing the phrase');
  api.setConfig({ enabled: false });
  assert.equal(label.textContent, '换个说法', 'disable restores the re-taken host text, not the pre-rewrite one');

  // host 模式 A→B→A：每拍重拍，最终快照与显示都是 A（重拍不更新基准时快照会停在 B）
  api.setConfig({ labelSource: 'host', enabled: true, typeSpeedMs: 0 });
  advanceNow(100); tick();
  label.textContent = 'B 文案';
  advanceNow(100); tick();
  assert.equal(label.getAttribute('data-zu-host-label'), 'B 文案');
  assert.equal(label.textContent, 'B 文案', 'host mode shows the latest host text');
  label.textContent = 'A 文案';
  advanceNow(100); tick();
  assert.equal(label.getAttribute('data-zu-host-label'), 'A 文案', 'snapshot follows back to A');
  assert.equal(label.textContent, 'A 文案');
  api.setConfig({ enabled: false });
  assert.equal(label.textContent, 'A 文案');

  // 文本被清空一拍：空串不是宿主改写，快照不变（清空常见于宿主重渲染的中间态）
  api.setConfig({ labelSource: 'host', enabled: true, typeSpeedMs: 0 });
  advanceNow(100); tick();
  label.textContent = '';
  advanceNow(100); tick();
  assert.equal(label.getAttribute('data-zu-host-label'), 'A 文案', 'empty beat does not re-snapshot');
  assert.equal(label.textContent, 'A 文案', 'host text is written back after the empty beat');
});

test('phrases 模式直接关闭（不经 host 模式中转）：耗时格恢复可见、激活类摘除', () => {
  const { window, body } = makeRotatorEnv('zh');
  const api = window.__zusageStatusRotator;
  const { label, clock } = buildChatRow(body, '工作中...');
  api.setConfig({ enabled: true, typeSpeedMs: 0 });
  assert.equal(clock.style.display, 'none');
  assert.ok(label.classList.contains('zu-rotator-active-label'));
  api.setConfig({ enabled: false });
  assert.equal(clock.style.display, '', 'clock restored on direct disable');
  assert.equal(label.classList.contains('zu-rotator-active-label'), false, 'active label class removed');
});

test('关闭态的整文档还原不碰从未挂载过的 loading 行（新旧结构都要守卫）', () => {
  const env = makeRotatorEnv('zh');
  const { body, timers, advanceNow } = env;
  const rows = [buildChatRow(body, '工作中...'), buildChatRow3180(body, 'Thinking')];
  const tick = [...timers.values()].filter(t => t.interval && t.ms === 65).pop().fn;
  advanceNow(2000); tick();   // 关闭态（默认）的 1s 帧步会扫全文档还原
  advanceNow(2000); tick();
  const want = ['工作中...', 'Thinking'];
  rows.forEach((row, i) => {
    assert.equal(row.label.textContent, want[i], 'untouched row keeps its host text');
    assert.equal(row.chatRow.hasAttribute('data-zusage-rotator-slot'), false);
    assert.equal(row.label.hasAttribute('data-zu-host-label'), false);
  });
});

/* ---------- v347 附加工作时长与悬停提示（specs/status-rotator-work-duration.md；
 * 性能预算 specs/perf-lag-reduction.md 规则 17）---------- */

test('v347 defaults: appendWorkDuration defaults on; explicit false survives; dirty value falls back', () => {
  const fresh = makeRotatorEnv('zh');
  assert.equal(vm.runInContext('rotatorCfg.appendWorkDuration', fresh.ctx), true, 'defaults on (2026-11-14 用户规格)');
  const optedOut = makeRotatorEnv('zh', { appendWorkDuration: false });
  assert.equal(vm.runInContext('rotatorCfg.appendWorkDuration', optedOut.ctx), false, 'persisted explicit opt-out survives');
  const dirty = makeRotatorEnv('zh', { appendWorkDuration: 'yes' });
  assert.equal(vm.runInContext('rotatorCfg.appendWorkDuration', dirty.ctx), true, 'non-boolean falls back to the default');
});

test('v347 formatWorkDuration mirrors the host formatConversationWorkDuration across all buckets', () => {
  const { ctx } = makeRotatorEnv('zh');
  const fmt = (lang, ms) => vm.runInContext(`formatWorkDuration(${JSON.stringify(lang)}, ${ms})`, ctx);
  assert.equal(fmt('zh', 125000), '2 分 5 秒');
  assert.equal(fmt('zh', 42000), '42 秒');
  assert.equal(fmt('zh', 3780000), '1 时 3 分');
  assert.equal(fmt('zh', 3723000), '1 时 2 分', 'three non-zero units are capped at the first two (review V2)');
  assert.equal(fmt('zh', 60000), '1 分', 'seconds=0 with a higher unit is not listed');
  assert.equal(fmt('zh', 93600000), '1 天 2 时', 'first two units win across the day boundary');
  assert.equal(fmt('zh', 500), '1 秒', 'sub-second rounds up to the 1s floor');
  assert.equal(fmt('zh', 1500), '2 秒', 'rounds up past the half-second boundary (review V1)');
  assert.equal(fmt('en', 400), '1s', 'sub-second rounds up to the 1s floor (en)');
  assert.equal(fmt('en', 125000), '2m 5s');
  assert.equal(fmt('en', 3780000), '1h 3m');
  assert.equal(fmt('en', 3723000), '1h 2m', 'three non-zero units are capped at the first two (en)');
  assert.equal(fmt('en', 93600000), '1d 2h');
});

test('v347 mount: duration span after the label, tooltip independent of the toggle, restore cleans both', () => {
  const { window, body } = makeRotatorEnv('zh');
  const api = window.__zusageStatusRotator;
  const { chatRow, label } = buildChatRow(body, '工作中...');

  api.setConfig({ enabled: true, typeSpeedMs: 0 });
  const span = label.nextElementSibling;
  assert.ok(span && span.classList.contains('zu-rotator-elapsed'), 'duration span inserted right after the label');
  assert.ok(/^工作中 /.test(span.textContent), `span shows the host-format duration, got "${span.textContent}"`);
  assert.equal(span.textContent, chatRow.getAttribute('data-tip'), 'tooltip shares the same text as the span');
  assert.ok(chatRow.classList.contains('zu-rot-livetip'), 'tooltip class on the row (v349: outside the label filter scope)');
  assert.equal(label.getAttribute('data-tip'), null, 'no legacy tip left on the label');
  assert.equal(label.getAttribute('title'), null, 'no native title on the label');

  // host 模式：span 摘除（宿主耗时格本就显示），tooltip 仍在（独立于开关①）
  api.setConfig({ labelSource: 'host' });
  assert.equal(chatRow.querySelector('.zu-rotator-elapsed'), null, 'span removed in host mode');
  assert.ok(chatRow.hasAttribute('data-tip'), 'tooltip stays in host mode');

  // 关闭还原：span 与 tooltip 一并摘除
  api.setConfig({ enabled: false });
  assert.equal(chatRow.querySelector('.zu-rotator-elapsed'), null, 'span removed on restore');
  assert.equal(chatRow.hasAttribute('data-tip'), false, 'row data-tip cleaned on restore');
  assert.equal(chatRow.classList.contains('zu-rot-livetip'), false, 'tooltip class cleaned on restore');
  assert.equal(label.hasAttribute('data-tip'), false, 'label legacy tip stays clean');
});

test('v347 mount works on the 3.18.0 loading row structure (label renamed; host-client parity)', () => {
  const { window, body } = makeRotatorEnv('zh');
  const api = window.__zusageStatusRotator;
  const { chatRow, label } = buildChatRow3180(body, '工作中');

  api.setConfig({ enabled: true, typeSpeedMs: 0 });
  const span = label.nextElementSibling;
  assert.ok(span && span.classList.contains('zu-rotator-elapsed'), 'duration span inserted after the renamed label');
  assert.ok((chatRow.getAttribute('data-tip') || '').startsWith('工作中'), 'tooltip carried by the row (v349)');
  assert.ok(chatRow.classList.contains('zu-rot-livetip'), 'tooltip class on the row');
  assert.equal(label.getAttribute('data-tip'), null, 'no legacy tip on the renamed label');

  api.setConfig({ appendWorkDuration: false });
  assert.equal(chatRow.querySelector('.zu-rotator-elapsed'), null, 'span removed on toggle off (new structure)');
  assert.ok(chatRow.hasAttribute('data-tip'), 'tooltip independent of the toggle (new structure)');

  api.setConfig({ enabled: false });
  assert.equal(chatRow.querySelector('.zu-rotator-elapsed'), null, 'span removed on restore (new structure)');
  assert.equal(chatRow.hasAttribute('data-tip'), false, 'row tip cleaned on restore (new structure)');
  assert.equal(chatRow.classList.contains('zu-rot-livetip'), false, 'tooltip class cleaned (new structure)');
  assert.equal(label.textContent, '工作中', 'host text restored on the renamed label');
});

test('v347 perf rule 17: same-second ticks write nothing; second rollover writes once; no added document queries', () => {
  const env = makeRotatorEnv('zh');
  const { ctx, window, body, timers, advanceNow } = env;
  const doc = env.document;
  const api = window.__zusageStatusRotator;
  const { chatRow, label } = buildChatRow(body, '工作中...');

  let qsaCalls = 0;
  const rawQsa = doc.querySelectorAll.bind(doc);
  doc.querySelectorAll = sel => { qsaCalls++; return rawQsa(sel); };

  api.setConfig({ enabled: true, typeSpeedMs: 0, whaleTail: false });
  const tick = [...timers.values()].filter(t => t.interval && t.ms === 65).pop().fn;
  const span = label.nextElementSibling;
  assert.ok(span && span.classList.contains('zu-rotator-elapsed'), 'span mounted before the gating measurements');

  // 写计数探针：textContent 用 defineProperty 覆盖夹具的 get/set 属性后计数
  function spyWrites(el) {
    const counts = { text: 0, attr: 0, cls: 0 };
    const rawSetAttr = el.setAttribute.bind(el);
    el.setAttribute = (k, v) => { counts.attr++; rawSetAttr(k, v); };
    const cls = el.classList;
    const rawAdd = cls.add.bind(cls);
    const rawRemove = cls.remove.bind(cls);
    cls.add = (...a) => { counts.cls++; return rawAdd(...a); };
    cls.remove = (...a) => { counts.cls++; return rawRemove(...a); };
    let tv = el.textContent;
    Object.defineProperty(el, 'textContent', {
      configurable: true,
      get: () => tv,
      set: v => { counts.text++; tv = String(v == null ? '' : v); }
    });
    return counts;
  }
  const spanW = spyWrites(span);
  const labelW = spyWrites(label);
  // data-tip 专项计数：行上另有既有代码每拍无条件写的 slot 标记（setAttribute 同值 DOM no-op），
  // 整表 attr 计数会把非本功能写入混进来
  let tipWrites = 0;
  const rawRowSetAttr = chatRow.setAttribute.bind(chatRow);
  chatRow.setAttribute = (k, v) => { if (k === 'data-tip') tipWrites++; return rawRowSetAttr(k, v); };

  advanceNow(70); tick();   // 同一秒内（elapsed ~140ms < 1s）
  advanceNow(70); tick();
  assert.deepEqual(spanW, { text: 0, attr: 0, cls: 0 }, 'same-second ticks write nothing to the span');
  assert.equal(labelW.text, 0, 'same-second ticks write nothing to the label text (static phrase)');
  assert.equal(labelW.attr, 0, 'same-second ticks write nothing to label attributes');
  assert.equal(tipWrites, 0, 'same-second ticks write nothing to the row tooltip');
  const qsaBefore = qsaCalls;
  advanceNow(70); tick();
  assert.equal(qsaCalls - qsaBefore, 1, 'one whole-document rows scan per tick — the duration span adds none');

  advanceNow(1500); tick();   // 秒跨变（宿主 round 进位：elapsed ~1.71s → 「2 秒」）→ 恰各一次写
  assert.equal(spanW.text, 1, 'second rollover writes the span once');
  assert.equal(tipWrites, 1, 'second rollover writes the row tooltip once');
  // 注：labelW.cls 不在此断言——既有代码每拍无条件 classList.add("zu-rotator-active-label")
  // （对已存在类是 DOM no-op，非本功能写入）；本功能的类操作门控由源码契约测试锁定。

  api.setConfig({ appendWorkDuration: false });
  assert.equal(chatRow.querySelector('.zu-rotator-elapsed'), null, 'span removed when the toggle is off');
  assert.ok(chatRow.hasAttribute('data-tip'), 'tooltip independent of the toggle');
});

test('v347 panel: append-duration checkbox rendered, synced and saved through the change chain', () => {
  const env = makeRotatorEnv('zh');
  const { ctx, window, storage } = env;
  const html = vm.runInContext('zuRotatorSectionHtml(true)', ctx);
  assert.ok(html.indexOf('zu-rot-append-duration') > 0, 'checkbox present in the rotator section');
  assert.ok(html.indexOf('追加工作时长') > 0, 'zh label present');
  assert.equal(html.indexOf(' title='), -1, 'no native title attributes');

  const panel = makeFakeElement('div');
  const stage = makeFakeElement('div'); stage.className = 'zu-rot-prev-stage';
  panel.appendChild(stage);
  const cb = makeFakeElement('input');
  cb.className = 'zu-rot-append-duration';
  panel.appendChild(cb);
  window.__adPanel = panel;
  vm.runInContext('zuRotatorSyncPanel(window.__adPanel)', ctx);
  assert.equal(cb.checked, true, 'syncPanel checks the box per the default-on config');

  cb.checked = false;
  window.__adCb = cb;
  assert.equal(vm.runInContext('zuRotatorPanelChange({ target: window.__adCb }, window.__adPanel)', ctx), true, 'change handled');
  window.__adCb = null;
  assert.equal(vm.runInContext('rotatorCfg.appendWorkDuration', ctx), false, 'config updated');
  const saved = JSON.parse(storage['zusage3.rotator2'] || '{}');
  assert.equal(saved.appendWorkDuration, false, 'persisted through saveRotatorConfig');
  window.__adPanel = null;
});

test('v347 source contracts: zero queries/listeners/timers in the surface sync, static CSS bubble, folded restore selector', () => {
  const { ctx } = makeRotatorEnv('zh');
  const fnSrc = rotatorSlice.match(/function syncWorkDurationSurface\([\s\S]*?\n  \}/);
  assert.ok(fnSrc, 'syncWorkDurationSurface present in the shard');
  assert.ok(!/querySelector/.test(fnSrc[0]), 'span locating is nextElementSibling-only (zero document queries)');
  assert.ok(!/addEventListener|setInterval|setTimeout|MutationObserver/.test(fnSrc[0]), 'zero listeners/timers/observers');
  assert.ok(/querySelectorAll\("\.zu-whale-tail-wrap,[^"]*\.zu-rotator-elapsed"\)/.test(rotatorSlice), 'span removal folded into the existing restore selector');
  assert.ok(!/label\.setAttribute\("data-tip"/.test(rotatorSlice), 'tip never written back onto the gradient label (v349 filter scope)');
  assert.ok(/row\.setAttribute\("data-tip"/.test(fnSrc[0]) && /row\.getAttribute\("data-tip"\) !== text/.test(fnSrc[0]), 'tooltip lives on the row, attr compare-gated');
  assert.ok(/contains\("zu-rot-livetip"\)\) row\.classList\.add/.test(fnSrc[0]) && /contains\("zu-rot-livetip"\)\) row\.classList\.remove/.test(fnSrc[0]), 'tooltip class ops are contains-gated (no unconditional class writes)');
  assert.equal((rotatorSlice.match(/setInterval\(/g) || []).length, 2, 'no new intervals (rotator tick + preview tick only)');

  const css = vm.runInContext('rotatorStyleEl.textContent', ctx);
  assert.ok(css.indexOf('.zu-rot-livetip{position:relative}') >= 0, 'tooltip anchor rule present');
  assert.ok(css.indexOf('.zu-rot-livetip:hover::after{content:attr(data-tip)') >= 0, 'CSS-only tooltip rule present');
  assert.ok(/\.zu-rot-livetip:hover::after\{[^}]*pointer-events:none/.test(css), 'pseudo-element never traps the pointer');
  assert.ok(!/\.zu-rot-livetip[^{]*\{[^}]*animation/.test(css), 'no animation on the bubble (rule 17 ⑤)');
  /* v348 用户实报两连：文字隐形=text-fill-color 透明继承；样式=宿主原生 TooltipContent 视格（无阴影） */
  assert.ok(/\.zu-rot-livetip:hover::after\{[^}]*-webkit-text-fill-color:var\(--color-tooltip-foreground/.test(css), 'text-fill-color reset defeats the gradient-label transparent inheritance');
  assert.ok(/\.zu-rot-livetip:hover::after\{[^}]*background:var\(--color-tooltip,/.test(css), 'system tooltip background (bg-tooltip)');
  assert.ok(/\.zu-rot-livetip:hover::after\{[^}]*border:1px solid var\(--color-border,/.test(css), 'system tooltip border (border-border)');
  assert.ok(!/\.zu-rot-livetip:hover::after\{[^}]*box-shadow/.test(css), 'no shadow on the bubble (native TooltipContent has none)');
});
