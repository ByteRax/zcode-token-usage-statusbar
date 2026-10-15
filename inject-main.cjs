/* ZCode token 用量注入 loader v2（主进程）。
 * 由 patch_install.py 在 app.asar 入口尾部追加一行 import 引入。
 * 职责：1) 向每个窗口注入 overlay.js（mtime 变化热更新，免重启）；
 *       2) 触发式拉取：fs.watch 监听 db 目录，db.sqlite/-wal 一有写入（去抖 300ms）就
 *          查询并推送。限频 config.activity_min_ms（默认 1500ms），限频到点
 *          自动补拉，最后一笔写入不漏；完全空闲时零进程零轮询，仅兜底心跳
 *          （config.heartbeat_ms，默认 30s）防文件事件丢失（Node 官方文档：fs.watch
 *          事件不保证送达）。任何失败只打日志，不影响客户端。
 *       3) 每窗口当前会话（v6）：渲染端 workspace shell 把焦点会话 id 经 IPC
 *          "zcode:sync-active-task-session" 推给主进程（客户端自带通道，实测见 app bundle），
 *          这里追加监听记录 webContents.id → 会话 id：查询时把全部窗口的会话强制纳入快照，
 *          推送时给每个窗口注入 mine 字段 —— 多窗口各自显示自己的会话，不再猜"全局最近活跃"。 *
 *  v8：查询改常驻 python（zusage.py serve，stdin/stdout 行协议）——省每次 ~60-100ms 的
 *      解释器启动费；意外退出自动重启（30s 内连续 3 次判不稳定则回退一次性 spawn）；
 *      zusage.py mtime 变化自动重启（升级生效）；stdin EOF = 泵退出，常驻进程自清理。 */
"use strict";
const path = require("path");
const fs = require("fs");
const { spawn, execFile } = require("child_process");
const { createHash } = require("crypto");
const { app, BrowserWindow, webContents } = require("electron");
const { fileURLToPath } = require("url");

const HERE = __dirname;   // 本 loader 被 asar 注入行按绝对 file:// URL import，__dirname 即真实目录（克隆到任意路径无需改代码）
const CONFIG = path.join(HERE, "config.json");
const OVERLAY = path.join(HERE, "overlay.js");
const ZUSAGE = path.join(HERE, "zusage.py");
const LOG = (...a) => console.error("[zusage]", ...a);
const loadedHashes = { _loadedAt: Date.now() - process.uptime() * 1000 };
for (const name of ["inject-main.cjs", "plugin-updater.cjs", "plugin-release.cjs", "plugin-storage.cjs", "overlay.js", "zusage.py"]) {
  try { loadedHashes[name] = createHash("sha256").update(fs.readFileSync(path.join(HERE, name))).digest("hex"); }
  catch (e) { LOG("startup fingerprint unavailable:", name, e.message); }
}
function acknowledgeRestart() {
  const helper = path.join(HERE, "runtime_lock.py");
  if (!fs.existsSync(helper)) return;
  execFile(readCfg().python_path || (process.platform === "win32" ? "python" : "python3"),
    [helper, "--ack-restart", HERE, JSON.stringify(loadedHashes)],
    { windowsHide: true, timeout: 15000, maxBuffer: 65536 },
    (error) => { if (error) LOG("restart acknowledgement failed:", error.message); });
}

function readCfg() {
  const c = { python_path: "python", resident: true };
  try { Object.assign(c, JSON.parse(fs.readFileSync(CONFIG, "utf8"))); } catch (e) { }
  return c;
}

/* config.json 内容缓存：热更新定时器每 2s 触发，改为 stat mtime 判变化后才读文件 */
let cfgMtime = 0;
let cfgCache = null;
function readCfgCached() {
  let m = 0;
  try { m = fs.statSync(CONFIG).mtimeMs; } catch (e) { }
  if (!cfgCache || m !== cfgMtime) {
    cfgMtime = m;
    cfgCache = readCfg();
  }
  return cfgCache;
}

/* overlay 注入源 + 热更新：mtime 变了就重注入（移除旧条+复位守卫）。
 * 载入前用 new Function 校验语法，避免把写到一半的文件载入页面。 */
let overlaySrc = "";
let overlayMtime = 0;
try {
  overlaySrc = fs.readFileSync(OVERLAY, "utf8");
  overlayMtime = fs.statSync(OVERLAY).mtimeMs;
} catch (e) { LOG("overlay.js missing:", e.message); }

function hotReloadIfChanged() {
  let m = 0, src = "";
  try {
    m = fs.statSync(OVERLAY).mtimeMs;
    src = fs.readFileSync(OVERLAY, "utf8");
  } catch (e) { return; }
  if (m === overlayMtime) return;
  try { new Function(src); } catch (e) { LOG("overlay.js syntax not ready, skip:", e.message); return; }
  overlayMtime = m;
  overlaySrc = src;
  LOG("overlay.js changed, hot-reloading");
  for (const wc of webContents.getAllWebContents()) {
    if (!isMainWindowState(wc) || wc.isDestroyed()) continue;
    wc.executeJavaScript(
      '(function(){var b=document.getElementById("zusage-bar");if(b)b.remove();var t=document.getElementById("zusage-tip");if(t)t.remove();window.__zusageOverlay=false;})()', true
    ).catch(() => { });
    injectOverlay(wc);
  }
}

function isMainWindowState(wc) {
  try { return wc.getType() === "window"; } catch (e) { return false; }
}

function pushOnce(wc, payload) {
  if (!isMainWindowState(wc) || wc.isDestroyed() || !payload || typeof payload !== "object") return;
  /* 按窗口注入 mine（本窗口焦点会话 id，可为空串 = 该窗口当前无会话）：
   * overlay 收到 mine 字段就优先显示它，不再多窗口共享同一个猜测。
   * 必须对象合并后序列化，禁止对 JSON 字符串做括号手术——v34 首版 slice 掐尾少补一个
   * 右括号，生成语法错误代码且失败只进静默 catch，全部窗口停在初始零值（实测翻车）。 */
  const obj = Object.assign({}, payload, {
    ...(activeSid.has(wc.id) ? { mine: activeSid.get(wc.id) || "" } : {}),
    scope_bindings: scopeBindings.get(wc.id) || {},
  });
  /* U+2028/2029 转义：JSON.stringify 会输出裸字符，放进 executeJavaScript 字符串字面量
   * 有语法风险（zusage.py 侧 ensure_ascii 的同款考量；会话标题可能含任意文本） */
  const js = `window.__zusageUpdate && window.__zusageUpdate(${JSON.stringify(obj).replace(/[\u2028\u2029]/g, (c) => c === "\u2028" ? "\\u2028" : "\\u2029")})`;
  wc.executeJavaScript(js, true).catch(() => { });
}

/* 每窗口焦点会话：客户端渲染端把 activeTaskId 经此通道同步给主进程（CUA PiP 所用通道），
 * 追加监听器不影响原有处理。值为 "" = 窗口已同步但当前无会话（新空会话/非任务页）；
 * 不在表里 = 该窗口从未同步（辅助窗口），推送时不带 mine，overlay 走本地键启发式。 */
const IPC_ACTIVE_SID = "zcode:sync-active-task-session";
const activeSid = new Map();   // webContents.id → 会话 id 或 ""
const windowWorkspaces = new Map();
const windowTasks = new Map();
const scopeBindings = new Map();
function trustedSender(e) {
  try {
    if (!e || !e.sender || e.sender.isDestroyed() || !isMainWindowState(e.sender)) return false;
    const url = e.sender.getURL();
    if (!url.startsWith("file:")) return false;
    const relative = path.relative(process.resourcesPath, fileURLToPath(url));
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  } catch (e) { return false; }
}
try {
  const { ipcMain } = require("electron");
  // 只旁听宿主公开的单向同步，不读取凭据或 Electron 私有 handler 状态。
  ipcMain.on("zcode:sync-web-remote-control-workspaces", (e, rows) => {
    if (!trustedSender(e) || !Array.isArray(rows)) return;
    windowWorkspaces.set(e.sender.id, rows.filter((r) => r && typeof r.workspacePath === "string")
      .map((r) => ({ kind: r.kind, identity: typeof r.workspaceIdentity === "string" ? r.workspaceIdentity.trim() : "" })));
    scheduleRetry(300);
  });
  ipcMain.on("zcode:sync-web-remote-control-tasks", (e, rows) => {
    if (!trustedSender(e) || !Array.isArray(rows)) return;
    const tasks = new Map();
    for (const r of rows) {
      if (!r || typeof r.taskId !== "string") continue;
      const identity = r.workspaceKind === "remote" && typeof r.workspaceIdentity === "string" ? r.workspaceIdentity.trim() : "";
      if (!tasks.has(r.taskId)) tasks.set(r.taskId, new Set());
      tasks.get(r.taskId).add(identity);
    }
    windowTasks.set(e.sender.id, tasks);
    scheduleRetry(300);
  });
  ipcMain.on(IPC_ACTIVE_SID, (e, sid) => {
    if (!e || !e.sender || e.sender.isDestroyed()) return;
    const s = typeof sid === "string" ? sid.trim() : "";
    const val = s && s.length <= 255 && /^[A-Za-z0-9_-]+$/.test(s) ? s : "";
    const prev = activeSid.get(e.sender.id);
    activeSid.set(e.sender.id, val);
    if (prev !== val) scheduleRetry(800);   // 会话切换/窗口就绪：尽快按新会话拉一次（限频器仍生效）
  });
} catch (e) { LOG("ipc hook failed:", e.message); }

/* db 活动戳：db.sqlite / -wal / -shm 的最新 mtime。WAL 模式下写入主要落在 -wal。 */
let DB_DIR = null;
function dbDir() {
  if (!DB_DIR) DB_DIR = path.join(app.getPath("home"), ".zcode", "cli", "db");
  return DB_DIR;
}
function dbStamp() {
  let m = 0;
  const dir = dbDir();
  for (const f of ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"]) {
    try { m = Math.max(m, fs.statSync(path.join(dir, f)).mtimeMs); } catch (e) { }
  }
  return m;
}

/* 远端状态按 (sid, workspaceIdentity) 隔离；显式可信 scope 首查失败也续查。
 * 请求直接携带 identity，不依赖上一份 payload 的临时目标序号。
 * 最后成功 remote 标记保留 10 分钟，pending 保证失败后持续恢复。 */
const REMOTE_STICKY_MS = 10 * 60 * 1000;
const remoteSids = new Map();      // sid → lastSeen ms
const pendingSids = new Map();     // sid → next attempt ms
let targetByIdentity = new Map();  // workspaceIdentity → 目标键（最近一次 payload）
function isRemoteSid(s) {
  const t = remoteSids.get(s);
  if (t === undefined) return false;
  if (Date.now() - t > REMOTE_STICKY_MS) { remoteSids.delete(s); return false; }
  return true;
}
function remotePollMs() {
  const r = readCfgCached().remote;
  return Math.max(1000, (r && r.poll_ms | 0) || 3000);
}

let busy = false;
let pushCount = 0;
let lastSpawn = 0;    // 上次发起查询时刻（activity_min_ms 限频用）
let lastStamp = 0;    // 上次拉取时的 db mtime（去重：无新写入不拉）
let lastWants = "";   // 上次查询用的会话 id 集合（变化即拉，防"会话切了但 db 没写入"滞留旧数据）
let lastRequest = { sids: [], scopes: [] };
let lastSourceStamp = "";
let collecting = false;
function scopeKey(sid, identity) { return JSON.stringify([sid, identity || ""]); }
function requestKeys(request) {
  return request.sids.map((sid) => scopeKey(sid, "")).concat(request.scopes.map((s) => scopeKey(s.sid, s.workspaceIdentity)));
}
function sourceStamp() {
  const home = (process.env && process.env.ZCODE_DESKTOP_HOME_DIR) || app.getPath("home");
  const files = [CONFIG, path.join(home, ".zcode", "v2", "setting.json")];
  return files.map((file) => { try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}`; } catch (e) { return "missing"; } }).join("|");
}
let lastHadRemote = false;

function remoteDisabled() {
  const remote = readCfgCached().remote || {};
  return remote.auto === false && remote.enabled === false;
}
function clearRemoteRecovery() {
  remoteSids.clear();
  pendingSids.clear();
  lastHadRemote = false;
  clearTimeout(retryTimer);
  retryTimer = 0;
}
function handlePayload(payload) {
  const disabled = remoteDisabled();
  if (disabled) clearRemoteRecovery();
  // serve 的 error 是查询失败，不是空快照；不可清掉重试状态和最后成功数据显示。
  if (!payload || typeof payload !== "object" || payload.error) return;
  const now = Date.now();
  const marks = new Set();
  for (const r of (payload.recent || [])) if (r && r.remote && r.sid && !r.remote_error && !r.remote_missing) {
    const key = scopeKey(r.sid, r.workspace_identity);
    marks.add(key);
    remoteSids.set(key, now);
  }
  const idents = new Map();
  for (const t of (payload.remote_targets || [])) {
    if (!t || !t.key) continue;
    for (const id of (t.identities || [])) if (id) idents.set(String(id), String(t.key));
  }
  targetByIdentity = idents;
  const notLocal = new Set(Array.isArray(payload.not_local) ? payload.not_local : []);
  const poll = remotePollMs();
  const keys = requestKeys(lastRequest);
  for (const key of keys) {
    const [sid, identity] = JSON.parse(key);
    if (marks.has(key)) { pendingSids.delete(key); continue; }
    const remote = readCfgCached().remote || {};
    if (identity && !(remote.auto === false && remote.enabled === false) || (notLocal.has(sid) && payload.remote_enabled && remote.enabled === true)) pendingSids.set(key, now + poll);
    else { pendingSids.delete(key); remoteSids.delete(key); }
  }
  for (const key of pendingSids.keys()) if (!keys.includes(key)) pendingSids.delete(key);
  if (disabled) clearRemoteRecovery(); // 关闭期间返回的迟到成功快照也不能重建粘性标记。
  else lastHadRemote = keys.some((key) => isRemoteSid(key) || pendingSids.has(key));
  for (const wc of webContents.getAllWebContents()) pushOnce(wc, payload);
  // 定位诊断：每 ~15 次拉取收集每个窗口各自的 __zusageDiag，附加泵侧证据后写 diag-<n>.json（多窗口互不覆盖）
  if (++pushCount % 15 === 1) {
    let idx = 0;
    for (const wc of webContents.getAllWebContents()) {
      if (!isMainWindowState(wc) || wc.isDestroyed()) continue;
      const file = path.join(HERE, "diag-" + idx + ".json");
      idx++;
      wc.executeJavaScript("JSON.stringify(window.__zusageDiag||null)", true)
        .then((s) => {
          if (s && s !== "null") {
            try {
              const obj = JSON.parse(s);
              obj.pump = {
                version: 10,
                resident: !!pyRes,
                activeMap: Array.from(activeSid.entries()).slice(0, 12),
                wants: lastWants,
              };
              fs.writeFileSync(file, JSON.stringify(obj));
            } catch (e2) {
              try { fs.writeFileSync(file, s); } catch (e) { }
            }
          }
        })
        .catch(() => { });
    }
  }
}

/* ---------- 常驻查询进程（v8）：zusage.py serve，stdin 请求行 / stdout 响应行 ---------- */
let pyRes = null;        // { proc, buf, waiters: [fn], born }
let pyFail = 0;          // 启动 30s 内退出次数（>=3 判不稳定，回退一次性 spawn）
let pyBackoff = 1000;
let pyRestarting = false;   // 主动 kill（升级/超时）标记，close 时不计失败

function startResident() {
  if (pyRes) return;
  const proc = spawn(readCfg().python_path, [path.join(HERE, "zusage.py"), "serve"], { windowsHide: true });
  const state = { proc, buf: "", waiters: [], born: Date.now() };
  pyRes = state;
  LOG("resident python starting");
  proc.stdout.on("data", (d) => {
    state.buf += d.toString("utf8");
    let i;
    while ((i = state.buf.indexOf("\n")) >= 0) {
      const line = state.buf.slice(0, i);
      state.buf = state.buf.slice(i + 1);
      const w = state.waiters.shift();
      if (!w) continue;
      let payload = null;
      try { payload = JSON.parse(line); } catch (e) { }
      w(payload);
    }
  });
  proc.stderr.on("data", () => { });
  proc.on("error", (e) => {
    LOG("resident spawn failed:", e.message);
    const pending = state.waiters.splice(0);
    pending.forEach((w) => w(null));
  });
  proc.stdin.on("error", (e) => {
    LOG("resident stdin failed:", e.message);
    const pending = state.waiters.splice(0);
    pending.forEach((w) => w(null));
    try { proc.kill(); } catch (e) { }
  });
  proc.on("close", () => {
    if (pyRes === state) pyRes = null;
    const pending = state.waiters;
    state.waiters = [];
    pending.forEach((w) => w(null));   // 挂起请求失败收场，泵侧等下一笔写入/心跳补拉
    if (pyRestarting) { pyRestarting = false; startResident(); return; }
    if (Date.now() - state.born < 30000) {   // 早期崩溃：退避重启，3 次判不稳定
      pyFail++;
      if (pyFail >= 3) { LOG("resident unstable (3 early exits), fallback to one-shot spawn"); return; }
      setTimeout(startResident, pyBackoff);
      pyBackoff = Math.min(pyBackoff * 2, 30000);
    } else {   // 长跑后退出（升级/外部误杀）：立即重启，不计失败
      pyFail = 0;
      pyBackoff = 1000;
      startResident();
    }
  });
}

function killResidentForUpgrade() {
  if (!pyRes) return;
  pyRestarting = true;
  try { pyRes.proc.kill(); } catch (e) { }
}

/* 统一查询入口：resident 可用走 JSON 行协议，否则一次性 spawn。 */
function runQuery(request) {
  busy = true;
  let settled = false;
  const done = (payload) => {
    // timeout、error、close 只能结算一次；旧请求不得解除新请求的 busy。
    if (settled) return;
    settled = true;
    busy = false;
    if (remoteDisabled()) {
      clearRemoteRecovery();
      if (payload && !payload.error) handlePayload(payload);
    } else if (payload && !payload.error) handlePayload(payload);
    else {
      for (const key of requestKeys(request)) pendingSids.set(key, Date.now() + remotePollMs());
      lastHadRemote = requestKeys(request).length > 0;
    }
    if (lastHadRemote) scheduleRetry(remotePollMs());
  };
  const line = JSON.stringify(request);
  if (readCfgCached().resident !== false && pyFail < 3) {
    if (!pyRes) startResident();
    if (pyRes && pyRes.proc.stdin.writable) {
      const state = pyRes;
      const waiter = (payload) => { clearTimeout(timer); done(payload); };
      const timer = setTimeout(() => {
        LOG("resident query timeout, restarting it");
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) state.waiters.splice(index, 1);
        pyRestarting = true;
        try { state.proc.kill(); } catch (e) { }
        done(null);
      }, 15000);
      state.waiters.push(waiter);
      try { state.proc.stdin.write(line + "\n"); }
      catch (e) { waiter(null); }
      return;
    }
  }
  legacySpawn(line, done);
}

/* 回退路径仍使用同款 JSON scope 请求，避免 resident=false 丢失隔离。 */
function legacySpawn(line, done) {
  const args = [path.join(HERE, "zusage.py"), "json", line];
  const py = spawn(readCfg().python_path, args, { windowsHide: true });
  let out = "";
  const killTimer = setTimeout(() => {
    LOG("query timeout, killing");
    try { py.kill(); } catch (e) { }
    done(null);
  }, 15000);
  py.stdout.on("data", (d) => { out += d; });
  py.on("error", (e) => { clearTimeout(killTimer); LOG("spawn failed:", e.message); done(null); });
  py.on("close", () => {
    clearTimeout(killTimer);
    let payload = null;
    try { payload = JSON.parse(out); } catch (e) { }
    done(payload);
  });
}

/* 触发式拉取：db 有新写入（mtime 变化）才 spawn 查询；限频不满足时安排补拉，
 * 保证限频窗口结束后最后一笔写入的数据一定被取到。 */
let retryTimer = 0;
function scheduleRetry(ms) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(maybeSpawn, ms);
}
function maybeSpawn() {
  if (busy || collecting) { scheduleRetry(300); return; }
  const st = dbStamp();
  const cfg = readCfgCached();
  if (remoteDisabled()) clearRemoteRecovery();
  const wait = Math.max(300, cfg.activity_min_ms | 0 || 1500);
  /* 先取各窗口的"当前会话 id"：主进程 IPC 映射（应用自己上报的焦点会话，v6）优先，
   * overlay 从 localStorage 键读出的 __zusageWantSid 兜底；无窗口时直接短路（空闲零进程的
   * 设计意图）；executeJavaScript 挂 1s 超时，防渲染进程卡死导致泵永不 settle。
   * v8：全部窗口都已在 IPC 映射表里（含"已同步但无会话"的空串）时跳过整轮 eval ——
   * mine 模式下 WantSid 已非主数据源，省掉活跃期每 1.5s × N 窗口的页面求值。 */
  const wcs = webContents.getAllWebContents().filter((wc) => isMainWindowState(wc) && !wc.isDestroyed());
  if (!wcs.length) return;
  const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(""), ms))]);
  /* 各窗口的 pane 会话 id（v10，__zusageWantSids 数组，分屏多实例状态条用）+ 旧单值兜底；
   * v12 附带 __zusageSidWs（sid→workspaceIdentity，多服务器路由）。 */
  collecting = true;
  const readWantsJs = '(function(){var a=window.__zusageWantSids;if(!a||!a.length){a=window.__zusageWantSid?[window.__zusageWantSid]:[]}return JSON.stringify({s:a,w:window.__zusageSidWs||{},p:window.__zusagePaneScopes||{}})})()';
  Promise.all(wcs.map((wc) => withTimeout(Promise.resolve().then(() => wc.executeJavaScript(readWantsJs, true)).catch(() => ""), 1000)))
    .then((vals) => {
      const request = { sids: [], scopes: [] };
      const add = (sid, identity) => {
        if (identity) {
          if (!request.scopes.some((s) => s.sid === sid && s.workspaceIdentity === identity)) request.scopes.push({ sid, workspaceIdentity: identity });
        } else if (!request.sids.includes(sid)) request.sids.push(sid);
      };
      wcs.forEach((wc, i) => {
        let parsed = {};
        try { parsed = JSON.parse(vals[i] || "{}"); } catch (e) { }
        const wants = Array.isArray(parsed.s) ? parsed.s.slice() : [];
        if (activeSid.get(wc.id)) wants.push(activeSid.get(wc.id));
        const workspaces = windowWorkspaces.get(wc.id) || [];
        const trusted = new Set(workspaces.filter((w) => w.kind === "remote" && w.identity.startsWith("remote:ssh:")).map((w) => w.identity));
        const tasks = windowTasks.get(wc.id);
        const bindings = {};
        for (const [pid, pane] of Object.entries(parsed.p || {})) {
          if (!pane || !wants.includes(pane.sid) || typeof pane.sid !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(pane.sid)) continue;
          bindings[pid] = ""; // 本地/未知 pane 显式隔离，不能从同 sid 远端绑定继承。
          if (pane.identity === "" || (pid === "workspace-main" && !Object.prototype.hasOwnProperty.call(pane, "identity"))) {
            // 工作区同步可能只含 connected remotes，不能证明主 pane 当前属于远端。
            add(pane.sid, "");
            continue;
          }
          if (!trusted.has(pane.identity)) continue;
          const taskScopes = tasks && tasks.get(pane.sid);
          if (taskScopes && !taskScopes.has(pane.identity)) continue;
          bindings[pid] = pane.identity;
          add(pane.sid, pane.identity);
        }
        for (const sid of wants) {
          if (typeof sid !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(sid)) continue;
          const raw = parsed.w && parsed.w[sid];
          const candidates = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []).filter((id) => trusted.has(id));
          const taskScopes = tasks && tasks.get(sid);
          const eligible = [...new Set(candidates)].filter((id) => !taskScopes || taskScopes.has(id));
          const primary = parsed.p && parsed.p["workspace-main"];
          if (primary && primary.sid === sid && !Object.prototype.hasOwnProperty.call(primary, "identity")) continue;
          if (eligible.length === 1) {
            bindings[sid] = eligible[0];
            add(sid, eligible[0]);
          } else if (!request.scopes.some((s) => s.sid === sid)) {
            // 本地/未知不能自动借唯一历史SSH通道；Python JSON无scope默认只查本地。
            add(sid, "");
          }
        }
        scopeBindings.set(wc.id, bindings);
      });
      request.sids.sort();
      request.scopes.sort((a, b) => scopeKey(a.sid, a.workspaceIdentity).localeCompare(scopeKey(b.sid, b.workspaceIdentity)));
      const key = JSON.stringify(request);
      const src = sourceStamp();
      const keys = requestKeys(request);
      const now = Date.now();
      const remoteActive = keys.some((s) => isRemoteSid(s));
      const pendingDue = keys.some((s) => { const t = pendingSids.get(s); return t !== undefined && t <= now; });
      if (key === lastWants && src === lastSourceStamp && st && st === lastStamp && !remoteActive && !pendingDue) return;
      const effWait = (remoteActive || pendingDue) ? remotePollMs() : wait;
      if (now - lastSpawn < effWait) { scheduleRetry(effWait - (now - lastSpawn) + 50); return; }
      lastWants = key;
      lastSourceStamp = src;
      lastRequest = request;
      lastHadRemote = remoteActive || pendingDue || request.scopes.length > 0;
      if (st) lastStamp = st;
      lastSpawn = now;
      runQuery(request);
    })
    .catch(() => { })
    .finally(() => { collecting = false; });
}

/* 监听 db 目录：WAL/主库一有写入立刻（去抖 300ms）触发拉取；完全空闲时零进程零轮询 */
let debounceTimer = 0;
let dbWatcher = null;
function watchDb() {
  if (dbWatcher) return;
  try {
    dbWatcher = fs.watch(dbDir(), (ev, f) => {
      if (f && !/db\.sqlite/.test(f)) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(maybeSpawn, 300);
    });
    dbWatcher.on("error", () => {
      LOG("db watcher error, re-arm in 5s");
      try { dbWatcher.close(); } catch (e) { }
      dbWatcher = null;
      setTimeout(watchDb, 5000);
    });
    LOG("watching", dbDir());
  } catch (e) {
    LOG("fs.watch failed, retry in 5s:", e.message);
    setTimeout(watchDb, 5000);
  }
}

/* overlay / zusage.py 热更新检查（stat mtime，开销可忽略）；config.hot_reload=false 可关闭
 * （发布/稳定形态：改文件需重启 ZCode 才生效），开关改动随下次心跳生效。
 * zusage.py 变化时重启常驻进程（serve 进程驻内存的是旧代码）；顺带 stat config mtime。 */
let overlayMtimeKnown = false;
let zusageMtime = 0;
setInterval(() => {
  const cfg = readCfgCached();
  if (cfg.hot_reload === false) return;
  hotReloadIfChanged();
  try {
    const m = fs.statSync(ZUSAGE).mtimeMs;
    if (overlayMtimeKnown && m !== zusageMtime && pyRes) {
      LOG("zusage.py changed, restarting resident python");
      killResidentForUpgrade();
    }
    zusageMtime = m;
    overlayMtimeKnown = true;
  } catch (e) { }
}, 2000);
setInterval(maybeSpawn, Math.max(10000, readCfg().heartbeat_ms | 0 || 30000));   // 兜底心跳：防文件事件丢失
watchDb();
maybeSpawn();   // 启动先拉一次

let pluginUpdater = null;
let pluginRequestBusy = false;
function pushPluginState(wc, state) {
  if (!isMainWindowState(wc) || wc.isDestroyed()) return;
  /* rateLine 随插件状态一起推送：⚙ 面板「逐问速率行」勾选态的真值来自 config.json */
  const payload = { ...state, rateLine: readCfgCached().answer_rate_line !== false };
  wc.executeJavaScript(`window.__zusagePluginUpdate && window.__zusagePluginUpdate(${JSON.stringify(payload)})`, true).catch(() => { });
}
try {
  const { createUpdater } = require("./plugin-updater.cjs");
  pluginUpdater = createUpdater({ runtime: HERE, home: app.getPath("home"),
    resourcesPath: process.resourcesPath, executable: process.execPath,
    notify: (state) => webContents.getAllWebContents().forEach((wc) => pushPluginState(wc, state)) });
} catch (e) {
  delete loadedHashes["plugin-updater.cjs"];
  delete loadedHashes["plugin-release.cjs"];
  delete loadedHashes["plugin-storage.cjs"];
  LOG("plugin updater unavailable:", e.message);
}
acknowledgeRestart();
/* 逐问速率行开关（⚙ 面板）：原子写运行时 config.json 的 answer_rate_line（缺省=开启）。
   prompt-submit hook 每次提问时读同一文件——开关下一问即生效，无需重启客户端。 */
function broadcastPluginState() {
  const base = pluginUpdater ? pluginUpdater.status() : {};
  webContents.getAllWebContents().forEach((wc) => pushPluginState(wc, base));
}
async function setAnswerRateLine(enabled) {
  try {
    const { updateConfig } = require("./plugin-updater.cjs");
    await updateConfig(HERE, { answer_rate_line: enabled }, readCfgCached().python_path || (process.platform === "win32" ? "python" : "python3"));
    cfgCache = null;   // 写后置空，下一次 readCfgCached 立即重读（mtime 判变的双保险）
    broadcastPluginState();
  } catch (e) { LOG("answer_rate_line toggle failed:", e.message); }
}
async function pollPluginRequests() {
  if (pluginRequestBusy) return;
  pluginRequestBusy = true;
  try {
    for (const wc of webContents.getAllWebContents()) {
      if (!isMainWindowState(wc) || wc.isDestroyed()) continue;
      // 仅在宿主本地窗口读取固定动作；外部网页不能触发插件更新或配置写入。
      const url = wc.getURL();
      if (!url.startsWith("file:")) continue;
      const local = fileURLToPath(url);
      const relative = path.relative(process.resourcesPath, local);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const requests = await Promise.race([
        wc.executeJavaScript('(function(){var q=window.__zusagePluginRequests;return Array.isArray(q)?q.splice(0,8):[]})()', true),
        new Promise((resolve) => setTimeout(() => resolve([]), 1000)),
      ]);
      if (!Array.isArray(requests)) continue;
      for (const req of requests) {
        if (req && ["auto", "check", "update"].includes(req.action)) {
          if (pluginUpdater) pluginUpdater.request(req).catch((e) => LOG("plugin update action failed:", e.message));
        } else if (req && req.action === "rate-line" && typeof req.enabled === "boolean") {
          setAnswerRateLine(req.enabled);
        }
      }
    }
  } catch (e) { LOG("plugin update request failed:", e.message); }
  finally { pluginRequestBusy = false; }
}
setInterval(pollPluginRequests, 1000);
setInterval(() => { if (pluginUpdater) pluginUpdater.tick().catch((e) => LOG("plugin auto update:", e.message)); }, 60000);
if (pluginUpdater) pluginUpdater.tick().catch((e) => LOG("plugin auto update:", e.message));

function injectOverlay(wc) {
  if (!overlaySrc || !isMainWindowState(wc)) return;
  wc.executeJavaScript(overlaySrc, true).then(() => {
    /* 无条件推送：updater 不可用时也要让面板拿到 rateLine 真值（缺省开） */
    pushPluginState(wc, pluginUpdater ? pluginUpdater.status() : {});
  }).catch(() => { });
}

const hook = (wc) => {
  if (!isMainWindowState(wc)) return;
  wc.on("did-finish-load", () => injectOverlay(wc));
  if (wc.isLoading()) return;
  injectOverlay(wc);
};
app.on("web-contents-created", (e, wc) => hook(wc));
for (const wc of webContents.getAllWebContents()) hook(wc);

/* 测试接缝：vm 沙箱加载后取内部引用复现真实控制流；生产加载方（asar 动态 import）不用它。 */
if (typeof module === "object" && module && module.exports) {
  module.exports.__zusageTest = {
    handlePayload, maybeSpawn, isRemoteSid, remoteSids, pendingSids,
    targetByIdentity: () => targetByIdentity,
  };
}

LOG("injected v12 (auto remote targets from client setting.json, per-sid multi-server routing, sticky remote marks + pending-retry self recovery, per-pane wants array, resident query mode, answer_rate_line config write, plugin request polling decoupled from updater availability)");
