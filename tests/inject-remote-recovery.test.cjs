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
function renderer(wc, panes, bindings = {}, history = [A], workbench = null) {
  const entries = new Map([
    ["zcode-v4-pane-layout:v2", JSON.stringify({
      root: panes.length === 1 ? { type: "leaf", paneId: "workspace-main" } : {
        type: "split", id: "n1", direction: "row", ratio: 0.5,
        first: { type: "leaf", paneId: "workspace-main" }, second: { type: "leaf", paneId: "right" },
      }, panes: bindings, focusedPaneId: "workspace-main",
    })],
    ...history.map(identity => ["zcode-v4-last-session:v1:" + identity, "sA"]),
  ]);
  const workbenchPayload = list => JSON.stringify({
    version: 1, activeGroupId: list.length ? "g0" : null,
    groups: Object.fromEntries(list.map((primaryBinding, i) => ["g" + i, { primaryBinding }])),
    sessionIndex: {},
  });
  if (workbench) entries.set("zcode-v4-session-workbench-groups:v1", workbenchPayload(workbench));
  const context = vm.createContext({
    window: {}, instances: panes.map(pid => ({ pid, getSid: () => "sA" })),
    remoteCache: {}, remoteTodayCache: {},
    localStorage: { get length() { return entries.size; }, key: i => [...entries.keys()][i], getItem: k => entries.get(k) || null },
  });
  context.ls = (key, fallback) => entries.get(key) || fallback;
  const extract = (start, end) => overlaySource.slice(overlaySource.indexOf(start), overlaySource.indexOf(end, overlaySource.indexOf(start)));
  vm.runInContext(extract("  function collectSidWs()", "  /* ---------- 回复末尾速率行") + extract("  function sessionFor(", "  window.__zusageUpdate"), context);
  context.window.__zusageUpdate = payload => { context.payload = payload; };
  context.replaceWorkbench = list => { entries.set("zcode-v4-session-workbench-groups:v1", workbenchPayload(list)); context.refreshWants(); };
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
  assert.equal(page.sessionFor(page.payload, "sA", "workspace-main").requests, 9);
});
test("main pane routes remote through the last-session fallback without any group (issue #30)", async () => {
  // 单会话主标签页形态：无 workbench-groups 键，唯一归属证据是 last-session A→sA（issue #30 复测）
  const f = loadPump(), wc = f.addWindow(A), page = renderer(wc, ["workspace-main"]);
  f.workspace(wc, [A]); f.api.maybeSpawn(); await flush();
  assert.equal(page.window.__zusagePaneScopes["workspace-main"].identity, A);
  assert.deepEqual(f.lines[0].sids, []);
  assert.deepEqual(f.lines[0].scopes, [{ sid: "sA", workspaceIdentity: A }]);
  f.respond(success(A)); await flush();
  assert.equal(page.payload.scope_bindings["workspace-main"], A);
  assert.equal(page.sessionFor(page.payload, "sA", "workspace-main").requests, 3);
});
test("tasks contradiction vetoes the last-session fallback identity", async () => {
  const f = loadPump(), wc = f.addWindow(A);
  renderer(wc, ["workspace-main"]);
  f.workspace(wc, [A, B]); f.tasks(wc, [B]); f.api.maybeSpawn(); await flush();
  assert.deepEqual(f.lines[0].sids, ["sA"]);
  assert.deepEqual(f.lines[0].scopes, []);
});
test("real local main and remote right sharing sid stay isolated with remote-only workspace IPC", async () => {
  const f = loadPump(), wc = f.addWindow(A);
  const page = renderer(wc, ["workspace-main", "right"], {
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
  assert.equal(page.sessionFor(page.payload, "sA", "workspace-main").requests, 9);
});
test("main pane routes remote through a unique workbench primary binding (issue #30)", async () => {
  const f = loadPump(), wc = f.addWindow(A);
  const page = renderer(wc, ["workspace-main"], {}, [], [wbRemote(A)]);
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
  const page = renderer(wc, ["workspace-main"], {}, [], [wbLocal(), wbRemote(A)]);
  f.workspace(wc, [A]); f.api.maybeSpawn(); await flush();
  assert.equal(page.window.__zusagePaneScopes["workspace-main"].identity, undefined);
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
  const page = renderer(wc, ["workspace-main"], {}, [], [wbRemote(A)]);
  f.workspace(wc, [B]); f.api.maybeSpawn(); await flush();
  assert.deepEqual(f.lines[0].sids, ["sA"]);
  assert.deepEqual(f.lines[0].scopes, []);
});
test("tasks contradiction vetoes the workbench main identity", async () => {
  const f = loadPump(), wc = f.addWindow(A);
  renderer(wc, ["workspace-main"], {}, [], [wbRemote(A)]);
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
  const page = renderer(wc, ["workspace-main"], {}, [], [wbRemote(A)]);
  f.workspace(wc, [A]); f.api.maybeSpawn(); await flush();
  f.respond(success(A)); await flush();
  assert.equal(page.payload.scope_bindings["workspace-main"], A);
  assert.equal(page.sessionFor(page.payload, "sA", "workspace-main").requests, 3);
  page.replaceWorkbench([wbLocal()]);
  assert.equal(page.sessionFor(page.payload, "sA", "workspace-main"), null);
});test("same sid remote and local panes keep explicit empty local binding", async () => {
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
