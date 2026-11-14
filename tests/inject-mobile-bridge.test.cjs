"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { EventEmitter } = require("node:events");
const { readInjectSource } = require("./helpers/overlay-extract.cjs");

const flush = () => new Promise(resolve => setImmediate(resolve));
const A = "remote:ssh:host:/project";
const WSL = "remote:server:wsl-fixture:/project";
function makeBridge(identity = A) {
  const p = {};
  return { p, b: { relayProtocol: { protocol: p }, readyAnnounced: true,
    kind: identity ? "remote" : "local", workspacePath: "/project", workspaceIdentity: identity,
    ...(identity ? { remoteSessionId: "remote-fixture" } : {}) } };
}
function mobileView(identity = A) {
  return { taskId: "s1", workspacePath: "/project", workspaceIdentity: identity,
    ...(identity ? { remoteSessionId: "remote-fixture" } : {}) };
}
function status(view = mobileView()) { return JSON.stringify({ mobileConnected: true, mobileTaskView: view }); }
function harness(initial = {}) {
  let cfg = { python_path: "custom-python", ...initial }, stamp = 1, mobileMtime = 1;
  const windows = [], intervals = [], relays = [], ipc = new EventEmitter(), app = new EventEmitter();
  app.getPath = () => "/fixture/home";
  const contents = "module.exports = {};";
  const mockFs = {
    readFileSync: f => String(f).endsWith("config.json") ? JSON.stringify(cfg) : contents,
    statSync: f => {
      if (String(f).endsWith("config.json")) return { mtimeMs: stamp, size: 1 };
      if (String(f).endsWith("mobile-relay.cjs")) return { mtimeMs: mobileMtime, size: 1 };
      throw Error("missing");
    },
    existsSync: () => false, watch: () => ({ on() {}, close() {} }), writeFileSync() {},
  };
  const load = name => {
    if (name === "fs") return mockFs;
    if (["path", "url", "crypto"].includes(name)) return require(name);
    if (name === "electron") return { app, ipcMain: ipc, webContents: { getAllWebContents: () => windows } };
    if (name === "child_process") return { spawn() { throw Error("disabled in fixture"); }, execFile() {} };
    if (name === "./mobile-relay.cjs") return { createMobileRelay(options) {
      const relay = { options, calls: [], disposed: 0, pump() {},
        push(payload, validate, verifyTarget) { this.calls.push({ payload, validate, verifyTarget }); },
        dispose() { this.disposed++; } };
      relays.push(relay); return relay;
    } };
    throw Error(name);
  };
  load.cache = {}; load.resolve = name => name;
  const resources = path.resolve("/fixture/resources");
  const bridge = makeBridge();
  const sandbox = { __dirname: "/fixture/runtime", console: { error() {} }, module: { exports: {} },
    __zusageRelayStash: [bridge],
    process: { resourcesPath: resources, env: {}, uptime: () => 1, platform: "win32" },
    setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; }, clearInterval() {},
    setTimeout() { return 1; }, clearTimeout() {}, require: load };
  vm.runInNewContext(readInjectSource(), sandbox);
  function addWindow() {
    const wc = new EventEmitter();
    Object.assign(wc, { id: windows.length + 1, getType: () => "window", isDestroyed: () => false,
      getURL: () => pathToFileURL(path.join(resources, "index.html")).href, executeJavaScript: async () => "null" });
    windows.push(wc); return wc;
  }
  return { app, ipc, windows, intervals, relays, bridge, api: sandbox.module.exports.__zusageTest, addWindow,
    stash(entries) { sandbox.__zusageRelayStash = entries; },
    config(value) { cfg = { ...cfg, ...value }; stamp++; },
    changeMobile() { mobileMtime++; },
    tick() { intervals.find(x => x.ms === 1500).fn(); },
    workspace(wc, ids) { ipc.emit("zcode:sync-web-remote-control-workspaces", { sender: wc }, ids.map(identity => ({ kind: "remote", workspacePath: "/project", workspaceIdentity: identity }))); },
    tasks(wc, ids) { ipc.emit("zcode:sync-web-remote-control-tasks", { sender: wc }, ids.map(identity => ({ taskId: "s1", workspaceKind: identity ? "remote" : "local", workspaceIdentity: identity }))); },
  };
}

test("mobile relay receives live enabled and interpreter getters", () => {
  const h = harness({ mobile_relay: { enabled: false } });
  const opts = h.relays[0].options;
  assert.equal(opts.isEnabled(), false);
  assert.equal(opts.getPythonCmd(), "custom-python");
  h.config({ mobile_relay: { enabled: true }, python_path: "new-python" });
  assert.equal(opts.isEnabled(), true);
  assert.equal(opts.getPythonCmd(), "new-python");
  h.config({ mobile_relay: { enabled: "invalid" } });
  assert.equal(opts.isEnabled(), true);
});

test("dynamic WSL target uses its official live bridge without a desktop tabs entry", async () => {
  const h = harness(), wc = h.addWindow(), relay = h.relays[0];
  h.stash([makeBridge(WSL)]);
  h.workspace(wc, [A]); h.tasks(wc, []);
  wc.executeJavaScript = async () => status(mobileView(WSL));
  h.tick(); await flush();
  const accepted = relay.calls.at(-1);
  assert.equal(accepted.payload.target.taskId, "s1");
  assert.equal(accepted.payload.target.workspaceIdentity, WSL);
  assert.equal(accepted.validate(), true);
  assert.equal(await accepted.verifyTarget(), true);
  h.workspace(wc, []);
  assert.equal(accepted.validate(), true, "desktop tabs do not own the mobile bridge");
  h.tasks(wc, [A]);
  assert.equal(accepted.validate(), false, "explicit task contradiction still revokes the target");
  assert.equal(relay.calls.at(-1).payload.target, null);
});

test("desktop pane still requires its workspace identity in the tabs whitelist", async () => {
  const h = harness(), wc = h.addWindow();
  const wants = { s: ["s1"], w: { s1: [WSL] }, p: { "workspace-main": { sid: "s1", identity: WSL } } };
  wc.executeJavaScript = async () => JSON.stringify(wants);
  h.workspace(wc, [A]); h.tasks(wc, [WSL]);
  h.api.maybeSpawn(); await flush();
  assert.equal(h.api.ipcState().scopeBindings.get(wc.id)["workspace-main"], "");
  h.workspace(wc, [WSL]);
  h.api.maybeSpawn(); await flush();
  assert.equal(h.api.ipcState().scopeBindings.get(wc.id)["workspace-main"], WSL);
});

test("late discovery after disable or multiple windows is discarded", async () => {
  const h = harness(), wc = h.addWindow(), relay = h.relays[0];
  let resolve;
  wc.executeJavaScript = () => new Promise(r => { resolve = r; });
  h.tick(); await flush();
  h.config({ mobile_relay: { enabled: false } }); resolve(status()); await flush();
  assert.equal(relay.calls.some(c => c.payload.target), false);
  h.config({ mobile_relay: { enabled: true } }); h.addWindow(); h.tick(); await flush();
  assert.equal(relay.calls.some(c => c.payload.target), false);
});

for (const [label, alter] of [
  ["external page", wc => { wc.getURL = () => "https://example.com/"; }],
  ["destroyed window", wc => { wc.isDestroyed = () => true; }],
  ["non-window sender", wc => { wc.getType = () => "webview"; }],
]) {
  test(`mobile discovery rejects an ${label}`, async () => {
    const h = harness(), wc = h.addWindow(), relay = h.relays[0];
    wc.executeJavaScript = async () => status();
    alter(wc); h.tick(); await flush();
    assert.equal(relay.calls.some(c => c.payload.target), false);
  });
}

test("mobile local target rejects explicit task contradictions", async () => {
  const h = harness(), wc = h.addWindow(), relay = h.relays[0];
  h.stash([makeBridge("")]);
  wc.executeJavaScript = async () => status(mobileView(""));
  h.tasks(wc, [A]); h.tick(); await flush();
  assert.equal(relay.calls.at(-1).payload.target, null);
  h.tasks(wc, [""]); h.tick(); await flush();
  const accepted = relay.calls.at(-1);
  assert.equal(accepted.payload.target.workspaceIdentity, "");
  assert.equal(accepted.validate(), true);
  wc.executeJavaScript = async () => status({ ...mobileView(""), workspaceIdentity: null });
  h.tick(); await flush();
  assert.equal(relay.calls.at(-1).payload.target, null);
  assert.equal(accepted.validate(), false);
});

test("send verifier reads live status before cached discovery changes", async () => {
  const h = harness(), wc = h.addWindow(), relay = h.relays[0];
  const view = mobileView();
  let currentStatus = { mobileConnected: true, mobileTaskView: view };
  wc.executeJavaScript = async () => JSON.stringify(currentStatus);
  h.tasks(wc, [A]); h.tick(); await flush();
  const accepted = relay.calls.at(-1);
  assert.equal(accepted.validate(), true);
  assert.equal(await accepted.verifyTarget(), true);
  for (const next of [
    { mobileConnected: false, mobileTaskView: view },
    { mobileConnected: true, mobileTaskView: null },
    { mobileConnected: true, mobileTaskView: { ...view, taskId: "s2" } },
    { mobileConnected: true, mobileTaskView: { ...view, workspacePath: "/other" } },
    { mobileConnected: true, mobileTaskView: { ...view, workspaceIdentity: "remote:ssh:other:/project" } },
    { mobileConnected: true, mobileTaskView: { ...view, workspaceIdentity: undefined } },
    { mobileConnected: true, mobileTaskView: { ...view, remoteSessionId: "remote-other" } },
    { mobileConnected: true, mobileTaskView: { ...view, remoteSessionId: undefined } },
  ]) {
    currentStatus = next;
    assert.equal(accepted.validate(), true, "cached discovery has not changed");
    assert.equal(await accepted.verifyTarget(), false);
  }
  wc.executeJavaScript = async () => { throw Error("status unavailable"); };
  assert.equal(await accepted.verifyTarget(), false);
});

test("discovery and send verifier both execute the host preload status call", async () => {
  const h = harness(), wc = h.addWindow(), relay = h.relays[0];
  let calls = 0;
  const window = { zcode: { async getWebRemoteControlStatus() {
    calls++;
    return { mobileConnected: true, mobileTaskView: mobileView() };
  } }, __zusageMobileChips: { zm: 1, target: { taskId: "cached-stale", workspacePath: "/old" } } };
  wc.executeJavaScript = script => vm.runInNewContext(script, { window });
  h.tick(); await flush();
  const accepted = relay.calls.at(-1);
  assert.equal(accepted.payload.target.taskId, "s1");
  assert.equal(accepted.payload.target.workspaceIdentity, A);
  assert.equal(calls, 1);
  assert.equal(await accepted.verifyTarget(), true);
  assert.equal(calls, 2);
  window.zcode.getWebRemoteControlStatus = async () => { throw Error("unavailable"); };
  assert.equal(await accepted.verifyTarget(), false);
  delete window.zcode.getWebRemoteControlStatus;
  assert.equal(await accepted.verifyTarget(), false);
  h.tick(); await flush();
  assert.equal(accepted.validate(), false);
  assert.equal(relay.calls.at(-1).payload.target, null);
});

test("live status without identity is accepted only for a bridge-confirmed local target", async () => {
  const h = harness(), wc = h.addWindow(), relay = h.relays[0], bridge = makeBridge("");
  h.stash([bridge]);
  const view = { taskId: "s1", workspacePath: "/project" };
  wc.executeJavaScript = async () => status(view);
  h.tasks(wc, [""]); h.tick(); await flush();
  const accepted = relay.calls.at(-1);
  assert.equal(accepted.payload.target.workspaceIdentity, "");
  assert.equal(await accepted.verifyTarget(), true);
  view.workspaceIdentity = null;
  assert.equal(await accepted.verifyTarget(), false);
  delete view.workspaceIdentity;
  delete bridge.b.workspaceIdentity;
  assert.equal(await accepted.verifyTarget(), true, "host local bridge permits undefined identity");
  bridge.b.kind = "remote";
  assert.equal(await accepted.verifyTarget(), false, "remote bridge without identity is rejected");
  bridge.b.workspaceIdentity = A;
  assert.equal(await accepted.verifyTarget(), false);
});

for (const [label, change] of [
  ["task", view => { view.taskId = "invalid task"; }],
  ["path", view => { view.workspacePath = "/other"; }],
  ["identity", view => { view.workspaceIdentity = WSL; }],
  ["missing remote identity", view => { delete view.workspaceIdentity; }],
  ["null identity", view => { view.workspaceIdentity = null; }],
  ["missing remote session", view => { delete view.remoteSessionId; }],
  ["wrong remote session", view => { view.remoteSessionId = "remote-other"; }],
  ["null remote session", view => { view.remoteSessionId = null; }],
  ["empty remote session", view => { view.remoteSessionId = ""; }],
]) {
  test(`mobile discovery rejects a mismatched ${label}`, async () => {
    const h = harness(), wc = h.addWindow(), relay = h.relays[0], view = mobileView();
    change(view); wc.executeJavaScript = async () => status(view);
    h.tick(); await flush();
    assert.equal(relay.calls.at(-1).payload.target, null);
  });
}

test("remote session is optional only when neither bridge nor host view provides it", async () => {
  const h = harness(), wc = h.addWindow(), relay = h.relays[0], view = mobileView();
  delete h.bridge.b.remoteSessionId;
  wc.executeJavaScript = async () => status(view);
  h.tick(); await flush();
  assert.equal(relay.calls.at(-1).payload.target, null, "a view cannot invent a bridge route");
  delete view.remoteSessionId;
  h.tick(); await flush();
  assert.equal(relay.calls.at(-1).validate(), true);
  assert.equal(await relay.calls.at(-1).verifyTarget(), true);
});

for (const [label, change] of [
  ["not ready", h => { h.bridge.b.readyAnnounced = false; }],
  ["missing ready", h => { delete h.bridge.b.readyAnnounced; }],
  ["invalid ready", h => { h.bridge.b.readyAnnounced = "true"; }],
  ["degraded", h => { h.bridge.b.degraded = true; }],
  ["closed", h => { h.bridge.b.closed = true; }],
  ["destroyed", h => { h.bridge.b.destroyed = true; }],
  ["missing relay", h => { delete h.bridge.b.relayProtocol; }],
  ["protocol mismatch", h => { h.bridge.b.relayProtocol.protocol = {}; }],
  ["missing stash", h => { h.stash([]); }],
  ["multiple live bridges", h => { h.stash([h.bridge, makeBridge()]); }],
  ["bridge replaced with same protocol", h => { h.stash([{ p: h.bridge.p, b: { ...h.bridge.b } }]); }],
  ["relay replaced with same protocol", h => { h.bridge.b.relayProtocol = { protocol: h.bridge.p }; }],
  ["protocol replaced consistently", h => { h.bridge.p = {}; h.bridge.b.relayProtocol.protocol = h.bridge.p; }],
  ["remote session changed", h => { h.bridge.b.remoteSessionId = "remote-new"; }],
  ["workspace path changed", h => { h.bridge.b.workspacePath = "/other"; }],
  ["workspace identity changed", h => { h.bridge.b.workspaceIdentity = WSL; }],
]) {
  test(`mobile target binding is revoked when ${label}`, async () => {
    const h = harness(), wc = h.addWindow(), relay = h.relays[0];
    wc.executeJavaScript = async () => status();
    h.tick(); await flush();
    const accepted = relay.calls.at(-1);
    assert.equal(accepted.validate(), true);
    change(h);
    assert.equal(accepted.validate(), false);
    assert.equal(await accepted.verifyTarget(), false);
    h.tick(); await flush();
    assert.equal(accepted.validate(), false, "rediscovery cannot revive the old binding");
  });
}

test("non-live stash entries do not make the official bridge ambiguous", async () => {
  const h = harness(), wc = h.addWindow(), relay = h.relays[0];
  const stale = makeBridge(); stale.b.closed = true;
  const pending = makeBridge(); pending.b.readyAnnounced = false;
  const mismatched = makeBridge(); mismatched.b.relayProtocol.protocol = {};
  h.stash([stale, pending, mismatched, h.bridge]);
  wc.executeJavaScript = async () => status();
  h.tick(); await flush();
  assert.equal(relay.calls.at(-1).validate(), true);
});

for (const [label, change] of [
  ["task contradiction", h => { h.tasks(h.windows[0], [WSL]); }],
  ["bridge replacement", h => { h.stash([makeBridge()]); }],
  ["protocol replacement", h => { h.bridge.b.relayProtocol.protocol = {}; }],
  ["remote session change", h => { h.bridge.b.remoteSessionId = "remote-new"; }],
  ["second window", h => { h.addWindow(); }],
  ["disable", h => { h.config({ mobile_relay: { enabled: false } }); }],
  ["shutdown", h => { h.app.emit("before-quit"); }],
]) {
  test(`live status verification rejects an in-flight ${label}`, async () => {
    const h = harness(), wc = h.addWindow(), relay = h.relays[0];
    wc.executeJavaScript = async () => status();
    h.tick(); await flush();
    const accepted = relay.calls.at(-1);
    let finish;
    wc.executeJavaScript = () => new Promise(resolve => { finish = resolve; });
    const pending = accepted.verifyTarget();
    await flush();
    change(h);
    finish(status());
    assert.equal(await pending, false);
  });
}

test("live status verification cannot restore a target revoked during its await", async () => {
  const h = harness(), wc = h.addWindow(), relay = h.relays[0];
  wc.executeJavaScript = async () => status();
  h.tick(); await flush();
  const accepted = relay.calls.at(-1);
  let finish;
  wc.executeJavaScript = () => new Promise(resolve => { finish = resolve; });
  const pending = accepted.verifyTarget();
  await flush();
  wc.executeJavaScript = async () => status(null);
  h.tick(); await flush();
  finish(status());
  assert.equal(await pending, false);
  assert.equal(relay.calls.at(-1).payload.target, null);
});

for (const [label, change] of [
  ["bridge replacement", h => { h.stash([makeBridge()]); }],
  ["relay replacement", h => { h.bridge.b.relayProtocol = { protocol: h.bridge.p }; }],
  ["protocol replacement", h => { h.bridge.p = {}; h.bridge.b.relayProtocol.protocol = h.bridge.p; }],
  ["remote session change", h => { h.bridge.b.remoteSessionId = "remote-new"; }],
]) {
  test(`discovery discards a status read across ${label}`, async () => {
    const h = harness(), wc = h.addWindow(), relay = h.relays[0];
    let finish;
    wc.executeJavaScript = () => new Promise(resolve => { finish = resolve; });
    h.tick(); await flush();
    change(h);
    const view = mobileView();
    if (label === "remote session change") view.remoteSessionId = "remote-new";
    finish(status(view)); await flush();
    assert.equal(relay.calls.some(c => c.payload.target), false, "a late status cannot bind to a different bridge");
    wc.executeJavaScript = async () => status(view);
    h.tick(); await flush();
    assert.equal(relay.calls.at(-1).validate(), true, "a fresh read can bind the new bridge");
  });
}

test("out-of-order discovery cannot restore a revoked target", async () => {
  const h = harness(), wc = h.addWindow(), relay = h.relays[0];
  const pending = [];
  wc.executeJavaScript = () => new Promise(r => pending.push(r));
  h.tick(); await flush(); h.tick(); await flush();
  pending[1](status(null)); await flush();
  pending[0](status()); await flush();
  assert.equal(relay.calls.some(c => c.payload.target), false);
});

test("mobile relay hot swaps once and is disposed at shutdown", async () => {
  const h = harness();
  h.changeMobile();
  assert.equal(await h.api.hotReloadMainModules(), true);
  assert.equal(h.relays.length, 2);
  assert.equal(h.relays[0].disposed, 1);
  assert.equal(typeof h.api.hotModuleState().hashes._hotLoadedAt["mobile-relay.cjs"], "number");
  h.app.emit("before-quit");
  assert.equal(h.relays[1].disposed, 1);
});
