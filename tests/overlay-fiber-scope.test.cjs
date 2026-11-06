"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
// v258：静态桥缺席（HOST_TARGETS 表外客户端）时 readPaneScope/detOwnerOf/sidePaneKeyOf 的
// React fiber 兜底。切片与 overlay-remote-scope.test.cjs 同源（433→520 行 eval 区间），
// 新增函数必须落在该切片内且不引用切片外符号——本文件就是对这条约束的守护。
const source = fs.readFileSync(path.join(__dirname, "..", "overlay.js"), "utf8");
const ID = "remote:ssh:a:22:u:/p";
function extract(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
function attrNode(attrs) {
  return {
    hasAttribute: (k) => Object.prototype.hasOwnProperty.call(attrs, k),
    getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null),
  };
}
function frame(props, extra = {}) {
  return Object.assign({ memoizedProps: props, pendingProps: null, stateNode: null, return: null }, extra);
}
function chain(frames) {
  for (let i = 0; i < frames.length - 1; i++) frames[i].return = frames[i + 1];
  return frames[0];
}
function paneEl({ sid = "sA", attrs = {}, fiber = null, connected = true } = {}) {
  const el = Object.assign(attrNode(Object.assign({ "data-session-id": sid }, attrs)), { isConnected: connected, parentElement: null });
  if (fiber) el["__reactFiber$1"] = fiber;
  return el;
}
function scopeCtx() {
  const ctx = { instances: [], window: {}, localStorage: new Proxy({}, { get() { throw Error("shared storage must not be read"); } }) };
  vm.runInNewContext(extract("  function collectSidWs()", "  /* ---------- 回复末尾速率行"), ctx);
  return ctx;
}
const PANE_PROPS = { workspacePath: "/w", paneId: "workspace-main", workspaceIdentity: ID, remoteSessionId: "conn1" };

test("static bridge attributes keep priority and fail closed without fiber rescue", () => {
  const ctx = scopeCtx();
  // version=1 且属性合法：fiber 给出不同值也不采纳（静态分支优先）
  const good = paneEl({ attrs: { "data-zusage-scope-version": "1", "data-zusage-pane-id": "workspace-main",
    "data-zusage-workspace-path": "/p", "data-zusage-workspace-identity": ID, "data-zusage-remote-session-id": "connectionA" },
    fiber: frame({ ...PANE_PROPS, workspacePath: "/other" }) });
  const got = ctx.readPaneScope(good, "sA", "workspace-main");
  assert.equal(got.workspacePath, "/p");
  assert.equal(got.identity, ID);
  // version=1 且属性非法：不回落 fiber（fail-closed 矩阵不放宽）
  const bad = paneEl({ attrs: { "data-zusage-scope-version": "1", "data-zusage-pane-id": "workspace-main",
    "data-zusage-workspace-path": "/p", "data-zusage-workspace-identity": "remote:ftp:x", "data-zusage-remote-session-id": "c" },
    fiber: frame({ ...PANE_PROPS }) });
  assert.equal(ctx.readPaneScope(bad, "sA", "workspace-main"), null);
});

test("fiber fallback recovers scope when bridge attributes are absent or unknown version", () => {
  const ctx = scopeCtx();
  const root = paneEl({ fiber: chain([frame({ className: "x" }), frame({ ...PANE_PROPS })]) });
  const got = ctx.readFiberPaneScope(root, "sA", "workspace-main");
  assert.equal(got.workspacePath, "/w");
  assert.equal(got.identity, ID);
  assert.equal(got.remoteSessionId, "conn1");
  assert.equal(got.sid, "sA");
  // readPaneScope 在 version 缺失/"2" 时走同一兜底
  assert.equal(ctx.readPaneScope(paneEl({ fiber: frame({ ...PANE_PROPS }) }), "sA", "workspace-main").workspacePath, "/w");
  const v2 = paneEl({ attrs: { "data-zusage-scope-version": "2", "data-zusage-pane-id": "workspace-main",
    "data-zusage-workspace-path": "/attr", "data-zusage-workspace-identity": "", "data-zusage-remote-session-id": "" },
    fiber: frame({ ...PANE_PROPS }) });
  assert.equal(ctx.readPaneScope(v2, "sA", "workspace-main").workspacePath, "/w");
});

test("fiber fallback requires pane id (or side-chat tabId) match", () => {
  const ctx = scopeCtx();
  const root = paneEl({ fiber: frame({ ...PANE_PROPS }) });
  assert.equal(ctx.readFiberPaneScope(root, "sA", "split-1"), null);
  assert.ok(ctx.readFiberPaneScope(root, "sA", "workspace-main"));
  const side = paneEl({ fiber: frame({ workspacePath: "/w", tabId: "selection-side-chat:a%3Ab" }) });
  assert.ok(ctx.readFiberPaneScope(side, "sA", "selection-side-chat:a%3Ab"));
  assert.equal(ctx.readFiberPaneScope(side, "sA", "workspace-main"), null);
  // tabId 不带 selection-side-chat: 前缀的不当侧聊匹配
  const bare = paneEl({ fiber: frame({ workspacePath: "/w", tabId: "a%3Ab" }) });
  assert.equal(ctx.readFiberPaneScope(bare, "sA", "a%3Ab"), null);
});

test("fiber-derived scope passes the same validation matrix as static attributes", () => {
  const ctx = scopeCtx();
  const read = (props) => ctx.readFiberPaneScope(paneEl({ fiber: frame(props) }), "sA", "workspace-main");
  assert.equal(read({ workspacePath: "/w\n", paneId: "workspace-main" }), null);   // 控制字符
  assert.equal(read({ workspacePath: "   ", paneId: "workspace-main" }), null);    // 空白路径
  assert.equal(read({ workspacePath: "/w", paneId: "workspace-main", remoteSessionId: "conn" }), null);   // remote 无 identity
  assert.equal(read({ workspacePath: "/w", paneId: "workspace-main", remoteSessionId: "co nn", workspaceIdentity: ID }), null);   // remote 带空白
  assert.equal(read({ workspacePath: "/w", paneId: "workspace-main", workspaceIdentity: "bad:id" }), null);   // identity 白名单外
  assert.ok(read({ workspacePath: "/w", paneId: "workspace-main", workspaceIdentity: ID, remoteSessionId: "__base__" }));   // "__base__" 在静态分支同样放行（桥 get 层才拒保留字）
  const local = read({ workspacePath: "/w", paneId: "workspace-main" });
  assert.equal(local.identity, "");
  assert.equal(local.remoteSessionId, "");
  // draft 与 sid 不匹配在 fiber 分支同样拒绝
  assert.equal(ctx.readFiberPaneScope(paneEl({ fiber: frame({ ...PANE_PROPS }) }), "draft", "workspace-main"), null);
  assert.equal(ctx.readFiberPaneScope(paneEl({ sid: "sB", fiber: frame({ ...PANE_PROPS }) }), "sA", "workspace-main"), null);
  // 无 fiber 键 / fiber 非对象：安全 null 不抛
  assert.equal(ctx.readFiberPaneScope(paneEl({}), "sA", "workspace-main"), null);
  assert.equal(ctx.readFiberPaneScope(paneEl({ fiber: null }), "sA", "workspace-main"), null);
});

test("ambiguous fiber candidates are rejected; identical forwarded props are accepted", () => {
  const ctx = scopeCtx();
  const ambiguous = paneEl({ fiber: chain([
    frame({ ...PANE_PROPS }),
    frame({ className: "mid" }),
    frame({ ...PANE_PROPS, workspacePath: "/other" }),
  ]) });
  assert.equal(ctx.readFiberPaneScope(ambiguous, "sA", "workspace-main"), null);
  const forwarded = paneEl({ fiber: chain([frame({ ...PANE_PROPS }), frame({ ...PANE_PROPS, paneId: undefined })]) });
  assert.equal(ctx.readFiberPaneScope(forwarded, "sA", "workspace-main").workspacePath, "/w");
});

test("fiber walk is depth-bounded and stops at enclosing session/pane roots", () => {
  const ctx = scopeCtx();
  const fillers = [];
  for (let i = 0; i < 30; i++) fillers.push(frame({ depth: i }));
  fillers.push(frame({ ...PANE_PROPS }));
  assert.equal(ctx.readFiberPaneScope(paneEl({ fiber: chain(fillers) }), "sA", "workspace-main"), null);
  const boundary = attrNode({ "data-session-id": "sOuter" });
  const crossed = paneEl({ fiber: chain([frame({ className: "inner" }), frame({ className: "shell" }, { stateNode: boundary }), frame({ ...PANE_PROPS })]) });
  assert.equal(ctx.readFiberPaneScope(crossed, "sA", "workspace-main"), null);
  // 边界之下（root 自身帧）的候选合法：root 自己的 fiber 不算跨 pane
  const ownFiber = paneEl({ fiber: chain([frame({ ...PANE_PROPS }), frame({ className: "shell" }, { stateNode: boundary })]) });
  assert.equal(ctx.readFiberPaneScope(ownFiber, "sA", "workspace-main").workspacePath, "/w");
  const paneBoundary = attrNode({ "data-pane-id": "workspace-main" });
  const crossedPane = paneEl({ fiber: chain([frame({ className: "inner" }), frame({ className: "shell" }, { stateNode: paneBoundary }), frame({ ...PANE_PROPS })]) });
  assert.equal(ctx.readFiberPaneScope(crossedPane, "sA", "workspace-main"), null);
});

test("detOwnerOf falls back to fiber tabId when bridge attributes are absent", () => {
  const ctx = { instances: [], document: { body: {} }, WeakMap };
  vm.runInNewContext(extract("  function fiberSideIdOf(", "  function detSeenKey"), ctx);
  const tabId = "selection-side-chat:x%3Ay";
  const paneRoot = Object.assign(attrNode({ "data-session-id": "side-child" }), { parentElement: ctx.document.body });
  paneRoot["__reactFiber$9"] = chain([frame({ className: "c" }), frame({ tabId })]);
  const box = Object.assign(attrNode({}), { parentElement: paneRoot });
  const owner = { pid: tabId, detRoot: () => paneRoot };
  paneRoot.contains = () => true;
  ctx.instances.push(owner);
  assert.equal(ctx.detOwnerOf(box), owner);
  // fiber 指向别的 tabId：不认领
  paneRoot["__reactFiber$9"] = frame({ tabId: "selection-side-chat:other" });
  assert.equal(ctx.detOwnerOf(box), null);
  ctx.instances.pop();
  // 无实例时只判 null，不抛
  assert.equal(ctx.detOwnerOf(box), null);
});

test("fiberSideIdOf is fail-closed and prefix-checked", () => {
  const ctx = { instances: [], document: { body: {} } };
  vm.runInNewContext(extract("  function fiberSideIdOf(", "  function detSeenKey"), ctx);
  const el = paneEl({});
  assert.equal(ctx.fiberSideIdOf(el), "");
  el["__reactFiber$1"] = chain([frame({ tabId: "selection-side-chat:a" }), frame({ tabId: "selection-side-chat:b" })]);
  assert.equal(ctx.fiberSideIdOf(el), "");   // 歧义拒绝
  el["__reactFiber$1"] = frame({ tabId: "plain" });
  assert.equal(ctx.fiberSideIdOf(el), "");   // 无前缀不采纳
  el["__reactFiber$1"] = chain([frame({ filler: 1 }),
    frame({ x: 1 }, { stateNode: attrNode({ "data-pane-id": "p" }) }),
    frame({ tabId: "selection-side-chat:a" })]);
  assert.equal(ctx.fiberSideIdOf(el), "");   // 外层 pane 边界止步，取不到越界帧
  el["__reactFiber$1"] = chain([frame({ tabId: "selection-side-chat:a" }),
    frame({ x: 1 }, { stateNode: attrNode({ "data-pane-id": "p" }) })]);
  assert.equal(ctx.fiberSideIdOf(el), "selection-side-chat:a");   // 边界之下（自身帧）命中合法
  el["__reactFiber$1"] = frame({ tabId: "selection-side-chat:a" });
  assert.equal(ctx.fiberSideIdOf(el), "selection-side-chat:a");
  el["__reactInternalInstance$2"] = frame({ tabId: "selection-side-chat:a" });
  delete el["__reactFiber$1"];
  assert.equal(ctx.fiberSideIdOf(el), "selection-side-chat:a");   // 旧版 React 内部键兼容
});

test("sidePaneKeyOf falls back to fiber only when both host testid and bridge attrs are missing", () => {
  const ctx = { document: { body: {} } };
  vm.runInNewContext(extract("    function sidePaneKeyOf(el) {", "    var SEL = "), ctx);
  const tabId = "selection-side-chat:s%3A1";
  const root = Object.assign(attrNode({ "data-session-id": "sA" }), { parentElement: ctx.document.body });
  root["__reactFiber$1"] = frame({ tabId });
  const composer = Object.assign(attrNode({}), { parentElement: root });
  assert.equal(ctx.sidePaneKeyOf(composer), tabId);
  // 宿主 testid 在场：静态优先
  const hostRoot = Object.assign(attrNode({ "data-testid": "v4-session-pane-" + tabId }), { parentElement: ctx.document.body });
  hostRoot["__reactFiber$1"] = frame({ tabId: "selection-side-chat:other" });
  const hostChild = Object.assign(attrNode({}), { parentElement: hostRoot });
  assert.equal(ctx.sidePaneKeyOf(hostChild), tabId);
  // 桥 version=1 在场：zusage-pane-id 优先，fiber 不参与
  const bridgeRoot = Object.assign(attrNode({ "data-zusage-pane-id": tabId, "data-zusage-scope-version": "1" }), { parentElement: ctx.document.body });
  bridgeRoot["__reactFiber$1"] = frame({ tabId: "selection-side-chat:other" });
  const bridgeChild = Object.assign(attrNode({}), { parentElement: bridgeRoot });
  assert.equal(ctx.sidePaneKeyOf(bridgeChild), tabId);
  // 普通会话根（无 tabId props）：不误判
  const mainRoot = Object.assign(attrNode({ "data-session-id": "sA" }), { parentElement: ctx.document.body });
  mainRoot["__reactFiber$1"] = frame({ workspacePath: "/w", paneId: "workspace-main" });
  const mainChild = Object.assign(attrNode({}), { parentElement: mainRoot });
  assert.equal(ctx.sidePaneKeyOf(mainChild), "");
});
