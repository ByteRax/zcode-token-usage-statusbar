"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { cliExecutable, createUpdater, compareVersions, INTERVAL_MS, PLUGIN_ID, listOverview, runAutoCommand } = require("../plugin-updater.cjs");

function fixture(t, settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-update-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = path.join(dir, "runtime");
  const inventory = path.join(dir, ".zcode", "cli", "plugins");
  fs.mkdirSync(runtime); fs.mkdirSync(inventory, { recursive: true });
  const recordFile = path.join(inventory, "installed_plugins.json");
  const configFile = path.join(runtime, "config.json");
  fs.writeFileSync(configFile, JSON.stringify({ python_path: "python3", lang: "en", remote: { enabled: false }, ...settings }));
  const record = { id: PLUGIN_ID, version: "1.0.0", scope: "user", installPath: path.join(dir, "installed") };
  const writeRecord = () => fs.writeFileSync(recordFile, JSON.stringify({ version: 1, plugins: [record] }));
  writeRecord();
  fs.writeFileSync(path.join(inventory, "known_marketplaces.json"), JSON.stringify({ marketplaces: [
    { id: "zusage-marketplace", source: { source: "directory", path: dir } },
  ] }));
  const calls = [], states = [], syncs = [];
  let time = 100000000, version = "1.1.0", enabled = true, error = null, missing = false, changed = [], skipped = [];
  const cli = async (args) => {
    calls.push(args);
    if (error) throw new Error(error);
    if (args[0] === "marketplace") return { diagnostics: [] };
    if (args[0] === "list") {
      // Real CLI shapes: plain list answers a top-level array; --available adds the object envelope.
      if (!args.includes("--available")) return [{ id: PLUGIN_ID, version: record.version, enabled, diagnostics: [] }];
      return {
        installed: [{ id: PLUGIN_ID, version: record.version, enabled }],
        available: missing ? [] : [{ id: PLUGIN_ID, version }], diagnostics: [],
      };
    }
    if (args[0] === "update") { record.version = version; writeRecord(); return { ok: true, version, diagnostics: [] }; }
    throw new Error("Unexpected CLI command");
  };
  const options = { runtime, home: dir, resourcesPath: dir, executable: process.execPath, now: () => time,
    cli, sync: async (root) => { syncs.push(root); return { changed, skipped, preserved: skipped }; }, notify: (s) => states.push(s) };
  return { updater: createUpdater(options), options, runtime, configFile, recordFile, calls, states, syncs, record,
    set: (values) => { if ("version" in values) version = values.version; if ("error" in values) error = values.error;
      if ("missing" in values) missing = values.missing; if ("enabled" in values) enabled = values.enabled;
      if ("changed" in values) changed = values.changed; if ("skipped" in values) skipped = values.skipped; },
    advance: (ms) => { time += ms; }, writeRecord };
}

test("semantic versions compare numeric components, prereleases and build metadata", () => {
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
  assert.equal(compareVersions("1.1.0", "1.1.0-beta.2"), 1);
  assert.equal(compareVersions("1.1.0-beta.10", "1.1.0-beta.2"), 1);
  assert.equal(compareVersions("1.1.0-1", "1.1.0-beta"), -1);
  assert.equal(compareVersions("1.1.0+new", "1.1.0+old"), 0);
  assert.throws(() => compareVersions("", "1.0.0"));
});
test("list overview accepts both real CLI list shapes, keeps foreign diagnostics out, rejects unknown shapes", () => {
  const entry = { id: PLUGIN_ID, version: "1.0.0", enabled: true, diagnostics: [] };
  const plain = [{ id: "other@zusage-marketplace", version: "9.9.9", enabled: true,
    diagnostics: [{ severity: "error", message: "foreign plugin broken" }] }, entry];
  const fromPlain = listOverview(plain);
  assert.equal(fromPlain.installed.length, 2); assert.deepEqual(fromPlain.available, []);
  assert.deepEqual(fromPlain.diagnostics, []); // other plugins' errors are not ours to act on
  assert.deepEqual(listOverview([{ id: PLUGIN_ID, diagnostics: [{ severity: "error", message: "ours" }] }]).diagnostics,
    [{ severity: "error", message: "ours" }]);
  const envelope = listOverview({ installed: [entry], available: [{ id: PLUGIN_ID, version: "1.1.0" }], diagnostics: [] });
  assert.deepEqual(envelope.installed, [entry]); assert.deepEqual(envelope.available, [{ id: PLUGIN_ID, version: "1.1.0" }]);
  assert.deepEqual(listOverview([]).installed, []); // real absence, not a shape problem
  assert.deepEqual(listOverview({ available: [] }).installed, []); // envelope may omit installed
  for (const junk of ["garbage", null, 7, { diagnostics: [] }, {}]) assert.throws(() => listOverview(junk), /无法识别/);
});
test("missing auto setting defaults to on and tick checks plus installs", async (t) => {
  const f = fixture(t); const before = fs.readFileSync(f.configFile, "utf8");
  await f.updater.tick();
  assert.equal(f.updater.status().auto, true); assert.equal(f.updater.status().phase, "updated");
  assert.deepEqual(f.calls, [["marketplace", "update", "zusage-marketplace"], ["list", "--available"], ["update", PLUGIN_ID]]);
  assert.equal(fs.readFileSync(f.configFile, "utf8"), before);
});
test("missing config defaults to on without writing unrelated settings", async (t) => {
  const f = fixture(t); fs.unlinkSync(f.configFile);
  await f.updater.tick();
  assert.equal(f.updater.status().auto, true); assert.equal(f.updater.status().phase, "updated");
  assert.equal(fs.existsSync(f.configFile), false);
});
test("explicit false stays off across restarts and tick does not contact marketplace", async (t) => {
  const f = fixture(t, { plugin_auto_update: false });
  await f.updater.tick(); await createUpdater(f.options).tick();
  assert.equal(f.calls.length, 0); assert.equal(f.updater.status().auto, false);
  assert.equal(JSON.parse(fs.readFileSync(f.configFile)).plugin_auto_update, false);
});
test("corrupt, non-object and non-boolean config never auto-enables or overwrites", async (t) => {
  const f = fixture(t);
  const inputs = ["{bad JSON", "null", "[]", "true", ...[null, 0, 1, "true", "false", [], {}].map((v) => JSON.stringify({ plugin_auto_update: v }))];
  for (const input of inputs) {
    fs.writeFileSync(f.configFile, input);
    const u = createUpdater(f.options); await u.tick();
    assert.equal(u.status().auto, false, input); assert.equal(f.calls.length, 0, input);
    assert.equal(fs.readFileSync(f.configFile, "utf8"), input);
  }
});
test("manual detection only refreshes this marketplace and never installs", async (t) => {
  const f = fixture(t); await f.updater.request({ action: "check" });
  assert.deepEqual(f.calls, [["marketplace", "update", "zusage-marketplace"], ["list", "--available"]]);
  assert.equal(f.updater.status().phase, "available"); assert.equal(f.syncs.length, 0);
  assert.ok(f.states.some((s) => s.phase === "checking" && s.busy));
});
test("manual update rechecks then uses official installer and synchronizes installed path", async (t) => {
  const f = fixture(t); f.set({ changed: ["overlay.js", "inject-main.cjs"], skipped: ["zusage.py"] });
  await f.updater.request({ action: "update", path: "/untrusted/script" });
  assert.deepEqual(f.calls[2], ["update", PLUGIN_ID]);
  assert.deepEqual(f.syncs, [f.record.installPath]);
  assert.equal(f.updater.status().phase, "updated"); assert.equal(f.updater.status().restartRequired, true);
  assert.deepEqual(f.updater.status().skipped, ["zusage.py"]);
});
test("runtime sync callback fires once when a marker is present and cannot fail the update", async (t) => {
  const f = fixture(t); f.set({ changed: ["quota-client.cjs"] });
  let synced = 0, boom = false;
  const u = createUpdater({ ...f.options, onRuntimeSynced: async () => { synced += 1; if (boom) throw new Error("hot swap failed"); } });
  await u.request({ action: "update" });
  assert.equal(synced, 1);   // 冷变更写了 marker：宿主热换钩子被 await
  assert.equal(u.status().phase, "updated");
  assert.equal(u.status().restartRequired, true);   // fixture 不销账：红点保持（真实链路由 onRuntimeSynced 清除）
  boom = true;
  f.set({ version: "1.2.0" });   // 追平后 check 会判 current 跳过安装：二轮给新版本再触发
  await u.request({ action: "update" });
  assert.equal(synced, 2);   // 二轮更新再次触发
  assert.equal(u.status().phase, "updated");   // 回调抛异常被吞，更新链不受损
});
test("runtime sync callback is skipped when no cold marker was written", async (t) => {
  const f = fixture(t); f.set({ changed: [] });
  let synced = 0;
  const u = createUpdater({ ...f.options, onRuntimeSynced: async () => { synced += 1; } });
  await u.request({ action: "update" });
  assert.equal(f.syncs.length, 1);
  assert.equal(synced, 0);   // 无冷变更无 marker：不触发热换扫描（避免无谓 ack 子进程）
  assert.equal(u.status().phase, "updated");
});
test("manual update on the local directory channel leaves checking as soon as the version is known, not only after install completes", async (t) => {
  const f = fixture(t);
  await f.updater.request({ action: "update" });
  const phases = f.states.map((s) => s.phase);
  const first = (phase) => phases.indexOf(phase);
  // 本地目录市场渠道同样先 checking 再 marketplace/list 调用；旧代码只在到达 updating 前都
  // 不再 publish，面板停在「正在检查更新」。state.phase="available" 必须先于 "updating" 发布。
  assert.ok(first("checking") >= 0 && first("available") > first("checking"), phases.join(","));
  assert.ok(first("updating") > first("available"), phases.join(","));
  assert.equal(f.updater.status().phase, "updated");
});
test("up-to-date and older marketplace versions never install", async (t) => {
  const f = fixture(t); f.set({ version: "1.0.0" }); await f.updater.request({ action: "update" });
  f.set({ version: "0.9.0" }); await f.updater.request({ action: "update" });
  assert.equal(f.calls.filter((c) => c[0] === "update").length, 0); assert.equal(f.updater.status().phase, "current");
});
test("auto enable persists configuration and performs check plus install", async (t) => {
  const f = fixture(t); await f.updater.request({ action: "auto", enabled: true });
  const cfg = JSON.parse(fs.readFileSync(f.configFile));
  assert.equal(cfg.plugin_auto_update, true); assert.equal(cfg.lang, "en"); assert.deepEqual(cfg.remote, { enabled: false });
  assert.equal(f.updater.status().phase, "updated");
  assert.ok(f.calls.some((c) => c[0] === "update"));
});
test("automatic update interval is exactly one hour", () => {
  assert.equal(INTERVAL_MS, 3600000);
});
test("auto checks are throttled for one hour across ticks and loader restarts", async (t) => {
  const f = fixture(t, { plugin_auto_update: true }); await f.updater.tick();
  const count = f.calls.length; await f.updater.tick(); assert.equal(f.calls.length, count);
  const restored = createUpdater(f.options); await restored.tick(); assert.equal(f.calls.length, count);
  f.advance(3599999); await restored.tick(); assert.equal(f.calls.length, count);
  f.advance(1); await restored.tick(); assert.equal(f.calls.length, count + 2);
});
test("hourly checks reuse saved millisecond lastAttempt rather than checkedAt", async (t) => {
  for (const [elapsed, due] of [[3599999, false], [3600000, true], [3600001, true], [1800000, false], [7200000, true]]) {
    await t.test(`elapsed ${elapsed}ms`, async (t) => {
      const f = fixture(t); f.set({ version: "1.0.0" });
      const stateFile = path.join(f.runtime, "plugin-update.json");
      const lastAttempt = f.options.now() - elapsed;
      const saved = JSON.stringify({ lastAttempt, checkedAt: f.options.now() });
      fs.writeFileSync(stateFile, saved);
      const restored = createUpdater(f.options); await restored.tick();
      assert.equal(f.calls.length, due ? 2 : 0);
      assert.equal(restored.status().lastAttempt, due ? f.options.now() : lastAttempt);
      assert.equal(f.syncs.length, 0);
      if (!due) assert.equal(fs.readFileSync(stateFile, "utf8"), saved);
    });
  }
});
test("automatic check re-reads a recent cross-instance attempt after acquiring the lock", async (t) => {
  const f = fixture(t);
  const stateFile = path.join(f.runtime, "plugin-update.json");
  const recent = JSON.stringify({ lastAttempt: f.options.now() - 1800000 });
  fs.writeFileSync(stateFile, JSON.stringify({ lastAttempt: f.options.now() - 7200000 }));
  let released = false;
  const u = createUpdater({ ...f.options, acquireLock: async () => {
    fs.writeFileSync(stateFile, recent);
    return async () => { released = true; };
  } });
  await u.tick();
  assert.equal(f.calls.length, 0); assert.equal(released, true);
  assert.equal(u.status().lastAttempt, f.options.now() - 1800000);
  assert.equal(fs.readFileSync(stateFile, "utf8"), recent);
});
test("manual check bypasses the hourly interval without installing", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.runtime, "plugin-update.json"), JSON.stringify({ lastAttempt: f.options.now() }));
  await f.updater.tick(); assert.equal(f.calls.length, 0);
  await f.updater.request({ action: "check" });
  assert.equal(f.calls.length, 2); assert.equal(f.syncs.length, 0);
  assert.equal(f.updater.status().phase, "available");
});
test("auto disable stops future checks while manual check remains usable", async (t) => {
  const f = fixture(t, { plugin_auto_update: true }); await f.updater.request({ action: "auto", enabled: false });
  await f.updater.tick(); assert.equal(f.calls.length, 0);
  await f.updater.request({ action: "check" }); assert.equal(f.calls.length, 2);
});
test("auto never updates a disabled plugin", async (t) => {
  const f = fixture(t, { plugin_auto_update: true }); f.set({ enabled: false }); await f.updater.tick();
  assert.equal(f.updater.status().phase, "available"); assert.equal(f.calls.length, 2);
});
test("missing manifest version or entry is an error, not up-to-date", async (t) => {
  const f = fixture(t); f.set({ version: "" }); await f.updater.request({ action: "check" });
  assert.equal(f.updater.status().phase, "error"); assert.equal(f.updater.status().checkedAt, 0);
  f.set({ missing: true }); await f.updater.request({ action: "check" }); assert.equal(f.updater.status().phase, "error");
});
test("network failure is visible, marketplace refresh retries three times, and lastError persists (issue #247)", async (t) => {
  const f = fixture(t, { plugin_auto_update: true }); f.set({ error: "network unavailable" }); await f.updater.tick();
  assert.equal(f.updater.status().phase, "error");
  assert.match(f.updater.status().error, /市场清单刷新连续 3 次失败/);
  assert.match(f.updater.status().error, /network unavailable/);
  // 检查阶段失败也持久化 lastError：浮层不在时它是 plugin-update.json 里的唯一痕迹
  assert.deepEqual(f.updater.status().lastError, { message: "市场清单刷新连续 3 次失败: network unavailable", at: 100000000 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.runtime, "plugin-update.json"), "utf8")).lastError,
    { message: "市场清单刷新连续 3 次失败: network unavailable", at: 100000000 });
  await f.updater.tick(); assert.equal(f.calls.length, 3);
  f.advance(3599999); await f.updater.tick(); assert.equal(f.calls.length, 3);
  f.advance(1); await f.updater.tick(); assert.equal(f.calls.length, 6);
  f.set({ error: null }); await f.updater.request({ action: "check" }); assert.equal(f.updater.status().phase, "available");
  assert.equal(f.updater.status().lastError, null);   // 检查成功即清
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.runtime, "plugin-update.json"), "utf8")).lastError, null);
});
test("CLI error diagnostics are honored even on exit zero", async (t) => {
  const f = fixture(t); const u = createUpdater({ ...f.options,
    cli: async () => ({ diagnostics: [{ severity: "error", message: "market missing" }] }) });
  await u.request({ action: "check" }); assert.equal(u.status().phase, "error"); assert.match(u.status().error, /market missing/);
});
test("market install failure persists both lastFailure and lastError with the same cause", async (t) => {
  const f = fixture(t);
  const u = createUpdater({ ...f.options, cli: async (args) => {
    f.calls.push(args);
    if (args[0] === "marketplace") return { diagnostics: [] };
    if (args[0] === "list") {
      if (args.includes("--available")) return { installed: [{ id: PLUGIN_ID, version: "1.0.0", enabled: true }],
        available: [{ id: PLUGIN_ID, version: "1.1.0" }], diagnostics: [] };
      return [{ id: PLUGIN_ID, version: "1.0.0", enabled: true, diagnostics: [] }];
    }
    if (args[0] === "update") return { ok: true, diagnostics: [] };   // CLI 声称成功但清单版本没前进
    throw new Error("Unexpected CLI command");
  } });
  await u.request({ action: "update" });
  assert.equal(u.status().phase, "error");
  assert.match(u.status().error, /未提交新版安装记录/);
  const saved = JSON.parse(fs.readFileSync(path.join(f.runtime, "plugin-update.json"), "utf8"));
  assert.equal(saved.lastFailure.version, "1.1.0");       // 安装失败目标身份（既有语义，不变）
  assert.equal(saved.lastFailure.channel, "market");
  assert.match(saved.lastError.message, /未提交新版安装记录/);   // 失败原因同落盘（issue #247）
});
test("tick force bypasses the hourly throttle but never the auto-update opt-out (issue #247)", async (t) => {
  const f = fixture(t, { plugin_auto_update: true });
  await f.updater.tick();   // 首次检查并安装成功，lastAttempt 刚写
  const count = f.calls.length;
  await f.updater.tick(); assert.equal(f.calls.length, count);          // 1h 内普通 tick 不再查
  await f.updater.tick(true); assert.equal(f.calls.length, count + 2);  // force 立即重查（已是最新 → 不安装）
  assert.equal(f.updater.status().phase, "current");
  const off = fixture(t, { plugin_auto_update: false });
  await off.updater.tick(true); assert.equal(off.calls.length, 0);      // 显式关闭仍不更新
});
test("auto command accepts --force and rejects unknown flags (issue #247)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-auto-cmd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = path.join(dir, "runtime"); fs.mkdirSync(runtime);
  await assert.doesNotReject(() => runAutoCommand(["--auto", "--force", "--resources", dir, "--runtime", runtime]));
  await assert.rejects(() => runAutoCommand(["--auto", "--bogus", "x"]), /无效自动更新参数/);
  await assert.rejects(() => runAutoCommand(["--auto"]), /缺少客户端或运行时目录/);
});
test("invalid config is never overwritten", async (t) => {
  const f = fixture(t); fs.writeFileSync(f.configFile, "{bad JSON");
  await f.updater.request({ action: "auto", enabled: true });
  assert.equal(fs.readFileSync(f.configFile, "utf8"), "{bad JSON"); assert.equal(f.updater.status().phase, "error");
});
test("uninstalled plugin or unavailable host bundle cannot update", async (t) => {
  const f = fixture(t); fs.writeFileSync(f.recordFile, '{"plugins":[]}'); await f.updater.request({ action: "check" });
  assert.equal(f.updater.status().supported, false); assert.equal(f.calls.length, 0);
  f.writeRecord(); const u = createUpdater({ ...f.options, cli: undefined }); assert.equal(u.status().supported, false);
});
test("missing config is created without requiring installer-generated settings", async (t) => {
  const f = fixture(t); fs.unlinkSync(f.configFile);
  await f.updater.request({ action: "auto", enabled: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile)), { plugin_auto_update: true });
  assert.equal(f.updater.status().phase, "updated");
});
test("failed runtime sync can be retried after restart without reinstalling plugin", async (t) => {
  const f = fixture(t); let fail = true;
  const options = { ...f.options, sync: async () => { if (fail) throw new Error("runtime locked"); return { changed: ["overlay.js"] }; } };
  const u = createUpdater(options); await u.request({ action: "update" });
  assert.equal(u.status().phase, "error"); assert.equal(u.status().pendingSync, true);
  assert.equal(f.record.version, "1.1.0");
  fail = false;
  const restored = createUpdater(options); await restored.request({ action: "check" });
  assert.equal(restored.status().phase, "updated"); assert.equal(restored.status().pendingSync, false);
  assert.equal(f.calls.filter((c) => c[0] === "update").length, 1);
});
test("pending runtime synchronization recovers offline without waiting an hour", async (t) => {
  const f = fixture(t, { plugin_auto_update: true });
  fs.writeFileSync(path.join(f.runtime, "plugin-update.json"), JSON.stringify({ lastAttempt: f.options.now(), pendingSync: true }));
  f.set({ error: "network unavailable" });
  const u = createUpdater(f.options); await u.tick();
  assert.equal(u.status().phase, "updated"); assert.equal(u.status().pendingSync, false);
  assert.equal(f.calls.length, 0); assert.equal(f.syncs.length, 1);
});
test("multiple hook and loader instances serialize updates across the shared runtime", async (t) => {
  const f = fixture(t, { plugin_auto_update: true }); let release, entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const options = { ...f.options, cli: async (args) => { entered(); await blocked;
    if (args[0] === "marketplace") return { diagnostics: [] };
    return { installed: [{ id: PLUGIN_ID, version: "1.0.0", enabled: true }], available: [{ id: PLUGIN_ID, version: "1.0.0" }] }; } };
  const first = createUpdater(options), second = createUpdater(options);
  const running = first.tick(); await started; await second.tick();
  assert.equal(first.status().busy, true); assert.equal(second.status().busy, false);
  release(); await running; assert.equal(fs.existsSync(path.join(f.runtime, "plugin-update-v2.lock")), true);
  await second.tick(); assert.equal(second.status().lastAttempt, first.status().lastAttempt);
});
test("lock owned by a live process prevents updates and lock failures are visible", async (t) => {
  const f = fixture(t); const lock = path.join(f.runtime, "plugin-update.lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  await f.updater.request({ action: "update" }); assert.equal(f.calls.length, 0);
  fs.unlinkSync(lock); fs.mkdirSync(path.join(f.runtime, "plugin-update-v2.lock"));
  await f.updater.request({ action: "check" }); assert.equal(f.updater.status().phase, "error");
});
test("unknown actions and invalid settings have no effects", async (t) => {
  const f = fixture(t); await f.updater.request({ action: "shell", command: "evil" });
  await f.updater.request({ action: "auto", enabled: "true" }); assert.equal(f.calls.length, 0);
});
test("busy operations ignore duplicate update requests", async (t) => {
  const f = fixture(t); let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const u = createUpdater({ ...f.options, cli: async () => { await blocked; return { installed: [], available: [], diagnostics: [] }; } });
  const pending = u.request({ action: "check" });
  await new Promise((resolve) => setImmediate(resolve));
  await u.request({ action: "update" }); release(); await pending; assert.equal(f.syncs.length, 0);
});

test("invalid state objects and fields recover without changing automatic opt-out", async (t) => {
  const f = fixture(t, { plugin_auto_update: false });
  const stateFile = path.join(f.runtime, "plugin-update.json");
  for (const input of ["null", "[]", "true", "{bad", JSON.stringify({ checkedAt: "bad", lastAttempt: -1, pendingSync: "true" }),
    JSON.stringify({ checkedAt: 1e30, lastAttempt: "1", pendingSync: false }),
    JSON.stringify({ checkedAt: Number.MAX_SAFE_INTEGER, lastAttempt: Number.MAX_SAFE_INTEGER })]) {
    fs.writeFileSync(stateFile, input);
    const u = createUpdater(f.options); await u.tick();
    assert.equal(u.status().auto, false); assert.equal(u.status().checkedAt, 0);
    assert.equal(u.status().lastAttempt, 0); assert.equal(u.status().pendingSync, false);
  }
  assert.equal(f.calls.length, 0);
});
test("automatic install re-reads cross-instance opt-out after marketplace check", async (t) => {
  const f = fixture(t); const original = f.options.cli;
  const u = createUpdater({ ...f.options, cli: async (args) => {
    const result = await original(args);
    if (args[0] === "list") fs.writeFileSync(f.configFile, JSON.stringify({ plugin_auto_update: false }));
    return result;
  } });
  await u.tick(); assert.equal(u.status().auto, false);
  assert.equal(f.calls.filter((c) => c[0] === "update").length, 0);
});
test("disable is persisted while a check is busy and prevents automatic install", async (t) => {
  const f = fixture(t); let resume, entered;
  const gate = new Promise((resolve) => { resume = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const u = createUpdater({ ...f.options, cli: async (args) => { entered(); await gate; return f.options.cli(args); } });
  const running = u.tick(); await started;
  await u.request({ action: "auto", enabled: false });
  assert.equal(JSON.parse(fs.readFileSync(f.configFile)).plugin_auto_update, false);
  resume(); await running; assert.equal(f.calls.filter((c) => c[0] === "update").length, 0);
});
test("pending intent exists before installer commits and failed committed CLI recovers offline", async (t) => {
  const f = fixture(t); const stateFile = path.join(f.runtime, "plugin-update.json");
  const u = createUpdater({ ...f.options, cli: async (args) => {
    if (args[0] !== "update") return f.options.cli(args);
    const intent = JSON.parse(fs.readFileSync(stateFile));
    assert.equal(intent.pendingSync, true); assert.equal(intent.pendingVersion, "1.0.0");
    await f.options.cli(args); throw new Error("CLI failed after inventory commit");
  } });
  await u.request({ action: "update" });
  assert.equal(u.status().phase, "updated"); assert.equal(f.syncs.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).pendingSync, false);
});
test("markerAt tracks the restart marker mtime as the badge fingerprint generation (v172)", (t) => {
  const f = fixture(t);
  assert.equal(f.updater.status().markerAt, 0);   // 无 marker：代际 0，红点无待办
  const marker = path.join(f.runtime, ".plugin-restart-required");
  fs.writeFileSync(marker, JSON.stringify({ state: "pending-sync", createdAt: 1 }));
  const first = createUpdater(f.options);
  assert.equal(first.status().restartRequired, true);
  assert.equal(first.status().markerAt, fs.statSync(marker).mtimeMs);
  fs.utimesSync(marker, new Date(), new Date(1000));   // mtime 变化 = 新代际：已读过的红点据此重现
  const second = createUpdater(f.options);
  assert.equal(second.status().markerAt, 1000);
  assert.notEqual(second.status().markerAt, first.status().markerAt);
  fs.unlinkSync(marker);
  const cleared = createUpdater(f.options);
  assert.equal(cleared.status().restartRequired, false);
  assert.equal(cleared.status().markerAt, 0);
});
test("persistent restart marker survives updater restart and throttled background tick", async (t) => {
  const f = fixture(t); f.set({ changed: ["plugin-updater.cjs"] });
  await f.updater.request({ action: "update" });
  assert.equal(fs.existsSync(path.join(f.runtime, ".plugin-restart-required")), true);
  const u = createUpdater(f.options); await u.tick();
  assert.equal(u.status().restartRequired, true);
});
test("uncommitted installer failures are errors, never sync, and permit next automatic retry", async (t) => {
  const f = fixture(t); let attempts = 0;
  const u = createUpdater({ ...f.options, cli: async (args) => {
    if (args[0] !== "update") return f.options.cli(args);
    attempts++; throw new Error("install failed before commit");
  } });
  await u.tick(); assert.equal(u.status().phase, "error"); assert.equal(u.status().pendingSync, false);
  assert.equal(u.status().lastAttempt, 0); assert.equal(f.syncs.length, 0);
  await u.tick(); assert.equal(attempts, 2); assert.equal(f.syncs.length, 0);
});
test("CLI success without a newer official inventory commit is not successful update", async (t) => {
  const f = fixture(t);
  const u = createUpdater({ ...f.options, cli: async (args) => args[0] === "update" ? { ok: true } : f.options.cli(args) });
  await u.tick(); assert.equal(u.status().phase, "error"); assert.match(u.status().error, /未提交/);
  assert.equal(f.syncs.length, 0); assert.equal(u.status().pendingSync, false);
});
test("persisted pre-install intent recovers committed version offline even after auto disabled", async (t) => {
  const f = fixture(t, { plugin_auto_update: false }); f.record.version = "1.1.0"; f.writeRecord();
  fs.writeFileSync(path.join(f.runtime, "plugin-update.json"), JSON.stringify({
    lastAttempt: f.options.now(), pendingSync: true, pendingVersion: "1.0.0",
  }));
  f.set({ error: "offline" }); const u = createUpdater(f.options); await u.tick();
  assert.equal(u.status().phase, "updated"); assert.equal(f.calls.length, 0); assert.equal(f.syncs.length, 1);
  assert.equal(u.status().auto, false); assert.equal(u.status().pendingSync, false);
});
test("uncommitted intent with auto disabled clears without networking or claiming update", async (t) => {
  const f = fixture(t, { plugin_auto_update: false });
  fs.writeFileSync(path.join(f.runtime, "plugin-update.json"), JSON.stringify({
    lastAttempt: f.options.now(), pendingSync: true, pendingVersion: "1.0.0",
  }));
  const u = createUpdater(f.options); await u.tick();
  assert.equal(u.status().phase, "idle"); assert.equal(u.status().pendingSync, false); assert.equal(u.status().lastAttempt, 0);
  assert.equal(f.calls.length, 0); assert.equal(f.syncs.length, 0);
});
test("disable after installer start saves opt-out without cancelling already-launched commit", async (t) => {
  const f = fixture(t); let resume, entered;
  const gate = new Promise((resolve) => { resume = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const u = createUpdater({ ...f.options, cli: async (args) => {
    if (args[0] === "update") { entered(); await gate; }
    return f.options.cli(args);
  } });
  const running = u.tick(); await started;
  await u.request({ action: "auto", enabled: false }); resume(); await running;
  assert.equal(u.status().phase, "updated"); assert.equal(u.status().auto, false);
  assert.equal(f.calls.filter((c) => c[0] === "update").length, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.configFile)).plugin_auto_update, false);
});
test("hot-reload opt-out marks changed overlay or usage only, not unchanged or tools", async (t) => {
  for (const changed of [[], ["usage_mcp.py"], ["overlay.js"], ["zusage.py"]]) {
    const f = fixture(t, { hot_reload: false }); f.set({ changed });
    await f.updater.tick(); assert.equal(f.updater.status().restartRequired, changed.includes("overlay.js") || changed.includes("zusage.py"));
  }
});
test("current sync report marker is not re-recorded by legacy fallback", async (t) => {
  const f = fixture(t); const marker = path.join(f.runtime, ".plugin-restart-required");
  const u = createUpdater({ ...f.options, sync: async () => {
    fs.writeFileSync(marker, JSON.stringify({ createdAt: 1, hashes: { "plugin-updater.cjs": "saved" } }));
    return { changed: ["plugin-updater.cjs"], restartRecorded: true };
  } });
  await u.tick(); assert.equal(JSON.parse(fs.readFileSync(marker)).createdAt, 1);
  assert.equal(u.status().restartRequired, true);
});
test("marker write failure leaves pending intent for retry and never clears reminder", async (t) => {
  const f = fixture(t); const marker = path.join(f.runtime, ".plugin-restart-required");
  fs.mkdirSync(marker); f.set({ changed: ["inject-main.cjs"] });
  await f.updater.tick(); assert.equal(f.updater.status().phase, "error"); assert.equal(f.updater.status().pendingSync, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.runtime, "plugin-update.json"))).pendingVersion, "1.0.0");
  fs.rmdirSync(marker); const restored = createUpdater(f.options); await restored.tick();
  assert.equal(restored.status().phase, "updated"); assert.equal(restored.status().restartRequired, true);
  assert.equal(f.calls.filter((c) => c[0] === "update").length, 1);
});
test("invalid sync JSON report keeps coordination pending", async (t) => {
  const f = fixture(t); const u = createUpdater({ ...f.options, sync: async () => null });
  await u.tick(); assert.equal(u.status().phase, "error"); assert.equal(u.status().pendingSync, true);
});
test("null or damaged inventory cannot crash updater or trigger official install", async (t) => {
  const f = fixture(t);
  for (const input of ["null", "[]", "{bad", '{"plugins":[null]}']) {
    fs.writeFileSync(f.recordFile, input); const u = createUpdater(f.options); await u.tick();
    assert.equal(u.status().supported, false); assert.equal(f.calls.length, 0);
  }
});
test("dead legacy wx lock is ignored without deletion and stale file remains", async (t) => {
  const f = fixture(t); const old = path.join(f.runtime, "plugin-update.lock");
  fs.writeFileSync(old, JSON.stringify({ pid: 2147483647, createdAt: 1 }));
  await f.updater.tick(); assert.equal(f.updater.status().phase, "updated");
  assert.equal(fs.existsSync(old), true); assert.equal(fs.existsSync(path.join(f.runtime, "plugin-update-v2.lock")), true);
});
test("missing Python helper errors are visible and do not leave updater busy", async (t) => {
  const f = fixture(t, { python_path: path.join(os.tmpdir(), "missing-zusage-python") });
  await f.updater.tick(); assert.equal(f.updater.status().phase, "error"); assert.equal(f.updater.status().busy, false);
  assert.equal(f.calls.length, 0);
});
test("macOS CLI child prefers the LSUIElement Helper bundle and falls back when absent", (t) => {
  // 主 bundle 二进制以 Foreground 登记 LaunchServices，检查更新会在 Dock 闪现「zcode-cli」图标；
  // 更新器必须换用 Helper bundle（LSUIElement，登记 UIElement 不进 Dock），缺失时回退主二进制。
  // 显式传 platform 使非 darwin 分支在 darwin 机器上同样被断言。
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-cli-exec-"));
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
  const main = path.join(appDir, "ZCode.app", "Contents", "MacOS", "ZCode");
  const helper = path.join(appDir, "ZCode.app", "Contents", "Frameworks", "ZCode Helper.app", "Contents", "MacOS", "ZCode Helper");
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  assert.equal(cliExecutable(main, "win32"), main);    // 非 macOS 一律维持调用方二进制
  assert.equal(cliExecutable(main, "linux"), main);
  assert.equal(cliExecutable(main, "darwin"), main);   // Helper 未就位：回退主二进制，更新链不中断
  fs.writeFileSync(helper, ""); fs.chmodSync(helper, 0o755);
  assert.equal(cliExecutable(main, "darwin"), helper); // Helper 就位：Dock 不再闪图标
  fs.chmodSync(helper, 0o644);
  assert.equal(cliExecutable(main, "darwin"), main);   // 不可执行：回退，宁可闪图标不可更新失败
  fs.rmSync(helper); fs.mkdirSync(helper);
  assert.equal(cliExecutable(main, "darwin"), main);   // Helper 位置是目录：同样回退
  assert.equal(cliExecutable("/usr/local/bin/node", "darwin"), "/usr/local/bin/node");   // 非 bundle 路径不动
});
test("createUpdater spawns the Helper bundle for its CLI children on macOS", async (t) => {
  // 端到端锁定生产接线：不注入 options.cli 时，默认 cli() 必须以 Helper 路径 spawn（而非主二进制），
  // 防止 createUpdater 内的接线被回退后测试仍全绿。子进程桩把自己被 exec 的路径追加到 probe 供断言。
  if (process.platform !== "darwin") return;
  const f = fixture(t);
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-cli-spawn-"));
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
  const probe = path.join(appDir, "probe.log");
  const writeStub = (rel) => {
    const file = path.join(appDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "#!/bin/sh\nprintf '{\"diagnostics\":[]}'\nprintf '%s\\n' \"$0\" >> \"" + probe + "\"\n");
    fs.chmodSync(file, 0o755);
    return file;
  };
  // 桩必须摆出真实 bundle 形状：<App>.app/Contents/{MacOS/ZCode, Frameworks/ZCode Helper.app/...}
  const main = writeStub(path.join("ZCode.app", "Contents", "MacOS", "ZCode"));
  const helper = writeStub(path.join("ZCode.app", "Contents", "Frameworks", "ZCode Helper.app", "Contents", "MacOS", "ZCode Helper"));
  // resourcesPath 下需有真实 bundle 文件，否则 supported=false 会直接短路 check，轮不到 cli() spawn
  fs.mkdirSync(path.join(path.dirname(f.runtime), "glm"), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(f.runtime), "glm", "zcode.cjs"), "");
  const { cli, ...withoutCli } = f.options;
  const u = createUpdater({ ...withoutCli, executable: main });
  await u.request({ action: "check" });
  const spawned = fs.readFileSync(probe, "utf8").trim().split("\n");
  assert.ok(spawned.length >= 1, "CLI 子进程应至少被拉起一次");
  for (const line of spawned) assert.equal(line, helper, "CLI 子进程必须以 Helper bundle 运行");
});
test("onRuntimeSynced runs after busy is released and initialState preserves post-update state across hot-swap", async (t) => {
  const f = fixture(t);
  f.set({ changed: ["plugin-updater.cjs"], skipped: ["zusage.py"] });
  const marker = path.join(f.runtime, ".plugin-restart-required");
  let busyInsideHook = null, replacement = null;
  const published = [];
  let currentUpdater = null;
  const u = createUpdater({
    ...f.options,
    notify: (s) => published.push(s),
    onRuntimeSynced: async () => {
      busyInsideHook = currentUpdater.status().busy;
      fs.unlinkSync(marker);   // 模拟 hotReloadMainModules + acknowledgeRestart 当场清掉 marker
      replacement = createUpdater({ ...f.options, initialState: currentUpdater.status() });
    },
  });
  currentUpdater = u;
  published.length = 0;
  await u.request({ action: "update" });
  assert.equal(busyInsideHook, false, "onRuntimeSynced 必须在 busy=false 释放后调用，以便 updater 自身可当场热换");
  assert.equal(u.status().restartRequired, false, "marker 在 onRuntimeSynced 中被销账后，终态不得再报告 restartRequired=true");
  assert.equal(published.some((s) => s.restartRequired === true), false, "全过程不得向 UI 推送任何一帧 restartRequired=true（零红点闪烁）");
  assert.ok(replacement, "模拟热换重建的新 updater 实例应已创建");
  assert.equal(replacement.status().phase, "updated", "initialState 应保留刚完成的 updated 阶段");
  assert.equal(replacement.status().latestVersion, "1.1.0");
  assert.deepEqual(replacement.status().skipped, ["zusage.py"]);
  assert.equal(replacement.status().restartRequired, false);
});

