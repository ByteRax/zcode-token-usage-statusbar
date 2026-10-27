const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
const turnStatsSource = fs.readFileSync(path.join(__dirname, '..', 'turn-stats.js'), 'utf8');

/* 与真实 DOM 语义对齐的最小选择器匹配：覆盖本测试构造的节点形态。 */
function datasetKey(attribute) {   // data-turn-id → dataset.turnId（真实 dataset 键不含前缀）
  return camel(attribute.replace(/^data-/, ''));
}
function camel(attribute) {
  return attribute.replace(/-(.)/g, (_, c) => c.toUpperCase());
}
function selectorMatches(el, selector) {
  for (const raw of String(selector).split(',')) {
    const sel = raw.trim();
    if (!sel) continue;
    let hit = false;
    if (sel === 'blockquote p') {
      hit = el.tagName === 'P' && el.parentElement && el.parentElement.tagName === 'BLOCKQUOTE';
    } else if (/^[a-z]+$/.test(sel)) {
      hit = el.tagName === sel.toUpperCase();
    } else if (/^\.[\w-]+$/.test(sel)) {
      hit = String(el.className || '').split(/\s+/).includes(sel.slice(1));
    } else if (/^([a-z]+)?((\[[\w-]+\])+)$/.test(sel)) {
      const tag = (sel.match(/^([a-z]+)?/) || [])[1];
      const attrs = [...sel.matchAll(/\[([\w-]+)\]/g)].map(m => datasetKey(m[1]));
      hit = attrs.every(a => a in el.dataset) && (!tag || el.tagName === tag.toUpperCase());
    }
    if (hit) return true;
  }
  return false;
}

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null;
    this.dataset = {}; this.style = {}; this.className = ''; this.textContent = '';
    this.innerHTML = '';
    this.style.setProperty = (k, v) => { this.style[k] = v; };
    this.style.getPropertyValue = k => this.style[k] || '';
    this.listeners = new Map(); this._lazy = new Map();
    const classes = new Set();
    this.classList = {
      contains: k => classes.has(k),
      add: k => { classes.add(k); this.className = [...classes].join(' '); },
      remove: k => { classes.delete(k); this.className = [...classes].join(' '); },
      toggle: (k, on) => { if (on) classes.add(k); else classes.delete(k); this.className = [...classes].join(' '); },
    };
  }
  addEventListener(type, fn) { const a = this.listeners.get(type) || []; a.push(fn); this.listeners.set(type, a); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(f => f !== fn)); }
  appendChild(el) { if (el.parentElement) el.remove(); this.children.push(el); el.parentElement = this; return el; }
  insertBefore(el, ref) {   // v79 统计行落点依赖；ref 不属于本节点时按真实 DOM 语义退化为 append
    if (!ref || ref.parentElement !== this) return this.appendChild(el);
    const idx = this.children.indexOf(ref);
    if (el.parentElement) el.remove();
    this.children.splice(idx, 0, el);
    el.parentElement = this;
    return el;
  }
  get nextSibling() {
    const p = this.parentElement;
    if (!p) return null;
    return p.children[p.children.indexOf(this) + 1] || null;
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(e => e !== this);
    this.parentElement = null;
  }
  contains(el) { return this === el || this.children.some(child => child.contains(el)); }
  collect(selector, out) {
    for (const child of this.children) {
      if (selectorMatches(child, selector)) out.push(child);
      child.collect(selector, out);
    }
    return out;
  }
  querySelectorAll(selector) { return this.collect(selector, []); }
  querySelector(selector) {
    // 实时段节点不在 children 树（render 走 innerHTML 字符串）：按字符串特征合成稳定引用，
    // 且每次查询都从 innerHTML 回放 class/text——整条重渲染（换图标/换文案）后替身
    // 也要反映新状态，否则只有原地改字路径可见（v77 相位切换引入了更多整条重渲染）。
    if (selector === '.zu-live') {
      const m = this.innerHTML.match(/class="(zu-live[^"]*)"[^>]*>([^<]*)/);
      if (m) {
        if (!this.__liveEl) this.__liveEl = new Element('span');
        this.__liveEl.className = m[1];
        this.__liveEl.textContent = m[2];
        return this.__liveEl;
      }
      return null;
    }
    const hit = this.querySelectorAll(selector)[0] || null;
    if (hit) return hit;
    // 无值属性选择器按真实 DOM 语义返回 null（确定性历史行扫描依赖 miss 判定）
    if (/^\[[\w-]+\]$/.test(selector.trim())) return null;
    // 面板内部控件等未建树查询：惰性创建保持实例装配可运行（与 lifecycle 夹具一致）
    if (!this._lazy.has(selector)) this._lazy.set(selector, new Element('div'));
    return this._lazy.get(selector);
  }
  setAttribute(name, value) { this.dataset[camel(name.replace(/^data-/, ''))] = String(value); }
  getAttribute(name) {
    if (!name.startsWith('data-')) return null;
    const key = camel(name.replace(/^data-/, ''));
    return key in this.dataset ? this.dataset[key] : null;
  }
  hasAttribute(name) {
    if (name === 'data-pane-id') return 'paneId' in this.dataset;
    if (name === 'data-session-id') return 'sessionId' in this.dataset;
    return name.startsWith('data-') && camel(name.replace(/^data-/, '')) in this.dataset;
  }
  closest() { return null; }
  getBoundingClientRect() { return { top: 600, bottom: 650, left: 20, right: 520, width: 500, height: 50 }; }
}

function makeStore(snapshot) {
  const subs = new Set();
  return {
    state: snapshot, offs: 0,
    getState() { return this.state === null ? null : { snapshot: this.state, status: 'live' }; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    subscribers() { return subs.size; },
    notify() { for (const fn of [...subs]) fn(); },
    off() { this.offs += 1; },
    set(snapshot) { this.state = snapshot; this.notify(); },
  };
}

function snap(seq, rows, sessionId = 'sid_a', logEpoch = 'e1') {
  return { sessionId, logEpoch, seq, rows: { window: rows } };
}
function header(state, extra = {}) {
  return { rowId: 1, turnId: 't1', productTurnId: 'pt1', kind: 'turnHeader', state, ...extra };
}
function text(value) { return { rowId: 2, turnId: 't1', productTurnId: 'pt1', kind: 'assistantText', text: value }; }

/* harness(withBridge)：完整跑 turn-stats.js + overlay.js（VM 同上下文，注入序与线上一致）。 */
function harness(withBridge = true) {
  const window = new Element('window');
  Object.assign(window, { innerWidth: 1000, innerHeight: 800 });
  const body = new Element('body'), root = new Element('html');
  const document = new Element('document');
  Object.assign(document, {
    body, documentElement: root,
    createElement: tag => new Element(tag),
    getElementById: () => null,
  });
  document.querySelectorAll = selector => selector.startsWith('textarea,')
    ? panes : body.collect(selector, []);

  let panes = [];
  const diagSessions = [];
  let bindCalls = 0;
  if (withBridge) {
    window.__zusageConversationDiagnostics = () => ({ keys: diagSessions.map(s => s.key), sessions: diagSessions });
    window.__zusageGetExistingConversationStore = scope => {
      if (!scope || typeof scope.sessionId !== 'string' || !scope.workspacePath) return null;
      bindCalls += 1;
      const entry = diagSessions.find(s => s.topic === 'conversation/' + scope.sessionId);
      return entry && entry.store || null;
    };
  }

  const clock = { now: 0 };
  const timers = new Map(), frames = new Map();
  let id = 0;
  const sandbox = vm.createContext({
    window, document, console, innerHeight: 800, innerWidth: 1000,
    location: { href: 'file:///fixture' },
    localStorage: { getItem: () => null, setItem() {} },
    performance: { now: () => clock.now },
    getComputedStyle: () => ({ borderTopWidth: '1px', backgroundColor: 'black', opacity: '1', display: 'block', visibility: 'visible', pointerEvents: 'auto' }),
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimeout: n => timers.delete(n),
    setInterval: (fn, ms) => { timers.set(++id, { fn, ms, interval: true }); return id; },
    clearInterval: n => timers.delete(n),
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; },
    cancelAnimationFrame: n => frames.delete(n),
    MutationObserver: class { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} },
  });
  vm.runInContext(turnStatsSource, sandbox);   // 统计内核先注入（与 inject-main.cjs 页面注入序一致）
  const executable = source.replace(/\}\)\(\);\s*$/,
    'window.bridgeTest = { instances: function() { return instances; } };})();');
  function inject() { window.__zusageOverlay = false; vm.runInContext(executable, sandbox); }
  const runTimers = ms => { for (const t of [...timers.values()]) if (t.interval && t.ms === ms) t.fn(); };
  function boot() { for (const [, t] of [...timers]) if (!t.interval && t.ms === 0) { timers.delete(t); t.fn(); } }
  function setPanes(keys) {
    panes = keys.map(k => {
      const card = body.appendChild(new Element('div'));
      const pane = card.appendChild(new Element('div')); pane.dataset.paneId = k; pane.dataset.sessionId = 'sid_' + k;
      return pane.appendChild(new Element('textarea'));
    });
  }
  return {
    window, body, timers, frames, inject, boot, runTimers, setPanes, clock,
    diagSessions, bindCalls: () => bindCalls,
    deterministic: () => body.collect('[data-zusage-deterministic]', [])
      .filter(el => el.tagName === 'BLOCKQUOTE'),   // 行容器（内部 p 同带标记，随父计数）
  };
}

function instanceOf(h) { return h.window.bridgeTest.instances()[0]; }

/* v75：完成态历史行先插桥接简化文案占位，同时把 {action:'turn-text'} 请求入队给
 * inject-main.cjs（它按 turn 身份一次性查库，用 --turn --session --turn-id 拿模型时代
 * 那行富文本，再经 window.__zusageDeliverTurnText 回推）。请求/交付用 tracker 的轮次
 * key（productTurnId 优先），缓存/限流用扫描循环的 DOM tid；两者经反查表对应。 */
function turnRequests(h) {
  return (h.window.__zusagePluginRequests || []).filter(r => r && r.action === 'turn-text');
}
/* 完成一轮 + 挂上 turn 容器 + 跑一次 0.5s 扫描：返回该容器的统计行 <p> */
function completeTurn(h, store, tid = 'pt1') {
  h.clock.now = 1600;
  store.set(snap(3, [header('completedSuccess', { outputTokens: 1000, modelDurationMs: 4000, activeMs: 5000 }), text('abcdef')]));
  const section = h.body.appendChild(new Element('section'));
  section.dataset.turnId = tid;
  h.runTimers(500);
  return { section, line: () => h.deterministic()[0].querySelector('p') };
}
const RICH = '⚡ 82.6 token/s(本轮) · 首字 1.4s · 输出 8,300(含 2,100 思考) token / 生成 100.5s · 7 段 / 峰 112 token/s · 累计 16.4万 token · ⏱ 20:31:22';

test('⑫ completed turn shows the bridge placeholder and enqueues one DB rich-text request by session', () => {
  const h = harness();
  const store = driveStreaming(h);
  const { line } = completeTurn(h, store);
  // 占位：桥接能算出的简化文案（注意不是模型那行富文本）
  assert.equal(line().textContent, '⚡ 250.0 token/s(本轮) · 输出 1,000 token · 耗时 5.0s');
  const reqs = turnRequests(h);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].action, 'turn-text');
  assert.equal(reqs[0].sid, 'sid_a');      // 查询按 session 走 --current 推断，不带显式 turn-id
  assert.equal(reqs[0].turnId, undefined); // 数据库 turn_id 和渲染器 turnId 不是同一套标识，不能传
  assert.equal(reqs[0].cn, 1);             // v85：万/亿开关（缺省开、中文）随请求转达给 token_rate.py
});

test('⑬ delivered DB rich text replaces the placeholder line immediately, without waiting for the next tick', () => {
  const h = harness();
  const store = driveStreaming(h);
  const { line } = completeTurn(h, store);
  assert.equal(turnRequests(h)[0].sid, 'sid_a');
  h.window.__zusageDeliverTurnText('sid_a', RICH);   // 交付按 sid 关联，不是 turnId
  assert.equal(line().textContent, RICH);   // 立即重扫生效（未跑任何定时器）
  assert.doesNotMatch(line().textContent, /耗时 5\.0s/);   // 桥接简化文案已被覆盖
  h.runTimers(500);                        // 后续 tick 不再重建回简化文案
  assert.equal(line().textContent, RICH);
  assert.equal(turnRequests(h).length, 1);  // 已有富文本：不再入队
});

test('⑬b delayed DB rich text still replaces the placeholder after its tracker record slides out', () => {
  const h = harness();
  const store = driveStreaming(h);
  const { line } = completeTurn(h, store);
  assert.equal(turnRequests(h).length, 1);
  assert.equal(turnRequests(h)[0].sid, 'sid_a');
  store.set(snap(4, [{ rowId: 9, turnId: 't2', productTurnId: 'pt2', kind: 'turnHeader', state: 'running' }]));
  h.runTimers(500);
  assert.equal(instanceOf(h).statsFor('pt1'), null);
  assert.equal(turnRequests(h).length, 1);
  h.window.__zusageDeliverTurnText('sid_a', RICH);
  assert.equal(line().textContent, RICH);
  for (let i = 0; i < 10; i++) h.runTimers(500);
  assert.equal(line().textContent, RICH);
  assert.equal(turnRequests(h).length, 1);
});

test('⑬c delayed DB rich text replaces the placeholder after epoch hydration restores zero output', () => {
  const h = harness();
  const store = driveStreaming(h);
  const { line } = completeTurn(h, store);
  store.set(snap(4, [header('completedSuccess', { outputTokens: 0, modelDurationMs: 0,
    startedAt: 1000, endedAt: 6000 }), text('abcdef')], 'sid_a', 'e2'));
  h.runTimers(500);
  assert.equal(instanceOf(h).statsFor('pt1').observedLive, false);
  assert.equal(instanceOf(h).statsFor('pt1').outputTokens, 0);
  assert.equal(turnRequests(h).length, 1);
  h.window.__zusageDeliverTurnText('sid_a', RICH);
  assert.equal(line().textContent, RICH);
  h.runTimers(500);
  assert.equal(line().textContent, RICH);
  assert.equal(turnRequests(h).length, 1);
});

for (const delivery of ['before remount', 'after remount']) {
  test(`⑬d cached DB rich text rebuilds a hydrated historical turn (${delivery})`, () => {
    const h = harness();
    const store = driveStreaming(h);
    const { section } = completeTurn(h, store);
    store.set(snap(4, [header('completedSuccess', { outputTokens: 0, modelDurationMs: 0 }), text('abcdef')], 'sid_a', 'e2'));
    h.runTimers(500);
    if (delivery === 'before remount') h.window.__zusageDeliverTurnText('sid_a', RICH);
    section.remove();
    const remounted = h.body.appendChild(new Element('section'));
    remounted.dataset.turnId = 'pt1';
    h.runTimers(500);
    if (delivery === 'after remount') {
      assert.equal(h.deterministic().length, 0);
      h.window.__zusageDeliverTurnText('sid_a', RICH);
    }
    assert.equal(h.deterministic().length, 1);
    assert.equal(h.deterministic()[0].querySelector('p').textContent, RICH);
    h.runTimers(500);
    assert.equal(h.deterministic()[0].querySelector('p').textContent, RICH);
    assert.equal(turnRequests(h).length, 1);
  });
}

test('⑭ empty delivery (DB not caught up yet) keeps the placeholder and retries on the next tick', () => {
  const h = harness();
  const store = driveStreaming(h);
  const { line } = completeTurn(h, store);
  const before = turnRequests(h).length;
  h.window.__zusageDeliverTurnText('sid_a', '');      // 主进程回推空串 = 库里还没这一轮/还没有有效提问时刻
  assert.equal(line().textContent, '⚡ 250.0 token/s(本轮) · 输出 1,000 token · 耗时 5.0s');
  assert.equal(turnRequests(h).length, before);     // 交付回调本身不重复入队（重试只由扫描驱动）
  h.runTimers(500);                                // 下一次扫描 tick：补发一次同 session 的重试
  const reqs = turnRequests(h);
  assert.ok(reqs.length > before);
  assert.equal(reqs[reqs.length - 1].sid, 'sid_a');
  h.window.__zusageDeliverTurnText('sid_a', RICH);    // 重试命中后即止
  assert.equal(line().textContent, RICH);
  h.runTimers(500);
  assert.equal(turnRequests(h).length, reqs.length);
});

test('⑮ bar "generation speed" chip is untouched by the rich-text overlay path', () => {
  const h = harness();
  const store = driveStreaming(h);
  assert.equal(instanceOf(h).liveEl().textContent, '1.5 t/s');   // 生成中：估算态
  const { line } = completeTurn(h, store);
  // 完成态 chip：紧凑 tok/s + 档位色（v73 格式，与对话内长句无关）——富文本请求/交付全程不变
  assert.equal(instanceOf(h).liveEl().textContent, '250.0 t/s');
  assert.equal(instanceOf(h).liveEl().className, 'zu-live zu-sky');   // 250 t/s ∈ 200–300 快速档（v127 十档）
  h.window.__zusageDeliverTurnText('sid_a', RICH);
  assert.equal(line().textContent, RICH);
  assert.equal(instanceOf(h).liveEl().textContent, '250.0 t/s');
  assert.equal(instanceOf(h).liveEl().className, 'zu-live zu-sky');   // 250 t/s ∈ 200–300 快速档（v127 十档）
  h.runTimers(500);
  assert.equal(instanceOf(h).liveEl().textContent, '250.0 t/s');
});

/* 绑定并驱动到"生成中"的公共序列：pane a → 桥命中 → 流式快照推进。 */
function driveStreaming(h) {
  h.setPanes(['a']);
  h.inject(); h.boot();
  h.runTimers(600);           // coordinator：spawn 实例 + attach（instSid = sid_a）
  const store = makeStore(snap(1, [header('running'), text('abc')]));
  h.diagSessions.push({ key: '__base__ /fixture/ws', topic: 'conversation/sid_a', store });
  h.runTimers(100);          // bridgeTick（v89 0.1s 心跳）：能力检测 → 绑定 → 订阅首个快照（生成中）
  h.clock.now = 1000;
  store.set(snap(2, [header('running'), text('abcdef')]));
  return store;
}

test('① bridge API absent degrades to DB path: no binding, no live segment, no deterministic line', () => {
  const h = harness(false);
  h.setPanes(['a']); h.inject(); h.boot(); h.runTimers(600); h.runTimers(500); h.runTimers(500);
  assert.equal(h.bindCalls(), 0);
  assert.equal(instanceOf(h).statsFor('pt1'), null);
  const section = h.body.appendChild(new Element('section'));
  section.dataset.turnId = 'pt1';
  h.runTimers(500);
  assert.equal(h.deterministic().length, 0);
});

test('② matched session binds store and live segment shows c2t-estimated tok/s before calibration', () => {
  const h = harness();
  const store = driveStreaming(h);
  assert.ok(h.bindCalls() >= 1);
  assert.equal(store.subscribers(), 1);   // subscribeStore 订阅在位
  const inst = instanceOf(h);
  const stats = inst.statsFor('pt1');
  assert.equal(stats.complete, false);
  assert.equal(stats.characterRate, 3);
  const live = inst.liveEl();
  assert.ok(live, 'live segment node mounted');
  // 本会话尚无已完成轮次校准过比例：退回默认每 token 2 字符 → 3/2 = 1.5
  assert.equal(live.textContent, '1.5 t/s');
  assert.equal(live.className, 'zu-live hot');   // 估算 1.5 t/s 套低速档（v127 估算态也分档）
  // 无桥时不渲染实时段（降级现状）：见用例①，liveEl 为 null
});

test('③ completed turn swaps live text to final summary and inserts deterministic history line', () => {
  const h = harness();
  const store = driveStreaming(h);
  h.clock.now = 1600;
  store.set(snap(3, [header('completedSuccess', { outputTokens: 1000, modelDurationMs: 4000, activeMs: 5000 }), text('abcdef')]));
  const inst = instanceOf(h);
  const stats = inst.statsFor('pt1');
  assert.equal(stats.complete, true);
  assert.equal(stats.tokenRate, 250);
  // 悬浮条 chip 完成态：紧凑真实 tok/s + 档位色（与对话内长句 zuFinalText 分开，互不影响）
  assert.equal(inst.liveEl().textContent, '250.0 t/s');
  assert.equal(inst.liveEl().className, 'zu-live zu-sky');   // 250 t/s ∈ 200–300 快速档（v127 十档）
  // 原始 turnId 形态（DOM data-turn-id）经 alias 映射同样命中
  assert.equal(inst.statsFor('t1').tokenRate, 250);
  const section = h.body.appendChild(new Element('section'));
  section.dataset.turnId = 't1';
  h.runTimers(500);
  const lines = h.deterministic();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].tagName, 'BLOCKQUOTE');
  assert.ok(lines[0].parentElement === section);   // 插在 turn 容器末尾
  assert.match(lines[0].querySelector('p').textContent, /250\.0 token\/s\(本轮\)/);
  assert.match(lines[0].querySelector('p').textContent, /耗时 5\.0s/);
  assert.ok(lines[0].querySelector('p').dataset.zusageDeterministic === '1');
});

test('③ existing model rate line in the same turn container suppresses duplicate insertion', () => {
  const h = harness();
  const store = driveStreaming(h);
  store.set(snap(3, [header('completedSuccess', { outputTokens: 1000, modelDurationMs: 4000, activeMs: 5000 }), text('abcdef')]));
  const section = h.body.appendChild(new Element('section'));
  section.dataset.turnId = 'pt1';
  const quote = section.appendChild(new Element('blockquote'));
  const p = quote.appendChild(new Element('p'));
  p.textContent = '⚡ 153.8 tok/s(本轮) · 首字 3.0s · 输出 2,000 tok';
  h.runTimers(500);
  assert.equal(h.deterministic().length, 0);   // 模型历史统计行在位：不叠双行
  p.remove();
  h.runTimers(500);
  assert.equal(h.deterministic().length, 1);   // 行被移除（重挂场景）且无模型行 → 插入
});

test('④ virtual-list remount rebuilds from tracker; cleared records keep their line and never refabricate', () => {
  const h = harness();
  const store = driveStreaming(h);
  store.set(snap(3, [header('completedSuccess', { outputTokens: 1000, modelDurationMs: 4000, activeMs: 5000 }), text('abcdef')]));
  const section = h.body.appendChild(new Element('section'));
  section.dataset.turnId = 'pt1';
  h.runTimers(500);
  assert.equal(h.deterministic().length, 1);
  h.deterministic().forEach(el => el.remove());   // 模拟虚拟列表回收节点
  h.runTimers(500);
  assert.equal(h.deterministic().length, 1);      // tracker 仍有记录 → 重挂重建
  assert.match(h.deterministic()[0].querySelector('p').textContent, /token\/s\(本轮\)/);
  // 换代清空 tracker 记录：保留已有文本——已完成轮的数字不会过时，而"不可用"在 tracker 不认识
  // 这轮时没有信息量（v86；v74 原设计"明示不可用"在重启后首条消息/热更新场景整页误报）
  store.set(snap(4, [], 'sid_a', 'e2'));
  h.runTimers(500);
  assert.equal(h.deterministic().length, 1);
  assert.match(h.deterministic()[0].querySelector('p').textContent, /token\/s\(本轮\)/);
  h.deterministic()[0].remove();                  // 回收后：tracker 无记录的旧消息不补造
  h.runTimers(500);
  assert.equal(h.deterministic().length, 0);
});

test('⑤ store generation change detaches and the next probe rebinds the replacement store', () => {
  const h = harness();
  const old = driveStreaming(h);
  assert.equal(old.subscribers(), 1);
  old.set(snap(5, [header('running')], 'sid_other'));   // 快照 sessionId 变：换代
  assert.equal(old.subscribers(), 0);                    // 订阅即撤
  assert.ok(old.offs >= 1);                              // store.off 已调
  assert.equal(instanceOf(h).statsFor('pt1'), null);     // tracker 已 dispose
  const fresh = makeStore(snap(1, [header('running'), text('x')]));
  h.diagSessions.length = 0;
  h.diagSessions.push({ key: '__base__ /fixture/ws', topic: 'conversation/sid_a', store: fresh });
  h.runTimers(100);                                     // 下轮能力检测重绑（0.1s 心跳）
  assert.equal(fresh.subscribers(), 1);
  h.clock.now = 2000;
  fresh.set(snap(2, [header('running'), text('xyz')]));
  assert.equal(instanceOf(h).statsFor('pt1').characterRate, 2);
});

test('⑥ dispose releases store subscriptions, removes deterministic nodes and clears timers', () => {
  const h = harness();
  const store = driveStreaming(h);
  store.set(snap(3, [header('completedSuccess', { outputTokens: 1000, modelDurationMs: 4000, activeMs: 5000 }), text('abcdef')]));
  const section = h.body.appendChild(new Element('section'));
  section.dataset.turnId = 'pt1';
  h.runTimers(500);
  assert.equal(h.deterministic().length, 1);
  h.window.__zusageDispose();
  assert.equal(store.subscribers(), 0);
  assert.ok(store.offs >= 1);
  assert.equal(h.deterministic().length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.frames.size, 0);
});

test('⑦ rate-line toggle off detaches the bridge and withdraws live segment and deterministic lines', () => {
  const h = harness();
  const store = driveStreaming(h);
  store.set(snap(3, [header('completedSuccess', { outputTokens: 1000, modelDurationMs: 4000, activeMs: 5000 }), text('abcdef')]));
  const section = h.body.appendChild(new Element('section'));
  section.dataset.turnId = 'pt1';
  h.runTimers(500);
  assert.equal(h.deterministic().length, 1);
  const live = instanceOf(h).liveEl();
  assert.equal(live.textContent, '250.0 t/s');
  h.window.__zusagePluginUpdate({ rateLine: false });   // ⚙ 面板关闭逐问速率行
  h.runTimers(100);                                    // 下一轮检测（0.1s 心跳）：detach
  h.runTimers(500);                                    // 扫描撤下自插历史行
  assert.equal(store.subscribers(), 0);
  assert.equal(instanceOf(h).statsFor('pt1'), null);
  // v72：桥撤下且本测试无 DB 兜底数据（last.tps 恒为 0）时，合并后的 chip 整条移除，不留空壳
  assert.equal(instanceOf(h).liveEl(), null);
  assert.equal(h.deterministic().length, 0);            // 自插的历史行撤下（模型历史行不在此测）
});

test('⑧ c2t calibration uses the previous completed turn\'s real ratio for the next live estimate', () => {
  const h = harness();
  const store = driveStreaming(h);   // pt1 生成中，characterRate=3（尚无校准样本，用默认比例 2）
  assert.equal(instanceOf(h).liveEl().textContent, '1.5 t/s');
  h.clock.now = 2000;
  // pt1 完成：6 字符（'abcdef'）÷ 2 tokens = 每 token 3 字符（区别于默认值 2，便于断言区分）
  store.set(snap(3, [header('completedSuccess', { outputTokens: 2, modelDurationMs: 1000, activeMs: 1000 }), text('abcdef')]));
  assert.equal(instanceOf(h).liveEl().textContent, '2.0 t/s');
  // 新一轮 t2/pt2 开始生成（同一 store/session，calibration 不随换轮重置）
  h.clock.now = 2100;
  store.set(snap(4, [
    { rowId: 3, turnId: 't2', productTurnId: 'pt2', kind: 'turnHeader', state: 'running' },
    { rowId: 4, turnId: 't2', productTurnId: 'pt2', kind: 'assistantText', text: 'x' },
  ]));
  h.clock.now = 3100;
  store.set(snap(5, [
    { rowId: 3, turnId: 't2', productTurnId: 'pt2', kind: 'turnHeader', state: 'running' },
    { rowId: 4, turnId: 't2', productTurnId: 'pt2', kind: 'assistantText', text: 'xxxxxxxxxx' },
  ]));
  assert.equal(instanceOf(h).statsFor('pt2').characterRate, 9);
  // 用上一轮校准出的 3 字符/token（而非默认 2）：9 ÷ 3 = 3.0
  assert.equal(instanceOf(h).liveEl().textContent, '3.0 t/s');
});

test('⑨ nested [data-v4-turn-unit] wrapping a section with the same turn-id inserts exactly one line', () => {
  const h = harness();
  const store = driveStreaming(h);
  store.set(snap(3, [header('completedSuccess', { outputTokens: 1000, modelDurationMs: 4000, activeMs: 5000 }), text('abcdef')]));
  // 真机 DOM 形态：外层 [data-v4-turn-unit] 包一个同 tid 的内层 section（均能单独命中原选择器）
  const outer = h.body.appendChild(new Element('div'));
  outer.dataset.v4TurnUnit = 'true';
  outer.dataset.turnId = 'pt1';
  const section = outer.appendChild(new Element('section'));
  section.dataset.turnId = 'pt1';
  h.runTimers(500);
  assert.equal(h.deterministic().length, 1);         // 不因两个选择器都命中而插两条
  assert.ok(section.children.some(c => c.tagName === 'BLOCKQUOTE'));   // 插在更具体的 section 里
  assert.equal(outer.children.filter(c => c.tagName === 'BLOCKQUOTE').length, 0);
});

test('⑩ completed turn with zero output shows unavailable instead of a meaningless duration number', () => {
  const h = harness();
  const store = driveStreaming(h);
  // 完成但零输出（如纯控制/后台轮次）：真机曾出现"输出 0 tok · 耗时 939.0s"这类无意义数字
  store.set(snap(3, [header('completedSuccess', { outputTokens: 0, modelDurationMs: 1000, activeMs: 939000 })]));
  const section = h.body.appendChild(new Element('section'));
  section.dataset.turnId = 'pt1';
  h.runTimers(500);
  assert.equal(h.deterministic().length, 1);
  assert.equal(h.deterministic()[0].querySelector('p').textContent, '⚡ 本轮统计不可用(本轮)');
  // 悬浮条 chip：零输出/缺口径的完成轮不再显示刺眼的"速度不可用"，直接回退 DB
  // 分支（本测试无 DB 兜底数据 last.tps=0）→ 整枚 chip 不渲染
  assert.equal(instanceOf(h).liveEl(), null);
});

test('⑪ heartbeat tick alone (no new store push) still advances the observed-seconds display during a stall', () => {
  const h = harness();
  const store = driveStreaming(h);   // 末尾：characterRate=3，liveEl 显示 '1.5 t/s'
  assert.equal(instanceOf(h).liveEl().textContent, '1.5 t/s');
  // 模拟工具执行期间宿主不再推送新快照：只推进时钟、只触发 bridgeTick 自身的 0.1s 心跳
  h.clock.now = 3100;   // 距上个样本（t=1000）超过 2000ms 陈旧窗口，characterRate 应变为 null
  h.runTimers(100);
  assert.equal(instanceOf(h).statsFor('pt1').characterRate, null);
  // 没有新快照也要能走字：证明心跳本身驱动了刷新，而不是只等 store 通知
  assert.equal(instanceOf(h).liveEl().textContent, '思考中…3秒');
  for (const [now, expected] of [
    [59999, '59 秒'], [60000, '1 分'], [70000, '1 分 10 秒'],
    [3600000, '1 时'], [3610000, '1 时 10 秒'], [3660000, '1 时 1 分'], [3670000, '1 时 1 分 10 秒'],
  ]) {
    h.clock.now = now;
    h.runTimers(100);
    assert.equal(instanceOf(h).liveEl().textContent, '思考中…' + expected.replace(/ /g, ''));
  }
  // 无可测字符流=思考态：chip 图标切到动效脑（v77：用户语义"生成中"改"思考中"）
  assert.equal(instanceOf(h).liveIconKind(), 'think');
  assert.equal(store.subscribers(), 1);   // 心跳没有误判成"店铺换代"而重新订阅/脱离
});

test('⑫ bar chip mirrors the running toolCall state (verb + elapsed) instead of a stale 生成中', () => {
  const h = harness();
  const store = driveStreaming(h);   // 正文流式中：'1.5 t/s'
  assert.equal(instanceOf(h).liveEl().textContent, '1.5 t/s');
  // 工具开始执行（本轮最后一个活动行变为 running 的 toolCall）：悬浮条切到宿主同款动词
  store.set(snap(3, [header('running'), text('abcdef'),
    { rowId: 5, turnId: 't1', productTurnId: 'pt1', kind: 'toolCall', toolName: 'Edit', inputText: '{}', status: 'running', startedAt: Date.now() - 4200 }]));
  assert.match(instanceOf(h).liveEl().textContent, /^正在编辑 · 4\.\d+s$/);
  // 工具完成、回到正文流式：恢复估算速度（与 toolCall 行状态再次对应）
  h.clock.now = 4000;
  store.set(snap(4, [header('running'), text('abcdefghij'),
    { rowId: 5, turnId: 't1', productTurnId: 'pt1', kind: 'toolCall', toolName: 'Edit', inputText: '{}', status: 'success' }]));
  assert.match(instanceOf(h).liveEl().textContent, /^\d/);
});

test('⑬ running phases keep distinct generating, thinking and tool icons after updates', () => {
  const h = harness();
  const store = driveStreaming(h);   // 正文流式：运行期=动效脑
  const inst = instanceOf(h);
  assert.equal(inst.liveIconKind(), 'generate');
  // 思考开始：本轮最后一个活动行变为 reasoning（思考文本流式输出，正文行仍在窗口内）
  h.clock.now = 2000;
  store.set(snap(3, [header('running'), text('abcdef'),
    { rowId: 5, turnId: 't1', productTurnId: 'pt1', kind: 'reasoning', text: '想一想' }]));
  assert.equal(inst.statsFor('pt1').phase, 'thinking');
  assert.equal(inst.liveIconKind(), 'think');   // 相位切换触发整条重渲染：动效脑保持
  assert.match(inst.liveEl().textContent, /^\d+(\.\d+)? t\/s$/);   // 思考文本也在流式：估算速度照常
  // 工具执行期同样保持动效脑（v77.1：运行期一律脑图标）
  store.set(snap(4, [header('running'), text('abcdef'),
    { rowId: 6, turnId: 't1', productTurnId: 'pt1', kind: 'toolCall', toolName: 'Read', inputText: '', status: 'running', startedAt: Date.now() }]));
  assert.equal(inst.liveIconKind(), 'tool');
  assert.match(inst.liveEl().textContent, /^正在读取 · \d/);
  // 思考结束回正文流式（reasoning 移出窗口，正文行继续增长）：仍为动效脑
  h.clock.now = 3000;
  store.set(snap(5, [header('running'), text('abcdefghij')]));
  assert.equal(inst.statsFor('pt1').phase, 'writing');
  assert.equal(inst.liveIconKind(), 'generate');
  // 轮次完成：无相位，图标回落到 bolt（真实 tok/s 档位视图）
  store.set(snap(6, [header('completedSuccess', { outputTokens: 1000, modelDurationMs: 4000, activeMs: 5000 }), text('abcdefghij')]));
  assert.equal(inst.liveIconKind(), 'bolt');
  assert.equal(inst.liveEl().textContent, '250.0 t/s');
});

test('⑯ switching to a session whose latest turn finished before this binding does not show a misleading "rate unavailable"', () => {
  const h = harness();
  h.setPanes(['a']);
  h.inject(); h.boot();
  h.runTimers(600);
  // 直接绑定一个"早已完成"的轮次——没有经历过 running 阶段的实时观测，模拟切换到一个
  // 老会话，桥接首次订阅就看到这一轮早就跑完了（不是我们亲历的完成过程）。
  const store = makeStore(snap(1, [header('completedSuccess',
    { outputTokens: 1000, modelDurationMs: 4000, activeMs: 5000 }), text('abcdef')]));
  h.diagSessions.push({ key: '__base__ /fixture/ws', topic: 'conversation/sid_a', store });
  h.runTimers(100);
  const stats = instanceOf(h).statsFor('pt1');
  assert.equal(stats.complete, true);
  assert.equal(stats.observedLive, false);   // 从未见过它处于未完成状态
  // 悬浮条：不该展示"速度不可用"（会被误读成这个会话突然坏了）——
  // 视为没有可用的桥接视图，回退 DB（本测试无 DB 兜底数据）即整条不渲染
  assert.equal(instanceOf(h).liveEl(), null);
  // 对话内历史行不受这个限制：只要完成且有输出，仍然正常展示统计——
  // 用户滚回这条老消息时，期望看到的是数据，不是因为"桥是不是亲历的"而消失
  const section = h.body.appendChild(new Element('section'));
  section.dataset.turnId = 'pt1';
  h.runTimers(500);
  assert.equal(h.deterministic().length, 1);
  assert.equal(h.deterministic()[0].querySelector('p').textContent,
    '⚡ 250.0 token/s(本轮) · 输出 1,000 token · 耗时 5.0s');
});

/* v86：重启/切会话后桥接一步到位捞到的历史存量轮（observedLive=false）可能缺 outputTokens 等
 * 详细字段（宿主恢复的 turnHeader 不带实时完成事件的数据）。这类轮不能被判成"本轮统计不可用"
 * ——那是 v74 为"亲历过的真实零输出轮"准备的文案；缺字段 ≠ 零输出。真机：完全重启后历史轮
 * 曾整页显示"本轮统计不可用(本轮)"。 */
test('⑯b a historical turn caught at binding without output fields is skipped, not marked "unavailable"', () => {
  const h = harness();
  h.setPanes(['a']);
  h.inject(); h.boot();
  h.runTimers(600);
  const store = makeStore(snap(1, [header('completedSuccess'), text('abcdef')]));
  h.diagSessions.push({ key: '__base__ /fixture/ws', topic: 'conversation/sid_a', store });
  h.runTimers(100);
  const stats = instanceOf(h).statsFor('pt1');
  assert.equal(stats.complete, true);
  assert.equal(stats.observedLive, false);
  assert.equal(stats.outputTokens, null);
  const section = h.body.appendChild(new Element('section'));
  section.dataset.turnId = 'pt1';
  h.runTimers(500);
  assert.equal(h.deterministic().length, 0);   // 不插行：既不编造数字，也不误报"不可用"
  assert.equal(turnRequests(h).length, 0);     // 也不白跑一次数据库旁路查询
});

test('⑯c after a store epoch change re-projects a turn without output fields, its existing line is kept', () => {
  const h = harness();
  const store = driveStreaming(h);
  const { line } = completeTurn(h, store);   // 亲历完成：占位行
  assert.match(line().textContent, /250\.0 token\/s\(本轮\)/);
  store.set(snap(4, [header('completedSuccess'), text('abcdef')], 'sid_a', 'e2'));   // 宿主 store 换代重投影：历史轮不再带 outputTokens
  h.runTimers(500);
  assert.equal(h.deterministic().length, 1);
  assert.match(line().textContent, /250\.0 token\/s\(本轮\)/);   // 保留已有文本，不翻成"不可用"
});

test('⑯e a turn that slid out of the snapshot window keeps its line (window slide ≠ record loss)', () => {
  const h = harness();
  const store = driveStreaming(h);
  const { line } = completeTurn(h, store);
  assert.match(line().textContent, /250\.0 token\/s\(本轮\)/);
  // 新一轮把旧轮挤出 ≤60 行快照窗口：同 session/epoch，窗口里不再有 t1 的任何行 → tracker 删除其记录
  store.set(snap(4, [{ rowId: 9, turnId: 't2', productTurnId: 'pt2', kind: 'turnHeader', state: 'running' }], 'sid_a', 'e1'));
  h.runTimers(500);
  assert.equal(instanceOf(h).statsFor('pt1'), null);
  assert.equal(h.deterministic().length, 1);
  assert.match(line().textContent, /250\.0 token\/s\(本轮\)/);   // 保留：已完成轮的数字不会过时
});

test('⑯d an "unavailable" line left on a historical turn without output fields is removed', () => {
  const h = harness();
  h.setPanes(['a']);
  h.inject(); h.boot();
  h.runTimers(600);
  const store = makeStore(snap(1, [header('completedSuccess'), text('abcdef')]));
  h.diagSessions.push({ key: '__base__ /fixture/ws', topic: 'conversation/sid_a', store });
  h.runTimers(500);
  // 修复前版本已经插进去的误报行（热更新后仍在 DOM 里）
  const section = h.body.appendChild(new Element('section'));
  section.dataset.turnId = 'pt1';
  const stale = section.appendChild(new Element('blockquote'));
  stale.dataset.zusageDeterministic = '1';
  const p = stale.appendChild(new Element('p'));
  p.dataset.zusageDeterministic = '1';
  p.textContent = '⚡ 本轮统计不可用(本轮)';
  h.runTimers(500);
  assert.equal(h.deterministic().length, 0);   // 撤下误报行，而不是保留或重插
});

test('⑰ a turn observed from "running" still shows its real rate normally (observedLive guard does not over-suppress)', () => {
  const h = harness();
  const store = driveStreaming(h);
  const { line } = completeTurn(h, store);
  // 从 running 一路追踪到 complete：observedLive 应为 true，悬浮条正常显示真实速度，
  // 不会被这次新增的"历史存量"过滤误伤。
  assert.equal(instanceOf(h).statsFor('pt1').observedLive, true);
  assert.equal(instanceOf(h).liveEl().textContent, '250.0 t/s');
  assert.equal(instanceOf(h).liveEl().className, 'zu-live zu-sky');   // 250 t/s ∈ 200–300 快速档（v127 十档）
  assert.equal(line().textContent, '⚡ 250.0 token/s(本轮) · 输出 1,000 token · 耗时 5.0s');
});

/* ---------- v78：消息流 loading 插槽状态词已删（[data-zusage-loading-status]） ---------- */
function toolRow(status, extra = {}) {
  return { rowId: 5, turnId: 't1', productTurnId: 'pt1', kind: 'toolCall',
           toolName: 'Read', inputText: '{}', status, ...extra };
}

test('⑱ tool running in the message flow never inserts a status word (v78 removed the feature)', () => {
  const h = harness();
  const store = driveStreaming(h);
  const section = h.body.appendChild(new Element('section'));
  section.dataset.turnId = 'pt1';
  const slot = section.appendChild(new Element('div'));
  slot.setAttribute('data-zcode-chat-loading-slot', 'true');
  slot.appendChild(new Element('div')).setAttribute('data-zcode-chat-loading-animate', 'true');
  store.set(snap(3, [header('running'), text('abc'), toolRow('running', { startedAt: Date.now() })]));
  h.runTimers(500);
  assert.equal(h.body.collect('[data-zusage-loading-status]', []).length, 0);
});

test('⑲ stale status words from an older generation are removed on dispose', () => {
  const h = harness();
  driveStreaming(h);   // 先驱动 overlay 装配（__zusageDispose 在此挂上）
  // 模拟旧版本残留：直接往 body 塞一个带属性的 span（v76 时代的真实节点形态）
  const stale = h.body.appendChild(new Element('span'));
  stale.setAttribute('data-zusage-loading-status', '1');
  stale.textContent = '正在读取 · 1.0s';
  h.window.__zusageDispose();
  assert.equal(h.body.collect('[data-zusage-loading-status]', []).length, 0);
});

test('⑳ deterministic history line renders at the reduced inline font size (v78)', () => {
  const h = harness();
  const store = driveStreaming(h);
  const { line } = completeTurn(h, store);
  assert.equal(line().style.fontSize, '0.8125rem');   // 内联样式，宿主正文号不再适用
  assert.equal(line().textContent, '⚡ 250.0 token/s(本轮) · 输出 1,000 token · 耗时 5.0s');
});

test('㉑ deterministic line lands before the hover action row and after the closed popover (v79)', () => {
  const h = harness();
  const store = driveStreaming(h);
  h.clock.now = 1600;
  store.set(snap(3, [header('completedSuccess', { outputTokens: 1000, modelDurationMs: 4000, activeMs: 5000 }), text('abcdef')]));
  const section = h.body.appendChild(new Element('section'));
  section.dataset.turnId = 'pt1';
  section.appendChild(new Element('div'));                                   // 正文内容
  const popover = section.appendChild(new Element('div'));
  popover.setAttribute('data-state', 'closed');                              // 弹出层（已关闭）
  const actions = section.appendChild(new Element('div'));                   // hover 工具条
  actions.className = 'flex items-center gap-1 opacity-0 transition-opacity ' +
    'group-hover/assistant-turn:opacity-100 focus-within:opacity-100 ' +
    'has-[[data-bot-group-delivery]]:opacity-100';
  h.runTimers(500);
  const quote = h.deterministic()[0];
  const kids = section.children;
  const at = kids.indexOf(quote);
  assert.ok(at > 0, 'blockquote 已插入容器');
  assert.equal(kids[at - 1], popover, '统计行在 data-state=closed 弹出层之后');
  assert.equal(kids[at + 1], actions, '统计行在 hover 工具条之前');
  // React 重排兜底：工具条被移到统计行之后时，下一个 tick 应摆回来
  section.insertBefore(quote, null);   // 挪到末尾（模拟宿主重排后统计行落在工具条后）
  h.runTimers(500);
  assert.equal(section.children.indexOf(quote) + 1, section.children.indexOf(actions), '重排后被摆回工具条之前');
});

test('㉒ new-session layout: line lands inside the nested content column, above the nested action row (v82)', () => {
  /* 新开会话的真实结构：turn 容器直接子层没有工具条，它嵌在
   * group/assistant-turn flex w-full flex-col gap-5 → flex flex-col gap-5 内容列末尾。
   * v82 深度锚点：insertBefore 落在锚的父容器（内容列）内、工具条之上。 */
  const h = harness();
  const store = driveStreaming(h);
  h.clock.now = 1600;
  store.set(snap(3, [header('completedSuccess', { outputTokens: 1000, modelDurationMs: 4000, activeMs: 5000 }), text('abcdef')]));
  const section = h.body.appendChild(new Element('section'));
  section.dataset.turnId = 'pt1';
  const turnRow = section.appendChild(new Element('div'));
  turnRow.className = 'group/assistant-turn flex w-full flex-col gap-5';
  const col = turnRow.appendChild(new Element('div'));
  col.className = 'flex flex-col gap-5';                                      // 内容列
  col.appendChild(new Element('div'));                                        // 正文内容
  const actions = col.appendChild(new Element('div'));                        // 工具条嵌在内容列末尾
  actions.className = 'flex items-center gap-1 opacity-0 transition-opacity ' +
    'group-hover/assistant-turn:opacity-100 focus-within:opacity-100 ' +
    'has-[[data-bot-group-delivery]]:opacity-100';
  h.runTimers(500);
  const quote = h.deterministic()[0];
  assert.equal(quote.parentElement, col, '统计行挂进内容列（flex flex-col gap-5）');
  assert.equal(col.children[col.children.length - 2], quote, '内容列内倒数第二位');
  assert.equal(col.children[col.children.length - 1], actions, 'hover 工具条仍在统计行之后');
  // React 重排兜底：被挪到 section 末尾后，下一 tick 摆回内容列内工具条之前
  section.insertBefore(quote, null);
  h.runTimers(500);
  assert.equal(quote.parentElement, col, '重排后回到内容列');
  assert.equal(col.children.indexOf(quote) + 1, col.children.indexOf(actions), '仍贴在工具条之前');
});

test('㉓ v87 synthetic thinking fires only for empty-window draft or phase=running, never for sessions with rows but no header in the tail window (v116)', () => {
  /* 宿主源码证实：wire 快照 rows.window 恒为全序尾 60 行，末轮行数超窗口的闲置
   * 会话整窗没有 turnHeader；旧条件「行非空」让这类会话永久合成"思考中"
   * （用户停了任务还亮着、切走切回每次重绑重新计时）。v116 收紧为：
   * 显式 phase=running（verifier/长轮 header 滑出，轮真的活着），或显式
   * phase=draft 且窗口为空（新会话空窗，v87 本意）；control 缺失或 phase
   * 未知的旧形状一律不合成。子场景按判别因子正交展开，防「删掉某析取项」的
   * 等价变异存活。 */
  const h = harness();
  h.setPanes(['a']);
  h.inject(); h.boot();
  h.runTimers(600);
  const idleRows = [text('abcdef'),
    { rowId: 3, turnId: 't1', productTurnId: 'pt1', kind: 'toolCall', toolName: 'Bash', inputText: '', status: 'success' }];
  const withControl = (seq, rows, phase) =>
    Object.assign(snap(seq, rows), phase === undefined ? {} : { control: { phase } });
  const store = makeStore(withControl(1, idleRows, 'completedInterrupted'));
  h.diagSessions.push({ key: '__base__ /fixture/ws', topic: 'conversation/sid_a', store });
  h.runTimers(100);
  assert.equal(instanceOf(h).liveEl(), null, '① 闲置：行非空 + 无 header + phase 终态 → 不合成');
  // 行非空 + 非终态 phase（draft）→ 仍不合成：合成只认 running，行非空本身不是活性证据
  store.set(withControl(2, idleRows, 'draft'));
  h.runTimers(100);
  assert.equal(instanceOf(h).liveEl(), null, '② 行非空 + draft → 不合成（杀「running||非终态」等价变异）');
  // control 整体缺失（旧宿主形状）：不合成
  store.set(withControl(3, idleRows, undefined));
  h.runTimers(100);
  assert.equal(instanceOf(h).liveEl(), null, '③ control 缺失 → 不合成（字段缺失是常态不是错误）');
  // goal verifier 启动：只加 timelineMarker 不加 turnHeader（product-projection.ts:5136），phase=running
  store.set(withControl(4, idleRows.concat([{ rowId: 4, kind: 'timelineMarker', lane: 'turnTailBoundary' }]), 'running'));
  h.runTimers(100);
  assert.match(instanceOf(h).liveEl().textContent, /^思考中…\d+秒$/, '④ phase=running（无 header）仍合成思考中');
  // 新会话 draft 空窗（v87 本意）
  store.set(withControl(5, [], 'draft'));
  h.runTimers(100);
  assert.match(instanceOf(h).liveEl().textContent, /^思考中…/, '⑤ draft 空窗仍合成思考中');
  // 空窗但 phase 已终态（rewind 清空等）：三种终态都不合成
  store.set(withControl(6, [], 'completedSuccess'));
  h.runTimers(100);
  assert.equal(instanceOf(h).liveEl(), null, '⑥a 空窗 + completedSuccess → 不合成');
  store.set(withControl(7, [], 'completedInterrupted'));
  h.runTimers(100);
  assert.equal(instanceOf(h).liveEl(), null, '⑥b 空窗 + completedInterrupted → 不合成');
  store.set(withControl(8, [], 'error'));
  h.runTimers(100);
  assert.equal(instanceOf(h).liveEl(), null, '⑥c 空窗 + error → 不合成');
});

test('㉓b thinking elapsed anchors to turnHeader.startedAt (host writes it at header creation), not first observation (v116)', () => {
  const h = harness();
  const store = driveStreaming(h);   // t=1000，'1.5 t/s'
  store.set(snap(3, [header('running', { startedAt: Date.now() - 4200 }), text('abcdef')]));
  h.clock.now = 3100;   // 字符流停滞 >2s：characterRate 失效进入思考态
  h.runTimers(100);     // 仅心跳驱动（无新快照），同 ⑪
  // observedMs（首观测 t=0 起算）会显示 3 秒；锚定 startedAt（4.2s 前创建）应显示 4 秒——
  // 切走再切回重绑后计时不再从 0 重计。墙钟余量 ~800ms（构造到断言需超时 4.2s→5s 才假红）
  assert.equal(instanceOf(h).liveEl().textContent, '思考中…4秒');
});
