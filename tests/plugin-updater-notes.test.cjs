"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createUpdater, PLUGIN_ID } = require("../plugin-updater.cjs");

/* 更新日志（v202）状态供给测试：markerVersion / channelRepo / lastFailure 的产生、
 * 持久化与清除。fixture 模式与 plugin-updater.test.cjs 同款（依赖注入 cli/sync/notify）。 */
function fixture(t, { settings = {}, marketSource = null, fetchRelease = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-notes-upd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = path.join(dir, "runtime");
  const inventory = path.join(dir, ".zcode", "cli", "plugins");
  fs.mkdirSync(runtime);
  fs.mkdirSync(inventory, { recursive: true });
  const recordFile = path.join(inventory, "installed_plugins.json");
  fs.writeFileSync(path.join(runtime, "config.json"), JSON.stringify({ python_path: "python3", plugin_auto_update: false, ...settings }));
  const record = { id: PLUGIN_ID, version: "1.0.0", scope: "user", installPath: path.join(dir, "installed") };
  const writeRecord = () => fs.writeFileSync(recordFile, JSON.stringify({ version: 1, plugins: [record] }));
  writeRecord();
  fs.writeFileSync(path.join(inventory, "known_marketplaces.json"), JSON.stringify({ marketplaces: [
    marketSource || { id: "zusage-marketplace", source: { source: "directory", path: dir } },
  ] }));
  const calls = [], states = [];
  let version = "1.1.0", updateError = null;
  const cli = async (args) => {
    calls.push(args);
    if (args[0] === "marketplace") return { diagnostics: [] };
    if (args[0] === "list" && !args.includes("--available")) return [{ id: PLUGIN_ID, version: record.version, enabled: true, diagnostics: [] }];
    if (args[0] === "list") return { installed: [{ id: PLUGIN_ID, version: record.version, enabled: true }], available: [{ id: PLUGIN_ID, version }], diagnostics: [] };
    if (args[0] === "update") {
      if (updateError) throw new Error(updateError);
      record.version = version;
      writeRecord();
      return { ok: true, version, diagnostics: [] };
    }
    if (args[0] === "install") {
      if (updateError) throw new Error(updateError);
      record.version = version;
      writeRecord();
      return { ok: true, version, diagnostics: [] };
    }
    throw new Error("Unexpected CLI command");
  };
  const options = { runtime, home: dir, resourcesPath: dir, executable: process.execPath, now: () => 100000000,
    cli, sync: async () => ({ changed: ["overlay.js"], skipped: [], preserved: [] }),
    notify: (s) => states.push(s), ...(fetchRelease ? { fetchRelease } : {}) };
  const stateFile = path.join(runtime, "plugin-update.json");
  return { updater: createUpdater(options), options, runtime, stateFile, calls, states, record, writeRecord,
    set: (v) => { if ("version" in v) version = v.version; if ("updateError" in v) updateError = v.updateError; } };
}

test("marker version exposes the actually installed target while restart is pending", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.runtime, ".plugin-restart-required"), JSON.stringify({ version: "1.2.0", hashes: { "inject-main.cjs": "x" }, changed: ["inject-main.cjs"], createdAt: 1 }));
  const u = createUpdater(f.options);
  assert.equal(u.status().restartRequired, true);
  assert.equal(u.status().markerVersion, "1.2.0");
  fs.writeFileSync(path.join(f.runtime, ".plugin-restart-required"), JSON.stringify({ version: "junk", hashes: {} }));
  const bad = createUpdater(f.options);
  assert.equal(bad.status().restartRequired, true);
  assert.equal(bad.status().markerVersion, "");   // 损坏 marker 不冒充可用身份
  fs.rmSync(path.join(f.runtime, ".plugin-restart-required"));
  assert.equal(createUpdater(f.options).status().markerVersion, "");
});

test("market install failure keeps the failed target, persists it and never fakes success", async (t) => {
  const f = fixture(t);
  f.set({ updateError: "installer crashed" });
  await f.updater.request({ action: "update" });
  assert.equal(f.updater.status().phase, "error");
  const failure = f.updater.status().lastFailure;
  assert.equal(failure.version, "1.1.0");   // 目标 = latestVersion（市场渠道无 Release 对象）
  assert.equal(failure.channel, "market");
  assert.equal(failure.at, 100000000);
  const saved = JSON.parse(fs.readFileSync(f.stateFile, "utf8"));
  assert.equal(saved.lastFailure.version, "1.1.0");   // plugin-update.json 持久化，重启后仍在
  const revived = createUpdater(f.options);
  assert.equal(revived.status().lastFailure.version, "1.1.0");
});

test("a later successful install clears the failure record", async (t) => {
  const f = fixture(t);
  f.set({ updateError: "installer crashed" });
  await f.updater.request({ action: "update" });
  assert.equal(f.updater.status().lastFailure.version, "1.1.0");
  f.set({ updateError: null });
  await f.updater.request({ action: "update" });
  assert.equal(f.updater.status().phase, "updated");
  assert.equal(f.updater.status().lastFailure, null);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile, "utf8")).lastFailure, null);
});

test("catching up to the failed version clears the stale failure label on check", async (t) => {
  const f = fixture(t);
  f.set({ updateError: "installer crashed" });
  await f.updater.request({ action: "update" });
  assert.equal(f.updater.status().lastFailure.version, "1.1.0");
  f.set({ version: "1.0.0" });   // 市场可装版本退回，安装记录升到 1.1.0（模拟手动装好）
  f.record.version = "1.1.0";
  f.writeRecord();
  await f.updater.request({ action: "check" });
  assert.equal(f.updater.status().phase, "current");
  assert.equal(f.updater.status().lastFailure, null);
});

test("readState drops malformed failure records instead of trusting them", (t) => {
  const f = fixture(t);
  const cases = [null, "x", 5, [], { version: "bad" }, { version: "1.0.0" }, { version: "1.0.0", at: 99 },
    { version: "1.0.0", at: 100000000, channel: "local" }, { version: "1.0.0", at: 200000000, channel: "release" }];
  for (const lastFailure of cases) {
    fs.writeFileSync(f.stateFile, JSON.stringify({ lastFailure }));
    assert.equal(createUpdater(f.options).status().lastFailure, null, JSON.stringify(lastFailure));
  }
  fs.writeFileSync(f.stateFile, JSON.stringify({ lastFailure: { version: "1.0.0", at: 100000000, channel: "release", extra: 1 } }));
  assert.deepEqual(createUpdater(f.options).status().lastFailure, { version: "1.0.0", at: 100000000, channel: "release" });
});

test("release channel check exposes the registered repository even when the API fails", async (t) => {
  const f = fixture(t, {
    marketSource: { id: "zusage-marketplace", source: { source: "github", repo: "ByteRax/zcode-token-usage-statusbar" } },
    fetchRelease: async () => Buffer.from("[]"),   // 无正式 Release：渠道健康信号，直接报错不兜底
  });
  await f.updater.request({ action: "check" });
  const s = f.updater.status();
  assert.equal(s.channel, "release");
  assert.equal(s.channelHost, "github");
  assert.equal(s.channelRepo, "ByteRax/zcode-token-usage-statusbar");
});

test("local directory channel reports an empty repository for the notes card", async (t) => {
  const f = fixture(t);
  await f.updater.request({ action: "check" });
  const s = f.updater.status();
  assert.equal(s.channel, "local");
  assert.equal(s.channelRepo, "");
});

test("uninstall-type cancellations are not recorded as install failures", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-notes-cancel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = path.join(dir, "runtime"), inventory = path.join(dir, ".zcode", "cli", "plugins");
  fs.mkdirSync(runtime);
  fs.mkdirSync(inventory, { recursive: true });
  const recordFile = path.join(inventory, "installed_plugins.json");
  const record = { id: PLUGIN_ID, version: "1.0.0", scope: "user", installPath: path.join(dir, "installed") };
  const writeRecord = () => fs.writeFileSync(recordFile, JSON.stringify({ version: 1, plugins: [record] }));
  writeRecord();
  fs.writeFileSync(path.join(inventory, "known_marketplaces.json"), JSON.stringify({ marketplaces: [
    { id: "zusage-marketplace", source: { source: "directory", path: dir } },
  ] }));
  fs.writeFileSync(path.join(runtime, "config.json"), JSON.stringify({ plugin_auto_update: false }));
  const cli = async (args) => {
    if (args[0] === "marketplace") return { diagnostics: [] };
    if (args[0] === "list" && !args.includes("--available")) return [{ id: PLUGIN_ID, version: record.version, enabled: true, diagnostics: [] }];
    if (args[0] === "list") {
      if (args.includes("--available")) fs.rmSync(recordFile);   // 检查通过后、安装开始前插件被卸载
      return { installed: [{ id: PLUGIN_ID, version: record.version, enabled: true }], available: [{ id: PLUGIN_ID, version: "1.1.0" }], diagnostics: [] };
    }
    throw new Error("unexpected " + args.join(" "));
  };
  const u = createUpdater({ runtime, home: dir, resourcesPath: dir, executable: process.execPath, now: () => 1000,
    cli, sync: async () => ({ changed: [], skipped: [], preserved: [] }), notify: () => { } });
  await u.request({ action: "update" });
  assert.equal(u.status().phase, "error");
  assert.match(u.status().error, /已卸载/);
  assert.equal(u.status().lastFailure, null);   // 卸载类取消 ≠ 目标版本安装失败
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtime, "plugin-update.json"), "utf8")).lastFailure, null);
});
