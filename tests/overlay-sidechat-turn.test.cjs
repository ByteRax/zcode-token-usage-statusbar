const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
const rich = source.slice(source.indexOf('  var richTextCache ='), source.indexOf('  /* ---------- 确定性历史行'));
const ownerCode = source.slice(source.indexOf('  function detOwnerOf('), source.indexOf('  function scanDeterministicLines()'));
function setup() {
  const ctx = vm.createContext({
    window: {}, document: { body: {} }, instances: [], MY_GEN: 3, state: { forceKmb: false },
    cnUnits: () => true, stale: () => false, scanDeterministicLines: () => {},
    capPut: (obj, key, value) => { obj[key] = value; },
  });
  vm.runInContext(rich + ownerCode, ctx);
  return ctx;
}
function instance(pid, root, result, sid = 'sid') {
  const inst = { pid, sid, scope: { sid, identity: '', workspacePath: '/workspace', remoteSessionId: '' },
    detRoot: () => root, statsFor: () => result, getSid() { return this.sid; }, getScope() { return this.scope; },
    isCurrentTurn: () => true };
  return inst;
}
function root(...nodes) { return { contains: node => nodes.includes(node) }; }

test('owner 不明或同根歧义不借其他 tracker，嵌套时选择最内层', () => {
  const c = setup(), box = {}, outer = root(box), inner = root(box);
  outer.contains = node => node === box || node === inner;
  const a = instance('main', outer, 'main'), b = instance('selection-side-chat:x', inner, 'side');
  c.instances.push(a, b);
  assert.equal(c.detOwnerOf(box), b);
  assert.equal(c.detStatsFor(box, 'same'), 'side');
  assert.equal(c.detStatsFor({}, 'same'), null);
  c.instances.push(instance('duplicate', inner, 'wrong'));
  assert.equal(c.detOwnerOf(box), null);
});

test('侧聊包括远端同 sid/tid 不请求或消费主视图缓存', () => {
  const c = setup(), main = instance('main', null, null, 'same-sid'), side = instance('selection-side-chat:remote', null);
  c.instances.push(main, side);
  const stats = { sessionId: 'same-sid' };
  c.zuRequestTurnText(main, 'same-tid', stats);
  c.zuFlushRichTextWants();
  const req = c.window.__zusagePluginRequests[0];
  c.window.__zusageDeliverTurnText('same-sid', 'main rich', req.unitEpoch);
  assert.equal(c.richTextCache[c.zuRichKey(main, 'same-tid')], 'main rich');
  assert.equal(c.zuRichKey(side, 'same-tid'), '');
  assert.equal(c.richTextCache[c.zuRichKey(side, 'same-tid')], undefined);
  c.zuRequestTurnText(side, 'same-tid', stats);
  c.zuFlushRichTextWants();
  assert.equal(c.window.__zusagePluginRequests.length, 1);
});

test('相同 sid 不同主实例或轮次拒绝迟到响应并隔离缓存', () => {
  const c = setup(), a = instance('main-a', null), b = instance('main-b', null);
  c.instances.push(a, b);
  const stats = { sessionId: 'sid' };
  c.zuRequestTurnText(a, 'tid', stats);
  c.zuFlushRichTextWants();
  const old = c.window.__zusagePluginRequests.at(-1);
  c.zuRequestTurnText(b, 'tid', stats);
  c.zuFlushRichTextWants();
  const current = c.window.__zusagePluginRequests.at(-1);
  assert.notEqual(old.unitEpoch, current.unitEpoch);
  c.window.__zusageDeliverTurnText('sid', 'old', old.unitEpoch);
  c.window.__zusageDeliverTurnText('sid', 'legacy');
  assert.equal(c.richTextCache[c.zuRichKey(b, 'tid')], undefined);
  c.window.__zusageDeliverTurnText('sid', 'new', current.unitEpoch);
  assert.equal(c.richTextCache[c.zuRichKey(b, 'tid')], 'new');
  assert.equal(c.richTextCache[c.zuRichKey(a, 'tid')], undefined);
  c.zuRequestTurnText(b, 'next', stats);
  c.zuFlushRichTextWants();
  c.window.__zusageDeliverTurnText('sid', 'late', current.unitEpoch);
  assert.equal(c.richTextCache[c.zuRichKey(b, 'next')], undefined);
});

test('同 SID 多轮只追活跃轮：跨扫描重试不换代号，迟到回复仍被接受', () => {
  const c = setup(), a = instance('main', null);
  c.instances.push(a);
  c.zuRequestTurnText(a, 'old', { sessionId: 'sid' });
  c.zuFlushRichTextWants();
  c.zuRequestTurnText(a, 'new', { sessionId: 'sid' });
  c.zuFlushRichTextWants();
  const current = c.window.__zusagePluginRequests.at(-1);
  for (let i = 0; i < 5; i++) c.zuFlushRichTextWants();   // 多个扫描周期：活跃轮未变时不换代号、不重复发
  assert.equal(c.window.__zusagePluginRequests.length, 2);
  c.window.__zusageDeliverTurnText('sid', 'new rich', current.unitEpoch);   // 跨周期迟到回复仍被接受
  assert.equal(c.richTextCache[c.zuRichKey(a, 'new')], 'new rich');
  a.isCurrentTurn = () => false;   // 该轮已不是活跃目标（如更新的轮已存在）：不请求，保持占位
  c.zuRequestTurnText(a, 'old', { sessionId: 'sid' });
  c.zuFlushRichTextWants();
  assert.equal(c.richTextCache[c.zuRichKey(a, 'old')], undefined);
  c.zuRequestTurnText(a, 'new', { sessionId: 'sid' });
  c.zuFlushRichTextWants();
  assert.equal(c.richTextCache[c.zuRichKey(a, 'new')], 'new rich');   // 已缓存不重发
  assert.equal(c.window.__zusagePluginRequests.length, 2);
});

test('同一实例切换 SID 或 scope 不消费旧缓存，也不接受迟到响应', () => {
  const c = setup(), a = instance('main', null);
  c.instances.push(a);
  c.zuRequestTurnText(a, 'tid', { sessionId: 'sid' });
  c.zuFlushRichTextWants();
  const first = c.window.__zusagePluginRequests.at(-1);
  const oldKey = c.zuRichKey(a, 'tid');
  a.sid = 'other'; a.scope = { ...a.scope, sid: 'other' };
  c.window.__zusageDeliverTurnText('sid', 'late', first.unitEpoch);
  assert.equal(c.richTextCache[oldKey], undefined);
  c.zuRequestTurnText(a, 'tid', { sessionId: 'other' });
  c.zuFlushRichTextWants();
  const second = c.window.__zusagePluginRequests.at(-1);
  c.window.__zusageDeliverTurnText('other', 'other rich', second.unitEpoch);
  assert.equal(c.richTextCache[c.zuRichKey(a, 'tid')], 'other rich');
  a.scope = { ...a.scope, workspacePath: '/different' };
  assert.equal(c.richTextCache[c.zuRichKey(a, 'tid')], undefined);
  c.zuRequestTurnText(a, 'next', { sessionId: 'other' });
  c.zuFlushRichTextWants();
  const third = c.window.__zusagePluginRequests.at(-1);
  a.scope = null;
  c.window.__zusageDeliverTurnText('other', 'late scope', third.unitEpoch);
  assert.equal(c.richTextCache[c.zuRichKey(a, 'next')], undefined);
});

test('无桥仅明确无远端证据且无远端绑定时允许本地富文本，证据撤销后拒绝迟到响应', () => {
  const c = setup(), a = instance('main', null);
  a.scope = null; c.instances.push(a);
  c.zuRequestTurnText(a, 'tid', { sessionId: 'sid' });
  c.zuFlushRichTextWants();
  assert.equal(c.window.__zusagePluginRequests, undefined);
  c.state.data = { remote_evidence: false, scope_bindings: {} };
  c.zuRequestTurnText(a, 'tid', { sessionId: 'sid' });
  c.zuFlushRichTextWants();
  const req = c.window.__zusagePluginRequests[0], key = c.zuRichKey(a, 'tid');
  c.state.data.remote_evidence = true;
  c.window.__zusageDeliverTurnText('sid', 'late', req.unitEpoch);
  assert.equal(c.richTextCache[key], undefined);
  c.state.data.remote_evidence = false;
  c.state.data.scope_bindings.main = 'remote:ssh:host';
  assert.equal(c.zuRichKey(a, 'tid'), '');
  delete c.state.data.scope_bindings.main;
  c.window.__zusagePaneScopes = { main: { sid: 'sid', identity: 'remote:ssh:host' } };
  assert.equal(c.zuRichKey(a, 'tid'), '');
  delete c.window.__zusagePaneScopes;
  c.window.__zusageDeliverTurnText('sid', 'local', req.unitEpoch);
  assert.equal(c.richTextCache[key], 'local');
});

test('可信远端 scope 不查询或消费本地富文本', () => {
  const c = setup(), a = instance('main', null);
  c.instances.push(a);
  c.state.data = { remote_evidence: false };
  a.scope = { ...a.scope, identity: 'remote:ssh:host', remoteSessionId: 'host' };
  assert.equal(c.zuRichKey(a, 'tid'), '');
  c.zuRequestTurnText(a, 'tid', { sessionId: 'sid' });
  assert.equal(c.window.__zusagePluginRequests, undefined);
});

test('统计行随节点迁移及 SID、scope 切换撤旧，同 owner tracker 换代保留', () => {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.textContent = ''; }
    appendChild(child) { child.remove(); this.children.push(child); child.parentElement = this; }
    remove() { if (this.parentElement) { const children = this.parentElement.children; children.splice(children.indexOf(this), 1); this.parentElement = null; } }
    getAttribute(name) { return name === 'data-turn-id' ? this.tid : null; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
      const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
      if (selector === '*') return descendants;
      if (selector === '[data-zusage-deterministic]') return descendants.filter(el => el.dataset.zusageDeterministic);
      if (selector === 'p') return descendants.filter(el => el.tag === 'p');
      if (selector === 'blockquote p, blockquote, p') return descendants.filter(el => el.tag === 'p' || el.tag === 'blockquote');
      return [];
    }
  }
  const box = new Element('section'); box.tid = 'turn';
  const document = { body: {}, createElement: tag => new Element(tag), querySelectorAll: selector =>
    selector === 'section[data-turn-id]' ? [box] : [] };
  const c = vm.createContext({ window: {}, document, instances: [], MY_GEN: 3,
    state: { rateLine: true }, TURN_STATS: {}, FATAL: {}, stale: () => false, cnUnits: () => true,
    capPut: (obj, key, value) => { obj[key] = value; }, zuHasMeaningfulOutput: s => !!s.outputTokens,
    zuFinalText: s => s.text, zuUnavailableText: () => 'unavailable', zuIsUnavailableText: text => text === 'unavailable',
    isRateLine: () => false });
  vm.runInContext(source.slice(source.indexOf('  var richTextCache ='), source.indexOf('  function zuDiagStats(')) +
    '\nfunction zuDiagStats() { return null; }', c);
  const stats = text => ({ complete: true, observedLive: true, outputTokens: 1, text, sessionId: 'sid' });
  let current = stats('A');
  const a = instance('a', root(box), null), b = instance('b', root(), null);
  a.statsFor = () => current; b.statsFor = () => current;
  c.instances.push(a, b);
  const line = () => box.querySelector('[data-zusage-deterministic]');
  const text = () => line()?.querySelector('p').textContent;
  c.scanDeterministicLines(); assert.equal(text(), 'A');
  current = null; c.scanDeterministicLines(); assert.equal(text(), 'A');
  delete line().__zuDetOwner; // 热重载前的旧行无法证明归属，不能沿用历史行保留规则
  c.scanDeterministicLines(); assert.equal(line(), null);
  current = stats('A rebuilt'); c.scanDeterministicLines(); assert.equal(text(), 'A rebuilt');
  current = null; c.scanDeterministicLines(); assert.equal(text(), 'A rebuilt');
  a.detRoot = () => root(); b.detRoot = () => root(box);
  c.scanDeterministicLines(); assert.equal(line(), null);
  current = stats('B'); c.scanDeterministicLines(); assert.equal(text(), 'B');
  b.sid = 'new'; b.scope = { ...b.scope, sid: 'new' }; current = null;
  c.scanDeterministicLines(); assert.equal(line(), null);
  current = { ...stats('new'), sessionId: 'new' }; c.scanDeterministicLines(); assert.equal(text(), 'new');
  b.scope = { ...b.scope, workspacePath: '/other' }; current = null;
  c.scanDeterministicLines(); assert.equal(line(), null);
  current = { ...stats('scope'), sessionId: 'new' }; c.scanDeterministicLines(); assert.equal(text(), 'scope');
  b.detRoot = () => root(); c.scanDeterministicLines(); assert.equal(line(), null);
});

test('两个无 owner 的同 tid 节点各自撤除遗留统计行', () => {
  const boxes = [0, 1].map(() => {
    const line = { removed: false, remove() { this.removed = true; } };
    return { line, getAttribute: name => name === 'data-turn-id' ? 'same' : null,
      querySelector: () => line };
  });
  const document = { body: {}, querySelectorAll: selector => selector === 'section[data-turn-id]' ? boxes : [] };
  const c = vm.createContext({ window: {}, document, instances: [], MY_GEN: 3,
    state: { rateLine: true }, TURN_STATS: {}, FATAL: {}, stale: () => false, cnUnits: () => true,
    capPut: (obj, key, value) => { obj[key] = value; } });
  vm.runInContext(source.slice(source.indexOf('  var richTextCache ='), source.indexOf('  function zuDiagStats(')) +
    '\nfunction zuDiagStats() { return null; }', c);
  c.scanDeterministicLines();
  assert.deepEqual(boxes.map(box => box.line.removed), [true, true]);
});

test('侧聊根嵌套主根但无对应实例时不借主 tracker', () => {
  const c = setup();
  const mainRoot = root(), side = root(), box = { parentElement: side };
  side.parentElement = mainRoot;
  side.getAttribute = name => name === 'data-testid' ? 'v4-session-pane-selection-side-chat:child' : null;
  mainRoot.contains = node => node === box || node === side;
  side.contains = node => node === box;
  const main = instance('main', mainRoot, 'main stats');
  c.instances.push(main);
  assert.equal(c.detStatsFor(box, 'tid'), null);
  const child = instance('selection-side-chat:child', side, 'child stats');
  c.instances.push(child);
  assert.equal(c.detStatsFor(box, 'tid'), 'child stats');
  child.detRoot = () => null;
  assert.equal(c.detStatsFor(box, 'tid'), null);
});
