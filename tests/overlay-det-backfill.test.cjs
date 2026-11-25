const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* v467：切回补捞的完成轮（重绑新建 tracker 后非亲历、窗口头部行 outputTokens=0）不再静默
 * 无行——仍是实例活跃轮时按既有 --current 通道要富文本，到达后插行、不插占位（空回执
 * 永不插行）。被更新轮顶替（isCurrentTurn=false）与压缩轮维持 v86/v230 静默。 */
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

function setup({ current = true, stats } = {}) {
  const clock = { t: 1000000 };
  class FakeDate extends Date { static now() { return clock.t; } }
  const box = new Element('section'); box.tid = 'turn';
  const document = { body: {}, createElement: tag => new Element(tag), querySelectorAll: selector =>
    selector === 'section[data-turn-id]' ? [box] : [] };
  const c = vm.createContext({ window: { __zusagePluginRequests: [] }, document, instances: [], MY_GEN: 3,
    state: { rateLine: true }, TURN_STATS: {}, FATAL: {}, stale: () => false, cnUnits: () => true,
    capPut: (obj, key, value) => { obj[key] = value; }, zuHasMeaningfulOutput: s => !!s.outputTokens,
    zuFinalText: s => s.text, zuUnavailableText: () => 'unavailable', zuIsUnavailableText: text => text === 'unavailable',
    isRateLine: () => false, Date: FakeDate });
  vm.runInContext(source.slice(source.indexOf('  var richTextCache ='), source.indexOf('  function zuDiagStats(')) +
    '\nfunction zuDiagStats() { return null; }', c);
  const inst = { pid: 'main', sid: 'sid', scope: { sid: 'sid', identity: '', workspacePath: '/workspace', remoteSessionId: '' },
    detRoot: () => ({ contains: node => node === box }),
    statsFor: () => stats,
    getSid() { return this.sid; }, getScope() { return this.scope; }, isCurrentTurn: () => current };
  c.instances.push(inst);
  const line = () => box.querySelector('[data-zusage-deterministic]');
  const scan = (ms = 500) => { clock.t += ms; c.scanDeterministicLines(); };
  return { c, box, inst, line, scan };
}

const backfilled = { complete: true, observedLive: false, outputTokens: 0, sessionId: 'sid' };

test('v467 非亲历零输出轮（活跃轮）：不插占位但按 --current 通道入队，富文本到达后插行', () => {
  const { c, line, scan } = setup({ stats: backfilled });
  scan();
  assert.ok(!line(), '富文本到达前不插行（含占位在内）');
  assert.ok(c.window.__zusagePluginRequests.length >= 1, 'flush 已发出 turn-text 请求');
  assert.equal(c.window.__zusagePluginRequests[0].sid, 'sid');
  assert.equal(c.window.__zusagePluginRequests[0].turnRef, undefined, '主会话请求不带 turnRef（走 --current）');
  const epoch = c.richTextRequestTids.sid.epoch;
  c.window.__zusageDeliverTurnText('sid', '⚡ 120.0 token/s(本轮) · 输出 5 token', epoch);
  assert.ok(line(), '富文本到达后插行');
  assert.match(line().querySelector('p').textContent, /120\.0 token\/s\(本轮\)/);
});

test('v467 非亲历零输出轮（被更新轮顶替）：不入队不插行（flush notCur 兜底，维持 v86 静默）', () => {
  const { c, line, scan } = setup({ current: false, stats: backfilled });
  scan();
  assert.ok(!line(), '不插行');
  assert.equal(c.window.__zusagePluginRequests.length, 0, '无请求发出');
});

test('v467 非亲历零输出轮：空回执不插行不写缓存，非空回执到达后插行', () => {
  const { c, line, scan } = setup({ stats: backfilled });
  // 第一拍入队 → deliver 空回执（库没追上/新提问后 promptTs 前移）→ 不插行、不写缓存 →
  // deliver 非空 → 由 deliver 内部重扫插行。缓存键直接读请求账本上的 key，不手算。
  scan();
  assert.ok(!line());
  const pending = c.richTextRequestTids.sid;
  c.window.__zusageDeliverTurnText('sid', '', pending.epoch);
  assert.ok(!line(), '空回执不插行');
  assert.ok(!c.richTextCache[pending.key], '空回执不写缓存');
  c.window.__zusageDeliverTurnText('sid', '⚡ rich(本轮)', pending.epoch);
  assert.match(line().querySelector('p').textContent, /rich\(本轮\)/);
});

test('v467 压缩轮（非亲历零输出）：维持 v230 静默，不查询不插行', () => {
  const { c, line, scan } = setup({ stats: { complete: true, observedLive: false, outputTokens: 0, isCompact: true, sessionId: 'sid' } });
  scan();
  assert.ok(!line(), '不插行');
  assert.equal(c.window.__zusagePluginRequests.length, 0, '无请求发出');
});

test('v467 亲历的真实零输出轮：维持 v86 明示「不可用」（回归）', () => {
  const { line, scan } = setup({ stats: { complete: true, observedLive: true, outputTokens: 0, sessionId: 'sid' } });
  scan();
  assert.ok(line(), '亲历零输出仍插行');
  assert.equal(line().querySelector('p').textContent, 'unavailable');
});
