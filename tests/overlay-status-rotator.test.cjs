const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
const startIdx = source.indexOf('  /* ==================== Status Rotator & Whale Tail & Danmaku Engine (v268) ====================');
const endIdx = source.indexOf('  /* 设置页（MCP 配置等）内的编辑框不是聊天输入框');
assert.ok(startIdx > 0 && endIdx > startIdx, 'Status Rotator block exists in overlay.js');
const rotatorSlice = source.slice(startIdx, endIdx);

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
      if (innerHTMLVal.includes('zu-rotator-sep')) {
        const sep = makeFakeElement('span');
        sep.className = 'zu-rotator-sep dim';
        sep.textContent = '·';
        el.appendChild(sep);
      }
      if (innerHTMLVal.includes('zu-rotator-active-label')) {
        const lbl = makeFakeElement('span');
        lbl.className = 'zu-rotator-active-label';
        const m2 = /<span class="zu-rotator-active-label">([^<]*)<\/span>/.exec(innerHTMLVal);
        if (m2) lbl.textContent = m2[1];
        el.appendChild(lbl);
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

function makeRotatorEnv(lang = 'zh') {
  const storage = {};
  const body = makeFakeElement('body');
  const docEl = makeFakeElement('html');
  docEl.classList.add('dark');

  const document = {
    title: 'ZCode Host Title',
    body,
    documentElement: docEl,
    createElement: tag => makeFakeElement(tag),
    querySelectorAll: sel => body.querySelectorAll(sel),
    querySelector: sel => body.querySelector(sel)
  };
  const window = {
    innerWidth: 1280,
    innerHeight: 800
  };
  const state = { lang, data: { session: { model: 'DeepSeek-V3' } } };
  const instances = [];
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
    activeSettingsSec: () => 'rotator',
    settingRow: (ctrl, title, desc) => `<div class="row">${ctrl}<b>${title}</b><span>${desc}</span></div>`,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    Date, Math, JSON, Number, String, Array, Object, RegExp, Infinity, isFinite, parseInt, parseFloat
  });
  vm.runInContext(rotatorSlice, ctx);
  return { ctx, window, document, body, storage, state, instances };
}

function buildFakeSpeedBar(body) {
  const barMain = makeFakeElement('div');
  barMain.className = 'zu-main';
  const speedIt = makeFakeElement('span');
  speedIt.className = 'it';
  speedIt.setAttribute('tabindex', '0');
  const ico = makeFakeElement('svg');
  ico.className = 'ico';
  const dimAvg = makeFakeElement('span');
  dimAvg.className = 'dim';
  dimAvg.textContent = '均';
  const live = makeFakeElement('span');
  live.className = 'zu-live ok';
  live.textContent = '144.1';
  const dimUnit = makeFakeElement('span');
  dimUnit.className = 'dim';
  dimUnit.textContent = 't/s';
  speedIt.appendChild(ico);
  speedIt.appendChild(dimAvg);
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

test('merges whale tail and rotator label directly into the speed .it cell and restores native lightning icon on unmount', () => {
  const { ctx, window, body } = makeRotatorEnv('zh');
  const api = window.__zusageStatusRotator;

  // Create fake host chat-loading row + native clock + pixel grid
  const chatRow = makeFakeElement('div');
  chatRow.setAttribute('data-testid', 'chat-loading');
  const pixelGrid = makeFakeElement('span');
  pixelGrid.className = 'grid';
  const label = makeFakeElement('span');
  label.className = 'zcode-loading-label';
  label.textContent = '原生思考中...';
  const clock = makeFakeElement('span');
  clock.className = 'font-mono tabular-nums';
  clock.textContent = '12.3s';
  chatRow.appendChild(pixelGrid);
  chatRow.appendChild(label);
  chatRow.appendChild(clock);
  body.appendChild(chatRow);

  // Create fake status bar .zu-main with speed .it cell
  const { barMain, speedIt, ico } = buildFakeSpeedBar(body);

  // 1) Default mountTarget = "both"
  api.setConfig({ enabled: true, mountTarget: 'both', typeSpeedMs: 0, whaleTail: true });
  vm.runInContext('rotatorMasterTick()', ctx);

  assert.equal(chatRow.getAttribute('data-zusage-rotator-slot'), '1');
  assert.equal(label.getAttribute('data-zu-host-label'), '原生思考中...');
  assert.notEqual(label.textContent, '原生思考中...');
  assert.equal(pixelGrid.style.display, 'none', 'native pixel grid hidden while whaleTail is on');
  assert.ok(chatRow.querySelector('.zu-whale-tail-wrap'), 'whale tail mounted in chat loading row');
  assert.equal(clock.textContent, '12.3s', 'native elapsed clock untouched');

  // Verify merged into speedIt (<span tabindex="0" class="it">)
  const mergedTail = speedIt.querySelector('.zu-whale-tail-wrap');
  const mergedBar = speedIt.querySelector('.zu-rotator-bar');
  assert.ok(mergedTail, 'whale tail mounted directly inside speed .it cell');
  assert.equal(mergedTail.parentElement, speedIt, 'whale tail is direct child of speed .it');
  assert.equal(speedIt.firstChild, mergedTail, 'whale tail sits at the start of speed .it');
  assert.equal(ico.style.display, 'none', 'native lightning svg.ico is hidden while whale tail is shown');
  assert.equal(mergedTail.querySelector('.zu-whale-tail').getAttribute('viewBox'), '20 40 300 240', 'whale tail uses unclipped viewBox="20 40 300 240"');
  assert.ok(mergedBar, 'rotator bar label mounted directly inside speed .it cell');
  assert.equal(mergedBar.parentElement, speedIt, 'rotator bar is direct child of speed .it');

  // 2) Switch to mountTarget = "bar" -> chat row restored, merged speed .it remains
  api.setConfig({ mountTarget: 'bar', barAlwaysShow: true });
  assert.equal(label.textContent, '原生思考中...', 'host label restored when switching to bar-only');
  assert.equal(pixelGrid.style.display, '', 'pixel grid restored');
  assert.equal(chatRow.querySelector('.zu-whale-tail-wrap'), null);
  assert.ok(speedIt.querySelector('.zu-rotator-bar'), 'merged bar pill still present inside speed .it');
  assert.ok(speedIt.querySelector('.zu-whale-tail-wrap'), 'merged whale tail still present inside speed .it');

  // 3) Switch to mountTarget = "chat" -> merged bar elements removed and lightning icon restored
  api.setConfig({ mountTarget: 'chat' });
  assert.equal(barMain.querySelector('.zu-rotator-bar'), null, 'bar pill removed in chat-only mode');
  assert.equal(speedIt.querySelector('.zu-whale-tail-wrap'), null, 'whale tail removed from speed .it in chat-only mode');
  assert.equal(ico.style.display, '', 'native lightning svg.ico restored when bar rotator unmounts');
  assert.ok(chatRow.querySelector('.zu-whale-tail-wrap'), 'whale tail back in chat row');
});

test('idle barAlwaysShow mode advances typewriter across ticks without resetting to first character', () => {
  const { ctx, window, body } = makeRotatorEnv('zh');
  const api = window.__zusageStatusRotator;

  // No chat-loading element in DOM -> idle state (ctx.active === false)
  const { speedIt } = buildFakeSpeedBar(body);

  api.setConfig({
    enabled: true,
    mountTarget: 'bar',
    barAlwaysShow: true,
    typeSpeedMs: 1,
    whaleTail: true
  });

  // api.setConfig already triggers an initial rotatorMasterTick()
  const firstLabel = speedIt.querySelector('.zu-rotator-active-label').textContent;
  assert.equal(firstLabel.length, 1, 'starts typing at character 1');

  // Advance clock and run subsequent ticks
  vm.runInContext('rotatorRuntime.lastTypeTime = 0; rotatorMasterTick()', ctx);
  vm.runInContext('rotatorRuntime.lastTypeTime = 0; rotatorMasterTick()', ctx);
  vm.runInContext('rotatorRuntime.lastTypeTime = 0; rotatorMasterTick()', ctx);

  const laterLabel = speedIt.querySelector('.zu-rotator-active-label').textContent;
  assert.ok(laterLabel.length > firstLabel.length, `expected typewriter to progress past 1 char in idle mode, got "${laterLabel}"`);
});

test('danmaku engine fires items and settings section renders all controls', () => {
  const { ctx, window } = makeRotatorEnv('zh');
  const api = window.__zusageStatusRotator;

  api.setConfig({ danmaku: { enabled: true, maxConcurrent: 5, pauseBehindMask: false, clickCopy: true } });
  const ok = api.sendDanmaku('测试弹幕 666', 'running');
  assert.equal(ok, true);

  assert.ok(source.includes('zuRotatorSectionHtml(secOpen("rotator") === "")'), 'buildPanel wires zuRotatorSectionHtml');
  const html = vm.runInContext('zuRotatorSectionHtml(true)', ctx);
  assert.match(html, /data-sec="rotator"/);
  assert.match(html, /zu-rot-mount/);
  assert.match(html, /zu-rot-whaletail/);
  assert.match(html, /zu-rot-tail-action/);
  assert.match(html, /zu-rot-dm-enable/);
});
