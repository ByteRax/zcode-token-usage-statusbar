"use strict";
// v179 自动压缩阈值引擎补丁回归：打补丁/幂等/各 fail-closed 分支/restore 往返/
// 阈值配置白名单、以及 prologue hook 的全部取值语义（vm 沙箱 + 临时 HOME）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const http = require("node:http");
const cp = require("node:child_process");

const ep = require("../engine-patch.cjs");
const { createEnginePatcher, ENGINE_TARGETS, PROLOGUE, PROLOGUE_V1, PROLOGUE_V2, PROLOGUE_PREFIX, ANCHOR, REPLACEMENT, MARK, insertPrologue, resolveEnginePath, buildPatchedSource } = ep;

function sha256hex(buf) { return require("crypto").createHash("sha256").update(buf).digest("hex"); }

/* 出厂登记表快照：registerTarget 会往共享数组追加夹具条目，须在任何用例之前拍下 */
const FACTORY_TARGETS = ENGINE_TARGETS.map((t) => ({ build: t.build, engineSha256: t.engineSha256, anchor: t.anchor, replacement: t.replacement }));

/* 各版本引擎的判定符号随构建轮换，逐条钉死：新登记版本滚动 ANCHOR/REPLACEMENT 时，旧条目
 * 若仍引用常量会静默继承新锚点（已打补丁用户 patched_inconsistent、restore 永久失败）。
 * 登记新版本时在此追加一行。 */
test("出厂登记表逐版本锁定判定符号：滚动 ANCHOR/REPLACEMENT 不得改写旧条目", () => {
  const symbols = {
    "4.0.0": ["$ue", "fZo", "0de95ddd65d7712a3beeccc8ee6de53ea0ce96338eb427e52b2717ba2f3afe19"],
    "3.19.1": ["Uue", "KKo", "4b90ae046753be9f5ba63dee14b8fd2cdb07b5540e9bfe348ba127504b8cf8da"],
    "3.19.0": ["Hue", "xZo", "6b84e928d9258fe020c6ab8c75fa2c123b0cd658fe43c0ce141a13df677fb0ea"],
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
 * 热更/重 build。判定区混淆符号未轮换（锚点串全文件唯一命中）时按登记条目兜底
 * 注入——结构验证替代指纹预检，与 renderer_bridge derive 同哲学；符号已轮换
 * （锚点不在/多处）仍 unsupported_build，drifted 只是给 ⚙ 面板的附注。 */
test("sha 脱钩但锚点唯一命中：按 build 前缀匹配的登记条目兜底注入", () => {
  // build 用 9.9.9：3.17.2 会先命中出厂条目（其锚点不在夹具里，兜底必拒绝）
  const s = setup({ fixture: Buffer.from(makeFixture().toString("utf8") + "/* drift-a */\n"), appVersion: "9.9.9.1" });
  try {
    // 只登记 build 号（sha 用无关字节）：兜底的前提是引擎 sha 不在表内
    const t = registerTarget(Buffer.from("drift-a-marker-unrelated"));
    t.build = "9.9.9";
    assert.equal(s.patcher.ensure(), "applied");
    const patched = fs.readFileSync(s.enginePath, "utf8");
    assert.ok(patched.includes(PROLOGUE), "prologue 注入");
    assert.ok(patched.includes(t.replacement), "判定点改道");
    assert.equal(s.patcher.status().state, "applied");
    assert.equal(s.patcher.status().build, "9.9.9");
    // 哨兵记录打补丁前的漂移 sha（与登记表对照即知是兜底注入）；幂等走 prologue 识别
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.runtime, "engine-patch.json"), "utf8")).build, "9.9.9");
    assert.equal(s.patcher.ensure(), "applied");
  } finally { s.cleanup(); }
});

test("sha 脱钩且锚点被轮换（不在/多处）：仍 unsupported_build 附 drifted", () => {
  const rotated = "n=ZZe(e.bufferTokens)??YYo;return Math.max(0,t-n)";
  const gone = setup({ fixture: makeFixture({ anchor: rotated }), appVersion: "9.9.9.1" });
  try {
    const t1 = registerTarget(Buffer.from("drift-gone-unrelated"));
    t1.build = "9.9.9";
    assert.equal(gone.patcher.ensure(), "unsupported_build");
    assert.equal(gone.patcher.status().drifted, "9.9.9");
    assert.match(gone.patcher.status().lastError, /not in ENGINE_TARGETS/);
  } finally { gone.cleanup(); }
  const dup = Buffer.from(
    '#!/usr/bin/env node\n"use strict";var wXi=1;\n' +
    "function q(e){let t=X(e)," + ANCHOR + "}\n" +
    "function r(e){let t=Y(e)," + ANCHOR + "}\n/* dup */\n");
  const many = setup({ fixture: dup, appVersion: "9.9.9.1" });
  try {
    const t2 = registerTarget(Buffer.from("drift-many-unrelated"));
    t2.build = "9.9.9";
    assert.equal(many.patcher.ensure(), "unsupported_build");
    assert.equal(many.patcher.status().drifted, "9.9.9");
  } finally { many.cleanup(); }
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

test("出厂条目兜底：四段 appVersion + 判定区符号未轮换 → 按出厂登记注入", () => {
  // issue #191 真实形态：引擎被单独热更但判定区混淆符号未轮换，出厂 3.17.2
  // 条目（cke/jBo）直接兜底，无需自注册条目；restore 往返字节精确。
  const cke = "n=cke(e.bufferTokens)??jBo;return Math.max(0,t-n)";
  const s = setup({ fixture: Buffer.from(makeFixture({ anchor: cke }).toString("utf8") + "/* hot-update */\n"), appVersion: "3.17.2.9661" });
  try {
    assert.equal(s.patcher.ensure(), "applied");
    const patched = fs.readFileSync(s.enginePath, "utf8");
    assert.ok(patched.includes(PROLOGUE), "prologue 注入");
    assert.ok(patched.includes("n=cke(e.bufferTokens)??jBo;return (globalThis." + MARK + "&&globalThis." + MARK + "(t,n))??Math.max(0,t-n)"), "判定点改道");
    assert.equal(s.patcher.status().build, "3.17.2");
    assert.equal(s.patcher.restore(), "off");
    assert.deepEqual(fs.readFileSync(s.enginePath), s.original);
  } finally { s.cleanup(); }
});

test("3.19.1 漂移兜底只接受自身的唯一锚点，重复应用与还原均保持字节一致", () => {
  const anchor = "n=Uue(e.bufferTokens)??KKo;return Math.max(0,t-n)";
  const original = Buffer.concat([makeFixture({ anchor }), Buffer.from("/* 3.19.1 drift */\n")]);
  const s = setup({ fixture: original, appVersion: "3.19.1.10833" });
  try {
    assert.ok(!ENGINE_TARGETS.some(t => t.engineSha256 === sha256hex(original)), "夹具只走出厂登记的漂移兜底");
    assert.equal(s.patcher.ensure(), "applied");
    assert.equal(s.patcher.status().build, "3.19.1");
    const patched = fs.readFileSync(s.enginePath);
    assert.notDeepEqual(patched, original);
    assert.equal(s.patcher.ensure(), "applied");
    assert.deepEqual(fs.readFileSync(s.enginePath), patched);
    assert.equal(s.patcher.restore(), "off");
    assert.deepEqual(fs.readFileSync(s.enginePath), original);

    const older = makeFixture({ anchor: "n=Hue(e.bufferTokens)??xZo;return Math.max(0,t-n)" });
    const duplicate = Buffer.concat([original, Buffer.from("function r(e){let t=Y(e)," + anchor + "}\n")]);
    for (const bytes of [older, duplicate]) {
      fs.writeFileSync(s.enginePath, bytes);
      assert.equal(s.patcher.ensure(), "unsupported_build");
      assert.equal(s.patcher.status().drifted, "3.19.1");
      assert.deepEqual(fs.readFileSync(s.enginePath), bytes);
    }
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
  // 中段命中（includes 变异会误配）：首段不是登记 build 即不匹配
  const mid = setup({ fixture: Buffer.from(makeFixture().toString("utf8") + "/* drift-c2 */\n"), appVersion: "13.17.2.9661" });
  try {
    const t2 = registerTarget(Buffer.from("drift-c2-marker-unrelated"));
    t2.build = "3.17.2";
    assert.equal(mid.patcher.ensure(), "unsupported_build");
    assert.equal(mid.patcher.status().drifted, null);
  } finally { mid.cleanup(); }
});

test("drifted 不跨调用残留：状态离开 unsupported_build 即清空", () => {
  // 夹具用轮换符号 + build 用 9.9.9：确保第一步兜底不命中仍走 unsupported_build
  const rotated = "n=ZZf(e.bufferTokens)??YYp;return Math.max(0,t-n)";
  const s = setup({ fixture: makeFixture({ anchor: rotated }), appVersion: "9.9.9.1" });
  try {
    const driftBuild = registerTarget(Buffer.from("drift-marker-unrelated-bytes"));
    driftBuild.build = "9.9.9";
    assert.equal(s.patcher.ensure(), "unsupported_build");
    assert.equal(s.patcher.status().drifted, "9.9.9");
    registerTarget(fs.readFileSync(s.enginePath), rotated);   // 引擎字节登记后可正常打补丁
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

test("ensure migrates a v194-era patched engine in place (v420 tokens floor swap)", () => {
  const s = setup();
  try {
    registerTarget(s.original);
    /* v194-v419 装机形态：percent 新段 + tokens 地板 1000（PROLOGUE_V2） */
    const legacy = buildPatchedSource(s.original.toString("utf8"), { anchor: ANCHOR, replacement: REPLACEMENT, prologue: PROLOGUE_V2 });
    assert.ok(legacy && !legacy.error);
    fs.writeFileSync(s.enginePath, legacy.output);
    assert.equal(s.patcher.ensure(), "applied");
    const after = fs.readFileSync(s.enginePath, "utf8");
    assert.ok(after.includes(PROLOGUE), "hook 本体已换装 100k 地板版");
    assert.ok(!after.includes(PROLOGUE_V2), "旧本体不残留");
    assert.ok(after.includes(REPLACEMENT), "锚点替换体保持不变");
    assert.equal(s.patcher.ensure(), "applied", "迁移后幂等");
  } finally { s.cleanup(); }
});

test("restore handles a v194-era patched engine", () => {
  const s = setup();
  try {
    registerTarget(s.original);
    const legacy = buildPatchedSource(s.original.toString("utf8"), { anchor: ANCHOR, replacement: REPLACEMENT, prologue: PROLOGUE_V2 });
    fs.writeFileSync(s.enginePath, legacy.output);
    assert.equal(s.patcher.restore(), "off");
    assert.deepEqual(fs.readFileSync(s.enginePath), s.original, "V2 装机也能还原到原版字节");
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
    assert.deepEqual(s.patcher.writeConfig("tokens", 100000), { enabled: true, thresholdTokens: 100000 }, "v420 下限边界");
    assert.deepEqual(s.patcher.writeConfig("buffer", 5000), { enabled: true, bufferTokens: 5000 });
    for (const [mode, value] of [["percent", 29], ["percent", 120], ["tokens", 999], ["tokens", 99999], ["buffer", -1], ["evil", 1]]) {   // v194：百分比下限 30；v420：tokens 下限 100k
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

test("v445: the replacement body is inserted verbatim — `$` sequences never act as replace patterns", () => {
  /* 压缩标识符常带 $（$$、$&、$1…）；字符串替换串会把它们当替换模式展开，补丁体就走样 */
  const target = { anchor: "FOO_BAR", replacement: "a$$b$&c$1d", prologue: "/*P*/0;" };
  const out = buildPatchedSource('"use strict";\nX FOO_BAR Y;\n', target);
  assert.equal(out.error, undefined);
  assert.equal(out.output, '"use strict";\n/*P*/0;\nX a$$b$&c$1d Y;\n');
});

test("v445: legacy-prologue migration and restore also insert their bodies verbatim when `$` replacement patterns appear", () => {
  /* 函数式替换的三处里另两处：站点 2（旧代 prologue 原位换装，换入体=t2.prologue）与站点 3（restore
   * 还原锚点）。出厂常量今天只含 $ue（无害），用带 $$/$&/$1 的登记条目走真实 ensure/restore 链锁定 */
  const anchor = "a$$b$&c$1d", replacement = "x$$y$&z$1w", mark = PROLOGUE + "\n/* $$ $& keep */";
  const original = '#!/usr/bin/env node\n"use strict";var wXi=1;\nfunction q(e){let t=X(e),' + anchor + '}\n';
  const target = { build: "test", engineSha256: sha256hex(Buffer.from(original)), anchor, replacement, prologue: mark };
  ENGINE_TARGETS.push(target); extraTargets.push(target);
  const first = setup({ fixture: Buffer.from(original) });
  const migrated = setup();
  try {
    assert.equal(first.patcher.ensure(), "applied");
    const patched = fs.readFileSync(first.enginePath, "utf8");
    assert.ok(patched.includes(replacement), "apply：替换体逐字节原样");
    assert.ok(patched.includes(mark), "apply：prologue 逐字节原样（$$ 不被折叠成 $）");
    assert.equal(first.patcher.restore(), "off");
    assert.equal(fs.readFileSync(first.enginePath, "utf8"), original, "restore：锚点逐字节还原");
    // 站点 2：已打旧代 prologue 的引擎原位换装——换入的新 prologue 带 $ 序列
    const legacyPatched = patched.replace(mark, PROLOGUE_V2);
    fs.writeFileSync(migrated.enginePath, legacyPatched);
    assert.equal(migrated.patcher.ensure(), "applied");
    const after = fs.readFileSync(migrated.enginePath, "utf8");
    assert.ok(after.includes(mark), "旧代迁移：换入的 prologue 逐字节原样");
    assert.equal(after.includes(PROLOGUE_V2), false, "旧代 prologue 已被替换");
    assert.equal(migrated.patcher.restore(), "off");
    assert.equal(fs.readFileSync(migrated.enginePath, "utf8"), original, "迁移后的引擎同样能逐字节还原");
  } finally { first.cleanup(); migrated.cleanup(); }
});

test("ensure reports patched_inconsistent and leaves bytes untouched for a foreign or half-applied patch", () => {
  /* 三道形态：① 带补丁前缀但任一登记条目的替换体都不在；② 旧代 prologue 在、替换体不在
   * （缺第一道守卫会对 undefined 取 prologue 抛错）；③ 替换体在、却没有任何已知代际的
   * prologue（半截补丁）。外来/半截补丁一律不接手、不写盘、不留备份 */
  /* 正文带一个 undefined 字面量：第二道守卫被删时 text.replace(undefined, …) 会改写正文，
     「不写盘」断言才会参与击杀 */
  const head = '#!/usr/bin/env node\n"use strict";\n' + PROLOGUE_PREFIX + "/* foreign */\nvar a=1; /* undefined */\n";
  const fixtures = {
    "no replacement body": head,
    "legacy prologue without replacement body": PROLOGUE_V1 + "\nvar a=1;\n",
    "replacement body without any known prologue": head + REPLACEMENT + "\n",
  };
  for (const [what, text] of Object.entries(fixtures)) {
    const s = setup({ fixture: Buffer.from(text) });
    try {
      assert.equal(s.patcher.ensure(), "error", what);
      assert.equal(s.patcher.status().state, "error", what);
      assert.equal(s.patcher.status().lastError, "patched_inconsistent", what);
      assert.deepEqual(fs.readFileSync(s.enginePath), s.original, what + "：不写盘");
      assert.equal(fs.readdirSync(path.dirname(s.enginePath)).filter((f) => f.startsWith(".pre-acthreshold-")).length, 0, what + "：不留备份");
    } finally { s.cleanup(); }
  }
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
    assert.equal(hook(EFF), 100000, "v420：低于 100k 下限钳到 100000（历史手写小值不再放行）");
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

/* ---------- 请求抓包 hook（CAPTURE_PROLOGUE，vm 沙箱 + 临时 HOME）---------- */
const PROLOGUE_BASE = ep.PROLOGUE_BASE;
const HDR = { "content-type": "application/json", "x-zcode-trace-id": "trace-1", "x-zcode-query-source": "main_turn", "x-zcode-session-type": "main" };
const modelBody = (sys, tools, user) => JSON.stringify({
  model: "m-1", system: sys, tools,
  messages: [{ role: "user", content: user || "SECRET-USER-TEXT" }, { role: "assistant", content: [{ type: "text", text: "SECRET-ANSWER-TEXT" }] }],
});
const TOOLS = [{ name: "Read", description: "read a file", parameters: { type: "object" } }];

function captureEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ztus-capture-home-"));
  const cfgDir = path.join(root, ".zcode", "zcode-token-usage-statusbar");
  fs.mkdirSync(cfgDir, { recursive: true });
  const capDir = path.join(cfgDir, "req-capture");
  const jsonl = path.join(capDir, "requests.jsonl");
  return {
    root, capDir, jsonl,
    cfg: path.join(cfgDir, "req-capture.json"),
    setConfig: (obj) => fs.writeFileSync(path.join(cfgDir, "req-capture.json"), JSON.stringify(obj)),
    lines: () => (fs.existsSync(jsonl) ? fs.readFileSync(jsonl, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    blobs: () => { const d = path.join(capDir, "blobs"); return fs.existsSync(d) ? fs.readdirSync(d).sort() : []; },
    blobText: (h) => fs.readFileSync(path.join(capDir, "blobs", h + ".json"), "utf8"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function loadCapture(env, fetchImpl, extra = {}) {
  const calls = [];
  const clock = { value: 1700000000000 };   // 真实纪元毫秒量级：hook 的 5 秒节流窗以 0 为「上次检查」，小数值会被当成刚检查过
  const base = fetchImpl || (async (input, init) => { calls.push({ input, init }); return { ok: true }; });
  // node:http / node:https 替身：记下 request 入参，返回一个带 end 的假请求对象（真引擎就是 req.end(Buffer) 写请求体）
  const httpCalls = [];
  const fakeMod = () => ({
    request(...args) {
      httpCalls.push({ self: this, args });
      const req = { ended: [], once() { return this; }, on() { return this; } };
      req.end = function (...a) { this.ended.push(a[0]); return this; };
      return req;
    },
  });
  const http = fakeMod();
  const https = fakeMod();
  const sandbox = {
    require: (name) => (name === "os" ? { homedir: () => env.root } : name === "node:http" ? http : name === "node:https" ? https : require(name)),
    fetch: base,
    Date: { now: () => clock.value },
    Buffer,
    ...extra,   // 额外的沙箱全局（例如 setImmediate 替身）
  };
  vm.runInNewContext(PROLOGUE, sandbox, { filename: "capture-prologue-test.js" });
  return { fetch: sandbox.fetch, base, calls, clock, http, https, httpCalls };
}

/* 宿主 4.0.0 引擎 fetchHttpResponse 的两条真实调用形态 */
const HOST_HDRS = new Headers({ "content-type": "application/json", "x-zcode-trace-id": "trace-1", "x-zcode-query-source": "main_turn", "x-zcode-session-type": "main" });
const hostDirectFetch = (c, body) => c.fetch("https://x.test/api/chat/completions", { body: Buffer.from(body), method: "POST", headers: HOST_HDRS, redirect: "manual" });
const hostNodeRequest = (mod, body) => {
  // p.request({agent, headers, hostname, method, path, port, protocol, signal, lookup}, cb) → x.end(Buffer)
  const hdrs = {};
  HOST_HDRS.forEach((v, k) => { hdrs[k] = v; });
  const req = mod.request({ agent: undefined, headers: hdrs, hostname: "x.test", method: "POST", path: "/api/chat/completions", port: void 0, protocol: "https:", signal: void 0, lookup: void 0 }, () => {});
  req.once("error", () => {});
  req.end(body === undefined ? void 0 : Buffer.from(body));
  return req;
};

test("capture hook: full prologue compiles and is BASE + capture; legacy bodies stay free of it", () => {
  assert.doesNotThrow(() => new vm.Script(PROLOGUE), "注入引擎的 prologue 必须可解析（坏一字即全引擎起不来）");
  assert.ok(PROLOGUE.startsWith(PROLOGUE_BASE), "完整 prologue = 阈值 hook + 抓包 hook");
  assert.ok(PROLOGUE.includes("request capture hook") && !PROLOGUE_BASE.includes("request capture hook"));
  assert.equal(ep.PROLOGUE_CAP_V2, PROLOGUE_BASE + ep.CAPTURE_PROLOGUE_V2, "上一版抓包装机形态 = 阈值 hook + 上一版抓包 hook");
  assert.notEqual(ep.CAPTURE_PROLOGUE_V2, ep.CAPTURE_PROLOGUE, "上一版文本原样保留，供迁移逐字节命中");
  assert.ok(!/\\/.test(ep.CAPTURE_PROLOGUE), "抓包段不含反斜杠转义（模板会提前解开换行，生成非法 JS）");
  // 上一版抓包串靠逐字节命中做原位迁移：这里钉死它的哈希，任何误改（哪怕一个字符）都会让测试变红，
  // 而不是等到那台机器迁移时报 patched_inconsistent。要换掉这一版时连同哈希一起滚动。
  assert.equal(sha256hex(Buffer.from(ep.CAPTURE_PROLOGUE_V2, "utf8")), "bd4bff09dd4a3f492b197a3d39ab1906d02e08604cee27eb6aa5c48340285cab");
  assert.ok(!PROLOGUE_V1.includes("request capture hook") && !PROLOGUE_V2.includes("request capture hook"), "旧代际串不得混入抓包段（迁移要逐字节命中）");
});

test("capture hook: off by default — pass-through, nothing on disk", async () => {
  const env = captureEnv();
  try {
    const c = loadCapture(env);
    const init = { method: "POST", headers: HDR, body: modelBody("You are a helper", TOOLS) };
    const res = await c.fetch("https://x.test/v1/chat/completions", init);
    assert.deepEqual(res, { ok: true });
    assert.equal(c.calls.length, 1);
    assert.equal(c.calls[0].init, init, "参数原样透传");
    assert.deepEqual(env.lines(), []);
    assert.deepEqual(env.blobs(), []);
    env.setConfig({ enabled: false });
    c.clock.value += 6000;
    await c.fetch("https://x.test/v1/chat/completions", init);
    assert.deepEqual(env.lines(), [], "enabled:false 不记");
    env.setConfig("{broken");
    c.clock.value += 6000;
    await c.fetch("https://x.test/v1/chat/completions", init);
    assert.deepEqual(env.lines(), [], "损坏配置不记也不抛");
  } finally { env.cleanup(); }
});

test("capture hook: enabled — one line per model request, deduped blobs, no message bodies", async () => {
  const env = captureEnv();
  try {
    env.setConfig({ enabled: true });
    const c = loadCapture(env);
    await c.fetch("https://x.test/v1/chat/completions", { method: "POST", headers: HDR, body: modelBody("You are a helper", TOOLS) });
    await c.fetch("https://x.test/v1/messages", { method: "POST", headers: HDR, body: modelBody("You are a helper", TOOLS, "SECOND-USER-TEXT") });
    const lines = env.lines();
    assert.equal(lines.length, 2);
    const l = lines[0];
    assert.equal(l.trace, "trace-1");
    assert.equal(l.querySource, "main_turn");
    assert.equal(l.sessionType, "main");
    assert.equal(l.model, "m-1");
    assert.equal(l.ts, 1700000000000);
    assert.equal(l.messages, 2);
    assert.ok(l.messageChars > 0, "只记消息条数与字符数");
    const sysJson = JSON.stringify("You are a helper"), toolsJson = JSON.stringify(TOOLS);
    assert.equal(l.systemHash, sha256hex(Buffer.from(sysJson)));
    assert.equal(l.toolsHash, sha256hex(Buffer.from(toolsJson)));
    assert.equal(l.systemChars, sysJson.length);
    assert.equal(l.toolsChars, toolsJson.length);
    assert.deepEqual(env.blobs(), [l.systemHash + ".json", l.toolsHash + ".json"].sort(), "两次同 system/tools 只落两份 blob");
    assert.equal(env.blobText(l.systemHash), sysJson, "blob 是 JSON 值，读取端 json.loads 即得原文");
    assert.equal(env.blobText(l.toolsHash), toolsJson);
    const everything = fs.readFileSync(env.jsonl, "utf8") + env.blobText(l.systemHash) + env.blobText(l.toolsHash);
    for (const secret of ["SECRET-USER-TEXT", "SECRET-ANSWER-TEXT", "SECOND-USER-TEXT"]) {
      assert.ok(!everything.includes(secret), "消息正文不得落盘：" + secret);
    }
    assert.equal(c.calls.length, 2, "原请求照常发出");
  } finally { env.cleanup(); }
});

test("capture hook: non-model requests and unusable bodies are skipped without breaking the call", async () => {
  const env = captureEnv();
  try {
    env.setConfig({ enabled: true });
    const c = loadCapture(env);
    const body = modelBody("sys", TOOLS);
    await c.fetch("https://x.test/v1/chat/completions", { method: "GET", headers: HDR });
    await c.fetch("https://x.test/v1/chat/completions", { method: "PUT", headers: HDR, body });            // 带归因头、带请求体，但不是 POST
    await c.fetch("https://x.test/v1/chat/completions", { method: "get", headers: HDR, body: modelBody("sys-lower", TOOLS) });
    await c.fetch("https://x.test/v1/chat/completions", { method: "POST", body });             // 无归因头
    await c.fetch("https://x.test/v1/chat/completions", { method: "POST", headers: { "X-Zcode-Trace-Id": "" }, body });
    await c.fetch("https://x.test/v1/chat/completions", { method: "POST", headers: HDR, body: "not json" });
    await c.fetch("https://x.test/v1/chat/completions", { method: "POST", headers: HDR, body: "[1,2]" });
    await c.fetch("https://x.test/v1/chat/completions", { method: "POST", headers: HDR, body: JSON.stringify({ model: "m", messages: [] }) });
    assert.equal(c.calls.length, 8, "原请求照常发出");
    assert.deepEqual(env.lines(), [], "只有 POST 记：PUT 与带体 GET 不记");
    assert.deepEqual(env.blobs(), []);
    await c.fetch("https://x.test/v1/chat/completions", { method: "POST", headers: { "X-ZCODE-TRACE-ID": "trace-upper" }, body });
    assert.equal(env.lines().length, 1, "请求头大小写不敏感");
    assert.equal(env.lines()[0].trace, "trace-upper");
  } finally { env.cleanup(); }
});

test("capture hook: Request-object input with an async body is captured", async () => {
  const env = captureEnv();
  try {
    env.setConfig({ enabled: true });
    const c = loadCapture(env);
    const req = {
      method: "POST",
      headers: { get: (n) => (n === "x-zcode-trace-id" ? "trace-req" : n === "x-zcode-session-type" ? "subagent" : null) },
      clone() { return { text: async () => modelBody("sys-req", null) }; },
    };
    await c.fetch(req);
    assert.equal(c.calls.length, 1, "原请求照常发出，不等抓包");
    await new Promise((r) => setImmediate(r));
    const lines = env.lines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].trace, "trace-req");
    assert.equal(lines[0].sessionType, "subagent");
    assert.equal(lines[0].toolsHash, "", "无 tools 不落 blob");
    assert.deepEqual(env.blobs(), [lines[0].systemHash + ".json"]);
  } finally { env.cleanup(); }
});

test("capture hook: config flips are picked up without a restart, at most once per 5s", async () => {
  const env = captureEnv();
  try {
    env.setConfig({ enabled: true });
    const c = loadCapture(env);
    const post = () => c.fetch("https://x.test/v1/chat/completions", { method: "POST", headers: HDR, body: modelBody("sys", null) });
    await post();
    assert.equal(env.lines().length, 1);
    env.setConfig({ enabled: false });
    await post();
    assert.equal(env.lines().length, 2, "5 秒内仍用缓存的开关");
    c.clock.value += 6000;
    await post();
    assert.equal(env.lines().length, 2, "过了节流窗读到关闭");
    env.setConfig({ enabled: true });
    await post();
    assert.equal(env.lines().length, 2);
    c.clock.value += 6000;
    await post();
    assert.equal(env.lines().length, 3, "重新打开同样免重启");
  } finally { env.cleanup(); }
});

test("capture hook: requests.jsonl keeps the last 300 lines past 512KB; blobs are capped at 300", async () => {
  const env = captureEnv();
  try {
    env.setConfig({ enabled: true });
    const c = loadCapture(env);
    for (let i = 0; i < 1700; i++) {
      await c.fetch("https://x.test/v1/chat/completions", { method: "POST", headers: { ...HDR, "x-zcode-trace-id": "trace-" + (i % 7) }, body: modelBody("sys", TOOLS) });
    }
    const lines = env.lines();
    assert.ok(lines.length > 0 && lines.length < 1700, "1700 行足以触发至少一次滚动，滚动掉更早的行：" + lines.length);
    assert.equal(lines[0].trace, "trace-" + ((1700 - lines.length) % 7), "留下的是最近写入的行（连续、无空洞）");
    for (let i = 1; i < lines.length; i++) {
      assert.equal(lines[i].trace, "trace-" + ((1700 - lines.length + i) % 7), "第 " + i + " 行连续");
    }
    assert.ok(fs.statSync(env.jsonl).size <= 524288, "滚动后文件回到 512KB 以内");
    for (let i = 0; i < 320; i++) {
      await c.fetch("https://x.test/v1/chat/completions", { method: "POST", headers: HDR, body: modelBody("distinct-system-" + i + "-" + "x".repeat(200), null) });
    }
    assert.equal(env.blobs().length, 300, "blob 目录封顶 300 个，超出按最旧删除");
    for (const h of env.blobs()) assert.ok(/^[0-9a-f]{64}\.json$/.test(h), "blob 文件名=内容 SHA256");
  } finally { env.cleanup(); }
});

test("ensure migrates an engine patched with the threshold-only prologue (PROLOGUE_BASE) and restore handles it", () => {
  const s = setup();
  try {
    registerTarget(s.original);
    /* 加抓包 hook 之前的装机形态：只有阈值 hook + 同一替换体 */
    const legacy = buildPatchedSource(s.original.toString("utf8"), { anchor: ANCHOR, replacement: REPLACEMENT, prologue: PROLOGUE_BASE });
    assert.ok(legacy && !legacy.error);
    fs.writeFileSync(s.enginePath, legacy.output);
    assert.equal(s.patcher.ensure(), "applied");
    const after = fs.readFileSync(s.enginePath, "utf8");
    assert.ok(after.includes(PROLOGUE), "hook 本体已换装为 阈值+抓包 完整版");
    assert.ok(after.includes(REPLACEMENT), "锚点替换体保持不变");
    assert.equal(after.split("request capture hook").length - 1, 1, "抓包 hook 只有一份，不叠加");
    assert.equal(s.patcher.ensure(), "applied", "迁移后幂等");
    assert.equal(s.patcher.restore(), "off");
    assert.deepEqual(fs.readFileSync(s.enginePath), s.original, "完整版装机还原到原版字节");
    /* 只装了 BASE 的机器直接 restore 也要能还原 */
    fs.writeFileSync(s.enginePath, legacy.output);
    assert.equal(s.patcher.restore(), "off");
    assert.deepEqual(fs.readFileSync(s.enginePath), s.original);
  } finally { s.cleanup(); }
});

test("capture hook: host direct path — fetch with a Buffer body and a Headers instance is captured", async () => {
  const env = captureEnv();
  try {
    env.setConfig({ enabled: true });
    const c = loadCapture(env);
    await hostDirectFetch(c, modelBody("You are a helper", TOOLS));
    assert.equal(env.lines().length, 1, "Buffer 请求体（宿主 fetchHttpResponse 直连分支的写法）必须能记");
    assert.equal(env.lines()[0].trace, "trace-1");
    assert.equal(env.lines()[0].systemChars, JSON.stringify("You are a helper").length);
    assert.equal(c.calls.length, 1, "原请求照常发出");
    // 其余字节形态
    const text = modelBody("sys-u8", null);
    await c.fetch("https://x.test/a", { method: "POST", headers: HDR, body: new TextEncoder().encode(text) });
    await c.fetch("https://x.test/a", { method: "POST", headers: HDR, body: new TextEncoder().encode(text).buffer });
    const view = new TextEncoder().encode(modelBody("sys-dv", null));
    await c.fetch("https://x.test/a", { method: "POST", headers: HDR, body: new DataView(view.buffer, 1, view.length - 1) });
    assert.equal(env.lines().length, 3, "Uint8Array / ArrayBuffer 记；DataView 截掉首字节后不是合法 JSON，不记也不抛");
    assert.ok(!env.lines().some((l) => l.systemChars === 0));
    await c.fetch("https://x.test/a", { method: "POST", headers: HDR, body: { not: "bytes" } });
    await c.fetch("https://x.test/a", { method: "POST", headers: HDR, body: null });
    assert.equal(env.lines().length, 3, "无法解码的请求体静默跳过");
    assert.equal(c.calls.length, 6);
  } finally { env.cleanup(); }
});

test("capture hook: host node path — http(s).request({method, headers}, cb) + req.end(Buffer) is captured", async () => {
  const env = captureEnv();
  try {
    env.setConfig({ enabled: true });
    const c = loadCapture(env);
    assert.ok(c.http.request.__zc === 1 && c.https.request.__zc === 1, "node:http 与 node:https 的 request 都被包了");
    const req = hostNodeRequest(c.https, modelBody("sys-node", TOOLS));
    assert.ok(req.ended.length === 1 && Buffer.isBuffer(req.ended[0]), "请求体原样交给原 end（Buffer 不动）");
    assert.equal(c.httpCalls.length, 1);
    assert.equal(c.httpCalls[0].self, c.https, "this 保持为模块对象");
    assert.equal(env.lines().length, 1);
    assert.equal((env.lines()[0].trace, env.lines()[0].systemChars), JSON.stringify("sys-node").length);
    hostNodeRequest(c.http, modelBody("sys-http", null));
    assert.equal(env.lines().length, 2, "http 与 https 两条都记");
    // 不该记的：GET、无归因头、关闭状态
    c.https.request({ method: "GET", headers: { "x-zcode-trace-id": "t" }, hostname: "x.test" }, () => {}).end();
    const plain = c.https.request({ method: "POST", headers: {}, hostname: "x.test" }, () => {});
    plain.end(Buffer.from(modelBody("no-trace", null)));
    assert.equal(plain.ended.length, 1);
    assert.equal(env.lines().length, 2, "GET 与无归因头的请求不记");
    // request(url, options, cb) 重载：选项在第二个参数
    const urlOpts = c.https.request("https://x.test/p", { method: "POST", headers: { "x-zcode-trace-id": "trace-url" } }, () => {});
    urlOpts.end(Buffer.from(modelBody("sys-url", null)));
    assert.equal(env.lines().length, 3);
    assert.equal(env.lines()[2].trace, "trace-url");
    // 关闭状态：原样透传、不记
    env.setConfig({ enabled: false });
    c.clock.value += 6000;
    const off = c.https.request({ method: "POST", headers: { "x-zcode-trace-id": "trace-1" }, hostname: "x.test" }, () => {});
    off.end(Buffer.from(modelBody("off", null)));
    assert.equal(off.ended.length, 1, "请求体照常交给原 end");
    assert.equal(env.lines().length, 3, "关闭状态不记");
    await hostDirectFetch(c, modelBody("off-fetch", null));
    assert.equal(env.lines().length, 3, "关闭状态 fetch 路径同样不记");
    // 同一模块重复初始化不叠加
    vm.runInNewContext(PROLOGUE, { require: (name) => (name === "os" ? { homedir: () => env.root } : name === "node:https" ? c.https : name === "node:http" ? c.http : require(name)), Buffer, Date: { now: () => c.clock.value } }, { filename: "again.js" });
    assert.equal(c.https.request.__zc, 1);
  } finally { env.cleanup(); }
});

test("ensure migrates an engine patched with the previous capture hook (PROLOGUE_CAP_V2) and restore handles it", () => {
  const s = setup();
  try {
    registerTarget(s.original);
    const legacy = buildPatchedSource(s.original.toString("utf8"), { anchor: ANCHOR, replacement: REPLACEMENT, prologue: ep.PROLOGUE_CAP_V2 });
    assert.ok(legacy && !legacy.error);
    fs.writeFileSync(s.enginePath, legacy.output);
    assert.equal(s.patcher.ensure(), "applied");
    const after = fs.readFileSync(s.enginePath, "utf8");
    assert.ok(after.includes(PROLOGUE), "已换装 阈值+抓包 v2");
    assert.ok(!after.includes(ep.PROLOGUE_CAP_V2), "初版抓包不残留");
    assert.equal(after.split("request capture hook").length - 1, 1, "抓包 hook 只有一份");
    assert.equal(s.patcher.ensure(), "applied", "迁移后幂等");
    assert.equal(s.patcher.restore(), "off");
    assert.deepEqual(fs.readFileSync(s.enginePath), s.original, "还原到原版字节");
    fs.writeFileSync(s.enginePath, legacy.output);
    assert.equal(s.patcher.restore(), "off", "初版抓包装机直接 restore");
    assert.deepEqual(fs.readFileSync(s.enginePath), s.original);
  } finally { s.cleanup(); }
});

test("capture hook: real Node runtime — both host request shapes hit a local server (temp HOME, real fetch/Headers/Buffer/http)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ztus-capture-real-home-"));
  const seen = [];
  const server = http.createServer((req, res) => {
    let n = 0;
    req.on("data", (c) => { n += c.length; });
    req.on("end", () => { seen.push({ method: req.method, trace: req.headers["x-zcode-trace-id"], bytes: n }); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = "http://127.0.0.1:" + server.address().port + "/v1/chat/completions";
    const cfgDir = path.join(home, ".zcode", "zcode-token-usage-statusbar");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, "req-capture.json"), JSON.stringify({ enabled: true }));
    const body = JSON.stringify({ model: "m", system: "REAL NODE", tools: [{ name: "Read" }], messages: [{ role: "user", content: "NEVER-STORED-BODY" }] });
    // 子进程里：先跑真实 prologue，再按宿主 fetchHttpResponse 的两种写法发请求
    const driver = [
      PROLOGUE,
      "(async () => {",
      "  const hdrs = new Headers({ 'content-type': 'application/json', 'x-zcode-trace-id': 'trace-real', 'x-zcode-query-source': 'main_turn', 'x-zcode-session-type': 'main' });",
      "  const r1 = await fetch(" + JSON.stringify(url) + ", { body: Buffer.from(" + JSON.stringify(body) + "), method: 'POST', headers: hdrs, redirect: 'manual' });",
      "  await r1.text();",
      "  const u = new URL(" + JSON.stringify(url) + ");",
      "  const h = {}; hdrs.forEach((v, k) => { h[k] = v; });",
      "  await new Promise((resolve, reject) => {",
      "    const x = require('node:http').request({ agent: undefined, headers: h, hostname: u.hostname, method: 'POST', path: u.pathname + u.search, port: u.port || undefined, protocol: u.protocol, signal: undefined, lookup: undefined }, (r) => { r.resume(); r.on('end', resolve); });",
      "    x.once('error', reject);",
      "    x.end(Buffer.from(" + JSON.stringify(body) + "));",
      "  });",
      "  await new Promise((r) => setImmediate(r));",
      "})().catch((e) => { console.error((e && e.stack) || e); process.exit(3); });",
    ].join("\n");
    const res = await new Promise((resolve) => {
      const child = cp.spawn(process.execPath, ["-e", driver], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code) => resolve({ code, err }));
    });
    assert.equal(res.code, 0, "子进程正常结束：" + res.err.slice(0, 400));
    assert.deepEqual(seen.map((x) => [x.method, x.trace, x.bytes]), [["POST", "trace-real", Buffer.byteLength(body)], ["POST", "trace-real", Buffer.byteLength(body)]], "两次请求原样到达服务器，请求体一字节没动");
    const jsonl = path.join(cfgDir, "req-capture", "requests.jsonl");
    const lines = fs.readFileSync(jsonl, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines.length, 2, "两条路径各记一条");
    assert.deepEqual(lines.map((l) => l.trace), ["trace-real", "trace-real"]);
    assert.equal(lines[0].systemHash, lines[1].systemHash);
    assert.equal(lines[0].systemChars, JSON.stringify("REAL NODE").length);
    assert.equal(lines[0].messages, 1);
    const blob = path.join(cfgDir, "req-capture", "blobs", lines[0].systemHash + ".json");
    assert.equal(fs.readFileSync(blob, "utf8"), JSON.stringify("REAL NODE"));
    assert.ok(!fs.readFileSync(jsonl, "utf8").includes("NEVER-STORED-BODY") && !fs.readFileSync(blob, "utf8").includes("NEVER-STORED-BODY"), "消息正文不落盘");
    assert.ok(!fs.existsSync(path.join(home, ".zcode", "zcode-token-usage-statusbar", "autocompact.json")), "阈值 hook 不受影响、不写东西");
    // 审查第 1 轮 R2：system prompt 可能含项目规则/记忆，落盘文件只给本人读（POSIX 权限位；Windows 不表达）
    if (process.platform !== "win32") {
      const capDir = path.join(cfgDir, "req-capture");
      assert.equal(fs.statSync(capDir).mode & 0o777, 0o700, "req-capture 目录 0700");
      assert.equal(fs.statSync(path.join(capDir, "blobs")).mode & 0o777, 0o700, "blobs 目录 0700");
      assert.equal(fs.statSync(jsonl).mode & 0o777, 0o600, "requests.jsonl 0600");
      assert.equal(fs.statSync(blob).mode & 0o777, 0o600, "blob 0600");
    }
    // 与平台无关的断言不进上面的权限位门：此前它在 Windows 上被一并静默跳过
    assert.equal(typeof lines[0].messageChars, "number");
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("capture hook: parsing and writing are deferred off the request path (unref'd setImmediate)", async () => {
  const env = captureEnv();
  try {
    env.setConfig({ enabled: true });
    const queued = [];
    let unrefd = 0;
    const fakeSetImmediate = (fn) => { queued.push(fn); return { unref() { unrefd += 1; } }; };
    const c = loadCapture(env, undefined, { setImmediate: fakeSetImmediate });
    await hostDirectFetch(c, modelBody("sys-defer", TOOLS));
    assert.equal(c.calls.length, 1, "原请求照常发出");
    assert.equal(env.lines().length, 0, "请求返回时还没有解析/落盘");
    const req = hostNodeRequest(c.https, modelBody("sys-defer-http", null));
    assert.equal(req.ended.length, 1, "请求体原样交给原 end");
    assert.equal(env.lines().length, 0);
    assert.equal(queued.length, 2, "两条路径各排了一个延后任务");
    assert.ok(unrefd >= 2, "延后定时器都 unref（不拖住进程）");
    while (queued.length) queued.shift()();
    assert.deepEqual(env.lines().map((l) => l.systemChars), [JSON.stringify("sys-defer").length, JSON.stringify("sys-defer-http").length]);
    // 没有 setImmediate 的环境同步执行
    const sync = loadCapture(env);
    await hostDirectFetch(sync, modelBody("sys-sync", null));
    assert.equal(env.lines().length, 3);
  } finally { env.cleanup(); }
});

test("capture hook: messageChars is null (not a misleading 0) when the message list is too long to estimate", async () => {
  const env = captureEnv();
  try {
    env.setConfig({ enabled: true });
    const c = loadCapture(env);
    const many = JSON.stringify({ model: "m", system: "sys-many", tools: [], messages: Array.from({ length: 20001 }, () => ({ role: "user", content: "x" })) });
    await c.fetch("https://x.test/a", { method: "POST", headers: HDR, body: many });
    const l = env.lines()[0];
    assert.equal(l.messages, 20001, "条数照记");
    assert.equal(l.messageChars, null, "超过 2 万条不估字符数：写 null");
    assert.equal(l.systemChars, JSON.stringify("sys-many").length);
    const ok = JSON.stringify({ model: "m", system: "s", tools: [], messages: [{ role: "user", content: "hello" }] });
    await c.fetch("https://x.test/a", { method: "POST", headers: HDR, body: ok });
    assert.equal(env.lines()[1].messageChars, JSON.stringify({ role: "user", content: "hello" }).length);
  } finally { env.cleanup(); }
});

test("capture hook: request bodies are decoded as UTF-8 (non-ASCII system prompts keep their characters)", async () => {
  const env = captureEnv();
  try {
    env.setConfig({ enabled: true });
    const c = loadCapture(env);
    const sys = "系统提示 · тест · “引号” · 换行";
    await c.fetch("https://x.test/a", { method: "POST", headers: HDR, body: Buffer.from(modelBody(sys, [{ name: "读文件", description: "читать" }]), "utf8") });
    const l = env.lines()[0];
    const sysJson = JSON.stringify(sys);
    assert.equal(l.systemChars, sysJson.length, "按 UTF-8 解码后字符数与原文一致");
    assert.equal(l.systemHash, sha256hex(Buffer.from(sysJson, "utf8")));
    assert.equal(env.blobText(l.systemHash), sysJson, "blob 里是原样的非 ASCII 文本");
  } finally { env.cleanup(); }
});

test("capture hook: message bodies never reach disk even in truncated or partial form", async () => {
  const env = captureEnv();
  try {
    env.setConfig({ enabled: true });
    const c = loadCapture(env);
    await c.fetch("https://x.test/a", { method: "POST", headers: HDR, body: modelBody("sys", null, "SECRET-USER-TEXT") });
    await hostDirectFetch(c, modelBody("sys", TOOLS, "SECRET-USER-TEXT"));
    const record = fs.readFileSync(env.jsonl, "utf8");
    assert.deepEqual(Object.keys(JSON.parse(record.split("\n")[0])).sort(),
      ["messageChars", "messages", "model", "querySource", "sessionType", "systemChars", "systemHash", "toolsChars", "toolsHash", "trace", "ts"],
      "记录行只有这些字段：没有任何承载消息内容的键");
    assert.ok(!record.includes("SECRET") && !record.includes("role") && !record.includes("content"));
  } finally { env.cleanup(); }
});
