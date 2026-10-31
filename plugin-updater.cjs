"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile, spawn } = require("child_process");
const crypto = require("crypto");
const { isDeepStrictEqual } = require("util");
const releaseChannel = require("./plugin-release.cjs");
const { resolvePluginStorage } = require("./plugin-storage.cjs");

const PLUGIN_ID = "zcode-token-usage-statusbar@zusage-marketplace";
const INTERVAL_MS = 60 * 60 * 1000;

function compareVersions(a, b) {
  const parse = (v) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v || "");
  const aa = parse(a), bb = parse(b);
  if (!aa || !bb) throw new Error("插件版本号缺失或不是语义版本，无法确认更新状态");
  for (let i = 1; i <= 3; i++) {
    if (Number(aa[i]) !== Number(bb[i])) return Number(aa[i]) > Number(bb[i]) ? 1 : -1;
  }
  if (!aa[4] && !bb[4]) return 0;
  if (!aa[4]) return 1;
  if (!bb[4]) return -1;
  const ap = aa[4].split("."), bp = bb[4].split(".");
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === bp[i]) continue;
    if (ap[i] === undefined) return -1;
    if (bp[i] === undefined) return 1;
    const an = /^\d+$/.test(ap[i]), bn = /^\d+$/.test(bp[i]);
    if (an && bn) return Number(ap[i]) > Number(bp[i]) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return ap[i] > bp[i] ? 1 : -1;
  }
  return 0;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}
function readConfig(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch (e) { return e.code === "ENOENT" ? {} : null; }
}
function writeJson(file, value) {
  const tmp = file + "." + process.pid + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { }
  }
}
function runFile(command, args, options, input, onSpawn) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, options, (error, stdout, stderr) => {
      let data;
      try { data = JSON.parse(stdout); } catch (e) { }
      if (error) {
        const detail = data && data.diagnostics && data.diagnostics.map((d) => d.message).join("; ");
        reject(new Error(detail || String(stderr || error.message).trim().slice(0, 1000)));
      } else if (!data) reject(new Error("插件管理器没有返回有效 JSON"));
      else resolve(data);
    });
    if (onSpawn) {
      try { if (child.pid) onSpawn(child.pid); }
      catch (e) { child.kill(); reject(e); }
    }
    if (input !== undefined) { child.stdin.on("error", () => {}); child.stdin.end(input); }
  });
}

async function updateConfig(runtime, changes, python, defaults) {
  const result = await runFile(python, [path.join(__dirname, "runtime_lock.py"), "--update-config", runtime], {
    windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
  }, JSON.stringify({ changes, defaults }));
  if (result.ok !== true || typeof result.changed !== "boolean") throw new Error("配置更新没有返回有效确认");
  return result;
}

function readState(file, currentTime) {
  const value = readJson(file, {});
  const saved = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const timestamp = (v) => Number.isSafeInteger(v) && v >= 0 && v <= currentTime ? v : 0;
  let pendingVersion = "";
  try { if (typeof saved.pendingVersion === "string") { compareVersions(saved.pendingVersion, saved.pendingVersion); pendingVersion = saved.pendingVersion; } } catch (e) { }
  // lastFailure：上次安装失败的目标身份（版本 + 语义化校验 + 渠道）。损坏即丢弃，
  // 绝不让坏记录冒充「已安装」或「已成功」——它只供更新日志卡片标注失败目标。
  let lastFailure = null;
  if (saved.lastFailure && typeof saved.lastFailure === "object" && !Array.isArray(saved.lastFailure)) {
    const f = saved.lastFailure;
    try {
      if (typeof f.version === "string" && compareVersions(f.version, f.version) === 0 &&
          Number.isSafeInteger(f.at) && f.at > 0 && f.at <= currentTime &&
          (f.channel === "release" || f.channel === "market")) {
        lastFailure = { version: f.version, at: f.at, channel: f.channel };
      }
    } catch (e) { }
  }
  return { checkedAt: timestamp(saved.checkedAt), lastAttempt: timestamp(saved.lastAttempt),
    pendingSync: saved.pendingSync === true, pendingVersion,
    pendingPid: Number.isSafeInteger(saved.pendingPid) && saved.pendingPid > 0 ? saved.pendingPid : 0,
    pendingRelease: saved.pendingRelease === undefined || saved.pendingRelease === null ? null : saved.pendingRelease,
    lastFailure };
}
function legacyLockBusy(runtime) {
  // An already-running wx updater cannot honor v2 locks. Respect its live owner,
  // never unlink its file, and retire old updater processes by restarting ZCode.
  const file = path.join(runtime, "plugin-update.lock");
  try {
    const owner = readJson(file, {});
    if (owner && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); return true; }
      catch (e) { return e.code !== "ESRCH"; }
    }
    return Date.now() - fs.statSync(file).mtimeMs < 600000;
  } catch (e) { if (e.code === "ENOENT") return false; throw e; }
}
function acquireUpdateLock(runtime, python, helper) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [helper, "--hold", path.join(runtime, "plugin-update-v2.lock")], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false, output = "", detail = "";
    const timer = setTimeout(() => fail(new Error("插件更新锁未返回就绪状态")), 10000);
    const fail = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.stdin.destroy(); child.kill(); reject(error);
    };
    child.stdin.on("error", () => {});
    child.once("error", fail);
    child.stderr.on("data", (chunk) => { detail = (detail + chunk).slice(0, 1000); });
    child.once("close", (code) => {
      if (!settled) fail(new Error(detail.trim() || `插件更新锁进程提前退出 (${code})`));
    });
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      output += chunk;
      if (output.length > 1000) { fail(new Error("插件更新锁返回无效 JSON")); return; }
      if (!output.includes("\n")) return;
      let data;
      try { data = JSON.parse(output.trim()); } catch (e) { fail(new Error("插件更新锁返回无效 JSON")); return; }
      if (!data || typeof data.locked !== "boolean" || Object.keys(data).length !== 1) {
        fail(new Error("插件更新锁返回无效 JSON")); return;
      }
      settled = true; clearTimeout(timer);
      if (!data.locked) { child.stdin.end(); resolve(null); return; }
      let releasing;
      resolve(() => {
        if (!releasing) releasing = new Promise((done) => {
          if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
          child.once("close", done); child.stdin.end();
        });
        return releasing;
      });
    });
  });
}

// 渠道身份只比 kind/repository/source；flavor 由 source 可推导，不参与比较，
// 这样旧版本持久化的更新意图（无 flavor 字段）在新代码下仍然等价，不会误判来源变化。
function sameChannel(a, b) {
  return !!a && !!b && a.kind === b.kind && (a.repository || "") === (b.repository || "") &&
    isDeepStrictEqual(a.source === undefined ? null : a.source, b.source === undefined ? null : b.source);
}
function channelFlavor(channel) {
  // 持久化意图的渠道形态：注册为 GitCode git 来源即镜像渠道，其余远端一律按 GitHub 校验。
  return !!(channel && channel.source && channel.source.source === "git" &&
    releaseChannel.gitcodeRepository(channel.source.url)) ? "gitcode" : "github";
}

function verifyCommittedRelease(record, expected, currentChannel) {
  const release = expected && expected.release, manifest = expected && expected.manifest;
  if (!release || !manifest || !expected.channel || !sameChannel(currentChannel, expected.channel)) throw new Error("Release 更新意图无效或市场来源已变化，停止运行时同步");
  const flavor = expected.channel.flavor || channelFlavor(expected.channel);
  // GitHub 意图有两个来源：API 行（archive.size 有效）与清单兜底（catalogSha256 标记），
  // 各用同源形状门复核；GitCode 意图只来自渠道清单。
  const validated = flavor === "gitcode"
    ? releaseChannel.validateGitcodeRelease(release)
    : release.catalogSha256 !== undefined
      ? releaseChannel.validateGithubCatalogRelease(release)
      : releaseChannel.validateRelease({ tag_name: release.tag, draft: false, prerelease: false,
        assets: [release.archive, release.manifest] }, release.repository);
  if (!validated || validated.version !== release.version || expected.channel.kind !== "release" ||
      flavor !== validated.flavor ||
      !releaseChannel.sameRepository(expected.channel.repository, release.repository)) throw new Error("Release 更新意图无效，停止运行时同步");
  releaseChannel.validateManifest(manifest, validated);
  if (release.catalogSha256 !== undefined && manifest.asset.sha256 !== release.catalogSha256) throw new Error("发布 manifest 与渠道清单的 SHA256 不一致，停止运行时同步");
  if (record.version !== release.version || !record.source || !releaseChannel.sameAssetUrl(record.source.url, release.archive.browser_download_url) ||
      record.source.sha256 !== manifest.asset.sha256 || record.source.source !== "url" || record.source.type !== "zip" ||
      record.source.path !== "plugins/zcode-token-usage-statusbar" ||
      (record.source.stripRoot !== undefined && record.source.stripRoot !== false) || record.source.headers !== undefined) throw new Error("官方安装结果与选定 Release 不一致，停止运行时同步");
}

function verifyRuntimeSync(options) {
  const { runtime, pluginRoot, home = os.homedir(), env = process.env } = options;
  const readObject = (file, missing) => {
    let value;
    try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return missing; throw error; }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("同步验收记录不是 JSON 对象: " + file);
    return value;
  };
  const root = fs.realpathSync(pluginRoot);
  const manifest = readObject(path.join(root, ".zcode-plugin", "plugin.json"), null);
  if (!manifest || manifest.name !== PLUGIN_ID.split("@")[0]) throw new Error("同步插件清单身份无效");
  compareVersions(manifest.version, manifest.version);
  const pending = readObject(path.join(runtime, "plugin-update.json"), null);
  const hasPending = pending && (pending.pendingSync === true || (pending.pendingRelease !== undefined && pending.pendingRelease !== null) || pending.pendingPid);
  if (legacyLockBusy(runtime)) throw new Error("旧更新进程仍在运行，停止运行时同步");
  if (pending && pending.pendingPid) {
    if (!Number.isSafeInteger(pending.pendingPid) || pending.pendingPid <= 0) throw new Error("安装进程记录无效");
    try { process.kill(pending.pendingPid, 0); throw new Error("插件安装进程仍在运行，停止运行时同步"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  const storage = resolvePluginStorage(home, env);
  if (fs.existsSync(path.join(storage, "marketplaces", ".zusage-marketplace.transaction.json"))) throw new Error("官方市场事务尚未完成，停止运行时同步");
  const inventory = readObject(path.join(storage, "installed_plugins.json"), null);
  if (inventory && !Array.isArray(inventory.plugins)) throw new Error("官方安装记录形状无效");
  const records = inventory ? inventory.plugins.filter((row) => row && row.id === PLUGIN_ID && row.scope === "user") : [];
  if (!records.length) {
    if (hasPending || inventory) throw new Error("同步所需用户插件安装记录不存在");
    return { ok: true, pluginRoot: root, version: manifest.version, identity: { record: null, channel: null, pending, manifest } };
  }
  if (records.length !== 1) throw new Error("同步所需用户插件安装记录不唯一");
  const record = records[0];
  if (record.enabled === false) throw new Error("同步插件已被禁用，停止运行时同步");
  if (typeof record.installPath !== "string" || fs.realpathSync(record.installPath) !== root) throw new Error("同步插件与官方安装记录不一致：安装器须从官方安装记录指向的插件根目录（插件缓存目录）运行，而非运行时目录");
  if (record.version !== manifest.version) throw new Error("同步插件与官方安装记录版本不一致，停止运行时同步");
  const selected = releaseChannel.readChannel(home, storage);
  const currentChannel = { kind: selected.kind, repository: selected.repository || "", source: selected.marketplace ? selected.marketplace.source : null };
  if (hasPending) {
    if (pending.pendingSync !== true) throw new Error("待同步意图不完整，停止运行时同步");
    if (pending.pendingVersion && compareVersions(record.version, pending.pendingVersion) <= 0) throw new Error("插件安装尚未提交新版，停止运行时同步");
    if (pending.pendingRelease !== undefined && pending.pendingRelease !== null) verifyCommittedRelease(record, pending.pendingRelease, currentChannel);
    else if (currentChannel.kind === "release") throw new Error("历史更新意图缺少 Release 校验信息，停止运行时同步");
  }
  return { ok: true, pluginRoot: root, version: manifest.version, identity: { record, channel: currentChannel, pending, manifest } };
}

function listOverview(data) {
  // The official CLI answers different shapes by flag: plain `plugins list --json`
  // returns a top-level array of installed entries (no scope field, per-entry
  // diagnostics), while `--available` returns { installed, available, diagnostics }.
  // Accept both so an absent plugin is a real absence, never a shape mismatch.
  if (Array.isArray(data)) {
    const diagnostics = [];
    for (const entry of data) {
      if (entry && entry.id === PLUGIN_ID && Array.isArray(entry.diagnostics)) diagnostics.push(...entry.diagnostics);
    }
    return { installed: data, available: [], diagnostics };
  }
  if (data && typeof data === "object") {
    const installed = Array.isArray(data.installed) ? data.installed : null;
    const available = Array.isArray(data.available) ? data.available : null;
    // An envelope without either list is a shape we do not know; an empty list
    // is a real absence. Never let shape drift masquerade as "not installed".
    if (!installed && !available) throw new Error("插件管理器返回了无法识别的插件列表");
    return { installed: installed || [], available: available || [],
      diagnostics: Array.isArray(data.diagnostics) ? data.diagnostics : [] };
  }
  throw new Error("插件管理器返回了无法识别的插件列表");
}

function createUpdater(options) {
  const { runtime, home, resourcesPath, executable, notify = () => {}, now = Date.now } = options;
  const configFile = path.join(runtime, "config.json");
  const stateFile = path.join(runtime, "plugin-update.json");
  const environment = options.env || process.env;
  let storageRoot = null, localError = "";
  const storage = () => {
    const root = resolvePluginStorage(home, environment);
    if (storageRoot && storageRoot !== root) throw new Error("更新期间插件存储目录已变化，请重新启动更新器");
    storageRoot = root;
    return root;
  };
  const bundle = path.join(resourcesPath, "glm", "zcode.cjs");
  const markerFile = path.join(runtime, ".plugin-restart-required");
  // marker 的 mtime 作红点代际：不存在/读取失败为 0（overlay 用它区分「新待办」与「已查看」）
  const markerMtime = () => {
    try { return fs.statSync(markerFile).mtimeMs || 0; } catch (e) { return 0; }
  };
  // marker.version 记录本次实际写入运行目录的新版本（syncInstalled 先更新 currentVersion 再 record_restart），
  // 是「已安装待重启」的唯一可靠目标身份；损坏/缺失返回空串，由浮层明确说明无法匹配。
  const markerVersion = () => {
    let value = null;
    try { value = JSON.parse(fs.readFileSync(markerFile, "utf8")); } catch (e) { return ""; }
    const version = value && typeof value === "object" && typeof value.version === "string" ? value.version : "";
    try { if (version) { compareVersions(version, version); return version; } } catch (e) { }
    return "";
  };
  const saved = readState(stateFile, now());
  let state = { phase: "idle", supported: false, auto: false, currentVersion: "", latestVersion: "",
    ...saved, restartRequired: fs.existsSync(markerFile), markerAt: 0, skipped: [], error: "", channel: "", channelHost: "", channelRepo: "", releaseUrl: "", progress: null, checkedVia: "", markerVersion: "" };
  state.markerAt = state.restartRequired ? markerMtime() : 0;
  state.markerVersion = state.restartRequired ? markerVersion() : "";
  let busy = false;
  let selectedRelease = null, selectedChannel = null;
  const channel = () => {
    const source = options.channel ? options.channel() : releaseChannel.readChannel(home, storage());
    return { kind: source.kind, flavor: source.flavor || "", repository: source.repository || "", source: source.marketplace ? source.marketplace.source : null };
  };
  const fetchRelease = options.fetchRelease || releaseChannel.fetchBytes;
  const prepareRelease = options.prepareRelease || ((release, onProgress) => releaseChannel.downloadRelease(release, python(), fetchRelease, undefined, onProgress));
  const readReleaseCatalog = options.readReleaseCatalog || (() => {
    const root = path.join(storage(), "marketplaces");
    if (fs.existsSync(path.join(root, ".zusage-marketplace.transaction.json"))) throw new Error("官方插件市场事务尚未完成，请稍后重试");
    return readJson(path.join(root, "zusage-marketplace", "marketplace.json"), null);
  });
  const python = () => process.env.ZUSAGE_PLUGIN_PYTHON || (readConfig(configFile) || {}).python_path || (process.platform === "win32" ? "python" : "python3");
  const helper = path.join(__dirname, "runtime_lock.py");
  const lock = options.acquireLock || (() => acquireUpdateLock(runtime, python(), helper));
  const cli = options.cli || ((args, onSpawn) => runFile(executable, [bundle, "plugins", ...args, "--json"], {
    cwd: home, env: { ...environment, HOME: home, USERPROFILE: home, ELECTRON_RUN_AS_NODE: "1", ZCODE_STORAGE_DIR: path.dirname(storage()) }, windowsHide: true,
    timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  }, undefined, onSpawn));
  const sync = options.sync || ((root) => runFile(python(), [
    path.join(root, "overlay_install.py"), "sync",
  ], { cwd: home, env: { ...process.env, ZUSAGE_PLUGIN_RUNTIME: runtime },
    windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }));

  function installedRecord() {
    const inventory = readJson(path.join(storage(), "installed_plugins.json"), {});
    const records = inventory && inventory.plugins;
    return Array.isArray(records) ? records.find((p) => p && p.id === PLUGIN_ID && p.scope === "user"
      && typeof p.installPath === "string" && p.installPath && typeof p.version === "string") : null;
  }
  function refreshLocal() {
    const config = readConfig(configFile);
    state.auto = !!config && (!Object.prototype.hasOwnProperty.call(config, "plugin_auto_update") || config.plugin_auto_update === true);
    let record = null;
    localError = "";
    try { record = installedRecord(); } catch (error) { localError = error.message; }
    state.supported = !!(record && record.installPath && (options.cli || fs.existsSync(bundle)));
    state.currentVersion = record && record.version || "";
    state.restartRequired = fs.existsSync(markerFile);
    state.markerAt = state.restartRequired ? markerMtime() : 0;
    state.markerVersion = state.restartRequired ? markerVersion() : "";
    return record;
  }
  function publish() {
    state.restartRequired = fs.existsSync(markerFile);
    state.markerAt = state.restartRequired ? markerMtime() : 0;
    state.markerVersion = state.restartRequired ? markerVersion() : "";
    notify({ ...state, busy });
  }
  function load() { Object.assign(state, readState(stateFile, now())); }
  function save() {
    writeJson(stateFile, { checkedAt: state.checkedAt, lastAttempt: state.lastAttempt,
      pendingSync: state.pendingSync, pendingVersion: state.pendingVersion, pendingPid: state.pendingPid, pendingRelease: state.pendingRelease, lastFailure: state.lastFailure || null });
  }
  function diagnostics(data) {
    const errors = (data.diagnostics || []).filter((d) => d.severity === "error" && (!d.pluginId || d.pluginId === PLUGIN_ID));
    if (errors.length) throw new Error(errors.map((d) => d.message).join("; "));
  }
  async function catalogFallback(source, cause) {
    // GitHub API 检查失败（限流/不可达）时退回注册 ref 的渠道清单：清单刷新走 zipball
    // 下载桶不占 API 配额，渠道身份与安装校验链都不变。兜底再失败则合并原因一起上报。
    try {
      const market = await cli(["marketplace", "update", "zusage-marketplace"]);
      diagnostics(market);
      if (!isDeepStrictEqual(channel(), source)) throw new Error("更新期间市场来源已变化");
      return releaseChannel.githubReleaseFromCatalog(readReleaseCatalog(), source.repository);
    } catch (error) {
      throw new Error(String((cause && cause.message) || cause) + "；渠道清单回退也失败: " + error.message);
    }
  }
  async function check(auto = false, install = false) {
    if (busy) { if (!auto) publish(); return; }
    refreshLocal();
    if (!state.supported) { state.phase = localError ? "error" : "unavailable"; state.error = localError; publish(); return; }
    busy = true;
    // 手动检查要立刻有反馈：取锁、恢复待处理意图等前置步骤可能耗时数秒，不能让面板毫无动静。
    if (!auto) { state.phase = "checking"; state.error = ""; publish(); }
    let release;
    try {
      if (legacyLockBusy(runtime)) { if (!auto) throw new Error("另一个更新进程仍在运行，请稍后重试"); return; }
      release = await lock();
      if (!release || legacyLockBusy(runtime)) { if (!auto) throw new Error("另一个更新进程仍在运行，请稍后重试"); return; }
      load();
      if (state.pendingSync && await recoverPending()) return;
      refreshLocal();
      if (auto && (!state.auto || (state.lastAttempt && now() - state.lastAttempt < INTERVAL_MS))) return;
      state.phase = "checking"; state.error = ""; publish();
      state.lastAttempt = now();
      save();
      const source = channel();
      state.channel = source.kind; state.channelHost = source.flavor === "gitcode" ? "gitcode" : source.flavor === "github" ? "github" : "";
      state.channelRepo = source.repository || "";   // 更新日志卡片按渠道仓库构造 Release 页链接（market/local 为空）
      state.releaseUrl = ""; selectedRelease = null; selectedChannel = source; state.checkedVia = "";
      if (source.kind === "release" && source.flavor === "gitcode") {
        // GitCode 渠道：宿主从注册 ref 拉取的渠道清单是唯一版本源，不调 GitCode API。
        const market = await cli(["marketplace", "update", "zusage-marketplace"]);
        diagnostics(market);
        if (!isDeepStrictEqual(channel(), source)) throw new Error("更新期间市场来源已变化");
        selectedRelease = releaseChannel.gitcodeReleaseFromCatalog(readReleaseCatalog(), source.repository);
        state.checkedVia = "release-catalog";
      } else if (source.kind === "release") {
        try {
          selectedRelease = await releaseChannel.checkRelease(source.repository, compareVersions, fetchRelease);
          state.checkedVia = "release-api";
        } catch (error) {
          // API 明确答复「无正式版」或分页守卫触发说明渠道健康，兜底只会绕过这些结论；
          // 只对限流/网络类不可达失败退回渠道清单。
          if (/不能安装开发分支|安全分页上限/.test(error.message)) throw error;
          selectedRelease = await catalogFallback(source, error);
          state.checkedVia = "release-catalog";
        }
      }
      if (selectedRelease) {
        state.releaseUrl = selectedRelease.url;
        state.latestVersion = selectedRelease.version;
        const record = installedRecord();
        if (!record) throw new Error("用户级插件安装记录不存在");
        state.currentVersion = record.version;
        maybeClearFailure();
        const newer = compareVersions(state.latestVersion, record.version) > 0;
        state.phase = newer ? "available" : "current"; state.checkedAt = now(); save(); publish();
        if ((auto || install) && newer) {
          const overview = listOverview(await cli(["list"])); diagnostics(overview);
          const installed = (overview.installed || []).find((p) => p && p.id === PLUGIN_ID && (!p.scope || p.scope === "user"));
          if (!installed) throw new Error("用户插件未注册，不能安装 Release");
          if (installed.enabled !== false) await installUpdate(auto);
        }
      } else {
        state.checkedVia = "market";
        const market = await cli(["marketplace", "update", "zusage-marketplace"]);
        diagnostics(market);
        const overview = listOverview(await cli(["list", "--available"]));
        diagnostics(overview);
        if (!isDeepStrictEqual(channel(), source)) throw new Error("更新期间市场来源已变化");
        const installed = (overview.installed || []).find((p) => p && p.id === PLUGIN_ID && (!p.scope || p.scope === "user"));
        const available = (overview.available || []).find((p) => p && p.id === PLUGIN_ID);
        if (!installed || !available) throw new Error("未找到已安装插件或市场中的插件，请检查市场来源");
        state.currentVersion = installed.version || "";
        state.latestVersion = available.version || "";
        maybeClearFailure();
        const newer = compareVersions(state.latestVersion, state.currentVersion) > 0;
        state.phase = newer ? "available" : "current";
        state.checkedAt = now(); save(); publish();
        if ((auto || install) && newer && installed.enabled !== false) await installUpdate(auto);
      }
    } catch (e) {
      state.phase = "error"; state.error = e.message; state.progress = null;
      maybeClearFailure();   // 检查失败也不能让已过时的失败标注残留（当前版本已追上目标时）
    } finally {
      if (release) await release();
      busy = false; publish();
    }
  }
  function clearPending() {
    state.pendingSync = false; state.pendingVersion = ""; state.pendingPid = 0; state.pendingRelease = null;
    save();
  }
  function recordInstallFailure() {
    // 安装失败保留目标身份（plugin-update.json 的 lastFailure），「更新日志」卡片据此明确
    // 标注该版本未安装成功；成功路径由 syncInstalled 清除。卸载/禁用/来源切换类取消
    // （cancelError）不经过这里——那不是目标版本的安装失败。
    const version = selectedRelease ? selectedRelease.version : state.latestVersion;
    if (!version) return;
    try {
      compareVersions(version, version);
      state.lastFailure = { version, at: now(), channel: selectedRelease ? "release" : "market" };
    } catch (e) { }
  }
  const cancelError = (message) => Object.assign(new Error(message), { cancel: true });
  function maybeClearFailure() {
    // 当前版本已追上失败目标（如后来手动装成功）：失败标注已过时，随下一次检查一并清除。
    if (!state.lastFailure || !state.currentVersion) return;
    try { if (compareVersions(state.currentVersion, state.lastFailure.version) >= 0) state.lastFailure = null; } catch (e) { }
  }
  async function recoverPending() {
    // Legacy pendingSync meant an acknowledged CLI commit. New intents are saved
    // before launch and must prove a version change in official user inventory.
    // A CLI orphaned by parent shutdown can still be writing inventory/runtime.
    // Wait even after its version commit; normal completion clears its PID.
    if (state.pendingPid) {
      try { process.kill(state.pendingPid, 0); state.phase = "updating"; state.progress = { stage: "install" }; return true; }
      catch (e) { if (e.code !== "ESRCH") { state.phase = "updating"; state.progress = { stage: "install" }; return true; } }
      state.pendingPid = 0;
    }
    const record = installedRecord();
    if (!record) throw new Error("更新恢复所需的安装记录不存在");
    if (!state.pendingVersion || compareVersions(record.version, state.pendingVersion) > 0) {
      if (!state.pendingRelease && channel().kind === "release") throw new Error("历史更新意图缺少 Release 校验信息，停止运行时同步");
      await syncInstalled(); return true;
    }
    state.lastAttempt = 0;
    clearPending();
    state.phase = "idle";
    return false;
  }
  async function installUpdate(auto) {
    let record = refreshLocal();
    if (!record) throw cancelError("插件已卸载，更新已取消");
    if (auto && !state.auto) return;
    if (!isDeepStrictEqual(channel(), selectedChannel)) throw cancelError("更新期间市场来源已变化");
    compareVersions(record.version, record.version);
    let downloaded = null;
    // 中途放弃（插件被卸载/禁用、自动更新被关闭、版本已不再更新）时退回「发现新版本」，
    // 不能让 downloading 阶段与进度条停在面板上。
    const abandon = () => { state.phase = "available"; state.progress = null; };
    try {
      if (selectedRelease) {
        const currentChannel = channel();
        if (!isDeepStrictEqual(currentChannel, selectedChannel) || currentChannel.kind !== "release" || !releaseChannel.sameRepository(currentChannel.repository, selectedRelease.repository)) throw cancelError("更新期间市场来源已变化");
        state.phase = "downloading"; state.progress = { stage: "download", loaded: 0, total: selectedRelease.archive.size || 0 }; publish();
        let lastPublished = 0;
        downloaded = await prepareRelease(selectedRelease, (progress) => {
          state.progress = progress;
          // 下载字节进度按 ~150ms 节流推送；阶段切换与下载完成一律立即推送。
          const complete = progress.stage !== "download" || (progress.total && progress.loaded >= progress.total);
          if (complete || now() - lastPublished >= 150) { lastPublished = now(); publish(); }
        });
        releaseChannel.validateManifest(downloaded.manifest, selectedRelease);
        // 清单兜底意图：下载到的 manifest 必须与检查时的渠道清单同代同资产，防清单与
        // Release 资产错代（API 路径由行内 size 强比对承担等价约束）。
        if (selectedRelease.catalogSha256 !== undefined && downloaded.manifest.asset.sha256 !== selectedRelease.catalogSha256) throw new Error("发布 manifest 与渠道清单的 SHA256 不一致");
        state.progress = { stage: "verify" }; publish();
        const market = await cli(["marketplace", "update", "zusage-marketplace"]); diagnostics(market);
        if (!isDeepStrictEqual(channel(), currentChannel)) throw cancelError("更新期间市场来源已变化");
        record = refreshLocal();
        if (!record) throw cancelError("插件已卸载，更新已取消");
        if (auto && !state.auto) { abandon(); return; }
        if (compareVersions(selectedRelease.version, record.version) <= 0) { abandon(); return; }
        const overview = listOverview(await cli(["list"])); diagnostics(overview);
        const installed = (overview.installed || []).find((p) => p && p.id === PLUGIN_ID && (!p.scope || p.scope === "user"));
        if (!installed) throw cancelError("用户插件已卸载，Release 安装已取消");
        if (installed.enabled === false) { abandon(); return; }
        if (!isDeepStrictEqual(channel(), currentChannel)) throw cancelError("更新期间市场来源已变化");
        record = refreshLocal();
        if (!record) throw cancelError("插件已卸载，更新已取消");
        if ((auto && !state.auto) || compareVersions(selectedRelease.version, record.version) <= 0) { abandon(); return; }
      }
      state.phase = "updating"; state.progress = { stage: "install" };
      state.pendingSync = true; state.pendingVersion = record.version; state.pendingPid = 0;
      state.pendingRelease = selectedRelease ? { release: selectedRelease, manifest: downloaded.manifest, channel: channel() } : null;
      save(); publish();
      const command = selectedRelease ? ["install", PLUGIN_ID, "--scope", "user"] : ["update", PLUGIN_ID];
      try {
        let result;
        try { result = await cli(command, (pid) => { state.pendingPid = pid; save(); }); }
        finally { state.pendingPid = 0; save(); }
        diagnostics(result);
        if (result.ok !== true) throw new Error("插件管理器未确认更新成功");
      } catch (e) {
        const committed = installedRecord();
        if (committed && compareVersions(committed.version, state.pendingVersion) > 0) {
          if (selectedRelease) verifyReleaseCommit(committed);
          await syncInstalled(); return;
        }
        state.lastAttempt = 0; clearPending(); throw e;
      }
      const committed = installedRecord();
      if (!committed || compareVersions(committed.version, state.pendingVersion) <= 0) {
        state.lastAttempt = 0; clearPending(); throw new Error("插件管理器未提交新版安装记录");
      }
      if (selectedRelease) verifyReleaseCommit(committed);
      await syncInstalled();
    } catch (e) { if (!e || e.cancel !== true) recordInstallFailure(); save(); throw e; }   // 失败身份立即落盘（clearPending 已先写过一次）；取消类不误标失败
    finally { if (downloaded && downloaded.cleanup) downloaded.cleanup(); }
  }
  function verifyReleaseCommit(record) {
    verifyCommittedRelease(record, state.pendingRelease, channel());
  }
  async function recordRestart(report) {
    if (report.restartRecorded === true) return;
    const changed = Array.isArray(report.changed) ? report.changed : [];
    const cold = changed.filter((f) => f === "inject-main.cjs" || f === "plugin-updater.cjs" || f === "plugin-release.cjs" || f === "plugin-storage.cjs" || f === "quota-client.cjs"
      || ((readConfig(configFile) || {}).hot_reload === false && (f === "overlay.js" || f === "zusage.py")));
    if (!cold.length) return;
    const hashes = {};
    for (const name of cold) {
      try { hashes[name] = crypto.createHash("sha256").update(fs.readFileSync(path.join(runtime, name))).digest("hex"); }
      catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    await runFile(python(), [helper, "--record-restart", runtime], {
      windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
    }, JSON.stringify({ hashes, changed, version: state.currentVersion }));
  }
  async function syncInstalled() {
    // 更新器只信任宿主安装记录，不接收页面提供的脚本路径。
    const record = installedRecord();
    if (!record || !record.installPath) throw new Error("更新后的安装记录不存在");
    if (state.pendingRelease !== null) verifyReleaseCommit(record);
    state.phase = "updating"; state.progress = { stage: "sync" }; publish();
    const report = await sync(record.installPath);
    if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("运行时同步没有返回有效报告");
    state.currentVersion = record.version;
    // Current packages persist the marker themselves. This also covers old
    // packages' changed reports, before clearing durable pending coordination.
    await recordRestart(report);
    state.lastFailure = null;   // 安装成功：失败目标标注随 pending 一并清除（一次落盘）
    clearPending();
    state.skipped = Array.isArray(report.preserved) ? report.preserved : [];
    state.restartRequired = fs.existsSync(markerFile);
    state.markerAt = state.restartRequired ? markerMtime() : 0;
    state.phase = "updated"; state.error = ""; state.progress = null;
  }
  async function request(req) {
    if (!req) return;
    if (req.action === "auto" && typeof req.enabled === "boolean") {
      try {
        await updateConfig(runtime, { plugin_auto_update: req.enabled }, python());
        refreshLocal(); state.error = "";
        publish();
        if (req.enabled) await check(true);
      } catch (e) { state.phase = "error"; state.error = e.message; publish(); }
    } else if (req.action === "check") await check();
    else if (req.action === "update") {
      // 手动更新也先刷新版本，避免过期的“有新版”状态触发重装或降级。
      await check(false, true);
    }
  }
  async function tick() {
    refreshLocal();
    if (localError) { state.phase = "error"; state.error = localError; }
    publish();
    if (busy) return;
    load();
    if (state.supported && (state.pendingSync || (state.auto && (!state.lastAttempt || now() - state.lastAttempt >= INTERVAL_MS)))) await check(true);
  }
  refreshLocal();
  return { request, tick, status: () => ({ ...state, busy }) };
}

async function runAutoCommand(argv) {
  if (argv[0] !== "--auto") throw new Error("仅支持 --auto 后台更新模式");
  const values = {};
  for (let i = 1; i < argv.length; i += 2) {
    if (!["--resources", "--runtime"].includes(argv[i]) || !argv[i + 1]) throw new Error("无效自动更新参数");
    values[argv[i]] = argv[i + 1];
  }
  if (!values["--resources"] || !values["--runtime"]) throw new Error("缺少客户端或运行时目录");
  const updater = createUpdater({ runtime: path.resolve(values["--runtime"]), home: os.homedir(),
    resourcesPath: path.resolve(values["--resources"]), executable: process.execPath });
  await updater.tick();
  const state = updater.status();
  process.stdout.write(JSON.stringify(state) + "\n");
  if (state.phase === "error") process.exitCode = 1;
}

module.exports = { createUpdater, compareVersions, INTERVAL_MS, PLUGIN_ID, runAutoCommand, updateConfig, verifyRuntimeSync, listOverview };
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--verify-runtime-sync") {
    try {
      if (argv.length !== 3) throw new Error("同步验收需要运行时与插件路径");
      process.stdout.write(JSON.stringify(verifyRuntimeSync({ runtime: path.resolve(argv[1]), pluginRoot: path.resolve(argv[2]) })) + "\n");
    } catch (error) { console.error("[zusage-plugin] 同步验收失败:", error.message); process.exitCode = 1; }
  } else runAutoCommand(argv).catch((e) => {
    console.error("[zusage-plugin] 自动更新失败:", e.message);
    process.exitCode = 1;
  });
}
