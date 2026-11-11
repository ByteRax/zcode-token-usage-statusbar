"use strict";
/* v339 pending 更新包清理触发链回归（issue #298：预注入改写废除，反转为清理自愈）：
 * 候选来自运行目录账本 pending-zip-patch.json 且 zip 仍在 pending 目录、路径穿越拒绝、
 * 清理恒开（pending_zip_patch:false 不再跳过）、平台门控、spawn 参数、失败退避、
 * before-quit 清理。切片加载 inject-main.cjs 段；fs 走真实临时目录（home 指向沙箱根），
 * 仅 app-update.yml 由 stub 提供 updaterCacheDirName。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const { getInjectSlice } = require("./helpers/overlay-extract.cjs");
const SEGMENT = getInjectSlice("pendingZipBlock");

function harness({ platform = "darwin", cfg = {}, version = "3.18.0" } = {}) {
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

function stageRecord(h, name = "ZCode-3.18.0-mac-arm64.zip", { withZip = true } = {}) {
  const state = { version: 1, files: {} };
  state.files[name] = { sha256: "a".repeat(64), patchedAt: 1, asarVersion: "3.18.0", runtime: h.sandbox.HERE };
  fs.mkdirSync(h.sandbox.HERE, { recursive: true });
  fs.writeFileSync(path.join(h.sandbox.HERE, "pending-zip-patch.json"), JSON.stringify(state));
  if (withZip) fs.writeFileSync(path.join(h.pending, name), "zip-bytes");
  return name;
}
const spawnArgs = (h, spawnRecord) => ({
  script: spawnRecord.args[0],
  zip: spawnRecord.args[2],
  runtime: spawnRecord.args[4],
});

test("recorded zip still in pending spawns the cleaner with explicit paths", async () => {
  const h = harness();
  try {
    const name = stageRecord(h);
    const tick = h.intervals.find((i) => i.ms === 60000);
    assert.ok(tick, "60s fallback poll registered");
    await tick.fn();
    assert.equal(h.spawns.length, 1);
    const p = h.spawns[0];
    assert.match(p.bin, /python3$/);
    const a = spawnArgs(h, p);
    assert.equal(a.script, path.join(h.sandbox.HERE, "pending_zip_patch.py"));
    assert.equal(a.zip, path.join(h.pending, name));
    assert.equal(a.runtime, h.sandbox.HERE);
    assert.ok(!p.args.includes("--asar"), "清理链不再需要 --asar");
    await h.settle(0);
    assert.ok(h.logs.some((l) => l.includes("pending update zip cleanup")));
  } finally { h.cleanup(); }
});

test("no record or missing zip spawns nothing", async () => {
  const h = harness();
  try {
    await h.intervals.find((i) => i.ms === 60000).fn();
    assert.equal(h.spawns.length, 0, "无账本不 spawn");
    fs.writeFileSync(path.join(h.pending, "ZCode-3.19.0-mac-arm64.zip"), "official");
    fs.writeFileSync(path.join(h.pending, "update-info.json"), JSON.stringify({ fileName: "ZCode-3.19.0-mac-arm64.zip" }));
    await h.intervals.find((i) => i.ms === 60000).fn();
    assert.equal(h.spawns.length, 0, "官方字节 zip 没有账本记录，绝不被触碰");
    stageRecord(h, "ZCode-3.18.0-mac-arm64.zip", { withZip: false });
    await h.intervals.find((i) => i.ms === 60000).fn();
    assert.equal(h.spawns.length, 0, "账本条目指向的 zip 已被宿主清掉：留给 python 按需清账本，Node 端不空转");
  } finally { h.cleanup(); }
});

test("record names with path separators never resolve outside pending", async () => {
  const h = harness();
  try {
    const state = { version: 1, files: {} };
    state.files["../escape.zip"] = { sha256: "a".repeat(64), patchedAt: 1, runtime: h.sandbox.HERE };
    fs.mkdirSync(h.sandbox.HERE, { recursive: true });
    fs.writeFileSync(path.join(h.sandbox.HERE, "pending-zip-patch.json"), JSON.stringify(state));
    fs.writeFileSync(path.join(h.root, "escape.zip"), "outside");
    await h.intervals.find((i) => i.ms === 60000).fn();
    assert.equal(h.spawns.length, 0);
  } finally { h.cleanup(); }
});

test("cleanup stays on with pending_zip_patch:false; non-darwin registers nothing", async () => {
  const h = harness({ cfg: { pending_zip_patch: false } });
  try {
    stageRecord(h);
    assert.equal(h.intervals.length, 1, "清理自愈恒开：显式 false 不再跳过注册");
    await h.intervals.find((i) => i.ms === 60000).fn();
    assert.equal(h.spawns.length, 1);
  } finally { h.cleanup(); }
  const w = harness({ platform: "win32" });
  try {
    stageRecord(w);
    assert.equal(w.intervals.length, 0);
    assert.equal(w.spawns.length, 0);
  } finally { w.cleanup(); }
});

test("three consecutive failures back off for ten minutes, success resets the counter", async () => {
  const h = harness();
  try {
    stageRecord(h);
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
    stageRecord(h);
    assert.equal(h.intervals.length, 1);
    h.sandbox.shuttingDown = true;
    await h.intervals[0].fn();
    assert.equal(h.spawns.length, 0);   // shuttingDown 后兜底轮询不再 spawn
  } finally { h.cleanup(); }
});
