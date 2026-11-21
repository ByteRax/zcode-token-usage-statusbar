const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
const injectSource = fs.readFileSync(path.join(__dirname, '..', 'inject-main.cjs'), 'utf8');

/* v344 增强提示词按钮：切片契约 + 整 IIFE 行为（overlay-quota-chip 同款夹具）。
 * 夹具：工具行 wrapper span 内 [用量圆环, 模型 chip]，editor 带 __zcodeLexicalInputE2E 桥；
 * 断言按钮前插模型 chip 左侧、点击发 prompt-enhance 请求、回包 setText、冲突不覆盖、开关门控。 */

const {
  getNamedSlice,
} = require(path.join(__dirname, 'helpers', 'overlay-extract.cjs'));

/* ---------- 切片契约：源码锚点（改行为必须同步改断言） ---------- */
test('contract: renderer slices keep enhance button wiring anchors', () => {
  assert.match(source, /ENHANCE_ANCHOR_SEL = '\[data-testid="chat-model-select-trigger"\]'/);
  assert.match(source, /wrap\.insertBefore\(b, ref\)/);   // 紧贴锚点左侧（跳过同锚 quota 段）
  assert.doesNotMatch(source, /wrap\.children\.indexOf/);   // 真实 DOM children 是 HTMLCollection，无 indexOf（实机 coordErr 教训）
  assert.match(source, /ENH_SVG_BUSY/);   // loading 态图标
  assert.match(source, /lucide-loader-circle/);   // 用户指定的 loader-circle（属性与 class 原样保留）
  assert.match(source, /prompt-enhance-cancel", \{ requestId: enhanceInFlightId \}/);   // 取消动作带在途 id
  assert.match(source, /enhanceSettled = true;/);   // 取消置 settled 丢弃迟到回包
  assert.match(source, /pluginRequest\(useCustom \? "prompt-enhance-v2" : "prompt-enhance"/);
  assert.match(source, /current !== draft/);   // 回填前快照比对
  assert.match(source, /apiNow\.setText\(res\.text\)/);   // 唯一官方写通道
  assert.match(source, /state\.enhanceEnabled === false/);   // 开关门控（显隐层）
  assert.match(source, /\.zu-enhance/);   // 自清与样式类名
  assert.match(source, /restoreEnhanceBtn\(true\);   \/\/ v344：摘除增强按钮/);   // dispose 中断在途请求
  assert.match(source, /enhanceSid = enhanceCurSid\(\);/);   // 发起时会话身份锚定
  assert.match(source, /enhanceCurSid\(\) !== enhanceSid/);   // 回填/收窗的会话切换校验
  assert.match(source, /readPaneScope\(wantedEl, sid, pid, true\)/);   // v354：仅增强链显式放行 draft（其余消费面不传参维持拒绝）
  assert.match(source, /b\.addEventListener\("mouseenter", function \(\) \{ showEnhanceTip\(this\); \}\)/);   // 悬停 tooltip
  assert.match(source, /b\.__zuEnhTip = label;/);   // 文案包随相位同步
  assert.doesNotMatch(source, /b\.title = label/);   // 禁原生 title（防与自绘 tooltip 双显）
  assert.match(source, /"enhance failed: "\.slice|Enhancing…|增强中…/);
  assert.match(source, /b\.__zuOpenEnhSettings = openEnhSettings;/);   // v417：增强历史壳层「设置」入口经实例钩子分发（壳层无闭包私有 panel/gear，曾 ReferenceError 静默失效）
  assert.match(source, /function openEnhSettings\(\) \{/);   // 实例侧执行体（右键同路径复用）
});

test('contract: inject-main whitelist routes prompt-enhance with fail-closed gate', () => {
  assert.match(injectSource, /req\.action === "prompt-enhance"/);
  assert.match(injectSource, /req\.action === "enhance" && typeof req\.enabled === "boolean"/);
  assert.match(injectSource, /if \(!enhanceEnabled\(\)\) \{ respond\(\{ ok: false, kind: "disabled"/);
  assert.match(injectSource, /function enhanceEnabled\(\) \{ return readCfgCached\(\)\.enhance_enabled !== false; \}/);
  assert.match(injectSource, /enhanceEnabled: enhanceEnabled\(\),/);   // 推送面
  assert.match(injectSource, /enhance_enabled: enabled/);   // 原子事务写
  assert.match(injectSource, /req\.action === "prompt-enhance-cancel" && typeof req\.requestId === "string"/);   // 取消分支
  assert.match(injectSource, /enhanceInFlight\.set\(wc, entries\)/);
  assert.match(injectSource, /signal: controller\.signal/);   // 中断透传 enhanceText
  assert.match(injectSource, /entries\.get\(req\.requestId\) === entry/);
  assert.match(source, /lucide-loader-circle/);   // （重复锚亦作 loading 态回归锚）
});

/* ---------- 行为夹具 ---------- */
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {};
    this.style.setProperty = (k, v) => { this.style[k] = v; };
    this.style.getPropertyValue = k => this.style[k] || '';
    this.listeners = new Map(); this.classes = new Set(); this.queries = new Map();
    this.classList = { contains: k => this.classes.has(k), add: k => this.classes.add(k), remove: k => this.classes.delete(k),
      toggle: (k, on) => { if (on) this.classes.add(k); else this.classes.delete(k); } };
    this.textContent = ''; this.innerHTML = ''; this._className = ''; this.isConnected = true;
  }
  set className(v) { this._className = String(v); this.classes.clear(); this._className.split(/\s+/).filter(Boolean).forEach(c => this.classes.add(c)); }
  get className() { return this._className; }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    const i = this.parentElement.children.indexOf(this);
    return this.parentElement.children[i + 1] || null;
  }
  setAttribute(k, v) { this.dataset[k] = String(v); }
  removeAttribute(k) { delete this.dataset[k]; }
  addEventListener(type, fn) { const a = this.listeners.get(type) || []; a.push(fn); this.listeners.set(type, a); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(f => f !== fn)); }
  appendChild(el) { this.children.push(el); el.parentElement = this; el.isConnected = true; return el; }
  insertBefore(el, ref) {
    if (!ref || ref.parentElement !== this) return this.appendChild(el);
    if (el.parentElement) el.remove();
    const idx = this.children.indexOf(ref);
    this.children.splice(idx, 0, el); el.parentElement = this; el.isConnected = true; return el;
  }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(e => e !== this); this.parentElement = null; this.isConnected = false; }
  matches(sel) { return sel === '.zu-sr-only' && this.classList.contains('zu-sr-only'); }
  querySelector(k) {
    if (k.startsWith('[data-testid="')) {
      const tid = k.slice('[data-testid="'.length, -2);
      for (const c of this.children) {
        if (c.dataset && c.dataset['data-testid'] === tid) return c;
        const hit = c.querySelector && c.querySelector(k);
        if (hit) return hit;
      }
      return null;
    }
    /* class 选择器兜底空元素（额度 chip 夹具同款）：面板 syncUpdate 链会查询大量
     * .zu-* 节点，返回 null 会在 buildPanel 首轮抛 coordErr 拖垮整个实例创建 */
    return this.queries.has(k) ? this.queries.get(k) : (this.queries.set(k, new Element()), this.queries.get(k));
  }
  querySelectorAll(sel) {
    if (sel === '[data-testid="v4-model-config"]') {   // readQuotaSelection 的实时模型归属标记（额度夹具同款）
      return this.children.filter(e => e.getAttribute('data-testid') === 'v4-model-config').concat(
        ...this.children.map(e => e.querySelectorAll(sel)));
    }
    return [];
  }
  contains(el) { return el === this || this.children.some(e => e.contains(el)); }
  closest() { return null; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.dataset, k); }
  getAttribute(k) { return this.dataset[k] !== undefined ? this.dataset[k] : null; }
  getBoundingClientRect() { return { top: 600, bottom: 650, left: 20, right: 520, width: 500, height: 50 }; }
  focus() {}   // v417：openEnhSettings 末尾 nav.focus()（querySelector class 兜底返回空元素）
  click() { (this.listeners.get('click') || []).slice().forEach(fn => fn({ preventDefault() {}, stopPropagation() {} })); }   // v417：gear.click() 官方开启路径
}

function harness({ enhanceOn = true } = {}) {
  const window = new Element(), body = new Element('body'), root = new Element('html');
  Object.assign(window, { innerWidth: 1000, innerHeight: 800 });
  window.__zusagePluginState = { enhanceEnabled: enhanceOn ? true : false };
  let panes = [];
  const document = new Element();
  Object.assign(document, { body, documentElement: root, createElement: tag => new Element(tag),
    getElementById: id => body.children.find(e => e.id === id),
    querySelectorAll: selector => (selector.startsWith('textarea,') || selector === '[data-testid="v4-composer-input"]') ? panes : [],
    elementFromPoint: () => panes[0] || body });
  const timers = new Map(), frames = new Map(), observers = []; let id = 0;
  const lsStore = new Map();
  lsStore.set('zcode-v4-last-session:v1:ws', 'sid_main');   // pickCurrent 的宿主「工作区最后会话」记录（键名正则 ^zcode-v4-last-session:）
  const sandbox = vm.createContext({ window, document, console, innerHeight: 800, innerWidth: 1000,
    location: { href: 'file:///fixture' },
    localStorage: (() => {   // Object.keys(localStorage) 需枚举到种子键（pickCurrent 的 zcode-v4-last-session 扫描）
      const api = { getItem: k => (lsStore.has(k) ? lsStore.get(k) : null),
        setItem: (k, v) => { lsStore.set(String(k), String(v)); api[k] = String(v); },
        removeItem: k => { lsStore.delete(k); delete api[k]; } };
      for (const [k, v] of lsStore) api[k] = v;
      return api;
    })(),
    getComputedStyle: () => ({ borderTopWidth: '1px', backgroundColor: 'black', opacity: '1', display: 'block', visibility: 'visible' }),
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms, interval: false }); return id; },
    clearTimeout: n => timers.delete(n),
    setInterval: (fn, ms) => { timers.set(++id, { fn, ms, interval: true }); return id; },
    clearInterval: n => timers.delete(n),
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; }, cancelAnimationFrame: n => frames.delete(n),
    MutationObserver: class {
      constructor(fn) { this.fn = fn; this.connected = false; observers.push(this); }
      observe(target, options) { this.target = target; this.options = options; this.connected = true; }
      disconnect() { this.connected = false; }
    },
  });
  const executable = source.replace(/\}\)\(\);\s*$/, 'window.enhanceTest = { instances: function() { return instances; }, state: function() { return state; } };})();');
  function inject() { window.__zusageOverlay = false; vm.runInContext(executable, sandbox); window.enhanceTest.state().pluginUpdate = { enhanceProvider: { capability: 1, available: true, mode: 'default', revision: 0 } }; }
  function boot() { for (const [n, t] of [...timers]) if (!t.interval && t.ms === 0) { timers.delete(n); t.fn(); } }
  function tick() { for (const t of [...timers.values()]) if (t.interval && (t.ms === 600 || t.ms === 500)) t.fn(); }
  function buildComposer(pid, sid, { provider = '', model = '', draft = '' } = {}) {
    const pane = body.appendChild(new Element());
    pane.setAttribute('data-testid', 'v4-session-pane-' + pid);
    pane.setAttribute('data-pane-id', pid);   // 协调器按 data-pane-id 祖先定 pane 键并派发 attach
    pane.setAttribute('data-session-id', sid);
    pane.setAttribute('data-zusage-scope-version', '1');
    pane.setAttribute('data-zusage-pane-id', pid);
    pane.setAttribute('data-zusage-workspace-path', '/fixture');
    pane.setAttribute('data-zusage-workspace-identity', '');
    pane.setAttribute('data-zusage-remote-session-id', '');   // readQuotaSelection 的实时模型归属校验（paneSid===sid）
    pane.sid = sid;
    const card = pane.appendChild(new Element());
    const marker = card.appendChild(new Element('span'));
    marker.setAttribute('data-testid', 'v4-model-config');
    marker.setAttribute('data-provider', provider);
    marker.setAttribute('data-model', model);
    const row = card.appendChild(new Element());
    row.className = 'group/toolbar flex items-end gap-3';
    const wrap = row.appendChild(new Element('span'));
    wrap.className = 'inline-flex shrink-0';
    const ctxBtn = wrap.appendChild(new Element('button'));
    ctxBtn.setAttribute('data-testid', 'chat-context-usage-trigger');
    const modelChip = wrap.appendChild(new Element('button'));
    modelChip.setAttribute('data-testid', 'chat-model-select-trigger');
    const editor = card.appendChild(new Element());
    editor.setAttribute('data-testid', 'v4-composer-input');
    editor.setAttribute('data-e2e-lexical-bridge', 'ready');
    editor.setAttribute('data-zusage-scope-version', '1');
    editor.setAttribute('data-zusage-workspace-path', '/fixture');
    editor.setAttribute('data-zusage-workspace-identity', '');
    editor.setAttribute('data-zusage-remote-session-id', '');
    editor.closest = selector => selector === '.chat-composer-input-surface' || selector === '[data-composer-layout]' ? card : null;   // composerCardOf 的 .chat-composer-input-surface/[data-composer-layout] 判定命中 card 自身
    editor.pid = pid; editor.setAttribute('data-session-id', sid);   // 协调器按 pane 归属派发 wantedEl（额度夹具同款）
    editor.__zcodeLexicalInputE2E = {
      getText: () => editor.__zuDraft,
      setText: t => { editor.__zuDraft = String(t); editor.setTextCalls = (editor.setTextCalls || 0) + 1; },
    };
    editor.__zuDraft = draft;
    panes.push(editor);
    return { card, row, wrap, ctxBtn, modelChip, editor, pane, marker };
  }
  function payload({ provider = 'account:bigmodel-individual-coding-plan', model = 'GLM-5.3-FlashX' } = {}) {
    return { remote_evidence: false, today: {}, not_local: [],
      recent: [{ sid: 'sid_main', workspace_identity: '', ctx: 63400, context_window: 200000, last_at: Date.now(), ctx_exc: 0,
        last: { provider_id: provider, model } }] };
  }
  /* 主进程轮询替身：取走队列里的插件请求；enhance 回包按需投递 */
  function takeRequests() {
    const q = window.__zusagePluginRequests || [];
    const out = q.splice(0, q.length);
    return out;
  }
  function respond(requestId, result) {
    window.__zusagePluginResult && window.__zusagePluginResult(Object.assign({ id: requestId }, result));
    runPending(timers, 0);
  }
  /* 协调器派发的测试入口：生产链路 inst.attach(el, sid)（05 分片 coordinator 按扫描结果
   * 调用同一入口）；fixture 不复刻宿主全量可见性扫描，直接走协议入口最稳 */
  function coordAttach(el, sid) {
    if (!window.enhanceTest) return;
    const inst = window.enhanceTest.instances()[0];
    if (inst) { el.parentElement.parentElement.setAttribute('data-zusage-pane-id', inst.pid); el.setAttribute('data-zusage-pane-id', inst.pid); inst.attach(el, sid); }
  }
  const enhOf = wrap => wrap.children.find(e => e.classList.contains('zu-enhance'));
  return { window, body, inject, boot, tick, buildComposer, payload, takeRequests, respond, enhOf, coordAttach, lsStore, timers };
}

function runPending(timers, ms) {
  for (const [n, t] of [...timers]) if (!t.interval && t.ms === ms) { timers.delete(n); t.fn(); }
}

test('renderer refuses an old main bridge without enhancement capability instead of falling back', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'p', model: 'm', draft: 'draft' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main'); h.window.__zusageUpdate(h.payload()); h.tick();
  h.window.enhanceTest.state().pluginUpdate = {};
  h.enhOf(ui.wrap).listeners.get('click')[0]();
  assert.equal(h.takeRequests().filter(r => /^prompt-enhance/.test(r.action)).length, 0);
  assert.match(h.enhOf(ui.wrap).getAttribute('aria-label'), /重启/);
  assert.equal(ui.editor.__zuDraft, 'draft');
});

test('button mounts directly left of the model chip and survives heavy ticks', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  assert.ok(enh, 'enhance button should mount');
  assert.equal(ui.wrap.children.indexOf(enh), ui.wrap.children.indexOf(ui.modelChip) - 1);
  h.tick();
  assert.equal(h.enhOf(ui.wrap), enh);   // 幂等：一个实例，不重插
});

test('v417: contextmenu lands on the enhance-provider section and the entry carries the shell hook', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: 'x' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  assert.equal(typeof enh.__zuOpenEnhSettings, 'function', 'entry exposes the shell-dispatch hook');
  enh.listeners.get('contextmenu')[0]({ preventDefault() {}, stopPropagation() {} });
  assert.equal(h.window.enhanceTest.state().settingsSec, 'enhance-provider', 'opens the enhance-provider section');
});

test('click sends prompt-enhance with live selection; reply replaces draft and returns to idle', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '帮我写个脚本' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  enh.listeners.get('click')[0]();
  assert.equal(enh.getAttribute('aria-busy'), 'true', enh.getAttribute('aria-label'));   // busy 立即置位，不等回包
  const reqs = h.takeRequests().filter(r => r.action === 'prompt-enhance');
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].providerId, 'account:bigmodel-individual-coding-plan');
  assert.equal(reqs[0].modelId, 'GLM-5.3-FlashX');
  assert.equal(reqs[0].text, '帮我写个脚本');
  h.respond(reqs[0].requestId, { ok: true, text: '更清晰的脚本需求' });
  assert.equal(ui.editor.__zuDraft, '更清晰的脚本需求');
  assert.equal(ui.editor.setTextCalls, 1);
  assert.equal(enh.getAttribute('aria-label'), '增强提示词');   // v350.1 撤销相位已删除：应用成功即回初始态
});

test('draft edited during enhance is never overwritten', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '原始草稿' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  enh.listeners.get('click')[0]();
  const req = h.takeRequests().find(r => r.action === 'prompt-enhance');
  ui.editor.__zuDraft = '用户继续输入的新草稿';   // 增强期间编辑
  h.respond(req.requestId, { ok: true, text: '增强结果' });
  assert.equal(ui.editor.__zuDraft, '用户继续输入的新草稿');
  assert.equal(ui.editor.setTextCalls || 0, 0);   // 未写回
  assert.match(enh.getAttribute('aria-label'), /草稿已变化/);
  assert.equal(enh.getAttribute('aria-busy'), 'false');
});

test('empty draft rejects without a request; failure shows warn phase', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '   ' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  enh.listeners.get('click')[0]();
  assert.equal(h.takeRequests().filter(r => r.action === 'prompt-enhance').length, 0);
  assert.match(enh.getAttribute('aria-label'), /先输入内容再增强/);
  ui.editor.__zuDraft = '现在有内容了';   // 同一按钮：草稿就绪后真实发起
  enh.listeners.get('click')[0]();
  const req = h.takeRequests().find(r => r.action === 'prompt-enhance');
  assert.ok(req, 'request should fire with non-empty draft');
  h.respond(req.requestId, { ok: false, kind: 'auth', error: 'no api key' });
  assert.match(enh.getAttribute('aria-label'), /增强失败/);
});

test('enhance disabled: button not mounted even when payload present', () => {
  const h = harness({ enhanceOn: false });
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '草稿' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  assert.equal(h.enhOf(ui.wrap), undefined);
});

test('plan_auth and balance kinds surface localized kindMap text; invalid provider phrase wins over kind map (issue #429 review)', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '草稿' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  // kind 优先走 kindMap：plan_auth/balance 不带可读短语时按 kind 本地化（error 兜底为旧渲染端兼容路径）
  enh.listeners.get('click')[0]();
  let req = h.takeRequests().find(r => r.action === 'prompt-enhance');
  h.respond(req.requestId, { ok: false, kind: 'plan_auth', error: 'plan conversation key unavailable' });
  assert.match(enh.getAttribute('aria-label'), /增强失败：\s*当前套餐暂不支持增强/);
  enh.listeners.get('click')[0]();
  req = h.takeRequests().find(r => r.action === 'prompt-enhance');
  h.respond(req.requestId, { ok: false, kind: 'balance' });
  assert.match(enh.getAttribute('aria-label'), /增强失败：\s*套餐额度或资源包不足/);
  // error 短语与 kind 归并语义冲突时短语特判优先：invalid provider 不显「草稿长度超出范围」
  enh.listeners.get('click')[0]();
  req = h.takeRequests().find(r => r.action === 'prompt-enhance');
  h.respond(req.requestId, { ok: false, kind: 'invalid_input', error: 'invalid provider' });
  assert.match(enh.getAttribute('aria-label'), /增强失败：\s*供应商身份无效/);
  assert.doesNotMatch(enh.getAttribute('aria-label'), /草稿长度超出范围/);
});

test('unknown action fallback: stale main process never hangs the button', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '草稿' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  enh.listeners.get('click')[0]();
  const req = h.takeRequests().find(r => r.action === 'prompt-enhance');
  h.respond(req.requestId, { ok: false, error: 'unknown action: prompt-enhance' });
  assert.match(enh.getAttribute('aria-label'), /增强失败/);
  assert.equal(ui.editor.setTextCalls || 0, 0);
});

test('hover shows self-drawn tooltip with phase text; leave hides it', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '草稿' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  const tip = h.body.children.find(e => e.classList.contains('zusage-enhance-tip'));
  assert.ok(tip, 'enhance tip element should exist at module level');
  assert.notEqual(tip.style.display, 'flex');
  enh.listeners.get('mouseenter')[0].call(enh);
  assert.equal(tip.style.display, 'flex');   // 悬停现在是历史面板（异步取数），phase 文案进面板头部
  assert.match(tip.innerHTML, /最近增强记录/);   // 悬停已升级为历史面板（stub 不解析 HTML，用 innerHTML 断言）
  assert.equal(tip.style.display, 'flex');
  enh.listeners.get('mouseleave')[0]();
  runPending(h.timers, 220);   // mouseleave 延迟收起（给移入历史面板留时间）
  assert.equal(tip.style.display, 'none');
});

test('click during enhance cancels: cancel request fired, phase resets, late reply ignored', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '原始草稿' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  enh.listeners.get('click')[0]();   // 发起
  assert.equal(enh.getAttribute('aria-busy'), 'true');
  assert.match(enh.innerHTML, /lucide-loader-circle/);   // loading 态图标
  h.takeRequests();
  enh.listeners.get('click')[0]();   // 再点 = 取消
  const reqs = h.takeRequests();
  const cancel = reqs.find(r => r.action === 'prompt-enhance-cancel');
  assert.ok(cancel, 'cancel request should fire');
  assert.match(cancel.requestId, /^zusage-/, 'cancel carries the in-flight requestId');
  assert.equal(enh.getAttribute('aria-busy'), 'false');   // 立即恢复初始态
  assert.equal(enh.getAttribute('aria-label'), '增强提示词');
  assert.equal(enh.innerHTML.indexOf('lucide-loader-circle'), -1);   // loading 图标复原
  // 迟到回包被丢弃：不应用结果
  h.respond(cancel.requestId === undefined ? '' : cancel.requestId, { ok: false, kind: 'cancelled', error: 'cancelled' });
  const late = h.takeRequests();
  assert.equal(ui.editor.__zuDraft, '原始草稿');
  assert.equal(ui.editor.setTextCalls || 0, 0);
  // 撤销态不应进入
  assert.equal(enh.getAttribute('aria-label'), '增强提示词');
});

test('no undo phase after success: immediate idle, next click issues a fresh request', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '原始草稿' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  enh.listeners.get('click')[0]();   // 发起
  const req = h.takeRequests().find(r => r.action === 'prompt-enhance');
  h.respond(req.requestId, { ok: true, text: '增强后的提示词' });
  assert.equal(ui.editor.__zuDraft, '增强后的提示词');
  assert.equal(enh.getAttribute('aria-label'), '增强提示词');   // v350.1：应用成功即回初始态，无撤销窗
  h.tick();
  assert.equal(enh.getAttribute('aria-label'), '增强提示词');   // 恒初始，不滞留「撤回」
  // 再点击 = 以当前草稿发起新增强（撤销恢复行为已随相位删除）
  enh.listeners.get('click')[0]();
  const req2 = h.takeRequests().find(r => r.action === 'prompt-enhance');
  assert.ok(req2, 'next click issues a fresh enhance request');
  assert.equal(req2.text, '增强后的提示词');
  h.respond(req2.requestId, { ok: true, text: '增强稿二' });
  assert.equal(ui.editor.__zuDraft, '增强稿二');
  assert.equal(enh.getAttribute('aria-label'), '增强提示词');
});

test('session switch during enhance: reply not applied to the new session, distinct wording', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '会话A的草稿' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  enh.listeners.get('click')[0]();   // 发起（锚定 sid_main）
  const req = h.takeRequests().find(r => r.action === 'prompt-enhance');
  assert.ok(req, 'request was fired before the switch');
  const switched = h.payload();
  ui.editor.setAttribute('data-session-id', 'sid_other');
  h.coordAttach(ui.editor, 'sid_other');
  switched.mine = 'sid_other';   // auto 实例的会话身份跟随泵推送的窗口焦点会话（mine），等同宿主切会话
  h.window.__zusageUpdate(switched);
  h.tick();
  h.respond(req.requestId, { ok: true, text: '会话A的增强结果' });
  assert.match(enh.getAttribute('aria-label'), /会话已切换/);   // 区分于「草稿已变化」
  assert.equal(ui.editor.__zuDraft, '会话A的草稿');   // 新会话草稿不被写入
  assert.equal(ui.editor.setTextCalls || 0, 0);
  runPending(h.timers, 4000);   // 警示 4s 自愈（定时器桩驱动）
  assert.match(enh.getAttribute('aria-label'), /增强提示词/);   // 警示自愈回初始态
});

test('session switch inside enhance flow: stale window never rewrites, next click rebinds the new session', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '会话A原稿' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  enh.listeners.get('click')[0]();
  const req = h.takeRequests().find(r => r.action === 'prompt-enhance');
  h.respond(req.requestId, { ok: true, text: '会话A增强稿' });
  assert.equal(ui.editor.__zuDraft, '会话A增强稿');
  const switched = h.payload();
  ui.editor.setAttribute('data-session-id', 'sid_other');
  h.coordAttach(ui.editor, 'sid_other');
  switched.mine = 'sid_other';
  h.window.__zusageUpdate(switched);
  h.tick();
  assert.match(enh.getAttribute('aria-label'), /增强提示词/);   // 对账自愈：sid 切换即回初始态
  // 撤销窗已删除：点击=发起新增强；切换后的会话（fixture 无模型归属）被守卫拒绝（fail-closed），草稿不动
  enh.listeners.get('click')[0]();
  assert.match(enh.getAttribute('aria-label'), /未识别当前模型/);
  const reqs2 = h.takeRequests().filter(r => r.action === 'prompt-enhance');
  assert.equal(reqs2.length, 0, 'no cross-session enhance request');
  assert.equal(ui.editor.__zuDraft, '会话A增强稿');
});

test('v354 draft session (no first message sent) enhances instead of refusing', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'draft', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '新会话的第一句' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'draft');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  assert.ok(enh, 'enhance button should mount on a draft pane');
  enh.listeners.get('click')[0]();
  const reqs = h.takeRequests().filter(r => r.action === 'prompt-enhance');
  assert.equal(reqs.length, 1, 'draft session should fire the request');
  assert.equal(reqs[0].text, '新会话的第一句');
  h.respond(reqs[0].requestId, { ok: true, text: '更清晰的第一句' });
  assert.equal(ui.editor.__zuDraft, '更清晰的第一句');
  assert.equal(enh.getAttribute('aria-label'), '增强提示词');   // 回填成功即回初始态
});

test('v354 draft without workspace scope still refuses with session warning', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'draft', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '草稿' });
  ui.editor.removeAttribute('data-zusage-scope-version');   // 桥缺席 → fiber 兜底；夹具无 fiber 候选 → null（同时覆盖 :112 透传的拒绝面）
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'draft');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  enh.listeners.get('click')[0]();
  assert.equal(h.takeRequests().filter(r => r.action === 'prompt-enhance').length, 0);
  assert.match(enh.getAttribute('aria-label'), /未识别当前会话/);
});

test('v354 draft promoted mid-enhance discards the reply as session switch', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'draft', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '原始草稿' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'draft');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  enh.listeners.get('click')[0]();
  const req = h.takeRequests().find(r => r.action === 'prompt-enhance');
  assert.ok(req, 'request was fired on the draft pane');
  ui.editor.setAttribute('data-session-id', 'sid_real');   // 宿主 draft-promotion：首条消息发出，pane 与 composer 同步换真实 sid
  ui.pane.setAttribute('data-session-id', 'sid_real');
  h.coordAttach(ui.editor, 'sid_real');   // 协调器派发新 sid → heavy 即拍更新 instSid
  h.respond(req.requestId, { ok: true, text: '增强结果' });
  assert.match(enh.getAttribute('aria-label'), /会话已切换/);   // 晋升按切换丢弃，不回填
  assert.equal(ui.editor.__zuDraft, '原始草稿');
  assert.equal(ui.editor.setTextCalls || 0, 0);
});

test('v354 draft scope never reaches the report chain (getScope stays null)', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'draft', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '草稿' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'draft');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const inst = h.window.enhanceTest.instances()[0];
  assert.equal(inst.getScope(), null, 'report-chain getScope keeps rejecting draft (no allowDraft)');
});

test('v354 draft enhances via fiber fallback when bridge attrs are absent (allowDraft forwarded)', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'draft', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '桥缺席的draft草稿' });
  ui.pane.removeAttribute('data-zusage-scope-version');   // 桥缺席：走 readFiberPaneScope 兜底
  ui.editor.removeAttribute('data-zusage-scope-version');
  ui.editor.__reactFiber$k = { stateNode: ui.editor, memoizedProps: { workspacePath: '/fixture', paneId: 'workspace-main' }, return: null };
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'draft');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  assert.ok(enh, 'button mounts on draft pane');
  enh.listeners.get('click')[0]();
  const reqs = h.takeRequests().filter(r => r.action === 'prompt-enhance');
  assert.equal(reqs.length, 1, 'fiber fallback must let draft enhance (allowDraft forwarded through :112)');
  assert.equal(reqs[0].text, '桥缺席的draft草稿');
});

test('successful enhance returns to idle immediately; missing reply hits the 75s timeout guard', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '草稿' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  // 场景一：成功回填立即回初始态（撤销窗已删除），草稿保持增强文本
  enh.listeners.get('click')[0]();
  const req = h.takeRequests().find(r => r.action === 'prompt-enhance');
  h.respond(req.requestId, { ok: true, text: '增强稿' });
  assert.match(enh.getAttribute('aria-label'), /增强提示词/);
  assert.equal(ui.editor.__zuDraft, '增强稿');
  // 场景二：无回包时 75s 兜底警示超时
  enh.listeners.get('click')[0]();
  h.takeRequests();
  runPending(h.timers, 75000);
  assert.match(enh.getAttribute('aria-label'), /增强超时/);
  assert.equal(enh.getAttribute('aria-busy'), 'false');
});

test('main-process handlers: abort wiring, cross-window guard, fail-closed gate (behavior)', () => {
  const injectSource = fs.readFileSync(path.join(__dirname, '..', 'inject-main.cjs'), 'utf8');
  const start = injectSource.indexOf('function modelPullerProviderOk(v) {');
  const end = injectSource.indexOf('/* 渠道门控');   // 取消 handler 之后的下一个分区锚
  assert.ok(start > 0 && end > start, 'handler slice anchors');
  const slice = injectSource.slice(start, end);
  const wc1 = { id: 1, isDestroyed: () => false };
  const wc2 = { id: 2, isDestroyed: () => false };
  let enhanceOn = true, enhanceTextReady = true;
  const captured = { signals: [] };
  const replies = [];
  const sandbox = {
    enhanceEnabled: () => enhanceOn,
    modelPuller: {
      enhanceText: async (p, m, t, o) => {
        captured.signals.push(o && o.signal);
        await new Promise(() => { });   // 挂起：由外部 abort 打断
        return { ok: false, kind: 'cancelled', error: 'cancelled' };
      },
    },
    modelPullerProviderOk: (v) => typeof v === 'string' && v.length > 0 && v.length <= 160,
    enhanceRequestTextOk: (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 20000,
    deliverPluginRequest: (wc, id, result) => replies.push({ wc: wc.id, id, result }),
    LOG: () => { },
    AbortController, wc1, path: require('path'), fs: require('fs'), URL, HERE: '/tmp/fake-runtime',
    console,
  };
  vm.runInNewContext(slice + '\n;globalThis.__enh = { get: (k) => enhanceInFlight.get(wc1)?.get(k), has: (k) => !!enhanceInFlight.get(wc1)?.has(k) };', sandbox);
  assert.equal(typeof sandbox.handlePromptEnhanceRequest, 'function');
  assert.equal(typeof sandbox.handlePromptEnhanceCancel, 'function');
  const R = { action: 'prompt-enhance', requestId: 'zusage-1-1', providerId: 'p1', modelId: 'm1', text: '草稿' };
  // fail-closed：开关关
  enhanceOn = false;
  sandbox.handlePromptEnhanceRequest(R, wc1);
  assert.equal(replies[0].result.kind, 'disabled');
  enhanceOn = true;
  // 发起：在途表登记 + signal 透传
  sandbox.handlePromptEnhanceRequest(R, wc1);
  assert.equal(captured.signals.length, 1);
  assert.ok(captured.signals[0], 'signal must be forwarded to enhanceText');   // 跨 realm 实例不做 instanceof，行为断言见下
  assert.equal(captured.signals[0].aborted, false);
  // 跨窗口同名 requestId：不误伤
  sandbox.handlePromptEnhanceCancel({ requestId: 'zusage-1-1' }, wc2);
  assert.equal(captured.signals[0].aborted, false);
  assert.ok(sandbox.__enh.has('zusage-1-1'), 'cross-window cancel must not delete');
  // 本窗口取消：abort 生效
  sandbox.handlePromptEnhanceCancel({ requestId: 'zusage-1-1' }, wc1);
  assert.equal(captured.signals[0].aborted, true);
  assert.equal(sandbox.__enh.has('zusage-1-1'), false);
  // 回执送达（abort 后 enhanceText 会以 cancelled 收口并 respond）
  sandbox.handlePromptEnhanceRequest({ ...R, requestId: 'zusage-1-2' }, wc1);
  const entry2 = sandbox.__enh.get('zusage-1-2');
  assert.ok(entry2 && entry2.wc === wc1);
});

test('R1 late reply after cancel-then-reenhance must not poison R2 (round-2 MAJOR-1 regression)', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '一次草稿' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  // R1 发起 → 取消（R1 回包此刻尚未送达）
  enh.listeners.get('click')[0]();
  const r1 = h.takeRequests().find(r => r.action === 'prompt-enhance');
  enh.listeners.get('click')[0]();   // 取消 R1
  h.takeRequests();
  // R2 发起（用户改稿后再增强）
  ui.editor.__zuDraft = '二次草稿';
  enh.listeners.get('click')[0]();
  const r2 = h.takeRequests().find(r => r.action === 'prompt-enhance');
  assert.ok(r2, 'R2 must be issued');
  assert.equal(enh.getAttribute('aria-busy'), 'true');
  // R1 迟到回包（cancelled）先于 R2 回包到达：不得毒化 R2
  h.respond(r1.requestId, { ok: false, kind: 'cancelled', error: 'cancelled' });
  assert.match(enh.getAttribute('aria-label'), /增强中/);   // R2 仍在途，未被打断
  assert.equal(enh.getAttribute('aria-busy'), 'true');
  // R2 正常成功回包：正常回填
  h.respond(r2.requestId, { ok: true, text: '二次增强稿' });
  assert.equal(ui.editor.__zuDraft, '二次增强稿');
  assert.match(enh.getAttribute('aria-label'), /增强提示词/);   // v350.1：成功即回初始态
});


test('same request ID is isolated by window and old replies cannot consume a replacement', async () => {
  const start = injectSource.indexOf('function modelPullerProviderOk(v) {');
  const end = injectSource.indexOf('/* 渠道门控');
  const calls = [], replies = [];
  const sandbox = { AbortController, LOG:()=>{}, enhanceEnabled:()=>true, path: require('path'), fs: require('fs'), URL, HERE: '/tmp/fake-runtime',
    deliverPluginRequest:(wc,id,result)=>replies.push({wc,id,result}),
    readEnhanceProvider:()=>({version:1,revision:0,mode:"default",available:true}),
    modelPuller:{ enhanceText:(p,m,t,o)=>new Promise(resolve=>calls.push({signal:o.signal,resolve})) } };
  vm.runInNewContext(injectSource.slice(start,end), sandbox);
  const a = {}, b = {}, req = {requestId:'same',providerId:'p',modelId:'m',text:'draft'};
  sandbox.handlePromptEnhanceRequest(req,a); sandbox.handlePromptEnhanceRequest(req,b);
  assert.equal(calls.length,2);
  sandbox.handlePromptEnhanceRequest({...req,providerId:''},a); assert.equal(calls.length,2); assert.equal(replies.length,0);   // 同 ID 去重闸先行静默返回（真实 provider 闸在同 ID 闸之后）
  sandbox.handlePromptEnhanceCancel(req,a); assert.equal(calls[0].signal.aborted,true); assert.equal(calls[1].signal.aborted,false);
  sandbox.handlePromptEnhanceRequest(req,a); assert.equal(calls.length,3);
  calls[0].resolve({ok:false}); await new Promise(setImmediate); assert.equal(replies.length,0);
  calls[1].resolve({ok:true,text:'b'}); calls[2].resolve({ok:true,text:'a'}); await new Promise(setImmediate);
  assert.equal(replies.length,2); assert.equal(replies.find(x=>x.wc===a).result.text,'a');
});

test('cancelling while native target confirmation is open never sends the draft', async () => {
  const start = injectSource.indexOf('function modelPullerProviderOk(v) {');
  const end = injectSource.indexOf('/* 渠道门控');
  const calls = [], replies = [];
  let accept;
  const settings = { version: 1, revision: 4, mode: 'custom', source: 'manual', baseUrl: 'http://127.0.0.1:9090', protocol: 'openai-chat-completions', model: 'fixture', apiKey: 'fixture-key' };
  const sandbox = { AbortController, URL, path: require('path'), fs: require('fs'), HERE: '/tmp/fake-runtime', LOG: () => {}, enhanceEnabled: () => true,
    dialog: { showMessageBox: () => new Promise(resolve => { accept = resolve; }) }, BrowserWindow: { fromWebContents: () => ({}) },
    deliverPluginRequest: (wc, id, result) => replies.push({ id, result }),
    modelPuller: { enhanceProviderVersion: 1, enhanceText: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } } };
  vm.runInNewContext(injectSource.slice(start, end), sandbox);
  sandbox.readEnhanceProvider = () => settings;
  const wc = {}, req = { action: 'prompt-enhance-v2', requestId: 'confirm-1', revision: 4, text: 'draft' };
  const pending = sandbox.handlePromptEnhanceRequest(req, wc);
  assert.equal(typeof accept, 'function');
  sandbox.handlePromptEnhanceCancel({ requestId: req.requestId }, wc);
  accept({ response: 1 });
  await pending;
  assert.equal(calls.length, 0);
  assert.equal(replies.length, 0);
});

test('strict mode rejects a server-side downgrade while allowed mode passes it through', async () => {
  const start = injectSource.indexOf('function modelPullerProviderOk(v) {');
  const end = injectSource.indexOf('/* 渠道门控');
  const replies = [];
  const mk = (allowDowngrade) => {
    const sandbox = { AbortController, URL, path: require('path'), fs: require('fs'), HERE: '/tmp/fake-runtime', LOG: () => {}, enhanceEnabled: () => true,
      deliverPluginRequest: (wc, id, result) => replies.push(result),
      modelPuller: { enhanceProviderVersion: 1, enhanceText: (...args) => Promise.resolve({ ok: true, text: 'out', model: args[1], serverModel: 'lite-model' }) } };
    vm.runInNewContext(injectSource.slice(start, end), sandbox);
    sandbox.readEnhanceProvider = () => ({ version: 1, revision: 1, mode: 'custom', allowDowngrade, baseUrl: 'https://example.test', protocol: 'openai-chat-completions', model: 'requested-model', apiKey: 'fixture-key' });   // 运行后赋值才能覆盖切片内的函数声明
    return sandbox;
  };
  await mk(false).handlePromptEnhanceRequest({ action: 'prompt-enhance-v2', requestId: 'd1', revision: 1, text: 'draft' }, {});
  assert.equal(replies[0].ok, false);
  assert.equal(replies[0].error, 'model downgraded');
  assert.equal(replies[0].detail, 'lite-model');
  await mk(true).handlePromptEnhanceRequest({ action: 'prompt-enhance-v2', requestId: 'd2', revision: 1, text: 'draft' }, {});
  assert.equal(replies[1].ok, true);
  assert.equal(replies[1].serverModel, 'lite-model');
});

test('custom enhancement refuses an older model-puller without the capability marker', async () => {
  const start = injectSource.indexOf('function modelPullerProviderOk(v) {');
  const end = injectSource.indexOf('/* 渠道门控');
  const replies = [], calls = [];
  const sandbox = { AbortController, URL, path: require('path'), fs: require('fs'), HERE: '/tmp/fake-runtime', LOG: () => {}, enhanceEnabled: () => true,
    deliverPluginRequest: (wc, id, result) => replies.push(result),
    modelPuller: { enhanceText: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } } };
  vm.runInNewContext(injectSource.slice(start, end), sandbox);
  sandbox.readEnhanceProvider = () => ({ mode: 'custom', revision: 1 });
  await sandbox.handlePromptEnhanceRequest({ action: 'prompt-enhance-v2', requestId: 'v', revision: 1, text: 'draft' }, {});
  assert.equal(calls.length, 0);
  assert.equal(replies[0].kind, 'unavailable');
});

test('main-process real gates: invalid provider and empty draft reject with zero side effects', () => {
  const start = injectSource.indexOf('function modelPullerProviderOk(v) {');
  const end = injectSource.indexOf('/* 渠道门控');
  const calls = [], replies = [];
  const sandbox = { AbortController, LOG: () => {}, enhanceEnabled: () => true, path: require('path'), fs: require('fs'), URL, HERE: '/tmp/fake-runtime',
    deliverPluginRequest: (wc, id, result) => replies.push({ id, result }),
    modelPuller: { enhanceText: () => { calls.push(1); return new Promise(() => {}); } } };
  vm.runInNewContext(injectSource.slice(start, end), sandbox);
  const wc = {};
  sandbox.handlePromptEnhanceRequest({ requestId: 'g1', providerId: '', modelId: 'm', text: '草稿' }, wc);
  sandbox.handlePromptEnhanceRequest({ requestId: 'g2', providerId: 'p', modelId: 'm', text: '' }, wc);
  assert.equal(calls.length, 0, 'gates must reject before any network attempt');
  assert.equal(replies.filter(x => x.result.kind === 'invalid_input').length, 2);
});

test('write verification waits for asynchronous editor commit', () => {
  const h=harness(); const ui=h.buildComposer('workspace-main','sid_main',{provider:'p',model:'m',draft:'original'});
  h.inject(); h.boot(); h.coordAttach(ui.editor,'sid_main'); h.window.__zusageUpdate(h.payload({provider:'p',model:'m'})); h.tick();
  const btn=h.enhOf(ui.wrap);
  ui.editor.__zcodeLexicalInputE2E.setText = text => { h.timers.set(-1,{ms:0,interval:false,fn:()=>{ui.editor.__zuDraft=text;}}); };
  btn.listeners.get('click')[0](); const req=h.takeRequests().find(r=>r.action==='prompt-enhance');
  h.respond(req.requestId,{ok:true,text:'enhanced'});
  assert.equal(ui.editor.__zuDraft,'enhanced'); assert.match(btn.getAttribute('aria-label'),/增强提示词/);
});


test('cancelled enhance leaves no pending enhance request and never touches the draft', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'p', model: 'm', draft: '草稿' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload({ provider: 'p', model: 'm' })); h.tick();
  const btn = h.enhOf(ui.wrap);
  btn.listeners.get('click')[0]();
  const r1 = h.takeRequests().find(r => r.action === 'prompt-enhance');
  btn.listeners.get('click')[0]();   // 取消
  h.takeRequests();
  const q = h.window.__zusagePluginRequests || [];
  assert.equal(q.filter(r2 => r2.action === 'prompt-enhance').length, 0, 'cancelled enhance must not requeue');
  h.respond(r1.requestId, { ok: true, text: '迟到结果' });   // 迟到成功回包也不得写稿
  assert.equal(ui.editor.__zuDraft, '草稿');
  assert.equal(ui.editor.setTextCalls || 0, 0);
});
test('structured mention draft is rejected before network request', () => {
  const h=harness(); const ui=h.buildComposer('workspace-main','sid_main',{provider:'p',model:'m',draft:'@file'});
  ui.editor.__zcodeLexicalInputE2E.getEditorState=()=>({root:{children:[{type:'prompt-mention',markdown:'@file'}]}});
  ui.editor.__zcodeLexicalInputE2E.setEditorStateJson=()=>{};
  h.inject(); h.boot(); h.coordAttach(ui.editor,'sid_main'); h.window.__zusageUpdate(h.payload({provider:'p',model:'m'})); h.tick();
  const btn=h.enhOf(ui.wrap); btn.listeners.get('click')[0]();
  assert.equal(h.takeRequests().filter(r=>r.action==='prompt-enhance').length,0);
  assert.match(btn.getAttribute('aria-label'),/草稿含引用/); assert.equal(ui.editor.__zuDraft,'@file');
});


test('structural change with identical text prevents writeback', () => {
  const h=harness(); const ui=h.buildComposer('workspace-main','sid_main',{provider:'p',model:'m',draft:'same'});
  let state={root:{children:[{type:'text',text:'same'}]}};
  ui.editor.__zcodeLexicalInputE2E.getEditorState=()=>state; ui.editor.__zcodeLexicalInputE2E.setEditorStateJson=()=>{};
  h.inject(); h.boot(); h.coordAttach(ui.editor,'sid_main'); h.window.__zusageUpdate(h.payload({provider:'p',model:'m'})); h.tick();
  const btn=h.enhOf(ui.wrap); btn.listeners.get('click')[0](); const req=h.takeRequests().find(r=>r.action==='prompt-enhance');
  state={root:{children:[{type:'prompt-mention',markdown:'same'}]}}; h.respond(req.requestId,{ok:true,text:'changed'});
  assert.equal(ui.editor.__zuDraft,'same'); assert.equal(ui.editor.setTextCalls||0,0);
});


test('post-success click with structurally edited draft issues a fresh request, never a restore', () => {
 const h=harness(), ui=h.buildComposer('workspace-main','sid_main',{provider:'p',model:'m',draft:'same'});
 let state={root:{children:[{type:'text',text:'same'}]}}; let restored=0;
 ui.editor.__zcodeLexicalInputE2E.getEditorState=()=>state; ui.editor.__zcodeLexicalInputE2E.setEditorStateJson=()=>{restored++};
 ui.editor.__zcodeLexicalInputE2E.setText=text=>{ui.editor.__zuDraft=text;state={root:{children:[{type:'text',text}]}}};
 h.inject(); h.boot(); h.coordAttach(ui.editor,'sid_main'); h.window.__zusageUpdate(h.payload({provider:'p',model:'m'})); h.tick();
 const btn=h.enhOf(ui.wrap); btn.listeners.get('click')[0](); const req=h.takeRequests().find(r=>r.action==='prompt-enhance');
 h.respond(req.requestId,{ok:true,text:'enhanced'}); state={root:{children:[{type:'text',text:'enhanced',format:1}]}};
 // v350.1 撤销恢复已删除：成功后再点击=以当前草稿发起新请求，绝无 setEditorStateJson 回写原文路径
 btn.listeners.get('click')[0](); assert.equal(restored,0);
 const req2=h.takeRequests().find(r=>r.action==='prompt-enhance');
 assert.ok(req2, 'fresh enhance request instead of a restore');
 assert.equal(req2.text,'enhanced'); assert.equal(ui.editor.__zuDraft,'enhanced');
});


test('disabled state arriving before reply never writes draft', () => {
 const h=harness(), ui=h.buildComposer('workspace-main','sid_main',{provider:'p',model:'m',draft:'original'});
 h.inject(); h.boot(); h.coordAttach(ui.editor,'sid_main'); h.window.__zusageUpdate(h.payload({provider:'p',model:'m'})); h.tick();
 const btn=h.enhOf(ui.wrap); btn.listeners.get('click')[0](); const req=h.takeRequests().find(r=>r.action==='prompt-enhance');
 h.window.enhanceTest.state().enhanceEnabled=false; h.respond(req.requestId,{ok:true,text:'late'});
 assert.equal(ui.editor.__zuDraft,'original'); assert.equal(ui.editor.setTextCalls||0,0);
});

test('CRLF in the model reply no longer fails the read-back verify', () => {
  /* 宿主 E2E 桥 setText 后读回可能把 CRLF 规范化为 LF（Lexical/宿主行为）：
   * 逐字比对会恒不等 → 误报「写回输入框失败或草稿已变化」且历史不入账（v357 换行归一） */
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '原始' });
  const bridge = ui.editor.__zcodeLexicalInputE2E;
  const rawSetText = bridge.setText;
  bridge.setText = t => { rawSetText(t); ui.editor.__zuReadback = String(t).replace(/\r\n/g, '\n'); };
  bridge.getText = () => (ui.editor.__zuReadback != null ? ui.editor.__zuReadback : ui.editor.__zuDraft);
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload({ provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX' }));
  h.tick();
  const enh = h.enhOf(ui.wrap);
  enh.listeners.get('click')[0]();
  const req = h.takeRequests().find(r => r.action === 'prompt-enhance');
  h.respond(req.requestId, { ok: true, text: '第一行\r\n第二行' });
  assert.equal(ui.editor.__zuDraft, '第一行\r\n第二行');   // 文本已实际写回
  assert.equal(enh.getAttribute('aria-label'), '增强提示词');   // 回初始态而非误报写回失败
});

test('CRLF reply also verifies when the bridge reads back verbatim (no host normalization)', () => {
  /* 第二场景封死单侧归一作弊面：只归一 res.text 不归一 committed 的实现，在逐字读回的
   * 桥上仍恒不等误报——归一必须两侧对称（v357） */
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '原始' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload({ provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX' }));
  h.tick();
  const enh = h.enhOf(ui.wrap);
  enh.listeners.get('click')[0]();
  const req = h.takeRequests().find(r => r.action === 'prompt-enhance');
  h.respond(req.requestId, { ok: true, text: '第一行\r\n第二行' });
  assert.equal(ui.editor.__zuDraft, '第一行\r\n第二行');   // 默认桥逐字读回（getText 返回 setText 原文）
  assert.equal(enh.getAttribute('aria-label'), '增强提示词');
});

test('main bridge exposes platformLimited and gates provider save symmetrically on win32', () => {
  /* Windows 无 POSIX 安全落盘：视图层带 platformLimited 供渲染端区分文案（不再误导
   * 「检查权限或重启」），save 分支与 models 分支同款早退门 */
  assert.match(injectSource, /platformLimited: process\.platform === "win32"/);
  const gate = injectSource.indexOf('if (req.action !== "enhance-provider-save"');
  assert.ok(gate > 0, 'save branch anchor');
  const seg = injectSource.slice(gate, gate + 300);
  assert.match(seg, /process\.platform === "win32"\) \{ reply\(\{ ok: false, error: "unsupported platform" \}\); return; \}/, 'save gate mirrors models branch');
  assert.match(source, /ep\.platformLimited/, 'renderer consumes the platform flag for the status copy');
});
