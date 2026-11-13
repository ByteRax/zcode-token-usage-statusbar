"use strict";
// v179 自动压缩阈值引擎补丁回归：打补丁/幂等/各 fail-closed 分支/restore 往返/
// 阈值配置白名单、以及 prologue hook 的全部取值语义（vm 沙箱 + 临时 HOME）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const ep = require("../engine-patch.cjs");
const { createEnginePatcher, ENGINE_TARGETS, PROLOGUE, PROLOGUE_V1, PROLOGUE_PREFIX, ANCHOR, REPLACEMENT, MARK, insertPrologue, resolveEnginePath, buildPatchedSource } = ep;

function sha256hex(buf) { return require("crypto").createHash("sha256").update(buf).digest("hex"); }

/* 出厂登记表快照：registerTarget 会往共享数组追加夹具条目，须在任何用例之前拍下 */
const FACTORY_TARGETS = ENGINE_TARGETS.map((t) => ({ build: t.build, engineSha256: t.engineSha256, anchor: t.anchor, replacement: t.replacement }));

/* 各版本引擎的判定符号随构建轮换，逐条钉死：新登记版本滚动 ANCHOR/REPLACEMENT 时，旧条目
 * 若仍引用常量会静默继承新锚点（已打补丁用户 patched_inconsistent、restore 永久失败）。
 * 登记新版本时在此追加一行。 */
test("出厂登记表逐版本锁定判定符号：滚动 ANCHOR/REPLACEMENT 不得改写旧条目", () => {
  const symbols = {
    "3.18.2": ["iTe", "PWo", "08726b5ef69e1e9072828baa4656713cb3aac93bb096938681278c5600312b2c"],
    "3.18.1": ["oTe", "vWo", "666f9c5a0a566eb8cbb906625e219aa2657e9f6a0e0ea8a73471fabdc54110b6"],
    "3.18.0": ["nTe", "K9o", "26785f28ab8fb9f8b0f3821f2bf71d294f4d0b8bf28108785292f86c7e14090d"],
    "3.17.2": ["cke", "jBo", "d9afd58d694f98a5279bf548cdc7646413c125762e86730605a6071f9e0346d6"],
    "3.17.1": ["ake", "DBo", "9afd565a104d660259e6bdeeaa5cb8abc74a908559e21aa3c5f6a06f2a9da6c6"],
  };
  assert.deepEqual(FACTORY_TARGETS.map((t) => t.build), Object.keys(symbols), "登记版本集合与顺序（新版本在表首）");
  for (const t of FACTORY_TARGETS) {
    const [fn, dflt, sha] = symbols[t.build];
    assert.equal(t.engineSha256, sha, t.build + " engine sha256");
    assert.equal(t.anchor, "n=" + fn + "(e.bufferTokens)??" + dflt + ";return Math.max(0,t-n)", t.build + " anchor");
    assert.equal(t.replacement, "n=" + fn + "(e.bufferTokens)??" + dflt +
      ";return (globalThis." + MARK + "&&globalThis." + MARK + "(t,n))??Math.max(0,t-n)", t.build + " replacement");
  }
  assert.equal(new Set(FACTORY_TARGETS.map((t) => t.anchor)).size, FACTORY_TARGETS.length, "各版本锚点互不相同");
  assert.equal(FACTORY_TARGETS[0].anchor, ANCHOR, "ANCHOR 常量只对应表首（最新登记）条目");
  assert.equal(FACTORY_TARGETS[0].replacement, REPLACEMENT);
});

function makeFixture(opts = {}) {
  const anchor = opts.anchor || ANCHOR;
  return Buffer.from(
    '#!/usr/bin/env node\n"use strict";var wXi=1;\n' +
    "function q(e){let t=X(e)," + anchor + "}\n");
}

function setup(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ztus-engine-patch-"));
  const resources = path.join(root, "resources");
  const layout = opts.layout || "flat";
  const engineDir = layout === "flat" ? path.join(resources, "glm")
    : path.join(resources, "glm", process.platform + "-" + process.arch);
  fs.mkdirSync(engineDir, { recursive: true });
  const runtime = path.join(root, "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  const enginePath = path.join(engineDir, "zcode.cjs");
  const original = opts.fixture || makeFixture();
  fs.writeFileSync(enginePath, original, { mode: 0o755 });
  let enabled = opts.enabled !== false;
  const patcher = createEnginePatcher({
    runtime, resourcesPath: resources,
    appVersion: opts.appVersion,
    isEnabled: () => enabled,
    log: () => { },
  });
  return {
    root, resources, runtime, enginePath, original, patcher,
    setEnabled: (v) => { enabled = v; },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/* 引擎字节不在出厂登记表里：每个用例把自己的夹具 SHA 注册进去，结束统一摘除 */
const extraTargets = [];
test.after(() => {
  for (const t of extraTargets) {
    const i = ENGINE_TARGETS.indexOf(t);
    if (i >= 0) ENGINE_TARGETS.splice(i, 1);
  }
});
function registerTarget(buf, anchor, replacement) {
  const t = { build: "test", engineSha256: sha256hex(buf), anchor: anchor || ANCHOR, replacement: replacement || REPLACEMENT, prologue: PROLOGUE };
  ENGINE_TARGETS.push(t);
  extraTargets.push(t);
  return t;
}

test("ensure applies prologue+replacement, leaves backup and sentinel, idempotent on re-run", () => {
  const s = setup();
  try {
    const buf = fs.readFileSync(s.enginePath);
    registerTarget(buf);
    const r1 = s.patcher.ensure();
    assert.equal(r1, "applied");
    const patched = fs.readFileSync(s.enginePath, "utf8");
    assert.ok(patched.includes(PROLOGUE), "prologue 注入");
    assert.ok(patched.includes(REPLACEMENT), "判定点改道");
    assert.ok(patched.startsWith('#!/usr/bin/env node\n"use strict";\n'), "shebang 与严格模式指令保持在最前");
    assert.equal(s.patcher.status().state, "applied");
    assert.equal(s.patcher.status().build, "test");
    // 备份 = 未打补丁原字节
    const backups = fs.readdirSync(path.dirname(s.enginePath)).filter((f) => f.startsWith(".pre-acthreshold-"));
    assert.equal(backups.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(s.enginePath), backups[0])), s.original);
    // 哨兵记录已打补丁
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.runtime, "engine-patch.json"), "utf8")).patched, true);
    // 幂等：重复 ensure 不叠加、不新增备份
    assert.equal(s.patcher.ensure(), "applied");
    assert.equal(fs.readFileSync(s.enginePath, "utf8"), patched);
    assert.equal(fs.readdirSync(path.dirname(s.enginePath)).filter((f) => f.startsWith(".pre-acthreshold-")).length, 1);
  } finally { s.cleanup(); }
});

test("ensure refuses engines whose sha is not in ENGINE_TARGETS (fail-closed, bytes untouched)", () => {
  // 夹具必须与其它用例字节不同：登记表按 SHA 匹配，同字节夹具会互相污染
  const s = setup({ fixture: Buffer.from(makeFixture().toString("utf8") + "/* unique */\n") });
  try {
    assert.equal(s.patcher.ensure(), "unsupported_build");
    assert.deepEqual(fs.readFileSync(s.enginePath), s.original);
    assert.match(s.patcher.status().lastError, /not in ENGINE_TARGETS/);
  } finally { s.cleanup(); }
});

/* issue #191：桌面 build 仍在登记表而引擎 sha 脱钩 = 引擎文件被供应商/CLI 侧单独
 * 热更。drifted 只是给 ⚙ 面板的附注，fail-closed 判定本身不变（仍 unsupported_build）。 */
test("unsupported_build 附 drifted：桌面 build 已登记而引擎 sha 不同（引擎被单独热更）", () => {
  const s = setup({ fixture: Buffer.from(makeFixture().toString("utf8") + "/* drift-a */\n"), appVersion: "3.17.2.9661" });
  try {
    // 只登记 build 号（sha 用无关字节）：drifted 的前提是引擎 sha 不在表内
    const t = registerTarget(Buffer.from("drift-a-marker-unrelated"));
    t.build = "3.17.2";
    assert.equal(s.patcher.ensure(), "unsupported_build");
    assert.equal(s.patcher.status().drifted, "3.17.2");
    assert.match(s.patcher.status().lastError, /not in ENGINE_TARGETS/);
  } finally { s.cleanup(); }
});

test("unsupported_build 不附 drifted：桌面 build 本身不在登记表（全新版本）", () => {
  // appVersion 用永不可能被登记的哨兵号：写成「下一个版本号」会在登记该版本时撞车
  const s = setup({ fixture: Buffer.from(makeFixture().toString("utf8") + "/* drift-b */\n"), appVersion: "0.0.0.1" });
  try {
    const t = registerTarget(Buffer.from("drift-b-marker-unrelated"));
    t.build = "3.17.2";
    assert.equal(s.patcher.ensure(), "unsupported_build");
    assert.equal(s.patcher.status().drifted, null);
  } finally { s.cleanup(); }
});

test("build 前缀匹配按点分界：3.17.20 不误配 3.17.2", () => {
  const s = setup({ fixture: Buffer.from(makeFixture().toString("utf8") + "/* drift-c */\n"), appVersion: "3.17.20.1" });
  try {
    const t = registerTarget(Buffer.from("drift-c-marker-unrelated"));
    t.build = "3.17.2";
    assert.equal(s.patcher.ensure(), "unsupported_build");
    assert.equal(s.patcher.status().drifted, null);
  } finally { s.cleanup(); }
});

test("drifted 不跨调用残留：状态离开 unsupported_build 即清空", () => {
  const s = setup({ fixture: Buffer.from(makeFixture().toString("utf8") + "/* drift-d */\n"), appVersion: "3.17.2.9661" });
  try {
    const driftBuild = registerTarget(Buffer.from("drift-marker-unrelated-bytes"));
    driftBuild.build = "3.17.2";
    assert.equal(s.patcher.ensure(), "unsupported_build");
    assert.equal(s.patcher.status().drifted, "3.17.2");
    registerTarget(fs.readFileSync(s.enginePath));   // 引擎字节登记后可正常打补丁
    assert.equal(s.patcher.ensure(), "applied");
    assert.equal(s.patcher.status().drifted, null);
  } finally { s.cleanup(); }
});

test("ensure reports engine_missing when no layout matches", () => {
  const s = setup({ layout: "triple" });
  try {
    // triple 布局存在文件但 resources 指向别处 → missing
    const missing = createEnginePatcher({ runtime: s.runtime, resourcesPath: path.join(s.root, "elsewhere"), isEnabled: () => true, log: () => { } });
    assert.equal(missing.ensure(), "engine_missing");
  } finally { s.cleanup(); }
});

test("resolveEnginePath supports flat and platform-triple layouts", () => {
  const flat = setup({ layout: "flat" });
  try {
    assert.equal(resolveEnginePath(flat.resources), flat.enginePath);
  } finally { flat.cleanup(); }
  const triple = setup({ layout: "triple" });
  try {
    assert.equal(resolveEnginePath(triple.resources), triple.enginePath);
  } finally { triple.cleanup(); }
});

test("ensure refuses when anchor count != 1", () => {
  const buf = makeFixture({ anchor: "n=ake(e.bufferTokens)??DBo;return Math.max(0,t-n);var x=1;" }) ;
  const dup = Buffer.from('#!/usr/bin/env node\n"use strict";\n' + ANCHOR + "\nfunction q(e){let t=X(e)," + ANCHOR + "}\n");
  registerTarget(dup);
  const s = setup({ fixture: dup });
  try {
    assert.equal(s.patcher.ensure(), "error");
    assert.equal(s.patcher.status().lastError, "anchor_count_2");
    assert.deepEqual(fs.readFileSync(s.enginePath), dup);
  } finally { s.cleanup(); }
});

test("ensure refuses bundles without leading strict directive", () => {
  const noStrict = Buffer.from('#!/usr/bin/env node\nvar wXi=1;\nfunction q(e){let t=X(e),' + ANCHOR + "}\n");
  registerTarget(noStrict);
  const s = setup({ fixture: noStrict });
  try {
    assert.equal(s.patcher.ensure(), "error");
    assert.equal(s.patcher.status().lastError, "strict_prefix_missing");
    assert.deepEqual(fs.readFileSync(s.enginePath), noStrict);
  } finally { s.cleanup(); }
});

test("ensure migrates an engine patched with the legacy prologue in place (v194 formula swap)", () => {
  const s = setup();
  try {
    registerTarget(s.original);
    /* v193 及以前的装机形态：旧版 prologue + 同一替换体 */
    const legacy = buildPatchedSource(s.original.toString("utf8"), { anchor: ANCHOR, replacement: REPLACEMENT, prologue: PROLOGUE_V1 });
    assert.ok(legacy && !legacy.error);
    fs.writeFileSync(s.enginePath, legacy.output);
    assert.equal(s.patcher.ensure(), "applied");
    const after = fs.readFileSync(s.enginePath, "utf8");
    assert.ok(after.includes(PROLOGUE), "hook 本体已换装新版");
    assert.ok(!after.includes(PROLOGUE_V1), "旧本体不残留");
    assert.ok(after.includes(REPLACEMENT), "锚点替换体保持不变");
    assert.equal(s.patcher.ensure(), "applied", "迁移后幂等");
  } finally { s.cleanup(); }
});

test("restore handles an engine patched with the legacy prologue", () => {
  const s = setup();
  try {
    registerTarget(s.original);
    const legacy = buildPatchedSource(s.original.toString("utf8"), { anchor: ANCHOR, replacement: REPLACEMENT, prologue: PROLOGUE_V1 });
    fs.writeFileSync(s.enginePath, legacy.output);
    assert.equal(s.patcher.restore(), "off");
    assert.deepEqual(fs.readFileSync(s.enginePath), s.original, "旧本体装机也能还原到原版字节");
  } finally { s.cleanup(); }
});

test("restore round-trips to the exact original bytes and clears the sentinel", () => {
  const s = setup();
  try {
    registerTarget(s.original);
    s.patcher.ensure();
    assert.equal(s.patcher.restore(), "off");
    assert.deepEqual(fs.readFileSync(s.enginePath), s.original);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.runtime, "engine-patch.json"), "utf8")).patched, false);
    // 再次 restore = 引擎已干净，no-op
    assert.equal(s.patcher.restore(), "off");
  } finally { s.cleanup(); }
});

test("restore fails closed when the patched region was tampered with", () => {
  const s = setup();
  try {
    registerTarget(s.original);
    s.patcher.ensure();
    // 破坏替换体（模拟外来半截补丁/版本演化残留）
    const tampered = fs.readFileSync(s.enginePath, "utf8").replace(REPLACEMENT, "n=ake(e.bufferTokens)??DBo;return 42");
    fs.writeFileSync(s.enginePath, tampered);
    assert.equal(s.patcher.restore(), "error");
    assert.equal(s.patcher.status().lastError, "restore_pattern_missing");
    // 失败不写盘： tampered 字节保持
    assert.ok(fs.readFileSync(s.enginePath, "utf8").includes("return 42"));
  } finally { s.cleanup(); }
});

test("syncStartup: disabled + unpatched sentinel does not touch the engine", () => {
  const s = setup({ enabled: false });
  try {
    registerTarget(s.original);
    assert.equal(s.patcher.syncStartup(), "off");
    assert.deepEqual(fs.readFileSync(s.enginePath), s.original);
    assert.equal(s.patcher.status().state, "off");
    assert.equal(s.patcher.status().enabled, false);
  } finally { s.cleanup(); }
});

test("syncStartup: disabled + patched sentinel restores on next launch", () => {
  const s = setup();
  try {
    registerTarget(s.original);
    s.patcher.ensure();
    s.setEnabled(false);
    assert.equal(s.patcher.syncStartup(), "off");
    assert.deepEqual(fs.readFileSync(s.enginePath), s.original);
  } finally { s.cleanup(); }
});

test("writeConfig normalizes modes, rejects invalid input, and writes atomically", () => {
  const s = setup();
  try {
    assert.equal(s.patcher.status().config, null, "未写配置时 status 回传 null");
    assert.deepEqual(s.patcher.writeConfig("default"), { enabled: true });
    assert.deepEqual(s.patcher.writeConfig("disabled"), { enabled: false });
    assert.deepEqual(s.patcher.writeConfig("percent", 70.4), { enabled: true, thresholdPercent: 70 });
    assert.deepEqual(s.patcher.writeConfig("percent", 30), { enabled: true, thresholdPercent: 30 });
    assert.deepEqual(s.patcher.writeConfig("percent", 99), { enabled: true, thresholdPercent: 99 });
    assert.deepEqual(s.patcher.writeConfig("tokens", 120000), { enabled: true, thresholdTokens: 120000 });
    assert.deepEqual(s.patcher.writeConfig("buffer", 5000), { enabled: true, bufferTokens: 5000 });
    for (const [mode, value] of [["percent", 29], ["percent", 120], ["tokens", 999], ["buffer", -1], ["evil", 1]]) {   // v194：百分比下限 30
      assert.throws(() => s.patcher.writeConfig(mode, value), undefined, mode + " " + value + " 应拒绝");
    }
    assert.deepEqual(s.patcher.readConfig(), { enabled: true, bufferTokens: 5000 });
    assert.deepEqual(s.patcher.status().config, { enabled: true, bufferTokens: 5000 }, "status 回传当前配置（⚙ 面板反推依据）");
    // 原子写不留 tmp
    assert.ok(fs.readdirSync(s.runtime).every((f) => !f.includes(".zusage-tmp")));
  } finally { s.cleanup(); }
});

test("insertPrologue keeps the directive prologue first", () => {
  const out = insertPrologue('#!/usr/bin/env node\n"use strict";var a=1;', PROLOGUE);
  assert.ok(out.startsWith('#!/usr/bin/env node\n"use strict";\n' + PROLOGUE_PREFIX));
  assert.ok(out.indexOf('"use strict";') < out.indexOf(PROLOGUE_PREFIX));
  assert.equal(insertPrologue("var a=1;", PROLOGUE), null);
});

/* ---- prologue hook 取值语义（vm 沙箱 + 临时 HOME）---- */
function runHook(home) {
  const sandbox = { require: (name) => (name === "os" ? { homedir: () => home } : require(name)) };
  return vm.runInNewContext(PROLOGUE + "\nglobalThis." + MARK, sandbox, { filename: "prologue-test.js" });
}
function hookEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ztus-hook-home-"));
  const cfgDir = path.join(root, ".zcode", "zcode-token-usage-statusbar");
  fs.mkdirSync(cfgDir, { recursive: true });
  const file = path.join(cfgDir, "autocompact.json");
  let tick = 0;
  const write = (obj) => {
    fs.writeFileSync(file, obj === null ? "{broken" : JSON.stringify(obj));
    fs.utimesSync(file, new Date(Date.now() / 1000 + tick), new Date(Date.now() / 1000 + tick));   // 强制 mtime 前进穿缓存
    tick += 1;
  };
  return { root, file, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("hook: missing/corrupt/no-override config falls back to engine default", () => {
  const env = hookEnv();
  try {
    const hook = runHook(env.root);
    const EFF = 179000;
    assert.equal(hook(EFF), undefined, "文件缺失 → 引擎默认");
    env.write(null);
    assert.equal(hook(EFF), undefined, "损坏 JSON → 引擎默认");
    env.write({ enabled: true });
    assert.equal(hook(EFF), undefined, "无覆盖键 → 引擎默认");
    env.write([]);
    assert.equal(hook(EFF), undefined, "数组配置 → 引擎默认");
  } finally { env.cleanup(); }
});

test("hook: percent semantics with clamps (30..99) on the nominal-window base (v194)", () => {
  const env = hookEnv();
  try {
    const hook = runHook(env.root);
    const EFF = 179000;   // 200,000 标称 − 21,000 预留
    env.write({ thresholdPercent: 70 });
    assert.equal(hook(EFF), 140000, "70% × 标称窗口 200,000（WYSIWYG：原生按钮 70% 处触发）");
    env.write({ thresholdPercent: 5 });
    assert.equal(hook(EFF), 60000, "下限钳到 30%（× 标称）");
    env.write({ thresholdPercent: 120 });
    assert.equal(hook(EFF), EFF, "99% × 标称 = 198,000 超有效窗口 → 钳在 eff");
    env.write({ thresholdPercent: 85 });
    assert.equal(hook(EFF), 170000, "85% × 标称 = 170,000 < eff，不触钳");
  } finally { env.cleanup(); }
});

test("hook: tokens/buffer semantics and the 1% floor against compact loops", () => {
  const env = hookEnv();
  try {
    const hook = runHook(env.root);
    const EFF = 179000;
    env.write({ thresholdTokens: 500 });
    assert.equal(hook(EFF), Math.floor(EFF * 0.01), "低于 tokens 下限且触发 1% 地板（防每轮压缩→rapid-refill 熔断）");
    env.write({ thresholdTokens: 100000 });
    assert.equal(hook(EFF), 100000, "正常 token 阈值原样生效");
    env.write({ thresholdTokens: 999999 });
    assert.equal(hook(EFF), EFF, "tokens 超 effective 钳到 effective");
    env.write({ bufferTokens: 1e9 });
    assert.equal(hook(EFF), Math.floor(EFF * 0.01), "超大 buffer 地板 1%：防每轮压缩→rapid-refill 熔断");
    env.write({ bufferTokens: 5000 });
    assert.equal(hook(EFF), EFF - 5000, "buffer 语义 = effective − buffer");
  } finally { env.cleanup(); }
});

test("hook: enabled:false parks the threshold at MAX_SAFE_INTEGER (reactive fallback intact)", () => {
  const env = hookEnv();
  try {
    const hook = runHook(env.root);
    env.write({ enabled: false });
    assert.equal(hook(179000), Number.MAX_SAFE_INTEGER);
  } finally { env.cleanup(); }
});

test("hook: mtime cache picks up rewrites without restart", () => {
  const env = hookEnv();
  try {
    const hook = runHook(env.root);
    const EFF = 179000;
    env.write({ thresholdPercent: 60 });
    assert.equal(hook(EFF), 120000);
    env.write({ thresholdPercent: 85 });
    assert.equal(hook(EFF), 170000, "改 JSON 下轮决策生效");
  } finally { env.cleanup(); }
});
