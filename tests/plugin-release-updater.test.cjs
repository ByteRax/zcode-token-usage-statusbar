"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { createUpdater, PLUGIN_ID, INTERVAL_MS, verifyRuntimeSync } = require("../plugin-updater.cjs");
const { validateRelease, validateManifest, downloadRelease, gitcodeReleaseFromCatalog } = require("../plugin-release.cjs");

const PLUGIN = "zcode-token-usage-statusbar";
const MARKET = "zusage-marketplace";
const REPOSITORY = "ByteRax/" + PLUGIN;
const GITCODE_REPOSITORY = "tanranran/" + PLUGIN;
const clone = (value) => JSON.parse(JSON.stringify(value));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));

function fixture(t, settings = {}, customStorage = false, variant = "github") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zusage-release-updater-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home"), runtime = path.join(dir, "runtime");
  const defaultInventory = path.join(home, ".zcode", "cli", "plugins");
  const storageDir = path.join(dir, "custom-storage");
  const inventory = customStorage ? path.join(storageDir, "cli", "plugins") : defaultInventory;
  if (customStorage) {
    fs.mkdirSync(path.join(home, ".zcode", "cli"), { recursive: true });
    writeJson(path.join(home, ".zcode", "cli", "config.json"), { storage: { dir: storageDir } });
  }
  const marketRoot = path.join(inventory, "marketplaces", MARKET);
  for (const folder of [runtime, marketRoot, path.join(home, "installed")]) fs.mkdirSync(folder, { recursive: true });
  const configFile = path.join(runtime, "config.json"), stateFile = path.join(runtime, "plugin-update.json");
  const recordFile = path.join(inventory, "installed_plugins.json");
  const knownFile = path.join(inventory, "known_marketplaces.json");
  const catalogFile = path.join(marketRoot, "marketplace.json");
  writeJson(configFile, { python_path: "python3", lang: "en", ...settings });
  const source = variant === "gitcode"
    ? { source: "git", url: `https://gitcode.com/${GITCODE_REPOSITORY}.git`, ref: "plugin-releases-gitcode" }
    : { source: "github", repo: REPOSITORY, ref: "plugin-releases" };
  const channelRepository = variant === "gitcode" ? GITCODE_REPOSITORY : REPOSITORY;
  const record = { id: PLUGIN_ID, version: "1.0.0", scope: "user", installPath: path.join(home, "installed"),
    source: { source: "directory", path: path.join(dir, "old-package") } };
  const events = [], calls = [], syncs = [], prepared = [], states = [];
  const f = { dir, home, runtime, inventory, defaultInventory, storageDir, configFile, stateFile, recordFile, knownFile, catalogFile,
    source, record, events, calls, syncs, prepared, states, enabled: true, offline: false, cleanupCount: 0 };
  f.writeKnown = () => writeJson(knownFile, { version: 1, marketplaces: [{ id: MARKET, source: clone(source) }] });
  f.writeRecord = () => writeJson(recordFile, { version: 1, plugins: [record] });
  f.channel = () => ({ kind: "release", flavor: variant === "gitcode" ? "gitcode" : "github",
    repository: channelRepository, source: clone(source) });
  f.setGitcodeRelease = (version, bytes = Buffer.from("synthetic archive"), manifest = null) => {
    // 模拟真实镜像链：清单 repository 是打包上游（ByteRax），渠道仓库是镜像（tanranran）。
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    f.manifest = manifest || { schemaVersion: 1, repository: REPOSITORY, version, tag: "v" + version,
      pluginId: PLUGIN_ID, asset: { name: `${PLUGIN}-v${version}.zip`, size: bytes.length, sha256: sha } };
    f.bytes = bytes;
    f.catalog = { name: MARKET, plugins: [{ name: PLUGIN, version, source: { source: "url", type: "zip",
      url: `https://gitcode.com/${GITCODE_REPOSITORY}/releases/download/v${version}/${PLUGIN}-v${version}.zip`,
      sha256: f.manifest.asset.sha256, path: "plugins/" + PLUGIN, stripRoot: false } }] };
    f.release = gitcodeReleaseFromCatalog(f.catalog, GITCODE_REPOSITORY);
  };
  f.setRelease = (version, bytes = Buffer.from("synthetic archive"), manifest = null) => {
    const base = `https://github.com/${REPOSITORY}/releases/download/v${version}/`;
    const name = `${PLUGIN}-v${version}.zip`;
    f.manifest = manifest || { schemaVersion: 1, repository: REPOSITORY, version, tag: "v" + version,
      pluginId: PLUGIN_ID, asset: { name, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") } };
    f.bytes = bytes;
    f.row = { tag_name: "v" + version, draft: false, prerelease: false, assets: [
      { name, state: "uploaded", size: bytes.length, browser_download_url: base + name },
      { name: "release-manifest.json", state: "uploaded", size: Buffer.byteLength(JSON.stringify(f.manifest)),
        browser_download_url: base + "release-manifest.json" },
    ] };
    f.release = validateRelease(f.row, REPOSITORY);
    validateManifest(f.manifest, f.release);
    f.catalog = { name: MARKET, plugins: [{ name: PLUGIN, version, source: { source: "url", type: "zip",
      url: f.release.archive.browser_download_url, sha256: f.manifest.asset.sha256,
      path: "plugins/" + PLUGIN, stripRoot: false } }] };
    f.rows = [f.row];
  };
  f.intent = () => ({ release: clone(f.release), manifest: clone(f.manifest), channel: f.channel() });
  f.seedPending = (pendingRelease = f.intent()) => {
    record.version = f.release.version; record.source = clone(f.catalog.plugins[0].source); f.writeRecord();
    writeJson(stateFile, { checkedAt: 100000000, lastAttempt: 100000000, pendingSync: true,
      pendingVersion: "1.0.0", pendingPid: 0, pendingRelease });
  };
  f.fetch = async (url, limit) => {
    events.push("fetch");
    if (variant === "gitcode") {
      if (url === f.release.manifest.browser_download_url) return Buffer.from(JSON.stringify(f.manifest));
      if (url === f.release.archive.browser_download_url) return f.bytes;
      throw new Error("unexpected gitcode download: " + url);
    }
    if (url.startsWith("https://api.github.com/")) {
      assert.equal(url, `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100&page=1`);
      assert.equal(limit, 4 * 1024 * 1024);
      if (f.offline) throw new Error("fixture offline");
      if (f.apiLimited) { events.push("api-403"); throw new Error("Release 请求失败 (403)"); }
      if (f.afterFetch) await f.afterFetch();
      return Buffer.from(JSON.stringify(f.rows));
    }
    if (url === f.release.manifest.browser_download_url) return Buffer.from(JSON.stringify(f.manifest));
    if (url === f.release.archive.browser_download_url) return f.bytes;
    throw new Error("unexpected github download: " + url);
  };
  let listCount = 0;
  const cli = async (args) => {
    calls.push([...args]); events.push(args[0] === "marketplace" ? "marketplace" : args[0]);
    if (f.offline) throw new Error("fixture CLI unavailable offline");
    if (args[0] === "list") {
      assert.deepEqual(args, ["list"]);
      if (f.afterList) await f.afterList(++listCount);
      // Real plain `plugins list --json`: top-level array, no scope field, per-entry
      // diagnostics. A foreign broken plugin must not block our install.
      if (f.uninstalled) return [];
      return [{ id: "other@" + MARKET, version: "9.9.9", enabled: true,
        diagnostics: [{ severity: "error", message: "foreign plugin broken" }] },
        { id: PLUGIN_ID, version: record.version, enabled: f.enabled, diagnostics: [] }];
    }
    if (args[0] === "marketplace") {
      assert.deepEqual(args, ["marketplace", "update", MARKET]);
      if (f.marketError) throw new Error(f.marketError);
      // issue #247：宿主 CLI 静默失败（exit 0 空输出 → runFile 报「没有返回有效 JSON」）。
      if (f.marketTransientFailures > 0) { f.marketTransientFailures -= 1; throw new Error("插件管理器没有返回有效 JSON"); }
      writeJson(catalogFile, f.catalog);
      if (f.afterMarket) await f.afterMarket();
      return { diagnostics: [] };
    }
    assert.deepEqual(args, ["install", PLUGIN_ID, "--scope", "user"]);
    const intent = readJson(stateFile);
    assert.equal(intent.pendingSync, true); assert.equal(intent.pendingVersion, record.version);
    assert.deepEqual(intent.pendingRelease, f.intent());
    if (f.installErrorBeforeCommit) throw new Error("fixture installer failed before commit");
    if (!f.skipCommit) {
      record.version = f.release.version; record.source = clone(readJson(catalogFile).plugins[0].source);
      if (f.changeCommit) f.changeCommit(record);
      f.writeRecord();
    }
    if (f.afterInstall) await f.afterInstall();
    if (f.installErrorAfterCommit) throw new Error("fixture installer exited after commit");
    return { ok: true, diagnostics: [] };
  };
  const prepareRelease = async (release, onProgress) => {
    events.push("prepare");
    assert.deepEqual(release, f.release);
    if (f.prepareError) throw new Error(f.prepareError);
    const manifest = clone(validateManifest(f.manifest, release));
    if (typeof onProgress === "function") for (const step of f.progressSteps || []) onProgress(clone(step));
    const directory = fs.mkdtempSync(path.join(dir, "prepared-")); prepared.push(directory);
    if (f.afterPrepare) await f.afterPrepare();
    return { directory, release, manifest, cleanup: () => {
      events.push("cleanup"); f.cleanupCount++; fs.rmSync(directory, { recursive: true, force: true });
    } };
  };
  f.options = { home, runtime, env: {}, resourcesPath: dir, executable: process.execPath, now: () => 100000000,
    fetchRelease: f.fetch, prepareRelease, cli, acquireLock: async () => () => {},
    sync: async (root) => {
      events.push("sync"); syncs.push(root); assert.equal(root, record.installPath);
      if (f.syncError) throw new Error(f.syncError);
      return { changed: [], preserved: [], restartRecorded: true };
    }, notify: (state) => states.push(state) };
  f.setRelease("1.1.0"); f.writeKnown(); f.writeRecord();
  f.restart = () => createUpdater(f.options);
  f.updater = f.restart();
  return f;
}

function assertNoInstall(f) {
  assert.equal(f.calls.filter((args) => args[0] === "install" || args[0] === "update").length, 0);
  assert.equal(f.syncs.length, 0);
}
function assertCleaned(f) {
  assert.equal(f.cleanupCount, f.prepared.length);
  for (const directory of f.prepared) assert.equal(fs.existsSync(directory), false);
}
async function assertPendingBlocked(f, expected) {
  const counts = [f.events.length, f.calls.length, f.syncs.length];
  f.offline = true;
  for (let i = 0; i < 2; i++) {
    const restored = f.restart(); await restored.tick();
    assert.equal(restored.status().phase, "error"); assert.equal(restored.status().pendingSync, true);
    assert.equal(restored.status().busy, false);
    assert.deepEqual(readJson(f.stateFile).pendingRelease, expected);
    assert.deepEqual([f.events.length, f.calls.length, f.syncs.length], counts);
  }
}

/* 默认分支安装的形态：已注册的是 GitHub 仓库来源，但市场清单里的插件条目是源码路径
   （"./plugins/..."），没有可校验的 Release。readChannel 把它判为 market 渠道，更新走
   宿主插件管理器自身的 marketplace update → list --available → update，不碰 Release API。 */
function sourceCatalogFixture(t, version, settings = {}, variant = "github") {
  const f = fixture(t, settings, false, variant);
  const catalog = { name: MARKET, plugins: [{ name: PLUGIN, version, source: "./plugins/" + PLUGIN }] };
  writeJson(f.catalogFile, catalog);
  f.hostCalls = [];
  f.options.cli = async (args) => {
    f.hostCalls.push([...args]); f.events.push(args[0]);
    if (args[0] === "marketplace") { assert.deepEqual(args, ["marketplace", "update", MARKET]); writeJson(f.catalogFile, catalog); return { diagnostics: [] }; }
    if (args[0] === "list") {
      assert.deepEqual(args, ["list", "--available"]);
      return { installed: [{ id: PLUGIN_ID, version: f.record.version, enabled: f.enabled, scope: "user" }],
        available: [{ id: PLUGIN_ID, version }], diagnostics: [] };
    }
    assert.deepEqual(args, ["update", PLUGIN_ID]);
    const intent = readJson(f.stateFile);
    assert.equal(intent.pendingSync, true); assert.equal(intent.pendingRelease, null);
    f.record.version = version; f.writeRecord();
    return { ok: true, diagnostics: [] };
  };
  f.updater = f.restart();
  return f;
}

for (const variant of ["github", "gitcode"]) {
  test(`${variant} marketplace whose catalog points at repository source updates through the host plugin manager`, async (t) => {
    const f = sourceCatalogFixture(t, "1.1.0", { plugin_auto_update: true }, variant);
    await f.updater.request({ action: "update" });
    const state = f.updater.status();
    assert.equal(state.phase, "updated", state.error);
    assert.equal(state.channel, "market"); assert.equal(state.channelHost, variant);
    assert.equal(state.currentVersion, "1.1.0"); assert.equal(state.latestVersion, "1.1.0");
    assert.equal(f.events.includes("fetch"), false);            // 不查 Release 列表
    assert.equal(f.events.includes("prepare"), false);          // 不下载发布包
    assert.deepEqual(f.hostCalls.map((args) => args[0]), ["marketplace", "list", "update"]);
    assert.equal(f.syncs.length, 1);
    assert.equal(readJson(f.stateFile).pendingSync, false);
  });
}

/* GitHub API 匿名配额（60/h/IP）被共享出口耗尽时，检查退回注册 ref 的渠道清单
   （zipball 下载桶不占配额），渠道身份与安装校验链不变；清单 sha256 全程交叉比对。 */
test("GitHub API rate limiting falls back to the channel catalog and completes the install", async (t) => {
  const f = fixture(t);
  const { githubReleaseFromCatalog } = require("../plugin-release.cjs");
  f.apiLimited = true;
  f.release = githubReleaseFromCatalog(f.catalog, REPOSITORY);
  await f.updater.request({ action: "check" });
  assert.equal(f.updater.status().phase, "available", f.updater.status().error);
  assert.equal(f.updater.status().checkedVia, "release-catalog");
  assert.ok(f.events.includes("api-403"));
  assert.ok(f.calls.some((args) => args[0] === "marketplace"));
  assertNoInstall(f);
  await f.updater.request({ action: "update" });
  const state = f.updater.status();
  assert.equal(state.phase, "updated", state.error);
  assert.equal(state.checkedVia, "release-catalog");
  const intent = readJson(f.stateFile);
  assert.equal(intent.pendingSync, false);
  assert.equal(intent.pendingRelease, null);
  assert.equal(f.syncs.length, 1);
});

test("rate limit with a failing catalog fallback reports both causes and never installs", async (t) => {
  const f = fixture(t);
  f.apiLimited = true;
  f.marketError = "fixture marketplace offline";
  await f.updater.request({ action: "check" });
  const status = f.updater.status();
  assert.equal(status.phase, "error");
  assert.match(status.error, /Release 请求失败 \(403\)/);
  assert.match(status.error, /渠道清单回退也失败/);
  assertNoInstall(f);
});

// 真实 release_tool 打包脚本（合成源文件，无 Git/凭据/外部 HTTP）：参数 = 仓库根、临时目录、owner/repo。
const REAL_BUILD_SCRIPT = `
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("fixture_builder", Path(sys.argv[1]) / "release_tool.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)
root = Path(sys.argv[2]) / "source"
for name in tool.NAMES:
    p = root / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"not executable fixture source\\n")
plugin = {"name": tool.PLUGIN, "version": "1.1.0", "commands": "commands", "skills": "skills",
         "packageLayout": {"schemaVersion": 1, "files": list(tool.NAMES)}}
for name in (".zcode-plugin/plugin.json", ".claude-plugin/plugin.json"):
    (root / tool.PREFIX / name).write_text(json.dumps(plugin))
(root / "marketplace.json").write_text(json.dumps({"name": "zusage-marketplace", "plugins": [
    {"name": tool.PLUGIN, "version": "1.1.0", "source": "./plugins/" + tool.PLUGIN}]}))
for name in (".mcp.json", "hooks/hooks.json"):
    (root / tool.PREFIX / name).write_text("{}")
for name in tool.SYNC_FILES:
    (root / name).write_bytes((root / tool.PREFIX / name).read_bytes())
script = (Path(sys.argv[1]) / "release_tool.py").read_bytes()
(root / "release_tool.py").write_bytes(script)
print(json.dumps(tool.build(root, sys.argv[3], Path(sys.argv[2]) / "assets")))
`;

/* 仓库改名迁移（install-release.md §6）：GitHub 对改名仓库的 API 响应体规范化为新名，
   按注册旧名的资产比对与清单兜底全部挂掉后，探测官方 301/302 命中新名，整体重查成功后
   才持久化 repoMigration；意图 channel 存新名，复核经迁移记录豁免注册旧名。 */
const RENAMED = "ByteRax/zcode-speed-bar";
const FIRST_RENAME = "ByteRax/zcode-first-name";
function renamedFixture(f, bytes, manifest) {
  f.setRelease("1.1.0", bytes);
  const row = clone(f.row);
  for (const asset of row.assets) asset.browser_download_url = asset.browser_download_url.replace(`/${REPOSITORY}/`, `/${RENAMED}/`);
  f.row = row; f.rows = [row];
  f.release = validateRelease(row, RENAMED);
  if (manifest) f.manifest = manifest; else f.manifest.repository = RENAMED;   // 改名后发布的新包烙新名
  f.catalog = { name: MARKET, plugins: [{ name: PLUGIN, version: "1.1.0", source: { source: "url", type: "zip",
    url: `https://github.com/${RENAMED}/releases/download/v1.1.0/${PLUGIN}-v1.1.0.zip`, sha256: f.manifest.asset.sha256,
    path: "plugins/" + PLUGIN, stripRoot: false } }] };
  f.intent = () => ({ release: clone(f.release), manifest: clone(f.manifest), channel: { ...f.channel(), repository: RENAMED } });
}
// GitHub 对改名仓库的任一旧名都 301 到同一仓库，响应体按当前名规范化：names 列出本夹具应答的 API 仓库名。
function renamedFetch(f, names = [REPOSITORY, RENAMED]) {
  const serve = new Set(names);
  return async (url) => {
    const api = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/releases\?per_page=100&page=1$/.exec(url);
    if (api) {
      if (!serve.has(api[1])) throw new Error("unexpected API name: " + api[1]);
      return Buffer.from(JSON.stringify(f.rows));
    }
    if (url === f.release.manifest.browser_download_url) return Buffer.from(JSON.stringify(f.manifest));
    if (url === f.release.archive.browser_download_url) return f.bytes;
    throw new Error("unexpected fetch: " + url);
  };
}
function renamedOptions(f, extra = {}) {
  return { ...f.options, fetchRelease: renamedFetch(f),
    prepareRelease: async (release) => {
      assert.equal(release.repository, RENAMED);
      const directory = fs.mkdtempSync(path.join(f.dir, "prepared-")); f.prepared.push(directory);
      return { directory, release, manifest: clone(f.manifest), cleanup: () => {
        f.cleanupCount++; fs.rmSync(directory, { recursive: true, force: true });
      } };
    }, ...extra };
}
test("renamed repository is probed after check and catalog failures, then retried under the new name", async (t) => {
  const f = fixture(t);
  renamedFixture(f);
  let probes = 0;
  f.options = renamedOptions(f, { probeRename: async (repo) => { probes++; assert.equal(repo, REPOSITORY); return RENAMED; } });
  f.updater = f.restart();
  await f.updater.request({ action: "check" });
  const status = f.updater.status();
  assert.equal(status.phase, "available", status.error);
  assert.equal(status.checkedVia, "release-api");
  assert.equal(probes, 1);
  const saved = readJson(f.stateFile);
  assert.deepEqual({ from: saved.repoMigration.from, to: saved.repoMigration.to }, { from: REPOSITORY, to: RENAMED });
  assert.equal(saved.repoMigration.at, 100000000);   // 夹具时钟
  await f.updater.request({ action: "update" });
  assert.equal(f.updater.status().phase, "updated", f.updater.status().error);
  assert.equal(f.syncs.length, 1);
  const record = readJson(f.recordFile).plugins[0];
  assert.equal(record.version, "1.1.0");
  assert.equal(record.source.url, `https://github.com/${RENAMED}/releases/download/v1.1.0/${PLUGIN}-v1.1.0.zip`);
  assert.equal(readJson(f.stateFile).repoMigration.to, RENAMED);   // 迁移记录跨安装保留
  assert.equal(probes, 1);                                          // 安装阶段不再探测
});

test("probe without a redirect keeps the original failure and never switches source or installs", async (t) => {
  const f = fixture(t);
  renamedFixture(f);
  let probes = 0;
  f.options = { ...f.options, probeRename: async () => { probes++; return null; }, fetchRelease: renamedFetch(f) };
  f.updater = f.restart();
  await f.updater.request({ action: "check" });
  const status = f.updater.status();
  assert.equal(status.phase, "error");
  assert.match(status.error, /资产来源或大小无效/);
  assert.doesNotMatch(status.error, /仓库已改名为/);   // 没有证据就不声称改名
  assert.equal(probes, 1);
  assert.equal(readJson(f.stateFile).repoMigration, null);
  assertNoInstall(f);
});

test("a persisted migration record short-circuits probing and checks directly under the new name", async (t) => {
  const f = fixture(t, { plugin_auto_update: false });
  renamedFixture(f);
  let probes = 0;
  f.options = { ...f.options, probeRename: async () => { probes++; throw new Error("must not probe"); },
    fetchRelease: renamedFetch(f, [RENAMED]) };
  f.updater = f.restart();
  writeJson(f.stateFile, { checkedAt: 1, lastAttempt: 1, repoMigration: { from: REPOSITORY, to: RENAMED, at: 1 } });
  await f.updater.request({ action: "check" });
  assert.equal(f.updater.status().phase, "available", f.updater.status().error);
  assert.equal(f.updater.status().checkedVia, "release-api");
  assert.equal(probes, 0);
});

test("verifyRuntimeSync accepts a migrated intent only with the persisted migration record", (t) => {
  const f = fixture(t);
  renamedFixture(f);
  fs.mkdirSync(path.join(f.record.installPath, ".zcode-plugin"), { recursive: true });
  writeJson(path.join(f.record.installPath, ".zcode-plugin", "plugin.json"), { name: PLUGIN, version: "1.1.0" });
  f.record.version = "1.1.0"; f.record.enabled = true;
  f.record.source = clone(f.catalog.plugins[0].source); f.writeRecord();
  const pendingRelease = { release: clone(f.release), manifest: clone(f.manifest), channel: { ...f.channel(), repository: RENAMED } };
  const run = () => verifyRuntimeSync({ runtime: f.runtime, pluginRoot: f.record.installPath, home: f.home, env: {} });
  const state = (repoMigration) => ({ checkedAt: 1, lastAttempt: 1, pendingSync: true, pendingVersion: "1.0.0", pendingPid: 0, pendingRelease, repoMigration });
  writeJson(f.stateFile, state({ from: REPOSITORY, to: RENAMED, at: 1 }));
  assert.equal(run().ok, true);
  writeJson(f.stateFile, state(null));
  assert.throws(run, /市场来源已变化/);   // 无记录：fail-closed
  writeJson(f.stateFile, state({ from: "other/repo", to: RENAMED, at: 1 }));
  assert.throws(run, /市场来源已变化/);   // 记录与注册名不匹配：fail-closed
  writeJson(f.stateFile, state({ from: REPOSITORY }));
  assert.throws(run, /市场来源已变化/);   // 缺 to 的残缺记录：fail-closed
  writeJson(f.stateFile, state({ from: REPOSITORY, to: "someone/else", at: 1 }));
  assert.throws(run, /市场来源已变化/);   // 记录的 to 与意图仓库不一致：fail-closed
  writeJson(f.stateFile, state({ from: REPOSITORY, to: RENAMED, at: 1 }));
  assert.equal(run().ok, true);
  // 同一份合法状态，缓存清单却变成源码形态 → 渠道种类 release→market：kind 恒严格，豁免不得放宽
  writeJson(f.catalogFile, { name: MARKET, plugins: [{ name: PLUGIN, version: "1.1.0", source: "./plugins/" + PLUGIN }] });
  assert.throws(run, /市场来源已变化/);
});

test("a migrated release whose package manifest still carries the old name is refused before install", async (t) => {
  const f = fixture(t);
  renamedFixture(f);
  f.manifest.repository = REPOSITORY;   // 改名前构建的包：渠道与清单已是新名，包内 manifest 仍烙旧名
  f.options = renamedOptions(f, { probeRename: async () => RENAMED });
  f.updater = f.restart();
  await f.updater.request({ action: "update" });
  assert.equal(f.updater.status().phase, "error");
  assert.match(f.updater.status().error, /manifest 与正式版本、来源或资源不一致/);
  assertNoInstall(f);   // 在宿主安装前就拒绝，不留下「版本已前进、运行目录未同步」的半成品
  assertCleaned(f);
  assert.equal(readJson(f.stateFile).pendingSync, false);
});

test("a failed retry under the new name never persists the migration record", async (t) => {
  const f = fixture(t);
  renamedFixture(f);
  const served = renamedFetch(f);
  f.options = renamedOptions(f, { probeRename: async () => RENAMED,
    fetchRelease: async (url) => {
      if (url.includes(`/repos/${RENAMED}/`)) throw new Error("fixture new-name API down");
      return served(url);
    } });
  // 旧名路径的清单兜底恰好刷新成功一次（据此判定失败并触发探测），随后宿主 CLI 离线：新名重试的兜底也失败。
  f.afterMarket = () => { f.marketError = "fixture marketplace offline"; };
  f.updater = f.restart();
  await f.updater.request({ action: "check" });
  assert.equal(f.updater.status().phase, "error");
  assert.match(f.updater.status().error, /仓库已改名为 ByteRax\/zcode-speed-bar，按新名重新检查仍失败：.*fixture new-name API down/);
  assert.equal(readJson(f.stateFile).repoMigration, null);   // 未经证实的目标不落盘，下轮检查重新从注册名判定
  assert.equal(f.updater.status().repoMigration, null);
  assertNoInstall(f);
});

test("a second rename is followed from the migrated name and the record keeps the registered name as origin", async (t) => {
  const f = fixture(t);
  renamedFixture(f);   // 仓库现名 RENAMED；记录还停在第一次改名后的 FIRST_RENAME
  const probed = [];
  f.options = renamedOptions(f, { fetchRelease: renamedFetch(f, [FIRST_RENAME, RENAMED]),
    probeRename: async (repo) => { probed.push(repo); return RENAMED; } });
  f.updater = f.restart();
  writeJson(f.stateFile, { checkedAt: 1, lastAttempt: 1, repoMigration: { from: REPOSITORY, to: FIRST_RENAME, at: 1 } });
  await f.updater.request({ action: "update" });
  assert.equal(f.updater.status().phase, "updated", f.updater.status().error);
  assert.deepEqual(probed, [FIRST_RENAME]);   // 从当前所在名继续追，而不是回到注册名
  const saved = readJson(f.stateFile).repoMigration;
  assert.deepEqual({ from: saved.from, to: saved.to }, { from: REPOSITORY, to: RENAMED });
});

test("renaming back to the registered name clears the migration record", async (t) => {
  const f = fixture(t);
  f.setRelease("1.1.0");   // 仓库已改回注册名：release 与清单都是注册名 URL
  const served = f.fetch;
  f.options = { ...f.options, probeRename: async (repo) => { assert.equal(repo, FIRST_RENAME); return REPOSITORY; },
    fetchRelease: async (url, limit) => url.startsWith(`https://api.github.com/repos/${FIRST_RENAME}/`)
      ? Buffer.from(JSON.stringify(f.rows)) : served(url, limit) };
  f.updater = f.restart();
  writeJson(f.stateFile, { checkedAt: 1, lastAttempt: 1, repoMigration: { from: REPOSITORY, to: FIRST_RENAME, at: 1 } });
  await f.updater.request({ action: "update" });
  assert.equal(f.updater.status().phase, "updated", f.updater.status().error);
  assert.equal(readJson(f.stateFile).repoMigration, null);
});

test("a probe answer that differs from the registered name only by case is treated as renaming back, using the registered spelling", async (t) => {
  const f = fixture(t);
  f.setRelease("1.1.0");   // 仓库在注册名上：release 与清单都是注册名 URL，f.fetch 只应答注册名的精确拼写
  const served = f.fetch;
  f.options = { ...f.options, probeRename: async () => REPOSITORY.toLowerCase(),
    fetchRelease: async (url, limit) => url.startsWith(`https://api.github.com/repos/${FIRST_RENAME}/`)
      ? Buffer.from(JSON.stringify(f.rows)) : served(url, limit) };
  f.updater = f.restart();
  writeJson(f.stateFile, { checkedAt: 1, lastAttempt: 1, repoMigration: { from: REPOSITORY, to: FIRST_RENAME, at: 1 } });
  await f.updater.request({ action: "update" });
  assert.equal(f.updater.status().phase, "updated", f.updater.status().error);   // 若按应答的小写拼写重查，served 会拒绝
  assert.equal(readJson(f.stateFile).repoMigration, null);
});

test("a persisted record whose origin differs from the registered name only by case is still honoured without probing", async (t) => {
  const f = fixture(t, { plugin_auto_update: false });
  renamedFixture(f);
  let probes = 0;
  f.options = renamedOptions(f, { probeRename: async () => { probes++; throw new Error("must not probe"); },
    fetchRelease: renamedFetch(f, [RENAMED]) });   // 旧名 API 不应被询问
  f.updater = f.restart();
  writeJson(f.stateFile, { checkedAt: 1, lastAttempt: 1, repoMigration: { from: REPOSITORY.toLowerCase(), to: RENAMED, at: 1 } });
  await f.updater.request({ action: "check" });
  assert.equal(f.updater.status().phase, "available", f.updater.status().error);
  assert.equal(probes, 0);
});

test("damaged migration records are dropped on load and a bad timestamp is sanitised to 0", async (t) => {
  const damaged = {
    "not an object (string)": "ByteRax/a",
    "array": [REPOSITORY, RENAMED],
    "missing to": { from: REPOSITORY, at: 1 },
    "null from and to": { from: null, to: null, at: 1 },
    "non-string to": { from: REPOSITORY, to: 42, at: 1 },
    "no slash": { from: "noslash", to: RENAMED, at: 1 },
    "URL form": { from: `https://github.com/${REPOSITORY}`, to: RENAMED, at: 1 },
    "from equals to": { from: REPOSITORY, to: REPOSITORY, at: 1 },
    "from equals to ignoring case": { from: "a/b", to: "A/B", at: 1 },
  };
  for (const [label, record] of Object.entries(damaged)) {
    const f = fixture(t);
    writeJson(f.stateFile, { checkedAt: 1, lastAttempt: 1, repoMigration: record });
    assert.equal(f.restart().status().repoMigration, null, label);
  }
  for (const at of ["yesterday", -5, 0, 1.5, null]) {
    const f = fixture(t);
    writeJson(f.stateFile, { checkedAt: 1, lastAttempt: 1, repoMigration: { from: REPOSITORY, to: RENAMED, at } });
    assert.deepEqual(f.restart().status().repoMigration, { from: REPOSITORY, to: RENAMED, at: 0 }, `at=${JSON.stringify(at)}`);
  }
  const f = fixture(t);
  writeJson(f.stateFile, { checkedAt: 1, lastAttempt: 1, repoMigration: { from: REPOSITORY, to: RENAMED, at: 123, extra: "dropped" } });
  assert.deepEqual(f.restart().status().repoMigration, { from: REPOSITORY, to: RENAMED, at: 123 });
});

test("verifyRuntimeSync fails closed with a clean rejection on malformed migration records and intents", (t) => {
  const f = fixture(t);
  renamedFixture(f);
  fs.mkdirSync(path.join(f.record.installPath, ".zcode-plugin"), { recursive: true });
  writeJson(path.join(f.record.installPath, ".zcode-plugin", "plugin.json"), { name: PLUGIN, version: "1.1.0" });
  f.record.version = "1.1.0"; f.record.enabled = true;
  f.record.source = clone(f.catalog.plugins[0].source); f.writeRecord();
  const intent = { release: clone(f.release), manifest: clone(f.manifest), channel: { ...f.channel(), repository: RENAMED } };
  const run = () => verifyRuntimeSync({ runtime: f.runtime, pluginRoot: f.record.installPath, home: f.home, env: {} });
  const write = (pendingRelease, repoMigration) => writeJson(f.stateFile, { checkedAt: 1, lastAttempt: 1, pendingSync: true,
    pendingVersion: "1.0.0", pendingPid: 0, pendingRelease, repoMigration });
  const clean = (error) => error instanceof Error && !(error instanceof TypeError) && /Release 更新意图无效|市场来源已变化/.test(error.message);
  write(intent, { from: REPOSITORY, to: RENAMED, at: 1 });
  assert.equal(run().ok, true);   // 对照：合法组合通过，下面的拒绝不是因为夹具本身坏了
  for (const record of [{ from: REPOSITORY, to: null, at: 1 }, { from: null, to: null, at: 1 }, { from: REPOSITORY, to: 42, at: 1 }, "ByteRax/a", [REPOSITORY, RENAMED]]) {
    write(intent, record);
    assert.throws(run, clean, JSON.stringify(record));   // 必须是干净的拒绝，不能是 TypeError
  }
  const noChannel = clone(intent); delete noChannel.channel;
  write(noChannel, { from: REPOSITORY, to: RENAMED, at: 1 });
  assert.throws(run, (error) => !(error instanceof TypeError) && /Release 更新意图无效/.test(error.message));
});

test("API normalised to the new name while the host cannot refresh the catalog still reaches the probe and migrates", async (t) => {
  const f = fixture(t);
  renamedFixture(f);
  f.marketError = "fixture marketplace offline";   // 代理环境常见：复合错误里只剩「资产来源」一支文案
  let probes = 0;
  f.options = renamedOptions(f, { probeRename: async (repo) => { probes++; assert.equal(repo, REPOSITORY); return RENAMED; } });
  f.updater = f.restart();
  await f.updater.request({ action: "check" });
  assert.equal(f.updater.status().phase, "available", f.updater.status().error);
  assert.equal(probes, 1);
  assert.equal(readJson(f.stateFile).repoMigration.to, RENAMED);
});

test("a stale migration record whose origin is not the registered name is ignored", async (t) => {
  const f = fixture(t);   // 注册名 REPOSITORY；夹具的 API 应答断言 URL 必须是注册名
  let probes = 0;
  f.options = { ...f.options, probeRename: async () => { probes++; return RENAMED; } };
  f.updater = f.restart();
  writeJson(f.stateFile, { checkedAt: 1, lastAttempt: 1, repoMigration: { from: "someone/old-name", to: RENAMED, at: 1 } });
  await f.updater.request({ action: "check" });
  assert.equal(f.updater.status().phase, "available", f.updater.status().error);
  assert.equal(f.updater.status().checkedVia, "release-api");
  assert.equal(probes, 0);
});

test("with a migration record the registered source must still match between check and install", async (t) => {
  const f = fixture(t);
  renamedFixture(f);
  const served = renamedFetch(f);
  let apiCalls = 0;
  f.options = renamedOptions(f, { probeRename: async () => RENAMED,
    fetchRelease: async (url, limit) => {
      const body = await served(url, limit);
      // 新名重查成功后（第 2 次 releases 请求），用户在检查与安装之间把注册来源的 ref 换掉
      if (url.includes("/releases?") && ++apiCalls === 2) writeJson(f.knownFile, { version: 1, marketplaces: [{ id: MARKET, source: { ...f.source, ref: "other-ref" } }] });
      return body;
    } });
  f.updater = f.restart();
  await f.updater.request({ action: "update" });
  assert.equal(f.updater.status().phase, "error");
  assert.match(f.updater.status().error, /更新期间市场来源已变化/);
  assertNoInstall(f);
});

test("a forged github flavor in the persisted intent cannot lift the migration exemption on a GitCode registration", (t) => {
  const f = fixture(t, {}, false, "gitcode");
  fs.mkdirSync(path.join(f.record.installPath, ".zcode-plugin"), { recursive: true });
  writeJson(path.join(f.record.installPath, ".zcode-plugin", "plugin.json"), { name: PLUGIN, version: "1.1.0" });
  const base = `https://github.com/${RENAMED}/releases/download/v1.1.0/`, name = `${PLUGIN}-v1.1.0.zip`;
  const bytes = Buffer.from("forged archive"), sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const release = validateRelease({ tag_name: "v1.1.0", draft: false, prerelease: false, assets: [
    { name, state: "uploaded", size: bytes.length, browser_download_url: base + name },
    { name: "release-manifest.json", state: "uploaded", size: 400, browser_download_url: base + "release-manifest.json" }] }, RENAMED);
  const manifest = { schemaVersion: 1, repository: RENAMED, version: "1.1.0", tag: "v1.1.0", pluginId: PLUGIN_ID,
    asset: { name, size: bytes.length, sha256: sha } };
  f.record.version = "1.1.0"; f.record.enabled = true;
  f.record.source = { source: "url", type: "zip", url: base + name, sha256: sha, path: "plugins/" + PLUGIN, stripRoot: false };
  f.writeRecord();
  // 注册来源是 GitCode 镜像，状态文件却自称 github flavor 并带一条迁移记录：豁免只认宿主注册来源，必须拒绝。
  writeJson(f.stateFile, { checkedAt: 1, lastAttempt: 1, pendingSync: true, pendingVersion: "1.0.0", pendingPid: 0,
    pendingRelease: { release, manifest, channel: { kind: "release", flavor: "github", repository: RENAMED, source: clone(f.source) } },
    repoMigration: { from: GITCODE_REPOSITORY, to: RENAMED, at: 1 } });
  assert.throws(() => verifyRuntimeSync({ runtime: f.runtime, pluginRoot: f.record.installPath, home: f.home, env: {} }), /市场来源已变化/);
});

test("GitCode channel never consults the rename probe, even when the catalog refresh fails", async (t) => {
  const f = fixture(t, {}, false, "gitcode");
  f.setGitcodeRelease("1.2.0");
  // 文案刻意命中 RENAME_SUSPECT：若回归让 gitcode 的失败误入 GitHub 的改名探测分支，探测会被调用。
  f.marketError = "GitHub Release 资产来源或大小无效";
  let probes = 0;
  f.options = { ...f.options, probeRename: async () => { probes++; return RENAMED; } };
  f.updater = f.restart();
  await f.updater.request({ action: "check" });
  assert.equal(f.updater.status().phase, "error");
  assert.equal(probes, 0);
  assert.equal(readJson(f.stateFile).repoMigration, null);
});

test("an invalid probe answer is ignored and the original failure is reported", async (t) => {
  for (const answer of [{ name: "owner/repo" }, "not a repository", "https://github.com/a/b", 42, "", true]) {
    const f = fixture(t);
    renamedFixture(f);
    f.options = renamedOptions(f, { probeRename: async () => answer });
    f.updater = f.restart();
    await f.updater.request({ action: "check" });
    assert.equal(f.updater.status().phase, "error", JSON.stringify(answer));
    assert.match(f.updater.status().error, /资产来源或大小无效/);
    assert.doesNotMatch(f.updater.status().error, /仓库已改名为/);
    assert.equal(readJson(f.stateFile).repoMigration, null);
    assertNoInstall(f);
  }
});

test("pure network failures never trigger the rename probe", async (t) => {
  const f = fixture(t);
  renamedFixture(f);
  let probes = 0;
  f.apiLimited = true; f.marketError = "fixture marketplace offline";   // 限流 + 宿主 CLI 刷新失败：没有任何来源校验信号
  f.options = { ...f.options, probeRename: async () => { probes++; return RENAMED; } };
  f.updater = f.restart();
  await f.updater.request({ action: "check" });
  assert.equal(f.updater.status().phase, "error");
  assert.match(f.updater.status().error, /Release 请求失败 \(403\)/);
  assert.match(f.updater.status().error, /渠道清单回退也失败/);
  assert.equal(probes, 0);   // 受限网络里不把失败的检查再拖长
  assert.equal(readJson(f.stateFile).repoMigration, null);
  assertNoInstall(f);
});

test("rate-limited API plus a catalog already carrying the new name still reaches the probe and migrates", async (t) => {
  const f = fixture(t);
  renamedFixture(f);
  const served = renamedFetch(f);
  let probes = 0;
  f.options = renamedOptions(f, { probeRename: async (repo) => { probes++; assert.equal(repo, REPOSITORY); return RENAMED; },
    fetchRelease: async (url, limit) => {
      if (url.includes(`/repos/${REPOSITORY}/`)) throw new Error("Release 请求失败 (403)");   // 旧名 API 配额耗尽
      return served(url, limit);
    } });
  f.updater = f.restart();
  await f.updater.request({ action: "check" });
  assert.equal(f.updater.status().phase, "available", f.updater.status().error);
  assert.equal(probes, 1);
  assert.equal(readJson(f.stateFile).repoMigration.to, RENAMED);
});

test("a probe that throws never masks the original failure", async (t) => {
  const f = fixture(t);
  renamedFixture(f);
  f.options = renamedOptions(f, { probeRename: async () => { throw new Error("probe exploded"); } });
  f.updater = f.restart();
  await f.updater.request({ action: "check" });
  assert.equal(f.updater.status().phase, "error");
  assert.match(f.updater.status().error, /资产来源或大小无效/);
  assert.doesNotMatch(f.updater.status().error, /probe exploded/);
  assert.doesNotMatch(f.updater.status().error, /仓库已改名为/);   // 探测抛错 ≠ 改回注册名，也不是改名证据
  assert.equal(readJson(f.stateFile).repoMigration, null);
  assertNoInstall(f);
});

test("an injected fetchRelease without probeRename keeps the rename probe off the real network", async (t) => {
  const https = require("https");
  const calls = [];
  for (const method of ["request", "get"]) {
    t.mock.method(https, method, (...args) => { calls.push(String(args[0])); throw new Error("network forbidden"); });
  }
  const f = fixture(t);
  renamedFixture(f);
  f.options = renamedOptions(f);   // 接管了网络层却没注入 probeRename：探测必须关闭，默认回归不得联网
  assert.equal(f.options.probeRename, undefined);
  f.updater = f.restart();
  await f.updater.request({ action: "check" });
  assert.equal(f.updater.status().phase, "error");
  assert.match(f.updater.status().error, /资产来源或大小无效/);
  assert.deepEqual(calls, []);
});

test("renamed repository: a real built ZIP for the new name installs through the migration path from an old-name registration", async (t) => {
  // 改名后才装、沿用旧安装命令的新用户（注册来源是旧名、没有 plugin-update.json），或改名后升级的老用户。
  const f = fixture(t);
  const run = promisify(execFile), repositoryRoot = path.resolve(__dirname, "..");
  const env = { HOME: f.home, USERPROFILE: f.home, TMPDIR: f.dir, PYTHONDONTWRITEBYTECODE: "1",
    PATH: process.env.PATH, LANG: "en_US.UTF-8" };
  const built = JSON.parse((await run("python3", ["-B", "-c", REAL_BUILD_SCRIPT, repositoryRoot, f.dir, RENAMED],
    { cwd: f.dir, env, timeout: 30000 })).stdout);
  const zip = fs.readFileSync(built.zip), manifestBytes = fs.readFileSync(built.manifest);
  renamedFixture(f, zip, readJson(built.manifest));
  f.catalog = readJson(built.catalog);
  const api = renamedFetch(f);
  const fetch = async (url, limit) => {
    if (url === f.release.manifest.browser_download_url) return manifestBytes;
    if (url === f.release.archive.browser_download_url) return zip;
    return api(url, limit);
  };
  const unpacked = [];
  f.options = renamedOptions(f, { fetchRelease: fetch, probeRename: async () => RENAMED,
    prepareRelease: async (release) => {
      f.events.push("prepare");
      const result = await downloadRelease(release, "python3", fetch, async (command, args) => {
        unpacked.push(args[args.indexOf("--repository") + 1]);
        return JSON.parse((await run(command, ["-B", ...args], { cwd: f.dir, env, timeout: 30000 })).stdout);
      });
      t.after(result.cleanup);
      return result;
    } });
  f.updater = f.restart();
  await f.updater.request({ action: "update" });
  assert.equal(f.updater.status().phase, "updated", f.updater.status().error);
  assert.deepEqual(unpacked, [RENAMED]);   // 真实解包器按新名复核真实打包出的 manifest
  assert.equal(f.syncs.length, 1);
  assert.equal(readJson(f.recordFile).plugins[0].source.url,
    `https://github.com/${RENAMED}/releases/download/v1.1.0/${PLUGIN}-v1.1.0.zip`);
  assert.equal(readJson(f.stateFile).repoMigration.to, RENAMED);
});

test("stale catalog after marketplace refresh is named as the cause, installer never launches (issue #247)", async (t) => {
  const f = fixture(t);
  f.setRelease("1.1.0");
  const stale = clone(f.catalog);
  stale.plugins[0].version = "1.0.9";
  stale.plugins[0].source.url = `https://github.com/${REPOSITORY}/releases/download/v1.0.9/${PLUGIN}-v1.0.9.zip`;
  // 模拟宿主 CLI「成功返回但没拉取」：清单停在旧版（3.17.2 静默失败回归）。
  f.afterMarket = () => writeJson(f.catalogFile, stale);
  await f.updater.request({ action: "update" });
  assert.equal(f.updater.status().phase, "error");
  assert.match(f.updater.status().error, /市场清单刷新后仍为 v1\.0\.9/);
  assert.match(f.updater.status().error, /未能拉取到 v1\.1\.0/);
  assert.equal(f.calls.filter((args) => args[0] === "install").length, 0);
  assert.equal(f.syncs.length, 0);
  assertCleaned(f);
  const saved = JSON.parse(fs.readFileSync(path.join(f.runtime, "plugin-update.json"), "utf8"));
  assert.equal(saved.lastFailure.version, "1.1.0");   // 失败目标身份照旧落盘
  assert.match(saved.lastError.message, /市场清单刷新后仍为 v1\.0\.9/);
});

test("transient empty marketplace CLI output is retried and the update still completes (issue #247)", async (t) => {
  const f = fixture(t);
  f.setRelease("1.1.0");
  f.marketTransientFailures = 2;   // 前两次静默失败，第三次成功
  await f.updater.request({ action: "update" });
  assert.equal(f.updater.status().phase, "updated");
  assert.equal(f.calls.filter((args) => args[0] === "marketplace").length, 3);
  assert.equal(f.calls.filter((args) => args[0] === "install").length, 1);
  assert.equal(f.syncs.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.runtime, "plugin-update.json"), "utf8")).lastError, null);
});

test("Release check success clears a persisted lastError (issue #247)", async (t) => {
  const f = fixture(t);
  f.setRelease("1.1.0");
  // 预置一次历史失败：market 渠道路径不会经过，验证的是 Release 分支的清除点
  writeJson(f.stateFile, { checkedAt: 1, lastAttempt: 1, lastError: { message: "历史失败", at: 1 } });
  await f.updater.request({ action: "check" });
  assert.equal(f.updater.status().phase, "available");
  assert.equal(f.updater.status().lastError, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.runtime, "plugin-update.json"), "utf8")).lastError, null);
});

test("cancelled install (channel changed mid-flight) records no lastError or lastFailure", async (t) => {
  const f = fixture(t);
  f.setRelease("1.1.0");
  f.afterPrepare = () => { f.source.ref = "changed-before-install"; f.writeKnown(); };
  await f.updater.request({ action: "update" });
  assert.equal(f.updater.status().phase, "error");   // 取消也走 error 相位提示来源变化
  assert.match(f.updater.status().error, /更新期间市场来源已变化/);
  const saved = JSON.parse(fs.readFileSync(path.join(f.runtime, "plugin-update.json"), "utf8"));
  assert.equal(saved.lastError, null);   // 取消类不算失败，不落盘
  assert.equal(saved.lastFailure, null);
  assert.equal(f.calls.filter((args) => args[0] === "install").length, 0);
  assertCleaned(f);
});

/* 「无正式版」与「超分页上限」是渠道健康信号而非故障（install-release §6），checkRelease
   抛出后必须直达用户、绝不触发渠道清单兜底——回退仅服务于 API 故障（限流/不可达）。 */
test("a healthy no-stable-release listing must not fall back to the channel catalog", async (t) => {
  const f = fixture(t);
  f.rows = [{ tag_name: "v9.9.9", draft: true, prerelease: false, assets: [] }];
  await f.updater.request({ action: "check" });
  const status = f.updater.status();
  assert.equal(status.phase, "error");
  assert.match(status.error, /不能安装开发分支/);
  assert.ok(!f.calls.some((args) => args[0] === "marketplace"), JSON.stringify(f.calls));
  assertNoInstall(f);
});

test("a full page without a stable release must not fall back to the channel catalog", async (t) => {
  const f = fixture(t);
  const page = Array.from({ length: 100 }, (_, i) => ({
    tag_name: "v9." + i + ".0", draft: false, prerelease: true, assets: [] }));
  f.options.fetchRelease = async (url) => {
    f.events.push("fetch");
    assert.match(String(url), /\/releases\?per_page=100&page=(10|[1-9])$/, String(url));
    return Buffer.from(JSON.stringify(page));
  };
  f.updater = f.restart();
  await f.updater.request({ action: "check" });
  const status = f.updater.status();
  assert.equal(status.phase, "error");
  assert.match(status.error, /安全分页上限/);
  assert.ok(!f.calls.some((args) => args[0] === "marketplace"), JSON.stringify(f.calls));
  assertNoInstall(f);
});

test("catalog-fallback Release intent recovers offline after restart and rejects a tampered sha256", async (t) => {
  const f = fixture(t);
  const { githubReleaseFromCatalog } = require("../plugin-release.cjs");
  f.release = githubReleaseFromCatalog(f.catalog, REPOSITORY);
  f.seedPending();
  const restored = f.restart(); await restored.tick();
  assert.equal(restored.status().phase, "updated", restored.status().error);
  assert.equal(readJson(f.stateFile).pendingRelease, null);

  const tampered = githubReleaseFromCatalog(f.catalog, REPOSITORY);
  tampered.catalogSha256 = "c".repeat(64);
  f.seedPending({ release: tampered, manifest: clone(f.manifest), channel: f.channel() });
  const blocked = f.restart(); await blocked.tick();
  assert.equal(blocked.status().phase, "error");
  assert.match(blocked.status().error, /SHA256 不一致/);
  assert.equal(readJson(f.stateFile).pendingSync, true);
  assert.equal(f.syncs.length, 1);
});

test("source-catalog marketplace reports up to date without installing when versions match", async (t) => {
  const f = sourceCatalogFixture(t, "1.0.0");
  await f.updater.request({ action: "check" });
  assert.equal(f.updater.status().phase, "current");
  assert.equal(f.updater.status().channel, "market");
  assertNoInstall(f);
});

test("source-catalog pending intent recovers through runtime sync after restart without demanding Release proof", async (t) => {
  const f = sourceCatalogFixture(t, "1.1.0");
  f.record.version = "1.1.0"; f.writeRecord();
  writeJson(f.stateFile, { checkedAt: 100000000, lastAttempt: 100000000, pendingSync: true,
    pendingVersion: "1.0.0", pendingPid: 0, pendingRelease: null });
  const restored = f.restart(); await restored.tick();
  assert.equal(restored.status().phase, "updated", restored.status().error);
  assert.equal(f.syncs.length, 1);
  assert.equal(readJson(f.stateFile).pendingSync, false);
});

/* SessionStart 的运行目录同步验收（overlay_install.py 调 verifyRuntimeSync）走的是另一条独立入口，
   直接读 plugin-update.json 与宿主安装记录。源码清单的仓库来源在这里也必须按 market 放行，
   否则 main 用户面板更新成功后，下次会话会以「缺少 Release 校验信息」拦停同步。 */
test("verifyRuntimeSync accepts a committed market intent for a source-catalog repository marketplace but still demands Release proof for zip catalogs", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.record.installPath, ".zcode-plugin"), { recursive: true });
  writeJson(path.join(f.record.installPath, ".zcode-plugin", "plugin.json"), { name: PLUGIN, version: "1.1.0" });
  f.record.version = "1.1.0"; f.record.enabled = true; f.writeRecord();
  writeJson(f.stateFile, { checkedAt: 1, lastAttempt: 1, pendingSync: true, pendingVersion: "1.0.0", pendingPid: 0, pendingRelease: null });
  const run = () => verifyRuntimeSync({ runtime: f.runtime, pluginRoot: f.record.installPath, home: f.home, env: {} });
  writeJson(f.catalogFile, { name: MARKET, plugins: [{ name: PLUGIN, version: "1.1.0", source: "./plugins/" + PLUGIN }] });
  const accepted = run();
  assert.equal(accepted.ok, true); assert.equal(accepted.identity.channel.kind, "market");
  writeJson(f.catalogFile, f.catalog);   // 同一注册来源、清单换成 Release zip → 仍是 release 渠道，无 Release 证据的意图不放行
  assert.throws(run, /缺少 Release 校验信息/);
});

test("manual check publishes checking before the update lock is taken and reports a busy lock instead of staying silent", async (t) => {
  const f = fixture(t);
  let seenAtLock = null;
  f.options.acquireLock = async () => { seenAtLock = clone(f.states[f.states.length - 1]); return null; };
  f.updater = f.restart();
  await f.updater.request({ action: "check" });
  assert.equal(seenAtLock.phase, "checking"); assert.equal(seenAtLock.busy, true);
  assert.equal(f.updater.status().phase, "error");
  assert.match(f.updater.status().error, /另一个更新进程仍在运行/);
  assert.equal(f.updater.status().busy, false);
  // 自动检查撞锁仍然静默，不把后台轮询的锁竞争当成错误弹给用户
  const g = fixture(t, { plugin_auto_update: true });
  g.options.acquireLock = async () => null;
  g.updater = g.restart();
  await g.updater.tick();
  assert.equal(g.updater.status().phase, "idle");
  assert.equal(g.states.some((s) => s.phase === "error" || s.phase === "checking"), false);
  assert.equal(g.events.includes("fetch"), false);
});

test("manual request while another check is in flight republishes the busy state", async (t) => {
  const f = fixture(t);
  let releaseLock;
  f.options.acquireLock = () => new Promise((resolve) => { releaseLock = () => resolve(() => {}); });
  f.updater = f.restart();
  const first = f.updater.request({ action: "check" });
  await new Promise((resolve) => setImmediate(resolve));
  f.states.length = 0;
  await f.updater.request({ action: "check" });
  assert.equal(f.states.length, 1); assert.equal(f.states[0].busy, true); assert.equal(f.states[0].phase, "checking");
  releaseLock(); await first;
  assert.equal(f.updater.status().busy, false);
});

test("Release check selects the newest stable package without catalog refresh, download or install", async (t) => {
  const f = fixture(t); f.setRelease("1.9.0");
  const older = clone(f.row); f.setRelease("1.10.0");
  const old = clone(f.row); old.tag_name = "screenshots-v65-hover-bubble";
  f.rows = [older, old, { ...f.row, draft: true }, { ...f.row, prerelease: true }, f.row];
  const before = fs.readFileSync(f.recordFile);
  await f.updater.request({ action: "check" });
  assert.equal(f.updater.status().phase, "available"); assert.equal(f.updater.status().channel, "release");
  assert.equal(f.updater.status().latestVersion, "1.10.0"); assert.equal(f.updater.status().releaseUrl, f.release.url);
  assert.deepEqual(f.events, ["fetch"]); assert.deepEqual(fs.readFileSync(f.recordFile), before);
  assert.equal(fs.existsSync(f.catalogFile), false); assertNoInstall(f);
});

for (const mode of ["manual", "auto"]) {
  test(`${mode} Release install validates before user-scope commit and sync, then cleans downloads`, async (t) => {
    const f = fixture(t);
    const known = fs.readFileSync(f.knownFile), config = fs.readFileSync(f.configFile);
    if (mode === "manual") await f.updater.request({ action: "update", path: "/untrusted/ignored" });
    else await f.updater.tick();
    assert.equal(f.updater.status().phase, "updated");
    assert.deepEqual(f.events, ["fetch", "list", "prepare", "marketplace", "list", "install", "sync", "cleanup"]);
    assert.deepEqual(f.calls, [["list"], ["marketplace", "update", MARKET], ["list"], ["install", PLUGIN_ID, "--scope", "user"]]);
    assert.deepEqual(readJson(f.recordFile).plugins[0].source, f.catalog.plugins[0].source);
    assert.equal(readJson(f.recordFile).plugins[0].version, "1.1.0");
    assert.equal(readJson(f.stateFile).pendingSync, false); assert.equal(readJson(f.stateFile).pendingRelease, null);
    assert.deepEqual(fs.readFileSync(f.knownFile), known); assert.deepEqual(fs.readFileSync(f.configFile), config);
    assertCleaned(f);
  });
  test(`${mode} Release install respects a disabled plugin`, async (t) => {
    const f = fixture(t); f.enabled = false;
    if (mode === "manual") await f.updater.request({ action: "update" }); else await f.updater.tick();
    assert.equal(f.updater.status().phase, "available");
    assert.deepEqual(f.events, ["fetch", "list"]); assertNoInstall(f);
  });
}

test("automatic opt-out survives restart without network while manual Release update remains available", async (t) => {
  const f = fixture(t, { plugin_auto_update: false });
  await f.updater.tick(); await f.restart().tick(); assert.deepEqual(f.events, []);
  await f.updater.request({ action: "update" }); assert.equal(f.updater.status().phase, "updated");
  assert.equal(readJson(f.configFile).plugin_auto_update, false); assertCleaned(f);
});

for (const version of ["1.1.0", "2.0.0"]) {
  test(`Release ${version} inventory never reinstalls or downgrades to 1.1.0`, async (t) => {
    const f = fixture(t); f.record.version = version; f.writeRecord();
    await f.updater.request({ action: "update" });
    assert.equal(f.updater.status().phase, "current"); assert.deepEqual(f.events, ["fetch"]); assertNoInstall(f);
  });
}

for (const change of ["disable", "newer inventory"]) {
  test(`Release rechecks ${change} after catalog refresh and cleans without installing`, async (t) => {
    const f = fixture(t);
    f.afterMarket = () => {
      if (change === "disable") writeJson(f.configFile, { plugin_auto_update: false });
      else { f.record.version = "2.0.0"; f.writeRecord(); }
    };
    await f.updater.tick(); assertNoInstall(f); assertCleaned(f);
    assert.deepEqual(f.events, ["fetch", "list", "prepare", "marketplace", "cleanup"]);
  });
}

test("disabling auto while Release preparation awaits prevents install without cancelling cleanup", async (t) => {
  const f = fixture(t);
  let resume, entered;
  const gate = new Promise((resolve) => { resume = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  f.afterPrepare = async () => { entered(); await gate; };
  const running = f.updater.tick();
  try { await started; await f.updater.request({ action: "auto", enabled: false }); }
  finally { resume(); await running; }
  assertNoInstall(f); assertCleaned(f); assert.equal(readJson(f.configFile).plugin_auto_update, false);
});

for (const mode of ["manual", "auto"]) {
  test(`${mode} empty formal Release listing refuses development-branch fallback`, async (t) => {
    const f = fixture(t); f.rows = [];
    if (mode === "manual") await f.updater.request({ action: "update" }); else await f.updater.tick();
    assert.equal(f.updater.status().phase, "error"); assert.match(f.updater.status().error, /正式 Release/);
    assert.deepEqual(f.events, ["fetch"]); assertNoInstall(f);
  });
}

for (const failure of ["download", "catalog fetch"]) {
  test(`Release ${failure} failure never invokes the installer or sync`, async (t) => {
    const f = fixture(t);
    if (failure === "download") f.prepareError = "fixture download SHA256 failure";
    if (failure === "catalog fetch") f.marketError = "fixture catalog fetch failure";
    await f.updater.request({ action: "update" });
    assert.equal(f.updater.status().phase, "error"); assert.equal(f.updater.status().pendingSync, false);
    assertNoInstall(f); assertCleaned(f); assert.equal(f.record.version, "1.0.0");
  });
}

test("Release install no longer gates on the marketplace catalog matching the Release; the installed record is still verified afterwards", async (t) => {
  const f = fixture(t);
  f.catalog.plugins[0].source.sha256 = "0".repeat(64);
  await f.updater.request({ action: "update" });
  assert.equal(f.calls.filter((args) => args[0] === "install").length, 1);   // 校验门已删：清单不一致也照常交给宿主安装
  assert.equal(f.updater.status().phase, "error");
  assert.match(f.updater.status().error, /官方安装结果与选定 Release 不一致/);   // 安装后复核仍在，不同步运行目录
  assert.equal(f.syncs.length, 0); assertCleaned(f);
});

for (const change of ["disabled", "uninstalled", "ref", "newer inventory"]) {
  test(`Release second inventory list rechecks ${change} before installer launch`, async (t) => {
    const f = fixture(t);
    f.afterList = (count) => {
      if (count !== 2) return;
      if (change === "disabled") f.enabled = false;
      if (change === "uninstalled") f.uninstalled = true;
      if (change === "ref") { f.source.ref = "changed-before-install"; f.writeKnown(); }
      if (change === "newer inventory") { f.record.version = "2.0.0"; f.writeRecord(); }
    };
    await f.updater.request({ action: "update" });
    if (change === "uninstalled" || change === "ref") assert.equal(f.updater.status().phase, "error");
    assertNoInstall(f); assertCleaned(f);
    assert.deepEqual(f.events, ["fetch", "list", "prepare", "marketplace", "list", "cleanup"]);
  });
}

for (const stage of ["fetch", "list", "prepare", "marketplace"]) {
  for (const change of ["repository", "directory", "ref"]) {
    test(`Release source ${change} change during ${stage} fails closed before install`, async (t) => {
      const f = fixture(t);
      const mutate = () => {
        if (change === "repository") f.source.repo = "other/" + PLUGIN;
        if (change === "directory") { delete f.source.repo; f.source.source = "directory"; f.source.path = f.dir; }
        if (change === "ref") f.source.ref = "different-release-channel";
        f.writeKnown();
      };
      f[{ fetch: "afterFetch", list: "afterList", prepare: "afterPrepare", marketplace: "afterMarket" }[stage]] = mutate;
      await f.updater.request({ action: "update" });
      assert.equal(f.updater.status().phase, "error"); assertNoInstall(f); assertCleaned(f);
    });
  }
}

const commitChanges = {
  version: (record) => { record.version = "1.2.0"; },
  hash: (record) => { record.source.sha256 = "0".repeat(64); },
  URL: (record) => { record.source.url = "https://github.com/other/repo/releases/download/v1.1.0/package.zip"; },
  type: (record) => { record.source.type = "tar"; },
  source: (record) => { record.source.source = "directory"; },
  path: (record) => { record.source.path = "plugins/other"; },
  stripRoot: (record) => { record.source.stripRoot = true; },
  headers: (record) => { record.source.headers = {}; },
};
for (const [name, change] of Object.entries(commitChanges)) {
  test(`committed Release ${name} mismatch stays pending and updater restarts never sync offline`, async (t) => {
    const f = fixture(t); f.changeCommit = change;
    const intent = f.intent();
    await f.updater.request({ action: "update" });
    assert.equal(f.updater.status().phase, "error"); assert.equal(f.updater.status().pendingSync, true);
    assert.match(f.updater.status().error, /Release/); assert.equal(f.syncs.length, 0);
    assert.deepEqual(readJson(f.stateFile).pendingRelease, intent); assertCleaned(f);
    await assertPendingBlocked(f, intent);
    assert.equal(f.calls.filter((args) => args[0] === "install").length, 1);
  });
}

test("mismatched commit remains pending when installer exits after recording a newer version", async (t) => {
  const f = fixture(t), intent = f.intent();
  f.installErrorAfterCommit = true; f.changeCommit = commitChanges.hash;
  await f.updater.request({ action: "update" });
  assert.equal(f.updater.status().phase, "error"); assert.equal(f.syncs.length, 0); assertCleaned(f);
  await assertPendingBlocked(f, intent);
});

test("market ref changed after installer commit preserves pending and blocks restart sync", async (t) => {
  const f = fixture(t), intent = f.intent();
  f.afterInstall = () => { f.source.ref = "changed-after-commit"; f.writeKnown(); };
  await f.updater.request({ action: "update" });
  assert.equal(f.updater.status().phase, "error"); assert.equal(f.syncs.length, 0); assertCleaned(f);
  await assertPendingBlocked(f, intent);
});

test("valid committed Release recovers from installer exit without reinstalling", async (t) => {
  const f = fixture(t); f.installErrorAfterCommit = true;
  await f.updater.request({ action: "update" });
  assert.equal(f.updater.status().phase, "updated"); assert.equal(f.syncs.length, 1);
  assert.equal(readJson(f.stateFile).pendingSync, false); assertCleaned(f);
});

test("valid Release pending survives sync failure and recovers offline after restart with auto disabled", async (t) => {
  const f = fixture(t); f.syncError = "fixture runtime busy";
  const intent = f.intent();
  await f.updater.request({ action: "update" });
  assert.equal(f.updater.status().phase, "error"); assert.equal(f.updater.status().pendingSync, true);
  assert.deepEqual(readJson(f.stateFile).pendingRelease, intent); assertCleaned(f);
  const events = [...f.events], calls = clone(f.calls);
  f.syncError = null; f.offline = true; writeJson(f.configFile, { plugin_auto_update: false });
  const restored = f.restart(); await restored.tick();
  assert.equal(restored.status().phase, "updated"); assert.equal(restored.status().auto, false);
  assert.deepEqual(f.events, [...events, "sync"]); assert.deepEqual(f.calls, calls);
  assert.equal(f.syncs.length, 2); assert.equal(readJson(f.stateFile).pendingRelease, null);
  await f.restart().tick(); assert.equal(f.syncs.length, 2);
});

test("valid saved Release intent recovers offline even when the catalog is absent", async (t) => {
  const f = fixture(t, { plugin_auto_update: false }); f.seedPending(); f.offline = true;
  const restored = f.restart(); await restored.tick();
  assert.equal(restored.status().phase, "updated"); assert.deepEqual(f.events, ["sync"]);
  assert.equal(fs.existsSync(f.catalogFile), false); assert.equal(readJson(f.stateFile).pendingSync, false);
});

test("live installer PID keeps committed Release pending across restarts without sync", async (t) => {
  const f = fixture(t); f.seedPending();
  const intent = readJson(f.stateFile); intent.pendingPid = process.pid; writeJson(f.stateFile, intent); f.offline = true;
  for (let i = 0; i < 2; i++) {
    const restored = f.restart(); await restored.tick();
    assert.equal(restored.status().phase, "updating"); assert.equal(restored.status().pendingSync, true);
  }
  assert.deepEqual(f.events, []); assert.equal(readJson(f.stateFile).pendingPid, process.pid);
});

for (const failure of ["exception", "success without commit"]) {
  test(`Release installer ${failure} clears uncommitted intent without sync`, async (t) => {
    const f = fixture(t);
    f.installErrorBeforeCommit = failure === "exception"; f.skipCommit = failure === "success without commit";
    await f.updater.tick();
    assert.equal(f.updater.status().phase, "error"); assert.equal(f.updater.status().pendingSync, false);
    assert.equal(f.updater.status().lastAttempt, 0); assert.equal(f.syncs.length, 0); assertCleaned(f);
    assert.equal(readJson(f.stateFile).pendingRelease, null);
    f.installErrorBeforeCommit = false; f.skipCommit = false; await f.updater.tick();
    assert.equal(f.updater.status().phase, "updated"); assert.equal(f.syncs.length, 1); assertCleaned(f);
  });
}

const intentChanges = {
  "missing channel": (intent) => { delete intent.channel; },
  "wrong channel ref": (intent) => { intent.channel.source.ref = "wrong-ref"; },
  "wrong repository": (intent) => { intent.release.repository = "other/" + PLUGIN; },
  "wrong tag": (intent) => { intent.release.tag = "screenshots-v65"; },
  "wrong manifest version": (intent) => { intent.manifest.version = "9.0.0"; },
  "wrong manifest identity": (intent) => { intent.manifest.pluginId = PLUGIN + "@other"; },
  "wrong manifest hash": (intent) => { intent.manifest.asset.sha256 = "not-a-sha256"; },
  "wrong archive size": (intent) => { intent.release.archive.size++; },
};
for (const [name, change] of Object.entries(intentChanges)) {
  test(`persisted Release intent with ${name} remains pending and never syncs`, async (t) => {
    const f = fixture(t), intent = f.intent(); change(intent); f.seedPending(intent);
    await assertPendingBlocked(f, intent);
  });
}
for (const value of [false, "damaged", [], {}, null]) {
  test(`remote pending ${JSON.stringify(value)} cannot degrade to unvalidated legacy sync`, async (t) => {
    const f = fixture(t); f.seedPending(value); await assertPendingBlocked(f, value);
  });
}

for (const change of ["ref", "repository", "directory"]) {
  test(`committed pending refuses offline recovery after registered channel ${change} changes`, async (t) => {
    const f = fixture(t), intent = f.intent(); f.seedPending(intent);
    if (change === "ref") f.source.ref = "changed-while-closed";
    if (change === "repository") f.source.repo = "other/" + PLUGIN;
    if (change === "directory") { f.source.source = "directory"; delete f.source.repo; f.source.path = f.dir; }
    f.writeKnown(); await assertPendingBlocked(f, intent);
  });
}

test("valid saved pending releases a dead installer PID and recovers offline", async (t) => {
  const f = fixture(t, { plugin_auto_update: false }); f.seedPending();
  const intent = readJson(f.stateFile); intent.pendingPid = 2147483647; writeJson(f.stateFile, intent); f.offline = true;
  const restored = f.restart(); await restored.tick();
  assert.equal(restored.status().phase, "updated"); assert.deepEqual(f.events, ["sync"]);
  assert.equal(readJson(f.stateFile).pendingPid, 0); assert.equal(readJson(f.stateFile).pendingRelease, null);
});

for (const stage of ["marketplace", "list"]) {
  test(`local source changed to GitHub during ${stage} never uses development update or Release install`, async (t) => {
    const f = fixture(t);
    delete f.source.repo; delete f.source.ref;
    f.source.source = "directory"; f.source.path = path.join(f.dir, "local-market"); f.writeKnown();
    const record = fs.readFileSync(f.recordFile);
    f.options.cli = async (args) => {
      f.calls.push([...args]); f.events.push(args[0]);
      if (args[0] === "marketplace") assert.deepEqual(args, ["marketplace", "update", MARKET]);
      else assert.deepEqual(args, ["list", "--available"]);
      if (args[0] === stage) {
        delete f.source.path;
        Object.assign(f.source, { source: "github", repo: REPOSITORY, ref: "plugin-releases" });
        f.writeKnown();
      }
      return args[0] === "marketplace" ? { diagnostics: [] } : {
        installed: [{ id: PLUGIN_ID, scope: "user", version: "1.0.0", enabled: true }],
        available: [{ id: PLUGIN_ID, version: "1.1.0" }], diagnostics: [],
      };
    };
    const updater = f.restart(); await updater.request({ action: "update" });
    assert.equal(updater.status().phase, "error"); assert.match(updater.status().error, /来源已变化/);
    assertNoInstall(f); assertCleaned(f);
    assert.deepEqual(f.calls, [["marketplace", "update", MARKET], ["list", "--available"]]);
    assert.deepEqual(f.events, ["marketplace", "list"]);
    assert.deepEqual(fs.readFileSync(f.recordFile), record); assert.equal(readJson(f.stateFile).pendingSync, false);
  });
}

test("user config custom storage supplies Release known source, inventory and catalog without default records", async (t) => {
  const f = fixture(t, {}, true);
  assert.deepEqual(f.options.env, {}); assert.equal(fs.existsSync(f.defaultInventory), false);
  assert.equal(readJson(path.join(f.home, ".zcode", "cli", "config.json")).storage.dir, f.storageDir);
  const known = fs.readFileSync(f.knownFile);
  const updater = f.restart(); assert.equal(updater.status().supported, true);
  await updater.request({ action: "check" });
  assert.equal(updater.status().phase, "available"); assertNoInstall(f);
  await updater.request({ action: "update" });
  assert.equal(updater.status().phase, "updated", updater.status().error);
  assert.deepEqual(f.calls, [["list"], ["marketplace", "update", MARKET], ["list"], ["install", PLUGIN_ID, "--scope", "user"]]);
  assert.equal(readJson(f.recordFile).plugins[0].version, f.release.version);
  assert.deepEqual(readJson(f.recordFile).plugins[0].source, f.catalog.plugins[0].source);
  assert.deepEqual(readJson(f.catalogFile), f.catalog); assert.deepEqual(fs.readFileSync(f.knownFile), known);
  assert.deepEqual(f.syncs, [f.record.installPath]); assertCleaned(f);
  assert.equal(fs.existsSync(f.defaultInventory), false);
});

test("custom storage Release pending recovers offline after auto update and sync failure without default inventory", async (t) => {
  const f = fixture(t, {}, true); f.syncError = "fixture custom runtime busy";
  const updater = f.restart(); await updater.tick();
  assert.equal(updater.status().supported, true); assert.equal(updater.status().pendingSync, true);
  assert.deepEqual(readJson(f.recordFile).plugins[0].source, f.catalog.plugins[0].source);
  assert.deepEqual(readJson(f.stateFile).pendingRelease, f.intent()); assertCleaned(f);
  const calls = clone(f.calls), events = [...f.events];
  f.offline = true; f.syncError = null; writeJson(f.configFile, { plugin_auto_update: false });
  const restored = f.restart(); await restored.tick();
  assert.equal(restored.status().phase, "updated", restored.status().error);
  assert.equal(restored.status().auto, false); assert.deepEqual(f.calls, calls);
  assert.deepEqual(f.events, [...events, "sync"]); assert.equal(f.syncs.length, 2);
  assert.equal(readJson(f.stateFile).pendingRelease, null);
  assert.equal(fs.existsSync(f.defaultInventory), false); assert.deepEqual(f.options.env, {});
});

// Real build -> downloadRelease -> Python unpack, with synthetic source files only.
// No Git, credentials, package hooks, real inventory or external HTTP is involved.
test("Release updater installs a real built ZIP through downloadRelease and unpack with stubbed HTTP", async (t) => {
  const f = fixture(t);
  const run = promisify(execFile), repositoryRoot = path.resolve(__dirname, "..");
  const env = { HOME: f.home, USERPROFILE: f.home, TMPDIR: f.dir, PYTHONDONTWRITEBYTECODE: "1",
    PATH: process.env.PATH, LANG: "en_US.UTF-8" };
  const code = REAL_BUILD_SCRIPT;
  const built = JSON.parse((await run("python3", ["-B", "-c", code, repositoryRoot, f.dir, REPOSITORY],
    { cwd: f.dir, env, timeout: 30000 })).stdout);
  f.setRelease("1.1.0", fs.readFileSync(built.zip), readJson(built.manifest));
  f.catalog = readJson(built.catalog);
  const downloadCalls = [];
  const fetch = async (url, limit) => {
    downloadCalls.push(url);
    const bytes = url === f.release.manifest.browser_download_url ? fs.readFileSync(built.manifest)
      : url === f.release.archive.browser_download_url ? fs.readFileSync(built.zip) : null;
    assert.ok(bytes, "unexpected download URL"); assert.ok(bytes.length <= limit); return bytes;
  };
  const prepared = [];
  f.options.prepareRelease = async (release) => {
    f.events.push("prepare");
    const result = await downloadRelease(release, "python3", fetch, async (command, args) => {
      assert.equal(command, "python3"); assert.equal(args[0], path.join(repositoryRoot, "release_unpack.py"));
      return JSON.parse((await run(command, ["-B", ...args], { cwd: f.dir, env, timeout: 30000 })).stdout);
    });
    prepared.push(result.directory); t.after(result.cleanup);
    const pluginManifest = readJson(path.join(result.pluginRoot, ".zcode-plugin", "plugin.json"));
    assert.equal(pluginManifest.version, "1.1.0");
    assert.equal(fs.readFileSync(path.join(result.marketplaceRoot, "LICENSE"), "utf8"), "not executable fixture source\n");
    const cleanup = result.cleanup;
    return { ...result, cleanup: () => { f.events.push("cleanup"); cleanup(); } };
  };
  const updater = f.restart(); await updater.request({ action: "update" });
  assert.equal(updater.status().phase, "updated", updater.status().error);
  assert.deepEqual(downloadCalls, [f.release.manifest.browser_download_url, f.release.archive.browser_download_url]);
  assert.deepEqual(f.events, ["fetch", "list", "prepare", "marketplace", "list", "install", "sync", "cleanup"]);
  assert.equal(f.syncs.length, 1);
  for (const directory of prepared) assert.equal(fs.existsSync(directory), false);
});

test("Release manual update leaves checking as soon as the version is known and publishes download, verify, install and sync progress", async (t) => {
  const f = fixture(t);
  f.progressSteps = [{ stage: "download", loaded: 8, total: 17 }, { stage: "download", loaded: 17, total: 17 }, { stage: "verify" }];
  await f.updater.request({ action: "update" });
  const phases = f.states.map((s) => s.phase);
  const first = (phase) => phases.indexOf(phase);
  // 修复前：checking 之后直到宿主安装器启动都没有再 publish，整个下载期面板停在「正在检查更新」。
  assert.ok(first("checking") >= 0 && first("available") > first("checking"), phases.join(","));
  assert.ok(first("downloading") > first("available") && first("updating") > first("downloading"), phases.join(","));
  const progress = f.states.filter((s) => s.progress).map((s) => [s.phase, s.progress.stage, s.progress.loaded, s.progress.total]);
  assert.deepEqual(progress[0], ["downloading", "download", 0, 17]);   // 下载开始前即推送总大小
  assert.ok(progress.some((p) => p[0] === "downloading" && p[1] === "download" && p[2] === 17 && p[3] === 17), "download completion published");
  assert.ok(progress.some((p) => p[0] === "downloading" && p[1] === "verify"), "verify stage published");
  assert.ok(progress.some((p) => p[0] === "updating" && p[1] === "install"), "install stage published");
  assert.ok(progress.some((p) => p[0] === "updating" && p[1] === "sync"), "sync stage published");
  const done = f.updater.status();
  assert.equal(done.phase, "updated"); assert.equal(done.progress, null); assert.equal(f.record.version, "1.1.0");
  assertCleaned(f);
});

test("Release download byte progress is throttled but stage changes and completion always publish", async (t) => {
  const f = fixture(t);
  f.progressSteps = [{ stage: "download", loaded: 1, total: 17 }, { stage: "download", loaded: 2, total: 17 },
    { stage: "download", loaded: 3, total: 17 }, { stage: "download", loaded: 17, total: 17 }, { stage: "verify" }];
  await f.updater.request({ action: "update" });
  // 夹具时钟固定，节流窗口内的中间字节进度不重复推送；首个回调、完成与阶段切换必须推送。
  const loaded = f.states.filter((s) => s.progress && s.progress.stage === "download").map((s) => s.progress.loaded);
  assert.deepEqual(loaded, [0, 1, 17]);
});

test("Release update abandoned after download returns to available without stale progress", async (t) => {
  const f = fixture(t);
  f.afterList = (count) => { if (count === 2) { f.record.version = "2.0.0"; f.writeRecord(); } };
  await f.updater.request({ action: "update" });
  const status = f.updater.status();
  assert.equal(status.phase, "available"); assert.equal(status.progress, null);
  assertNoInstall(f); assertCleaned(f);
});

test("GitCode channel checks the version from the host-refreshed catalog without any GitHub API call", async (t) => {
  const f = fixture(t, {}, false, "gitcode");
  f.setGitcodeRelease("1.2.0");
  await f.updater.request({ action: "check" });
  assert.equal(f.updater.status().phase, "available");
  assert.equal(f.updater.status().channel, "release");
  assert.equal(f.updater.status().channelHost, "gitcode");
  assert.equal(f.updater.status().latestVersion, "1.2.0");
  assert.equal(f.updater.status().releaseUrl, f.release.url);
  assert.deepEqual(f.events, ["marketplace"]);
  assertNoInstall(f);
});

test("GitCode channel up-to-date version never offers an install", async (t) => {
  const f = fixture(t, {}, false, "gitcode");
  f.record.version = "1.2.0"; f.writeRecord();
  f.setGitcodeRelease("1.2.0");
  await f.updater.request({ action: "check" });
  assert.equal(f.updater.status().phase, "current");
  assert.deepEqual(f.events, ["marketplace"]);
  assertNoInstall(f);
});

test("GitCode channel installs through gitcode URLs with the upstream manifest identity", async (t) => {
  const f = fixture(t, {}, false, "gitcode");
  f.setGitcodeRelease("1.1.0");
  await f.updater.request({ action: "update" });
  assert.equal(f.updater.status().phase, "updated", f.updater.status().error);
  assert.deepEqual(f.events, ["marketplace", "list", "prepare", "marketplace", "list", "install", "sync", "cleanup"]);
  assert.equal(f.syncs.length, 1); assertCleaned(f);
  assert.ok(f.prepared.length);
});

test("GitCode channel installs a real built ZIP via downloadRelease and unpack, keeping the upstream repository identity", async (t) => {
  const f = fixture(t, {}, false, "gitcode");
  const run = promisify(execFile), repositoryRoot = path.resolve(__dirname, "..");
  const env = { HOME: f.home, USERPROFILE: f.home, TMPDIR: f.dir, PYTHONDONTWRITEBYTECODE: "1",
    PATH: process.env.PATH, LANG: "en_US.UTF-8" };
  const code = `
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("fixture_builder", Path(sys.argv[1]) / "release_tool.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)
root = Path(sys.argv[2]) / "source"
for name in tool.NAMES:
    p = root / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"not executable fixture source\\n")
plugin = {"name": tool.PLUGIN, "version": "1.1.0", "commands": "commands", "skills": "skills",
         "packageLayout": {"schemaVersion": 1, "files": list(tool.NAMES)}}
for name in (".zcode-plugin/plugin.json", ".claude-plugin/plugin.json"):
    (root / tool.PREFIX / name).write_text(json.dumps(plugin))
(root / "marketplace.json").write_text(json.dumps({"name": "zusage-marketplace", "plugins": [
    {"name": tool.PLUGIN, "version": "1.1.0", "source": "./plugins/" + tool.PLUGIN}]}))
for name in (".mcp.json", "hooks/hooks.json"):
    (root / tool.PREFIX / name).write_text("{}")
for name in tool.SYNC_FILES:
    (root / name).write_bytes((root / tool.PREFIX / name).read_bytes())
script = (Path(sys.argv[1]) / "release_tool.py").read_bytes()
(root / "release_tool.py").write_bytes(script)
print(json.dumps(tool.build(root, sys.argv[3], Path(sys.argv[2]) / "assets")))
`;
  const built = JSON.parse((await run("python3", ["-B", "-c", code, repositoryRoot, f.dir, REPOSITORY],
    { cwd: f.dir, env, timeout: 30000 })).stdout);
  f.setGitcodeRelease("1.1.0", fs.readFileSync(built.zip), readJson(built.manifest));
  f.catalog = readJson(built.catalog);
  f.catalog.plugins[0].source.url = f.release.archive.browser_download_url;
  f.release = gitcodeReleaseFromCatalog(f.catalog, GITCODE_REPOSITORY);
  const downloadCalls = [];
  const prepared = [];
  const fetch = async (url, limit) => {
    downloadCalls.push(url);
    const bytes = url === f.release.manifest.browser_download_url ? fs.readFileSync(built.manifest)
      : url === f.release.archive.browser_download_url ? fs.readFileSync(built.zip) : null;
    assert.ok(bytes, "unexpected download URL"); assert.ok(bytes.length <= limit); return bytes;
  };
  f.options.prepareRelease = async (release) => {
    f.events.push("prepare");
    const result = await downloadRelease(release, "python3", fetch, async (command, args) => {
      assert.equal(command, "python3"); assert.equal(args[0], path.join(repositoryRoot, "release_unpack.py"));
      return JSON.parse((await run(command, ["-B", ...args], { cwd: f.dir, env, timeout: 30000 })).stdout);
    });
    prepared.push(result.directory); t.after(result.cleanup);
    const pluginManifest = readJson(path.join(result.pluginRoot, ".zcode-plugin", "plugin.json"));
    assert.equal(pluginManifest.version, "1.1.0");
    const cleanup = result.cleanup;
    return { ...result, cleanup: () => { f.events.push("cleanup"); cleanup(); } };
  };
  const updater = f.restart(); await updater.request({ action: "update" });
  assert.equal(updater.status().phase, "updated", updater.status().error);
  assert.deepEqual(downloadCalls, [f.release.manifest.browser_download_url, f.release.archive.browser_download_url]);
  assert.ok(downloadCalls.every((url) => url.startsWith("https://gitcode.com/")));
  assert.deepEqual(f.events, ["marketplace", "list", "prepare", "marketplace", "list", "install", "sync", "cleanup"]);
  assert.equal(f.syncs.length, 1);
});
