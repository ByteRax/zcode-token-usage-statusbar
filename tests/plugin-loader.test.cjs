"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { pathToFileURL } = require("url");

test("loader consumes only fixed update actions from trusted local windows and pushes state", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "inject-main.cjs"), "utf8");
  const resources = path.resolve("/fixture/resources");
  const intervals = [], requests = [], scripts = [], windows = [], acknowledgements = [];
  const status = { supported: true, phase: "available", auto: false };
  let tickCount = 0;
  const stub = { request: async (r) => requests.push(r), tick: async () => { tickCount++; }, status: () => status };
  const makeWindow = (url, queue) => ({
    getType: () => "window", isDestroyed: () => false, getURL: () => url, isLoading: () => false,
    on: () => {}, executeJavaScript: async (script) => {
      scripts.push(script);
      return script.includes("q.splice") ? queue.splice(0, 8) : "[]";
    },
  });
  windows.push(makeWindow(pathToFileURL(path.join(resources, "app.asar", "out", "renderer", "index.html")).href + "?restore", [
    { action: "check" }, { action: "shell", command: "ignored" }, { action: "auto", enabled: true },
  ]));
  windows.push(makeWindow("https://example.com", [{ action: "update" }]));
  windows.push(makeWindow(pathToFileURL(path.join(resources, "..", "outside.html")).href, [{ action: "update" }]));
  const mockFs = { readFileSync: (file) => String(file).endsWith("overlay.js") ? "/* overlay */" : "{}",
    statSync: () => ({ mtimeMs: 1 }), existsSync: () => true, watch: () => ({ on: () => {} }), writeFileSync: () => {},
    unlinkSync: () => { throw new Error("Loader must acknowledge instead of deleting the marker directly"); } };
  const sandbox = {
    __dirname: "/fixture/runtime", console: { error: () => {} },
    process: { resourcesPath: resources, execPath: process.execPath, uptime: () => 1 },
    setInterval: (fn, delay) => { intervals.push({ fn, delay }); },
    setTimeout: () => 1, clearTimeout: () => {},
    require: (id) => {
      if (id === "path") return path;
      if (id === "fs") return mockFs;
      if (id === "url") return require("url");
      if (id === "crypto") return require("crypto");
      if (id === "child_process") return { spawn: () => { throw new Error("Query must not run"); },
        execFile: (command, args, options, callback) => { acknowledgements.push({ command, args, options }); callback(null); } };
      if (id === "./plugin-updater.cjs") return { createUpdater: (opts) => { opts.notify(status); return stub; } };
      if (id === "electron") return { app: { getPath: () => "/fixture/home", on: () => {} },
        webContents: { getAllWebContents: () => windows }, ipcMain: { on: () => {} } };
      throw new Error(id);
    },
  };
  vm.runInNewContext(source, sandbox);
  await new Promise((r) => setImmediate(r));
  const poll = intervals.find((i) => i.delay === 1000);
  assert.ok(poll); await poll.fn();
  assert.equal(acknowledgements.length, 1);
  const ack = acknowledgements[0];
  // loader 用 path.join(HERE, ...) 构造命令；Windows 上产出反斜杠是真实运行所需，
  // 预期值须同用 path.join 保持平台一致。
  assert.deepEqual(Array.from(ack.args.slice(0, 3)),
    [path.join("/fixture/runtime", "runtime_lock.py"), "--ack-restart", "/fixture/runtime"]);
  const loaded = JSON.parse(ack.args[3]);
  assert.ok(loaded._loadedAt > 0);
  for (const name of ["inject-main.cjs", "plugin-updater.cjs", "overlay.js", "zusage.py"]) assert.match(loaded[name], /^[a-f0-9]{64}$/);
  assert.equal(ack.options.windowsHide, true);
  assert.deepEqual(requests.map((r) => r.action), ["check", "auto"]);
  assert.ok(scripts.some((s) => s.includes("window.__zusagePluginUpdate")));
  assert.equal(tickCount, 1);
  await intervals.find((i) => i.delay === 60000).fn(); assert.equal(tickCount, 2);
});

test("loader keeps polling controls while an update action is still awaiting the CLI", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "inject-main.cjs"), "utf8");
  const actionSource = source.slice(source.indexOf("async function pollPluginRequests()"), source.indexOf("setInterval(pollPluginRequests"));
  const pending = new Promise(() => {});
  const requests = [], queue = [{ action: "update" }];
  const wc = { id: 1, isDestroyed: () => false, getType: () => "window",
    getURL: () => pathToFileURL("/fixture/resources/app.asar/out/renderer/index.html").href,
    executeJavaScript: async () => queue.splice(0, 8) };
  const sandbox = { pluginRequestBusy: false, process: { resourcesPath: "/fixture/resources" }, path,
    fileURLToPath: require("url").fileURLToPath, isMainWindowState: () => true,
    webContents: { getAllWebContents: () => [wc] }, LOG: () => {}, setTimeout: () => 1,
    pluginUpdater: { request: (req) => { requests.push(req); return req.action === "update" ? pending : Promise.resolve(); } } };
  vm.runInNewContext(actionSource, sandbox);
  await sandbox.pollPluginRequests();
  queue.push({ action: "auto", enabled: false });
  await sandbox.pollPluginRequests();
  assert.deepEqual(requests.map((r) => r.action), ["update", "auto"]);
  assert.equal(requests[1].enabled, false);
  assert.equal(sandbox.pluginRequestBusy, false);
});

test('quota source requests write quota-secrets.json atomically with whitelist and 0600', async () => {
  const intervals = [], acknowledgements = [], windows = [];
  const writes = [];
  const secretsState = { json: null };
  const path = require("path");
  const { pathToFileURL } = require("url");
  const resources = "/fixture/resources";
  const status = {};
  const makeWindow = (url, queue) => ({
    getURL: () => url,
    isDestroyed: () => false,
    getType: () => "window",
    isLoading: () => false,
    on: () => {},
    executeJavaScript: async (script) => {
      if (script.includes("q.splice")) return queue.splice(0, 8);
      if (script.includes("__zusagePluginState")) return JSON.stringify(status);
      return "null";
    },
  });
  windows.push(makeWindow(pathToFileURL(path.join(resources, "app.asar", "out", "renderer", "index.html")).href, [
    { action: "quota-src", id: "mimo", enabled: true },
    { action: "quota-src-key", id: "mimo", field: "cookie", value: "userId=1; serviceToken=abc" },
    { action: "quota-src-key", id: "mimo", field: "evilField", value: "x" },          // 白名单外：忽略
    { action: "quota-src-key", id: "../etc", field: "apiKey", value: "x" },           // 非法源 id：忽略
    { action: "quota-src-key", id: "scnet", field: "modelPatterns", value: '{"GLM-*":"GLM-5.2"}' },
    { action: "quota-src-key", id: "scnet", field: "planCredits", value: "240000" },
    { action: "quota-src-refresh", id: "minimax" },
  ]));
  const mockFs = {
    readFileSync: (file) => {
      if (String(file).endsWith("quota-secrets.json")) {
        if (secretsState.json == null) throw new Error("ENOENT");
        return secretsState.json;
      }
      return String(file).endsWith("overlay.js") ? "/* overlay */" : "{}";
    },
    statSync: () => ({ mtimeMs: 1 }), existsSync: () => true, watch: () => ({ on: () => {} }),
    writeFileSync: (file, data, opts) => { writes.push({ file: String(file), data: String(data), opts }); },
    renameSync: (from, to) => {
      const w = writes[writes.length - 1];
      if (w && w.file === String(from)) secretsState.json = w.data;   // 原子替换语义：rename 后读得到
    },
    chmodSync: () => {},
    unlinkSync: () => { throw new Error("unexpected"); },
  };
  const sandbox = {
    __dirname: "/fixture/runtime", console: { error: () => {} },
    process: { resourcesPath: resources, execPath: process.execPath, uptime: () => 1 },
    setInterval: (fn, delay) => { intervals.push({ fn, delay }); },
    setTimeout: () => 1, clearTimeout: () => {},
    require: (id) => {
      if (id === "path") return path;
      if (id === "fs") return mockFs;
      if (id === "url") return require("url");
      if (id === "crypto") return require("crypto");
      if (id === "child_process") return { spawn: () => { throw new Error("no spawn"); }, execFile: (c, a, o, cb) => { acknowledgements.push({ args: a }); cb(null); } };
      if (id === "./plugin-updater.cjs") return { createUpdater: (o) => { o.notify(status); return { request: async () => {}, tick: async () => {}, status: () => status }; }, updateConfig: async () => {} };
      if (id === "./quota-client.cjs") return { createQuotaClient: () => ({ tick: () => {}, view: () => ({}), refresh: () => {}, refreshSource: () => {}, noteProvider: () => {}, credentialsChanged: () => {}, noteSnapshotExtras: () => {}, sourcesConfig: () => [], dispose: () => {} }) };
      if (id === "electron") return { app: { getPath: () => "/fixture/home", on: () => {} }, webContents: { getAllWebContents: () => windows }, ipcMain: { on: () => {} } };
      throw new Error(id);
    },
  };
  const vm = require("vm");
  const fs = require("fs");
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "inject-main.cjs"), "utf8"), sandbox);
  await new Promise((r) => setImmediate(r));
  const poll = intervals.find((i) => i.delay === 1000);
  await poll.fn();
  const final = JSON.parse(secretsState.json);
  assert.deepEqual(final.sources.mimo, { enabled: true, cookie: "userId=1; serviceToken=abc" });
  assert.deepEqual(final.sources.scnet, { modelPatterns: { "GLM-*": "GLM-5.2" }, planCredits: 240000 });
  assert.ok(!final.sources["../etc"], "非法源 id 被拒");
  assert.ok(final.sources.mimo.cookie, "白名单字段写入");
  assert.ok(!final.sources.mimo.evilField, "白名单外字段忽略");
  const first = writes[0];
  assert.equal(first.file, "/fixture/runtime/quota-secrets.json.tmp", "同目录 tmp 原子替换");
  assert.equal(first.opts.mode, 0o600, "凭据文件 0600 创建");
});
