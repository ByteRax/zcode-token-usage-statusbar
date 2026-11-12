"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
// v258：turn-stats.js 的运行时合成桥（BRIDGE_TEMPLATE v2 免混淆名同契约实现）——
// 静态桥缺席（表外客户端/replace-failed）时由渲染端自行提供三个 __zusage* 访问器。
// 本文件验证行为契约（白名单/快照冻结/租约/诊断/一次性探针）。registry 夹具一律在
// vm 域内构造：跨 realm 的 Node Map 过不了 instanceof Map，探针也只钩 vm 域原型。
const source = fs.readFileSync(path.join(__dirname, "..", "turn-stats.js"), "utf8");

function bridgeContext({ windowDoc = false, preBridge = false } = {}) {
  const sandbox = { window: windowDoc ? { document: {} } : {} };
  if (preBridge) {   // 静态桥已部署：探针布防守卫直接短路
    sandbox.window.__zusageGetExistingConversationStore = () => null;
    sandbox.__zusageGetExistingConversationStore = sandbox.window.__zusageGetExistingConversationStore;
  }
  const ctx = vm.createContext(sandbox);
  const origGet = vm.runInContext("Map.prototype.get", ctx);
  const origSet = vm.runInContext("Map.prototype.set", ctx);
  vm.runInContext(source, ctx);
  return { sandbox, ctx, origGet, origSet, api: sandbox.ZUsageTurnStats };
}
function buildRegistry(ctx, { stale = false, disposed = false, acquireThrows = false, leaseNoStore = false, storeClosed = false } = {}) {
  vm.runInContext(`(() => {
    globalThis.__zuSubs = [];
    globalThis.__zuStore = {
      closed: ${storeClosed},
      getState: () => ({ status: "active", snapshot: { sessionId: "s1", logEpoch: "e1", seq: 1, rows: { window: [] } } }),
      subscribe(cb) { globalThis.__zuSubs.push(cb); return () => { const i = globalThis.__zuSubs.indexOf(cb); if (i >= 0) globalThis.__zuSubs.splice(i, 1); }; },
      notify() { for (const cb of [...globalThis.__zuSubs]) cb(); },
    };
    globalThis.__zuLayer = { disposed: ${disposed}, entries: new Map(), acquire: null, released: [] };
    globalThis.__zuLayer.entries.set("conversation/s1", { store: globalThis.__zuStore });
    globalThis.__zuLayer.acquire = (sid) => {
      ${acquireThrows ? "throw new Error('disposed mid-acquire');" : ""}
      ${leaseNoStore ? "return { store: null, release() { globalThis.__zuLayer.released.push(sid); } };" : ""}
      const sub = { closed: false, getState: () => ({ status: "active", snapshot: { sessionId: sid, logEpoch: "e1", seq: 2, rows: { window: [] } } }), subscribe(cb) { return () => {}; } };
      globalThis.__zuLayer.entries.set("conversation/" + sid, { store: sub });
      return { store: sub, release() { globalThis.__zuLayer.released.push(sid); } };
    };
    globalThis.__zuReg = new Map();
    globalThis.__zuReg.set("__base__ /work", { layer: globalThis.__zuLayer, stale: ${stale}, refCount: 1 });
  })()`, ctx);
  return {
    registry: ctx.__zuReg, layer: ctx.__zuLayer, store: ctx.__zuStore, subs: ctx.__zuSubs,
    entry: () => ctx.__zuReg.get("__base__ /work"),
  };
}

test("no probe, no globals when a static bridge already exists or window lacks document", () => {
  const bridged = bridgeContext({ windowDoc: true, preBridge: true });
  assert.equal(bridged.sandbox.__zusageRegistryHooked, undefined);
  assert.equal(vm.runInContext("Map.prototype.set", bridged.ctx) === bridged.origSet, true);
  const headless = bridgeContext({ windowDoc: false });
  assert.equal(headless.sandbox.__zusageRegistryHooked, undefined);   // window 无 document 不布防
  assert.equal(typeof headless.api.installRuntimeBridge, "function");
});

test("installRuntimeBridge wires the three accessors, mirrors to window, rejects re-install", () => {
  const { sandbox, ctx, api } = bridgeContext({ windowDoc: false });
  const reg = buildRegistry(ctx);
  assert.equal(api.installRuntimeBridge(reg.registry), true);
  assert.equal(api.installRuntimeBridge(new Map()), false);   // 跨 realm Map 也拒：已捕获
  for (const name of ["__zusageGetExistingConversationStore", "__zusageAcquireConversationStore", "__zusageConversationDiagnostics"]) {
    assert.equal(typeof sandbox[name], "function");
  }
  // window 在场时注入口同样镜像到 window：overlay 读 window.*（preBridge 关探针，纯测注入口）
  const mirrored = bridgeContext({ windowDoc: true, preBridge: true });
  const reg2 = buildRegistry(mirrored.ctx);
  assert.equal(mirrored.api.installRuntimeBridge(reg2.registry), true);
  assert.match(String(mirrored.sandbox.window.__zusageGetExistingConversationStore), /zuGetExistingConversationStore/);   // 假桥已被真访问器覆盖
  assert.equal(typeof mirrored.sandbox.window.__zusageAcquireConversationStore, "function");
  assert.equal(typeof mirrored.sandbox.window.__zusageConversationDiagnostics, "function");
});

test("get returns a frozen snapshot wrapper, passes notifications, throws on invalid scope", () => {
  const { sandbox, ctx, api } = bridgeContext({ windowDoc: false });
  const reg = buildRegistry(ctx);
  api.installRuntimeBridge(reg.registry);
  const get = sandbox.__zusageGetExistingConversationStore;
  const store = get({ sessionId: "s1", workspacePath: "/work" });
  assert.ok(store);
  const snap = store.getState();
  assert.equal(snap.snapshot.seq, 1);
  assert.ok(Object.isFrozen(snap) && Object.isFrozen(snap.snapshot));
  assert.throws(() => { snap.snapshot.seq = 99; }, TypeError);
  // workspaceIdentity 存在时键公式优先取其 trim 值（同模板 `?.trim()||workspacePath`）；仅有 identity 无 workspacePath 与模板同规 throw
  reg.registry.set("__base__ /ident", { layer: reg.layer, stale: false, refCount: 1 });
  assert.ok(get({ sessionId: "s1", workspacePath: "/other", workspaceIdentity: " /ident " }));
  assert.throws(() => get({ sessionId: "s1", workspaceIdentity: " /ident " }), /Missing conversation scope field/);
  let hits = 0;
  const off = store.subscribe(() => { hits += 1; });
  assert.equal(typeof off, "function");
  reg.store.notify();
  assert.equal(hits, 1);
  off();
  reg.store.notify();
  assert.equal(hits, 1);   // off 后不再接收
  assert.throws(() => get({ sessionId: "s1", workspacePath: "/work", extra: 1 }), /Unknown conversation scope field/);   // 白名单外字段
  assert.throws(() => get({ sessionId: "s1" }), /Missing conversation scope field/);                 // 缺 workspacePath
  assert.throws(() => get({ workspacePath: "/work" }), /Missing conversation scope field/);          // 缺 sessionId
  assert.throws(() => get({ sessionId: "s1", workspacePath: "/work", remoteSessionId: "__base__" }), /Reserved remote identifier/);   // 保留字
  assert.throws(() => get({ sessionId: "s 1", workspacePath: "/work" }), /Invalid conversation identifier/);   // 标识符带空白
  assert.throws(() => get(null), /Invalid conversation scope/);
  assert.throws(() => get({ sessionId: "s1", workspacePath: "/w\n" }), /Invalid conversation scope field/);     // 控制字符
  // 远端 scope 按完整 key 命中；键不匹配返回 null
  reg.registry.set("remote:server:x:1 /work", { layer: reg.layer, stale: false, refCount: 1 });
  assert.ok(get({ sessionId: "s1", workspacePath: "/work", remoteSessionId: "remote:server:x:1" }));
  assert.equal(get({ sessionId: "s1", workspacePath: "/elsewhere" }), null);
});

test("wrapped getState is reference-stable per underlying state (issue #307)", () => {
  // 宿主 React useSyncExternalStore 以 Object.is 比对 getSnapshot：同一底层状态引用
  // 必须映射到同一冻结快照，否则渲染期间视为 store 又变了 → 无限重渲染（#185）。
  // 真实宿主形态：无变化时底层 getState 返回同一引用（夹具默认每次造新对象，
  // 这里换成稳定引用 store 专门锁此契约）。
  const { sandbox, ctx, api } = bridgeContext({ windowDoc: false });
  const reg = buildRegistry(ctx);
  vm.runInContext(`(() => {
    globalThis.__zuState = globalThis.__zuStore.getState();
    globalThis.__zuStore.getState = () => globalThis.__zuState;
  })()`, ctx);
  api.installRuntimeBridge(reg.registry);
  const store = sandbox.__zusageGetExistingConversationStore({ sessionId: "s1", workspacePath: "/work" });
  const keepOff = store.subscribe(() => { });   // 订阅在场：wrapper 内部订阅底层 store，通知才能到达缓存失效链
  const first = store.getState();
  assert.equal(store.getState(), first);              // 同一底层引用 → 同一快照（修复前每次新引用）
  assert.notEqual(first, ctx.__zuState);              // 仍是深拷贝，绝不外借宿主对象
  assert.ok(Object.isFrozen(first));
  // 就地变更不通知：React 契约下不可观察，返回缓存旧快照（缓存语义的代价与依据）
  vm.runInContext("globalThis.__zuState.snapshot.seq = 7", ctx);
  assert.equal(store.getState(), first);
  assert.equal(first.snapshot.seq, 1);
  // 就地变更 + 通知：缓存失效 → 重建，读到新内容且再次稳定
  vm.runInContext("globalThis.__zuStore.notify()", ctx);
  const second = store.getState();
  assert.notEqual(second, first);
  assert.equal(second.snapshot.seq, 7);
  assert.equal(store.getState(), second);
  // 不可变更新 + 通知：新底层引用 → 新快照
  vm.runInContext(`globalThis.__zuState = { status: "active", snapshot: { sessionId: "s1", logEpoch: "e1", seq: 8, rows: { window: [] } } }; globalThis.__zuStore.notify()`, ctx);
  const third = store.getState();
  assert.notEqual(third, second);
  assert.equal(third.snapshot.seq, 8);
  assert.equal(store.getState(), third);
  // 底层状态含不支持值（函数）：重建构造抛 TypeError（vm 域原型，按消息匹配），缓存不提交，逐次一致抛出
  vm.runInContext(`globalThis.__zuState = { status: "active", snapshot: { sessionId: "s1", logEpoch: "e1", seq: 9, fn: () => {} } }; globalThis.__zuStore.notify()`, ctx);
  assert.throws(() => store.getState(), /Unsupported snapshot value/);
  assert.throws(() => store.getState(), /Unsupported snapshot value/);
  // off 后 null，后续通知不复活
  keepOff();
  store.off();
  vm.runInContext("globalThis.__zuStore.notify()", ctx);
  assert.equal(store.getState(), null);
});

test("get degrades to null and self-unsubscribes when the session dies", () => {
  const { sandbox, ctx, api } = bridgeContext({ windowDoc: false });
  const reg = buildRegistry(ctx);
  api.installRuntimeBridge(reg.registry);
  const get = sandbox.__zusageGetExistingConversationStore;
  const store = get({ sessionId: "s1", workspacePath: "/work" });
  assert.ok(store.getState());
  reg.entry().stale = true;
  assert.equal(store.getState(), null);   // stale 即自停
  assert.equal(typeof store.subscribe(() => {}), "function");   // 停止后 subscribe 返回空函数
  const disposedCtx = bridgeContext({ windowDoc: false });
  const disposedReg = buildRegistry(disposedCtx.ctx, { disposed: true });
  disposedCtx.api.installRuntimeBridge(disposedReg.registry);
  assert.equal(disposedCtx.sandbox.__zusageGetExistingConversationStore({ sessionId: "s1", workspacePath: "/work" }), null);
  const closedCtx = bridgeContext({ windowDoc: false });
  const closedReg = buildRegistry(closedCtx.ctx, { storeClosed: true });
  closedCtx.api.installRuntimeBridge(closedReg.registry);
  assert.equal(closedCtx.sandbox.__zusageGetExistingConversationStore({ sessionId: "s1", workspacePath: "/work" }), null);
});

test("acquire is restricted to local sess_subagent_ sessions and releases the lease on off", () => {
  const { sandbox, ctx, api } = bridgeContext({ windowDoc: false });
  const reg = buildRegistry(ctx);
  api.installRuntimeBridge(reg.registry);
  const acquire = sandbox.__zusageAcquireConversationStore;
  assert.equal(acquire({ sessionId: "s1", workspacePath: "/work" }), null);   // 非 sess_subagent_ 前缀
  assert.throws(() => acquire({ sessionId: "sess_subagent_a", workspacePath: "/work", remoteSessionId: "remote:server:x:1" }), /Unknown conversation scope field/);   // acquire 白名单无 remoteSessionId（同模板），overlay 调用侧先行排除远端
  assert.throws(() => acquire({ sessionId: "sess_subagent_a", workspacePath: "/work", extra: 1 }), /Unknown conversation scope field/);   // 白名单外字段
  const store = acquire({ sessionId: "sess_subagent_a", workspacePath: "/work" });
  assert.ok(store);
  assert.equal(store.getState().snapshot.seq, 2);
  store.off();
  assert.deepEqual([...reg.layer.released], ["sess_subagent_a"]);   // off 时 release 租约
  store.off();   // 幂等
  assert.deepEqual([...reg.layer.released], ["sess_subagent_a"]);
});

test("acquire releases unusable leases and returns null on misses without throwing", () => {
  const { sandbox, ctx, api } = bridgeContext({ windowDoc: false });
  const reg = buildRegistry(ctx, { leaseNoStore: true });
  api.installRuntimeBridge(reg.registry);
  const acquire = sandbox.__zusageAcquireConversationStore;
  assert.equal(acquire({ sessionId: "sess_subagent_b", workspacePath: "/work" }), null);
  assert.deepEqual([...reg.layer.released], ["sess_subagent_b"]);
  const throwCtx = bridgeContext({ windowDoc: false });
  const throwReg = buildRegistry(throwCtx.ctx, { acquireThrows: true });
  throwCtx.api.installRuntimeBridge(throwReg.registry);
  assert.equal(throwCtx.sandbox.__zusageAcquireConversationStore({ sessionId: "sess_subagent_c", workspacePath: "/work" }), null);
  const staleCtx = bridgeContext({ windowDoc: false });
  const staleReg = buildRegistry(staleCtx.ctx, { stale: true });
  staleCtx.api.installRuntimeBridge(staleReg.registry);
  assert.equal(staleCtx.sandbox.__zusageAcquireConversationStore({ sessionId: "sess_subagent_d", workspacePath: "/work" }), null);
});

test("diagnostics enumerates live sessions with status/seq and keeps stale keys", () => {
  const { sandbox, ctx, api } = bridgeContext({ windowDoc: false });
  const reg = buildRegistry(ctx);
  reg.registry.set("__base__ /gone", { layer: { disposed: true, entries: new Map(), acquire: () => null }, stale: true, refCount: 0 });
  api.installRuntimeBridge(reg.registry);
  const diag = sandbox.__zusageConversationDiagnostics();
  assert.deepEqual([...diag.keys], ["__base__ /work", "__base__ /gone"]);
  assert.equal(diag.sessions.length, 1);
  assert.equal(diag.sessions[0].key, "__base__ /work");
  assert.equal(diag.sessions[0].topic, "conversation/s1");
  assert.equal(diag.sessions[0].status, "active");
  assert.equal(diag.sessions[0].seq, 1);
});

test("one-shot Map probe captures the host registry and restores native methods", () => {
  const { sandbox, ctx, origGet, origSet } = bridgeContext({ windowDoc: true });
  assert.equal(vm.runInContext("Map.prototype.set", ctx) === origSet, false);   // 已布防
  buildRegistry(ctx);   // 注册表落库的 set 事件即捕获
  assert.equal(vm.runInContext("typeof globalThis.__zusageGetExistingConversationStore", ctx), "function");
  assert.equal(vm.runInContext("globalThis.__zusageRegistryHooked", ctx), true);
  assert.equal(vm.runInContext("Map.prototype.get", ctx) === origGet, true);   // 捕获后还原原生方法
  assert.equal(vm.runInContext("Map.prototype.set", ctx) === origSet, true);
  const store = sandbox.window.__zusageGetExistingConversationStore({ sessionId: "s1", workspacePath: "/work" });
  assert.ok(store && store.getState());
  assert.equal(sandbox.ZUsageTurnStats.installRuntimeBridge(new Map()), false);   // 已捕获：注入口拒绝
  // 原生行为不受扰动（含非字符串键）
  vm.runInContext("const plain = new Map(); plain.set(42, 'x'); plain.set({}, 'y');", ctx);
  assert.equal(vm.runInContext("plain.get(42)", ctx), "x");
});

test("re-injection in the same realm never stacks probe layers", () => {
  const sandbox = { window: { document: {} } };
  const ctx = vm.createContext(sandbox);
  const origSet = vm.runInContext("Map.prototype.set", ctx);
  vm.runInContext(source, ctx);   // 第一代：布防
  vm.runInContext(source, ctx);   // 主桥热重注入：__zusageRegistryHooked 守卫阻止叠层
  assert.equal(vm.runInContext("Map.prototype.set", ctx) === origSet, false);   // 仍是第一代单层钩子
  vm.runInContext("new Map().set('__base__ /w', { layer: { entries: new Map(), acquire() {} }, stale: false, refCount: 1 });", ctx);
  assert.equal(vm.runInContext("Map.prototype.set", ctx) === origSet, true);   // 旧钩子完成捕获并还原
  assert.equal(vm.runInContext("typeof globalThis.__zusageGetExistingConversationStore", ctx), "function");
});
test("probe ignores non-registry entries and survives throwing entry objects", () => {
  const { ctx, origSet } = bridgeContext({ windowDoc: true });
  vm.runInContext("const m = new Map(); m.set('plain', { a: 1 }); m.set('__base__ /w', { layer: {} });", ctx);
  assert.equal(vm.runInContext("typeof globalThis.__zusageGetExistingConversationStore", ctx), "undefined");
  assert.equal(vm.runInContext("Map.prototype.set", ctx) === origSet, false);   // 仍在布防
  // entry 取属性抛错：探针吞掉，原调用不受影响
  vm.runInContext("const evil = new Proxy({}, { get() { throw new Error('boom'); } }); m.set('__base__ /w2', evil); m.get('__base__ /w2');", ctx);
  assert.equal(vm.runInContext("m.get('__base__ /w2') !== undefined", ctx), true);
  assert.equal(vm.runInContext("typeof globalThis.__zusageGetExistingConversationStore", ctx), "undefined");
  // 真条目到场：当场捕获并摘钩
  vm.runInContext("m.set('__base__ /w', { layer: { entries: new Map(), acquire() {} }, stale: false, refCount: 1 });", ctx);
  assert.equal(vm.runInContext("typeof globalThis.__zusageGetExistingConversationStore", ctx), "function");
  assert.equal(vm.runInContext("Map.prototype.get", ctx) === vm.runInContext("Map.prototype.get", ctx), true);
  vm.runInContext("const restored = Map.prototype.set;", ctx);
  assert.equal(vm.runInContext("restored === Map.prototype.set", ctx), true);
});
