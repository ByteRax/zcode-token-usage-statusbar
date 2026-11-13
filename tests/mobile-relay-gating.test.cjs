/* mobile-relay 门控与配置裁剪单元锁（specs/mobile-relay.md「v346 触发模型与门控」）：
 * - **门控**：只有收到手机上行配置（clientReady）后才查库推送；单纯建立远控通道不推；
 * - **事件驱动**：pump() 由 inject-main 的 DB watcher 调用（无内部轮询），
 *   查询节流 MIN_PUSH_INTERVAL_MS，未满足时补一拍；
 * - **配置裁剪**：按手机 zusage3.show 过滤 chips（speed/quota 恒保留，缺键全开，
 *   损坏 fail-open 不裁）。
 * spawnProc 替身：模拟常驻 serve 回罐头快照，不拉真 Python。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createMobileRelay } = require('../mobile-relay.cjs');

function decodeEventFireJson(frame) {
  const b = frame.buffer;
  let i = 1;
  const readVQL = () => { let v = 0, sh = 0; for (;;) { const byte = b[i++]; v |= (byte & 0x7f) << sh; if (!(byte & 0x80)) return v >>> 0; sh += 7; } };
  const n = readVQL();
  for (let k = 0; k < n; k++) { i++; readVQL(); }
  assert.equal(b[i++], 5, "帧体是 Object(JSON)");
  const len = readVQL();
  return JSON.parse(b.toString("utf8", i, i + len));
}

const CANNED = JSON.stringify({
  today: { total: 100, turns: 2, requests: 3 },
  recent: [{
    sid: "sess_x", title: "t", total: 90, turns: 2, requests: 3, tool_calls: 7,
    avg_tps: 40, last: { tps: 55 }, last_turn: { total: 1000, requests: 1 },
    project: { total: 500, sessions: 1, requests: 9 },
    sub: { total: 2000, requests: 2 },
    tools: { errors: 1 },
  }],
});

function makeRelay(t, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-gate-"));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { } });
  const sent = [];
  let stdoutCb = null;
  const proc = {
    stdin: { writable: true, on: () => { }, write: () => { setImmediate(() => { if (stdoutCb) stdoutCb(Buffer.from(CANNED + "\n", "utf8")); }); } },
    stdout: { on: (ev, cb) => { if (ev === "data") stdoutCb = cb; } },
    stderr: { on: () => { } }, on: () => { }, kill: () => { },
  };
  globalThis.__zusageRelayStash = [{ p: { send: (f) => sent.push(decodeEventFireJson(f)) }, b: { relayProtocol: {} } }];
  const relay = createMobileRelay(Object.assign({ log: () => { }, spawnProc: () => proc }, opts || {}));
  t.after(() => {
    relay.dispose();
    delete globalThis.__zusageRelayStash;
    delete globalThis.__zusageRelayUplinkQueue;
  });
  return { relay, sent };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("门控：未收到手机配置时不查库不推送（仅建通道不推）", async (t) => {
  const { relay, sent } = makeRelay(t);
  relay.push({ zm: 1, ts: Date.now(), target: { taskId: "sess_x" } });
  await wait(150);
  assert.equal(relay.status().clientReady, false);
  assert.equal(relay.status().queryRuns, 0, "无配置：零查询");
  assert.equal(sent.length, 0, "无配置：零推送");
});

test("门控：收到配置后开始推送，且下行帧带 zuUpCap/cfgGen 握手字段", async (t) => {
  const { relay, sent } = makeRelay(t);
  globalThis.__zusageRelayUplinkQueue = [{ zuUp: 2, zuCfg: { gen: 1, prefs: { show: "{}" } } }];
  relay.push({ zm: 1, ts: Date.now(), target: { taskId: "sess_x" } });
  await wait(200);
  assert.equal(relay.status().clientReady, true);
  assert.ok(sent.length >= 1, "有配置：推送");
  const body = sent[0];
  assert.equal(body.zuUpCap, 2);
  assert.equal(body.cfgGen, 1);
});

test("限频与桌面同源：默认 1500ms（activity_min_ms），可由 options 注入", async (t) => {
  // 注入 300ms 下限值：两次 pump 间隔 <300 只查一次
  const fast = makeRelay(t, { minIntervalMs: 300 });
  globalThis.__zusageRelayUplinkQueue = [{ zuUp: 2, zuCfg: { gen: 1, prefs: { show: "{}" } } }];
  fast.relay.push({ zm: 1, ts: Date.now(), target: { taskId: "sess_x" } });
  await wait(150);
  const n1 = fast.relay.status().queryRuns;
  fast.relay.pump(); fast.relay.pump();
  await wait(80);
  assert.equal(fast.relay.status().queryRuns, n1, "300ms 窗口内不重复查询");
  await wait(500);
  assert.ok(fast.relay.status().queryRuns > n1, "窗口过后补拍执行");
});

test("限频 getter 热生效：改配置后下一拍即用新值（无需重建）", async (t) => {
  let limit = 2000;
  const { relay } = makeRelay(t, { getMinIntervalMs: () => limit });
  globalThis.__zusageRelayUplinkQueue = [{ zuUp: 2, zuCfg: { gen: 1, prefs: { show: "{}" } } }];
  relay.push({ zm: 1, ts: Date.now(), target: { taskId: "sess_x" } });
  await wait(120);
  const n1 = relay.status().queryRuns;
  relay.pump();
  await wait(60);
  assert.equal(relay.status().queryRuns, n1, "2s 限频内不查");
  limit = 300;               // 用户改 config.json → getter 读新值
  relay.pump();
  await wait(400);
  assert.ok(relay.status().queryRuns > n1, "改小限频后补拍即生效");
});

test("事件驱动：pump() 即对账（DB 写入触发路径），节流内补拍", async (t) => {
  const { relay } = makeRelay(t, { minIntervalMs: 300 });
  globalThis.__zusageRelayUplinkQueue = [{ zuUp: 2, zuCfg: { gen: 1, prefs: { show: "{}" } } }];
  relay.push({ zm: 1, ts: Date.now(), target: { taskId: "sess_x" } });
  await wait(150);
  const n1 = relay.status().queryRuns;
  // 立即连发两次 pump：1s 节流内只应再查一次（补拍），不会每次 pump 都查
  relay.pump(); relay.pump();
  await wait(600);
  const n2 = relay.status().queryRuns;
  assert.ok(n2 === n1 + 1, `节流窗口内补拍一次（实际 ${n1} → ${n2}）`);
});

test("配置裁剪：zusage3.show 关闭的格不推送，speed/quota 恒保留", async (t) => {
  const { relay, sent } = makeRelay(t);
  globalThis.__zusageRelayUplinkQueue = [{
    zuUp: 2,
    zuCfg: { gen: 1, prefs: { show: JSON.stringify({ turn: 0, win: 0, today: 1, proj: 0, sub: 0, tools: 0 }) } },
  }];
  relay.push({ zm: 1, ts: Date.now(), target: { taskId: "sess_x" } });
  await wait(200);
  const body = sent.find((b) => b.chips);
  assert.ok(body, "有 chips 载荷");
  const ids = body.chips.map((c) => c.id);
  assert.ok(ids.includes("speed"), "speed 恒保留");
  assert.ok(ids.includes("today"), "today 开启");
  for (const off of ["turn", "win", "proj", "sub", "tools"]) {
    assert.ok(!ids.includes(off), `${off} 已关闭应不推`);
  }
});

test("配置损坏 fail-open：show 非法 JSON 时不裁剪", async (t) => {
  const { relay, sent } = makeRelay(t);
  globalThis.__zusageRelayUplinkQueue = [{ zuUp: 2, zuCfg: { gen: 1, prefs: { show: "{broken" } } }];
  relay.push({ zm: 1, ts: Date.now(), target: { taskId: "sess_x" } });
  await wait(200);
  const ids = (sent.find((b) => b.chips) || { chips: [] }).chips.map((c) => c.id);
  assert.ok(ids.includes("turn") && ids.includes("tools"), "损坏配置不裁（全开）");
});

test("gen 幂等：旧 gen 的配置帧不覆盖新配置", async (t) => {
  const { relay } = makeRelay(t);
  globalThis.__zusageRelayUplinkQueue = [{ zuUp: 2, zuCfg: { gen: 5, prefs: { show: "{}" } } }];
  relay.push({ zm: 1, ts: Date.now(), target: { taskId: "sess_x" } });
  await wait(150);
  assert.equal(relay.status().clientCfgGen, 5);
  globalThis.__zusageRelayUplinkQueue = [{ zuUp: 2, zuCfg: { gen: 3, prefs: { show: '{"turn":0}' } } }];
  relay.pump();
  await wait(120);
  assert.equal(relay.status().clientCfgGen, 5, "旧 gen 忽略");
});
