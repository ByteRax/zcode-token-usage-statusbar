const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');
const { readOverlaySource, getNamedSlice } = require('./helpers/overlay-extract.cjs');

const source = readOverlaySource();
const rotatorSlice = getNamedSlice('statusRotator');

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

test('rotator defaults follow the 2026-11-06 user spec; v2 storage key ignores the legacy one', () => {
  const { ctx, storage } = makeRotatorEnv('zh');
  const cfg = JSON.parse(JSON.stringify(vm.runInContext('rotatorCfg', ctx)));
  assert.equal(cfg.enabled, true, 'rotator on');
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
  assert.equal(cfg.enabledPacks.length, 14, 'all 14 packs enabled by default');
  assert.equal(cfg.enabledPacks.slice().sort().join(','), vm.runInContext('ZU_ROTATOR_PACK_META.map(function (m) { return m.id; })', ctx).sort().join(','), 'every pack id enabled');
  assert.equal('zusage3.rotator' in storage, false, 'legacy v1 key untouched on fresh load');

  // 旧键内容不再被读取（求值前预置才有真实读路径）；新键保存值照常生效
  const legacy = makeRotatorEnv('zh', null, { appearance: { theme: 'glitch' } });
  assert.equal(vm.runInContext('rotatorCfg.appearance.theme', legacy.ctx), 'none', 'legacy v1 key is ignored');
  const saved = makeRotatorEnv('zh', { appearance: { theme: 'none' } });
  assert.equal(vm.runInContext('rotatorCfg.appearance.theme', saved.ctx), 'none', 'v2 saved config honored');
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
