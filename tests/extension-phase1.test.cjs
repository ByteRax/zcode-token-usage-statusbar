"use strict";
// 用 CommonJS 写这个测试文件：全量脚本 scripts/check_all.py 只收 tests/*.test.cjs，.mjs 测试不会被执行。
// 入口是 CommonJS（顶层 extension-main.cjs，见 specs/context-insights-extension.md §5）：经 createRequire 加载。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const requirePlugin = createRequire(__filename);
// 扩展进程按 ZUSAGE_PLUGIN_RUNTIME 定位运行目录（未设则用标准的 ~/.zcode/zcode-token-usage-statusbar）：
// 测试指向临时目录，activate() 的 mkdir / watch / 轮询都不落在个人运行目录上（AGENTS.md §6）
const RUNTIME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-ext-runtime-"));
process.env.ZUSAGE_PLUGIN_RUNTIME = RUNTIME_TMP;
process.on("exit", () => { try { fs.rmSync(RUNTIME_TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
const { activate, enrichContextPaths, revealOrOpenFolder } = requirePlugin("../plugins/zcode-token-usage-statusbar/extension-main.cjs");

test("extension.mjs phase 1: dot badge, views, context_snapshot and commands", async () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-ext-data-"));
  const slotUpdates = [];
  const openedViews = [];
  const registeredViews = {};
  const registeredCommands = {};

  const ctx = {
    extension: {
      id: "zcode-token-usage-statusbar",
      version: "1.5.25",
      path: path.resolve("plugins/zcode-token-usage-statusbar"),
      dataPath,
    },
    log: { info() {}, warn() {}, error() {} },
    slots: {
      update(itemId, patch, scope) {
        slotUpdates.push({ itemId, patch, scope });
      },
    },
    views: {
      register(id, def) {
        registeredViews[id] = def;
        return { dispose() {} };
      },
      async open(id, scope) {
        openedViews.push({ id, scope });
      },
    },
    commands: {
      register(id, run) {
        registeredCommands[id] = run;
        return { dispose() {} };
      },
    },
    env: {
      async get() { return { locale: "zh-CN" }; },
      onDidChange() { return { dispose() {} }; },
    },
    workbench: {
      async visibleSessions() {
        return [{ sessionId: "sess_1", isDraft: false, focused: true }];
      },
      onDidChange() { return { dispose() {} }; },
    },
    context: {
      async get({ sessionId }) {
        return sessionId === "sess_1"
          ? { sessionId: "sess_1", estimatedTokens: 1200, categories: [{ id: "messages", tokens: 1200, chars: 4800 }] }
          : null;
      },
      onDidChange() { return { dispose() {} }; },
    },
  };

  const handle = await activate(ctx);
  try {
    // 1. First activation sets dot badge on insights
    assert.deepEqual(slotUpdates[0], { itemId: "insights", patch: { badge: "dot" }, scope: "app" });

    // 2. Opening insights view clears dot badge and persists ui-state.json
    const closeListeners = [];
    registeredViews.insights.onDidOpen({
      id: "v-ins-1",
      notify() {},
      onDidClose(fn) { closeListeners.push(fn); return { dispose() {} }; },
    });
    assert.deepEqual(slotUpdates[1], { itemId: "insights", patch: { badge: null }, scope: "app" });
    const persisted = JSON.parse(fs.readFileSync(path.join(dataPath, "ui-state.json"), "utf8"));
    assert.equal(persisted.insightsSeen, true);

    // 3. context_snapshot returns composition for focused session
    const snap = await registeredViews.context.tools.context_snapshot.run({}, { view: { id: "v-ctx-1", sessionId: "sess_1" } });
    assert.equal(snap.status, "ready");
    assert.equal(snap.sessionId, "sess_1");
    assert.equal(snap.composition.estimatedTokens, 1200);

    // 4. Commands call views.open
    await registeredCommands["open-insights"]({ scope: { kind: "app" } });
    await registeredCommands["open-context"]({ scope: { kind: "session", sessionId: "sess_1" } });
    assert.deepEqual(openedViews, [
      { id: "insights", scope: "app" },
      { id: "context", scope: { sessionId: "sess_1" } },
    ]);
  } finally {
    handle.dispose();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("enrichContextPaths resolves instruction files, skills, bundled skills, MCP tools and workspace", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-ctx-paths-"));
  try {
    const homeDir = path.join(tmp, "home");
    const wsDir = path.join(tmp, "ws");
    const appRes = path.join(tmp, "Resources");
    const plugDir = path.join(homeDir, ".zcode", "cli", "plugins", "cache", "mkt", "my-plug", "1.0.0");

    fs.mkdirSync(path.join(homeDir, ".zcode", "skills", "lark-drive"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".zcode", "skills", "lark-drive", "SKILL.md"), "# lark");
    fs.writeFileSync(path.join(homeDir, ".zcode", "AGENTS.md"), "# global");
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, "AGENTS.md"), "# ws");
    fs.mkdirSync(path.join(appRes, "glm", "packages", "pdf-plugin", "skills", "pdf"), { recursive: true });
    fs.writeFileSync(path.join(appRes, "glm", "packages", "pdf-plugin", "skills", "pdf", "SKILL.md"), "# pdf");
    fs.writeFileSync(path.join(appRes, "glm", "zcode.cjs"), "// engine");
    fs.mkdirSync(path.join(plugDir, "skills", "plug-skill"), { recursive: true });
    fs.writeFileSync(path.join(plugDir, "skills", "plug-skill", "SKILL.md"), "# plug");
    fs.writeFileSync(path.join(plugDir, ".mcp.json"), JSON.stringify({ mcpServers: { demo: {} } }));

    const composition = {
      categories: [
        {
          id: "meta_user_context",
          tokens: 1000,
          chars: 4000,
          items: [{ name: path.join(wsDir, "AGENTS.md"), tokens: 800 }],
        },
        {
          id: "skills",
          tokens: 500,
          chars: 2000,
          items: [
            { name: "lark-drive", tokens: 200 },
            { name: "pdf", tokens: 150 },
            { name: "my-plug:plug-skill", tokens: 150 },
          ],
        },
        {
          id: "mcp_tool_schemas",
          tokens: 300,
          chars: 1200,
          items: [{ name: "mcp__demo__ping", tokens: 300 }],
        },
        {
          id: "system_prompt",
          tokens: 200,
          chars: 800,
          items: [{ name: "Core", tokens: 200 }],
        },
      ],
    };

    const res = enrichContextPaths(composition, {
      homeDir,
      workspaceDir: wsDir,
      appResourcesDir: appRes,
      installedPlugins: [{ id: "my-plug@mkt", name: "my-plug", installPath: plugDir }],
    });

    assert.equal(res.workspaceDir, wsDir);
    assert.equal(res.itemPaths.meta_user_context[path.join(wsDir, "AGENTS.md")], path.join(wsDir, "AGENTS.md"));
    assert.equal(res.itemPaths.skills["lark-drive"], path.join(homeDir, ".zcode", "skills", "lark-drive", "SKILL.md"));
    assert.equal(res.itemPaths.skills["pdf"], path.join(appRes, "glm", "packages", "pdf-plugin", "skills", "pdf", "SKILL.md"));
    assert.equal(res.itemPaths.skills["my-plug:plug-skill"], path.join(plugDir, "skills", "plug-skill", "SKILL.md"));
    assert.equal(res.itemPaths.mcp_tool_schemas["mcp__demo__ping"], path.join(plugDir, ".mcp.json"));
    assert.equal(res.categories.system_prompt[0].path, path.join(appRes, "glm", "zcode.cjs"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("revealOrOpenFolder enforces allowedRoots and reveals files vs opens directories", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-open-folder-"));
  try {
    const allowedDir = path.join(tmp, "allowed");
    const subFile = path.join(allowedDir, "AGENTS.md");
    fs.mkdirSync(allowedDir, { recursive: true });
    fs.writeFileSync(subFile, "hi");

    const calls = [];
    const mockExec = (cmd, args, _opts, cb) => {
      calls.push({ cmd, args });
      cb(null);
    };

    // Rejects outside allowedRoots
    const denied = await revealOrOpenFolder("/etc/passwd", {
      allowedRoots: [allowedDir],
      platform: "darwin",
      execFn: mockExec,
      homeDir: allowedDir,
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, "forbidden-path");
    assert.equal(calls.length, 0);

    // Reveals file with -R on darwin (never executes file)
    const fileRes = await revealOrOpenFolder(subFile, {
      allowedRoots: [allowedDir],
      platform: "darwin",
      execFn: mockExec,
      homeDir: allowedDir,
    });
    assert.equal(fileRes.ok, true);
    assert.deepEqual(calls[0], { cmd: "open", args: ["-R", subFile] });

    // Opens directory directly on darwin
    const dirRes = await revealOrOpenFolder(allowedDir, {
      allowedRoots: [allowedDir],
      platform: "darwin",
      execFn: mockExec,
      homeDir: allowedDir,
    });
    assert.equal(dirRes.ok, true);
    assert.equal(calls[1].cmd, "open");
    assert.equal(calls[1].args.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("browserOptions clamps limits and only forwards well-formed turnId / before cursor", async () => {
  const { browserOptions } = requirePlugin("../plugins/zcode-token-usage-statusbar/extension-main.cjs");
  assert.deepEqual(browserOptions(undefined), { limit: 80, offset: 0 });
  assert.deepEqual(browserOptions({ limit: 9999, offset: -5 }), { limit: 300, offset: 0 });
  assert.deepEqual(browserOptions({ limit: "40", offset: "3" }), { limit: 40, offset: 3 });
  assert.deepEqual(browserOptions({ limit: "x", offset: null }), { limit: 80, offset: 0 });
  assert.deepEqual(browserOptions({ turnId: "turn_1" }), { limit: 80, offset: 0, turnId: "turn_1" });
  assert.deepEqual(browserOptions({ turnId: "" }), { limit: 80, offset: 0 }, "空轮号不透传");
  assert.deepEqual(browserOptions({ turnId: "x".repeat(129) }), { limit: 80, offset: 0 }, "超长轮号不透传");
  assert.deepEqual(browserOptions({ before: { s: 4, t: 1700000000000, id: "m4" } }), { limit: 80, offset: 0, before: { s: 4, t: 1700000000000, id: "m4" } });
  assert.deepEqual(browserOptions({ before: { s: "7", id: 5 } }), { limit: 80, offset: 0, before: { s: 7, t: 0, id: "5" } });
  assert.deepEqual(browserOptions({ before: { t: 1 } }), { limit: 80, offset: 0 }, "游标缺 s 不透传");
  assert.deepEqual(browserOptions({ before: { s: "x", t: 1 } }), { limit: 80, offset: 0 }, "游标 s 非数字不透传");
  assert.deepEqual(browserOptions({ before: { s: null, t: 1 } }), { limit: 80, offset: 0 }, "游标 s 为 null 不透传");
  assert.deepEqual(browserOptions({ before: { s: "", t: 1 } }), { limit: 80, offset: 0 }, "游标 s 为空串不透传（Number(\"\") 会变成 0）");
  assert.deepEqual(browserOptions({ before: { s: "  12 ", t: 1, id: "m" } }), { limit: 80, offset: 0, before: { s: 12, t: 1, id: "m" } }, "数字字符串照收");
  assert.deepEqual(browserOptions({ before: { s: Infinity } }), { limit: 80, offset: 0 }, "游标 s 为 Infinity 不透传");
  assert.deepEqual(browserOptions({ before: "4" }), { limit: 80, offset: 0 }, "游标不是对象不透传");
  const b = browserOptions({ before: { s: 1, id: "x".repeat(200) } });
  assert.equal(b.before.id.length, 128, "id 截断");
});

test("capture config helpers read/write the on/off switch atomically (temp path, never the real runtime dir)", async () => {
  const { readCaptureConfig, writeCaptureConfig } = requirePlugin("../plugins/zcode-token-usage-statusbar/extension-main.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-ext-capture-"));
  const cfg = path.join(dir, "req-capture.json");
  try {
    assert.deepEqual(readCaptureConfig(cfg), { enabled: false }, "文件不存在=关闭");
    assert.deepEqual(writeCaptureConfig(cfg, true), { enabled: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(cfg, "utf8")), { enabled: true }, "只写 enabled 一个键");
    assert.deepEqual(writeCaptureConfig(cfg, false), { enabled: false });
    assert.deepEqual(JSON.parse(fs.readFileSync(cfg, "utf8")), { enabled: false });
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith(".")).length, 0, "临时文件已改名，不留残骸");
    assert.deepEqual(writeCaptureConfig(cfg, "yes"), { enabled: false }, "非布尔值一律当关闭，不写 enabled:\"yes\"");
    assert.deepEqual(JSON.parse(fs.readFileSync(cfg, "utf8")), { enabled: false });
    fs.writeFileSync(cfg, "{broken");
    assert.deepEqual(readCaptureConfig(cfg), { enabled: false }, "损坏配置按关闭");
    fs.writeFileSync(cfg, '{"enabled":"yes"}');
    assert.deepEqual(readCaptureConfig(cfg), { enabled: false }, "只有布尔 true 才算开启");
    fs.writeFileSync(cfg, "[true]");
    assert.deepEqual(readCaptureConfig(cfg), { enabled: false });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("revealOrOpenFolder: a symlink inside the allowed root that resolves outside is refused", async () => {
  const { revealOrOpenFolder } = requirePlugin("../plugins/zcode-token-usage-statusbar/extension-main.cjs");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-ext-symlink-"));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  const real = path.join(base, "root", "real");
  // finally 里要摘这条链接：不能声明在 try 块内（块级作用域，finally 看不见，摘除会静默失败）
  const link = path.join(root, "escape");
  fs.mkdirSync(root); fs.mkdirSync(outside); fs.mkdirSync(real);
  try {
    // Windows 建目录符号链接要特权，junction 免特权、同样被 realpath 解析：用它覆盖同一条越界守卫
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    const opened = [];
    const execFn = (cmd, args, opts, cb) => { opened.push(args[0]); cb(null); };
    const opts = { allowedRoots: [root], platform: "darwin", execFn, homeDir: base };
    assert.deepEqual(await revealOrOpenFolder(path.join(root, "escape"), opts), { ok: false, error: "forbidden-path" });
    assert.deepEqual(opened, [], "没有调用任何打开命令");
    assert.equal((await revealOrOpenFolder(real, opts)).ok, true, "对照：根内的真实目录照常打开");
    assert.equal(opened.length, 1);
  } finally {
    // 先摘链接再递归清理：Node 的 rmSync(recursive) 在 Windows 上会把 junction 当目录、顺着它删目标内容，
    // 清到悬空处半途放弃，每跑一次在 %TEMP% 留一份残骸（目标 outside 在 base 内，不会越界）
    try { fs.unlinkSync(link); } catch { /* ignore */ }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("insights_open_session rejects session ids that are not shaped like sess_<id>", async () => {
  const { activate } = requirePlugin("../plugins/zcode-token-usage-statusbar/extension-main.cjs");
  const opened = [];
  const registeredViews = {};
  const ctx = {
    extension: { id: "zcode-token-usage-statusbar", version: "t", path: path.resolve("plugins/zcode-token-usage-statusbar"), dataPath: fs.mkdtempSync(path.join(os.tmpdir(), "zusage-ext-sid-")) },
    log: { info() {}, warn() {}, error() {} },
    slots: { update() {} },
    views: { register(id, def) { registeredViews[id] = def; return { dispose() {} }; }, async open() {} },
    sessions: { async openSession(arg) { opened.push(arg); } },
    commands: { register() { return { dispose() {} }; } },
    env: { async get() { return { locale: "zh-CN" }; }, onDidChange() { return { dispose() {} }; } },
    workbench: { async visibleSessions() { return []; }, onDidChange() { return { dispose() {} }; } },
    context: { async get() { return null; }, onDidChange() { return { dispose() {} }; } },
  };
  const handle = await activate(ctx);
  try {
    const run = (sessionId) => registeredViews.insights.tools.insights_open_session.run({ sessionId });
    assert.deepEqual(await run("../etc/passwd"), { ok: false, error: "invalid sessionId" });
    assert.deepEqual(await run("sess_../x"), { ok: false, error: "invalid sessionId" });
    assert.deepEqual(await run("msg_abc"), { ok: false, error: "invalid sessionId" });
    assert.deepEqual(await run("sess_" + "a".repeat(121)), { ok: false, error: "invalid sessionId" });
    assert.deepEqual(opened, [], "形状不对的没有交给宿主");
    assert.deepEqual(await run("sess_5f40506b-dfd2-4834-b948-844a9066f4e0"), { ok: true });
    assert.equal(opened.length, 1);
  } finally { handle.dispose(); fs.rmSync(ctx.extension.dataPath, { recursive: true, force: true }); }
});

test("zusage CLI: interpreter candidates follow the main bridge (configured python_path first, then the hooks chain)", () => {
  const { pythonCandidates, readJsonSafe } = requirePlugin("../plugins/zcode-token-usage-statusbar/extension-main.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-ext-py-"));
  try {
    // 没有配置：hooks 的回退链（Windows 没有 python3 别名，所以 python 在前）
    assert.deepEqual(pythonCandidates(dir, "win32"), [["python"], ["python3"], ["py", "-3"]]);
    assert.deepEqual(pythonCandidates(dir, "darwin"), [["python3"], ["python"], ["py", "-3"]]);
    // 配置里的 python_path 优先：安装与每次 SessionStart 都把 sys.executable 写回它
    const configured = path.join(dir, "Python312", "python.exe");
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ python_path: "  " + configured + "  " }));
    assert.equal(pythonCandidates(dir, "darwin")[0][0], configured);
    assert.equal(pythonCandidates(dir, "darwin").length, 4);
    // 与链里的候选同名时不重复列；带 BOM 的 config.json 也要读得出（主桥读宿主 config.json 同款处理）
    fs.writeFileSync(path.join(dir, "config.json"), "\uFEFF" + JSON.stringify({ python_path: "python" }));
    assert.deepEqual(readJsonSafe(path.join(dir, "config.json")), { python_path: "python" });
    assert.deepEqual(pythonCandidates(dir, "darwin"), [["python"], ["python3"], ["py", "-3"]]);
    // 配置损坏：退回回退链，不抛
    fs.writeFileSync(path.join(dir, "config.json"), "{broken");
    assert.deepEqual(pythonCandidates(dir, "win32"), [["python"], ["python3"], ["py", "-3"]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("zusage CLI: an unusable interpreter yields to the next candidate; a script failure does not", async () => {
  const { runZusageCli, interpreterUnusable } = requirePlugin("../plugins/zcode-token-usage-statusbar/extension-main.cjs");
  // 错误对象照 execFile 的真实形状写（见下面的真进程用例）：拉不起来 code 是字符串，非零退出 code 是数值的退出码
  for (const err of [{ code: "ENOENT" }, { code: "EINVAL" }, { code: "EACCES" }, { code: "ENOTDIR" }, { code: 9009 }]) {
    assert.equal(interpreterUnusable(err), true, "不可用：" + JSON.stringify(err));
  }
  assert.equal(interpreterUnusable({ status: 9009 }), false, "退出码不在 status 上：这种形状不是 execFile 会给的");
  for (const err of [null, { status: 1 }, { code: 1, message: "boom" }, { status: 2 }]) {
    assert.equal(interpreterUnusable(err), false, "脚本自身失败：" + JSON.stringify(err));
  }
  const calls = [];
  // python、python3 不在 PATH；py 能启动但……；第 4 个候选（配置里的解释器）才真正跑起来
  const replies = [{ err: { code: "ENOENT" } }, { err: { code: "ENOENT" } }, { err: { code: 9009, message: "Python was not found; run without arguments to install from the Microsoft Store" } },
                   { stdout: JSON.stringify({ ok: true, n: 1 }) }];
  const execFile = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    const r = replies.shift();
    setImmediate(() => cb(r.err || null, r.stdout || ""));
  };
  const candidates = [["python"], ["python3"], ["py", "-3"], [path.join(dirOf("opt"), "venv", "bin", "python3")]];
  const out = await runZusageCli(path.join(dirOf("plugin"), "dir"), ["insights", "7"], { execFile, candidates });
  assert.deepEqual(out, { ok: true, n: 1 });
  assert.deepEqual(calls.map((c) => c.file), ["python", "python3", "py", candidates[3][0]]);
  assert.deepEqual(calls[2].args, ["-3", "-B", "-X", "utf8", path.join(dirOf("plugin"), "dir", "zusage.py"), "insights", "7"],
    "-3 在脚本之前；-X utf8 让 stderr 也按 UTF-8 写（zusage.py 只钉了 stdout）");
  assert.equal(calls[0].opts.windowsHide, true, "不闪控制台窗口");
  const failing = (_file, _args, _opts, cb) => setImmediate(() => cb({ status: 1, message: "Traceback" }, ""));
  assert.deepEqual(await runZusageCli(path.join(dirOf("plugin"), "dir"), ["session-stats", "s"], { execFile: failing, candidates }),
    { ok: false, error: "Traceback" }, "脚本自己失败：如实报错，不换解释器重跑");
  const missing = (_file, _args, _opts, cb) => setImmediate(() => cb({ code: "ENOENT" }, ""));
  const gone = await runZusageCli(path.join(dirOf("plugin"), "dir"), [], { execFile: missing,
    candidates: [["python"], ["python3"]] });
  assert.deepEqual(gone, { ok: false, error: "python not found (python: ENOENT; python3: ENOENT)" }, "全部不可用时带上各候选的原因");
  function dirOf(name) { return process.platform === "win32" ? path.parse(process.cwd()).root + name : "/" + name; }
});

test("atomic JSON write retries a transiently locked target and never leaves a .tmp behind", () => {
  const { renameWithRetry } = requirePlugin("../plugins/zcode-token-usage-statusbar/extension-main.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-ext-rename-"));
  const realRename = fs.renameSync;
  const refusal = (code) => () => { const e = new Error(code + ": operation not permitted"); e.code = code; throw e; };
  try {
    const target = path.join(dir, "ext-open-request.json");
    fs.writeFileSync(target, "old");
    let left = 2;
    fs.renameSync = (a, b) => { if (left > 0) { left -= 1; refusal("EPERM")(); } return realRename(a, b); };
    const tmp = path.join(dir, ".ext-open-request.tmp.1");
    fs.writeFileSync(tmp, "new");
    renameWithRetry(tmp, target);
    assert.equal(fs.readFileSync(target, "utf8"), "new");
    assert.deepEqual(fs.readdirSync(dir), ["ext-open-request.json"], "瞬时被拒后重试成功，临时文件不残留");

    fs.renameSync = refusal("EPERM");
    fs.writeFileSync(path.join(dir, ".stuck.tmp"), "x");
    assert.throws(() => renameWithRetry(path.join(dir, ".stuck.tmp"), target), /EPERM/);
    assert.deepEqual(fs.readdirSync(dir), ["ext-open-request.json"], "始终被拒：抛出并清掉临时文件");

    fs.renameSync = refusal("ENOENT");
    fs.writeFileSync(path.join(dir, ".other.tmp"), "x");
    assert.throws(() => renameWithRetry(path.join(dir, ".other.tmp"), target), /ENOENT/);
    assert.deepEqual(fs.readdirSync(dir), ["ext-open-request.json"], "非瞬时错误不重试，临时文件同样清掉");
  } finally { fs.renameSync = realRename; fs.rmSync(dir, { recursive: true, force: true }); }
});

test("zusage CLI (real spawn, Windows): a candidate that exits 9009 yields to the next one", { skip: process.platform !== "win32" }, async () => {
  // 替身用例里的错误形状是人写的，这里用真进程锁死：execFile 把非零退出的退出码放在 err.code（数值）上，
  // 没有 status 字段——按 err.status 判 9009 的实现在替身用例里绿、在真机上不成立
  const { runZusageCli } = requirePlugin("../plugins/zcode-token-usage-statusbar/extension-main.cjs");
  const plugin = path.resolve("plugins/zcode-token-usage-statusbar");
  const reply = path.join(RUNTIME_TMP, "reply.json");
  fs.writeFileSync(reply, '{"ok":true}');
  try {
    const out = await runZusageCli(plugin, ["insights", "7"], { candidates: [
      ["cmd.exe", "/c", "exit", "9009"],   // 应用商店占位别名的行为：能启动、退出码 9009
      ["cmd.exe", "/c", "type", reply, "&", "rem"],   // 下一个候选：回一行合法 JSON，rem 吃掉后面的脚本参数
    ] });
    assert.deepEqual(out, { ok: true }, "9009 让位给下一个候选");
    const gone = await runZusageCli(plugin, [], { candidates: [["cmd.exe", "/c", "exit", "9009"]] });
    assert.deepEqual(gone, { ok: false, error: "python not found (cmd.exe: exit 9009)" });
  } finally { fs.rmSync(reply, { force: true }); }
});

function minimalCtx(opened) {
  return {
    extension: { id: "zcode-token-usage-statusbar", version: "t", path: path.resolve("plugins/zcode-token-usage-statusbar"),
      dataPath: fs.mkdtempSync(path.join(os.tmpdir(), "zusage-ext-poll-")) },
    log: { info() {}, warn() {}, error() {} },
    slots: { update() {} },
    views: { register() { return { dispose() {} }; },
      async open(id, scope) { opened.push(scope === undefined ? id : { id, sessionId: scope.sessionId }); } },
    commands: { register() { return { dispose() {} }; } },
    env: { async get() { return { locale: "zh-CN" }; }, onDidChange() { return { dispose() {} }; } },
    workbench: { async visibleSessions() { return []; }, onDidChange() { return { dispose() {} }; } },
    context: { async get() { return null; }, onDidChange() { return { dispose() {} }; } },
  };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("open-request bridge: a request file that predates activation is not replayed; later requests are picked up and gated by the sessionId shape; dispose stops the poll", async () => {
  const { activate, runtimeDir } = requirePlugin("../plugins/zcode-token-usage-statusbar/extension-main.cjs");
  assert.equal(runtimeDir, RUNTIME_TMP, "测试经 ZUSAGE_PLUGIN_RUNTIME 指向临时运行目录，不碰个人运行目录");
  const reqPath = path.join(runtimeDir, "ext-open-request.json");
  const opened = [];
  const intervals = [];
  const realSetInterval = global.setInterval, realClearInterval = global.clearInterval;
  global.setInterval = (fn, ms) => { const id = { fn, ms, cleared: false }; intervals.push(id); return id; };
  global.clearInterval = (id) => { if (id && typeof id === "object") id.cleared = true; };
  let handle = null;
  try {
    fs.writeFileSync(reqPath, JSON.stringify({ id: "before-activate", viewId: "insights", ts: Date.now() }));
    handle = await activate(minimalCtx(opened));
    await sleep(250);   // 激活即取一次种子（异步 stat）
    // macOS 的 fs.watch 会把建监听之前刚落盘的写入补发给新 watcher：上面这 250ms 里 watcher 路径
    // 已经排定并处理过一次，靠的是激活时按 id 种下的去重，而不是轮询的 mtime 种子
    assert.deepEqual(opened, [], "激活前已在的请求文件不当成新请求，不重放");
    const poll = intervals.find((i) => i.ms === 3000);
    assert.ok(poll, "登记了 3 秒轮询");
    // 平台无关的锁：直接触碰请求文件（id 与内容不变、mtime 前移），让 watcher 与轮询两条路径都
    // 再次排定处理——已种下的 id 必须被去重（Windows / Linux 的 fs.watch 不补发既有文件，
    // 只靠上面那次自然事件在这两个平台上锁不住这层保护）
    const touched = new Date(Date.now() + 4000);
    fs.utimesSync(reqPath, touched, touched);
    poll.fn();
    await sleep(150);
    assert.deepEqual(opened, [], "激活前已在的请求文件经 watcher / 轮询再次被看到也不重放（按 id 去重）");
    const bump = (body) => {
      fs.writeFileSync(reqPath, JSON.stringify({ ts: Date.now(), ...body }));
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(reqPath, later, later);   // 文件系统时钟粒度粗时两次写入可能同 mtime：显式拨后
    };
    bump({ id: "after-1", viewId: "context", sessionId: "../x" });
    poll.fn();
    await sleep(150);
    assert.deepEqual(opened, ["context"], "形状不对的 sessionId 不带会话打开");
    // 前缀对、形状不对（sess_../x）：只认前缀的旧写法会把它当会话 id 带上，必须按同一道正则门拒掉
    bump({ id: "after-1b", viewId: "context", sessionId: "sess_../x" });
    poll.fn();
    await sleep(150);
    assert.deepEqual(opened, ["context", "context"], "形状不对的 sessionId 不带会话打开（不止看前缀）");
    bump({ id: "after-2", viewId: "context", sessionId: "sess_5f40506b-dfd2-4834-b948-844a9066f4e0" });
    poll.fn();
    await sleep(150);
    assert.deepEqual(opened, ["context", "context", { id: "context", sessionId: "sess_5f40506b-dfd2-4834-b948-844a9066f4e0" }]);
    handle.dispose();
    assert.equal(poll.cleared, true, "dispose 清掉轮询");
  } finally {
    if (handle) handle.dispose();
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
    try { fs.rmSync(reqPath, { force: true }); } catch { /* ignore */ }
  }
});

test("open-request bridge: a watcher that reports an error is closed and rebuilt by the next poll, and the poll delivers on its own", async () => {
  const { activate } = requirePlugin("../plugins/zcode-token-usage-statusbar/extension-main.cjs");
  fs.rmSync(path.join(RUNTIME_TMP, "ext-open-request.json"), { force: true });   // 上一条用例收尾已删，这里不依赖它
  const opened = [];
  const intervals = [];
  const realSetInterval = global.setInterval, realClearInterval = global.clearInterval, realWatch = fs.watch;
  global.setInterval = (fn, ms) => { const id = { fn, ms, cleared: false }; intervals.push(id); return id; };
  global.clearInterval = (id) => { if (id && typeof id === "object") id.cleared = true; };
  const watchers = [];
  fs.watch = (dir, cb) => {
    const w = new EventEmitter();
    w.closed = 0;
    w.close = () => { w.closed++; };
    watchers.push(w);
    return w;
  };
  let handle = null;
  try {
    handle = await activate(minimalCtx(opened));
    const poll = intervals.find((i) => i.ms === 3000);
    assert.ok(poll, "登记了 3 秒轮询");
    assert.equal(watchers.length, 1, "激活时建一个 watcher");
    // fs.watch 报 error 后不再派发事件：必须关掉并置空，留给轮询重建——否则唤起链到进程重启前只剩轮询
    watchers[0].emit("error", new Error("EPERM"));
    assert.equal(watchers[0].closed, 1, "报 error 的 watcher 被关掉");
    poll.fn();
    await sleep(150);
    assert.equal(watchers.length, 2, "下一次轮询重建了 watcher");
    assert.equal(watchers[1].closed, 0);
    // 轮询兜底要能独立送达：这里的 watcher 是不会派发事件的替身，新请求只靠轮询被看到
    // （真实监听在场的用例里，把轮询换成空操作照样能靠 fs.watch 过，锁不住这条路）
    const reqPath = path.join(RUNTIME_TMP, "ext-open-request.json");
    fs.writeFileSync(reqPath, JSON.stringify({ id: "after-rebuild", viewId: "context", sessionId: "sess_5f40506b-dfd2-4834-b948-844a9066f4e0", ts: Date.now() }));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(reqPath, later, later);
    poll.fn();
    await sleep(150);
    assert.deepEqual(opened, [{ id: "context", sessionId: "sess_5f40506b-dfd2-4834-b948-844a9066f4e0" }], "watcher 不派发事件时，新请求经轮询送达");
    handle.dispose();
    assert.equal(watchers[1].closed, 1, "dispose 关掉在场的 watcher");
  } finally {
    if (handle) handle.dispose();
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
    fs.watch = realWatch;
    try { fs.rmSync(path.join(RUNTIME_TMP, "ext-open-request.json"), { force: true }); } catch { /* ignore */ }
  }
});
