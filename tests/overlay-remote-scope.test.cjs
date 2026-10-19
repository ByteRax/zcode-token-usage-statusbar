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
function scopeFixture(overrides = {}) {
  const attrs = {
    "data-session-id": "sA", "data-zusage-scope-version": "1", "data-zusage-pane-id": "workspace-main",
    "data-zusage-workspace-path": "/p", "data-zusage-workspace-identity": A,
    "data-zusage-remote-session-id": "connectionA", ...overrides,
  };
  const root = { isConnected: true, parentElement: null,
    hasAttribute: k => Object.prototype.hasOwnProperty.call(attrs, k), getAttribute: k => attrs[k] ?? null };
  const el = { isConnected: true, parentElement: root, hasAttribute: () => false };
  const ctx = { instances: [], window: {}, localStorage: new Proxy({}, { get() { throw Error("shared storage must not be read"); } }) };
  vm.runInNewContext(extract("  function collectSidWs()", "  /* ---------- 回复末尾速率行"), ctx);
  return { ctx, root, el, read: () => ctx.readPaneScope(el, "sA", "workspace-main") };
}
test("pane scope is read from the nearest live session node", () => {
  const f = scopeFixture();
  assert.equal(f.read().identity, A);
  assert.equal(f.read().workspacePath, "/p");
  assert.equal(f.read().remoteSessionId, "connectionA");
  const local = scopeFixture({ "data-zusage-workspace-identity": "", "data-zusage-remote-session-id": "" });
  assert.equal(local.read().identity, "");
  f.root.isConnected = false; f.el.isConnected = false;
  assert.equal(f.read(), null);
});
test("missing or inconsistent node identity fails closed", () => {
  for (const attrs of [
    { "data-zusage-scope-version": null }, { "data-zusage-scope-version": "2" },
    { "data-session-id": "other" }, { "data-session-id": "draft" },
    { "data-zusage-pane-id": "right" }, { "data-zusage-workspace-path": "" },
    { "data-zusage-workspace-identity": null }, { "data-zusage-remote-session-id": null },
    { "data-zusage-workspace-identity": "" }, { "data-zusage-remote-session-id": "bad id" },
    { "data-zusage-workspace-path": "/p\n" }, { "data-zusage-workspace-identity": "remote:wsl:p" },
  ]) assert.equal(scopeFixture(attrs).read(), null, JSON.stringify(attrs));
  const f = scopeFixture();
  f.el.hasAttribute = k => k === "data-session-id";
  f.el.getAttribute = () => "other";
  assert.equal(f.read(), null);
});
test("current panes retain same-sid scope isolation without reading shared storage", () => {
  const f = scopeFixture();
  f.ctx.instances = [
    { pid: "workspace-main", getSid: () => "sA", getScope: f.read },
    { pid: "right", getSid: () => "sA", getScope: () => ({ sid: "sA", identity: B }) },
    { pid: "unknown", getSid: () => "sA", getScope: () => null },
  ];
  f.ctx.refreshWants();
  assert.deepEqual(Array.from(f.ctx.collectSidWs().sA), [A, B]);
  assert.equal(f.ctx.window.__zusagePaneScopes["workspace-main"].identity, A);
  assert.equal(f.ctx.window.__zusagePaneScopes.right.identity, B);
  assert.equal(f.ctx.window.__zusagePaneScopes.unknown.identity, undefined);
  f.ctx.instances = []; f.ctx.refreshWants();
  assert.equal(f.ctx.window.__zusageWantSid, "");
  assert.equal(f.ctx.mainScopeNow.known, false);
});
test("unknown current main cannot substitute a same-sid local snapshot", () => {
  const d = { scope_bindings: { "workspace-main": "" }, recent: [{ sid: "sA", requests: 9 }] };
  assert.equal(sessionFixture({ sid: "sA", identity: "", known: false })(d, "sA", "workspace-main"), null);
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
