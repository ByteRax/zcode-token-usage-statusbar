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
  for (const name of ["inject-main.cjs", "plugin-updater.cjs", "engine-patch.cjs", "overlay.js", "zusage.py"]) assert.match(loaded[name], /^[a-f0-9]{64}$/);
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

test('quota source token edit for qianwen drops the stale device-login expiry and account (manual token after expiry stays usable; clear is a full sign-out)', async () => {
  const intervals = [], acknowledgements = [], windows = [];
  const writes = [];
  // 设备码登录过一次且登录态已过期：面板只写得到 token，写不到 tokenExpiresAt/account——
  // 残留的到期时间会让之后手填的有效 token 被判「登录态已过」（复盘 MINOR）
  // 另放一个带设备登录派生字段的无关源：清派生字段只许动 qianwen
  const secretsState = { json: JSON.stringify({ sources: {
    qianwen: { enabled: true, token: "expired", account: "a@example.com", tokenExpiresAt: 1 },
    other: { enabled: true, token: "old", account: "keep@example.com", tokenExpiresAt: 999 } } }) };
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
  const queue = [{ action: "quota-src-key", id: "qianwen", field: "token", value: "manual-token" }];
  windows.push(makeWindow(pathToFileURL(path.join(resources, "app.asar", "out", "renderer", "index.html")).href, queue));
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
      /* 缺 resolveQuotaPaths 时 createQuotaClientInstance 在装配前就抛、quotaClient 恒为 null——
       * 这个桩就成了死桩（复盘 MINOR）：路径函数补齐，客户端才真的被装上 */
      if (id === "./quota-client.cjs") return { resolveQuotaPaths: () => ({ credsPath: '/fixture/home/credentials.json', credsDir: '/fixture/home', customCfgPath: '/fixture/home/provider.json', customCfgDir: '/fixture/home', builtinCfgPath: '/fixture/home/builtin.json', builtinCfgDir: '/fixture/home' }), createQuotaClient: () => ({ tick: () => {}, view: () => ({}), refresh: () => {}, refreshSource: () => {}, noteProvider: () => {}, credentialsChanged: () => {}, noteSnapshotExtras: () => {}, sourcesConfig: () => [], dispose: () => {} }) };
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
  assert.deepEqual(JSON.parse(secretsState.json).sources.qianwen, { enabled: true, token: "manual-token" },
    "手填 token：到期时间与账号一并清掉，开关保留");
  queue.push({ action: "quota-src-key", id: "qianwen", field: "token", value: "" });
  await poll.fn();
  assert.deepEqual(JSON.parse(secretsState.json).sources.qianwen, { enabled: true },
    "清空 token = 退出登录：邮箱与到期时间不留");
  // 其它源不受牵连：只动被写的那个字段，设备登录留下的派生字段原样保留
  queue.push({ action: "quota-src-key", id: "other", field: "token", value: "x" });
  await poll.fn();
  assert.deepEqual(JSON.parse(secretsState.json).sources.other,
    { enabled: true, token: "x", account: "keep@example.com", tokenExpiresAt: 999 }, "派生字段只对 qianwen 清");
});


test('turning the quota switch off cancels an in-flight qianwen sign-in; while off, start is refused and state/cancel still answer', async () => {
  const intervals = [], windows = [], scripts = [], queue = [], cancelled = [], starts = [];
  const cfgState = { json: JSON.stringify({ quota_enabled: true }) };
  const path = require("path");
  const { pathToFileURL } = require("url");
  const resources = "/fixture/resources";
  windows.push({
    getURL: () => pathToFileURL(path.join(resources, "app.asar", "out", "renderer", "index.html")).href,
    isDestroyed: () => false, getType: () => "window", isLoading: () => false, on: () => {},
    executeJavaScript: async (script) => { scripts.push(script); return script.includes("q.splice") ? queue.splice(0, 8) : "null"; },
  });
  const mockFs = {
    readFileSync: (file) => {
      if (String(file).endsWith("config.json")) return cfgState.json;
      if (String(file).endsWith("quota-secrets.json")) throw new Error("ENOENT");
      return "{}";
    },
    statSync: () => ({ mtimeMs: 1, size: 1 }), existsSync: () => true, watch: () => ({ on: () => {}, close: () => {} }),
    writeFileSync: () => {}, renameSync: () => {}, chmodSync: () => {}, unlinkSync: () => {},
  };
  const quotaPaths = { credsPath: '/fixture/home/credentials.json', credsDir: '/fixture/home', customCfgPath: '/fixture/home/provider.json', customCfgDir: '/fixture/home', builtinCfgPath: '/fixture/home/builtin.json', builtinCfgDir: '/fixture/home' };
  const quotaClient = {
    tick: () => {}, view: () => ({ sources: {}, byProvider: {} }), refresh: () => {}, refreshSource: () => true,
    noteProvider: () => {}, credentialsChanged: () => {}, noteSnapshotExtras: () => {}, sourcesConfig: () => [], dispose: () => {},
    qianwenSignInStart: () => { starts.push(1); return new Promise(() => {}); },   // 起流后一直挂着（在途）
    qianwenSignInState: () => ({ ok: true, state: starts.length ? "polling" : "idle" }),
    qianwenSignInCancel: () => { cancelled.push(1); },
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
      if (id === "child_process") return { spawn: () => { throw new Error("no spawn"); }, execFile: (c, a, o, cb) => { cb(null); } };
      if (id === "./plugin-updater.cjs") return { createUpdater: () => ({ status: () => ({}), tick: async () => {}, request: async () => {} }), updateConfig: async () => { cfgState.json = JSON.stringify({ quota_enabled: false }); } };
      if (id === "./quota-client.cjs") return { resolveQuotaPaths: () => quotaPaths, createQuotaClient: () => quotaClient };
      if (id === "electron") return { app: { getPath: () => "/fixture/home", on: () => {} }, webContents: { getAllWebContents: () => windows }, ipcMain: { on: () => {} } };
      throw new Error(id);
    },
  };
  const vm = require("vm");
  const fs = require("fs");
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "inject-main.cjs"), "utf8"), sandbox);
  await new Promise((r) => setImmediate(r));
  const poll = () => intervals.find((i) => i.delay === 1000).fn();
  const settle = async () => { await poll(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };
  /* deliverPluginRequest 的脚本形如 window.__zusagePluginResult && window.__zusagePluginResult({...}) */
  const results = () => scripts.filter((s) => s.includes("__zusagePluginResult")).map((s) => JSON.parse(s.slice(s.indexOf("(", s.indexOf("&&")) + 1, s.lastIndexOf(")"))));
  const last = () => results().at(-1) || null;

  queue.push({ action: "quota-qianwen-signin", requestId: "q1" });
  await settle();
  assert.deepEqual(starts, [1], "开关开着：发起登录");
  queue.push({ action: "quota-qianwen-signin-state", requestId: "q2" });
  await settle();
  assert.deepEqual(last(), { id: "q2", ok: true, state: "polling" });

  queue.push({ action: "quota", enabled: false, requestId: "q3" });
  await settle();
  assert.deepEqual(cancelled, [1], "关额度即取消在途登录（轮询不再打到 t.qianwenai.com、不再落凭据）");
  assert.deepEqual(last(), { id: "q3", ok: true });

  queue.push({ action: "quota-qianwen-signin", requestId: "q4" });
  await settle();
  assert.deepEqual(last(), { id: "q4", ok: false, error: "quota disabled" }, "关闭期间发起被拒");
  assert.deepEqual(starts, [1], "被拒不起新流");
  queue.push({ action: "quota-qianwen-signin-state", requestId: "q5" });
  await settle();
  assert.deepEqual(last(), { id: "q5", ok: true, state: "polling" }, "关闭期间 state 照常应答（设置页轮询靠它收尾）");
  queue.push({ action: "quota-qianwen-signin-cancel", requestId: "q6" });
  await settle();
  assert.deepEqual(cancelled, [1, 1], "关闭期间 cancel 照常应答");
  assert.deepEqual(last(), { id: "q6", ok: true });
});


test('quota source write failures are returned without echoing credential values', async () => {
  const path = require('path');
  const { pathToFileURL } = require('url');
  const resources = '/fixture/resources';
  const requestId = 'zusage-1-2';
  const scripts = [], queue = [{ action: 'quota-src-key', id: 'mimo', field: 'cookie', value: 'userId=secret; serviceToken=private', requestId }];
  const wc = {
    getURL: () => pathToFileURL(path.join(resources, 'app.asar', 'out', 'renderer', 'index.html')).href,
    isDestroyed: () => false, getType: () => 'window', isLoading: () => false, on() {},
    executeJavaScript: async script => { scripts.push(script); return script.includes('q.splice') ? queue.splice(0, 8) : 'null'; },
  };
  const intervals = [], writes = [];
  const mockFs = {
    readFileSync: file => String(file).endsWith('quota-secrets.json') ? (() => { throw Error('ENOENT'); })() : '{}',
    statSync: () => ({ mtimeMs: 1 }), existsSync: () => true, watch: () => ({ on() {} }),
    writeFileSync: (file, data) => { writes.push([String(file), String(data)]); throw Error('disk full'); },
    unlinkSync() {}, renameSync() {}, chmodSync() {},
  };
  const sandbox = {
    __dirname: '/fixture/runtime', console: { error() {} },
    process: { resourcesPath: resources, execPath: process.execPath, uptime: () => 1 },
    setInterval: (fn, delay) => { intervals.push({ fn, delay }); }, setTimeout: () => 1, clearTimeout() {},
    require(id) {
      if (id === 'path') return path;
      if (id === 'fs') return mockFs;
      if (id === 'url') return require('url');
      if (id === 'crypto') return require('crypto');
      if (id === 'child_process') return { spawn() { throw Error('isolated'); }, execFile(c, a, o, cb) { cb(null); } };
      if (id === './plugin-updater.cjs') return { createUpdater: () => ({ status: () => {}, tick: async () => {} }), updateConfig: async () => {} };
      if (id === './quota-client.cjs') return { createQuotaClient: () => ({ view: () => ({}), sourcesConfig: () => [], dispose() {} }) };
      if (id === 'electron') return { app: { getPath: () => '/fixture/home', on() {} }, webContents: { getAllWebContents: () => [wc] }, ipcMain: { on() {} } };
      throw Error(id);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'inject-main.cjs'), 'utf8'), sandbox);
  await new Promise(resolve => setImmediate(resolve));
  await intervals.find(x => x.delay === 1000).fn();
  const resultScript = scripts.find(script => script.includes('__zusagePluginResult'));
  assert.ok(resultScript);
  assert.match(resultScript, /"ok":false/);
  assert.match(resultScript, /"error":"Unable to save quota settings"/);
  assert.doesNotMatch(resultScript, /userId=secret|serviceToken=private/);
  assert.equal(writes.length, 1);
});

test('live quota selections use trusted full-window snapshots and revoke on navigation or close', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'inject-main.cjs'), 'utf8');
  const intervals = [], providerSets = [], windows = [];
  const queues = [[], [], [], []];
  const resources = path.resolve('/fixture/resources');
  const makeWindow = (id, url, queue) => ({
    id, dead: false, listeners: new Map(), scripts: [],
    getURL() { return url; }, getType: () => 'window', isDestroyed() { return this.dead; }, isLoading: () => false,
    on(type, fn) { this.listeners.set(type, fn); },
    async executeJavaScript(script) { this.scripts.push(script); return script.includes('q.splice') ? queue.splice(0, 8) : null; },
  });
  const localUrl = pathToFileURL(path.join(resources, 'app.asar', 'out', 'renderer', 'index.html')).href;
  windows.push(makeWindow(1, localUrl, queues[0]), makeWindow(2, localUrl, queues[1]),
    makeWindow(3, 'https://outside.example/', queues[2]),
    makeWindow(4, pathToFileURL(path.join(resources, '..', 'outside.html')).href, queues[3]));
  const request = (providerId, paneId = 'workspace-main') => ({ action: 'quota-providers', panes: {
    [paneId]: { sid: 'session_fixture', providerId, modelId: 'model-fixture' },
  } });
  const mockFs = {
    readFileSync: file => String(file).endsWith('config.json') ? '{"quota_enabled":true}' : '{}',
    statSync: () => ({ mtimeMs: 1, size: 1 }), existsSync: () => true,
    watch: () => ({ on() {}, close() {} }),
  };
  const sandbox = {
    __dirname: '/fixture/runtime', console: { error() {} },
    process: { resourcesPath: resources, execPath: process.execPath, env: {}, uptime: () => 1 },
    setInterval: (fn, delay) => { intervals.push({ fn, delay }); },
    setTimeout: () => 1, clearTimeout() {}, module: { exports: {} },
    require(id) {
      if (id === 'path') return path;
      if (id === 'fs') return mockFs;
      if (id === 'url') return require('url');
      if (id === 'crypto') return require('crypto');
      if (id === 'child_process') return { spawn() { throw Error('isolated'); }, execFile(c, a, o, cb) { cb(null); } };
      if (id === './plugin-updater.cjs') return { createUpdater: () => ({ status: () => ({}), tick: async () => {} }) };
      if (id === './quota-client.cjs') return { resolveQuotaPaths: () => ({ credsPath: '/fixture/home/credentials.json', credsDir: '/fixture/home', customCfgPath: '/fixture/home/provider.json', customCfgDir: '/fixture/home', builtinCfgPath: '/fixture/home/builtin.json', builtinCfgDir: '/fixture/home' }), createQuotaClient: () => ({
        setProviders(ids) { providerSets.push(Array.from(ids).sort()); }, tick() {}, view: () => ({ sources: {}, byProvider: {} }),
        sourcesConfig: () => [], noteSnapshotExtras() {}, dispose() {},
      }) };
      if (id === 'electron') return { app: { getPath: () => '/fixture/home', on() {} },
        webContents: { getAllWebContents: () => windows }, ipcMain: { on() {} } };
      throw Error(id);
    },
  };
  vm.runInNewContext(source, sandbox);
  await new Promise(resolve => setImmediate(resolve));
  const poll = intervals.find(t => t.delay === 1000).fn;
  queues[0].push(request('account:bigmodel-individual-coding-plan'));
  queues[1].push(request('relay-b'));
  queues[2].push(request('outside-web'));
  queues[3].push(request('outside-file'));
  await poll();
  assert.deepEqual(providerSets.at(-1), ['account:bigmodel-individual-coding-plan', 'relay-b']);
  const api = sandbox.module.exports.__zusageTest;
  api.handlePayload({ session: { last: { provider_id: 'old-global-provider' } }, recent: [] });
  assert.deepEqual(providerSets.at(-1), ['account:bigmodel-individual-coding-plan', 'relay-b'], 'DB global provider cannot override current pane selections');
  queues[0].push({ action: 'quota-providers', panes: {} });
  await poll();
  assert.deepEqual(providerSets.at(-1), ['relay-b'], 'empty map revokes the departed window selection');
  windows[1].listeners.get('did-start-navigation')({}, 'file:///next', false, true);
  assert.deepEqual(providerSets.at(-1), [], 'navigating the last selected window does not revive global history');
  queues[0].push(request('relay-a'));
  queues[1].push(request('relay-b'));
  await poll();
  windows[1].dead = true;
  windows[1].listeners.get('destroyed')();
  assert.deepEqual(providerSets.at(-1), ['relay-a'], 'closing one window preserves only the live window provider');
  queues[0].push(request('forged', '../escape'));
  await poll();
  assert.deepEqual(providerSets.at(-1), ['relay-a'], 'invalid full snapshot cannot overwrite accepted state');
  assert.equal(queues[2].length, 1);
  assert.equal(queues[3].length, 1, 'untrusted pages cannot submit provider lookup requests');
});
