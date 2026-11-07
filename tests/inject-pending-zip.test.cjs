"use strict";
/* v228 pending 更新包预注入触发链回归：候选筛选（版本/文件名/update-info.json 一致性）、
 * 配置与平台门控、spawn 参数、失败退避、before-quit 清理。
 * 切片加载 inject-main.cjs 的 v228 段；fs 走真实临时目录（home 指向沙箱根），仅
 * app-update.yml 由 stub 提供 updaterCacheDirName。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const { getInjectSlice } = require("./helpers/overlay-extract.cjs");
const SEGMENT = getInjectSlice("pendingZipBlock");

function harness({ platform = "darwin", cfg = {}, version = "3.17.2" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-pendingzip-"));
  const pending = path.join(root, "Library", "Caches", "test-updater", "pending");
  fs.mkdirSync(pending, { recursive: true });
  const spawns = [], intervals = [], logs = [];
  let timerId = 0;
  const timers = new Map();
  const realFs = fs;
  const fakeFs = {
    readFileSync: (file, opts) => String(file).endsWith("app-update.yml")
      ? "updaterCacheDirName: 'test-updater'\nprovider: generic\n"
      : realFs.readFileSync(file, opts),
    existsSync: (file) => realFs.existsSync(file),
    readdirSync: (dir) => realFs.readdirSync(dir),
    watch: (dir, cb) => {
      const watcher = realFs.watch(dir, cb);
      watchers.push(watcher);
      return watcher;
    },
    statSync: (file) => realFs.statSync(file),
  };
  const watchers = [];
  const spawn = (bin, args, opts) => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.stdin = { write: () => {} };
    p.bin = bin; p.args = args; p.opts = opts;
    spawns.push(p);
    return p;
  };
  const sandbox = vm.createContext({
    __dirname: path.join(root, "runtime"),
    console: { error: (...a) => logs.push(a.join(" ")) },
    LOG: (...a) => logs.push(a.join(" ")),
    process: { platform, resourcesPath: path.join(root, "resources"), uptime: () => 1 },
    spawn,
    fs: fakeFs,
    path,
    app: { getPath: () => root, getVersion: () => version },
    readCfg: () => ({ python_path: "python3", ...cfg }),
    readCfgCached: () => ({ python_path: "python3", ...cfg }),
    HERE: path.join(root, "runtime"),
    shuttingDown: false,
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: (n) => timers.delete(n),
    setInterval: (fn, ms) => { intervals.push({ fn, ms, id: ++timerId }); return timerId; },
    clearInterval: (n) => { const i = intervals.findIndex((t) => t.id === n); if (i >= 0) intervals.splice(i, 1); },
  });
  vm.runInContext(SEGMENT, sandbox);
  return {
    root, pending, spawns, intervals, logs, sandbox,
    settle: async (code) => { const p = spawns[spawns.length - 1]; p.stdout.emit("data", "ok"); p.emit("close", code); await new Promise((r) => setImmediate(r)); },
    cleanup: () => {
      for (const w of watchers) { try { w.close(); } catch (e) { } }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function stageUpdate(h, { name = "ZCode-3.18.0-mac-arm64.zip", infoName = null } = {}) {
  fs.writeFileSync(path.join(h.pending, name), "zip-bytes");
  fs.writeFileSync(path.join(h.pending, "update-info.json"),
    JSON.stringify({ fileName: infoName === null ? name : infoName, sha512: "x" }));
}
const patchArgs = (h, spawnRecord) => ({
  script: spawnRecord.args[0],
  zip: spawnRecord.args[2],
  asar: spawnRecord.args[4],
  runtime: spawnRecord.args[6],
});

test("darwin pending zip with a newer version spawns the patcher with explicit paths", async () => {
  const h = harness();
  try {
    stageUpdate(h);
    fs.mkdirSync(path.join(h.root, "resources"), { recursive: true });
    fs.writeFileSync(path.join(h.root, "resources", "app.asar"), "asar");
    const tick = h.intervals.find((i) => i.ms === 60000);
    assert.ok(tick, "60s fallback poll registered");
    await tick.fn();
    assert.equal(h.spawns.length, 1);
    const p = h.spawns[0];
    assert.match(p.bin, /python3$/);
    const a = patchArgs(h, p);
    assert.equal(a.script, path.join(h.sandbox.HERE, "pending_zip_patch.py"));
    assert.equal(a.zip, path.join(h.pending, "ZCode-3.18.0-mac-arm64.zip"));
    assert.equal(a.asar, path.join(h.root, "resources", "app.asar"));
    assert.equal(a.runtime, h.sandbox.HERE);
    await h.settle(0);
    assert.ok(h.logs.some((l) => l.includes("pending update zip patched")));
  } finally { h.cleanup(); }
});

test("candidate gating: running version, stale info, dmg and wrong arch layout", async () => {
  const h = harness({ version: "3.17.2" });
  try {
    // resources/app.asar 必须先就位：existsSync 守卫先于候选判定，缺失会屏蔽全部用例
    fs.mkdirSync(path.join(h.root, "resources"), { recursive: true });
    fs.writeFileSync(path.join(h.root, "resources", "app.asar"), "asar");
    stageUpdate(h, { name: "ZCode-3.17.2-mac-arm64.zip" });   // 当前版本：残留缓存留给差量
    await h.intervals.find((i) => i.ms === 60000).fn();
    assert.equal(h.spawns.length, 0);
    stageUpdate(h, { name: "ZCode-3.18.0-mac-arm64.zip", infoName: "ZCode-3.19.0-mac-arm64.zip" });
    await h.intervals.find((i) => i.ms === 60000).fn();
    assert.equal(h.spawns.length, 0);   // update-info.json 指向别的包：陈旧缓存不打
    stageUpdate(h, { name: "ZCode-3.18.0-mac-x64.zip", infoName: "ZCode-3.18.0-mac-x64.zip" });
    fs.writeFileSync(path.join(h.pending, "installer.dmg"), "dmg");
    await h.intervals.find((i) => i.ms === 60000).fn();
    // dmg 无候选名不选；arm64 zip 因 update-info.json 已指向 x64 包被过滤；x64 匹配即 spawn
    assert.equal(h.spawns.length, 1);
    assert.equal(path.basename(h.spawns[0].args[2]), "ZCode-3.18.0-mac-x64.zip");
  } finally { h.cleanup(); }
});

test("x64 candidates are patched the same way on x64 hosts", async () => {
  const h = harness({ version: "3.17.2" });
  try {
    fs.mkdirSync(path.join(h.root, "resources"), { recursive: true });
    fs.writeFileSync(path.join(h.root, "resources", "app.asar"), "asar");
    stageUpdate(h, { name: "ZCode-3.18.0-mac-x64.zip" });
    await h.intervals.find((i) => i.ms === 60000).fn();
    assert.equal(h.spawns.length, 1, "x64 zip with matching info must spawn");
    assert.equal(h.spawns[0].args[2], path.join(h.pending, "ZCode-3.18.0-mac-x64.zip"));
  } finally { h.cleanup(); }
});

test("pending_zip_patch:false and non-darwin register no watcher and never spawn", async () => {
  for (const opts of [{ cfg: { pending_zip_patch: false } }, { platform: "win32" }]) {
    const h = harness(opts);
    try {
      stageUpdate(h);
      fs.mkdirSync(path.join(h.root, "resources"), { recursive: true });
      fs.writeFileSync(path.join(h.root, "resources", "app.asar"), "asar");
      assert.equal(h.intervals.length, 0);
      assert.equal(h.spawns.length, 0);
    } finally { h.cleanup(); }
  }
});

test("three consecutive failures back off for ten minutes, success resets the counter", async () => {
  const h = harness();
  try {
    stageUpdate(h);
    fs.mkdirSync(path.join(h.root, "resources"), { recursive: true });
    fs.writeFileSync(path.join(h.root, "resources", "app.asar"), "asar");
    const tick = () => h.intervals.find((i) => i.ms === 60000).fn();
    await tick(); await h.settle(1);
    await tick(); await h.settle(1);
    await tick(); await h.settle(1);
    assert.equal(h.spawns.length, 3);
    await tick();
    assert.equal(h.spawns.length, 3);   // 退避中：不 spawn
    // 退避过期：vm context 的 Date 是独立 realm，mock 外层 Date.now 无效；
    // 直接把段内 lastFailAt 拨回 11 分钟前
    vm.runInContext("pendingZipLastFailAt = Date.now() - 601000", h.sandbox);
    await tick();
    assert.equal(h.spawns.length, 4);
    await h.settle(0);
    await tick();
    assert.equal(h.spawns.length, 5);   // 成功后计数清零：连续触发不再退避
  } finally { h.cleanup(); }
});

test("shuttingDown gates the fallback poll (before-quit cleanup is asserted in inject-main-lifecycle)", async () => {
  const h = harness();
  try {
    stageUpdate(h);
    const watcherCount = h.intervals.length;
    assert.equal(watcherCount, 1);
    h.sandbox.shuttingDown = true;
    await h.intervals[0].fn();
    assert.equal(h.spawns.length, 0);   // shuttingDown 后兜底轮询不再 spawn
  } finally { h.cleanup(); }
});
