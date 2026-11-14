/* 13-mobile-chips 的 DOM 采集口径锁（specs/mobile-relay.md「DOM 快路径」与「样式复用」）。
 * 桌面状态条的 .it 原样 textContent 直推手机端会产生三类不一致，本测试钉住修法：
 *  1) 子代理格不再跳过（0.2.4 起完全照抄桌面 chip 集，含子代理）；
 *  2) 工具格是 <span class=v>717</span><span class=eb>15</span>，textContent 拼成
 *     "71715" → 只剥离尾部错误数作 err 字段，.dim「N次」保留；
 *  3) 按桌面 DOM 拆 {v 主值, dim 后缀}，速度格 .zu-live 单串拆数字+t/s；
 *  4) id 与桌面 state.show 键对齐（turn/win/today/proj/tools/sub）。
 * 采集逻辑在 overlay.js 的 boot 闭包内，这里按源码契约断言（与 overlay 套件同风格）。 */
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { readOverlayPart, sliceOverlay } = require('./helpers/overlay-extract.cjs');

const mobilePart = readOverlayPart('13-mobile-chips.js');
const source = mobilePart;
const bridgePart = sliceOverlay('  window.__zusagePluginUpdate = function (s) {', '  /* 工作区身份来自当前会话节点', { file: 'src/overlay/01-git-and-doc-tooltips.js' });

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

function mobileHarness(getStatus, initialState = { mobileRelayEnabled: true, mobileRelaySupported: true }, roots = [], mobileMode = false) {
  let now = 0, nextId = 1;
  const timers = new Map();
  function schedule(fn, delay, repeat) {
    const id = nextId++;
    timers.set(id, { fn, at: now + delay, delay, repeat });
    return id;
  }
  let updates = 0, scans = 0;
  const state = { ...initialState };
  const window = { __zusageGen: 1, __zusageUpdate() { updates++; }, zcode: { getWebRemoteControlStatus: getStatus } };
  const context = {
    state, mobileMode, instances: [], stale: () => false, scanRateLines() {},
    window, document: { querySelectorAll: () => { scans++; return roots; } },
    setTimeout: (fn, delay) => schedule(fn, delay, false),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, true),
    clearInterval: (id) => timers.delete(id),
  };
  vm.runInNewContext('(function () {\n' + bridgePart + mobilePart, context);
  return {
    window, timers, state, updates: () => updates, scans: () => scans,
    configure(s) { window.__zusagePluginUpdate(s); },
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

test('mobile relay gate: missing, disabled and malformed state performs no target polling or DOM collection', async () => {
  const cases = [{}, { mobileRelayEnabled: true }, { mobileRelaySupported: true }];
  for (const value of [undefined, null, false, 1, 'true', [], {}]) {
    cases.push({ mobileRelayEnabled: value, mobileRelaySupported: true });
    cases.push({ mobileRelayEnabled: true, mobileRelaySupported: value });
  }
  for (const config of cases) {
    let calls = 0;
    const h = mobileHarness(() => { calls++; return status('private'); }, config);
    h.window.__zusageUpdate({ session: { sid: 'desktop' } });
    h.advance(5000); await flush();
    assert.equal(calls, 0, JSON.stringify(config));
    assert.equal(h.scans(), 0);
    assert.equal(h.updates(), 1, 'desktop snapshots still reach their original consumer');
    assert.equal(h.window.__zusageMobileChips, undefined);
    assert.equal(h.timers.size, 0, 'closed relay owns no polling or harvesting timers');
    h.window.__zusageDispose();
  }
});

function chipRoot() {
  const value = { textContent: '123' };
  const cell = {
    textContent: '123', classList: { contains: () => false },
    getAttribute: key => key === 'aria-label' ? '本轮' : null,
    querySelector: selector => selector === '.v' ? value : null,
    querySelectorAll: () => [],
  };
  const main = { textContent: '123', querySelectorAll: () => [cell] };
  return { querySelector: () => main, getAttribute: () => 'session_a' };
}

test('mobile mode never installs desktop collection, even with enabled relay state and later broadcasts', async () => {
  let calls = 0;
  const enabled = { mobileRelayEnabled: true, mobileRelaySupported: true };
  const h = mobileHarness(() => { calls++; return status('private'); }, enabled, [chipRoot()], true);
  const update = h.window.__zusageUpdate;
  h.configure(enabled);
  h.window.__zusageUpdate({ session: { sid: 'mobile' } });
  h.advance(5000); await flush();
  assert.equal(h.window.__zusageUpdate, update, 'mobile snapshots keep their original consumer');
  assert.equal(h.updates(), 1);
  assert.equal(calls, 0);
  assert.equal(h.scans(), 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.window.__zusageMobileChips, undefined);
  assert.equal(h.window.__zusageDispose, undefined, 'mobile collection does not wrap disposal');
});

test('mobile relay gate: enable starts immediately, disable clears target, chips and scheduled harvest without affecting desktop', async () => {
  let calls = 0;
  const off = { mobileRelayEnabled: false, mobileRelaySupported: true };
  const h = mobileHarness(() => { calls++; return status('session_a'); }, off, [chipRoot()]);
  h.configure({ mobileRelayEnabled: true, mobileRelaySupported: true }); await flush();
  assert.equal(calls, 1); assert.equal(h.target().taskId, 'session_a');
  h.window.__zusageUpdate({}); h.advance(50);
  assert.equal(h.scans(), 1);
  assert.equal(h.window.__zusageMobileChips.bySession.session_a[0].v, '123');
  const previousPayload = h.window.__zusageMobileChips;
  h.window.__zusageUpdate({});
  h.configure(off);
  assert.equal(h.window.__zusageMobileChips, undefined, 'previous payload is removed synchronously');
  assert.equal(h.timers.size, 0);
  h.advance(5000); await flush();
  assert.equal(h.scans(), 1); assert.equal(calls, 1);
  assert.equal(h.updates(), 2);
  h.configure({ mobileRelayEnabled: true, mobileRelaySupported: true }); await flush();
  assert.equal(calls, 2);
  assert.notEqual(h.window.__zusageMobileChips, previousPayload);
  assert.equal(Object.keys(h.window.__zusageMobileChips.bySession).length, 0, 're-enable cannot reuse harvested chips');
  h.configure({ mobileRelayEnabled: true });
  assert.equal(h.window.__zusageMobileChips, undefined, 'capability withdrawal also clears the relay');
  assert.equal(h.timers.size, 0);
  h.window.__zusageDispose();
});

test('mobile relay gate: rapid off/on discards the old status promise before accepting the new target', async () => {
  const old = deferred(), fresh = deferred();
  let calls = 0;
  const h = mobileHarness(() => ++calls === 1 ? old.promise : fresh.promise);
  h.configure({ mobileRelayEnabled: false, mobileRelaySupported: true });
  assert.equal(h.timers.size, 0);
  h.configure({ mobileRelayEnabled: true, mobileRelaySupported: true });
  assert.equal(calls, 2, 're-enable starts a fresh status request despite an unresolved old promise');
  old.resolve(status('old')); await flush();
  assert.equal(h.window.__zusageMobileChips, undefined);
  fresh.resolve(status('fresh')); await flush();
  assert.equal(h.target().taskId, 'fresh');
  h.configure({});
  h.advance(5000); await flush();
  assert.equal(h.window.__zusageMobileChips, undefined); assert.equal(h.timers.size, 0);
  h.window.__zusageDispose();
});

test('mobile relay gate: dispose cancels a pending harvest and clears its payload', async () => {
  const h = mobileHarness(() => status('session_a'), { mobileRelayEnabled: true, mobileRelaySupported: true }, [chipRoot()]);
  await flush();
  h.window.__zusageUpdate({});
  assert.ok(h.timers.size > 1);
  h.window.__zusageDispose();
  h.advance(5000); await flush();
  assert.equal(h.scans(), 0); assert.equal(h.timers.size, 0); assert.equal(h.window.__zusageMobileChips, undefined);
});

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
