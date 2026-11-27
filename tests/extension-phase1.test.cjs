"use strict";
// 用 CommonJS 写这个测试文件：全量脚本 scripts/check_all.py 只收 tests/*.test.cjs，.mjs 测试不会被执行。
// 入口是 CommonJS（顶层 extension-main.cjs，见 specs/context-insights-extension.md §5）：经 createRequire 加载。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const requirePlugin = createRequire(__filename);
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

test("revealOrOpenFolder: a symlink inside the allowed root that resolves outside is refused", { skip: process.platform === "win32" }, async () => {
  const { revealOrOpenFolder } = requirePlugin("../plugins/zcode-token-usage-statusbar/extension-main.cjs");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-ext-symlink-"));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  const real = path.join(base, "root", "real");
  fs.mkdirSync(root); fs.mkdirSync(outside); fs.mkdirSync(real);
  try {
    fs.symlinkSync(outside, path.join(root, "escape"));
    const opened = [];
    const execFn = (cmd, args, opts, cb) => { opened.push(args[0]); cb(null); };
    const opts = { allowedRoots: [root], platform: "darwin", execFn, homeDir: base };
    assert.deepEqual(await revealOrOpenFolder(path.join(root, "escape"), opts), { ok: false, error: "forbidden-path" });
    assert.deepEqual(opened, [], "没有调用任何打开命令");
    assert.equal((await revealOrOpenFolder(real, opts)).ok, true, "对照：根内的真实目录照常打开");
    assert.equal(opened.length, 1);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
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
