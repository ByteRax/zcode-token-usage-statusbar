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
  assert.match(source, /b\.addEventListener\("mouseenter", function \(\) \{ var bT = this; zuChipHoverArm\(bT, function \(\) \{ showEnhanceTip\(bT\); \}\); \}\)/);   // v440 悬停 tooltip（悬停门槛包门）
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
const INPUT_SEL = '[data-testid="v4-composer-input"]';
const CONTENTEDITABLE_SEL = '[contenteditable="true"]';
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
    if (sel === INPUT_SEL || sel === CONTENTEDITABLE_SEL) {   // issue #477：卡内选框的后代枚举——先序深度优先，与真实 DOM 文档序一致；两种输入框选择器写法都认
      const byTestid = sel === INPUT_SEL;
      const matches = c => c.getAttribute && (byTestid ? c.getAttribute('data-testid') === 'v4-composer-input' : c.getAttribute('contenteditable') === 'true');
      const out = [];
      for (const c of this.children) {
        if (matches(c)) out.push(c);
        if (c.querySelectorAll) out.push(...c.querySelectorAll(sel));
      }
      return out;
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
  const isInputSelector = selector => selector.includes('v4-composer-input') || selector.includes('contenteditable');   // issue #477：输入框选择器不论写法
  const document = new Element();
  Object.assign(document, { body, documentElement: root, createElement: tag => new Element(tag),
    getElementById: id => body.children.find(e => e.id === id),
    querySelectorAll: selector => (selector.startsWith('textarea,') || isInputSelector(selector)) ? panes : [],
    /* issue #477：页面级单节点查找也要能命中输入框——否则「只在卡内选框」的回归锁对
     * document.querySelector 形态的页面级兜底失效（第 2 轮变异审查实证） */
    querySelector: selector => isInputSelector(selector) ? (panes[0] || null) : Element.prototype.querySelector.call(document, selector),
    elementFromPoint: () => panes[0] || body });
  const timers = new Map(), frames = new Map(), observers = []; let id = 0;
  const lsStore = new Map();
  lsStore.set('zcode-v4-last-session:v1:ws', 'sid_main');   // pickCurrent 的宿主「工作区最后会话」记录（键名正则 ^zcode-v4-last-session:）
  lsStore.set('zusage3.tipHoverMs', '0');   // v440：门槛关直通（本文件测开门后行为；门槛链由 overlay-tip-activation 锁）
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
    editor.setAttribute('contenteditable', 'true');   // 真实 Lexical 根节点带 contenteditable
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
  return { window, body, inject, boot, tick, buildComposer, payload, takeRequests, respond, enhOf, coordAttach, lsStore, timers, candidates: panes, document };
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

/* ---------- issue #477：本卡内选框 + 读取失败分流（v472） ----------
 * 报告：输入框里有可见文字，点增强却提示「先输入内容再增强」。旧实现只取卡内第一个输入节点，
 * 且「找不到节点 / 桥未就绪 / 读取抛错 / 桥读空 / 真空草稿」并成同一句提示。
 * 选框只在卡内进行：首轮审查用夹具实证过「按几何就近取页面内输入框」会读写相邻分栏的草稿；
 * 相邻分栏的输入框必须真挂进文档树，页面级查找才找得到它（第 2 轮变异审查实证）。 */
const ZERO_RECT = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
const FLAT_NO_HEIGHT = { top: 600, bottom: 600, left: 20, right: 520, width: 500, height: 0 };   // 有宽无高：扁平节点按隐藏处理
const FLAT_NO_WIDTH = { top: 600, bottom: 650, left: 20, right: 20, width: 0, height: 50 };     // 有高无宽
const SAME_AS_BUTTON = { top: 600, bottom: 650, left: 20, right: 520, width: 500, height: 50 };   // 夹具默认矩形：与增强按钮同位
function mkInput(draft, rect) {   // 候选输入节点：桥就绪、几何可控
  const el = new Element();
  el.setAttribute('data-testid', 'v4-composer-input');
  el.setAttribute('contenteditable', 'true');   // 真实 Lexical 根节点带 contenteditable
  el.setAttribute('data-e2e-lexical-bridge', 'ready');
  el.__zcodeLexicalInputE2E = {
    getText: () => el.__zuDraft,
    setText: t => { el.__zuDraft = String(t); el.setTextCalls = (el.setTextCalls || 0) + 1; },
  };
  el.__zuDraft = draft;
  el.getBoundingClientRect = () => ({ ...rect });
  return el;
}
function mountEnh(h, ui) {   // 建实例到按钮就绪（不点击）；用例随后再制造故障现场
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  assert.ok(enh, 'enhance button should mount');
  return enh;
}
const ENH_PROVIDER = { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX' };
const enhanceRequests = h => h.takeRequests().filter(r => r.action === 'prompt-enhance');
const clickButton = enh => enh.listeners.get('click')[0]();
/* 把实例绑定的输入框挪出卡片（仍留在页面里）：此后卡内候选不再含 composer，用例据此锁定②④的次序 */
const moveOwnInputOutOfCard = ui => { ui.editor.remove(); ui.pane.appendChild(ui.editor); };
/* 把候选输入框挂进文档树，做成相邻分栏的样子：页面级查找（不论写法）都找得到它 */
function mountNeighbourPane(h, el) {
  const pane = h.body.appendChild(new Element());
  pane.setAttribute('data-pane-id', 'workspace-right');
  pane.setAttribute('data-session-id', 'sid_right');
  pane.appendChild(el);
  h.candidates.push(el);
}

test('issue477: the visible bound composer wins over an earlier leftover in the same card, hidden or visible', () => {
  for (const [name, rect] of Object.entries({ 'hidden leftover': ZERO_RECT, 'visible leftover': SAME_AS_BUTTON })) {
    const h = harness();
    const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '本卡草稿' });
    const enh = mountEnh(h, ui);
    const stale = mkInput('', rect);   // 卡内更靠前的残留节点：隐藏的空编辑器 / 可见的空编辑器
    ui.card.insertBefore(stale, ui.editor);
    clickButton(enh);
    const reqs = enhanceRequests(h);
    assert.equal(reqs.length, 1, name + ': ' + enh.getAttribute('aria-label'));
    assert.equal(reqs[0].text, '本卡草稿', name);
    h.respond(reqs[0].requestId, { ok: true, text: '增强结果' });
    assert.equal(ui.editor.__zuDraft, '增强结果', name + ': write-back lands on the bound node');
    assert.equal(stale.setTextCalls || 0, 0, name);
    assert.equal(enh.getAttribute('aria-label'), '增强提示词', name);   // 回填链在选中节点上闭环
  }
});

test('issue477: a folded bound input keeps its draft ahead of hidden leftovers', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '本卡草稿' });
  const enh = mountEnh(h, ui);
  ui.editor.getBoundingClientRect = () => ({ ...ZERO_RECT });   // 绑定输入框被折叠：隐藏但草稿仍在
  const stale = mkInput('', ZERO_RECT);   // 卡内更靠前的隐藏残留节点（空编辑器）
  ui.card.insertBefore(stale, ui.editor);
  clickButton(enh);
  const reqs = enhanceRequests(h);
  assert.equal(reqs.length, 1, enh.getAttribute('aria-label'));
  assert.equal(reqs[0].text, '本卡草稿');
  h.respond(reqs[0].requestId, { ok: true, text: '增强结果' });
  assert.equal(ui.editor.__zuDraft, '增强结果', 'write-back lands on the bound node');
  assert.equal(stale.setTextCalls || 0, 0, 'the leftover node is never written');
  assert.equal(enh.getAttribute('aria-label'), '增强提示词');
});

test('issue477: right after a layout switch the folded empty bound input yields to the visible new input', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '' });
  const enh = mountEnh(h, ui);
  ui.editor.getBoundingClientRect = () => ({ ...ZERO_RECT });   // 旧输入框已折叠且为空（协调器重绑前的窗口）
  const fresh = mkInput('新输入框的草稿', SAME_AS_BUTTON);      // 新输入框已可见
  ui.card.appendChild(fresh);
  clickButton(enh);
  const reqs = enhanceRequests(h);
  assert.equal(reqs.length, 1, enh.getAttribute('aria-label'));   // 不再提示「先输入内容再增强」
  assert.equal(reqs[0].text, '新输入框的草稿');
  h.respond(reqs[0].requestId, { ok: true, text: '增强结果' });
  assert.equal(fresh.__zuDraft, '增强结果');
  assert.equal(ui.editor.setTextCalls || 0, 0, 'the folded old input is never written');
  assert.equal(enh.getAttribute('aria-label'), '增强提示词');
});

test('issue477: with the bound input gone from the card the first visible node in the card is used, hidden nodes skipped', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '' });
  const enh = mountEnh(h, ui);
  moveOwnInputOutOfCard(ui);
  const hidden = mkInput('', ZERO_RECT);            // 更靠前的隐藏节点：不选
  const first = mkInput('首份草稿', SAME_AS_BUTTON);   // 期望命中：文档序首个可见节点，且是卡的孙节点
  const second = mkInput('末份草稿', SAME_AS_BUTTON);  // 文档序靠后的可见节点：不选
  const wrapper = ui.card.appendChild(new Element());
  wrapper.appendChild(first);
  ui.card.insertBefore(hidden, wrapper);
  ui.card.appendChild(second);
  clickButton(enh);
  const reqs = enhanceRequests(h);
  assert.equal(reqs.length, 1, enh.getAttribute('aria-label'));
  assert.equal(reqs[0].text, '首份草稿');
  h.respond(reqs[0].requestId, { ok: true, text: '增强结果' });
  assert.equal(first.__zuDraft, '增强结果', 'write-back lands on the selected node');
  assert.equal(second.__zuDraft, '末份草稿');
  assert.equal(enh.getAttribute('aria-label'), '增强提示词');
});

test('issue477: a flat node (width or height zero) counts as hidden', () => {
  for (const [name, rect] of Object.entries({ 'no height': FLAT_NO_HEIGHT, 'no width': FLAT_NO_WIDTH })) {
    const h = harness();
    const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '' });
    const enh = mountEnh(h, ui);
    moveOwnInputOutOfCard(ui);
    const flat = mkInput('', rect);   // 扁平节点排在前面：有宽无高 / 有高无宽
    const live = mkInput('可见草稿', SAME_AS_BUTTON);
    ui.card.appendChild(flat);
    ui.card.appendChild(live);
    clickButton(enh);
    const reqs = enhanceRequests(h);
    assert.equal(reqs.length, 1, name + ': ' + enh.getAttribute('aria-label'));
    assert.equal(reqs[0].text, '可见草稿', name);
    assert.equal(flat.setTextCalls || 0, 0, name);
  }
});

test('issue477: hidden in-card inputs keep ownership over a visible input in the neighbouring pane; document order picks the first', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '' });
  const enh = mountEnh(h, ui);
  moveOwnInputOutOfCard(ui);
  const own = mkInput('本卡草稿', ZERO_RECT);   // 卡内只剩隐藏节点（编辑器被按设计折叠）
  const later = mkInput('另一份', ZERO_RECT);
  ui.card.appendChild(own);
  ui.card.appendChild(later);
  const elsewhere = mkInput('别处的草稿', SAME_AS_BUTTON);   // 与按钮同位：几何上最近
  mountNeighbourPane(h, elsewhere);
  assert.equal(h.document.querySelectorAll(INPUT_SEL).filter(e => e === elsewhere).length, 1, 'page enumeration must see the neighbour');
  clickButton(enh);
  const reqs = enhanceRequests(h);
  assert.equal(reqs.length, 1, enh.getAttribute('aria-label'));
  assert.equal(reqs[0].text, '本卡草稿');
  h.respond(reqs[0].requestId, { ok: true, text: '增强结果' });
  assert.equal(own.__zuDraft, '增强结果');
  assert.equal(later.__zuDraft, '另一份');
  assert.equal(elsewhere.__zuDraft, '别处的草稿', 'another pane draft is never touched');
});

test('issue477: no input inside the card never reads or writes a visible input in the neighbouring pane', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '' });
  const enh = mountEnh(h, ui);
  ui.editor.remove();
  h.candidates.splice(h.candidates.indexOf(ui.editor), 1);   // 本卡、本窗格都没有输入节点
  const elsewhere = mkInput('别栏草稿', SAME_AS_BUTTON);   // 相邻分栏的输入框：与按钮几何同位，离得最近
  mountNeighbourPane(h, elsewhere);
  assert.equal(h.document.querySelectorAll(INPUT_SEL).filter(e => e === elsewhere).length, 1, 'page enumeration must see the neighbour');
  assert.equal(h.document.querySelector(INPUT_SEL), elsewhere, 'page-level single lookup must see the neighbour');
  assert.equal(h.document.querySelector('[data-testid=v4-composer-input]'), elsewhere, 'unquoted attribute selector must resolve');
  assert.equal(h.document.querySelector('[contenteditable="true"]'), elsewhere, 'contenteditable lookup must see the neighbour');
  assert.equal(h.body.querySelector(INPUT_SEL), elsewhere, 'tree-scoped lookup must see the neighbour');
  clickButton(enh);
  assert.equal(enhanceRequests(h).length, 0);
  assert.match(enh.getAttribute('aria-label'), /未找到当前输入框/);
  assert.equal(enh.getAttribute('aria-busy'), 'false');
  assert.equal(elsewhere.setTextCalls || 0, 0, 'another pane draft is never written');
  assert.equal(elsewhere.__zuDraft, '别栏草稿');
});

test('issue477: a detached card cache reports "not found" instead of using its stale nodes', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '陈旧草稿' });
  const enh = mountEnh(h, ui);
  ui.card.isConnected = false;   // 卡片缓存已 detach（输入节点仍挂在缓存节点下）
  clickButton(enh);
  assert.equal(enhanceRequests(h).length, 0);
  assert.match(enh.getAttribute('aria-label'), /未找到当前输入框/);
  assert.equal(ui.editor.setTextCalls || 0, 0);
});

test('issue477: no input node anywhere reports the real reason, not "type a prompt"', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '草稿' });
  const enh = mountEnh(h, ui);
  ui.editor.remove();
  h.candidates.splice(h.candidates.indexOf(ui.editor), 1);
  clickButton(enh);
  assert.equal(enhanceRequests(h).length, 0);
  assert.match(enh.getAttribute('aria-label'), /未找到当前输入框/);
  assert.equal(enh.getAttribute('aria-busy'), 'false');
});

test('issue477: an input without a ready bridge reports "not readable", not "type a prompt"', () => {
  const strips = {
    'bridge attribute missing': ed => ed.removeAttribute('data-e2e-lexical-bridge'),
    'bridge object removed': ed => { delete ed.__zcodeLexicalInputE2E; },   // 宿主桥被别的编辑器摘除后的现场
  };
  for (const [name, strip] of Object.entries(strips)) {
    const h = harness();
    const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '看得见的草稿' });
    const enh = mountEnh(h, ui);
    strip(ui.editor);
    clickButton(enh);
    assert.equal(enhanceRequests(h).length, 0, name);
    assert.match(enh.getAttribute('aria-label'), /输入框暂不可读/, name);
    assert.doesNotMatch(enh.getAttribute('aria-label'), /先输入内容/, name);
    assert.equal(ui.editor.__zuDraft, '看得见的草稿', name);
  }
});

test('issue477: a throwing getText reports a read failure and sends nothing', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '草稿' });
  const enh = mountEnh(h, ui);
  ui.editor.__zcodeLexicalInputE2E.getText = () => { throw new Error('editor detached'); };
  clickButton(enh);
  assert.equal(enhanceRequests(h).length, 0);
  assert.match(enh.getAttribute('aria-label'), /读取草稿失败/);
});

test('issue477: bridge reads empty while the input visibly has text — unreadable draft, not "type a prompt"', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '' });
  const enh = mountEnh(h, ui);
  ui.editor.textContent = '看得见的草稿';   // 桥读到别的（空）编辑器，本节点 DOM 仍有文字
  clickButton(enh);
  assert.equal(enhanceRequests(h).length, 0);
  assert.match(enh.getAttribute('aria-label'), /未能读取输入框里的草稿/);
  assert.match(enh.getAttribute('aria-label'), /重启/);
  assert.doesNotMatch(enh.getAttribute('aria-label'), /先输入内容/);
  assert.equal(ui.editor.setTextCalls || 0, 0);
});

test('issue477: a genuinely empty draft keeps the original "type a prompt" wording', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '' });
  const enh = mountEnh(h, ui);
  ui.editor.textContent = ' \n';   // 只有空白：与空草稿等价
  clickButton(enh);
  assert.equal(enhanceRequests(h).length, 0);
  assert.match(enh.getAttribute('aria-label'), /先输入内容再增强/);
});

/* 回包路径：在途期间输入框变得读不了，回包不写入并如实提示，不说成草稿变了 */
const replyNotApplied = {
  'bridge removed mid-flight': ui => ui.editor.removeAttribute('data-e2e-lexical-bridge'),
  'bridge throws on read mid-flight': ui => { ui.editor.__zcodeLexicalInputE2E.getText = () => { throw new Error('editor detached'); }; },
  'bound input left the card mid-flight': ui => moveOwnInputOutOfCard(ui),
};
for (const [name, breakIt] of Object.entries(replyNotApplied)) {
  test(`issue477: a reply arriving after the input became unreadable is not applied — ${name}`, () => {
    const h = harness();
    const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '原草稿' });
    const enh = mountEnh(h, ui);
    clickButton(enh);
    const req = enhanceRequests(h)[0];
    assert.ok(req, 'request was fired before the input broke');
    breakIt(ui);
    h.respond(req.requestId, { ok: true, text: '增强结果' });
    assert.equal(ui.editor.__zuDraft, '原草稿', name);
    assert.equal(ui.editor.setTextCalls || 0, 0, name);
    assert.match(enh.getAttribute('aria-label'), /输入框暂不可读，本次结果未应用/, name);
    assert.doesNotMatch(enh.getAttribute('aria-label'), /草稿已变化/, name);
    assert.equal(enh.getAttribute('aria-busy'), 'false', name);
  });
}

test('issue477: after the bound input is back in the card a new click issues a fresh request', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '原草稿' });
  const enh = mountEnh(h, ui);
  clickButton(enh);
  const first = enhanceRequests(h)[0];
  moveOwnInputOutOfCard(ui);
  h.respond(first.requestId, { ok: true, text: '增强结果' });
  assert.equal(ui.editor.setTextCalls || 0, 0);
  ui.card.appendChild(ui.editor);   // 输入框回到卡内
  clickButton(enh);
  const second = enhanceRequests(h)[0];
  assert.ok(second, 'a fresh request is issued once the input is readable again');
  assert.equal(second.text, '原草稿');
});

/* ---------- issue #501：输入桥记忆与归属凭证（v480） ----------
 * 报告：v1.5.24 上输入框有可见文字，点增强提示「输入框暂不可读」——节点找到了，桥没了。
 * 宿主 4.0.0 渲染包（styles-*.js）静态核实：Lexical registerRootListener 注销时回调 (null, 当前根)，
 * E2ELexicalInputBridgePlugin 的 effect 清理因此先把自己的桥挂到「页面首个输入框」再删掉——卸载任一
 * 编辑器都会误伤幸存的那一个（编辑器还活着、文字还在，桥对象与 ready 标记都没了）。
 * 下面两个夹具逐句复刻这两段宿主逻辑，用来在测试里确定性制造报告现场。 */
/* Lexical 编辑器替身：registerRootListener 的回调约定与 4.0.0 包内实现一致 */
function mkLexicalEditor(rootEl) {
  const rootListeners = new Set();
  const editor = {
    root: rootEl, state: {}, draft: '', setTextCalls: 0,
    getRootElement: () => editor.root,
    getEditorState: () => editor.state,
    registerRootListener(listener) {
      rootListeners.add(listener);
      listener(editor.root, null);   // 注册即回调一次 (root, null)
      return () => { rootListeners.delete(listener); listener(null, editor.root); };   // 注销回调 (null, 当前根)
    },
  };
  return editor;
}
/* E2ELexicalInputBridgePlugin 的 effect 体复刻；返回值即 effect 的清理函数 */
function hostMountBridge(editor, doc) {
  const inputTestId = 'v4-composer-input';
  const bridge = {
    getEditorState: () => editor.getEditorState(),
    getText: () => editor.draft,
    setText: t => { editor.draft = String(t); editor.setTextCalls += 1; },
  };
  let attachedInput = null;
  const detachBridge = input => {
    if (input && input.__zcodeLexicalInputE2E === bridge) delete input.__zcodeLexicalInputE2E;
    if (input) input.removeAttribute('data-e2e-lexical-bridge');
  };
  const attachBridge = input => {
    if (attachedInput && attachedInput !== input) detachBridge(attachedInput);
    attachedInput = input;
    if (input) {
      Object.defineProperty(input, '__zcodeLexicalInputE2E', { configurable: true, value: bridge });
      input.setAttribute('data-e2e-lexical-bridge', 'ready');
    }
  };
  const resolveInput = root => (root && root.getAttribute('data-testid') === inputTestId ? root : doc.querySelector(`[data-testid="${inputTestId}"]`));
  const unregisterRoot = editor.registerRootListener((root, prev) => { if (prev !== root) detachBridge(prev); attachBridge(resolveInput(root)); });
  return () => { unregisterRoot(); detachBridge(attachedInput); };
}
/* React fiber 替身：输入节点的 fiber 链上溯到 LexicalComposer 的 context Provider（真机 4.0.0 实测第 5 层），
 * memoizedProps.value = [editor, config] */
function attachComposerFiber(inputEl, editor, { hops = 5, config = { getTheme() {} } } = {}) {
  let f = { memoizedProps: { value: [editor, config] }, return: null };
  for (let i = 0; i < hops; i++) f = { memoizedProps: {}, return: f };
  inputEl.__reactFiber$fixture = f;
  return f;
}
/* 把夹具里的主输入框换成「宿主挂好桥的 Lexical 编辑器」：lex.draft 即草稿 */
function ownLexInput(h, ui, draft) {
  const lex = mkLexicalEditor(ui.editor);
  hostMountBridge(lex, h.document);
  attachComposerFiber(ui.editor, lex);
  lex.draft = draft; ui.editor.textContent = draft;
  return lex;
}
/* 再开一个共用 testid 的编辑器（相邻分栏）。close() = 节点先离开文档，再跑宿主 effect 清理（React 先摘 DOM、后跑 passive 清理） */
function openSecondEditor(h, draft) {
  const ui = h.buildComposer('workspace-right', 'sid_right', { ...ENH_PROVIDER, draft: '' });
  const lex = mkLexicalEditor(ui.editor);
  const cleanup = hostMountBridge(lex, h.document);
  attachComposerFiber(ui.editor, lex);
  lex.draft = draft; ui.editor.textContent = draft;
  return { ui, lex, close() { ui.pane.remove(); h.candidates.splice(h.candidates.indexOf(ui.editor), 1); cleanup(); } };
}
/* 宿主清理过后的现场：桥对象与 ready 标记都没了，节点和编辑器都还在 */
const stripBridge = el => { delete el.__zcodeLexicalInputE2E; el.removeAttribute('data-e2e-lexical-bridge'); };
const bridgeGone = (el, name) => {
  assert.equal(el.getAttribute('data-e2e-lexical-bridge'), null, name + ': ready marker is gone');
  assert.equal(el.__zcodeLexicalInputE2E, undefined, name + ': bridge object is gone');
};

/* 夹具自证（与插件无关）：钉住对宿主清理的复刻——关掉任一编辑器，幸存输入框的桥与标记都被摘掉，
 * 它的编辑器却仍以它为根。两个方向都验：宿主回退查找取的是页面首个输入框，谁靠前谁被波及。 */
test('issue501 fixture: the host cleanup of one editor strips the surviving input\'s bridge and marker while its editor stays rooted there', () => {
  for (const [name, closing] of Object.entries({ 'closing the later editor': 'b', 'closing the earlier editor': 'a' })) {
    const h = harness();
    const build = pid => {
      const ui = h.buildComposer(pid, 'sid_' + pid, { ...ENH_PROVIDER, draft: '' });
      const lex = mkLexicalEditor(ui.editor);
      return { ui, lex, cleanup: hostMountBridge(lex, h.document) };
    };
    const w = { a: build('workspace-main'), b: build('workspace-right') };
    const survivor = w[closing === 'a' ? 'b' : 'a'];
    assert.equal(survivor.ui.editor.getAttribute('data-e2e-lexical-bridge'), 'ready', name + ': control — ready before the other editor closes');
    w[closing].ui.pane.remove(); h.candidates.splice(h.candidates.indexOf(w[closing].ui.editor), 1);
    w[closing].cleanup();
    bridgeGone(survivor.ui.editor, name);
    assert.equal(survivor.lex.getRootElement(), survivor.ui.editor, name + ': the surviving editor is still rooted at its input');
  }
});

/* 主场景（3m/3n）：从未点击过增强，只靠按钮对账点见过就绪；别栏关闭后本卡桥被摘，点击仍读本卡草稿并写回本卡 */
test('issue501: after another editor\'s cleanup strips the surviving input\'s bridge, enhance still reads and writes its own draft', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '' });
  const lex = ownLexInput(h, ui, '幸存输入框的草稿');
  const enh = mountEnh(h, ui);
  const other = openSecondEditor(h, '被关闭一侧的草稿');
  other.close();
  bridgeGone(ui.editor, 'closing the other editor');
  clickButton(enh);
  const reqs = enhanceRequests(h);
  assert.equal(reqs.length, 1, enh.getAttribute('aria-label'));
  assert.equal(reqs[0].text, '幸存输入框的草稿');
  h.respond(reqs[0].requestId, { ok: true, text: '增强结果' });
  assert.equal(lex.draft, '增强结果', 'write-back lands on the surviving input');
  assert.equal(lex.setTextCalls, 1);
  assert.equal(other.lex.setTextCalls, 0, 'the closed editor is never written');
  assert.equal(other.lex.draft, '被关闭一侧的草稿');
  assert.equal(enh.getAttribute('aria-label'), '增强提示词');
});

/* 记忆是页面级的：桥先丢、随后浮层热更换代，新代从未见过这个输入框就绪也照样找回 */
test('issue501: the remembered bridge survives an overlay re-inject — a new generation recovers a bridge lost before it loaded', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '' });
  const lex = ownLexInput(h, ui, '本卡草稿');
  mountEnh(h, ui);   // 旧代见过就绪
  stripBridge(ui.editor);   // 桥先丢
  h.inject();   // 再热更：新代从未见过它就绪
  h.boot();
  h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  clickButton(enh);
  const reqs = enhanceRequests(h);
  assert.equal(reqs.length, 1, enh.getAttribute('aria-label'));
  assert.equal(reqs[0].text, '本卡草稿');
  h.respond(reqs[0].requestId, { ok: true, text: '增强结果' });
  assert.equal(lex.draft, '增强结果');
});

/* 凭证不成立不找回（3o）：找不到 fiber / 编辑器根不在本节点 / 节点已被另一个编辑器复用 */
test('issue501: recovery requires the ownership proof — no fiber, an editor rooted elsewhere, or a bridge left by the node\'s previous editor', () => {
  const cases = {
    'no fiber on the node': (h, ui, lex) => { delete ui.editor.__reactFiber$fixture; },
    'composer editor is rooted at another node': (h, ui, lex) => { lex.root = new Element(); },
    'node reused by a new editor after the bridge was lost': (h, ui, lex) => {
      stripBridge(ui.editor);
      const next = mkLexicalEditor(ui.editor);   // 同一节点换了编辑器，它的桥还没挂上
      attachComposerFiber(ui.editor, next);
      next.draft = '新编辑器的草稿';
    },
  };
  for (const [name, breakProof] of Object.entries(cases)) {
    const h = harness();
    const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '' });
    const lex = ownLexInput(h, ui, '本卡草稿');
    const enh = mountEnh(h, ui);
    breakProof(h, ui, lex);
    stripBridge(ui.editor);
    clickButton(enh);
    assert.equal(enhanceRequests(h).length, 0, name + ': ' + enh.getAttribute('aria-label'));
    assert.match(enh.getAttribute('aria-label'), /输入框暂不可读/, name);
    assert.equal(lex.setTextCalls, 0, name);
    assert.equal(lex.draft, '本卡草稿', name);
  }
});

/* 凭证的查找细节：只认 LexicalComposer 的 context（value=[editor, config]，editor 有 getRootElement/
 * getEditorState、config 有 getTheme，缺一不可），链上更靠内的其它 Provider 一路跳过；旧版 React 的
 * __reactInternalInstance$ 键名同样认 */
test('issue501: only the Lexical composer context counts — providers nearer the input are skipped, and the legacy fiber key works', () => {
  const decoys = {
    'plain object value': { memoizedProps: { value: { theme: 'x' } } },
    'array without an editor': { memoizedProps: { value: [{}, {}] } },
    'editor without composer config': { memoizedProps: { value: [{ getRootElement() {}, getEditorState() {} }, {}] } },
    'legacy fiber key': null,
  };
  for (const [name, decoy] of Object.entries(decoys)) {
    const h = harness();
    const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '' });
    const lex = ownLexInput(h, ui, '本卡草稿');
    if (decoy) { decoy.return = ui.editor.__reactFiber$fixture; ui.editor.__reactFiber$fixture = decoy; }   // 诱饵夹在输入节点与真正的 composer Provider 之间
    else { ui.editor.__reactInternalInstance$fixture = ui.editor.__reactFiber$fixture; delete ui.editor.__reactFiber$fixture; }
    const enh = mountEnh(h, ui);
    stripBridge(ui.editor);
    clickButton(enh);
    const reqs = enhanceRequests(h);
    assert.equal(reqs.length, 1, name + ': ' + enh.getAttribute('aria-label'));
    assert.equal(reqs[0].text, '本卡草稿', name);
    h.respond(reqs[0].requestId, { ok: true, text: '增强结果' });
    assert.equal(lex.draft, '增强结果', name);
  }
});

test('issue501: a fiber chain with no Lexical composer context is undecidable — the ready bridge is used but nothing is remembered', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '' });
  const lex = ownLexInput(h, ui, '本卡草稿');
  ui.editor.__reactFiber$fixture = { memoizedProps: { value: [{ getRootElement() {}, getEditorState() {} }, {}] }, return: null };   // 像编辑器，但不是 composer context
  const enh = mountEnh(h, ui);
  clickButton(enh);
  const req = enhanceRequests(h)[0];
  assert.ok(req, 'the ready bridge is still used — ' + enh.getAttribute('aria-label'));
  h.respond(req.requestId, { ok: true, text: '增强结果' });
  stripBridge(ui.editor);
  clickButton(enh);
  assert.equal(enhanceRequests(h).length, 0, 'nothing was remembered');
  assert.match(enh.getAttribute('aria-label'), /输入框暂不可读/);
});

/* 宿主对象在核对凭证时抛错（编辑器刚被销毁之类）：按无从判定处理，对账点不抛，节点上就绪的桥照用 */
test('issue501: a host object throwing during the ownership check is treated as undecidable, not as an error', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '' });
  const lex = ownLexInput(h, ui, '本卡草稿');
  const enh = mountEnh(h, ui);
  lex.getEditorState = () => { throw new Error('editor torn down'); };   // fiber 上找得到编辑器，但它的状态读不了
  assert.doesNotThrow(() => h.tick());
  clickButton(enh);
  const req = enhanceRequests(h)[0];
  assert.ok(req, 'the ready bridge is still used — ' + enh.getAttribute('aria-label'));
  assert.equal(req.text, '本卡草稿');
});

/* 写回后的 0ms 校验认桥的身份：setText 之后节点上的桥换成了别的对象（节点被新编辑器复用、宿主挂上了
 * 它自己的新桥），校验要报「写回输入框失败或草稿已变化」，不能因为新桥读回的文本恰好相同就假成功 */
test('issue501: a bridge swapped between setText and the commit check fails the write-back instead of reporting success', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '' });
  const lex = ownLexInput(h, ui, '原草稿');
  const enh = mountEnh(h, ui);
  stripBridge(ui.editor);   // 本次增强走取回的桥
  clickButton(enh);
  const req = enhanceRequests(h)[0];
  assert.ok(req, 'request fired via the recalled bridge');
  h.window.__zusagePluginResult(Object.assign({ id: req.requestId }, { ok: true, text: '增强结果' }));   // 只跑回包回调：setText 已写，0ms 校验还没跑
  assert.equal(lex.draft, '增强结果', 'setText went through the recalled bridge');
  const next = mkLexicalEditor(ui.editor);   // 节点被新编辑器复用
  attachComposerFiber(ui.editor, next);
  hostMountBridge(next, h.document);   // 宿主给新编辑器挂上了它自己的新桥
  next.draft = '增强结果';   // 新桥读回的文本与结果相同：只有身份校验能识破
  runPending(h.timers, 0);
  assert.match(enh.getAttribute('aria-label'), /写回输入框失败或草稿已变化/);
  assert.equal(lex.setTextCalls, 1);
});

/* 判明是别栏的桥（3p）：宿主回退错绑把别栏编辑器的桥挂到本卡输入框上。没记住过本节点自己的桥时不读、不发、
 * 不写，提示与桥未就绪相同，也不记住它——之后桥被摘也不找回 */
test('issue501: a live bridge proven to belong to another editor is refused — no request, nothing read or sent, and it is never remembered', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '' });
  ownLexInput(h, ui, '本卡草稿');
  stripBridge(ui.editor);   // 本卡输入框在插件加载时就已没有自己的桥：没有东西可记
  const enh = mountEnh(h, ui);
  const other = openSecondEditor(h, '别栏草稿');
  Object.defineProperty(ui.editor, '__zcodeLexicalInputE2E', { configurable: true, value: other.ui.editor.__zcodeLexicalInputE2E });   // 错绑现场：节点上被挂上别栏的桥
  ui.editor.setAttribute('data-e2e-lexical-bridge', 'ready');   // 宿主挂桥时 ready 标记一并写上
  h.tick();   // 对账点在这一拍见过它
  clickButton(enh);
  assert.equal(enhanceRequests(h).length, 0, enh.getAttribute('aria-label'));
  assert.match(enh.getAttribute('aria-label'), /输入框暂不可读/);
  assert.equal(other.lex.setTextCalls, 0, 'the other editor is never written');
  stripBridge(ui.editor);
  clickButton(enh);
  assert.equal(enhanceRequests(h).length, 0, 'a foreign bridge is never remembered for later recovery');
  assert.match(enh.getAttribute('aria-label'), /输入框暂不可读/);
});

/* 同一现场的另一面：本节点自己的桥此前记住过——别栏的桥压上来之后点击，改用记住的那个，读写的仍是本卡草稿 */
test('issue501: with a foreign bridge squatting on the input, the remembered own bridge is used instead — the other editor is never read or written', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '' });
  const lex = ownLexInput(h, ui, '本卡草稿');
  const enh = mountEnh(h, ui);   // 记住了本卡自己的桥
  const other = openSecondEditor(h, '别栏草稿');
  Object.defineProperty(ui.editor, '__zcodeLexicalInputE2E', { configurable: true, value: other.ui.editor.__zcodeLexicalInputE2E });
  h.tick();
  clickButton(enh);
  const reqs = enhanceRequests(h);
  assert.equal(reqs.length, 1, enh.getAttribute('aria-label'));
  assert.equal(reqs[0].text, '本卡草稿', "the draft sent is this input's own, never the other editor's");
  h.respond(reqs[0].requestId, { ok: true, text: '增强结果' });
  assert.equal(lex.draft, '增强结果');
  assert.equal(other.lex.draft, '别栏草稿');
  assert.equal(other.lex.setTextCalls, 0, 'the other editor is never written');
  assert.equal(enh.getAttribute('aria-label'), '增强提示词');
});

/* 无从判定（3q）：节点上就绪的桥照用（v472 以前口径不变），但不记住——桥丢了不找回 */
test('issue501: when ownership cannot be decided the ready bridge is still used, but nothing is remembered', () => {
  const cases = {
    'no fiber on the node': (h, ui, lex) => { delete ui.editor.__reactFiber$fixture; },
    'composer editor is rooted at another node': (h, ui, lex) => { lex.root = new Element(); },
    'bridge without getEditorState': (h, ui, lex) => { delete ui.editor.__zcodeLexicalInputE2E.getEditorState; },
  };
  for (const [name, makeUndecidable] of Object.entries(cases)) {
    const h = harness();
    const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '' });
    const lex = ownLexInput(h, ui, '本卡草稿');
    const enh = mountEnh(h, ui);
    makeUndecidable(h, ui, lex);
    clickButton(enh);
    const req = enhanceRequests(h)[0];
    assert.ok(req, name + ': the ready bridge is still used — ' + enh.getAttribute('aria-label'));
    assert.equal(req.text, '本卡草稿', name);
    h.respond(req.requestId, { ok: true, text: '增强结果' });
    assert.equal(lex.draft, '增强结果', name);
    stripBridge(ui.editor);
    clickButton(enh);
    assert.equal(enhanceRequests(h).length, 0, name + ': nothing was remembered, so there is nothing to recover');
    assert.match(enh.getAttribute('aria-label'), /输入框暂不可读/, name);
  }
});

/* 在途时桥被摘（3r）：回包按凭证取回，草稿比对照常，结果写回同一节点 */
test('issue501: a bridge lost while a request is in flight is recovered for the write-back when the proof holds', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { ...ENH_PROVIDER, draft: '' });
  const lex = ownLexInput(h, ui, '原草稿');
  const enh = mountEnh(h, ui);
  clickButton(enh);
  const req = enhanceRequests(h)[0];
  assert.ok(req, 'request fired while the bridge was intact');
  stripBridge(ui.editor);
  h.respond(req.requestId, { ok: true, text: '增强结果' });
  assert.equal(lex.draft, '增强结果');
  assert.equal(lex.setTextCalls, 1);
  assert.equal(enh.getAttribute('aria-label'), '增强提示词');
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

test('team_auth surfaces the team-exchange copy with its failing step, not "plan unsupported" (issue #481)', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-team-coding-plan', model: 'GLM-5.4', draft: '草稿' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  const failWith = (receipt) => {
    enh.listeners.get('click')[0]();
    const req = h.takeRequests().find(r => r.action === 'prompt-enhance');
    h.respond(req.requestId, receipt);
    return enh.getAttribute('aria-label');
  };
  // 团队凭据换发在本地失败：不再误报「当前套餐暂不支持增强」，环节码本地化成第几步
  const missing = failWith({ ok: false, kind: 'team_auth', reason: 'keys_missing', error: 'team credential exchange failed (keys_missing)' });
  assert.match(missing, /增强失败：\s*团队凭据换发失败（第 2 步未找到团队密钥）$/);
  const unauthorized = failWith({ ok: false, kind: 'team_auth', reason: 'customer_http', status: 401, error: 'team credential exchange failed (customer_http, HTTP 401)' });
  assert.match(unauthorized, /增强失败：\s*团队凭据换发失败（第 1 步校验团队失败，HTTP 401）$/);
  const malformed = failWith({ ok: false, kind: 'team_auth', reason: 'pat_shape', error: 'team credential exchange failed (pat_shape)' });
  assert.match(malformed, /增强失败：\s*团队凭据换发失败（第 3 步响应异常）$/);
  for (const label of [missing, unauthorized, malformed]) {
    assert.doesNotMatch(label, /当前套餐暂不支持增强/);
    assert.doesNotMatch(label, /team credential exchange failed/);
  }
  // 环节码不在本地表内（主进程比渲染端新）：回落 error 短语，不留空白也不误报套餐不支持
  const fallback = failWith({ ok: false, kind: 'team_auth', reason: 'some_new_code', error: 'team credential exchange failed (some_new_code)' });
  assert.match(fallback, /增强失败：\s*team credential exchange failed \(some_new_code\)$/);
  // status 只认正整数：字符串或非正数不拼进文案
  assert.match(failWith({ ok: false, kind: 'team_auth', reason: 'keys_http', status: '500', error: 'team credential exchange failed (keys_http, HTTP 500)' }), /增强失败：\s*团队凭据换发失败（第 2 步读取团队密钥失败）$/);
  assert.match(failWith({ ok: false, kind: 'team_auth', reason: 'keys_http', status: -1, error: 'team credential exchange failed (keys_http, HTTP -1)' }), /增强失败：\s*团队凭据换发失败（第 2 步读取团队密钥失败）$/);
  // 原型链上的名字（constructor/toString）不算表内环节码
  const inherited = failWith({ ok: false, kind: 'team_auth', reason: 'constructor', error: 'team credential exchange failed (constructor)' });
  assert.match(inherited, /增强失败：\s*team credential exchange failed \(constructor\)$/);
});

test('the team_auth English copy names the same step and nature as the Chinese one for every reason code (issue #481)', () => {
  const h = harness();
  h.lsStore.set('zusage3.lang', 'en');   // L() 在注入时读 localStorage：先置英文再注入
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-team-coding-plan', model: 'GLM-5.4', draft: '草稿' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  const failWith = (receipt) => {
    enh.listeners.get('click')[0]();
    const req = h.takeRequests().find(r => r.action === 'prompt-enhance');
    h.respond(req.requestId, receipt);
    return enh.getAttribute('aria-label');
  };
  const expected = {
    token: 'login credential unavailable',
    selection: 'host is not on the team plan',
    customer_http: 'step 1 (verify team) failed, HTTP 503',
    customer_mismatch: 'step 1: selected team not found',
    customer_shape: 'step 1: unexpected response',
    keys_http: 'step 2 (list team keys) failed, HTTP 500',
    keys_missing: 'step 2: team key not found',
    keys_shape: 'step 2: unexpected response',
    pat_http: 'step 3 (issue team token) failed, HTTP 404',
    pat_shape: 'step 3: unexpected response',
    network: 'network request failed or timed out',
  };
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [reason, text] of Object.entries(expected)) {
    const status = /_http$/.test(reason) ? Number(text.slice(-3)) : 0;
    const label = failWith({ ok: false, kind: 'team_auth', reason, status: status || undefined, error: 'team credential exchange failed (' + reason + ')' });
    assert.match(label, new RegExp('Enhance failed:\\s*Team credential exchange failed \\(' + escape(text) + '\\)$'), reason);
  }
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

/* v468（issue #476）：用户点过增强按钮（焦点落在按钮上）再去点面板里的「设置」——mousedown 把焦点移到面板内
 * 按钮，按钮的 blur 若在此时收面板，click 就落到下方页面。无头 Chrome 真实指针三样式实证（修复前）：blur 后
 * 面板 display:none，mouseup/click 的目标变成 body，设置面板不打开。浏览器顺序固定为 mousedown→blur→mouseup→click，
 * 这里按同一顺序驱动监听器。 */
test('v468: button focused by a click → blur while the pointer is over the history panel keeps it open; settings click then opens the panel on the enhance section', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '   ' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  const tip = h.body.children.find(e => e.classList.contains('zusage-enhance-tip'));
  const settingsPanel = () => h.body.children.find(e => e.classList.contains('panel') && e.classList.contains('zu-settings'));
  enh.listeners.get('focus')[0].call(enh);   // 点击的 mousedown 阶段：按钮获得焦点，面板显示
  assert.equal(tip.style.display, 'flex');
  enh.listeners.get('click')[0]();   // 空草稿：警示相位（感叹号），不发请求
  assert.ok(enh.classList.contains('zu-ewarn'), 'button enters the warn (exclamation) phase');
  assert.equal(tip.style.display, 'flex', 'history panel stays open in the warn phase');
  // 指针停在面板上时按下「设置」：mousedown 先把焦点移走
  tip.matches = sel => sel === ':hover';   // 真实浏览器里指针停在面板上时 enhanceTip.matches(':hover') 为 true
  enh.listeners.get('blur')[0].call(enh, { relatedTarget: null });
  runPending(h.timers, 220);
  assert.equal(tip.style.display, 'flex', 'blur with the pointer over the panel keeps it open (not a delayed hide)');
  // click 到达面板的委托
  const setBtn = new Element('button');
  setBtn.setAttribute('data-ehset', '');
  setBtn.closest = sel => sel === 'button' ? setBtn : null;
  tip.listeners.get('click')[0]({ target: setBtn });
  assert.equal(tip.style.display, 'none', 'the settings entry hides the panel');
  assert.ok(settingsPanel() && settingsPanel().classList.contains('open'), 'settings panel opens');
  assert.equal(h.window.enhanceTest.state().settingsSec, 'enhance-provider', 'opens the enhance-provider section');
});

test('v468: blur while the pointer is not over the history panel still hides it (keyboard path)', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '草稿' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  const tip = h.body.children.find(e => e.classList.contains('zusage-enhance-tip'));
  enh.listeners.get('focus')[0].call(enh);
  assert.equal(tip.style.display, 'flex');
  enh.listeners.get('blur')[0].call(enh, { relatedTarget: null });   // 键盘 Tab 离开：指针不在面板上
  assert.equal(tip.style.display, 'none', 'blur away from the panel hides it (keyboard path)');
});

/* v468 接管路径（审查补）：守卫放过 blur 之后，「按钮已失焦但面板仍显示」这个新状态完全靠面板自身的
 * mouseleave 延迟收起来收。锁定：离开按钮的延迟收起被进入面板取消；守卫放过的 blur 不会变成延迟收起
 * （离开延迟到期面板仍在）；指针离开面板后按延迟收起。 */
test('v468: after a guarded blur the panel still hides when the pointer leaves it (mouseleave delayed hide takes over)', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '草稿' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  const tip = h.body.children.find(e => e.classList.contains('zusage-enhance-tip'));
  enh.listeners.get('focus')[0].call(enh);
  assert.equal(tip.style.display, 'flex');
  tip.matches = sel => sel === ':hover';   // 指针在面板上
  enh.listeners.get('mouseleave')[0]();   // 指针离开按钮：排一个延迟收起
  tip.listeners.get('mouseenter')[0]();   // 进入面板：取消
  runPending(h.timers, 220);
  assert.equal(tip.style.display, 'flex', 'entering the panel cancels the leave delay');
  enh.listeners.get('blur')[0].call(enh, { relatedTarget: null });   // 按下面板内按钮：mousedown 先移走焦点
  runPending(h.timers, 220);
  assert.equal(tip.style.display, 'flex', 'a guarded blur never turns into a delayed hide');
  tip.listeners.get('mouseleave')[0]();   // 指针离开面板
  assert.equal(tip.style.display, 'flex', 'leaving the panel hides it only after the delay');
  runPending(h.timers, 220);
  assert.equal(tip.style.display, 'none', 'mouseleave delayed hide takes over');
});

/* v468（审查补）：验收 11——同一状态下 footer 的「查看全部历史」「清空记录」同样要能点。修复前整排失效
 * （无头 Chrome 真实指针实证：main v467 上两者的 click 均落到 body）。 */
test('v468: after a guarded blur the other footer buttons still act — view-all opens the full panel, clear asks for confirmation', () => {
  const cases = [
    ['data-all', h => h.body.children.find(e => e.classList.contains('zusage-enhance-full') && e.style.display !== 'none'), 'view-all opens the full history panel'],
    ['data-clear', h => h.body.children.find(e => e.classList.contains('zu-compact-dlg')), 'clear asks for confirmation'],
  ];
  for (const [attr, pick, what] of cases) {
    const h = harness();
    const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '   ' });
    h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
    h.window.__zusageUpdate(h.payload());
    h.tick();
    const enh = h.enhOf(ui.wrap);
    const tip = h.body.children.find(e => e.classList.contains('zusage-enhance-tip'));
    enh.listeners.get('focus')[0].call(enh);
    enh.listeners.get('click')[0]();   // 空草稿：警示相位（感叹号），不发请求
    assert.ok(enh.classList.contains('zu-ewarn'));
    tip.matches = sel => sel === ':hover';
    enh.listeners.get('blur')[0].call(enh, { relatedTarget: null });
    assert.equal(tip.style.display, 'flex', attr + ': panel survives the blur');
    const footerBtn = new Element('button');
    footerBtn.setAttribute(attr, '');
    footerBtn.closest = sel => sel === 'button' ? footerBtn : null;
    tip.listeners.get('click')[0]({ target: footerBtn });
    assert.ok(pick(h), attr + ': ' + what + ' after a guarded blur');
  }
});

/* v468（审查补）：降级环境——没有 matches 或 matches 抛错时 blur 照旧即收（规格「降级环境照旧即收」）。 */
test('v468: without a usable matches() the blur handler still hides the panel (degraded environments keep the old behavior)', () => {
  const variants = [['missing', undefined], ['throwing', () => { throw new Error('matches unavailable'); }]];
  for (const [label, matches] of variants) {
    const h = harness();
    const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '草稿' });
    h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
    h.window.__zusageUpdate(h.payload());
    h.tick();
    const enh = h.enhOf(ui.wrap);
    const tip = h.body.children.find(e => e.classList.contains('zusage-enhance-tip'));
    enh.listeners.get('focus')[0].call(enh);
    assert.equal(tip.style.display, 'flex');
    tip.matches = matches;
    enh.listeners.get('blur')[0].call(enh, { relatedTarget: null });
    assert.equal(tip.style.display, 'none', 'blur still hides when matches is ' + label);
  }
});

/* v468（变异检查补）：壳层 openEnhanceSettings 先收面板这一步被实例侧 openEnhSettings 的同一动作遮住——
 * 只有入口钩子缺席时才单独可见。锁定：钩子缺席时点「设置」，设置面板不开，但面板照样收起（不悬空）。 */
test('v468: the settings entry still closes the panel when the entry hook is missing', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '草稿' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  const tip = h.body.children.find(e => e.classList.contains('zusage-enhance-tip'));
  enh.listeners.get('focus')[0].call(enh);
  assert.equal(tip.style.display, 'flex');
  enh.__zuOpenEnhSettings = undefined;   // 入口钩子缺席：壳层无处分发
  const setBtn = new Element('button');
  setBtn.setAttribute('data-ehset', '');
  setBtn.closest = sel => sel === 'button' ? setBtn : null;
  tip.listeners.get('click')[0]({ target: setBtn });
  assert.equal(tip.style.display, 'none', 'the panel closes even though nothing can be opened');
  assert.equal(h.window.enhanceTest.state().settingsSec, 'display', 'nothing was opened');
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

test('issue442: provider save delegates to the runtime lock on every platform; platformLimited is a legacy flag', () => {
  /* issue #442：Windows 早退门移除——save 分支全平台统一委托 python 事务
   * （runtime_lock.update_enhance_provider 已支持 nt，uid/0600 语义 POSIX 专属）；
   * platformLimited 恒 false（字段保留供旧渲染端读旧主进程的 true 区分文案），
   * available 不再按平台收窄。渲染端分支消费面保持（旧主进程兼容）。 */
  assert.doesNotMatch(injectSource, /error: "unsupported platform"/, 'win32 save early-return removed');
  /* round2-A：models 分支的 win32 恒拒门随 save 门同拆（Windows custom 模式「拉取模型」
   * 不得恒 provider unavailable）——锚点锁回归，防止只拆一半的对称门回潮。 */
  assert.doesNotMatch(injectSource, /settings\.unreadable \|\| process\.platform === "win32"/, 'win32 models gate removed too');
  assert.match(injectSource, /platformLimited: false/);
  assert.match(injectSource, /available: !!modelPuller && modelPuller\.enhanceProviderVersion === 1/);
  assert.match(source, /ep\.platformLimited/, 'renderer keeps consuming the legacy flag for old-main compat');
});

test('issue440: platform-limited custom mode names the platform restriction, not a restart hint', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: 'draft' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  h.window.enhanceTest.state().pluginUpdate = { enhanceProvider: { capability: 1, available: false, platformLimited: true, mode: 'custom', revision: 0 } };
  h.enhOf(ui.wrap).listeners.get('click')[0]();
  const label = h.enhOf(ui.wrap).getAttribute('aria-label');
  assert.match(label, /平台/, 'names the platform restriction');
  assert.doesNotMatch(label, /重启/, 'no misleading restart hint (issue #440: platform gate never lifts by restarting)');
  assert.equal(h.takeRequests().filter(r => /^prompt-enhance/.test(r.action)).length, 0, 'no request leaves in custom mode');
  assert.equal(ui.editor.__zuDraft, 'draft');
});

test('issue440: unavailable custom mode on a capable platform still points at a restart', () => {
  /* 非 win32（platformLimited 缺省 false）下 available false 仍是旧主进程/热模块缺位：
   * 「完全重启」文案在该场景保持正确，平台特判不得扩大化 */
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: 'draft' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  h.window.enhanceTest.state().pluginUpdate = { enhanceProvider: { capability: 1, available: false, mode: 'custom', revision: 0 } };
  h.enhOf(ui.wrap).listeners.get('click')[0]();
  assert.match(h.enhOf(ui.wrap).getAttribute('aria-label'), /重启/);
  assert.equal(h.takeRequests().filter(r => /^prompt-enhance/.test(r.action)).length, 0);
});

test('contract: custom-mode click gate branches on platformLimited before the restart hint', () => {
  assert.match(source, /ep\.mode === "custom" && ep\.available !== true/);
  /* 09 分片设置页另有 platformLimited 状态文案（配置与历史落盘措辞）——锚点必须含
   * 点击入口专属的英文对句，否则断言会被设置页行误满足（红测阶段实证） */
  assert.match(source, /当前平台暂不支持自定义增强供应商"[\s\S]{0,120}"Custom enhancement providers are not supported on this platform/);
});

test('v445: hot-reload handoff keeps the previous generation in-flight enhance cancel; other stale requests are dropped', () => {
  const h = harness();
  const cancel = { action: 'prompt-enhance-cancel', requestId: 'zusage-7-3' };
  /* 旧代 dispose 先于本代 boot 运行并把取消推进旧队列；主桥按 tick 取，此刻还没取走 */
  h.window.__zusagePluginRequests = [{ action: 'quota-providers', panes: {} }, cancel, { action: 'prompt-enhance-cancel' }];
  h.inject();
  const q = h.window.__zusagePluginRequests;
  assert.equal(q.length, 1, '只有取消留下：其余旧请求本代会重发，缺 requestId 的取消主桥本就拒收');
  assert.equal(q[0], cancel, '取消必须留在队列里等主桥取走');
  /* 首次注入（没有旧队列）仍是空队列 */
  const fresh = harness();
  fresh.inject();
  assert.equal(fresh.window.__zusagePluginRequests.length, 0);
});

test('v445: end to end — a re-inject during an in-flight enhance keeps the cancel the old generation pushes while disposing', () => {
  /* 复盘第 2 轮：上一条用例是手摆旧队列；这条走真实链路——在途增强 → 同一沙箱再注入一次，
   * 新代 IIFE 开头的 window.__zusageDispose() 让旧代真实 dispose（restoreEnhanceBtn(true) 推取消），
   * 取消必须活过紧随其后的队列重置。 */
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '帮我写个脚本' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  h.takeRequests();   // 启动期请求清空
  h.enhOf(ui.wrap).listeners.get('click')[0]();
  const sent = h.takeRequests().filter(r => /^prompt-enhance/.test(r.action));
  assert.equal(sent.length, 1, JSON.stringify(sent.map(r => r.action)));
  assert.match(String(sent[0].requestId), /^zusage-\d+-\d+$/);
  assert.equal((h.window.__zusagePluginRequests || []).length, 0, '前置：重注入前队列为空——取消只可能来自旧代 dispose');
  const oldGen = h.window.__zusageGen;
  h.inject();   // 热重载：新代 IIFE 先跑旧代的 window.__zusageDispose()
  assert.equal(h.window.__zusageGen, oldGen + 1, '新代际已起');
  const q = h.window.__zusagePluginRequests;
  const cancels = (q || []).filter(r => r.action === 'prompt-enhance-cancel');
  assert.equal(cancels.length, 1, '旧代 dispose 推进来的取消留在队列里等主桥取走：' + JSON.stringify((q || []).map(r => r.action)));
  assert.equal(cancels[0].requestId, sent[0].requestId, '取消带的正是在途那条请求的 id');
});

test('v445: main-process enhance guards — draft cap, settings file 0600 door, manual-source key never reused across targets', () => {
  const { sliceInject } = require('./helpers/overlay-extract.cjs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zu-enh-guards-'));
  try {
    const sandbox = {
      URL, fs, path, process, HERE: dir,
      modelPuller: { resolveEnhanceHost: (id) => (id === 'plan-a'
        ? { providerId: id, baseUrl: 'https://api.z.ai', protocol: 'anthropic-messages', apiKey: 'k-host', deviceMid: 'dev-1' } : null) },
    };
    vm.runInNewContext([
      sliceInject('function enhanceRequestTextOk(v) {', 'const enhanceInFlight = new Map();'),
      sliceInject('function readEnhanceProvider() {', 'function enhanceProviderView() {'),
      sliceInject('function validEnhanceUrl(value) {', 'function enhanceTargetRisk(value) {'),
      sliceInject('function resolveEnhanceDraftProvider(settings, draft, formApiKey) {', 'function resolveEnhanceProvider(d) {'),
    ].join('\n'), sandbox);
    // 草稿上限：空白拒、超 20000 拒、恰好 20000 收
    assert.equal(sandbox.enhanceRequestTextOk('   '), false);
    assert.equal(sandbox.enhanceRequestTextOk('x'.repeat(20001)), false);
    assert.equal(sandbox.enhanceRequestTextOk('x'.repeat(20000)), true);
    // 设置文件 0600 门（POSIX）：组/其它可读即视为不可读，不加载其中的 Key
    const file = path.join(dir, 'enhance-provider.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, revision: 3, mode: 'custom' }), { mode: 0o600 });
    assert.equal(sandbox.readEnhanceProvider().revision, 3);
    if (process.platform !== 'win32') {
      fs.chmodSync(file, 0o644);
      assert.equal(sandbox.readEnhanceProvider().unreadable, true, '0644 的设置文件不加载');
    }
    // 手动来源：目标（baseUrl+protocol）与已保存的完全一致才复用已存 Key；换目标必须重填
    const settings = { source: 'manual', baseUrl: 'https://relay.example.com/v1', protocol: 'openai-chat-completions', apiKey: 'sk-saved' };
    const same = sandbox.resolveEnhanceDraftProvider(settings, { source: 'manual', baseUrl: 'https://relay.example.com/v1', protocol: 'openai-chat-completions' }, '');
    assert.equal(same.apiKey, 'sk-saved');
    const moved = sandbox.resolveEnhanceDraftProvider(settings, { source: 'manual', baseUrl: 'https://evil.example.com/v1', protocol: 'openai-chat-completions' }, '');
    assert.equal(moved, null, '换目标且没填表单 Key：不得把已存 Key 发往新地址');
    assert.equal(sandbox.resolveEnhanceDraftProvider(settings, { source: 'manual', baseUrl: 'https://evil.example.com/v1', protocol: 'openai-chat-completions' }, 'sk-typed').apiKey, 'sk-typed');
    // 宿主来源：草稿的 baseUrl/protocol 必须与宿主当前公告一致（防把会话 Key 发往别处）
    assert.equal(sandbox.resolveEnhanceDraftProvider({}, { source: 'host', providerId: 'plan-a', baseUrl: 'https://evil.example.com', protocol: 'anthropic-messages' }, ''), null);
    assert.equal(sandbox.resolveEnhanceDraftProvider({}, { source: 'host', providerId: 'plan-a', baseUrl: 'https://api.z.ai', protocol: 'anthropic-messages' }, '').apiKey, 'k-host');
    assert.equal(sandbox.validEnhanceUrl('https://user:pw@example.com/v1'), false, '带 userinfo 的地址不收');
    assert.equal(sandbox.validEnhanceUrl('https://example.com/v1?x=1'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
