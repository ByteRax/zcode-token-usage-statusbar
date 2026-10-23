"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const source = fs.readFileSync(path.join(__dirname, "..", "inject-main.cjs"), "utf8");
const A = "remote:ssh:a:22:u:/p", B = "remote:ssh:b:22:u:/p";
const flush = () => new Promise(resolve => setImmediate(resolve));
function loadPump(config = {}, desktopHome = "/fixture/home") {
  let now = 100000, id = 0, cfgStamp = 1, settingStamp = 1;
  const timers = new Map(), intervals = [], procs = [], lines = [], windows = [], ipc = new EventEmitter();
  let cfg = { activity_min_ms: 300, remote: { poll_ms: 1000 }, ...config };
  class Clock extends Date { static now() { return now; } }
  const mockFs = {
    readFileSync: file => String(file).endsWith("config.json") ? JSON.stringify(cfg) : "{}",
    statSync: file => {
      if (file === "/fixture/runtime/config.json") return { mtimeMs: cfgStamp, size: 1 };
      if (file === desktopHome + "/.zcode/v2/setting.json") return { mtimeMs: settingStamp, size: 1 };
      if (["/fixture/runtime/overlay.js", "/fixture/runtime/zusage.py",
        ...["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"].map(name => "/fixture/home/.zcode/cli/db/" + name)].includes(file)) {
        return { mtimeMs: 1, size: 1 };
      }
      throw Object.assign(new Error("ENOENT: " + file), { code: "ENOENT" });
    },
    existsSync: () => false, watch: () => ({ on() {} }), writeFileSync() {},
  };
  const sandbox = {
    __dirname: "/fixture/runtime", console: { error() {} }, Date: Clock,
    process: { resourcesPath: "/fixture/resources", execPath: process.execPath, uptime: () => 1,
      env: { ZCODE_DESKTOP_HOME_DIR: desktopHome } }, module: { exports: {} },
    setTimeout: (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    require(name) {
      if (name === "fs") return mockFs;
      if (["path", "url", "crypto"].includes(name)) return require(name);
      if (name === "electron") return { app: { getPath: () => "/fixture/home", on() {} }, webContents: { getAllWebContents: () => windows }, ipcMain: ipc };
      if (name === "child_process") return {
        spawn(cmd, args) {
          const p = new EventEmitter();
          p.args = args; p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.stdin = new EventEmitter();
          p.stdin.writable = true; p.stdin.write = line => lines.push(JSON.parse(line));
          p.kill = () => { p.killed = true; p.stdin.writable = false; };
          procs.push(p); return p;
        }, execFile() {},
      };
      throw new Error(name);
    },
  };
  vm.runInNewContext(source, sandbox);
  function addWindow(identity, sid = "sA") {
    const wc = { id: windows.length + 1, page: { s: [sid], w: identity ? { [sid]: [identity] } : {}, p: {} }, pushes: [],
      getType: () => "window", isDestroyed: () => false, getURL: () => "file:///fixture/resources/index.html",
      executeJavaScript: async js => {
        if (js.includes("var a=window.__zusageWantSids")) return JSON.stringify(wc.page);
        if (js.startsWith("window.__zusageUpdate")) wc.pushes.push(js);
        return "null";
      },
    };
    windows.push(wc); return wc;
  }
  return {
    api: sandbox.module.exports.__zusageTest, lines, procs, windows, timers, intervals, addWindow,
    workspace(wc, identities) { ipc.emit("zcode:sync-web-remote-control-workspaces", { sender: wc }, identities.map(workspaceIdentity => ({ workspacePath: "/p", kind: "remote", workspaceIdentity }))); },
    tasks(wc, identities) { ipc.emit("zcode:sync-web-remote-control-tasks", { sender: wc }, identities.map(workspaceIdentity => ({ taskId: "sA", workspaceKind: "remote", workspaceIdentity }))); },
    respond(payload, p = procs.at(-1)) { p.stdout.emit("data", Buffer.from(JSON.stringify(payload) + "\n")); },
    setCfg(value) { cfg = { ...cfg, ...value }; cfgStamp++; },
    settingChanged() { settingStamp++; },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = end; await flush();
    },
  };
}
async function start(f, identity = A) {
  const wc = f.addWindow(identity);
  if (identity) f.workspace(wc, [identity]);
  f.api.maybeSpawn(); await flush(); return wc;
}
const overlaySource = fs.readFileSync(path.join(__dirname, "..", "overlay.js"), "utf8");
function renderer(wc, panes, bindings = {}, history = [A], workbench = null, sharedEntries) {
  const entries = sharedEntries || new Map();
  entries.set("zcode-v4-pane-layout:v2", JSON.stringify({ panes: {} }));
  for (const identity of history) entries.set("zcode-v4-last-session:v1:" + identity, "sA");
  const workbenchPayload = list => JSON.stringify({
    version: 1, activeGroupId: list.length ? "g0" : null,
    groups: Object.fromEntries(list.map((primaryBinding, i) => ["g" + i, { primaryBinding }])),
  });
  if (workbench) entries.set("zcode-v4-session-workbench-groups:v1", workbenchPayload(workbench));
  const nodes = new Map();
  function node(pid, binding) {
    const scope = binding && binding.workspaceScope;
    const attrs = { "data-session-id": binding && binding.sessionId || "sA" };
    if (scope) Object.assign(attrs, {
      "data-zusage-scope-version": "1", "data-zusage-pane-id": pid,
      "data-zusage-workspace-path": scope.workspacePath,
      "data-zusage-workspace-identity": scope.workspaceIdentity || "",
      "data-zusage-remote-session-id": scope.remoteSessionId || "",
    });
    return { isConnected: true, parentElement: null,
      hasAttribute: k => Object.prototype.hasOwnProperty.call(attrs, k),
      getAttribute: k => attrs[k] ?? null };
  }
  for (const pid of panes) nodes.set(pid, node(pid, bindings[pid]));
  const context = vm.createContext({
    window: {}, instances: panes.map(pid => ({ pid, getSid: () => nodes.get(pid).getAttribute("data-session-id"),
      getScope: () => context.readPaneScope(nodes.get(pid), nodes.get(pid).getAttribute("data-session-id"), pid) })),
    remoteCache: {}, remoteTodayCache: {},
    localStorage: { get length() { return entries.size; }, key: i => [...entries.keys()][i], getItem: k => entries.get(k) || null },
  });
  context.ls = (key, fallback) => entries.get(key) || fallback;
  const extract = (start, end) => overlaySource.slice(overlaySource.indexOf(start), overlaySource.indexOf(end, overlaySource.indexOf(start)));
  vm.runInContext(extract("  function collectSidWs()", "  /* ---------- 回复末尾速率行") + extract("  function sessionFor(", "  window.__zusageUpdate"), context);
  context.window.__zusageUpdate = payload => { context.payload = payload; };
  context.replaceWorkbench = list => { entries.set("zcode-v4-session-workbench-groups:v1", workbenchPayload(list)); context.refreshWants(); };
  context.replacePane = (pid, binding) => { nodes.set(pid, node(pid, binding)); context.refreshWants(); };
  context.entries = entries;
  context.refreshWants();
  wc.executeJavaScript = async js => {
    if (js.includes("var a=window.__zusageWantSids") || js.startsWith("window.__zusageUpdate")) return vm.runInContext(js, context);
    return "null";
  };
  return context;
}
const wbRemote = (identity = A, sessionId = "sA") => ({ workspaceScope: { workspacePath: "/p", workspaceIdentity: identity }, sessionId });
const wbLocal = (sessionId = "sA") => ({ workspaceScope: { workspacePath: "/local" }, sessionId });
const success = identity => ({ recent: [{ sid: "sA", workspace_identity: identity, remote: true, remote_target: "stable", requests: 3 }], not_local: ["sA"], remote_enabled: true });
for (const [label, payload] of [["success", success(A)], ["SSH failure", { recent: [{ sid: "sA", workspace_identity: A, remote: true, remote_error: "ssh failed", remote_missing: true }], not_local: ["sA"], remote_enabled: true }], ["error", { error: "database locked" }], ["null", null]]) {
  test(`first ${label} automatically retries with a real scheduled timer`, async () => {
    const f = loadPump(); await start(f); f.respond(payload);
    await f.advance(999); assert.equal(f.lines.length, 1);
    await f.advance(1); assert.equal(f.lines.length, 2);
    assert.deepEqual(f.lines[1].scopes, [{ sid: "sA", workspaceIdentity: A }]);
  });
}
test("established chain survives repeated error and null responses", async () => {
  const f = loadPump(); await start(f); f.respond(success(A));
  for (const payload of [{ error: "locked" }, null, { error: "locked" }, success(A)]) {
    await f.advance(1000); f.respond(payload);
  }
  await f.advance(1000); assert.equal(f.lines.length, 6);
});
test("local idle dedups, config and client setting changes invalidate dedup", async () => {
  const f = loadPump(); await start(f, ""); f.respond({ recent: [], not_local: [], remote_enabled: false });
  await f.advance(31000); f.api.maybeSpawn(); await flush(); assert.equal(f.lines.length, 1);
  f.setCfg({ remote: { enabled: true, poll_ms: 1000 } }); f.api.maybeSpawn(); await flush(); assert.equal(f.lines.length, 2);
  f.respond({ recent: [], not_local: [] }); await f.advance(500);
  f.settingChanged(); f.api.maybeSpawn(); await flush(); assert.equal(f.lines.length, 3);
});
test("development desktop HOME setting changes invalidate local dedup", async () => {
  const f = loadPump({}, "/fixture/development-home");
  await start(f, "");
  f.respond({ recent: [], not_local: [], remote_enabled: false });
  await f.advance(31000);
  f.api.maybeSpawn(); await flush();
  assert.equal(f.lines.length, 1);
  f.settingChanged(); f.api.maybeSpawn(); await flush();
  assert.equal(f.lines.length, 2);
});
test("route change with unchanged sid bypasses dedup and does not need a target handshake", async () => {
  const f = loadPump(), wc = await start(f); f.respond(success(A));
  wc.page.w = { sA: [B] }; f.workspace(wc, [B]); await f.advance(350);
  assert.equal(f.lines.length, 2); assert.equal(f.lines[1].scopes[0].workspaceIdentity, B);
});
test("late load and untrusted or ambiguous history fail closed; workspace IPC recovers", async () => {
  const f = loadPump(), wc = await start(f, A);
  // No task IPC is required (Web remote feature may be disabled).
  assert.equal(f.lines[0].scopes.length, 1); f.respond(success(A));
  const g = loadPump(), late = g.addWindow(A); g.api.maybeSpawn(); await flush();
  assert.equal(g.lines[0].scopes.length, 0); g.respond({ recent: [], not_local: [] });
  g.workspace(late, [A]); await g.advance(350); assert.equal(g.lines[1].scopes.length, 1);
  g.respond(success(A)); late.page.w.sA = [A, B]; g.workspace(late, [A, B]); await g.advance(350);
  assert.equal(g.lines.at(-1).scopes.length, 0);
});
test("same sid in two windows retains both scopes and per-window bindings", async () => {
  const f = loadPump(), wa = f.addWindow(A), wb = f.addWindow(B);
  f.workspace(wa, [A]); f.workspace(wb, [B]); f.api.maybeSpawn(); await flush();
  assert.deepEqual(f.lines[0].scopes.map(s => s.workspaceIdentity), [A, B]);
  f.respond(success(A)); assert.match(wa.pushes.at(-1), /"scope_bindings":\{"sA":"remote:ssh:a/);
  assert.match(wb.pushes.at(-1), /"scope_bindings":\{"sA":"remote:ssh:b/);
});
test("same-window different panes preserve same sid distinct scopes", async () => {
  const f = loadPump(), wc = f.addWindow(A);
  wc.page.w.sA = [A, B]; wc.page.p = { left: { sid: "sA", identity: A }, right: { sid: "sA", identity: B } };
  f.workspace(wc, [A, B]); f.api.maybeSpawn(); await flush();
  assert.deepEqual(f.lines[0].scopes.map(s => s.workspaceIdentity), [A, B]);
});
test("primary pane with panes:{} refuses remote inference from connected-only workspace IPC", async () => {
  const f = loadPump(), wc = f.addWindow(A), page = renderer(wc, ["workspace-main"], {}, []);
  f.workspace(wc, [A]); f.api.maybeSpawn(); await flush();
  assert.deepEqual(f.lines[0].sids, ["sA"]);
  assert.equal(f.lines[0].scopes.length, 0);
  f.respond({ ...success(A), recent: [...success(A).recent, { sid: "sA", requests: 9 }] }); await flush();
  assert.equal(page.payload.scope_bindings["workspace-main"], "");
  assert.equal(page.sessionFor(page.payload, "sA", "workspace-main"), null);
});
test("bridge-less local-only window shows its local snapshot (issue #40)", async () => {
  /* 无桥 + 本窗没有任何远端证据：泵只能查本地，overlay 必须显示本地记录，
   * 不能因身份未知走零值占位（3.16.2 未登记版本的真实场景）。 */
  const f = loadPump(), wc = f.addWindow(null), page = renderer(wc, ["workspace-main"], {}, []);
  f.api.maybeSpawn(); await flush();
  assert.deepEqual(f.lines[0].sids, ["sA"]);
  assert.equal(f.lines[0].scopes.length, 0);
  f.respond({ recent: [{ sid: "sA", requests: 9 }], not_local: [] }); await flush();
  assert.equal(page.payload.scope_bindings["workspace-main"], "");
  assert.equal(page.payload.remote_evidence, false);
  assert.equal(page.sessionFor(page.payload, "sA", "workspace-main").requests, 9);
});
test("remote task evidence is scoped to the pane sid (issue #40)", async () => {
  /* 无关 sid 的远端任务不能把本地 pane 判死；同 sid 的远端任务仍 fail-closed。 */
  const f = loadPump(), wc = f.addWindow(null, "sB");
  const page = renderer(wc, ["workspace-main"], { "workspace-main": { sessionId: "sB" } }, []);
  f.tasks(wc, [A]);   // 远端任务属于 sA，与 pane 的 sB 无关
  f.api.maybeSpawn(); await flush();
  f.respond({ recent: [{ sid: "sB", requests: 9 }], not_local: [] }); await flush();
  assert.equal(page.payload.remote_evidence, false);
  assert.equal(page.sessionFor(page.payload, "sB", "workspace-main").requests, 9);

  const g = loadPump(), wc2 = g.addWindow(null), page2 = renderer(wc2, ["workspace-main"], {}, []);
  g.tasks(wc2, [A]);  // 远端任务属于 sA，正是 pane 的 sid
  g.api.maybeSpawn(); await flush();
  g.respond({ recent: [{ sid: "sA", requests: 9 }], not_local: [] }); await flush();
  assert.equal(page2.payload.remote_evidence, true);
  assert.equal(page2.sessionFor(page2.payload, "sA", "workspace-main"), null);
});
test("other window clearing a local last-session never routes the local main remotely", async () => {
  const f = loadPump(), local = f.addWindow(A), remote = f.addWindow(A);
  const shared = new Map();
  const page = renderer(local, ["workspace-main"], { "workspace-main": wbLocal() }, [A, "/local"], null, shared);
  const other = renderer(remote, ["workspace-main"], { "workspace-main": wbRemote() }, [], null, shared);
  f.workspace(local, [A]); f.workspace(remote, [A]);
  f.api.maybeSpawn(); await flush();
  f.respond({ ...success(A), recent: [...success(A).recent, { sid: "sA", requests: 9 }] }); await flush();
  shared.delete("zcode-v4-last-session:v1:/local");
  page.refreshWants(); other.refreshWants();
  await f.advance(1000);
  assert.equal(page.window.__zusagePaneScopes["workspace-main"].identity, "");
  assert.equal(other.window.__zusagePaneScopes["workspace-main"].identity, A);
  assert.deepEqual(f.lines.at(-1).sids, ["sA"]);
  f.respond({ ...success(A), recent: [...success(A).recent, { sid: "sA", requests: 9 }] }); await flush();
  assert.equal(page.sessionFor(page.payload, "sA", "workspace-main").requests, 9);
});
test("other window overwriting or deleting last-session cannot revoke a remote main", async () => {
  const f = loadPump(), wc = f.addWindow(A), otherWc = f.addWindow(A, "sB"), shared = new Map();
  const page = renderer(wc, ["workspace-main"], { "workspace-main": wbRemote() }, [A], null, shared);
  const other = renderer(otherWc, ["workspace-main"], { "workspace-main": wbRemote(A, "sB") }, [], null, shared);
  f.workspace(wc, [A]); f.workspace(otherWc, [A]); f.api.maybeSpawn(); await flush();
  const payload = () => ({ ...success(A), recent: [...success(A).recent,
    { sid: "sB", workspace_identity: A, remote: true, remote_target: "stable", requests: 7 }] });
  f.respond(payload()); await flush();
  for (const value of ["sB", null]) {
    const key = "zcode-v4-last-session:v1:" + A;
    if (value) shared.set(key, value); else shared.delete(key);
    page.refreshWants(); other.refreshWants(); await f.advance(1000);
    assert.equal(page.window.__zusagePaneScopes["workspace-main"].identity, A);
    assert.deepEqual(f.lines.at(-1).scopes, [
      { sid: "sA", workspaceIdentity: A }, { sid: "sB", workspaceIdentity: A },
    ]);
    assert.equal(page.sessionFor(page.payload, "sA", "workspace-main").requests, 3);
    assert.equal(other.sessionFor(other.payload, "sB", "workspace-main").requests, 7);
    f.respond(payload()); await flush();
  }
});
test("main pane routes remote through current node identity without history or groups", async () => {
  const f = loadPump(), wc = f.addWindow(A);
  const page = renderer(wc, ["workspace-main"], { "workspace-main": wbRemote() }, []);
  f.workspace(wc, [A]); f.api.maybeSpawn(); await flush();
  assert.equal(page.window.__zusagePaneScopes["workspace-main"].identity, A);
  assert.deepEqual(f.lines[0].sids, []);
  assert.deepEqual(f.lines[0].scopes, [{ sid: "sA", workspaceIdentity: A }]);
  f.respond(success(A)); await flush();
  assert.equal(page.sessionFor(page.payload, "sA", "workspace-main").requests, 3);
});
test("wsl and server identities join the trusted set and route remote", async () => {
  // 3.15.x wsl 直连（remote:wsl:）与 v3.16 握手升级（remote:server:）都必须与 ssh 同权：
  // 进 trusted、绑定主 pane、以整串身份发起 scope 查询；未知前缀仍 fail-closed 按本地。
  const W = "remote:wsl:Ubuntu:dev:/p", S = "remote:server:srv1:/p";
  for (const identity of [W, S]) {
    const f = loadPump(), wc = f.addWindow(identity);
    const page = renderer(wc, ["workspace-main"], { "workspace-main": wbRemote(identity) }, []);
    f.workspace(wc, [identity]); f.api.maybeSpawn(); await flush();
    assert.equal(page.window.__zusagePaneScopes["workspace-main"].identity, identity, identity);
    assert.deepEqual(f.lines[0].scopes, [{ sid: "sA", workspaceIdentity: identity }], identity);
    f.respond(success(identity)); await flush();
    assert.equal(page.sessionFor(page.payload, "sA", "workspace-main").requests, 3, identity);
  }
  const bad = loadPump(), badWc = bad.addWindow("remote:ftp:x:/p");
  const badPage = renderer(badWc, ["workspace-main"], { "workspace-main": wbRemote("remote:ftp:x:/p") }, []);
  bad.workspace(badWc, ["remote:ftp:x:/p"]); bad.api.maybeSpawn(); await flush();
  // 双层 fail-closed：浮层拒绝未知前缀（pane scope 只留 {sid} 占位），泵不信任该身份（按本地隔离）。
  assert.equal(badPage.window.__zusagePaneScopes["workspace-main"].sid, "sA");
  assert.equal(badPage.window.__zusagePaneScopes["workspace-main"].identity, undefined);
  assert.deepEqual(bad.lines[0].sids, ["sA"]);
  assert.deepEqual(bad.lines[0].scopes, []);
});
test("tasks contradiction vetoes the current node identity", async () => {
  const f = loadPump(), wc = f.addWindow(A);
  renderer(wc, ["workspace-main"], { "workspace-main": wbRemote() });
  f.workspace(wc, [A, B]); f.tasks(wc, [B]); f.api.maybeSpawn(); await flush();
  assert.deepEqual(f.lines[0].sids, ["sA"]);
  assert.deepEqual(f.lines[0].scopes, []);
});
test("real local main and remote right sharing sid stay isolated with remote-only workspace IPC", async () => {
  const f = loadPump(), wc = f.addWindow(A);
  const page = renderer(wc, ["workspace-main", "right"], {
    "workspace-main": wbLocal(),
    right: { sessionId: "sA", workspaceScope: { workspacePath: "/p", workspaceIdentity: A } },
  }, []);
  // Web remote disabled: host only publishes connected remotes, not the local main workspace.
  f.workspace(wc, [A]); f.api.maybeSpawn(); await flush();
  assert.deepEqual(f.lines[0].sids, ["sA"]);
  assert.deepEqual(f.lines[0].scopes, [{ sid: "sA", workspaceIdentity: A }]);
  f.respond({ ...success(A), recent: [...success(A).recent, { sid: "sA", requests: 9 }] }); await flush();
  assert.equal(page.payload.scope_bindings["workspace-main"], "");
  assert.equal(page.sessionFor(page.payload, "sA", "workspace-main").requests, 9);
  assert.equal(page.sessionFor(page.payload, "sA", "right").requests, 3);
});
test("primary pane with ambiguous trusted workspace history does not inherit a sid route", async () => {
  const f = loadPump(), wc = f.addWindow(A), page = renderer(wc, ["workspace-main"], {}, [A, B]);
  f.workspace(wc, [A, B]); f.api.maybeSpawn(); await flush();
  assert.equal(f.lines[0].scopes.length, 0);
  f.respond({ ...success(A), recent: [...success(A).recent, { sid: "sA", requests: 9 }] }); await flush();
  assert.equal(page.sessionFor(page.payload, "sA", "workspace-main"), null);
});
test("rendered group main routes by node scope even when persisted groups disagree", async () => {
  const f = loadPump(), wc = f.addWindow(A);
  const page = renderer(wc, ["workspace-main"], { "workspace-main": wbRemote(A) }, [], [wbLocal()]);
  f.workspace(wc, [A]); f.api.maybeSpawn(); await flush();
  assert.equal(page.window.__zusagePaneScopes["workspace-main"].identity, A);
  assert.deepEqual(f.lines[0].sids, []);
  assert.deepEqual(f.lines[0].scopes, [{ sid: "sA", workspaceIdentity: A }]);
  f.respond(success(A)); await flush();
  assert.equal(page.payload.scope_bindings["workspace-main"], A);
  assert.equal(page.sessionFor(page.payload, "sA", "workspace-main").requests, 3);
});
test("ambiguous workbench bindings (local main + remote group sharing sid) keep main local", async () => {
  const f = loadPump(), wc = f.addWindow(A);
  const page = renderer(wc, ["workspace-main"], { "workspace-main": wbLocal() }, [], [wbLocal(), wbRemote(A)]);
  f.workspace(wc, [A]); f.api.maybeSpawn(); await flush();
  assert.equal(page.window.__zusagePaneScopes["workspace-main"].identity, "");
  assert.deepEqual(f.lines[0].sids, ["sA"]);
  assert.deepEqual(f.lines[0].scopes, []);
  f.respond({ recent: [{ sid: "sA", requests: 9 }], not_local: [] }); await flush();
  assert.equal(page.payload.scope_bindings["workspace-main"], "");
  assert.equal(page.sessionFor(page.payload, "sA", "workspace-main").requests, 9);
});
test("two remote workbench primaries with the same sid keep main local", async () => {
  const f = loadPump(), wc = f.addWindow(A);
  const page = renderer(wc, ["workspace-main"], {}, [], [wbRemote(A), wbRemote(B)]);
  f.workspace(wc, [A, B]); f.api.maybeSpawn(); await flush();
  assert.deepEqual(f.lines[0].sids, ["sA"]);
  assert.deepEqual(f.lines[0].scopes, []);
});
test("workbench identity outside the trusted allowlist stays local", async () => {
  const f = loadPump(), wc = f.addWindow(B);
  const page = renderer(wc, ["workspace-main"], { "workspace-main": wbRemote(A) }, [], [wbRemote(A)]);
  f.workspace(wc, [B]); f.api.maybeSpawn(); await flush();
  assert.deepEqual(f.lines[0].sids, ["sA"]);
  assert.deepEqual(f.lines[0].scopes, []);
});
test("tasks contradiction vetoes the workbench main identity", async () => {
  const f = loadPump(), wc = f.addWindow(A);
  renderer(wc, ["workspace-main"], { "workspace-main": wbRemote(A) }, [], [wbRemote(A)]);
  f.workspace(wc, [A, B]); f.tasks(wc, [B]); f.api.maybeSpawn(); await flush();
  assert.deepEqual(f.lines[0].sids, ["sA"]);
  assert.deepEqual(f.lines[0].scopes, []);
});
test("split main pane keeps its layout identity through the late-payload guard", async () => {
  const f = loadPump(), wc = f.addWindow(A);
  const page = renderer(wc, ["workspace-main", "right"], {
    "workspace-main": { sessionId: "sA", workspaceScope: { workspacePath: "/p", workspaceIdentity: A } },
  });
  f.workspace(wc, [A]); f.api.maybeSpawn(); await flush();
  assert.equal(page.window.__zusagePaneScopes["workspace-main"].identity, A);
  assert.deepEqual(f.lines[0].scopes, [{ sid: "sA", workspaceIdentity: A }]);
  f.respond(success(A)); await flush();
  assert.equal(page.payload.scope_bindings["workspace-main"], A);
  assert.equal(page.sessionFor(page.payload, "sA", "workspace-main").requests, 3);
});
test("revoked main identity discards late remote payloads via the renderer guard", async () => {
  const f = loadPump(), wc = f.addWindow(A);
  const page = renderer(wc, ["workspace-main"], { "workspace-main": wbRemote(A) }, [], [wbRemote(A)]);
  f.workspace(wc, [A]); f.api.maybeSpawn(); await flush();
  f.respond(success(A)); await flush();
  assert.equal(page.payload.scope_bindings["workspace-main"], A);
  assert.equal(page.sessionFor(page.payload, "sA", "workspace-main").requests, 3);
  page.replacePane("workspace-main", wbLocal());
  assert.equal(page.sessionFor(page.payload, "sA", "workspace-main"), null);
});
test("same sid remote and local panes keep explicit empty local binding", async () => {
  const f = loadPump(), wc = f.addWindow(A);
  wc.page.p = { left: { sid: "sA", identity: A }, right: { sid: "sA", identity: "" } };
  f.workspace(wc, [A]); f.api.maybeSpawn(); await flush();
  assert.deepEqual(f.lines[0].sids, ["sA"]);
  assert.deepEqual(f.lines[0].scopes, [{ sid: "sA", workspaceIdentity: A }]);
  f.respond(success(A));
  assert.match(wc.pushes.at(-1), /"right":""/);
});
test("synchronous renderer destruction does not leave collection locked", async () => {
  const f = loadPump(), broken = f.addWindow(A), healthy = f.addWindow(B);
  f.workspace(healthy, [B]);
  broken.executeJavaScript = () => { throw new Error("WebContents was destroyed"); };
  assert.doesNotThrow(() => f.api.maybeSpawn()); await flush();
  assert.equal(f.lines.length, 1); assert.equal(f.lines[0].scopes[0].workspaceIdentity, B);
  f.windows.splice(0, 1); f.respond(success(B));
  await f.advance(1000); assert.equal(f.lines.length, 2);
});
for (const [label, payload] of [["error", { error: "locked" }], ["null", null], ["late success", success(A)]]) {
  test(`complete shutdown clears remote state even after ${label}`, async () => {
    const f = loadPump(); await start(f); f.respond(success(A));
    await f.advance(1000);
    // Configuration can change while the remote query is in flight.
    f.setCfg({ remote: { auto: false, enabled: false, poll_ms: 1000 } });
    f.respond(payload);
    assert.equal(f.api.remoteSids.size, 0); assert.equal(f.api.pendingSids.size, 0);
    await f.advance(31000); const count = f.lines.length;
    f.api.maybeSpawn(); await flush();
    if (f.lines.length > count) f.respond(payload); // one config-change probe is allowed
    const afterProbe = f.lines.length;
    await f.advance(31000); f.api.maybeSpawn(); await flush();
    assert.equal(f.lines.length, afterProbe);
    assert.equal(f.api.remoteSids.size, 0); assert.equal(f.api.pendingSids.size, 0);
  });
}
test("concurrent maybeSpawn collects only once", async () => {
  const f = loadPump(); f.addWindow(A);
  f.api.maybeSpawn(); f.api.maybeSpawn(); await flush(); assert.equal(f.lines.length, 1);
});
test("resident errors do not escape and timeout cannot double-settle a newer query", async () => {
  const f = loadPump(); await start(f); const old = f.procs[0];
  old.emit("error", new Error("ENOENT")); old.emit("close");
  await f.advance(1000); assert.equal(f.lines.length, 2);
  const active = f.procs.at(-1); await f.advance(15000); active.emit("close");
  await f.advance(1000); const count = f.lines.length;
  active.emit("close"); f.api.maybeSpawn(); await flush(); assert.equal(f.lines.length, count);
});
test("complete remote shutdown stops polling but re-enable is detected", async () => {
  const f = loadPump(), wc = await start(f); f.respond(success(A));
  f.setCfg({ remote: { auto: false, enabled: false, poll_ms: 1000 } });
  await f.advance(1000); f.respond({ recent: [], not_local: ["sA"], remote_enabled: false });
  const count = f.lines.length; await f.advance(31000); f.api.maybeSpawn(); await flush(); assert.equal(f.lines.length, count);
  f.setCfg({ remote: { auto: true, enabled: false, poll_ms: 1000 } }); f.api.maybeSpawn(); await flush();
  assert.equal(f.lines.length, count + 1); assert.equal(f.lines.at(-1).scopes[0].workspaceIdentity, A);
});
test("external window IPC is not a trusted auto route", async () => {
  const f = loadPump(), wc = f.addWindow(A); wc.getURL = () => "https://example.invalid";
  f.workspace(wc, [A]); f.api.maybeSpawn(); await flush(); assert.equal(f.lines[0].scopes.length, 0);
});
test("one-shot uses JSON protocol and retries after error/close once", async () => {
  const f = loadPump({ resident: false }); await start(f);
  assert.equal(JSON.parse(f.procs[0].args[2]).scopes[0].workspaceIdentity, A);
  f.procs[0].emit("error", new Error("ENOENT")); f.procs[0].emit("close");
  await f.advance(1000); assert.equal(f.procs.length, 2);
});
