"use strict";
/* ZCode 扩展入口（CommonJS）。宿主用 import() 加载本文件并取 activate / deactivate。
 * 放在插件顶层、用 .cjs 后缀，是因为在野旧版解包器只放行顶层 .py/.cjs/.js 与
 * hooks/*.py、commands/*.md、skills/…；新建子目录或 .mjs/.html 会让旧版用户无法自动更新。 */
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STATE_FILE = "ui-state.json";
const OPEN_REQ_DIR = path.join(os.homedir(), ".zcode", "zcode-token-usage-statusbar");
const OPEN_REQ_FILE = "ext-open-request.json";
const CAPTURE_FILE = "req-capture.json";
const INSIGHTS_STATE_URI = "ui://zcode-token-usage-statusbar/insights/state";
const CONTEXT_STATE_URI = "ui://zcode-token-usage-statusbar/context/state";
const STALE_OPEN_REQ_MS = 15000;

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(obj), "utf8");
  fs.renameSync(tmp, filePath);
}

/* 请求抓包开关：运行目录 req-capture.json 的 enabled===true。引擎 prologue（engine-patch.cjs
 * CAPTURE_PROLOGUE）每次模型请求前读它（5 秒 mtime 缓存）；只落 system 与工具 schema。 */
function readCaptureConfig(configPath) {
  // 文件缺失、损坏或 enabled 不是布尔 true，一律按关闭
  try {
    const d = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return { enabled: Boolean(d && typeof d === "object" && d.enabled === true) };
  } catch {
    return { enabled: false };
  }
}

function writeCaptureConfig(configPath, enabled) {
  writeJsonAtomic(configPath, { enabled: enabled === true });   // 与 readCaptureConfig 同样严格：只有布尔 true 才写开启
  return readCaptureConfig(configPath);
}

/* context_browser 入参 → zusage.py session-browser 的选项（单个 JSON 位置参数）：
 * 逐轮模式（turnId）与游标翻页（before=上一页最老一条的 sequence/time/id）；越界或畸形值不透传。 */
function browserOptions(input) {
  const num = (v, dflt, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
  const opts = { limit: num(input && input.limit, 80, 1, 300), offset: num(input && input.offset, 0, 0, 1e6) };
  const tid = input && typeof input.turnId === "string" ? input.turnId : "";
  if (tid && tid.length <= 128) opts.turnId = tid;
  const b = input && input.before;
  const s = b && typeof b === "object" ? b.s : undefined;
  const sOk = typeof s === "number" || (typeof s === "string" && s.trim() !== "");   // Number(null)/Number("") 会变成 0，不能当游标
  if (sOk && Number.isFinite(Number(s))) {
    opts.before = { s: Number(s), t: Number(b.t) || 0, id: String(b.id || "").slice(0, 128) };
  }
  return opts;
}

function expandHome(p, homeDir) {
  if (typeof p !== "string" || !p) return "";
  if (p === "~") return homeDir;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homeDir, p.slice(2));
  return p;
}

function existsSafe(p) {
  if (!p || typeof p !== "string") return false;
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function isUnderRoot(targetPath, rootPath) {
  if (!targetPath || !rootPath) return false;
  const rel = path.relative(rootPath, targetPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function detectAppResourcesDir() {
  if (typeof process.resourcesPath === "string" && existsSafe(process.resourcesPath)) {
    return process.resourcesPath;
  }
  const exec = typeof process.execPath === "string" ? process.execPath : "";
  const appIdx = exec.indexOf(".app/Contents/");
  if (appIdx > 0) {
    const cand = path.join(exec.slice(0, appIdx + 4), "Contents", "Resources");
    if (existsSafe(cand)) return cand;
  }
  if (process.platform === "darwin" && existsSafe("/Applications/ZCode.app/Contents/Resources")) {
    return "/Applications/ZCode.app/Contents/Resources";
  }
  return "";
}

function loadInstalledPlugins(homeDir) {
  const regPath = path.join(homeDir, ".zcode", "cli", "plugins", "installed_plugins.json");
  const raw = readJsonSafe(regPath);
  if (!raw || !Array.isArray(raw.plugins)) return [];
  return raw.plugins.filter((p) => p && typeof p.installPath === "string" && p.installPath);
}

function resolveSkillPath(skillName, { workspaceDir, homeDir, installedPlugins, appResourcesDir }) {
  if (!skillName || typeof skillName !== "string" || skillName === "skills_listing") return "";
  const raw = skillName.trim();
  if (!raw || raw.includes("..") || raw.includes("/") || raw.includes("\\")) {
    const expanded = expandHome(raw, homeDir);
    if (path.isAbsolute(expanded) && existsSafe(expanded)) return expanded;
    return "";
  }
  let pluginPrefix = "";
  let bareName = raw;
  const colonIdx = raw.indexOf(":");
  if (colonIdx > 0) {
    pluginPrefix = raw.slice(0, colonIdx);
    bareName = raw.slice(colonIdx + 1);
  }
  const pickExisting = (dir) => {
    if (!dir) return "";
    const skillMd = path.join(dir, "SKILL.md");
    if (existsSafe(skillMd)) return skillMd;
    if (existsSafe(dir)) return dir;
    return "";
  };

  if (pluginPrefix) {
    for (const plug of installedPlugins) {
      if (plug.name === pluginPrefix || (typeof plug.id === "string" && plug.id.startsWith(pluginPrefix + "@"))) {
        const hit = pickExisting(path.join(plug.installPath, "skills", bareName));
        if (hit) return hit;
      }
    }
  }

  const bases = [];
  if (workspaceDir) {
    bases.push(
      path.join(workspaceDir, ".zcode", "skills", bareName),
      path.join(workspaceDir, ".claude", "skills", bareName),
      path.join(workspaceDir, ".agents", "skills", bareName),
    );
  }
  if (homeDir) {
    bases.push(
      path.join(homeDir, ".zcode", "skills", bareName),
      path.join(homeDir, ".claude", "skills", bareName),
      path.join(homeDir, ".agents", "skills", bareName),
      path.join(homeDir, ".codex", "skills", bareName),
      path.join(homeDir, ".codex", "skills", ".system", bareName),
    );
  }
  for (const cand of bases) {
    const hit = pickExisting(cand);
    if (hit) return hit;
  }

  for (const plug of installedPlugins) {
    const hit = pickExisting(path.join(plug.installPath, "skills", bareName));
    if (hit) return hit;
  }

  if (appResourcesDir) {
    const pkgsDir = path.join(appResourcesDir, "glm", "packages");
    const bundledHit = pickExisting(path.join(pkgsDir, "bundled-skills", "skills", bareName));
    if (bundledHit) return bundledHit;
    const directPkgHit = pickExisting(path.join(pkgsDir, `${bareName}-plugin`, "skills", bareName));
    if (directPkgHit) return directPkgHit;
    try {
      for (const entry of fs.readdirSync(pkgsDir)) {
        const hit = pickExisting(path.join(pkgsDir, entry, "skills", bareName));
        if (hit) return hit;
      }
    } catch { /* ignore */ }
  }
  return "";
}

function resolveMcpToolPath(toolName, { workspaceDir, homeDir, installedPlugins }) {
  if (typeof toolName !== "string" || !toolName.startsWith("mcp__")) return "";
  const parts = toolName.split("__");
  const serverName = parts[1] || "";
  if (!serverName) return "";

  for (const plug of installedPlugins) {
    if (serverName.includes(plug.name)) {
      const mcpJson = path.join(plug.installPath, ".mcp.json");
      if (existsSafe(mcpJson)) return mcpJson;
      if (existsSafe(plug.installPath)) return plug.installPath;
    }
    const mcpJson = path.join(plug.installPath, ".mcp.json");
    const cfg = readJsonSafe(mcpJson);
    const servers = (cfg && (cfg.mcpServers || cfg)) || null;
    if (servers && typeof servers === "object" && Object.prototype.hasOwnProperty.call(servers, serverName)) {
      return mcpJson;
    }
  }
  if (workspaceDir) {
    const wsMcp = path.join(workspaceDir, ".mcp.json");
    if (existsSafe(wsMcp)) return wsMcp;
  }
  if (homeDir) {
    const userCfg = path.join(homeDir, ".zcode", "cli", "config.json");
    if (existsSafe(userCfg)) return userCfg;
  }
  return "";
}

function enrichContextPaths(composition, opts = {}) {
  const homeDir = opts.homeDir || os.homedir();
  const workspaceDir = typeof opts.workspaceDir === "string" && existsSafe(opts.workspaceDir) ? opts.workspaceDir : "";
  const appResourcesDir = opts.appResourcesDir !== undefined ? opts.appResourcesDir : detectAppResourcesDir();
  const installedPlugins = Array.isArray(opts.installedPlugins) ? opts.installedPlugins : loadInstalledPlugins(homeDir);

  const contextPaths = {
    homeDir,
    workspaceDir,
    categories: {},
    itemPaths: {},
  };
  if (!composition || !Array.isArray(composition.categories)) return contextPaths;

  const pushUnique = (arr, labelZh, labelEn, targetPath) => {
    if (!targetPath || !existsSafe(targetPath)) return;
    if (!arr.some((x) => x.path === targetPath)) {
      arr.push({ labelZh, labelEn, path: targetPath });
    }
  };

  for (const cat of composition.categories) {
    if (!cat || !cat.id) continue;
    const catPaths = [];
    const itemMap = {};

    if (cat.id === "meta_user_context") {
      if (workspaceDir) {
        pushUnique(catPaths, "项目 AGENTS.md", "Project AGENTS.md", path.join(workspaceDir, "AGENTS.md"));
        pushUnique(catPaths, ".zcode/AGENTS.md", ".zcode/AGENTS.md", path.join(workspaceDir, ".zcode", "AGENTS.md"));
        pushUnique(catPaths, "项目 CLAUDE.md", "Project CLAUDE.md", path.join(workspaceDir, "CLAUDE.md"));
      }
      if (homeDir) {
        pushUnique(catPaths, "全局 AGENTS.md", "Global AGENTS.md", path.join(homeDir, ".zcode", "AGENTS.md"));
        pushUnique(catPaths, "记忆目录", "Memories", path.join(homeDir, ".zcode", "cli", "memories", "projects"));
      }
    } else if (cat.id === "skills") {
      if (workspaceDir) pushUnique(catPaths, "项目技能目录", "Project skills", path.join(workspaceDir, ".zcode", "skills"));
      if (homeDir) pushUnique(catPaths, "全局技能目录", "Global skills", path.join(homeDir, ".zcode", "skills"));
    } else if (cat.id === "mcp_tool_schemas") {
      if (workspaceDir) pushUnique(catPaths, "项目 .mcp.json", "Project .mcp.json", path.join(workspaceDir, ".mcp.json"));
      if (homeDir) pushUnique(catPaths, "全局 MCP 配置", "Global MCP config", path.join(homeDir, ".zcode", "cli", "config.json"));
    } else if (cat.id === "system_prompt" || cat.id === "tool_prompt" || cat.id === "system_tool_schemas") {
      if (appResourcesDir) {
        const glmEntry = path.join(appResourcesDir, "glm", "zcode.cjs");
        pushUnique(catPaths, "内置引擎", "Built-in engine", existsSafe(glmEntry) ? glmEntry : appResourcesDir);
      }
    } else if (cat.id === "messages" && workspaceDir) {
      pushUnique(catPaths, "会话工作区", "Workspace", workspaceDir);
    }

    for (const it of cat.items || []) {
      if (!it || typeof it.name !== "string") continue;
      const expanded = expandHome(it.name, homeDir);
      if (path.isAbsolute(expanded) && existsSafe(expanded)) {
        itemMap[it.name] = expanded;
        continue;
      }
      if (cat.id === "skills") {
        const sp = resolveSkillPath(it.name, { workspaceDir, homeDir, installedPlugins, appResourcesDir });
        if (sp) itemMap[it.name] = sp;
      } else if (cat.id === "mcp_tool_schemas" || cat.id === "deferred_tool_schemas") {
        const mp = resolveMcpToolPath(it.name, { workspaceDir, homeDir, installedPlugins });
        if (mp) itemMap[it.name] = mp;
      } else if (cat.id === "reminders") {
        if ((it.name === "environment" || it.name === "session_context") && workspaceDir) {
          itemMap[it.name] = workspaceDir;
        } else if (it.name === "agent_listing_delta") {
          const wsAgents = workspaceDir ? path.join(workspaceDir, ".zcode", "agents") : "";
          const globalAgents = homeDir ? path.join(homeDir, ".zcode", "cli", "agents") : "";
          if (existsSafe(wsAgents)) itemMap[it.name] = wsAgents;
          else if (existsSafe(globalAgents)) itemMap[it.name] = globalAgents;
        } else if (it.name === "hook_context") {
          const wsHooks = workspaceDir ? path.join(workspaceDir, ".zcode") : "";
          const globalCfg = homeDir ? path.join(homeDir, ".zcode", "cli", "config.json") : "";
          if (existsSafe(wsHooks)) itemMap[it.name] = wsHooks;
          else if (existsSafe(globalCfg)) itemMap[it.name] = globalCfg;
        }
      }
    }

    if (catPaths.length) contextPaths.categories[cat.id] = catPaths;
    if (Object.keys(itemMap).length) contextPaths.itemPaths[cat.id] = itemMap;
  }

  return contextPaths;
}

function revealOrOpenFolder(rawPath, { allowedRoots = [], platform = process.platform, execFn = execFile, homeDir = os.homedir() } = {}) {
  return new Promise((resolve) => {
    if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.includes("\0")) {
      resolve({ ok: false, error: "invalid-path" });
      return;
    }
    const expanded = path.resolve(expandHome(rawPath.trim(), homeDir));
    const normalizedRoots = allowedRoots
      .filter((r) => typeof r === "string" && r.trim())
      .map((r) => path.resolve(r));
    if (!normalizedRoots.some((root) => isUnderRoot(expanded, root))) {
      resolve({ ok: false, error: "forbidden-path" });
      return;
    }

    let target = expanded;
    let st = null;
    try {
      st = fs.statSync(target);
    } catch {
      const parent = path.dirname(target);
      if (normalizedRoots.some((root) => isUnderRoot(parent, root))) {
        try {
          const pst = fs.statSync(parent);
          if (pst.isDirectory()) {
            target = parent;
            st = pst;
          }
        } catch { /* ignore */ }
      }
    }
    if (!st) {
      resolve({ ok: false, error: "path-not-found" });
      return;
    }

    const isFile = st.isFile();
    let realTarget = target;
    if (!isFile) {
      try { realTarget = fs.realpathSync(target); } catch { /* keep target */ }
    }
    // 符号链接：目录换成真实目标后必须仍在受信根内（根内链接指向根外时不揭示）。两边都按真实路径比，
    // 否则 /var → /private/var 这类系统级链接会把根内的普通目录误判成根外。
    const realRoots = normalizedRoots.map((root) => {
      try { return fs.realpathSync(root); } catch { return root; }   // 逐个换真实路径；不存在的根保留原值，不拖累其它根
    });
    if (realTarget !== target && !realRoots.some((root) => isUnderRoot(realTarget, root))) {
      resolve({ ok: false, error: "forbidden-path" });
      return;
    }

    if (platform === "darwin") {
      const args = isFile || realTarget.endsWith(".app") ? ["-R", isFile ? target : realTarget] : [realTarget];
      execFn("open", args, { timeout: 8000 }, (err) => {
        if (err && isFile) {
          execFn("open", [path.dirname(target)], { timeout: 8000 }, (err2) => {
            resolve(err2 ? { ok: false, error: err2.message || "open-failed" } : { ok: true, path: path.dirname(target) });
          });
          return;
        }
        resolve(err ? { ok: false, error: err.message || "open-failed" } : { ok: true, path: isFile ? target : realTarget });
      });
      return;
    }

    if (platform === "win32") {
      const args = isFile ? [`/select,${target}`] : [realTarget];
      execFn("explorer.exe", args, { timeout: 8000, windowsHide: true }, () => {
        // explorer.exe often exits with code 1 even after opening the window successfully
        resolve({ ok: true, path: isFile ? target : realTarget });
      });
      return;
    }

    const dirToOpen = isFile ? path.dirname(target) : realTarget;
    execFn("xdg-open", [dirToOpen], { timeout: 8000 }, (err) => {
      resolve(err ? { ok: false, error: err.message || "open-failed" } : { ok: true, path: dirToOpen });
    });
  });
}

function runZusageCli(pluginPath, args) {
  const scriptPath = path.join(pluginPath, "zusage.py");
  const pyCandidates = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  return new Promise((resolve) => {
    let idx = 0;
    function tryNext() {
      if (idx >= pyCandidates.length) {
        resolve({ ok: false, error: "python not found" });
        return;
      }
      const py = pyCandidates[idx++];
      execFile(
        py,
        ["-B", scriptPath, ...args],
        { timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          if (err) {
            if (err.code === "ENOENT") {
              tryNext();
              return;
            }
            resolve({ ok: false, error: err.message || "zusage failed" });
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch (e) {
            resolve({ ok: false, error: "invalid json from zusage.py" });
          }
        },
      );
    }
    tryNext();
  });
}

async function activate(ctx) {
  const disposables = [];
  const contextViews = new Map();
  const insightsViews = new Set();
  const insightsCache = new Map(); // days -> { data, ts }
  const insightsInflight = new Map(); // days -> Promise
  const INSIGHTS_TTL_MS = 30000;
  const bootAt = Date.now();
  let lastHandledReqId = "";
  let currentLocale = "zh-CN";
  let currentSessions = [];
  let watcher = null;
  let watchTimer = null;
  const warmTimers = new Set();   // 视图打开后的洞察预热定时器：停用时统一清掉，且不拖住进程

  const uiStatePath = path.join(ctx.extension.dataPath, STATE_FILE);
  const captureConfigPath = path.join(OPEN_REQ_DIR, CAPTURE_FILE);
  let uiState = readJsonSafe(uiStatePath) || {};

  try {
    const env = await ctx.env.get();
    if (env && typeof env.locale === "string" && env.locale) currentLocale = env.locale;
  } catch { /* host-unavailable */ }

  try {
    const list = await ctx.workbench.visibleSessions();
    if (Array.isArray(list)) currentSessions = list;
  } catch { /* host-unavailable */ }

  if (!uiState.insightsSeen) {
    try {
      ctx.slots.update("insights", { badge: "dot" }, "app");
    } catch { /* ignore */ }
  }

  function markInsightsSeen() {
    if (uiState.insightsSeen) return;
    uiState = { ...uiState, insightsSeen: true, seenAt: Date.now() };
    try {
      writeJsonAtomic(uiStatePath, uiState);
    } catch { /* ignore */ }
    try {
      ctx.slots.update("insights", { badge: null }, "app");
    } catch { /* ignore */ }
  }

  function extractWorkspacePath(ws) {
    if (!ws) return "";
    if (typeof ws === "string") return ws;
    if (typeof ws === "object") {
      for (const k of ["rootPath", "path", "directory", "cwd"]) {
        if (typeof ws[k] === "string" && ws[k]) return ws[k];
      }
    }
    return "";
  }

  function pickTargetSession(view) {
    if (view && view.sessionId) {
      const matched = currentSessions.find((s) => s.sessionId === view.sessionId);
      return {
        sessionId: view.sessionId,
        isDraft: matched ? Boolean(matched.isDraft) : false,
        inWorkbench: Boolean(matched),
        workspaceDir: matched ? extractWorkspacePath(matched.workspace) : "",
      };
    }
    const focused = currentSessions.find((s) => s.focused) || currentSessions[0] || null;
    if (!focused) return { sessionId: "", isDraft: false, inWorkbench: false, workspaceDir: "" };
    return {
      sessionId: focused.sessionId,
      isDraft: Boolean(focused.isDraft),
      inWorkbench: true,
      workspaceDir: extractWorkspacePath(focused.workspace),
    };
  }

  async function buildContextSnapshot(view) {
    const target = pickTargetSession(view);
    if (!target.sessionId) {
      return {
        status: "no-session",
        sessionId: "",
        isDraft: false,
        locale: currentLocale,
        composition: null,
        stats: null,
        contextPaths: null,
        capture: readCaptureConfig(captureConfigPath),
      };
    }
    const [compRes, statsRes] = await Promise.allSettled([
      ctx.context.get({ sessionId: target.sessionId }),
      runZusageCli(ctx.extension.path, ["session-stats", target.sessionId]),
    ]);
    const composition = compRes.status === "fulfilled" ? compRes.value : null;
    const stats = statsRes.status === "fulfilled" && statsRes.value && statsRes.value.ok ? statsRes.value : null;
    const workspaceDir = (stats && stats.session && stats.session.directory) || target.workspaceDir || "";
    const contextPaths = composition ? enrichContextPaths(composition, { workspaceDir }) : null;
    const status = composition ? "ready" : (stats ? "stats-only" : (target.inWorkbench ? "unsupported" : "unavailable"));
    return {
      status,
      sessionId: target.sessionId,
      isDraft: target.isDraft,
      locale: currentLocale,
      composition,
      stats,
      contextPaths,
      capture: readCaptureConfig(captureConfigPath),
    };
  }

  async function buildContextBrowser(view, input) {
    const target = pickTargetSession(view);
    if (!target.sessionId) return { ok: false, error: "no-session" };
    return runZusageCli(ctx.extension.path, ["session-browser", target.sessionId, JSON.stringify(browserOptions(input))]);
  }

  function notifyAllContextViews() {
    for (const view of contextViews.values()) {
      try { view.notify(CONTEXT_STATE_URI); } catch { /* ignore */ }
    }
  }

  function notifyAllInsightsViews() {
    for (const view of insightsViews) {
      try { view.notify(INSIGHTS_STATE_URI); } catch { /* ignore */ }
    }
  }

  function fetchInsightsCached(days) {
    const key = Number.isFinite(Number(days)) ? Number(days) : 7;
    const cacheable = key === 0 || key === 1 || key === 7 || key === 30;   // 只缓存视图用到的档位，别的 days 不占内存
    const hit = cacheable ? insightsCache.get(key) : undefined;
    if (hit && Date.now() - hit.ts < INSIGHTS_TTL_MS) {
      return Promise.resolve({ ...hit.data, locale: currentLocale, extensionVersion: ctx.extension.version });
    }
    if (insightsInflight.has(key)) return insightsInflight.get(key);
    const p = runZusageCli(ctx.extension.path, ["insights", String(key)]).then((data) => {
      insightsInflight.delete(key);
      if (cacheable && data && data.ok) insightsCache.set(key, { data, ts: Date.now() });
      return { ...data, locale: currentLocale, extensionVersion: ctx.extension.version };
    }, (err) => {
      insightsInflight.delete(key);
      return { ok: false, error: err && err.message ? err.message : "insights failed" };
    });
    insightsInflight.set(key, p);
    return p;
  }

  function warmInsightsAll() {
    for (const d of [1, 7, 30, 0]) {
      const hit = insightsCache.get(d);
      if (!hit || Date.now() - hit.ts >= INSIGHTS_TTL_MS) {
        void fetchInsightsCached(d);
      }
    }
  }

  disposables.push(
    ctx.views.register("insights", {
      entry: "./extension-view-insights.js",
      onDidOpen(view) {
        insightsViews.add(view);
        markInsightsSeen();
        const warmTimer = setTimeout(() => {
          warmTimers.delete(warmTimer);
          warmInsightsAll();
        }, 150);
        warmTimers.add(warmTimer);
        if (typeof warmTimer.unref === "function") warmTimer.unref();
        view.onDidClose(() => insightsViews.delete(view));
      },
      tools: {
        insights_snapshot: {
          description: "Read cross-session context insights snapshot",
          inputSchema: {
            type: "object",
            properties: {
              days: { type: "number" },
            },
          },
          run: async (input) => {
            const raw = input && input.days !== undefined ? Number(input.days) : 7;
            const days = raw === 0 ? 0 : (Number.isFinite(raw) ? Math.max(1, Math.min(365, raw)) : 7);
            return fetchInsightsCached(days);
          },
        },
        insights_open_session: {
          description: "Attempt to open a session by sessionId",
          inputSchema: {
            type: "object",
            properties: {
              sessionId: { type: "string" },
            },
            required: ["sessionId"],
          },
          run: async (input) => {
            const sid = input && typeof input.sessionId === "string" ? input.sessionId : "";
            if (!sid) return { ok: false, error: "missing sessionId" };
            // 与 ext-open-request.json 文件链同一道门：只接受会话 id 的形状
            if (!/^sess_[A-Za-z0-9_-]{1,120}$/.test(sid)) return { ok: false, error: "invalid sessionId" };
            try {
              if (ctx.sessions && typeof ctx.sessions.openSession === "function") {
                await ctx.sessions.openSession({ session: { kind: "app", sessionId: sid } });
                return { ok: true };
              }
            } catch (e) {
              return { ok: false, error: e && e.code ? e.code : "unavailable" };
            }
            return { ok: false, error: "unavailable" };
          },
        },
      },
      resources: {
        [INSIGHTS_STATE_URI]: {
          mimeType: "application/json",
          read: async () => JSON.stringify({ ts: Date.now(), locale: currentLocale }),
        },
      },
    }),
  );

  disposables.push(
    ctx.views.register("context", {
      entry: "./extension-view-context.js",
      onDidOpen(view) {
        contextViews.set(view.id, view);
        view.onDidClose(() => contextViews.delete(view.id));
      },
      tools: {
        context_snapshot: {
          description: "Read current session context composition and stats",
          inputSchema: { type: "object", properties: {} },
          run: async (_input, call) => buildContextSnapshot(call.view),
        },
        context_browser: {
          description: "Read current session messages, tool calls, file activity and events",
          inputSchema: {
            type: "object",
            properties: {
              limit: { type: "number" },
              offset: { type: "number" },
              turnId: { type: "string", description: "Only this turn's messages, oldest first" },
              before: {
                type: "object",
                description: "Cursor of the oldest loaded message; returns older messages",
                properties: { s: { type: "number" }, t: { type: "number" }, id: { type: "string" } },
              },
            },
          },
          run: async (input, call) => buildContextBrowser(call.view, input),
        },
        context_open_folder: {
          description: "Reveal file or open folder in system file manager",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
          },
          run: async (input, call) => {
            const rawPath = input && typeof input.path === "string" ? input.path : "";
            const homeDir = os.homedir();
            const allowedRoots = [homeDir, detectAppResourcesDir()].filter(Boolean);
            for (const s of currentSessions) {
              const wp = extractWorkspacePath(s && s.workspace);
              if (wp) allowedRoots.push(wp);
            }
            const expanded = path.resolve(expandHome(rawPath.trim(), homeDir));
            if (!allowedRoots.some((r) => isUnderRoot(expanded, path.resolve(r)))) {
              const target = pickTargetSession(call && call.view);
              if (target.sessionId) {
                const st = await runZusageCli(ctx.extension.path, ["session-stats", target.sessionId]);
                if (st && st.ok && st.session && typeof st.session.directory === "string" && st.session.directory) {
                  allowedRoots.push(st.session.directory);
                }
              }
            }
            return revealOrOpenFolder(rawPath, { allowedRoots, homeDir });
          },
        },
        context_capture_set: {
          description: "Turn request capture on or off (stores system prompt and tool schemas only, never message bodies)",
          inputSchema: {
            type: "object",
            properties: { enabled: { type: "boolean" } },
            required: ["enabled"],
          },
          run: async (input) => {
            if (!input || typeof input.enabled !== "boolean") return { ok: false, error: "missing enabled" };
            try {
              return { ok: true, ...writeCaptureConfig(captureConfigPath, input.enabled) };
            } catch (e) {
              return { ok: false, error: e && e.message ? e.message : "write failed" };
            }
          },
        },
      },
      resources: {
        [CONTEXT_STATE_URI]: {
          mimeType: "application/json",
          read: async () => JSON.stringify({ ts: Date.now(), locale: currentLocale }),
        },
      },
    }),
  );

  disposables.push(
    ctx.commands.register("open-insights", async () => {
      await ctx.views.open("insights", "app");
    }),
  );

  disposables.push(
    ctx.commands.register("open-context", async (call) => {
      const scope = call && call.scope && call.scope.kind === "session" && call.scope.sessionId
        ? { sessionId: call.scope.sessionId }
        : undefined;
      await ctx.views.open("context", scope);
    }),
  );

  disposables.push(
    ctx.env.onDidChange((e) => {
      if (e && typeof e.locale === "string" && e.locale) {
        currentLocale = e.locale;
        notifyAllContextViews();
        notifyAllInsightsViews();
      }
    }),
  );

  disposables.push(
    ctx.workbench.onDidChange((e) => {
      if (e && Array.isArray(e.sessions)) {
        currentSessions = e.sessions;
        notifyAllContextViews();
      }
    }),
  );

  disposables.push(
    ctx.context.onDidChange((e) => {
      if (!e || !e.sessionId) return;
      for (const view of contextViews.values()) {
        const target = pickTargetSession(view);
        if (target.sessionId === e.sessionId) {
          try { view.notify(CONTEXT_STATE_URI); } catch { /* ignore */ }
        }
      }
    }),
  );

  async function processOpenRequestFile() {
    const reqPath = path.join(OPEN_REQ_DIR, OPEN_REQ_FILE);
    const req = readJsonSafe(reqPath);
    if (!req || typeof req !== "object") return;
    const reqId = typeof req.id === "string" ? req.id : "";
    const ts = typeof req.ts === "number" ? req.ts : 0;
    if (!reqId || reqId === lastHandledReqId) return;
    if (ts < bootAt - STALE_OPEN_REQ_MS) return;
    lastHandledReqId = reqId;
    const viewId = req.viewId === "insights" ? "insights" : req.viewId === "context" ? "context" : "";
    if (!viewId) return;
    try {
      if (viewId === "insights") {
        await ctx.views.open("insights", "app");
      } else {
        const rawSid = typeof req.sessionId === "string" ? req.sessionId.trim() : "";
        const sid = rawSid.startsWith("sess_") ? rawSid : "";
        await ctx.views.open("context", sid ? { sessionId: sid } : undefined);
      }
    } catch (err) {
      ctx.log.warn("open view from overlay failed:", err && err.message ? err.message : String(err));
    }
  }

  try {
    fs.mkdirSync(OPEN_REQ_DIR, { recursive: true });
    watcher = fs.watch(OPEN_REQ_DIR, (_eventType, filename) => {
      if (filename && filename !== OPEN_REQ_FILE) return;
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        watchTimer = null;
        void processOpenRequestFile();
      }, 30);
    });
    watcher.on("error", () => { /* ignore watch errors */ });
  } catch { /* ignore */ }

  return {
    dispose() {
      for (const t of warmTimers) clearTimeout(t);
      warmTimers.clear();
      if (watchTimer) {
        clearTimeout(watchTimer);
        watchTimer = null;
      }
      if (watcher) {
        try { watcher.close(); } catch { /* ignore */ }
        watcher = null;
      }
      for (const d of disposables) {
        try { d.dispose(); } catch { /* ignore */ }
      }
    },
  };
}

function deactivate() {
  /* resources are disposed via returned Disposable */
}

module.exports = { activate, deactivate, enrichContextPaths, revealOrOpenFolder, readCaptureConfig, writeCaptureConfig, browserOptions };
