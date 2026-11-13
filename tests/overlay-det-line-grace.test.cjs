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

function setup({ outer = false } = {}) {
  const clock = { t: 1000000 };   // 假时钟：宽限同时看拍数与墙钟，每次 scan 默认前进 500ms（与真实扫描节奏同）
  class FakeDate extends Date { static now() { return clock.t; } }
  const box = new Element('section'); box.tid = 'turn';
  const wrap = outer ? new Element('div') : null;   // 外层 [data-v4-turn-unit] 包着内层 section，带同一个 data-turn-id
  if (wrap) { wrap.tid = 'turn'; wrap.appendChild(box); }
  const document = { body: {}, createElement: tag => new Element(tag), querySelectorAll: selector =>
    selector === 'section[data-turn-id]' ? [box] : (selector === '[data-v4-turn-unit][data-turn-id]' && wrap ? [wrap] : []) };
  const c = vm.createContext({ window: {}, document, instances: [], MY_GEN: 3,
    state: { rateLine: true }, TURN_STATS: {}, FATAL: {}, stale: () => false, cnUnits: () => true,
    capPut: (obj, key, value) => { obj[key] = value; }, zuHasMeaningfulOutput: s => !!s.outputTokens,
    zuFinalText: s => s.text, zuUnavailableText: () => 'unavailable', zuIsUnavailableText: text => text === 'unavailable',
    isRateLine: () => false, Date: FakeDate });
  vm.runInContext(source.slice(source.indexOf('  var richTextCache ='), source.indexOf('  function zuDiagStats(')) +
    '\nfunction zuDiagStats() { return null; }', c);
  const inst = { pid: 'main', sid: 'sid', scope: { sid: 'sid', identity: '', workspacePath: '/workspace', remoteSessionId: '' },
    detRoot: () => ({ contains: node => node === box || node === wrap }),
    statsFor: () => ({ complete: true, observedLive: true, outputTokens: 1, text: 'stats' }),
    getSid() { return this.sid; }, getScope() { return this.scope; }, isCurrentTurn: () => true };
  c.instances.push(inst);
  const line = () => box.querySelector('[data-zusage-deterministic]');
  const scan = (ms = 500) => { clock.t += ms; c.scanDeterministicLines(); };
  return { c, box, inst, line, scan, clock };
}

test('getSid 逐拍交替空串/有值：统计行节点保持同一引用不被拆建', () => {
  const { inst, line, scan } = setup();
  scan();
  const first = line();
  assert.ok(first);
  let removed = 0;
  const origRemove = first.remove; first.remove = function () { removed++; return origRemove.call(this); };
  for (let i = 0; i < 20; i++) {
    inst.sid = i % 2 ? 'sid' : '';
    scan();
    assert.equal(line(), first, `第 ${i} 拍节点被替换/撤除`);
  }
  assert.equal(removed, 0);
});

test('令牌连续取不到须同时满足拍数与墙钟才撤，恢复一拍即清零重新计数', () => {
  const { inst, line, scan } = setup();
  scan();
  const first = line();
  inst.sid = '';
  scan(); scan();
  assert.equal(line(), first);
  inst.sid = 'sid'; scan();   // 恢复：计数清零
  inst.sid = '';
  scan(); scan();
  assert.equal(line(), first);
  scan();   // 第三拍连续取不到且已跨 1s：fail-closed 撤除
  assert.equal(line(), null);
});

test('拍数够但墙钟不够（回执爆发密集调用）不撤；墙钟够但拍数不够也不撤', () => {
  const { inst, line, scan } = setup();
  scan();
  const first = line();
  inst.sid = '';
  for (let i = 0; i < 10; i++) scan(10);   // 10 拍共 100ms
  assert.equal(line(), first);
  scan(5000);   // 墙钟已远超，但计数已够 → 撤
  assert.equal(line(), null);
  const t2 = setup();
  t2.scan();
  const l2 = t2.line();
  t2.inst.sid = '';
  t2.scan(60000);   // 单拍墙钟极长（后台节流）：拍数 1 <3 不撤
  assert.equal(t2.line(), l2);
});

test('归属换成另一个有效令牌（SID 切换）仍即时撤旧重建，不吃宽限', () => {
  const { inst, line, scan } = setup();
  scan();
  const first = line();
  inst.sid = 'other'; inst.scope = { ...inst.scope, sid: 'other' };
  scan();
  assert.ok(line());
  assert.notEqual(line(), first);
});

test('无法证明归属的遗留行（无 __zuDetOwner 或无 __zuDetTid）不吃宽限', () => {
  for (const key of ['__zuDetOwner', '__zuDetTid']) {
    const { inst, line, scan } = setup();
    scan();
    delete line()[key];
    inst.sid = '';
    scan();
    assert.equal(line(), null, key);
  }
});

test('宽限期内 box 复用为另一轮（tid 变化）即时撤，不滞留旧轮文本', () => {
  const { box, inst, line, scan } = setup();
  scan();
  assert.ok(line());
  inst.sid = ''; box.tid = 'turn2';
  scan();
  assert.equal(line(), null);
});

test('scope 与 sid 不符（属于别的会话的反证）即时撤，不吃宽限', () => {
  const { inst, line, scan } = setup();
  scan();
  inst.scope = { ...inst.scope, sid: 'mismatch' };
  scan();
  assert.equal(line(), null);
});

test('detRoot 取不到/同根歧义（owner 缺席）同样宽限 2 拍，第 3 拍撤', () => {
  const cases = {
    'detRoot 为空': t => { t.inst.detRoot = () => null; },
    '同根歧义': t => { t.twin.detRoot = t.inst.detRoot; },
  };
  for (const [name, arrange] of Object.entries(cases)) {
    const t = setup();
    t.twin = { ...t.inst, pid: 'twin', detRoot: () => null };   // 先不认领任何 box，行才建得出来
    t.c.instances.push(t.twin);
    t.scan();
    const first = t.line();
    assert.ok(first, name);
    arrange(t);
    t.scan(); t.scan();
    assert.equal(t.line(), first, name + ' 前 2 拍保留');
    t.scan();
    assert.equal(t.line(), null, name + ' 第 3 拍撤除');
  }
});

test('令牌取不到的原因只统计带行 box，计数精确', () => {
  const { c, inst, line, scan } = setup();
  scan();
  assert.deepEqual({ ...c.scanDeterministicLines.nulls, since: 0 }, { owner: 0, sid: 0, scope: 0, grace: 0, removed: 0, swap: 0, since: 0 });
  inst.sid = '';
  scan(); scan();   // sid×2，均宽限
  inst.sid = 'sid'; scan();   // 恢复
  inst.detRoot = () => null;
  scan(); scan();   // owner×2，均宽限
  assert.ok(line());
  scan();   // owner 第 3 拍：撤行
  assert.equal(line(), null);
  scan();   // 已无行：不再计数
  assert.deepEqual({ ...c.scanDeterministicLines.nulls, since: 0 }, { owner: 3, sid: 2, scope: 0, grace: 4, removed: 1, swap: 0, since: 0 });
  inst.detRoot = () => ({ contains: () => true });
  scan();   // 重建
  inst.scope = { ...inst.scope, sid: 'mismatch' };
  scan();
  assert.deepEqual({ ...c.scanDeterministicLines.nulls, since: 0 }, { owner: 3, sid: 2, scope: 1, grace: 4, removed: 2, swap: 0, since: 0 });
});

test('FATAL.det.nullOwner 随 diag 输出', () => {
  const { c, inst, scan } = setup();
  scan();
  inst.sid = '';
  scan();
  c.scanDeterministicLines.diagAt = 0;
  scan();
  assert.equal(c.FATAL.det.nullOwner.sid, 2);
  assert.equal(c.FATAL.det.nullOwner.grace, 2);
});

test('每拍间隔远超 1s（后台节流）时仍须连续 3 拍才撤，拍数门独立生效', () => {
  const { inst, line, scan } = setup();
  scan();
  const first = line();
  inst.sid = '';
  scan(60000); scan(60000);
  assert.equal(line(), first);
  scan(60000);
  assert.equal(line(), null);
});

test('外层 turn-unit 与内层 section 同命中一行：每拍只计一次，诊断不翻倍', () => {
  const { c, inst, line, scan } = setup({ outer: true });
  scan();
  const first = line();
  assert.ok(first);
  inst.detRoot = () => null;   // owner 缺席：detSeenKey 为 null，内外两个 box 都会被扫到
  scan(); scan();
  assert.equal(line(), first, '前 2 拍保留（拍数门不被双 box 提前耗尽）');
  assert.equal(c.scanDeterministicLines.nulls.owner, 2);
  assert.equal(c.scanDeterministicLines.nulls.grace, 2);
  scan();
  assert.equal(line(), null);
  assert.equal(c.scanDeterministicLines.nulls.removed, 1);
});

test('系统时钟回拨视为宽限到期，行不会无限滞留', () => {
  const { inst, line, scan, clock } = setup();
  scan();
  inst.sid = '';
  scan(); scan();
  clock.t -= 3600000;   // 回拨 1h
  scan();
  assert.equal(line(), null);
});

test('removed 只计空令牌撤行，非空令牌换代撤旧计入 swap', () => {
  const { c, inst, scan } = setup();
  scan();
  inst.sid = 'other'; inst.scope = { ...inst.scope, sid: 'other' };
  scan();
  const n = c.scanDeterministicLines.nulls;
  assert.equal(n.removed, 0);
  assert.equal(n.swap, 1);
});

test('恢复后第二段取不到须重新起算墙钟：拍数够但墙钟不够仍保留', () => {
  const { inst, line, scan } = setup();
  scan(); const first = line();
  inst.sid = ''; scan(); scan();
  inst.sid = 'sid'; scan();
  inst.sid = '';
  for (let i = 0; i < 6; i++) scan(10);
  assert.equal(line(), first);
});

test('nullOwner.since 为本代起算的 ISO 时刻', () => {
  const { c } = setup();
  assert.match(c.scanDeterministicLines.nulls.since, /^\d{4}-\d{2}-\d{2}T/);
});
