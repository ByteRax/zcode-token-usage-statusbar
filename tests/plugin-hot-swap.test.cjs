"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const { pathToFileURL } = require("url");
// v258：主进程子模块热替换循环（G3）。整源码 vm 装配 + 六模块桩，经 __zusageTest
// 接缝驱动 hotReloadMainModules：mtime 检测 / 语法预检跳过 / busy 顺延 / dispose+重建
// 依赖联动 / loadedHashes._hotLoadedAt 销账载荷 / acknowledgeRestart。
const source = fs.readFileSync(path.join(__dirname, "..", "inject-main.cjs"), "utf8");
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

function harness() {
  const mtimes = {}, contents = {};
  for (const name of ["inject-main.cjs", "plugin-updater.cjs", "plugin-release.cjs", "plugin-storage.cjs",
    "quota-client.cjs", "model-puller.cjs", "engine-patch.cjs", "overlay.js", "zusage.py", "token_pricing.py"]) {
    mtimes[name] = 1000;
    contents[path.join("/fixture/runtime", name)] = "{}";
  }
  const acks = [], intervals = [];
  let quotaInstances = 0, modelInstances = 0, notesInstances = 0, engineSyncs = 0, updaterInstances = 0;
  let updaterBusy = false;
  let capturedUpdaterOpts = null, capturedDecrypt = null, disposedQuota = 0, setProvidersCalls = [];
  const resources = path.resolve("/fixture/resources");
  const makeQuotaInstance = () => ({
    id: ++quotaInstances,
    dispose: () => { disposedQuota += 1; },
    view: () => ({}), sourcesConfig: () => [], tick: async () => {}, refresh: async () => {},
    refreshSource: async () => {}, noteProvider: () => {}, setProviders: (ids) => setProvidersCalls.push(ids),
    credentialsChanged: () => {}, noteSnapshotExtras: () => {},
  });
  const sandbox = {
    __dirname: "/fixture/runtime", console: { error: () => {} },
    process: { resourcesPath: resources, execPath: process.execPath, uptime: () => 1, platform: "darwin", env: {} },
    setInterval: (fn, delay) => { intervals.push({ fn, delay }); return delay; },
    setTimeout: () => 1, clearTimeout: () => {},
    module: { exports: {} },
    require: (id) => {
      if (id === "path") return path;
      if (id === "fs") return {
        statSync: (file) => {
          const base = path.basename(String(file));
          if (!(String(file) in mtimes) && !(base in mtimes)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          return { mtimeMs: mtimes[String(file)] ?? mtimes[base] ?? 1 };
        },
        readFileSync: (file) => {
          if (String(file) in contents) return contents[String(file)];
          if (path.basename(String(file)) === "setting.json") return "{}";
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
        existsSync: () => true, watch: () => ({ on: () => {} }), writeFileSync: () => {},
        renameSync: () => {}, unlinkSync: () => {},
      };
      if (id === "url") return require("url");
      if (id === "crypto") return require("crypto");
      if (id === "child_process") return {
        spawn: () => { throw new Error("Query must not run"); },
        execFile: (command, args, options, callback) => { acks.push({ command, args }); callback(null); },
      };
      if (id === "./plugin-updater.cjs") return { createUpdater: (opts) => {
        capturedUpdaterOpts = opts; updaterInstances += 1; opts.notify({});
        return { request: async () => {}, tick: async () => {}, status: () => ({ busy: updaterBusy }), noteRuntimeAcked: () => {} };
      } };
      if (id === "./engine-patch.cjs") return { createEnginePatcher: () => ({
        syncStartup: () => { engineSyncs += 1; }, status: () => ({}), ensure: () => {}, restore: () => {},
        readConfig: () => ({}), writeConfig: () => {}, configPath: "/fixture/runtime/engine-patch.json" }) };
      if (id === "./quota-client.cjs") return {
        createQuotaClient: () => makeQuotaInstance(),
        resolveQuotaPaths: () => ({ credsPath: "/q/credentials.json", credsDir: "/q/creds",
          customCfgPath: "", customCfgDir: "/q/custom", builtinCfgPath: "", builtinCfgDir: "/q/builtin" }),
        decryptValue: () => "plain", deriveCipherKey: () => "key",
      };
      if (id === "./model-puller.cjs") return { createModelPuller: (opts) => {
        capturedDecrypt = opts.decryptValue; modelInstances += 1;
        return { listProviders: () => [], fetchModels: async () => ({}), applyModels: async () => ({}) };
      } };
      if (id === "./plugin-release.cjs") return {
        createNotesService: () => ({ id: ++notesInstances, getNotes: async () => ({}), getList: async () => ({}) }),
        createNotesCache: () => ({}), readChannel: () => null,
      };
      if (id === "./plugin-storage.cjs") return { resolvePluginStorage: () => "/fixture/storage" };
      if (id === "electron") return { app: { getPath: () => "/fixture/home", on: () => {}, getVersion: () => "3.17.2" },
        webContents: { getAllWebContents: () => [] }, ipcMain: { on: () => {} } };
      throw new Error("unexpected require: " + id);
    },
  };
  vm.runInNewContext(source, sandbox);
  const seam = sandbox.module.exports.__zusageTest;
  assert.ok(seam && typeof seam.hotReloadMainModules === "function");
  return {
    sandbox, seam, acks, intervals, mtimes, contents,
    counters: { get quota() { return quotaInstances; }, get model() { return modelInstances; },
      get notes() { return notesInstances; }, get engineSyncs() { return engineSyncs; }, get updater() { return updaterInstances; } },
    state: {
      get disposedQuota() { return disposedQuota; }, get setProvidersCalls() { return setProvidersCalls; },
      get updaterOpts() { return capturedUpdaterOpts; }, get decrypt() { return capturedDecrypt; },
      get updaterBusy() { return updaterBusy; }, set updaterBusy(v) { updaterBusy = v; },
    },
  };
}
const MOD = (n) => path.join("/fixture/runtime", n);

test("cold boot builds the mtime table and passes onRuntimeSynced to the updater", async () => {
  const h = harness();
  assert.equal(Object.keys(h.seam.hotModuleState().mtimes).length, 6);
  assert.equal(h.counters.quota, 1);
  assert.equal(h.counters.model, 1);
  assert.equal(h.counters.engineSyncs, 1);
  assert.equal(typeof h.state.updaterOpts.onRuntimeSynced, "function");
});

test("mtime change swaps quota-client and model-puller, records _hotLoadedAt and acks", async () => {
  const h = harness();
  const qcSrc = "module.exports = { v: 2 };";
  h.mtimes["quota-client.cjs"] = 2000;
  h.mtimes["model-puller.cjs"] = 2000;
  h.contents[MOD("quota-client.cjs")] = qcSrc;
  h.contents[MOD("model-puller.cjs")] = "module.exports = { v: 3 };";
  const beforeAcks = h.acks.length;
  const changed = await h.seam.hotReloadMainModules();
  assert.equal(changed, true);
  assert.equal(h.state.disposedQuota, 1);              // 旧实例 dispose
  assert.equal(h.counters.quota, 2);                   // 新实例
  assert.equal(h.counters.model, 2);                   // decryptValue 注入联动重建
  assert.notEqual(h.state.decrypt, null);
  assert.deepEqual([...h.state.setProvidersCalls.pop(), ""].slice(0, 1), [""]);   // syncQuotaProviders 重绑（空窗集合）
  const state = h.seam.hotModuleState();
  assert.equal(state.mtimes["quota-client.cjs"], 2000);
  assert.equal(state.hashes["quota-client.cjs"], sha256(qcSrc));
  assert.equal(typeof state.hashes._hotLoadedAt["quota-client.cjs"], "number");
  assert.equal(typeof state.hashes._hotLoadedAt["model-puller.cjs"], "number");
  assert.equal(h.acks.length, beforeAcks + 1);         // acknowledgeRestart 已带新指纹销账
  const loaded = JSON.parse(h.acks[h.acks.length - 1].args[3]);
  assert.equal(loaded["quota-client.cjs"], sha256(qcSrc));
  assert.ok(loaded._hotLoadedAt["quota-client.cjs"] >= Date.now() - 60000);
});

test("unreadable or invalid sources skip the round and keep old instances", async () => {
  const h = harness();
  h.mtimes["quota-client.cjs"] = 2000;
  h.contents[MOD("quota-client.cjs")] = "module.exports = (((";   // 语法错误
  assert.equal(await h.seam.hotReloadMainModules(), false);
  assert.equal(h.counters.quota, 1);
  assert.equal(h.seam.hotModuleState().mtimes["quota-client.cjs"], 1000);   // 旧 mtime 保留 → 下轮重试
  h.contents[MOD("quota-client.cjs")] = "module.exports = { v: 9 };";
  assert.equal(await h.seam.hotReloadMainModules(), true);
  assert.equal(h.counters.quota, 2);
});

test("updater group defers while an update is in flight and swaps once idle", async () => {
  const h = harness();
  h.state.updaterBusy = true;
  h.mtimes["plugin-updater.cjs"] = 2000;
  h.contents[MOD("plugin-updater.cjs")] = "module.exports = { v: 5 };";
  assert.equal(await h.seam.hotReloadMainModules(), false);
  assert.equal(h.counters.updater, 1);
  assert.equal(h.seam.hotModuleState().mtimes["plugin-updater.cjs"], 1000);
  h.state.updaterBusy = false;
  assert.equal(await h.seam.hotReloadMainModules(), true);
  assert.equal(h.counters.updater, 2);
  assert.equal(h.counters.notes, 2);                   // updater 组变更联动重建 notes
  assert.equal(h.seam.hotModuleState().mtimes["plugin-updater.cjs"], 2000);
});

test("engine-patch hot swap re-runs the idempotent startup sync only", async () => {
  const h = harness();
  h.mtimes["engine-patch.cjs"] = 2000;
  h.contents[MOD("engine-patch.cjs")] = "module.exports = { v: 6 };";
  const before = h.counters.engineSyncs;
  assert.equal(await h.seam.hotReloadMainModules(), true);
  assert.equal(h.counters.engineSyncs, before + 1);    // syncStartup 幂等重跑（stub 计数即证据）
});

test("no mtime change is a no-op without touching instances", async () => {
  const h = harness();
  const before = h.acks.length;
  assert.equal(await h.seam.hotReloadMainModules(), false);
  assert.equal(h.acks.length, before);
  assert.equal(h.counters.quota, 1);
});
