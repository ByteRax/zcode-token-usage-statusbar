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
  assert.match(source, /pluginRequest\("prompt-enhance", \{ providerId: providerId, modelId: modelId, text: draft \}/);
  assert.match(source, /current !== draft/);   // 回填前快照比对
  assert.match(source, /apiNow\.setText\(res\.text\)/);   // 唯一官方写通道
  assert.match(source, /state\.enhanceEnabled === false/);   // 开关门控（显隐层）
  assert.match(source, /\.zu-enhance/);   // 自清与样式类名
  assert.match(source, /restoreEnhanceBtn\(true\);   \/\/ v344：摘除增强按钮/);   // dispose 中断在途请求
  assert.match(source, /enhanceSid = enhanceCurSid\(\);/);   // 发起时会话身份锚定
  assert.match(source, /enhanceCurSid\(\) !== enhanceSid/);   // 回填/收窗的会话切换校验
  assert.match(source, /b\.addEventListener\("mouseenter", function \(\) \{ showEnhanceTip\(this\); \}\)/);   // 悬停 tooltip
  assert.match(source, /b\.__zuEnhTip = label;/);   // 文案包随相位同步
  assert.doesNotMatch(source, /b\.title = label/);   // 禁原生 title（防与自绘 tooltip 双显）
  assert.match(source, /"enhance failed: "\.slice|Enhancing…|增强中…/);
});

test('contract: inject-main whitelist routes prompt-enhance with fail-closed gate', () => {
  assert.match(injectSource, /req\.action === "prompt-enhance"/);
  assert.match(injectSource, /req\.action === "enhance" && typeof req\.enabled === "boolean"/);
  assert.match(injectSource, /if \(!enhanceEnabled\(\)\) \{ respond\(\{ ok: false, kind: "disabled"/);
  assert.match(injectSource, /function enhanceEnabled\(\) \{ return readCfgCached\(\)\.enhance_enabled !== false; \}/);
  assert.match(injectSource, /enhanceEnabled: enhanceEnabled\(\),/);   // 推送面
  assert.match(injectSource, /enhance_enabled: enabled/);   // 原子事务写
  assert.match(injectSource, /req\.action === "prompt-enhance-cancel" && typeof req\.requestId === "string"/);   // 取消分支
  assert.match(injectSource, /enhanceInFlight\.set\(req\.requestId, \{ controller: controller, wc: wc \}\)/);   // 在途表登记（带窗口归属）
  assert.match(injectSource, /signal: controller\.signal/);   // 中断透传 enhanceText
  assert.match(injectSource, /entry && entry\.wc === wc/);   // 在途表按窗口归属读写（多窗口 requestId 相撞防护）
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
  function inject() { window.__zusageOverlay = false; vm.runInContext(executable, sandbox); }
  function boot() { for (const [n, t] of [...timers]) if (!t.interval && t.ms === 0) { timers.delete(n); t.fn(); } }
  function tick() { for (const t of [...timers.values()]) if (t.interval && (t.ms === 600 || t.ms === 500)) t.fn(); }
  function buildComposer(pid, sid, { provider = '', model = '', draft = '' } = {}) {
    const pane = body.appendChild(new Element());
    pane.setAttribute('data-testid', 'v4-session-pane-' + pid);
    pane.setAttribute('data-pane-id', pid);   // 协调器按 data-pane-id 祖先定 pane 键并派发 attach
    pane.setAttribute('data-session-id', sid);   // readQuotaSelection 的实时模型归属校验（paneSid===sid）
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
    editor.closest = () => card;   // composerCardOf 的 .chat-composer-input-surface/[data-composer-layout] 判定命中 card 自身
    editor.pid = pid; editor.sid = sid;   // 协调器按 pane 归属派发 wantedEl（额度夹具同款）
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
  }
  /* 协调器派发的测试入口：生产链路 inst.attach(el, sid)（05 分片 coordinator 按扫描结果
   * 调用同一入口）；fixture 不复刻宿主全量可见性扫描，直接走协议入口最稳 */
  function coordAttach(el, sid) {
    if (!window.enhanceTest) return;
    const inst = window.enhanceTest.instances()[0];
    if (inst) inst.attach(el, sid);
  }
  const enhOf = wrap => wrap.children.find(e => e.classList.contains('zu-enhance'));
  return { window, body, inject, boot, tick, buildComposer, payload, takeRequests, respond, enhOf, coordAttach, lsStore, timers };
}

function runPending(timers, ms) {
  for (const [n, t] of [...timers]) if (!t.interval && t.ms === ms) { timers.delete(n); t.fn(); }
}

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

test('click sends prompt-enhance with live selection; reply replaces draft and arms undo', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '帮我写个脚本' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  enh.listeners.get('click')[0]();
  assert.equal(enh.getAttribute('aria-busy'), 'true');   // busy 立即置位，不等回包
  const reqs = h.takeRequests().filter(r => r.action === 'prompt-enhance');
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].providerId, 'account:bigmodel-individual-coding-plan');
  assert.equal(reqs[0].modelId, 'GLM-5.3-FlashX');
  assert.equal(reqs[0].text, '帮我写个脚本');
  h.respond(reqs[0].requestId, { ok: true, text: '更清晰的脚本需求' });
  assert.equal(ui.editor.__zuDraft, '更清晰的脚本需求');
  assert.equal(ui.editor.setTextCalls, 1);
  assert.equal(enh.getAttribute('aria-label'), '撤销增强，恢复原文');   // undo 相位
  enh.listeners.get('click')[0]();   // 撤销
  assert.equal(ui.editor.__zuDraft, '帮我写个脚本');
  assert.equal(enh.getAttribute('aria-label'), '增强提示词');
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
  assert.notEqual(tip.style.display, 'block');
  enh.listeners.get('mouseenter')[0].call(enh);
  assert.equal(tip.style.display, 'block');
  assert.equal(tip.textContent, '增强提示词');
  enh.listeners.get('mouseleave')[0]();
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

test('undo window self-heals when draft is sent (cleared), and undo click is guarded', () => {
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
  assert.match(enh.getAttribute('aria-label'), /撤销增强/);   // undo 态
  // 模拟消息发送：宿主提交流程清空草稿
  ui.editor.__zuDraft = '';
  h.tick();
  assert.equal(enh.getAttribute('aria-label'), '增强提示词');   // ≤一拍自动回初始态，不再滞留「撤回」
  // 此时点击（若用户手快）不得把原文塞回已清空的输入框
  enh.listeners.get('click')[0]();
  assert.equal(ui.editor.__zuDraft, '');
  assert.equal(ui.editor.setTextCalls || 0, 1);   // 只有最初那次成功回填
  // 对照：窗口内草稿被用户再编辑 → 点击撤销也不回写（守卫拒绝）
  ui.editor.__zuDraft = '原稿二';
  enh.listeners.get('click')[0]();
  const req2 = h.takeRequests().find(r => r.action === 'prompt-enhance');
  h.respond(req2.requestId, { ok: true, text: '增强稿二' });
  assert.equal(ui.editor.__zuDraft, '增强稿二');
  ui.editor.__zuDraft = '增强稿二（用户微调）';   // 窗口内手动编辑
  h.tick();
  assert.match(enh.getAttribute('aria-label'), /增强提示词/);   // 编辑后窗口自动失效（基准不再匹配）
  enh.listeners.get('click')[0]();
  assert.equal(ui.editor.__zuDraft, '增强稿二（用户微调）');   // 不被原文覆盖
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

test('undo sid guard: session switched inside the window, undo click must not write cross-session', () => {
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
  switched.mine = 'sid_other';
  h.window.__zusageUpdate(switched);
  h.tick();
  assert.match(enh.getAttribute('aria-label'), /增强提示词/);   // 对账自愈：sid 切换即收窗
  enh.listeners.get('click')[0]();   // 窗口已失效，点击不回写原文
  assert.equal(ui.editor.__zuDraft, '会话A增强稿');
});

test('undo window expires after 20s back to idle; missing reply hits the 75s timeout guard', () => {
  const h = harness();
  const ui = h.buildComposer('workspace-main', 'sid_main', { provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX', draft: '草稿' });
  h.inject(); h.boot(); h.coordAttach(ui.editor, 'sid_main');
  h.window.__zusageUpdate(h.payload());
  h.tick();
  const enh = h.enhOf(ui.wrap);
  // 场景一：成功回填进入 undo 态，20s 到期自动回初始态
  enh.listeners.get('click')[0]();
  const req = h.takeRequests().find(r => r.action === 'prompt-enhance');
  h.respond(req.requestId, { ok: true, text: '增强稿' });
  assert.match(enh.getAttribute('aria-label'), /撤销增强/);
  runPending(h.timers, 20000);
  assert.match(enh.getAttribute('aria-label'), /增强提示词/);   // 到期收窗
  assert.equal(ui.editor.__zuDraft, '增强稿');   // 收窗不改草稿
  // 场景二：无回包时 75s 兜底警示超时
  enh.listeners.get('click')[0]();
  h.takeRequests();
  runPending(h.timers, 75000);
  assert.match(enh.getAttribute('aria-label'), /增强超时/);
  assert.equal(enh.getAttribute('aria-busy'), 'false');
});

test('main-process handlers: abort wiring, cross-window guard, fail-closed gate (behavior)', () => {
  const injectSource = fs.readFileSync(path.join(__dirname, '..', 'inject-main.cjs'), 'utf8');
  const start = injectSource.indexOf('const enhanceInFlight = new Map();');
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
    AbortController,
    console,
  };
  vm.runInNewContext(slice + '\n;globalThis.__enh = { get: (k) => enhanceInFlight.get(k), has: (k) => enhanceInFlight.has(k) };', sandbox);
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
  assert.match(enh.getAttribute('aria-label'), /撤销增强/);
});
