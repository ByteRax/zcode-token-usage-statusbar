"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "overlay.js"), "utf8");
const A = "remote:ssh:a:22:u:/p", B = "remote:ssh:b:22:u:/p";
function extract(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
function sessionFixture(mainScope) {
  const context = vm.createContext({ remoteCache: {}, remoteTodayCache: {}, Object,
    window: {}, stale: () => false, state: {}, instances: [], FATAL: {}, nativeCtxVal: 0 });
  if (mainScope !== undefined) context.mainScopeNow = mainScope;
  vm.runInContext(extract("  function sessionFor(", "  window.__zusagePluginRequests"), context);
  const pick = (d, sid = "sA", pid = "auto") => context.sessionFor(d, sid, pid);
  pick.view = d => {
    context.window.__zusageUpdate(d);
    context.p = pick(d); context.d = d;
    vm.runInContext(extract('      var myTarget = p.remote_target || "";', "      lastSub = view.sub;"), context);
    return context.view;
  };
  return pick;
}
test("session lookup isolates identical sid by workspace and pane", () => {
  const pick = sessionFixture(), d = { scope_bindings: { left: A, right: B }, recent: [
    { sid: "sA", workspace_identity: A, remote: true, requests: 1 },
    { sid: "sA", workspace_identity: B, remote: true, requests: 2 },
    { sid: "sA", requests: 9 },
  ] };
  assert.equal(pick(d, "sA", "left").requests, 1); assert.equal(pick(d, "sA", "right").requests, 2);
  assert.equal(pick({ ...d, scope_bindings: {} }).requests, 9);
});
test("local and unknown panes never inherit a same-sid remote binding", () => {
  const pick = sessionFixture(), recent = [
    { sid: "sA", workspace_identity: A, remote: true, requests: 1 },
    { sid: "sA", requests: 9 },
  ];
  const d = { scope_bindings: { left: A, right: "", sA: A }, recent };
  assert.equal(pick(d, "sA", "left").requests, 1);
  assert.equal(pick(d, "sA", "right").requests, 9);
  assert.equal(pick(d, "sA", "unknown").requests, 9);
  assert.equal(pick(d, "sA", "auto").requests, 1);
});
test("failed scoped snapshot keeps prior success without cross-target substitution", () => {
  const pick = sessionFixture();
  pick({ scope_bindings: { sA: A }, recent: [{ sid: "sA", workspace_identity: A, remote: true, remote_target: "a", requests: 7 }] });
  const failed = pick({ scope_bindings: { sA: A }, recent: [{ sid: "sA", workspace_identity: A, remote: true, remote_target: "a", remote_error: "ssh failed", remote_missing: true, requests: 0 }] });
  assert.equal(failed.requests, 7); assert.equal(failed.remote_error, "ssh failed"); assert.equal(failed.remote_missing, true);
  const other = pick({ scope_bindings: { sA: B }, recent: [] });
  assert.equal(other.requests, undefined); assert.equal(other.workspace_identity, B);
  assert.equal(pick({ scope_bindings: { sA: A }, recent: [{ sid: "sA", workspace_identity: A, remote: true, requests: 8 }] }).requests, 8);
});
test("same identity target override cannot reuse old target session or today; new target recovers independently", () => {
  const pick = sessionFixture();
  const payload = (target, requests, error = "") => ({
    scope_bindings: { sA: A }, today: { requests: 99 },
    recent: [{ sid: "sA", workspace_identity: A, remote: true, remote_target: target,
      remote_host: target + "-host", requests, remote_error: error, remote_missing: !!error }],
    remote_today: error ? {} : { [target]: { requests: requests * 10 } },
    remote_errors: error ? { [target]: error } : {},
  });
  const old = pick.view(payload("a", 3));
  assert.equal(old.today.requests, 30);
  const changed = pick.view(payload("b", 0, "B failed"));
  assert.equal(changed.session.requests, 0);
  assert.equal(changed.session.remote_target, "b");
  assert.equal(changed.remote_host, "b-host");
  assert.equal(changed.today.requests, undefined);
  assert.equal(changed.remote_error, "B failed");
  assert.equal(!!changed.remote_stale, false);
  const recovered = pick.view(payload("b", 7));
  assert.equal(recovered.session.requests, 7); assert.equal(recovered.today.requests, 70);
  const failedAgain = pick.view(payload("b", 0, "B failed again"));
  assert.equal(failedAgain.session.requests, 7); assert.equal(failedAgain.today.requests, 70);
  assert.equal(failedAgain.session.remote_target, "b"); assert.equal(failedAgain.remote_host, "b-host");
  assert.equal(failedAgain.remote_error, "B failed again"); assert.equal(failedAgain.remote_stale, true);
  const unknown = pick.view(payload("", 0, "unknown target"));
  assert.equal(unknown.session.requests, 0); assert.equal(unknown.today.requests, undefined);
  assert.equal(unknown.session.remote_target, ""); assert.equal(!!unknown.remote_stale, false);
  const missing = pick.view({ scope_bindings: { sA: A }, recent: [], remote_today: {}, remote_errors: {} });
  assert.equal(missing.session.requests, undefined); assert.equal(missing.today.requests, undefined);
});
test("per-target today and errors never fall back to another host or local today", () => {
  const code = extract('      var myTarget = p.remote_target || "";', "      lastSub = view.sub;");
  function view(p, d) {
    const ctx = { p, d, remoteTodayCache: {}, nativeCtxVal: 0 };
    vm.runInNewContext(code, ctx); return ctx.view;
  }
  const d = { today: { requests: 99 }, remote_today: { a: { requests: 1 }, b: { requests: 2 } }, remote_errors: { b: "B failed" }, remote_error: "B failed" };
  assert.equal(view({ sid: "sA", remote: true, remote_target: "a" }, d).today.requests, 1);
  assert.equal(view({ sid: "sA", remote: true, remote_target: "a" }, d).remote_error, "");
  assert.equal(view({ sid: "sB", remote: true, remote_target: "b" }, d).remote_error, "B failed");
  assert.equal(view({ sid: "sC", remote: true }, d).today.requests, undefined);
  assert.equal(view({ sid: "sL" }, d).today.requests, 99);
});
test("real pane schema and raw sid storage retain ambiguity instead of choosing first", () => {
  const entries = new Map([
    ["zcode-v4-pane-layout:v2", JSON.stringify({ root: { type: "leaf", paneId: "split" }, panes: { split: { sessionId: "sA", workspaceScope: { workspaceIdentity: A, workspacePath: "/p" } } } })],
    ["zcode-v4-last-session:v1:" + B, "sA"],
  ]);
  const ctx = { localStorage: { get length() { return entries.size; }, key: i => [...entries.keys()][i], getItem: k => entries.get(k) || null } };
  vm.runInNewContext(extract("  function collectSidWs()", "  function mainWorkbenchScope("), ctx);
  assert.deepEqual(Array.from(ctx.collectSidWs().sA), [A, B]);
});
function workbenchFixture(groups) {
  const entries = new Map([
    ["zcode-v4-session-workbench-groups:v1", JSON.stringify({
      version: 1, activeGroupId: groups.length ? "g0" : null,
      groups: Object.fromEntries(groups.map((primaryBinding, i) => ["g" + i, { primaryBinding }])),
      sessionIndex: {},
    })],
  ]);
  const ctx = { ls: (k, d) => entries.get(k) ?? d };
  vm.runInNewContext(extract("  function mainWorkbenchScope(", "  function refreshWants()"), ctx);
  return ctx;
}
const wbRemote = (identity = A, sessionId = "sA") => ({ workspaceScope: { workspacePath: "/p", workspaceIdentity: identity }, sessionId });
const wbLocal = (sessionId = "sA") => ({ workspaceScope: { workspacePath: "/local" }, sessionId });
test("main workbench scope resolves only a unique remote primary binding", () => {
  assert.equal(workbenchFixture([wbRemote()]).mainWorkbenchScope("sA"), A);
  assert.equal(workbenchFixture([wbRemote(), wbRemote()]).mainWorkbenchScope("sA"), A);   // 同 scope 重复分组不构成歧义
  assert.equal(workbenchFixture([{ workspaceScope: A, sessionId: "sA" }]).mainWorkbenchScope("sA"), A);   // 防御：scope 退化成字符串
  assert.equal(workbenchFixture([wbLocal()]).mainWorkbenchScope("sA"), "");               // 仅本地 scope 不路由
  assert.equal(workbenchFixture([wbLocal(), wbRemote()]).mainWorkbenchScope("sA"), "");   // 本地+远端同 sid：多窗口共享 localStorage，歧义不猜
  assert.equal(workbenchFixture([wbRemote(A), wbRemote(B)]).mainWorkbenchScope("sA"), "");
  assert.equal(workbenchFixture([wbRemote(A, "other")]).mainWorkbenchScope("sA"), "");    // sid 不匹配不参与
  assert.equal(workbenchFixture([]).mainWorkbenchScope("sA"), "");
  assert.equal(workbenchFixture([wbRemote()]).mainWorkbenchScope(""), "");
});
test("main workbench scope tolerates malformed persistence", () => {
  const payloads = [
    "{not json",
    "null",
    JSON.stringify({ version: 1 }),                                                        // 缺 groups
    JSON.stringify({ version: 1, groups: { g0: null } }),                                  // 分组损坏
    JSON.stringify({ version: 1, groups: { g0: { primaryBinding: { workspaceScope: null, sessionId: "sA" } } } }),
  ];
  for (const raw of payloads) {
    const ctx = { ls: (k, d) => k === "zcode-v4-session-workbench-groups:v1" ? raw : d };
    vm.runInNewContext(extract("  function mainWorkbenchScope(", "  function refreshWants()"), ctx);
    assert.equal(ctx.mainWorkbenchScope("sA"), "");
  }
});
test("main pane strips late scope bindings that no longer match current workbench state", () => {
  const recent = [
    { sid: "sA", workspace_identity: A, remote: true, requests: 1 },
    { sid: "sA", requests: 9 },
  ];
  const d = { scope_bindings: { "workspace-main": A, left: A }, recent };
  assert.equal(sessionFixture({ sid: "sA", identity: A })(d, "sA", "workspace-main").requests, 1);
  assert.equal(sessionFixture({ sid: "sA", identity: "" })(d, "sA", "workspace-main").requests, 9);
  assert.equal(sessionFixture({ sid: "sB", identity: A })(d, "sA", "workspace-main").requests, 9);
  assert.equal(sessionFixture(null)(d, "sA", "workspace-main").requests, 9);              // 夹具/首帧未刷新：按本地处理
  assert.equal(sessionFixture({ sid: "sB", identity: A })(d, "sA", "left").requests, 1);  // 非主叶不受守卫影响
});
