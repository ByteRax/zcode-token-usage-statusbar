const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* issue #327：回答末尾统计行在 owner 令牌瞬时取不到（getSid 空串 / 实例重绑 / 同根歧义）的单拍里
 * 被整块 remove 且当拍不重建，表现为约 0.5s 一档的消失/重现。已验证归属的行对「令牌为空」宽限几拍。 */
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

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

function setup() {
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
  const inst = { pid: 'main', sid: 'sid', scope: { sid: 'sid', identity: '', workspacePath: '/workspace', remoteSessionId: '' },
    detRoot: () => ({ contains: node => node === box }),
    statsFor: () => ({ complete: true, observedLive: true, outputTokens: 1, text: 'stats' }),
    getSid() { return this.sid; }, getScope() { return this.scope; }, isCurrentTurn: () => true };
  c.instances.push(inst);
  const line = () => box.querySelector('[data-zusage-deterministic]');
  return { c, box, inst, line };
}

test('getSid 逐拍交替空串/有值：统计行节点保持同一引用不被拆建', () => {
  const { c, inst, line } = setup();
  c.scanDeterministicLines();
  const first = line();
  assert.ok(first);
  let removed = 0;
  const origRemove = first.remove; first.remove = function () { removed++; return origRemove.call(this); };
  for (let i = 0; i < 20; i++) {
    inst.sid = i % 2 ? 'sid' : '';
    c.scanDeterministicLines();
    assert.equal(line(), first, `第 ${i} 拍节点被替换/撤除`);
  }
  assert.equal(removed, 0);
});

test('令牌连续取不到超过宽限后撤除，恢复一拍即清零重新计数', () => {
  const { c, inst, line } = setup();
  c.scanDeterministicLines();
  const first = line();
  inst.sid = '';
  c.scanDeterministicLines(); c.scanDeterministicLines();
  assert.equal(line(), first);
  inst.sid = 'sid'; c.scanDeterministicLines();   // 恢复：计数清零
  inst.sid = '';
  c.scanDeterministicLines(); c.scanDeterministicLines();
  assert.equal(line(), first);
  c.scanDeterministicLines();   // 第三拍连续取不到：fail-closed 撤除
  assert.equal(line(), null);
});

test('归属换成另一个有效令牌（SID 切换）仍即时撤旧重建，不吃宽限', () => {
  const { c, inst, line } = setup();
  c.scanDeterministicLines();
  const first = line();
  inst.sid = 'other'; inst.scope = { ...inst.scope, sid: 'other' };
  c.scanDeterministicLines();
  assert.ok(line());
  assert.notEqual(line(), first);
});

test('无法证明归属的遗留行（无 __zuDetOwner）不吃宽限', () => {
  const { c, inst, line } = setup();
  c.scanDeterministicLines();
  delete line().__zuDetOwner;
  inst.sid = '';
  c.scanDeterministicLines();
  assert.equal(line(), null);
});

test('令牌取不到的原因计入 FATAL.det.nullOwner 供诊断', () => {
  const { c, inst } = setup();
  c.scanDeterministicLines();
  inst.sid = '';
  c.scanDeterministicLines(); c.scanDeterministicLines();
  inst.sid = 'sid'; inst.scope = { ...inst.scope, sid: 'mismatch' };
  c.scanDeterministicLines();
  inst.scope = { ...inst.scope, sid: 'sid' };
  inst.detRoot = () => null;
  c.scanDeterministicLines();
  c.scanDeterministicLines.diagAt = 0;
  c.scanDeterministicLines();
  const n = c.FATAL.det.nullOwner;
  assert.ok(n.sid >= 2 && n.scope >= 1 && n.owner >= 1, JSON.stringify(n));
  assert.ok(n.grace >= 1, JSON.stringify(n));
});
