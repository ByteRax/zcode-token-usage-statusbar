/* 13-mobile-chips 的 DOM 采集口径锁（specs/mobile-relay.md「DOM 快路径」与「样式复用」）。
 * 桌面状态条的 .it 原样 textContent 直推手机端会产生三类不一致，本测试钉住修法：
 *  1) 子代理格不再跳过（0.2.4 起完全照抄桌面 chip 集，含子代理）；
 *  2) 工具格是 <span class=v>717</span><span class=eb>15</span>，textContent 拼成
 *     "71715" → 只剥离尾部错误数作 err 字段，.dim「N次」保留；
 *  3) 按桌面 DOM 拆 {v 主值, dim 后缀}，速度格 .zu-live 单串拆数字+t/s；
 *  4) id 与桌面 state.show 键对齐（turn/win/today/proj/tools/sub）。
 * 采集逻辑在 overlay.js 的 boot 闭包内，这里按源码契约断言（与 overlay 套件同风格）。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { readOverlayPart } = require('./helpers/overlay-extract.cjs');

const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
const mobilePart = readOverlayPart('13-mobile-chips.js');

test('mobile chips: subagent cell included (0.2.4 full desktop copy)', () => {
  assert.doesNotMatch(source, /classList\.contains\("zu-sub"\)\) continue;/);
  assert.match(source, /"子代理": "sub"/);
});

test('mobile chips: tools value strips only the trailing error count, keeps dim text', () => {
  assert.match(source, /var ebEl = el\.querySelector\("\.eb"\);/);
  // 只在尾部匹配时剥离，不能统一只取 .v（那会丢掉「N次 / N轮 N次」dim 文本）
  assert.match(source, /if \(ebText && value\.slice\(-ebText\.length\) === ebText\) value = value\.slice\(0, -ebText\.length\)\.trim\(\);/);
  assert.match(source, /if \(ebText && ebText !== "0"\) detail =/);
});

test('mobile chips: value split into v/dim like desktop DOM', () => {
  assert.match(source, /var vText = vEl \? \(vEl\.textContent \|\| ""\)\.trim\(\) : value;/);
  assert.match(source, /var dimText = dimEls\.length \? \(dimEls\[dimEls\.length - 1\]\.textContent \|\| ""\)\.trim\(\) : "";/);
  assert.match(source, /var sm = vText\.match\(/);   // 速度格 "170.4t/s" 拆数字 + t/s
  assert.match(source, /vText = sm\[1\]; dimText = "t\/s";/);
  assert.match(source, /chip\.dim = dimText;/);
});

test('mobile chips: stable ids aligned with desktop state.show keys', () => {
  assert.match(source, /var mcIds = \{ "本轮": "turn", "会话": "win", "会话累计": "win", "今日": "today", "今日合计": "today", "项目": "proj", "项目累计": "proj", "工具": "tools", "子代理": "sub", "速度": "speed", "额度": "quota" \};/);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function mobileHarness(getStatus) {
  let now = 0, nextId = 1;
  const timers = new Map();
  function schedule(fn, delay, repeat) {
    const id = nextId++;
    timers.set(id, { fn, at: now + delay, delay, repeat });
    return id;
  }
  const window = { __zusageGen: 1, __zusageUpdate() {}, zcode: { getWebRemoteControlStatus: getStatus } };
  const context = {
    window, document: { querySelectorAll: () => [] },
    setTimeout: (fn, delay) => schedule(fn, delay, false),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, true),
    clearInterval: (id) => timers.delete(id),
  };
  vm.runInNewContext('(function () {\n' + mobilePart, context);
  return {
    window, timers,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.at <= end && (!next || timer.at < next.timer.at)) next = { id, timer };
        }
        if (!next) break;
        now = next.timer.at;
        if (next.timer.repeat) next.timer.at += next.timer.delay;
        else timers.delete(next.id);
        next.timer.fn();
      }
      now = end;
    },
    target() {
      const payload = window.__zusageMobileChips;
      return payload ? JSON.parse(JSON.stringify(payload.target)) : undefined;
    },
  };
}

const status = (taskId, fields = {}) => ({ mobileConnected: true, mobileTaskView: { taskId, ...fields } });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

for (const failure of ['missing', 'throw', 'reject', 'timeout']) {
  test(`mobile target: ${failure} clears the previous target and permits recovery`, async () => {
    let mode = 'ok', calls = 0;
    const h = mobileHarness(() => {
      calls++;
      if (mode === 'throw') throw new Error('unavailable');
      if (mode === 'reject') return Promise.reject(new Error('unavailable'));
      if (mode === 'timeout') return new Promise(() => {});
      return status('session_a', { workspacePath: '/work', workspaceIdentity: '' });
    });
    await flush();
    assert.deepEqual(h.target(), { taskId: 'session_a', workspacePath: '/work', workspaceIdentity: '' });
    mode = failure;
    if (failure === 'missing') delete h.window.zcode.getWebRemoteControlStatus;
    h.advance(1000);
    await flush();
    if (failure === 'timeout') { h.advance(3000); await flush(); }
    assert.equal(h.target(), null);
    const before = calls;
    mode = 'ok';
    if (failure === 'missing') h.window.zcode.getWebRemoteControlStatus = () => { calls++; return status('session_b'); };
    h.advance(1000);
    await flush();
    assert.ok(calls > before, 'the status request must be retried');
    assert.equal(h.target().taskId, failure === 'missing' ? 'session_b' : 'session_a');
    h.window.__zusageDispose();
    assert.equal(h.timers.size, 0);
  });
}

test('mobile target: optional fields remain null, strings remain unchanged, invalid types fail closed', async () => {
  let view = status('session_a');
  const h = mobileHarness(() => view);
  await flush();
  assert.deepEqual(h.target(), { taskId: 'session_a', workspacePath: null, workspaceIdentity: null });
  view = status('session_a', { workspacePath: '', workspaceIdentity: '' });
  h.advance(1000); await flush();
  assert.deepEqual(h.target(), { taskId: 'session_a', workspacePath: '', workspaceIdentity: '' });
  view = status('session_a', { workspacePath: null, workspaceIdentity: null });
  h.advance(1000); await flush();
  assert.deepEqual(h.target(), { taskId: 'session_a', workspacePath: null, workspaceIdentity: null });
  for (const fields of [{ workspacePath: 123 }, { workspaceIdentity: {} }]) {
    view = status('session_a', fields);
    h.advance(1000); await flush();
    assert.equal(h.target(), null);
  }
  h.window.__zusageDispose();
});

test('mobile target: timed out and missing-interface requests cannot overwrite a newer target', async () => {
  const pending = deferred();
  let mode = 'initial';
  const getStatus = () => mode === 'pending' ? pending.promise : status(mode);
  const h = mobileHarness(getStatus);
  await flush();
  mode = 'pending';
  h.advance(1000); await flush();
  h.advance(3000); await flush();
  assert.equal(h.target(), null);
  mode = 'newer';
  h.advance(1000); await flush();
  assert.equal(h.target().taskId, 'newer');
  pending.resolve(status('stale')); await flush();
  assert.equal(h.target().taskId, 'newer');
  h.window.__zusageDispose();

  const missingPending = deferred();
  let first = true;
  const h2 = mobileHarness(() => first ? (first = false, status('first')) : missingPending.promise);
  await flush();
  h2.advance(1000); await flush();
  delete h2.window.zcode.getWebRemoteControlStatus;
  h2.advance(1000); await flush();
  assert.equal(h2.target(), null);
  missingPending.resolve(status('stale')); await flush();
  assert.equal(h2.target(), null);
  h2.window.__zusageDispose();
});

test('mobile target: initial synchronous failure publishes null and clears the timeout', async () => {
  const h = mobileHarness(() => { throw new Error('unavailable'); });
  assert.equal(h.target(), null);
  assert.equal(h.timers.size, 1, 'only the polling interval remains');
  h.window.zcode.getWebRemoteControlStatus = () => status('recovered');
  h.advance(1000); await flush();
  assert.equal(h.target().taskId, 'recovered');
  assert.equal(h.timers.size, 1, 'a settled request clears its timeout');
  h.window.__zusageDispose();
});

test('mobile target: a throwing interface getter clears the target and invalidates in-flight work', async () => {
  const pending = deferred();
  let first = true;
  const h = mobileHarness(() => first ? (first = false, status('first')) : pending.promise);
  await flush();
  h.advance(1000); await flush();
  Object.defineProperty(h.window.zcode, 'getWebRemoteControlStatus', { get() { throw new Error('unavailable'); } });
  h.advance(1000); await flush();
  assert.equal(h.target(), null);
  pending.reject(new Error('late failure')); await flush();
  assert.equal(h.target(), null);
  h.window.__zusageDispose();
  assert.equal(h.timers.size, 0);
});

test('mobile target: disposal and generation change discard in-flight results and timers', async () => {
  for (const action of ['dispose', 'generation']) {
    const pending = deferred();
    const h = mobileHarness(() => pending.promise);
    if (action === 'dispose') h.window.__zusageDispose();
    else { h.window.__zusageGen++; h.advance(1000); }
    assert.equal(h.timers.size, 0);
    pending.resolve(status('stale')); await flush();
    assert.equal(h.target(), undefined);
  }
});
