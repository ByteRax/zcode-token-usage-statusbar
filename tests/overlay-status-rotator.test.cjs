const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
const startIdx = source.indexOf('  /* ==================== Status Rotator & Whale Tail (v268 移植；后按用户规格收敛) ====================');
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
        const re = /<span class="zu-rotator-active-label">([^<]*)<\/span>/g;
        let m2;
        while ((m2 = re.exec(innerHTMLVal))) {
          const lbl = makeFakeElement('span');
          lbl.className = 'zu-rotator-active-label';
          lbl.textContent = m2[1];
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

function makeRotatorEnv(lang = 'zh', savedCfg = null) {
  const storage = {};
  if (savedCfg) storage['zusage3.rotator'] = JSON.stringify(savedCfg);
  const body = makeFakeElement('body');
  const docEl = makeFakeElement('html');
  docEl.classList.add('dark');

  let NOW = 1700000000000;
  class FakeDate extends Date {
    constructor(...args) { super(args.length === 0 ? NOW : args[0]); }
    static now() { return NOW; }
  }

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

  // 保存过词包选择：旧版 `id in 数组` 恒 false 把选择清空，现在必须保留合法 id、丢弃未知 id
  const env2 = makeRotatorEnv('zh', { enabledPacks: ['deepseek', 'bogus-pack'], mountTarget: 'bar' });
  assert.deepEqual(vm.runInContext('rotatorCfg.enabledPacks.slice()', env2.ctx), ['deepseek']);
  assert.equal(vm.runInContext('rotatorCfg.mountTarget', env2.ctx), undefined, 'bar mount config is gone');
});

test('65ms rotator timer drives the typewriter past the first character (regression: stuck at 「长」)', () => {
  const env = makeRotatorEnv('zh');
  const { ctx, window, body, timers, advanceNow } = env;

  const ivs = [...timers.values()].filter(t => t.interval && t.ms === 65);
  assert.equal(ivs.length, 1, 'module-level ensureRotatorTimer schedules exactly one 65ms interval');

  buildChatRow(body);
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
  assert.equal(pixelGrid.style.display, '', 'pixel grid restored');
  assert.equal(clock.style.display, '', 'clock restored');
  assert.equal(chatRow.querySelector('.zu-whale-tail-wrap'), null, 'whale tail removed');
  assert.equal(chatRow.hasAttribute('data-zusage-rotator-slot'), false);
});

test('speed cell wears the flow theme only — no rotator pill, no whale svg, native icon intact (user spec #2)', () => {
  const { ctx, window, body } = makeRotatorEnv('zh');
  const api = window.__zusageStatusRotator;
  buildChatRow(body);   // 激活轮播
  const { barMain, speedIt, ico } = buildFakeSpeedBar(body);

  api.setConfig({ enabled: true, whaleTail: true, typeSpeedMs: 0 });
  assert.equal(barMain.querySelector('.zu-rotator-bar'), null, 'rotator pill never injected into the bar');
  assert.equal(barMain.querySelector('.zu-whale-tail-wrap'), null, 'whale svg never injected into the bar');
  assert.equal(ico.style.display, '', 'native lightning icon untouched');
  assert.equal(speedIt.classList.contains('zu-flow-num'), true, 'speed .it carries the flow class when gradient is on');

  api.setConfig({ enabled: false });
  assert.equal(speedIt.classList.contains('zu-flow-num'), false, 'flow class removed when rotator disabled');

  api.setConfig({ enabled: true, appearance: { gradient: { enabled: false } } });
  assert.equal(speedIt.classList.contains('zu-flow-num'), false, 'flow class follows gradient.enabled');

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
  assert.doesNotMatch(html, /zu-rot-mount/, 'no mount selector (bar mount removed)');
  assert.doesNotMatch(html, /zu-rot-bar-always/, 'no bar-always switch');
  assert.match(html, /zu-rot-pack-preview/, 'preview container rendered');
  assert.match(html, /zu-rot-pack-prev/, 'per-pack preview buttons rendered');
  assert.match(html, /<small>[1-9]/, 'pack phrase counts are real numbers now (were all 0)');

  const pv = vm.runInContext('zuRotPackPreviewHtml("deepseek")', ctx);
  assert.ok(pv.includes('DeepSeek'), 'preview carries the localized pack title');
  assert.match(pv, /zu-rotator-active-label/, 'preview phrases wear the themed shimmer label');
  const stripped = pv
    .replace(/<b>/g, '').replace(/<\/b>/g, '')
    .replace(/<span class="zu-rot-pv-phase">/g, '')
    .replace(/<span class="zu-rotator-active-label">/g, '')
    .replace(/<\/span>/g, '');
  assert.ok(!/[<>]/.test(stripped), 'no unescaped angle brackets outside the known wrapper tags');
  assert.equal(vm.runInContext('zuRotPackPreviewHtml("no-such-pack")', ctx), '', 'unknown pack yields empty preview');
});
