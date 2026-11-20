const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {};
    this.style.setProperty = (k, v) => { this.style[k] = v; };
    this.style.getPropertyValue = k => this.style[k] || '';
    this.listeners = new Map(); this.queries = new Map(); this.classes = new Set();
    this.classList = { contains: k => this.classes.has(k), add: k => this.classes.add(k), remove: k => this.classes.delete(k),
      toggle: (k, on) => { if (on) this.classes.add(k); else this.classes.delete(k); } };
    this.textContent = ''; this.innerHTML = ''; this.attributes = []; this.isConnected = true;
  }
  setAttribute(k, v) { this.dataset[k] = String(v); }
  removeAttribute(k) { delete this.dataset[k]; }
  addEventListener(type, fn) { const a = this.listeners.get(type) || []; a.push(fn); this.listeners.set(type, a); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(f => f !== fn)); }
  count() { return [...this.listeners.values()].reduce((a, b) => a + b.length, 0); }
  appendChild(el) { this.children.push(el); el.parentElement = this; el.isConnected = true; return el; }
  insertBefore(el, ref) {   // v80 in-card 挂载依赖；ref 不属于本节点时按真实 DOM 语义退化为 append
    if (!ref || ref.parentElement !== this) return this.appendChild(el);
    const idx = this.children.indexOf(ref);
    if (el.parentElement) el.remove();
    this.children.splice(idx, 0, el);
    el.parentElement = this;
    return el;
  }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(e => e !== this); this.parentElement = null; this.isConnected = false; }
  // v280：模块级 Portal（spdHoverPortal）创建路径用到 setAttribute / classList（补夹具纪律）
  setAttribute(k, v) { this.dataset[k] = v; }
  classList = { toggle() {}, add() {}, remove() {} };
  querySelector(k) { if (!this.queries.has(k)) this.queries.set(k, new Element()); return this.queries.get(k); }
  querySelectorAll() { return []; }
  contains(el) { return el === this || this.children.some(e => e.contains(el)); }
  closest() { return null; }
  hasAttribute(k) { return k === 'data-pane-id' ? !!this.pid : k === 'data-session-id' ? !!this.sid : Object.prototype.hasOwnProperty.call(this.dataset, k); }
  getAttribute(k) { return k === 'data-pane-id' ? this.pid : k === 'data-session-id' ? this.sid : this.dataset[k] ?? null; }
  getBoundingClientRect() { return { top: 600, bottom: 650, left: 20, right: 520, width: 500, height: 50 }; }
}
function harness(ls = { getItem: () => null, setItem() {} }) {
  const window = new Element(), body = new Element('body'), root = new Element('html');
  Object.assign(window, { innerWidth: 1000, innerHeight: 800 });
  let panes = [];
  const document = new Element();
  Object.assign(document, { body, documentElement: root, createElement: tag => new Element(tag),
    getElementById: id => body.children.find(e => e.id === id),
    querySelectorAll: selector => selector.startsWith('textarea,') ? panes : [],
    elementFromPoint: () => panes[0] || body });
  const timers = new Map(), frames = new Map(), observers = []; let id = 0;
  const sandbox = vm.createContext({ window, document, console, innerHeight: 800, innerWidth: 1000,
    location: { href: 'file:///fixture' }, localStorage: ls,
    // v349 规则 18：overlay 的 tick 降频门用 performance.now 计单拍成本——夹具冻结为 0，
    // 既有用例恒判廉价、门永不介入；需注入耗时的用例在 inject 后经 sandbox 重写
    // performance/Date.now（vm 上下文内全局赋值）。
    performance: { now: () => 0 },
    getComputedStyle: el => ({ borderTopWidth: '1px', backgroundColor: 'black', opacity: el.style.opacity ?? '1', display: el.style.display ?? 'block', visibility: el.style.visibility ?? 'visible' }),
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms, interval: false }); return id; },
    clearTimeout: n => timers.delete(n),
    setInterval: (fn, ms) => { timers.set(++id, { fn, ms, interval: true }); return id; },
    clearInterval: n => timers.delete(n),
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; }, cancelAnimationFrame: n => frames.delete(n),
    MutationObserver: class { constructor(fn) { this.fn = fn; this.connected = false; observers.push(this); } observe() { this.connected = true; } disconnect() { this.connected = false; } },
  });
  const executable = source.replace(/\}\)\(\);\s*$/, 'window.lifecycleTest = { instances: function() { return instances; }, setBarTheme: function(t) { setBarTheme(t); } };})();');
  function inject() { window.__zusageOverlay = false; vm.runInContext(executable, sandbox); }
  function tick() { for (const t of [...timers.values()]) if (t.interval && t.ms === 600) t.fn(); }
  function boot() { for (const [n, t] of [...timers]) if (!t.interval && t.ms === 0) { timers.delete(n); t.fn(); } }
  function setPanes(keys, opts = {}) {
    panes = keys.map(k => { const card = body.appendChild(new Element()); card.style.marginBottom = k + 'px';
      const e = card.appendChild(new Element('textarea')); e.pid = k; e.sid = 'sid_' + k;
      if (opts.toolbar) {   // v80 in-card 夹具：宿主卡片最后一个子块是 group/toolbar 工具行
        const row = card.appendChild(new Element());
        row.className = 'group/toolbar flex items-end gap-3';
      }
      return e; });
    return panes.map(e => e.parentElement);
  }
  return { window, document, root, body, timers, frames, observers, sandbox, inject, tick, boot, setPanes,
    runFrame() { for (const [n, fn] of [...frames]) fn(); } };
}

test('coordinator quota counts only live panes and handles more than four sequential IDs', () => {
  const h = harness(); h.setPanes(['a', 'b', 'c', 'd', 'overflow']); h.inject(); h.boot();
  assert.equal(h.window.lifecycleTest.instances().length, 4);
  assert.equal(h.frames.size, 4);
  const old = [...h.window.lifecycleTest.instances()];
  h.setPanes(['e', 'f', 'g', 'h']); h.tick();
  assert.deepEqual(Array.from(h.window.lifecycleTest.instances(), e => e.pid), ['e', 'f', 'g', 'h']);
  assert.equal(h.frames.size, 4);
  /* v105 起每实例两个常连观察器：theme + 弹层压缩按钮的 body 观察器（4 实例 × 2）。 */
  assert.equal(h.observers.filter(e => e.connected).length, 8);
  old.forEach(e => e.dispose());
  assert.equal(h.frames.size, 4);
  h.window.__zusageDispose();
  assert.equal(h.frames.size, 0); assert.equal(h.timers.size, 0);
  assert.equal(h.document.count() + h.window.count() + h.root.count(), 0);
  assert.equal(h.observers.filter(e => e.connected).length, 0);
  assert.equal(h.body.children.filter(e => /zusage/.test(e.className || '')).length, 0);
});

test('padding release touches only the owning card and dispose restores original margins', () => {
  const h = harness(), cards = h.setPanes(['a', 'b']); h.inject(); h.boot();
  assert.equal(cards[0].style.marginBottom, '24px'); assert.equal(cards[1].style.marginBottom, '24px');
  h.window.lifecycleTest.instances()[0].dispose();
  assert.equal(cards[0].style.marginBottom, 'apx'); assert.equal(cards[1].style.marginBottom, '24px');
  h.window.__zusageDispose(); assert.equal(cards[1].style.marginBottom, 'bpx');
});

test('v146 compact theme: bar hides on body, heavy keeps it alive, no pads; leaving remounts in-card', () => {
  const store = new Map([['zusage3.theme', 'compact']]);
  const h = harness({ getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) });
  const cards = h.setPanes(['a', 'b'], { toolbar: true }); h.inject(); h.boot();
  const barA = h.document.body.children.find(e => /zusage-root/.test(e.className || ''));
  assert.ok(barA, 'bar stays mounted');
  assert.ok(barA.classList.contains('zu-compact'), 'compact class marks the theme');
  assert.equal(barA.getAttribute('data-zusage-theme'), 'compact');
  assert.equal(barA.style.display, 'none', 'bar is permanently hidden in compact mode');
  assert.equal(barA.parentElement, h.document.body, 'bar lives on body, detached from the card');
  assert.equal(cards[0].style.marginBottom, 'apx', 'no card pad in compact mode');
  // React 清子树场景：条被移除后 heavy（600ms）必须补挂回 body（<style> 随条，丢了 chip 样式全灭）
  barA.remove();
  h.tick();
  assert.equal(barA.parentElement, h.document.body);
  assert.equal(barA.isConnected, true);
  assert.equal(barA.style.display, 'none');
  // 切回默认：立即重挂工具行之后（in-card），track 帧恢复 flex 显示
  h.window.lifecycleTest.setBarTheme('default');
  const [barInCard] = cards[0].children.filter(e => /zusage-root/.test(e.className || ''));
  assert.ok(barInCard, 'bar is back inside the card');
  assert.ok(barInCard.classList.contains('zu-in'));
  assert.equal(store.get('zusage3.theme'), 'default', 'theme choice persisted');
  h.runFrame();
  assert.equal(barInCard.style.display, 'flex', 'track frame restores visibility');
});

/* v177：v169 双条去重的抑制不被 track 每帧复显打穿——heavy（600ms）锁 dupSuppress 并隐藏，
 * 此前 track 帧无条件复显 flex，次帧起双条永久并存（Windows 最小化/还原场景失效）。 */
test('v177 dedup: track frames cannot re-show a bar suppressed by a smaller-slot rival', () => {
  const h = harness(), cards = h.setPanes(['a', 'b'], { toolbar: true }); h.inject(); h.boot();
  const barB = cards[1].children.find(e => /zusage-root/.test(e.className || ''));
  assert.ok(barB, 'instance b bar mounted in card');
  assert.equal(barB.getAttribute('data-zusage-slot'), '1', 'harness sanity: bar b owns slot 1');
  // 桩 elementFromPoint 恒返 panes[0]（composer b 会被判"被盖"→ track 永远隐藏）：
  // 命中点指向 composer 本体，让可见性判定走通
  const paneB = cards[1].children.find(e => e.tagName === 'TEXTAREA');
  h.document.elementFromPoint = () => paneB;
  h.tick();
  h.runFrame();
  assert.equal(barB.style.display, 'flex', 'track frame shows the bar before any rival');
  // 同卡对手（slot 更小、可见）：heavy 让位隐藏
  const rival = cards[1].appendChild(new Element('div'));
  rival.className = 'zusage-root';
  rival.setAttribute('data-zusage-slot', '0');
  cards[1].querySelectorAll = (sel) => sel === '.zusage-root' && rival.isConnected ? [rival] : [];
  h.tick();
  assert.equal(barB.style.display, 'none', 'heavy hides the higher-slot bar');
  h.runFrame();
  assert.equal(barB.style.display, 'none', 'track frame must not re-show while suppressed');
  h.tick(); h.runFrame();
  assert.equal(barB.style.display, 'none', 'suppression persists across heavy+track cycles');
  // 对手退场：heavy 解除抑制，下一帧复显
  rival.remove();
  h.tick(); h.runFrame();
  assert.equal(barB.style.display, 'flex', 'bar re-shows after the rival disappears');
});

/* v177：setComposer 落在宿主「composer 已挂、data-session-id 未写」窗口期时 detRootEl
 * 为 null 且元素引用不变不再重进 setComposer——heavy 按拍补算让 det 统计行归属链自愈。 */
test('v177: detRoot self-heals when the host writes data-session-id after composer mount', () => {
  const h = harness(), cards = h.setPanes(['workspace-main'], { toolbar: true });
  h.inject(); h.boot();
  const TAB = 'selection-side-chat:%2Fp:late:sid';
  const side = sidePaneFixture(h, TAB, null, {});   // 先无 sid：命中窗口期
  h.tick();
  const inst = h.window.lifecycleTest.instances().find(i => i.pid === TAB);
  assert.ok(inst, 'side chat instance spawned without a session root yet');
  assert.equal(inst.detRoot(), null, 'no session root inside the window');
  side.rootEl.sid = 'sess_late';   // 宿主补写 data-session-id
  h.tick();
  assert.equal(inst.detRoot(), side.rootEl, 'heavy recompute picks up the late session root');
  h.window.__zusageDispose();
});

test('v80 in-card mount: bar lands inside the card after the toolbar row, no pad, no fixed styles', () => {
  const h = harness(), cards = h.setPanes(['a', 'b'], { toolbar: true }); h.inject(); h.boot();
  const [barA] = cards[0].children.filter(e => /zusage-root/.test(e.className || ''));
  const [barB] = cards[1].children.filter(e => /zusage-root/.test(e.className || ''));
  assert.ok(barA && barB, '两条分别挂进各自卡片');
  assert.equal(barA.classList.contains('zu-in'), true, 'in-card 形态类已加');
  assert.notEqual(barA.style.position, 'fixed', '内联 fixed 已摘除');
  assert.equal(cards[0].style.marginBottom, 'apx', 'in-card 形态不加 24px 让位带');
  // 位置：工具行之后（末尾无后续节点时 append 同语义）
  assert.equal(cards[0].children.indexOf(barA) > cards[0].children.findIndex(e => /group\/toolbar/.test(e.className || '')), true);
  // React 整子树重挂兜底（两条路径）：帧级对账（track/rAF）与周期对账（heavy/600ms）
  barA.remove();
  h.runFrame();
  assert.equal(barA.parentElement, cards[0], 'track 帧对账重挂回卡片');
  assert.equal(barA.classList.contains('zu-in'), true);
  barA.remove();
  h.tick();
  assert.equal(barA.parentElement, cards[0], 'heavy 周期对账兜底同样重挂');
  h.window.lifecycleTest.instances()[0].dispose();
  assert.equal(cards[0].children.includes(barA), false, 'dispose 从卡片摘除');
  h.window.__zusageDispose();
  assert.equal(cards[1].children.includes(barB), false);
});

/* v405（issue #408）：默认主题下，宿主 elicitation（问询/权限确认）面板打开时
 * chat-composer-region display:none、面板内回答输入框成为 pane 候选；该面板卡没有
 * group/toolbar 工具行，旧 mountInCard 失败 → below-card 悬浮胶囊（用户实报的「默认
 * 样式底部药丸态」）。现在条应平铺进面板内容列（footer 之后），沿用 .zu-in，不上 body。 */
test('v405 elicitation panel: default theme mounts flat inside the panel card after the footer', () => {
  const h = harness(), [card] = h.setPanes(['a']);
  const ta = card.children[0];
  const wrapper = new Element();
  wrapper.className = 'flex min-h-0 flex-1 flex-col gap-3 p-3';
  card.children = [wrapper]; wrapper.parentElement = card; wrapper.isConnected = true;
  wrapper.appendChild(ta);
  const footer = wrapper.appendChild(new Element());
  footer.setAttribute('data-elicitation-dialog-footer', 'true');
  card.setAttribute('data-elicitation-dialog-card', 'true');
  // 宿主面板内的回答输入框：closest 命中面板卡（panelCardOf 的锚点改判）
  ta.closest = sel => sel === '[data-elicitation-dialog-card]' ? card : null;
  card.queries.set('[data-elicitation-dialog-footer]', footer);
  h.inject(); h.boot(); h.runFrame();
  const bar = wrapper.children.find(e => /zusage-root/.test(e.className || ''));
  assert.ok(bar, '条已挂载');
  assert.equal(bar.parentElement, wrapper, '条平铺在面板内容列内，不再回落 body 悬浮胶囊');
  assert.equal(bar.classList.contains('zu-in'), true, '默认主题沿用 .zu-in 扁平外观');
  assert.notEqual(bar.style.position, 'fixed', '无兜底 fixed 定位');
  assert.ok(wrapper.children.indexOf(bar) > wrapper.children.indexOf(footer), '条位于 footer 之后');
  /* 夹具 appendChild 不像真实 DOM 那样从旧父节点摘除，按 parentElement 判归属 */
  const bodyBars = h.body.children.filter(e => /zusage-root/.test(e.className || '') && e.parentElement === h.body);
  assert.equal(bodyBars.length, 0, 'body 上不留悬浮条: ' + bodyBars.map(b => b.getAttribute('data-zusage-slot') + '/' + b.className).join(','));
  // React 重挂面板子树：帧级与 heavy 对账都按实际宿主 wrapper 补挂
  // （夹具 remove() 清 parentElement：mountInCard 的 parentElement 判定会真实重挂，
  //  isConnected/成员断言防止「parentElement 陈旧引用」让对账断言空洞）
  bar.remove();
  h.runFrame();
  assert.equal(bar.parentElement, wrapper, 'track 帧对账重挂回面板内容列');
  assert.equal(bar.isConnected, true, 'track 帧重挂后真实连通（非陈旧引用）');
  bar.remove();
  h.tick();
  assert.equal(bar.parentElement, wrapper, 'heavy 周期对账同样重挂');
  assert.equal(bar.isConnected, true, 'heavy 重挂后真实连通');
  h.window.__zusageDispose();
});

/* v405 去重平局语义（review 补）：同 slot 对手互不压制（barSlot 严格小于才让位）——
 * `<=` 回归会让两根同 slot 条互见双隐（比并存更糟）。 */
test('v405 dedup tie: same-slot rivals do not suppress each other', () => {
  const h = harness(), [card] = h.setPanes(['a']);
  const ta = card.children[0];
  const wrapper = new Element();
  wrapper.className = 'flex min-h-0 flex-1 flex-col gap-3 p-3';
  card.children = [wrapper]; wrapper.parentElement = card; wrapper.isConnected = true;
  wrapper.appendChild(ta);
  const footer = wrapper.appendChild(new Element());
  footer.setAttribute('data-elicitation-dialog-footer', 'true');
  card.setAttribute('data-elicitation-dialog-card', 'true');
  ta.closest = sel => sel === '[data-elicitation-dialog-card]' ? card : null;
  card.queries.set('[data-elicitation-dialog-footer]', footer);
  h.inject(); h.boot(); h.runFrame();
  const bar = wrapper.children.find(e => /zusage-root/.test(e.className || ''));
  assert.ok(bar, '条已平铺进面板内容列');
  assert.equal(bar.getAttribute('data-zusage-slot'), '0', 'harness sanity: 单实例 slot 0');
  const tie = wrapper.appendChild(new Element('div'));
  tie.className = 'zusage-root';
  tie.setAttribute('data-zusage-slot', '0');   // 与本实例同 slot（v169 陈旧视图副本形态）
  card.querySelectorAll = sel => sel === '.zusage-root' && tie.isConnected ? [tie] : [];
  h.document.elementFromPoint = () => ta;
  h.tick();
  assert.equal(bar.style.display, 'flex', '同 slot 平局不让位（<= 变异在此变红：双条双隐）');
  h.window.__zusageDispose();
});

/* v405 cardHost 去重语义（review 补）：同卡判定按实际宿主 wrapper 而非 cardCache——
 * 面板场景双条同落内容列时 slot 大的让位（v169 规则对新挂载目标同样成立）。
 * 变异：sameCard 回退 cardCache 判定 → 对手被 continue 跳过 → 双条并存互不压制。 */
test('v405 elicitation dedup: panel wrapper rivals are matched via cardHost, not cardCache', () => {
  const h = harness(), cards = h.setPanes(['a', 'b']);
  const taA = cards[0].children[0], taB = cards[1].children[0];
  const wrapper = new Element();
  wrapper.className = 'flex min-h-0 flex-1 flex-col gap-3 p-3';
  cards[0].children = [wrapper]; wrapper.parentElement = cards[0]; wrapper.isConnected = true;
  wrapper.appendChild(taA); wrapper.appendChild(taB);
  const footer = wrapper.appendChild(new Element());
  footer.setAttribute('data-elicitation-dialog-footer', 'true');
  cards[0].setAttribute('data-elicitation-dialog-card', 'true');
  // 面板打开时两 pane 候选都锚到同一面板卡（v169「宿主保留旧视图副本」的双实例形态）
  taA.closest = taB.closest = sel => sel === '[data-elicitation-dialog-card]' ? cards[0] : null;
  cards[0].queries.set('[data-elicitation-dialog-footer]', footer);
  h.inject(); h.boot(); h.runFrame();
  const barsIn = () => wrapper.children.filter(e => /zusage-root/.test(e.className || '') && e.parentElement === wrapper);
  assert.equal(barsIn().length, 2, '两实例双条同落面板内容列');
  // 对手收集走 cardCache.querySelectorAll：桩按 wrapper 实况应答（含两根条）
  cards[0].querySelectorAll = sel => sel === '.zusage-root' ? wrapper.children.filter(e => /zusage-root/.test(e.className || '')) : [];
  // 命中点 taA 同在 cardCache 子树：两实例的卡内豁免都放行（barA 自身命中、barB 走 coverOK）
  h.document.elementFromPoint = () => taA;
  h.tick();
  const [barA, barB] = barsIn();
  assert.equal(barB.getAttribute('data-zusage-slot'), '1', 'harness sanity: bar b owns slot 1');
  assert.equal(barB.style.display, 'none', '同宿主对手经 cardHost 判定：slot 1 让位隐藏');
  h.runFrame();
  assert.equal(barB.style.display, 'none', 'dupSuppress 不被 track 复显打穿（v177 规则沿袭）');
  h.window.__zusageDispose();
});

/* v405 cardHost 重置语义（review 补）：面板关闭（属性摘除）→ heavy 回落 below-card 时
 * cardHost 必须清空，否则去重按陈旧宿主把几何无关的残留对手误判同卡、错误压制。 */
test('v405 mountBelowCard resets cardHost so stale wrapper rivals cannot suppress after panel close', () => {
  const h = harness(), cards = h.setPanes(['a', 'b']);
  const taB = cards[1].children[0];
  const wrapper = new Element();
  wrapper.className = 'flex min-h-0 flex-1 flex-col gap-3 p-3';
  cards[1].children = [wrapper]; wrapper.parentElement = cards[1]; wrapper.isConnected = true;
  wrapper.appendChild(taB);
  const footer = wrapper.appendChild(new Element());
  footer.setAttribute('data-elicitation-dialog-footer', 'true');
  cards[1].setAttribute('data-elicitation-dialog-card', 'true');
  taB.closest = sel => sel === '[data-elicitation-dialog-card]' && cards[1].hasAttribute('data-elicitation-dialog-card') ? cards[1] : null;
  cards[1].queries.set('[data-elicitation-dialog-footer]', footer);
  // 命中点指向 composer 本体（v177 先例）：默认桩返回 panes[0]=taA 不在 b 卡内，遮挡判定会藏条
  h.document.elementFromPoint = () => taB;
  h.inject(); h.boot(); h.runFrame();
  const barB = wrapper.children.find(e => /zusage-root/.test(e.className || ''));
  assert.ok(barB && barB.parentElement === wrapper, 'sanity: b 实例平铺进面板内容列');
  // 面板关闭：宿主摘掉面板标记；wrapper 里残留一条几何无关的陈旧对手（矩形远离 body 兜底位）
  const stale = wrapper.appendChild(new Element('div'));
  stale.className = 'zusage-root';
  stale.setAttribute('data-zusage-slot', '0');
  stale.getBoundingClientRect = () => ({ top: 0, bottom: 20, left: 0, right: 60, width: 60, height: 20 });
  // 对手收集走 cardCache.querySelectorAll（夹具恒 []）：按 wrapper 实况应答
  cards[1].querySelectorAll = sel => sel === '.zusage-root' && stale.isConnected ? [stale] : [];
  cards[1].removeAttribute('data-elicitation-dialog-card');
  h.tick();
  assert.equal(barB.parentElement, h.document.body, '面板标记摘除后 heavy 回落 below-card 兜底');
  assert.equal(barB.style.display, 'flex', 'cardHost 已重置：几何无关的陈旧对手走矩形判定、不压制');
  h.window.__zusageDispose();
});

test('reinjection and repeated cleanup leave one live generation', () => {
  const h = harness(); h.setPanes(['a']); h.inject(); h.boot();
  const cleanup = h.window.__zusageDispose;
  h.inject(); h.boot(); cleanup();
  assert.equal(h.frames.size, 1); assert.equal(h.observers.filter(e => e.connected).length, 2);   // v105：theme + 弹层压缩按钮 body 观察器
  // 六个桌面循环：coordinator/heavy(600ms)、rate/deterministic/bridge(2s)、rotator(65ms)。
  assert.equal([...h.timers.values()].filter(t => t.interval).length, 6);
  assert.equal(h.timers.size, 6);
  h.window.__zusageDispose(); cleanup();
  assert.equal(h.timers.size, 0); assert.equal(h.frames.size, 0);
  assert.deepEqual(Array.from(h.window.__zusageWantSids), []); assert.equal(h.window.__zusageWantSid, '');
});

test('node scope changes with the same sid are reflected by the live instance immediately', () => {
  const h = harness(), [card] = h.setPanes(['workspace-main']);
  const composer = card.children[0], A = 'remote:ssh:a:22:u:/p', B = 'remote:ssh:b:22:u:/p';
  Object.assign(composer.dataset, {
    'data-zusage-scope-version': '1', 'data-zusage-pane-id': 'workspace-main',
    'data-zusage-workspace-path': '/p', 'data-zusage-workspace-identity': A,
    'data-zusage-remote-session-id': 'connectionA',
  });
  h.inject(); h.boot();
  const inst = h.window.lifecycleTest.instances()[0];
  assert.equal(inst.getScope().identity, A);
  assert.equal(h.window.__zusagePaneScopes['workspace-main'].identity, A);
  composer.dataset['data-zusage-workspace-identity'] = B;
  composer.dataset['data-zusage-remote-session-id'] = 'connectionB';
  assert.equal(inst.getScope().identity, B);
  h.tick();
  assert.equal(h.window.__zusagePaneScopes['workspace-main'].identity, B);
  delete composer.dataset['data-zusage-scope-version'];
  assert.equal(inst.getScope(), null);
  h.tick();
  assert.equal(h.window.__zusagePaneScopes['workspace-main'].identity, undefined);
  composer.isConnected = false;
  assert.equal(inst.getScope(), null);
  h.window.__zusageDispose();
});

test('empty main document actually creates the auto shadow/iframe fallback instance', () => {
  const h = harness(); h.inject(); h.boot();
  assert.equal(h.window.lifecycleTest.instances().length, 1);
  assert.equal(h.window.lifecycleTest.instances()[0].pid, 'auto');
  h.window.__zusageDispose();
});

// v91：设置是同窗口覆盖层，MCP 服务器表单的「请求头」textarea 在下半屏正常可见、
// 不是幽灵也不在弹窗里，v61/v62 判定拦不住——必须按设置页标记（PR #44 收尾后为
// 三层并集：settings-page testid + content/panel 双 frame）祖先排除，否则协调器
// 派实例、条挂进表单卡片（用户实测）。
test('settings-page form textarea is not dispatched or mounted as a chat composer', () => {
  const marker = k => /\[data-testid="settings-page"\]|\[data-settings-(content|panel)-frame\]/.test(k);
  // 只有设置表单编辑框（无 pane 标记）：不派发、不挂条
  const a = harness();
  const [layerA] = a.setPanes(['form']);
  const taA = layerA.children[0];
  taA.pid = undefined; taA.sid = undefined;
  taA.closest = k => marker(k) ? layerA : null;
  a.inject(); a.boot(); a.tick(); a.runFrame();
  assert.deepEqual(Array.from(a.window.lifecycleTest.instances(), e => e.pid), ['auto']);
  const barA = a.body.children.find(e => /zusage-root/.test(e.className || ''));
  assert.ok(barA, '兜底实例的条存在');
  assert.equal(barA.style.display, 'none', '设置表单编辑框不当聊天输入框，条保持隐藏');
  a.window.__zusageDispose();
  // 真 pane + 设置表单编辑框并存：pane 正常派发挂条，表单编辑框被排除
  const b = harness();
  const [, layerB] = b.setPanes(['workspace-main', 'form']);
  const taB = layerB.children[0];
  taB.pid = undefined; taB.sid = undefined;
  taB.closest = k => marker(k) ? layerB : null;
  b.inject(); b.boot(); b.tick(); b.runFrame();
  assert.deepEqual(Array.from(b.window.lifecycleTest.instances(), e => e.pid), ['workspace-main']);
  const barB = b.body.children.find(e => /zusage-root/.test(e.className || ''));
  assert.ok(barB, 'pane 实例的条存在');
  assert.equal(barB.style.display, 'flex', '真聊天输入框的条正常显示');
  b.window.__zusageDispose();
});

/* ---------- issue #147：划词 side chat 面板无 data-pane-id，被 "auto" 兜底键当作
 * 独立 pane → 同窗出现第二条状态条。窗口存在真实 pane 键时丢弃 auto 键。 ---------- */
test('issue #147: pane-less composer (side chat) next to a real pane must not spawn an auto instance', () => {
  const h = harness(), cards = h.setPanes(['workspace-main'], { toolbar: true });
  h.inject(); h.boot();
  // 划词 side chat 的 composer：不在任何 data-pane-id 容器里（直接挂 body），位置在
  // 下半屏（top 600 ≥ innerHeight 800×0.45）且可见 → 现状会被 "auto" 键收编为第二实例
  const side = h.body.appendChild(new Element('textarea'));
  side.sid = 'sess_side';   // 无 data-pane-id（3.17.1 side chat 形态）：走 paneKeyOf 无属性回退
  h.document.querySelectorAll('textarea,').push(side);   // 侧栏 composer 进入协调器扫描（document 桩返回 panes 数组）
  h.tick();
  const pids = () => Array.from(h.window.lifecycleTest.instances(), i => i.pid).sort();   // Array.from 转宿主 realm（VM 数组跨 realm deepStrictEqual 恒败）
  assert.deepEqual(pids(), ['workspace-main'], 'only the real pane instance exists: ' + JSON.stringify({ pids: pids(), len: pids().length, raw: h.window.lifecycleTest.instances().map(i => ({ pid: i.pid, api: Object.keys(i).slice(0, 6).join(',') })) }));
  assert.equal(pids().length, 1, 'instance count is one');
  // side chat 移除（面板收起/卸载）：实例保持，不重建
  side.remove();
  h.tick();
  assert.deepEqual(pids(), ['workspace-main']);
});

test('issue #147: pane-less candidates alone still use the auto fallback (shadow/iframe era)', () => {
  const h = harness();
  h.inject(); h.boot();
  const side = h.body.appendChild(new Element('textarea'));
  side.sid = 'sess_side';   // 无 data-pane-id（3.17.1 side chat 形态）：走 paneKeyOf 无属性回退
  h.document.querySelectorAll('textarea,').push(side);   // 进入协调器扫描
  h.tick();
  const pids = () => Array.from(h.window.lifecycleTest.instances(), i => i.pid).sort();   // Array.from 转宿主 realm（VM 数组跨 realm deepStrictEqual 恒败）
  assert.ok(pids().includes('auto'), 'auto fallback keeps single-pane legacy hosts working');
  assert.equal(pids().length, 1, 'single auto instance');
});

/* ---------- v174：辅助对话按宿主 tabId 独立成键（issue #147 守卫保留，配额 4+1） ---------- */
function sidePaneFixture(h, tabId, sid, opts = {}) {
  const rootEl = h.body.appendChild(new Element());
  rootEl.setAttribute('data-testid', 'v4-session-pane-' + tabId);
  rootEl.sid = sid;
  if (opts.bridge) {
    rootEl.setAttribute('data-zusage-scope-version', '1');
    rootEl.setAttribute('data-zusage-pane-id', tabId);
    rootEl.setAttribute('data-zusage-workspace-path', '/p');
    rootEl.setAttribute('data-zusage-workspace-identity', '');
    rootEl.setAttribute('data-zusage-remote-session-id', '');
  }
  const ta = rootEl.appendChild(new Element('textarea'));
  ta.setAttribute('data-testid', 'v4-composer-input');
  // sid 只放会话根（sessIdOf/readPaneScope 都取最近 data-session-id 祖先）：textarea 自带
  // sid 会把根判定短路到自身，桥属性就读不到了（真实宿主 data-session-id 在 SessionPane 根上）
  h.document.querySelectorAll('textarea,').push(ta);
  return { rootEl, ta };
}

test('v174: side chat composer keyed by host tab id spawns its own instance beside a real pane', () => {
  const h = harness(), cards = h.setPanes(['workspace-main'], { toolbar: true });
  h.inject(); h.boot();
  const TAB = 'selection-side-chat:%2Fp:parent:child';
  const side = sidePaneFixture(h, TAB, 'sess_child', { bridge: true });
  h.tick();
  const pids = () => Array.from(h.window.lifecycleTest.instances(), i => i.pid);
  assert.ok(pids().indexOf(TAB) >= 0, 'side chat instance keyed by host tab id: ' + JSON.stringify(pids()));
  assert.ok(pids().indexOf('workspace-main') >= 0, 'main pane instance untouched');
  const inst = h.window.lifecycleTest.instances().find(i => i.pid === TAB);
  assert.ok(inst.getScope(), 'bridge scope readable on the side chat root');
  assert.equal(inst.getScope().sid, 'sess_child');
  assert.equal(inst.getScope().workspacePath, '/p');
  assert.equal(inst.getScope().identity, '', 'local side chat binds an empty identity');
  assert.equal(h.window.__zusagePaneScopes[TAB].sid, 'sess_child', 'side chat scope reported to the pump');
  // 面板关闭（composer 撤出扫描）：实例撤销，主分栏不动
  const scanList = h.document.querySelectorAll('textarea,');
  scanList.splice(scanList.indexOf(side.ta), 1);
  side.rootEl.remove();
  h.tick();
  assert.deepEqual(pids(), ['workspace-main']);
});

test('v174: side chat without bridge attrs still keys by the host testid', () => {
  const h = harness(), cards = h.setPanes(['workspace-main'], { toolbar: true });
  h.inject(); h.boot();
  const TAB = 'selection-side-chat:%2Fp:p2:c2';
  sidePaneFixture(h, TAB, 'sess_child2', {});
  h.tick();
  const pids = () => Array.from(h.window.lifecycleTest.instances(), i => i.pid);
  assert.ok(pids().indexOf(TAB) >= 0, JSON.stringify(pids()));
  assert.ok(pids().indexOf('workspace-main') >= 0);
  h.window.__zusageDispose();
});

test('v174: four main splits plus one side chat all get instances (quota 4+1)', () => {
  const h = harness(), cards = h.setPanes(['a', 'b', 'c', 'd'], { toolbar: true });
  h.inject(); h.boot();
  sidePaneFixture(h, 'selection-side-chat:%2Fp:p3:c3', 'sess_child3', { bridge: true });
  h.tick();
  let pids = Array.from(h.window.lifecycleTest.instances(), i => i.pid);
  assert.equal(pids.length, 5, JSON.stringify(pids));
  assert.ok(pids.indexOf('selection-side-chat:%2Fp:p3:c3') >= 0);
  const extra = h.body.appendChild(new Element('textarea'));
  extra.pid = 'e'; extra.sid = 'sid_e';
  h.document.querySelectorAll('textarea,').push(extra);
  h.tick();
  assert.equal(h.window.lifecycleTest.instances().length, 5, 'main quota still caps at 4');
  h.window.__zusageDispose();
});

test('side chat before four mains, including nested side chat, keeps independent quotas', () => {
  const h = harness(), cards = h.setPanes(['a', 'b', 'c', 'd']);
  cards[0].pid = 'a'; // 侧聊实际嵌套在带 pane-id 的主分栏下
  const tab = 'selection-side-chat:first';
  const side = sidePaneFixture(h, tab, 'child');
  cards[0].appendChild(side.rootEl);
  const scan = h.document.querySelectorAll('textarea,');
  scan.unshift(scan.pop());
  h.inject(); h.boot();
  assert.deepEqual(Array.from(h.window.lifecycleTest.instances(), i => i.pid).sort(), [tab, 'a', 'b', 'c', 'd'].sort());
  h.window.__zusageDispose();
});

test('existing three mains and side do not block a fourth main', () => {
  const h = harness(); h.setPanes(['a', 'b', 'c']);
  const tab = 'selection-side-chat:existing'; sidePaneFixture(h, tab, 'child');
  h.inject(); h.boot();
  const extra = h.body.appendChild(new Element('textarea')); extra.pid = 'd'; extra.sid = 'sid_d';
  h.document.querySelectorAll('textarea,').push(extra); h.tick();
  assert.deepEqual(Array.from(h.window.lifecycleTest.instances(), i => i.pid).sort(), [tab, 'a', 'b', 'c', 'd'].sort());
  h.window.__zusageDispose();
});

test('pane-less native main coexists with side while unknown candidate is discarded', () => {
  const h = harness(), [card] = h.setPanes(['main']);
  const main = card.children[0]; main.pid = undefined; main.setAttribute('data-testid', 'v4-composer-input');
  const tab = 'selection-side-chat:legacy'; sidePaneFixture(h, tab, 'child');
  h.inject(); h.boot();
  assert.deepEqual(Array.from(h.window.lifecycleTest.instances(), i => i.pid).sort(), ['auto', tab].sort());
  h.window.__zusageDispose();
});

test('side visibility switching admits only one and disposes old instance idempotently', () => {
  const h = harness(); h.setPanes(['a']);
  const first = sidePaneFixture(h, 'selection-side-chat:one', 'one');
  const second = sidePaneFixture(h, 'selection-side-chat:two', 'two');
  second.rootEl.style.display = 'none'; h.inject(); h.boot();
  const old = h.window.lifecycleTest.instances().find(i => i.pid === 'selection-side-chat:one');
  assert.ok(old);
  first.rootEl.style.display = 'none'; second.rootEl.style.display = 'block'; h.tick();
  assert.deepEqual(Array.from(h.window.lifecycleTest.instances(), i => i.pid).sort(), ['a', 'selection-side-chat:two'].sort());
  old.dispose(); assert.equal(h.frames.size, 2);
  first.rootEl.style.display = 'block'; h.tick();
  assert.equal(h.window.lifecycleTest.instances().filter(i => i.pid.startsWith('selection-side-chat:')).length, 1);
  h.window.__zusageDispose(); assert.equal(h.frames.size, 0); assert.equal(h.timers.size, 0);
});

test('v174: unknown pane-less candidates are still dropped next to real panes (guard intact)', () => {
  const h = harness(), cards = h.setPanes(['workspace-main'], { toolbar: true });
  h.inject(); h.boot();
  const mystery = h.body.appendChild(new Element('textarea'));
  mystery.sid = 'sess_mystery';   // 无 pane 标记、也无辅助对话标记
  h.document.querySelectorAll('textarea,').push(mystery);
  h.tick();
  assert.deepEqual(Array.from(h.window.lifecycleTest.instances(), i => i.pid), ['workspace-main']);
  h.window.__zusageDispose();
});

/* ---------- issue #342（specs/perf-lag-reduction.md 规则 18b）：heavy/coordinator 600ms 对账
 * 自适应降频——单拍同步 ≥16ms（perfMs 差值，含界）时跳拍（600ms→封顶 600×3），<16ms 立即回
 * 600ms。耗时经 context 内假 performance/Date.now 注入（heavy 记 appendChild 条、coordinator
 * 记 SEL 查询，各恰好 +16ms/实跑），恰值边界与封顶阶梯全部确定性判定，不依赖计时。 */
function fakeClock(h, start) {
  vm.runInContext(`var __zuNow = { v: ${start} }; Date.now = function () { return __zuNow.v; }; var performance = { now: function () { return __zuNow.v; } };`, h.sandbox);
  return h.sandbox.__zuNow;
}

test('issue #342: heavy tick skips reconciliation rounds while the measured cost stays over budget', () => {
  const store = new Map([['zusage3.theme', 'compact']]);
  const h = harness({ getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) });
  h.setPanes(['a'], { toolbar: true }); h.inject(); h.boot();
  const now = fakeClock(h, 1000000);
  // 成本标记：heavy 每次实跑恰补挂一次 compact 条（document.body.appendChild(bar)）→ 恰 +16ms
  const realAppend = h.document.body.appendChild.bind(h.document.body);
  let costPerMount = 0;
  h.document.body.appendChild = function (el) {
    if (costPerMount && /zusage-root/.test(el.className || '')) now.v += costPerMount;
    return realAppend(el);
  };
  const bar = () => h.document.body.children.find(e => /zusage-root/.test(e.className || ''));
  // 贵拍（成本恰 16ms，≥ 阈值含界）：正常执行对账——compact 条被 React 清掉后补挂回 body
  costPerMount = 16;
  bar().remove();
  h.tick();
  assert.ok(bar(), '昂贵拍仍执行：heavy 补挂 bar');
  assert.equal(h.window.__zusageDiag.heavyCost, 16, 'heavyCost 落 diag 且恰为阈值（>16 变异在此变红）');
  // 降频窗口内（+300ms < 600ms×1 档）：再被清掉也不补挂
  now.v += 300;
  bar().remove();
  h.tick();
  assert.equal(bar(), undefined, '降频窗口内的 heavy 被跳过');
  // 恰 600ms（窗口右开 < 600）：该拍必须执行（skip 步移除的条此刻补挂）；成本仍贵 → 升到 2 档
  now.v += 300;
  h.tick();
  assert.ok(bar(), '恰 600ms 不跳拍（窗口右开，< 变异在此变红）');
  // 阶梯触顶（右开探针跑完已是 2 档）：Δ1250 升到 3 封顶；封顶失效（min(3→4)）时
  // 再下一拍 Δ1900 落进 600×4 窗被跳 → 红
  now.v += 1250; bar().remove(); h.tick(); assert.ok(bar(), '贵拍（Δ1250 ≥ 600×2）执行，升至 3 档');
  now.v += 1900; bar().remove(); h.tick(); assert.ok(bar(), '贵拍（Δ1900 ≥ 600×3）执行，档位封顶 3');
  now.v += 1900; bar().remove(); h.tick(); assert.ok(bar(), '封顶后 Δ1900 ≥ 600×3 仍执行（min(3→4) 变异在此变红）');
  // 恢复：廉价拍后档位回落，600ms 节奏照旧
  costPerMount = 0;
  now.v += 1900; bar().remove(); h.tick(); assert.ok(bar(), '恢复拍执行');
  now.v += 300;  bar().remove(); h.tick(); assert.ok(bar(), '廉价拍后档位回落 600ms：下一拍正常对账');
  h.window.__zusageDispose();
});

test('issue #342: coordinator tick skips instance reconciliation while over budget, disposes after recovery', () => {
  const h = harness(); h.setPanes(['a']); h.inject(); h.boot();
  const now = fakeClock(h, 2000000);
  // 成本标记：协调器每拍恰做一次 SEL 文档查询 → 恰 +16ms（heavy 不查 SEL，互不干扰）
  const realQS = h.document.querySelectorAll.bind(h.document);
  let costSel = 0;
  h.document.querySelectorAll = function (sel) {
    if (costSel && String(sel).indexOf('textarea,') === 0) now.v += costSel;
    return realQS(sel);
  };
  const pidOf = () => { const inst = h.window.lifecycleTest.instances().find(i => i.pid !== 'auto'); return inst ? inst.pid : '(none)'; };
  costSel = 16;
  h.tick();   // 贵拍（恰 16ms）
  assert.equal(pidOf(), 'a');
  assert.equal(h.window.__zusageDiag.coordCost, 16, 'coordCost 落 diag 且恰为阈值（>16 变异在此变红）');
  h.setPanes(['b']);
  now.v += 300;
  h.tick();
  assert.equal(pidOf(), 'a', '降频窗口内的 coordinator 被跳过：实例未被回收');
  h.setPanes(['c']);
  now.v += 300;   // 恰 600ms（窗口右开 < 600）：必须执行；成本仍贵 → 升到 2 档
  h.tick();
  assert.equal(pidOf(), 'c', '恰 600ms 不跳拍（窗口右开，< 变异在此变红）');
  h.setPanes(['d']);
  now.v += 650;
  h.tick();
  assert.equal(pidOf(), 'c', 'Δ650 < 600×2：跳拍');
  h.setPanes(['e']);
  now.v += 1250;   // Δ1900 ≥ 600×2：执行，升至 3 档
  h.tick();
  assert.equal(pidOf(), 'e');
  h.setPanes(['f']);
  now.v += 1900;   // Δ1900 ≥ 600×3：执行，档位封顶 3
  h.tick();
  assert.equal(pidOf(), 'f', '封顶后 Δ1900 ≥ 600×3 仍执行（min(3→4) 变异在此变红）');
  costSel = 0;   // 恢复廉价：档位回落，600ms 节奏照旧
  h.setPanes(['g']);
  now.v += 1900;
  h.tick();
  assert.equal(pidOf(), 'g', '恢复拍执行');
  h.setPanes(['h']);
  now.v += 300;
  h.tick();
  assert.equal(pidOf(), 'h', '廉价拍后档位回落 600ms：下一拍正常对账');
  h.window.__zusageDispose();
});
