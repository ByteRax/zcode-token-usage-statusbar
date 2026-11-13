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
  let now = 100000, id = 0, cfgStamp = 1, settingStamp = 1, dbStamp = 1;
  const timers = new Map(), intervals = [], procs = [], lines = [], windows = [], ipc = new EventEmitter();
  let cfg = { activity_min_ms: 300, remote: { poll_ms: 1000 }, ...config };
  class Clock extends Date { static now() { return now; } }
  const mockFs = {
    readFileSync: file => String(file).endsWith("config.json") ? JSON.stringify(cfg) : "{}",
    statSync: file => {
      if (file === "/fixture/runtime/config.json") return { mtimeMs: cfgStamp, size: 1 };
      if (file === desktopHome + "/.zcode/v2/setting.json") return { mtimeMs: settingStamp, size: 1 };
      if (["/fixture/runtime/overlay.js", "/fixture/runtime/zusage.py",
        // db 路径跟随 desktopHome（issue #279 起 dbDir 解析 setting.json dataBaseDir / env），
        // development-home 场景下库随之迁移，否则 stamp 恒 0 打穿去重
        ...["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"].map(name => desktopHome + "/.zcode/cli/db/" + name)].includes(file)) {
        return { mtimeMs: file.includes("/db/") ? dbStamp : 1, size: 1 };
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
    bumpDb() { dbStamp++; },   // 模拟宿主写 WAL：db 戳变化才会越过 maybeSpawn 的去重短路
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
  const { getNamedSlice, sliceOverlay } = require("./helpers/overlay-extract.cjs");
  vm.runInContext(getNamedSlice("paneScopeHelpers") + sliceOverlay("  function sessionFor(", "  window.__zusageUpdate"), context);
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
/* 规则 16（specs/perf-lag-reduction.md）：大库慢帧冷却。纯本地会话 + db 戳变化才会越过去重短路。
 * 旧门只从「发起」起算：帧耗时 ≥ 间隔时结算瞬间已满、下一帧零间隔紧接（占空比 ≈100%）——
 * 冷却从「结算」起算后，慢帧结算起须再等 ≥ 上帧实耗。 */
test("slow frame cools down for its own duration after settling (duty cycle capped)", async () => {
  const f = loadPump({ activity_min_ms: 1500 });
  await start(f, "");                                        // 本地 sid，无远端身份
  assert.equal(f.lines.length, 1);
  await f.advance(6000);                                     // 帧耗时 6s（远大于 activity_min_ms=1500）
  f.respond({ recent: [] });                                 // 结算：lastQueryMs=6000
  f.bumpDb(); f.api.maybeSpawn(); await flush();
  assert.equal(f.lines.length, 1, "结算瞬间不得零间隔紧接下一帧（旧门在此处会放行）");
  await f.advance(5500);
  assert.equal(f.lines.length, 1, "结算后冷却未满 6s 仍不放行");
  await f.advance(700);                                      // 总冷却 6.2s ≥ 6s + 50ms
  assert.equal(f.lines.length, 2, "冷却满后由 scheduleRetry 自驱放行");
});
/* 占空比驱动：宿主持续写库（bumpDb + maybeSpawn 代表 fs.watch 事件，夹具 watch 是空桩），
 * 每帧放行后 FRAME 毫秒结算（模拟 serve 返回）；返回放行帧数、结算帧数与帧间空闲时长。 */
async function drivePump(f, FRAME, WINDOW, STEP) {
  let sent = f.lines.length, settleAt = FRAME, frames = 0, idleMs = 0;
  for (let t = 0; t < WINDOW; t += STEP) {
    f.bumpDb(); f.api.maybeSpawn();
    if (t >= settleAt && sent > frames) { f.respond({ recent: [] }); frames = sent; settleAt = Infinity; }
    await f.advance(STEP);
    if (f.lines.length > sent) { sent = f.lines.length; settleAt = t + STEP + FRAME; }
    if (settleAt === Infinity) idleMs += STEP;               // 两帧之间的空闲（冷却）时间
  }
  return { sent, frames, idleMs };
}
test("duty cycle stays at or below ~50% under sustained slow frames", async () => {
  const f = loadPump({ activity_min_ms: 1500 });
  await start(f, "");
  const FRAME = 6000, WINDOW = 120000;
  const { frames, idleMs } = await drivePump(f, FRAME, WINDOW, 250);
  assert.ok(frames >= 5, "窗口内必须真的发生多帧（防空转假绿灯），实测 " + frames + " 帧");
  const duty = (frames * FRAME) / WINDOW;
  assert.ok(duty <= 0.55, "占空比应 ≤ ~50%，实测 " + Math.round(duty * 100) + "%（" + frames + " 帧）");
  assert.ok(idleMs > 0, "帧间必须存在冷却空闲");
});
test("frames just under activity_min_ms are capped too (no discontinuity at the interval)", async () => {
  /* 真库实测冷帧 ~1.05s 低于 activity_min_ms=1.5s。冷却若只在「帧耗时 > 间隔」时介入，T=1.2s 的帧
   * 占空比 ≈ 1.2/1.55 ≈ 77%，且在 T 跨过间隔处从 ~100% 骤降到 50%——这一档正是冷却最该覆盖的区间。 */
  const f = loadPump({ activity_min_ms: 1500 });
  await start(f, "");
  const FRAME = 1200, WINDOW = 60000;
  const { frames } = await drivePump(f, FRAME, WINDOW, 100);
  assert.ok(frames >= 10, "窗口内必须真的发生多帧，实测 " + frames + " 帧");
  const duty = (frames * FRAME) / WINDOW;
  assert.ok(duty <= 0.55, "占空比应 ≤ ~50%，实测 " + Math.round(duty * 100) + "%（" + frames + " 帧）");
});
test("fast frames keep the original activity_min_ms cadence (no behaviour change)", async () => {
  const f = loadPump({ activity_min_ms: 1500 });
  await start(f, ""); await f.advance(200); f.respond({ recent: [] });   // 帧耗时 200ms ≪ 1500ms
  f.bumpDb(); await f.advance(1000); f.api.maybeSpawn(); await flush();
  assert.equal(f.lines.length, 1, "未满 activity_min_ms 不放行");
  await f.advance(400); f.api.maybeSpawn(); await flush();
  assert.equal(f.lines.length, 2, "快帧仍按 1500ms 原节奏放行（冷却不介入）");
});
test("frames up to half the interval keep the original cadence (cooldown is covered by the old gate)", async () => {
  /* 帧耗时 T ≤ 间隔/2 时，旧限频门（发起+间隔）已比冷却（结算+T = 发起+2T）更严，节奏必须与旧版逐字一致。
   * 变异守卫：冷却若比 T 更长（如 2×T 或固定加量），这里的节奏会掉下来。 */
  const f = loadPump({ activity_min_ms: 1500 });
  await start(f, "");
  const { sent } = await drivePump(f, 600, 30000, 100);
  // 旧版/实测：每 ~1.43–1.55s 一帧 → 30s 内 21 帧；冷却若比 T 更长（2×T=1.8s 周期 → ~17 帧）会掉下来
  assert.ok(sent >= 20, "T=600ms 的节奏应保持 ~1.5s/帧，30s 内至少 20 帧，实测 " + sent);
});
test("resident timeout is widened for slow frames but stays 15s for fast ones", async () => {
  const slow = loadPump({ activity_min_ms: 1500 });
  await start(slow, ""); await slow.advance(8000); slow.respond({ recent: [] });   // 上帧 8s → 超时 max(15,16)=16s
  slow.bumpDb(); await slow.advance(8100); slow.api.maybeSpawn(); await flush();
  assert.equal(slow.lines.length, 2);
  const old = slow.procs[0];
  await slow.advance(15500);
  assert.equal(old.killed, undefined, "慢帧场景 15.5s 时尚在放宽后的超时内，不得被硬杀");
  const fast = loadPump({ activity_min_ms: 1500 });
  await start(fast, ""); await fast.advance(15100);
  assert.equal(fast.procs[0].killed, true, "快帧场景仍保持 15s 硬超时");
});
