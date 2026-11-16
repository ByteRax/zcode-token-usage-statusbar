/* 行为回归：远控目标身份、异步失效、桥路由和 wire 隐私。
 * VM 隔离 stash、诊断写入和 spawn；不访问真实数据库或启动 Python。 */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', 'mobile-relay.cjs');
const source = fs.readFileSync(sourcePath, 'utf8');
const A = 'remote:server:alpha';
const B = 'remote:server:beta';
const SID = 'session_shared';
const target = (identity = A, taskId = SID) => ({
  taskId, workspaceIdentity: identity, workspacePath: '/private/workspace/path',
});

function decode(frame) {
  const b = frame.buffer;
  let i = 1;
  function vql() {
    let n = 0, shift = 0, byte;
    do { byte = b[i++]; n |= (byte & 127) << shift; shift += 7; } while (byte & 128);
    return n >>> 0;
  }
  assert.equal(b[0], 4);
  const count = vql();
  const header = [];
  for (let j = 0; j < count; j++) { assert.equal(b[i++], 6); header.push(vql()); }
  assert.deepEqual(header, [204, 2147483647]);
  assert.equal(b[i++], 5);
  const length = vql();
  assert.equal(i + length, b.length);
  return JSON.parse(b.toString('utf8', i, i + length));
}

function snapshot(identity = A, taskId = SID) {
  return {
    today: { total: 111, requests: 1 },
    session: { sid: 'session_other', title: 'OTHER_SESSION_TITLE', body: 'OTHER_BODY_SECRET' },
    recent: [
      { sid: taskId, total: 112, title: 'LOCAL_TITLE_SECRET' },
      { sid: taskId, workspace_identity: B, remote: true, remote_target: 'beta', total: 222 },
      { sid: taskId, workspace_identity: identity, remote: true, remote_target: 'alpha',
        total: 333, requests: 3, title: 'TARGET_TITLE_SECRET', body: 'TARGET_BODY_SECRET',
        directory: '/private/workspace/path' },
      { sid: 'session_other', total: 999, title: 'OTHER_SESSION_TITLE' },
    ],
    remote_today: { alpha: { total: 444, requests: 4 }, beta: { total: 555, requests: 5 } },
    known_sids: ['session_other'],
  };
}

function assertScope(request, taskId, identity) {
  assert.deepEqual(request.scopes, [{ sid: taskId, workspaceIdentity: identity }]);
  assert.ok(Array.isArray(request.sids));
  assert.ok(request.sids.length === 0 || (request.sids.length === 1 && request.sids[0] === taskId));
  assert.equal(request.lean, true, '手机中继请求必须带 lean，跳过桌面增强字段');
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, message) {
  const until = Date.now() + 1500;
  while (Date.now() < until) {
    if (predicate()) return;
    await wait(10);
  }
  assert.fail(message);
}

function harness(t, options = {}, setup = {}) {
  const requests = [], spawns = [], frames = [], intervals = [], processes = [], hostCalls = [], fsWrites = [];
  let now = 1000000;
  function spawnProc(command, args) {
    spawns.push([command, args]);
    if (setup.legacy && args[1] === 'serve') throw new Error('serve unavailable');
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = new EventEmitter();
    proc.stdin.writable = true;
    proc.stdin.write = (line) => { requests.push(JSON.parse(line)); return true; };
    proc.kills = 0;
    proc.kill = () => { proc.kills++; proc.stdin.writable = false; };
    proc.legacy = args[1] === 'json';
    if (proc.legacy) requests.push(JSON.parse(args[2]));
    processes.push(proc);
    return proc;
  }
  const acceptPayload = function (payload) { hostCalls.push({ receiver: this, payload }); return 'original'; };
  const bridge = (identity) => {
    const e = { p: { send(frame) { frames.push({ identity, bytes: Buffer.from(frame.buffer), body: decode(frame) }); } },
      b: { workspaceIdentity: identity, readyAnnounced: true } };
    e.b.relayProtocol = { protocol: e.p };
    return e;
  };
  const initialBridge = bridge(A);
  if (setup.acceptPayload === 'writable') initialBridge.b.relayProtocol.acceptPayload = acceptPayload;
  if (setup.acceptPayload === 'readonly') {
    Object.defineProperty(initialBridge.b.relayProtocol, 'acceptPayload', { value: acceptPayload, writable: false });
  }
  const globals = {
    Buffer, process, console, setTimeout, clearTimeout,
    setInterval(fn, ms) { const timer = { fn, ms, unref() {} }; intervals.push(timer); return timer; },
    clearInterval(timer) { timer.cleared = true; },
    __zusageRelayStash: [initialBridge],
    __zusageRelayUplinkQueue: [],
  };
  if (setup.fakeClock) globals.Date = class extends Date { static now() { return now; } };
  globals.__zusageRelayUplinkQueue.push({ frame: { zuUp: 2, zuCfg: { gen: 1, prefs: { show: '{}' } } },
    b: globals.__zusageRelayStash[0].b, relay: globals.__zusageRelayStash[0].b.relayProtocol });
  const context = vm.createContext(globals);
  const module = { exports: {} };
  const isolatedRequire = (name) => {
    if (name === 'fs') return { writeFileSync(file) { fsWrites.push(file); } };
    if (name === 'child_process') return { spawn() { throw new Error('unexpected real spawn'); } };
    return require(name);
  };
  const load = vm.runInContext('(function(require,module,exports,__dirname){' + source + '\n})', context,
    { filename: sourcePath });
  load(isolatedRequire, module, module.exports, path.dirname(sourcePath));
  const createRelay = () => module.exports.createMobileRelay({
    log() {}, minIntervalMs: 300, strictOptIn: true, isEnabled: () => true,
    spawnProc,
    ...options,
  });
  let relay = createRelay();
  t.after(() => relay.dispose());
  return {
    get relay() { return relay; },
    requests, spawns, processes, frames, globals, bridge, hostCalls, fsWrites,
    reload() { relay.dispose(); relay = createRelay(); },
    respond(value, proc = processes[processes.length - 1]) {
      proc.stdout.emit('data', Buffer.from(JSON.stringify(value) + (proc.legacy ? '' : '\n')));
      if (proc.legacy) proc.emit('close', 0);
    },
    push(value, validator, verifier) { return relay.push({ zm: 1, ts: Date.now(), target: value }, validator, verifier); },
    uplink(gen = 1, prefs = { show: '{}' }) {
      const b = globals.__zusageRelayStash[0].b;
      globals.__zusageRelayUplinkQueue.push({ frame: { zuUp: 2, zuCfg: { gen, prefs } }, b, relay: b.relayProtocol });
    },
    rawTransport(payload) {
      // 与 mobile_relay_patch.inject_for_uplink 的持久 onRawTransportPayload 同序同形：
      // 在 acceptPayload dispatcher 之前无条件入队，并捕获当前 bridge/relay 的身份。
      const runtime = { currentBridge: globals.__zusageRelayStash[0].b };
      return (payload && payload.zuUp ? ((b) => ((globals.__zusageRelayUplinkQueue =
        globals.__zusageRelayUplinkQueue || []).push({ frame: payload, b,
        relay: b ? b.relayProtocol : undefined }), true))(runtime.currentBridge) : 0) ||
        runtime.currentBridge.relayProtocol.acceptPayload(payload);
    },
    dataFrames() { return frames.filter((f) => f.body.snap || f.body.chips); },
    announce() { const timer = intervals.find((item) => item.ms === 2500); assert.ok(timer); timer.fn(); },
    bridgeTick() { const timer = intervals.find((item) => item.ms === 30000); assert.ok(timer); timer.fn(); },
    dataTick() { const timer = intervals.find((item) => item.ms === 10000); assert.ok(timer); timer.fn(); },
    advance(ms) { now += ms; },
    remoteTick() { const timer = intervals.find((item) => item.ms === 1000); assert.ok(timer); timer.fn(); },
  };
}

test('远端查询携带 scope，并只使用匹配身份及其远端 today', async (t) => {
  const h = harness(t);
  h.push(target());
  await waitFor(() => h.requests.length === 1, '应发起查询');
  assertScope(h.requests[0], SID, A);
  h.respond(snapshot());
  await waitFor(() => h.dataFrames().length === 1, '应发送匹配远端的数据');
  const body = h.dataFrames()[0].body;
  assert.equal(body.snap.session.total, 333);
  assert.equal(body.snap.today.total, 444);
  assert.equal(body.scopeKind, 'remote');
  assert.equal(body.snap.session.remote, true);
  assert.equal(body.snap.recent.length, 1);
  assert.equal(body.snap.session.sid, SID);
  assert.equal(body.snap.session.workspace_identity, undefined);
  assert.equal(body.snap.session.remote_target, undefined);
  assert.equal(body.chips, undefined, '所有目标只交给同一桌面 overlay 渲染');
  assert.match(body.binding, /^[a-f0-9]{32}$/);
});

for (const [label, rows] of [
  ['仅有同 SID 本地记录', [{ sid: SID, total: 112 }]],
  ['仅有同 SID 其他远端记录', [{ sid: SID, workspace_identity: B, remote: true, remote_target: 'beta', total: 222 }]],
  ['目标远端不可用', [{ sid: SID, workspace_identity: A, remote: true, remote_target: 'alpha', remote_missing: true, remote_error: 'unavailable' }, { sid: SID, total: 112 }]],
]) {
  test(`${label}时不可借用其他身份数据`, async (t) => {
    const h = harness(t);
    h.push(target());
    await waitFor(() => h.requests.length === 1, '应发起查询');
    h.respond({ today: { total: 111 }, recent: rows, remote_today: { beta: { total: 555 } } });
    await wait(60);
    assert.equal(h.dataFrames().length, 0, '没有可信目标数据时不推送快照');
  });
}

for (const [label, next] of [
  ['切换 SID', target(A, 'session_new')],
  ['同 SID 切换身份', target(B)],
  ['撤销目标', null],
]) {
  test(`在途查询${label}后丢弃旧响应`, async (t) => {
    const h = harness(t);
    h.push(target());
    await waitFor(() => h.requests.length === 1, '旧目标应发起查询');
    h.push(next);
    if (next) h.globals.__zusageRelayStash[0].b.workspaceIdentity = next.workspaceIdentity;
    h.respond(snapshot());
    await wait(60);
    assert.equal(h.dataFrames().length, 0, '过期结果不得发给当前目标');
    if (next) {
      await waitFor(() => h.requests.length === 2, '新目标应继续查询');
      assertScope(h.requests[1], next.taskId, next.workspaceIdentity);
    } else {
      await wait(350);
      assert.equal(h.requests.length, 1, '撤销后不再查询');
    }
  });
}

test('重复发现相同目标不触发重复查询，DB 事件仍可刷新', async (t) => {
  const h = harness(t);
  h.push(target());
  await waitFor(() => h.requests.length === 1, '首次应查询');
  h.respond(snapshot());
  await waitFor(() => h.dataFrames().length === 1, '首次应推送');
  h.push(target()); h.push(target());
  await wait(400);
  assert.equal(h.requests.length, 1, '重复上报不能安排补拍');
  h.relay.pump();
  await waitFor(() => h.requests.length === 2, 'DB 事件仍应查询');
});

test('多桥无法唯一归属时不发送数据', async (t) => {
  const h = harness(t);
  h.globals.__zusageRelayStash = [h.bridge(A), h.bridge(A)];
  h.push(target());
  await wait(100);
  if (h.requests.length) h.respond(snapshot());
  await wait(60);
  assert.equal(h.dataFrames().length, 0, '歧义桥不得广播数据');
});

test("未 ready 桥不干扰唯一就绪桥的握手及推送", async (t) => {
  const h = harness(t);
  const pending = h.bridge(B); pending.b.readyAnnounced = false;
  h.globals.__zusageRelayStash.push(pending);
  h.push(target());
  await waitFor(() => h.requests.length === 1, "只向就绪桥查询");
  h.respond(snapshot());
  await waitFor(() => h.dataFrames().length === 1, "就绪桥继续推送");
  assert.equal(h.relay.status().bridges, 1);
  assert.equal(h.relay.status().clientReady, true);
  assert.equal(h.dataFrames()[0].identity, A);
});

test('实际编码帧不泄露路径、其他会话、标题或正文', async (t) => {
  const h = harness(t);
  h.push(target());
  await waitFor(() => h.requests.length === 1, '应发起查询');
  h.respond(snapshot());
  await waitFor(() => h.dataFrames().length === 1, '应发送数据帧');
  const frame = h.dataFrames()[0];
  assert.equal(frame.body.mine, SID);
  for (const secret of ['/private/workspace/path', 'session_other', 'LOCAL_TITLE_SECRET',
    'OTHER_SESSION_TITLE', 'OTHER_BODY_SECRET', 'TARGET_TITLE_SECRET', 'TARGET_BODY_SECRET']) {
    assert.equal(frame.bytes.includes(Buffer.from(secret)), false, `帧不得包含 ${secret}`);
  }
});

test('isEnabled 为 false 时公告、查询与数据均不发送', async (t) => {
  const h = harness(t, { isEnabled: () => false });
  h.announce();
  h.push(target());
  await wait(100);
  assert.equal(h.requests.length, 0);
  assert.equal(h.frames.length, 0);
});

test('查询在途时关闭 isEnabled，旧响应及后续公告均不发送', async (t) => {
  let enabled = true;
  const h = harness(t, { isEnabled: () => enabled });
  h.push(target());
  await waitFor(() => h.requests.length === 1, '应发起查询');
  enabled = false;
  h.respond(snapshot());
  h.announce();
  await wait(60);
  assert.equal(h.frames.length, 0);
});

test('实时目标复验未通过时不能发送', async (t) => {
  const h = harness(t);
  let valid = true;
  h.relay.push({ zm: 1, target: target() }, () => true, async () => valid);
  await waitFor(() => h.requests.length === 1, '应发起查询');
  valid = false;
  h.respond(snapshot());
  await wait(80);
  assert.equal(h.dataFrames().length, 0);
});

test('无来源或旧桥上行帧不能激活新桥', async (t) => {
  const h = harness(t);
  const old = h.globals.__zusageRelayStash[0];
  h.globals.__zusageRelayStash = [h.bridge(A)];
  h.push(target());
  await wait(100);
  assert.equal(h.requests.length, 0);
  assert.equal(h.relay.status().clientReady, false);
  h.globals.__zusageRelayUplinkQueue.push({ zuUp: 2, zuCfg: { gen: 2, prefs: {} } });
  h.relay.pump();
  await wait(50);
  assert.equal(h.requests.length, 0);
  assert.notEqual(old, h.globals.__zusageRelayStash[0]);
});

test('能力公告只在上行拦截可用时发送', (t) => {
  for (const mode of ['missing', 'readonly', 'writable']) {
    const h = harness(t, {}, { acceptPayload: mode });
    h.announce();
    assert.equal(h.frames.length, mode === 'writable' ? 1 : 0, mode);
  }
});

test('远端无本地写入时按配置周期重新查询', async (t) => {
  const h = harness(t, { getRemotePollMs: () => 3000 }, { fakeClock: true });
  h.push(target());
  await waitFor(() => h.requests.length === 1, '首次查询');
  h.respond(snapshot());
  await waitFor(() => h.dataFrames().length === 1, '首次发送');
  h.advance(2999); h.remoteTick();
  assert.equal(h.requests.length, 1);
  h.advance(1); h.remoteTick();
  await waitFor(() => h.requests.length === 2, '远端轮询查询');
});

test('数据心跳只驱动本地目标，远端仍严格按 poll_ms', async (t) => {
  const h = harness(t, { getRemotePollMs: () => 60000 }, { fakeClock: true });
  h.push(target());
  await waitFor(() => h.requests.length === 1, '首次查询');
  h.respond(snapshot());
  await waitFor(() => h.dataFrames().length === 1, '首次发送');
  h.advance(10000);
  h.dataTick();
  await wait(30);
  assert.equal(h.requests.length, 1, '远端不能被 10s 数据心跳拉快');
  h.advance(49999);   // 距上次查询 59999ms，仍不足 poll_ms
  h.remoteTick();
  await wait(30);
  assert.equal(h.requests.length, 1, 'poll_ms 未到不查询');
  h.advance(1);       // 60000ms
  h.remoteTick();
  await waitFor(() => h.requests.length === 2, 'poll_ms 到期按远端周期查询');
});

test('多桥瞬态下的 v1 裸帧仍被识别，恢复单桥也不发假公告', async (t) => {
  const h = harness(t, {}, { acceptPayload: 'writable' });
  const first = h.globals.__zusageRelayStash[0];
  h.globals.__zusageRelayStash = [h.bridge(A), h.bridge(A)];
  h.globals.__zusageRelayUplinkQueue.length = 0;
  h.globals.__zusageRelayUplinkQueue.push({ zuUp: 2, zuCfg: { gen: 3, prefs: {} } });
  h.bridgeTick();   // drainUplink：多桥不消费，但必须先识别裸帧
  assert.equal(h.relay.status().legacyUplinkSeen, true);
  assert.equal(h.relay.status().clientReady, false);
  h.globals.__zusageRelayStash = [first];
  h.bridgeTick();
  h.announce();
  assert.equal(h.relay.status().clientReady, false, '裸帧不能在新单桥下补握手');
  assert.equal(h.frames.length, 0, '恢复单桥后也不发假公告');
});

test('本地目标空闲无 DB 事件时数据心跳保证帧间隔 < 手机 TTL', async (t) => {
  const h = harness(t, {}, { fakeClock: true });
  h.push(target(''));
  await waitFor(() => h.requests.length === 1, '首次查询');
  const snap = snapshot('');
  h.respond(snap);
  await waitFor(() => h.dataFrames().length === 1, '首次发送');
  const sentAt = [h.dataFrames()[0].body.ts];
  // 内容不变：10s tick 距上次发送 <15s 被去重跳过，20s 那拍必然放行。
  for (let i = 1; i <= 6; i++) {
    h.advance(10000);
    h.dataTick();
    await waitFor(() => h.requests.length === i + 1, `第 ${i} 次数据心跳应查询`);
    h.respond(snap);
    const frames = h.dataFrames();
    if (frames.length > sentAt.length) sentAt.push(frames[frames.length - 1].body.ts);
  }
  assert.ok(sentAt.length >= 3, '空闲期间应持续发送心跳帧');
  for (let i = 1; i < sentAt.length; i++) {
    const gap = sentAt[i] - sentAt[i - 1];
    assert.ok(gap < 30000, `帧间隔 ${gap}ms 必须小于手机端 30s TTL`);
  }
});

test('DB 事件紧邻数据心跳的相位不产生超过手机 TTL 的空档', async (t) => {
  const h = harness(t, {}, { fakeClock: true });
  h.push(target(''));
  await waitFor(() => h.requests.length === 1, '首次查询');
  const snap = snapshot('');
  h.respond(snap);
  await waitFor(() => h.dataFrames().length === 1, '首次发送');
  const firstTs = h.dataFrames()[0].body.ts;
  h.advance(9000);
  h.relay.pump();   // DB 事件：距首帧 9s，查询后仍被 15s 去重跳过
  await waitFor(() => h.requests.length === 2, 'DB 事件查询');
  h.respond(snap);
  await wait(10);
  assert.equal(h.dataFrames().length, 1, '9s 处内容未变，去重跳过');
  h.advance(1000);  // t=10s，首个 tick 仍 <15s 被跳过
  h.dataTick();
  await waitFor(() => h.requests.length === 3, '首个 tick 查询');
  h.respond(snap);
  await wait(10);
  assert.equal(h.dataFrames().length, 1, '10s 处仍被去重');
  h.advance(10000); // t=20s：距首帧 20s，去重放行
  h.dataTick();
  await waitFor(() => h.requests.length === 4, '第二拍查询');
  h.respond(snap);
  const frames = h.dataFrames();
  assert.equal(frames.length, 2);
  const gap = frames[1].body.ts - firstTs;
  assert.ok(gap < 30000, `去重与 tick 相位间隔 ${gap}ms 必须小于手机 TTL`);
});

test('诊断默认不写盘，显式 diagPath 时才写', async (t) => {
  const plain = harness(t, {}, { fakeClock: true });
  plain.push(target());
  await waitFor(() => plain.requests.length === 1, '查询');
  plain.respond(snapshot());
  await waitFor(() => plain.dataFrames().length === 1, '推送');
  assert.equal(plain.fsWrites.length, 0, '未注入 diagPath 时零写盘');

  const withPath = harness(t, { diagPath: 'test-mobile-relay-diag.json' }, { fakeClock: true });
  withPath.push(target());
  await waitFor(() => withPath.requests.length === 1, '查询');
  withPath.respond(snapshot());
  await waitFor(() => withPath.dataFrames().length === 1, '推送');
  assert.ok(withPath.fsWrites.includes('test-mobile-relay-diag.json'), '显式 diagPath 仍写');
});

test('常驻查询连续早退后进入冷却，冷却到期重新尝试 serve', async (t) => {
  const h = harness(t, {}, { fakeClock: true });
  h.push(target());
  for (let i = 0; i < 3; i++) {
    await waitFor(() => h.requests.length === i + 1, `第 ${i + 1} 次查询应走常驻`);
    h.advance(1000);
    h.processes[i].emit('close', 1);   // <30s 早退：累计一次失败
    h.advance(2000);
    if (i < 2) h.relay.pump();
  }
  h.relay.pump();
  await waitFor(() => h.spawns.length === 4, '冷却期应改用一次性 json');
  assert.equal(h.spawns[3][1][1], 'json');
  h.respond({ error: 'one shot' }, h.processes[3]);
  h.advance(59000);
  h.relay.pump();
  await waitFor(() => h.spawns.length === 5, '冷却到期重新尝试常驻');
  assert.equal(h.spawns[4][1][1], 'serve');
});

test('v1 裸上行帧被识别但不绑定当前桥，能力公告随之停止', async (t) => {
  const h = harness(t, {}, { acceptPayload: 'writable' });
  h.globals.__zusageRelayUplinkQueue.length = 0;
  // v1 持久钩子直接推裸帧（没有 {frame,b,relay} 外壳）
  h.globals.__zusageRelayUplinkQueue.push({ zuUp: 2, zuCfg: { gen: 3, prefs: {} } });
  h.push(target());
  await waitFor(() => h.relay.status().legacyUplinkSeen === true, '应识别旧代裸帧');
  h.announce();
  assert.equal(h.frames.length, 0, '旧代裸帧存在时不发能力公告');
  assert.equal(h.relay.status().clientReady, false, '裸帧不能打开推送门控');
  assert.match(h.relay.status().lastError, /legacy uplink/);
  assert.equal(h.relay.status().uplinkFrames, 1);
});

test('acceptPayload 只读时持久 v2 标记可恢复能力公告', (t) => {
  const h = harness(t, {}, { acceptPayload: 'readonly' });
  h.globals.__zusageRelayUplinkGeneration = 2;
  h.announce();
  assert.equal(h.frames.length, 1, '持久 v2 注入标记等价于运行时包裹成功');
  assert.equal(h.frames[0].body.zuUpCap, 2);
});

test('切换后查询失败发送新目标不可用帧', async (t) => {
  const h = harness(t);
  h.push(target());
  await waitFor(() => h.requests.length === 1, '首次查询');
  h.respond(snapshot());
  await waitFor(() => h.dataFrames().length === 1, '首次发送');
  h.push(target(A, 'session_new'));
  await waitFor(() => h.requests.length === 2, '新目标查询');
  h.respond({ recent: [], today: { total: 111 } });
  await waitFor(() => h.frames.some((f) => f.body.state === 'unavailable'), '发送不可用状态');
  const body = h.frames.find((f) => f.body.state === 'unavailable').body;
  assert.equal(body.mine, 'session_new');
  assert.equal(body.target.taskId, 'session_new');
  assert.equal(body.scopeKind, 'remote');
  assert.equal(body.snap, undefined);
  assert.equal(body.chips, undefined);
});

test('同 SID 切换身份重新生成匿名绑定，重复发现保持绑定', async (t) => {
  const h = harness(t);
  h.push(target());
  await waitFor(() => h.requests.length === 1, '首次查询');
  h.respond(snapshot());
  await waitFor(() => h.dataFrames().length === 1, '首次发送');
  const first = h.dataFrames()[0].body.binding;
  h.push(target());
  await wait(320);
  h.relay.pump();
  await waitFor(() => h.requests.length === 2, '相同目标重新查询');
  const changed = snapshot(); changed.recent[2].total++;
  h.respond(changed);
  await waitFor(() => h.dataFrames().length === 2, '相同目标变化发送');
  assert.equal(h.dataFrames()[1].body.binding, first);
  h.push(target(B));
  await waitFor(() => h.requests.length === 3, '新身份查询');
  h.respond(snapshot(B));
  await waitFor(() => h.dataFrames().length === 3, '新身份发送');
  assert.notEqual(h.dataFrames()[2].body.binding, first);
});

test('相同目标的桥代次变化丢弃在途旧查询', async (t) => {
  const h = harness(t);
  const old = { ...target(), bridgeState: {}, relay: {}, remoteSessionId: 'route-1' };
  h.push(old);
  await waitFor(() => h.requests.length === 1, '旧查询');
  h.push({ ...old, bridgeState: {}, relay: {}, remoteSessionId: 'route-2' });
  h.respond(snapshot());
  await wait(60);
  assert.equal(h.dataFrames().length, 0);
  await waitFor(() => h.requests.length === 2, '新代次继续查询');
  h.respond(snapshot());
  await waitFor(() => h.dataFrames().length === 1, '只发送新查询');
});

for (const [label, oldFails] of [
  ['旧成功不得覆盖新不可用', false],
  ['旧不可用不得清除新成功', true],
]) {
  test(`同 binding 发送复验乱序：${label}`, async (t) => {
    const h = harness(t, {}, { fakeClock: true });
    const checks = [];
    h.relay.push({ zm: 1, target: target() }, () => true,
      () => new Promise(resolve => checks.push(resolve)));
    await waitFor(() => h.requests.length === 1, '第一次查询');
    h.respond(oldFails ? { error: 'old query failed' } : snapshot());
    await waitFor(() => checks.length === 1, '旧结果停在异步复验');
    h.advance(1000); h.relay.pump();
    await waitFor(() => h.requests.length === 2, '第二次查询');
    const fresh = snapshot(); fresh.recent[2].total = 777;
    h.respond(oldFails ? fresh : { error: 'new query failed' });
    await waitFor(() => checks.length === 2, '新结果独立复验');
    checks[1](true);
    await waitFor(() => h.frames.some(f => oldFails ? f.body.snap : f.body.state === 'unavailable'), '新结果先发送');
    const freshFrames = h.frames.filter(f => f.body.snap || f.body.state === 'unavailable');
    assert.equal(freshFrames.length, 1);
    if (oldFails) assert.equal(freshFrames[0].body.snap.session.total, 777);
    else assert.equal(freshFrames[0].body.state, 'unavailable');
    h.advance(1000); checks[0](true); await wait(40);
    assert.equal(h.frames.filter(f => f.body.snap || f.body.state === 'unavailable').length, 1,
      '迟到旧复验不得发送任何数据或不可用帧');
  });
}

test('常驻查询使用 getPythonCmd 返回的解释器', async (t) => {
  const h = harness(t, { getPythonCmd: () => 'custom-python-executable' });
  h.push(target());
  await waitFor(() => h.spawns.length === 1, '应启动常驻查询');
  assert.equal(h.spawns[0][0], 'custom-python-executable');
  assert.equal(h.spawns[0][1][1], 'serve');
});

for (const [label, getter] of [
  ['缺 getter', undefined], ['非函数 getter', true], ['false', () => false],
  ['undefined', () => undefined], ['null', () => null], ['字符串', () => 'true'],
  ['数字', () => 1], ['对象', () => ({ enabled: true })], ['数组', () => [true]],
  ['装箱布尔', () => new Boolean(true)], ['Promise', () => Promise.resolve(true)],
  ['getter 抛错', () => { throw new Error('invalid config'); }],
]) {
  test(`显式启用门控：${label}时公告 tick、查询与快照全部关闭`, async (t) => {
    const h = harness(t, { isEnabled: getter }, { acceptPayload: 'writable' });
    h.announce();
    h.push(target());
    h.relay.pump(); h.remoteTick(); h.bridgeTick();
    await wait(30);
    assert.equal(h.frames.length, 0, '包括能力公告与 unavailable 在内零插件帧');
    assert.equal(h.spawns.length, 0, '不得启动插件查询进程');
    assert.equal(h.relay.status().target, null);
    assert.equal(h.relay.status().clientReady, false);
    assert.equal(h.relay.status().clientCfgGen, 0);
    assert.equal(h.globals.__zusageRelayUplinkQueue.length, 0, '关闭时排空并忽略手机配置');
  });
}

for (const legacy of [false, true]) {
  test(`disable 同步回收${legacy ? '一次性回退' : '常驻'}查询并隔离快速关开`, async (t) => {
    let enabled = true;
    const h = harness(t, { isEnabled: () => enabled }, { legacy, fakeClock: true, acceptPayload: 'writable' });
    h.announce();
    assert.equal(h.frames.length, 1, '显式 true 才发能力公告');
    h.push(target());
    await waitFor(() => h.requests.length === 1, '旧查询开始');
    const old = h.processes[0];
    h.relay.pump(); // queryPending 必须随关闭清除
    h.uplink(9);
    enabled = false;
    assert.equal(typeof h.relay.disable, 'function');
    h.relay.disable();
    assert.equal(old.kills, 1, '返回前已回收查询');
    assert.equal(h.relay.status().target, null, '返回前已撤销目标');
    assert.equal(h.relay.status().clientReady, false);
    assert.equal(h.relay.status().clientCfgGen, 0);
    assert.equal(h.globals.__zusageRelayUplinkQueue.length, 0, '关闭前排队的配置失效');
    h.announce(); h.bridgeTick(); h.remoteTick(); h.relay.pump();
    const hostRelay = h.globals.__zusageRelayStash[0].b.relayProtocol;
    assert.equal(hostRelay.acceptPayload({ zuUp: 2, zuCfg: { gen: 10, prefs: {} } }), true);
    assert.equal(h.globals.__zusageRelayUplinkQueue.length, 0, '关闭期间上行安全消费且不保留');
    assert.equal(h.frames.length, 1, '关闭不发公告、数据或手机撤销帧');
    enabled = true;
    h.announce();
    assert.equal(h.frames.length, 2, '重开后可立即重新公告');
    assert.equal(h.frames[1].body.cfgGen, 0, '旧配置回执已清除');
    h.push(target());
    h.respond(snapshot(), old);
    h.relay.pump();
    await wait(40);
    assert.equal(h.requests.length, 1, '新目标仍需重新握手');
    assert.equal(h.dataFrames().length, 0, '关开后旧结果也不得复活');
    h.uplink(1); // 新握手可从低 gen 开始
    h.relay.pump();
    await waitFor(() => h.requests.length === 2, '重新握手后启动新查询');
    const fresh = h.processes[1];
    h.respond({ error: 'late failure' }, old);
    old.emit('close', 1);
    h.relay.pump();
    assert.equal(h.requests.length, 2, '迟到失败不得释放新查询的 busy 状态');
    h.respond(snapshot(), fresh);
    await waitFor(() => h.dataFrames().length === 1, '新查询正常推送');
    assert.equal(h.dataFrames()[0].body.cfgGen, 1);
    assert.equal(h.frames.some((f) => f.body.state === 'unavailable'), false, '旧错误不得产生不可用帧');
  });
}

for (const payload of [snapshot(), { error: 'failed' }]) {
  test(`关闭时丢弃旧${payload.error ? '失败' : '成功'}回包，不发送 unavailable`, async (t) => {
    let enabled = true;
    const h = harness(t, { isEnabled: () => enabled });
    h.push(target());
    await waitFor(() => h.requests.length === 1, '查询开始');
    enabled = false;
    h.relay.disable();
    h.respond(payload, h.processes[0]);
    await wait(30);
    assert.equal(h.frames.length, 0);
    assert.equal(h.requests.length, 1);
  });
}

for (const unavailable of [false, true]) {
  test(`等待目标复验的${unavailable ? 'unavailable' : '快照'}在关闭重开后失效`, async (t) => {
    let enabled = true, finishVerify;
    const verification = new Promise((resolve) => { finishVerify = resolve; });
    const h = harness(t, { isEnabled: () => enabled });
    h.push(target(), () => true, () => verification);
    await waitFor(() => h.requests.length === 1, '查询开始');
    h.respond(unavailable ? { error: 'failed' } : snapshot());
    enabled = false;
    h.relay.disable();
    enabled = true;
    h.uplink(); h.push(target());
    finishVerify(true);
    await wait(40);
    assert.equal(h.frames.length, 0, '相同 SID 与身份重开也不能发送旧代结果');
  });
}

test('disable 清除限频补拍排程，重开后需要新目标与新握手', async (t) => {
  let enabled = true;
  const h = harness(t, { isEnabled: () => enabled }, { fakeClock: true });
  h.push(target());
  await waitFor(() => h.requests.length === 1, '首次查询');
  h.respond(snapshot());
  await waitFor(() => h.dataFrames().length === 1, '首次推送');
  h.relay.pump(); // 限频补拍已排程
  enabled = false; h.relay.disable(); enabled = true;
  h.relay.pump(); // 先观察重新启用边沿，之前的积压均视为旧握手
  h.uplink(); h.relay.pump();
  h.advance(1000);
  await wait(350);
  assert.equal(h.requests.length, 1, '旧排程与目标不复用');
  h.push(target());
  await waitFor(() => h.requests.length === 2, '新目标重新启动查询');
});

for (const strictOptIn of [undefined, null, false, 0, 1, 'true', [], {}, new Boolean(true)]) {
  test(`旧 cold loader 能力 ${String(strictOptIn)} 不得以缺省 true 回调启用新 relay`, async (t) => {
    const h = harness(t, { strictOptIn, isEnabled: () => true }, { acceptPayload: 'writable' });
    const relay = h.globals.__zusageRelayStash[0].b.relayProtocol;
    assert.equal(relay.acceptPayload({ zuUp: 2, zuCfg: { gen: 99, prefs: {} } }), true);
    h.rawTransport({ zuUp: 2, zuCfg: { gen: 100, prefs: {} } });
    h.push(target()); h.relay.pump(); h.announce(); h.remoteTick(); h.bridgeTick();
    await wait(30);
    assert.equal(h.frames.length, 0, '无能力标记时零公告/快照/unavailable');
    assert.equal(h.spawns.length, 0, '不启动中继查询');
    assert.equal(h.relay.status().clientReady, false);
    assert.equal(h.globals.__zusageRelayUplinkQueue.length, 0);
    const hostFrame = { zcode_type: 'rpc-frame', seq: 8 };
    assert.equal(relay.acceptPayload(hostFrame), 'original');
    assert.equal(h.hostCalls.at(-1).payload, hostFrame, '普通宿主协议仍透传');
  });
}

for (const first of ['push', 'pump', 'announce']) {
  test(`持久 hook 关闭期间入队后重开，首个 ${first} 丢弃旧偏好并等待新握手`, async (t) => {
    let enabled = true;
    const h = harness(t, { isEnabled: () => enabled }, { fakeClock: true, acceptPayload: 'writable' });
    h.push(target());
    await waitFor(() => h.requests.length === 1, '关闭前查询');
    h.respond(snapshot());
    await waitFor(() => h.dataFrames().length === 1, '关闭前发送');
    enabled = false;
    h.relay.disable();
    assert.equal(h.rawTransport({ zuUp: 2, zuCfg: { gen: 99, prefs: { show: '{"win":0}' } } }), true);
    assert.equal(h.globals.__zusageRelayUplinkQueue.length, 1, '持久 hook 绕过 dispatcher 无条件入队');
    assert.equal(h.hostCalls.length, 0, '持久 hook 在宿主 seq 校验前消费');
    enabled = true;
    if (first === 'push') h.push(target());
    if (first === 'pump') h.relay.pump();
    if (first === 'announce') h.announce();
    h.push(target()); h.relay.pump(); h.announce();
    await wait(40);
    assert.equal(h.relay.status().clientReady, false, '关闭时旧偏好不算新握手');
    assert.equal(h.relay.status().clientCfgGen, 0);
    assert.equal(h.requests.length, 1, '新握手前无额外查询');
    assert.equal(h.globals.__zusageRelayUplinkQueue.length, 0);
    assert.equal(h.frames[h.frames.length - 1].body.cfgGen, 0, '重新公告回执归零');
    assert.equal(h.frames[h.frames.length - 1].body.chips, undefined);
    h.rawTransport({ zuUp: 2, zuCfg: { gen: 1, prefs: { show: '{}' } } });
    h.relay.pump();
    await waitFor(() => h.requests.length === 2, '新鲜持久 hook 握手后查询');
    h.respond(snapshot());
    await waitFor(() => h.dataFrames().length === 2, '新配置正常发送');
    const body = h.dataFrames()[1].body;
    assert.equal(body.cfgGen, 1, '不受旧 gen99 阻挡');
    assert.equal(body.chips, undefined, '统一 UI 不恢复旧 chips 协议');
    assert.equal(body.snap.session.total, 333, '新握手发送受限统计快照');
    assert.equal(h.relay.status().clientCfgGen, 1, '旧隐藏偏好的 gen99 已被清除');
  });
}

test('初始关闭未 tick，持久 hook 入队后首次启用也丢弃旧配置', async (t) => {
  let enabled = false;
  const h = harness(t, { isEnabled: () => enabled }, { fakeClock: true, acceptPayload: 'writable' });
  h.rawTransport({ zuUp: 2, zuCfg: { gen: 99, prefs: {} } });
  enabled = true;
  h.push(target()); h.relay.pump(); h.announce();
  await wait(40);
  assert.equal(h.spawns.length, 0, '初始关闭期间帧不能授权首次查询');
  assert.equal(h.relay.status().clientReady, false);
  assert.equal(h.frames[0].body.cfgGen, 0);
  const hostRelay = h.globals.__zusageRelayStash[0].b.relayProtocol;
  assert.equal(hostRelay.acceptPayload({ zuUp: 2, zuCfg: { gen: 1, prefs: {} } }), true);
  h.relay.pump();
  await waitFor(() => h.requests.length === 1, '启用边沿后的 dispatcher 新握手有效');
  assert.equal(h.relay.status().clientCfgGen, 1);
});

test('同一宿主桥热换后安全上行由新实例消费，包装不累计', async (t) => {
  let enabled = true;
  const h = harness(t, { isEnabled: () => enabled }, { acceptPayload: 'writable' });
  const hostRelay = h.globals.__zusageRelayStash[0].b.relayProtocol;
  const wrapped = hostRelay.acceptPayload;
  const old = h.relay;
  h.reload();
  assert.equal(hostRelay.acceptPayload, wrapped, '复用宿主桥上的稳定 dispatcher');
  assert.equal(hostRelay.acceptPayload({ zuUp: 2, zuCfg: { gen: 1, prefs: {} } }), true);
  h.push(target());
  await waitFor(() => h.requests.length === 1, 'dispose 后新实例仍能收到手机握手');
  assert.equal(h.relay.status().clientReady, true);
  h.respond(snapshot());
  await waitFor(() => h.dataFrames().length === 1, '新实例正常发送');
  enabled = false; h.relay.disable();
  h.reload();
  assert.equal(hostRelay.acceptPayload, wrapped, '多次热换也不增加包装层');
  hostRelay.acceptPayload({ zuUp: 2, zuCfg: { gen: 2, prefs: {} } });
  assert.equal(h.globals.__zusageRelayUplinkQueue.length, 0, '关闭实例继续消费并忽略');
  enabled = true;
  old.dispose(); // 旧实例重复清理也不能移除新实例的 dispatcher handler
  hostRelay.acceptPayload({ zuUp: 2, zuCfg: { gen: 1, prefs: {} } });
  h.push(target());
  await waitFor(() => h.requests.length === 2, '重开后仍能握手查询');
  const hostFrame = { zcode_type: 'rpc-frame', seq: 8 };
  assert.equal(hostRelay.acceptPayload(hostFrame), 'original');
  assert.equal(h.hostCalls.length, 1);
  assert.equal(h.hostCalls[0].receiver, hostRelay);
  assert.equal(h.hostCalls[0].payload, hostFrame);
});

test('关闭时仅安全消费插件上行帧，宿主无标记帧保持参数、接收者与返回值', (t) => {
  const h = harness(t, { isEnabled: () => false }, { acceptPayload: 'writable' });
  const relay = h.globals.__zusageRelayStash[0].b.relayProtocol;
  const pluginFrame = { zuUp: 2, zuCfg: { gen: 4, prefs: { show: '{}' } } };
  assert.equal(relay.acceptPayload(pluginFrame), true);
  assert.equal(h.hostCalls.length, 0, '插件帧不进入宿主 seq 校验');
  assert.equal(h.globals.__zusageRelayUplinkQueue.length, 0, '不保留关闭时的配置');
  for (const payload of [{ zcode_type: 'rpc-frame', seq: 7 }, { zuUp: 0 }, null]) {
    assert.equal(relay.acceptPayload(payload), 'original');
    assert.equal(h.hostCalls.at(-1).payload, payload);
    assert.equal(h.hostCalls.at(-1).receiver, relay);
  }
  assert.equal(h.hostCalls.length, 3);
  assert.equal(h.frames.length, 0);
});
