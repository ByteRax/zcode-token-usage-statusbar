/* End-to-end local projection through the real relay encoder, with isolated I/O. */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', 'mobile-relay.cjs');
const source = fs.readFileSync(sourcePath, 'utf8');
const SID = 'session_target';

function decode(frame) {
  const b = frame.buffer;
  let i = 0;
  function vql() {
    let n = 0, shift = 0, byte;
    do { byte = b[i++]; n |= (byte & 127) << shift; shift += 7; } while (byte & 128);
    return n >>> 0;
  }
  assert.equal(b[i++], 4);
  assert.equal(vql(), 2);
  assert.equal(b[i++], 6);
  assert.equal(vql(), 204);
  assert.equal(b[i++], 6);
  assert.equal(vql(), 2147483647);
  assert.equal(b[i++], 5);
  const length = vql();
  assert.equal(i + length, b.length);
  return JSON.parse(b.toString('utf8', i));
}

async function sendSnapshot(t, payload) {
  const frames = [], requests = [];
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.writable = true;
  proc.stdin.write = (line) => {
    requests.push(JSON.parse(line));
    setImmediate(() => proc.stdout.emit('data', Buffer.from(JSON.stringify(payload) + '\n')));
    return true;
  };
  proc.kill = () => { proc.stdin.writable = false; };
  const bridge = { p: { send: (frame) => frames.push({ bytes: Buffer.from(frame.buffer), body: decode(frame) }) }, b: { readyAnnounced: true } };
  bridge.b.relayProtocol = { protocol: bridge.p };
  const globals = { Buffer, process, console, setTimeout, clearTimeout, setInterval, clearInterval,
    __zusageRelayStash: [bridge], __zusageRelayUplinkQueue: [
      { frame: { zuUp: 2, zuCfg: { gen: 1, prefs: { show: '{}' } } }, b: bridge.b, relay: bridge.b.relayProtocol },
    ] };
  const context = vm.createContext(globals);
  const module = { exports: {} };
  const isolatedRequire = (name) => {
    if (name === 'fs') return { writeFileSync() {} };
    if (name === 'child_process') return { spawn() { throw new Error('unexpected spawn'); } };
    return require(name);
  };
  vm.runInContext('(function(require,module,exports,__dirname){' + source + '\n})', context,
    { filename: sourcePath })(isolatedRequire, module, module.exports, path.dirname(sourcePath));
  const relay = module.exports.createMobileRelay({ strictOptIn: true, isEnabled: () => true, spawnProc: () => proc });
  t.after(() => relay.dispose());
  relay.push({ zm: 1, target: { taskId: SID, workspaceIdentity: '' } });
  const deadline = Date.now() + 2000;
  while (!frames.some((f) => f.body.snap) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const frame = frames.find((f) => f.body.snap);
  assert.ok(frame, 'local snapshot should be sent');
  assert.deepEqual(requests[0], { lean: true, sids: [SID], scopes: [] });
  return frame;
}

test('local encoded projection keeps useful numeric arrays while removing private text', async (t) => {
  const model = 'MODEL_SECRET_/private/project';
  const tool = 'TOOL_SECRET_/private/file';
  const row = {
    sid: SID, title: 'TITLE_SECRET', directory: '/private/project', total: 1234,
    ctx: 41000, context_window: 128000, context_auto: true, tool_calls: 7,
    last: { tps: 20.5, startedAt: 1000, endedAt: 2000, model,
      provider_id: 'PROVIDER_SECRET', rates: { input: 3, key: 'RATE_SECRET' } },
    last_turn: { total: 42, tool_errors: 2, gen_ms: 100, ended: 2000,
      models: [{ model, total: 42, requests: 1, cost_usd: 0.2 }] },
    models: [{ model, total: 1234, requests: 3, rates: { input: 1, key: 'RATE_SECRET' } }],
    project: { total: 2345, sessions: 2, models: [{ model, total: 2345, requests: 4 }] },
    sub: { total: 90, requests: 2, active: true, rate_avg: 30,
      list: [{ sid: 'SUB_SID_SECRET', title: 'SUB_TITLE_SECRET', task: 'TASK_SECRET',
        agent: 'AGENT_SECRET', total: 90, requests: 2, tps_avg: 30, tps_out: 60, tps_gen: 2000,
        last: 1950, models: [{ model, total: 90, requests: 2 }] }] },
    tools: { total: 7, errors: 2, list: [{ name: tool, count: 7, duration_ms: 100, errors: 2,
      title: 'TOOL_TITLE_SECRET' }] },
    speed_segs: [{ v: 12.5, t: 1800, i: 100, o: 25, n: 2, c: 0.1, m: model,
      title: 'SPEED_TITLE_SECRET' }],
  };
  const payload = { today: { total: 999, models: [{ model, total: 999, requests: 4 }] },
    recent: [row, { sid: 'OTHER_SESSION_SECRET', title: 'OTHER_TITLE_SECRET', total: 9999 }],
    session: { sid: 'OTHER_SESSION_SECRET', title: 'OTHER_TITLE_SECRET' } };
  const frame = await sendSnapshot(t, payload);
  const snap = frame.body.snap, projected = snap.session;
  assert.equal(snap.recent.length, 1);
  assert.equal(projected.sid, SID);
  assert.equal(projected.ctx, 41000);
  assert.equal(projected.context_window, 128000);
  assert.equal(projected.context_auto, true);
  assert.equal(projected.last.startedAt, 1000);
  assert.equal(projected.last.endedAt, 2000);
  assert.deepEqual(projected.speed_segs[0], { v: 12.5, t: 1800, i: 100, o: 25, n: 2, c: 0.1, m: projected.models[0].model });
  assert.equal(projected.tools.list[0].count, 7);
  assert.equal(projected.tools.list[0].errors, 2);
  assert.equal(projected.tools.list[0].name, 'Tool 1');
  assert.equal(projected.sub.list.length, 1);
  assert.equal(projected.sub.list[0].sid, 'agent-1');
  assert.equal(projected.sub.list[0].tps_out, 60);
  assert.equal(projected.sub.list[0].last, 1950);
  assert.equal(projected.sub.list[0].models[0].total, 90);
  assert.equal(projected.last.model, projected.models[0].model);
  assert.equal(projected.last_turn.models[0].model, projected.models[0].model);
  assert.equal(snap.today.models[0].total, 999);
  for (const secret of [model, tool, 'TITLE_SECRET', '/private/project', 'PROVIDER_SECRET', 'RATE_SECRET',
    'SUB_SID_SECRET', 'SUB_TITLE_SECRET', 'TASK_SECRET', 'AGENT_SECRET', 'TOOL_TITLE_SECRET',
    'SPEED_TITLE_SECRET', 'OTHER_SESSION_SECRET', 'OTHER_TITLE_SECRET']) {
    assert.equal(frame.bytes.includes(Buffer.from(secret)), false, `wire leaked ${secret}`);
  }
});

test('projection bounds arrays and rejects mismatched field types', async (t) => {
  const row = { sid: SID, total: 'TEXT_SECRET', ctx: { total: 123 }, context_window: 64000,
    active: 'TEXT_SECRET', last: { startedAt: 'TEXT_SECRET', endedAt: 1234 },
    models: Array.from({ length: 100 }, (_, i) => ({ model: 'MODEL_SECRET_' + i, total: i })),
    tools: { total: 100, list: Array.from({ length: 100 }, (_, i) => ({ name: 'TOOL_SECRET_' + i, count: i })) },
    sub: { list: Array.from({ length: 100 }, (_, i) => ({ sid: 'SUB_SECRET_' + i, total: i })) },
    speed_segs: Array.from({ length: 100 }, (_, i) => ({ v: i, t: i + 1, m: 'SPEED_SECRET_' + i })) };
  const frame = await sendSnapshot(t, { today: {}, recent: [row] });
  const projected = frame.body.snap.session;
  assert.equal(projected.total, undefined);
  assert.equal(projected.ctx, undefined);
  assert.equal(projected.active, undefined);
  assert.equal(projected.last.startedAt, undefined);
  assert.equal(projected.last.endedAt, 1234);
  assert.equal(projected.models.length, 16);
  assert.equal(projected.tools.list.length, 32);
  assert.equal(projected.sub.list.length, 32);
  assert.equal(new Set(projected.sub.list.map((x) => x.sid)).size, 32);
  assert.equal(projected.speed_segs.length, 20);
  assert.equal(projected.speed_segs[0].v, 80);
  assert.equal(projected.speed_segs[19].v, 99);
  for (const secret of ['TEXT_SECRET', 'MODEL_SECRET_', 'TOOL_SECRET_', 'SUB_SECRET_', 'SPEED_SECRET_']) {
    assert.equal(frame.bytes.includes(Buffer.from(secret)), false, `wire leaked ${secret}`);
  }
});
