"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { resolveQuotaPaths, resolveCustomProvider, createQuotaClient, deriveCipherKey } = require("../quota-client.cjs");
const doc = (...rules) => ({ config: { providerConfigRules: { providerRules: rules } } });
const rule = (providerId, apiKey, baseUrl) => ({ providerId, providerName: "MiniMax", config: {
  access: apiKey === undefined ? {} : { apiKey }, api: baseUrl === undefined ? {} : { baseUrl },
} });
const tdoc = (templates, rules) => ({ config: { providerConfigRules: { templateRules: templates, providerRules: rules } } });
const tpl = (templateId, baseUrl) => ({ templateId, config: { api: { type: "openai-responses", baseUrl } } });
const tplProvider = (providerId, templateId, apiKey, baseUrl) => ({ providerId, templateId, config: {
  access: { type: "api-key", apiKey }, api: { type: "openai-responses", baseUrl } } });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quota-paths-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (p, d) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(d)); return p; };
  const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
  return { root, write, read };
}

test("paths: explicit > env actual files > data base > desktop home > OS home", () => {
  const env = { ZCODE_DATA_BASE_DIR: "/data", ZCODE_DESKTOP_HOME_DIR: "/desktop",
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/runtime/personal.json", ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/runtime/builtin.json" };
  const p = resolveQuotaPaths({ env, defaultHome: "/old" });
  assert.equal(p.credsPath, "/data/.zcode/v2/credentials.json");
  assert.equal(p.credsDir, "/data/.zcode/v2");
  assert.equal(p.customCfgPath, "/runtime/personal.json");
  assert.equal(p.builtinCfgDir, "/runtime");
  const explicit = resolveQuotaPaths({ env, defaultHome: "/old", dataBaseDir: "/explicit-base", credsPath: "/explicit/creds.json",
    customCfgPath: "/explicit/personal.json", builtinCfgPath: "/explicit/builtin.json" });
  assert.equal(explicit.credsPath, "/explicit/creds.json");
  assert.equal(explicit.customCfgPath, "/explicit/personal.json");
  assert.equal(explicit.builtinCfgPath, "/explicit/builtin.json");
  assert.equal(resolveQuotaPaths({ env, dataBaseDir: "/explicit-base" }).credsPath, "/explicit-base/.zcode/v2/credentials.json");
  assert.equal(resolveQuotaPaths({ env: { ZCODE_DESKTOP_HOME_DIR: "/desktop" }, defaultHome: "/old" }).credsDir, "/desktop/.zcode/v2");
  assert.equal(resolveQuotaPaths({ env: {}, defaultHome: "/old" }).customCfgPath, "/old/.zcode/v2/provider_config.json");
});

test("cipher: data migration does not change OS-home key derivation", () => {
  assert.deepEqual(deriveCipherKey({}), deriveCipherKey({ ZCODE_DATA_BASE_DIR: "D:\\迁移 数据", ZCODE_DESKTOP_HOME_DIR: "/fixture-desktop" }));
});

test("paths: Windows Unicode/spaces via win32 and automatic drive detection", () => {
  const env = { ZCODE_DATA_BASE_DIR: "D:\\ZcodeProgram 数据", ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "E:\\用户 配置\\personal.json",
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "E:\\运行 缓存\\builtin.json" };
  for (const pathImpl of [path.win32, undefined]) {
    const p = resolveQuotaPaths({ env, defaultHome: "C:\\Users\\旧 用户", pathImpl });
    assert.equal(p.credsPath, "D:\\ZcodeProgram 数据\\.zcode\\v2\\credentials.json");
    assert.equal(p.customCfgDir, "E:\\用户 配置");
    assert.equal(p.builtinCfgDir, "E:\\运行 缓存");
  }
});

test("migration: client only reads actual paths, never stale HOME copies", (t) => {
  const { root, write, read } = fixture(t);
  const home = path.join(root, "old-home"), data = path.join(root, "new-data");
  write(path.join(home, ".zcode/v2/provider_config.json"), doc(rule("minimax", "old-fixture-key", "https://api.minimax.io")));
  const personal = write(path.join(data, "personal.json"), doc(rule("minimax", "new-fixture-key")));
  const builtin = write(path.join(data, "builtin.json"), doc(rule("minimax", undefined, "https://api.minimaxi.com")));
  const paths = resolveQuotaPaths({ defaultHome: home, env: { ZCODE_DATA_BASE_DIR: data,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin } });
  const seen = [];
  const client = createQuotaClient({ ...paths, env: {}, secretsPath: path.join(root, "runtime/quota-secrets.json"),
    readFile(p) { seen.push(p); assert.ok(!p.startsWith(home), "stale HOME read"); return read(p); } });
  t.after(() => client.dispose());
  client.noteProvider("minimax");
  /* 统一调度器为 provider 建独立复合源（vendor:providerId），同一厂商多账户互不串显 */
  assert.equal(client.view().byProvider["minimax"], "minimax:minimax");
  assert.equal(client.view().active, "minimax:minimax");
  assert.ok(seen.includes(personal));
  assert.ok(seen.includes(builtin));
});

test("merge: personal api={} inherits builtin base, explicit empty key stays empty", (t) => {
  const { root, write, read } = fixture(t);
  const builtin = write(path.join(root, "builtin.json"), doc(rule("minimax", "builtin-fixture-key", "https://api.minimax.io/")));
  const personal = write(path.join(root, "personal.json"), doc(rule("minimax", "personal-fixture-key")));
  assert.deepEqual(resolveCustomProvider("minimax", read, personal, builtin), {
    name: "MiniMax", apiKey: "personal-fixture-key", baseUrl: "https://api.minimax.io",
  });
  write(personal, doc(rule("minimax", "")));
  assert.equal(resolveCustomProvider("minimax", read, personal, builtin).apiKey, "");
});

test("template: provider rule inherits builtin templateRules baseUrl; explicit baseUrl wins, empty string falls back (#123)", (t) => {
  const { root, write, read } = fixture(t);
  const builtin = write(path.join(root, "builtin.json"), tdoc([tpl("opencode-go-responses", "https://opencode.ai/zen/go/v1")], []));
  const personal = write(path.join(root, "personal.json"), doc(tplProvider("opencode-go-responses", "opencode-go-responses", "fixture-key", undefined)));
  const e = resolveCustomProvider("opencode-go-responses", read, personal, builtin);
  assert.equal(e.baseUrl, "https://opencode.ai/zen/go/v1", "个人配置无 baseUrl 回落内置模板域");
  assert.equal(e.apiKey, "fixture-key", "key 仍取个人配置");
  assert.equal(e.name, "");
  write(personal, doc(tplProvider("oc-relay", "opencode-go-responses", "fixture-key", "https://relay.example.com/v1/")));
  assert.equal(resolveCustomProvider("oc-relay", read, personal, builtin).baseUrl, "https://relay.example.com/v1",
    "显式 baseUrl 胜过模板，中转域不被模板替换");
  write(personal, doc(tplProvider("oc-empty", "opencode-go-responses", "fixture-key", "")));
  assert.equal(resolveCustomProvider("oc-empty", read, personal, builtin).baseUrl, "https://opencode.ai/zen/go/v1",
    "显式空串 baseUrl 按未填处理回落模板");
});

test("template: personal templateRules override builtin per templateId; unknown templateId behaves as before (#123)", (t) => {
  const { root, write, read } = fixture(t);
  const builtin = write(path.join(root, "builtin.json"), tdoc([tpl("go", "https://opencode.ai/zen/go/v1")], []));
  const personal = write(path.join(root, "personal.json"), tdoc(
    [tpl("go", "https://relay.example.com/zen/go")],
    [tplProvider("p1", "go", "fixture-key", undefined), tplProvider("p2", "no-such-template", "fixture-key", undefined)]));
  assert.equal(resolveCustomProvider("p1", read, personal, builtin).baseUrl, "https://relay.example.com/zen/go",
    "个人文件的同名模板按文件序覆盖内置");
  assert.equal(resolveCustomProvider("p2", read, personal, builtin).baseUrl, "", "未知 templateId 不回落，保持旧行为");
});

test("template: numeric templateId String-normalized; template access backfills omitted fields (#123)", (t) => {
  const { root, write, read } = fixture(t);
  const builtin = write(path.join(root, "builtin.json"), tdoc(
    [{ templateId: 123, config: { api: { type: "openai-responses", baseUrl: "https://opencode.ai/zen/go/v1" },
      access: { type: "coding-plan-api-key", apiKey: "tpl-key" } } }], []));
  const personal = write(path.join(root, "personal.json"), doc(
    { providerId: "p-num", templateId: "123", config: { access: { apiKey: "fixture-key" }, api: {} } },
    { providerId: "p-acc", templateId: 123, config: { access: {}, api: { baseUrl: "" } } }));
  assert.equal(resolveCustomProvider("p-num", read, personal, builtin).baseUrl, "https://opencode.ai/zen/go/v1",
    "数字 templateId 与字符串键按 String 归一互撞");
  assert.equal(resolveCustomProvider("p-acc", read, personal, builtin).apiKey, "tpl-key",
    "个人缺 access 字段时模板 access 回填");
});

test("template: truthy non-array templateRules does not disable same-file providerRules (#123)", (t) => {
  const { root, write, read } = fixture(t);
  const personal = write(path.join(root, "personal.json"), { config: { providerConfigRules: {
    templateRules: { oops: true },
    providerRules: [rule("minimax", "fixture-key", "https://api.minimax.io")] } } });
  assert.equal(resolveCustomProvider("minimax", read, personal, "").apiKey, "fixture-key",
    "损坏的 templateRules 按无模板处理，providerRules 照常加载");
});

test("MiniMax detect: only exact built-in ID permits key-only CN default; builtin international base wins", (t) => {
  const { root, write, read } = fixture(t);
  const personal = write(path.join(root, "personal.json"), doc(rule("minimax", "fixture-key"), rule("unknown-minimax-model", "fixture-key")));
  const client = createQuotaClient({ env: {}, customCfgPath: personal, builtinCfgPath: "", credsPath: path.join(root, "creds.json"),
    secretsPath: path.join(root, "secrets.json"), readFile: read });
  t.after(() => client.dispose());
  const adapter = client._adapters.find((a) => a.id === "minimax");
  const j = { customProviderOf: (id) => resolveCustomProvider(id, read, personal) };
  assert.equal(adapter.detect(j, "minimax").domain, "https://api.minimaxi.com");
  assert.equal(adapter.detect(j, "unknown-minimax-model"), null);
  const builtin = write(path.join(root, "builtin.json"), doc(rule("minimax", undefined, "https://api.minimax.io")));
  assert.equal(adapter.detect({ customProviderOf: (id) => resolveCustomProvider(id, read, personal, builtin) }, "minimax").domain, "https://api.minimax.io");
});

test("cache: same mtime/size on different personal or builtin paths remains isolated", (t) => {
  const { root, write, read } = fixture(t);
  const a = write(path.join(root, "a.json"), doc(rule("minimax", "fixture-a")));
  const b = write(path.join(root, "b.json"), doc(rule("minimax", "fixture-b")));
  const ba = write(path.join(root, "ba.json"), doc(rule("minimax", undefined, "https://api.minimax.io")));
  const bb = write(path.join(root, "bb.json"), doc(rule("minimax", undefined, "https://api.minimax.cn")));
  for (const p of [a, b, ba, bb]) fs.utimesSync(p, 1700000000, 1700000000);
  assert.equal(resolveCustomProvider("minimax", read, a, ba).apiKey, "fixture-a");
  assert.equal(resolveCustomProvider("minimax", read, b, ba).apiKey, "fixture-b");
  assert.equal(resolveCustomProvider("minimax", read, b, bb).baseUrl, "https://api.minimax.cn");
});

test("cache: stat failure is never cached, size and builtin changes invalidate", (t) => {
  const { root, write, read } = fixture(t);
  let value = "one";
  const virtual = () => doc(rule("minimax", value));
  const missing = path.join(root, "virtual.json");
  assert.equal(resolveCustomProvider("minimax", virtual, missing).apiKey, "one");
  value = "two";
  assert.equal(resolveCustomProvider("minimax", virtual, missing).apiKey, "two");
  const personal = write(path.join(root, "personal.json"), doc(rule("minimax", "fixture")));
  const builtin = write(path.join(root, "builtin.json"), doc(rule("minimax", undefined, "https://api.minimax.io")));
  const stamp = fs.statSync(builtin).mtime;
  assert.equal(resolveCustomProvider("minimax", read, personal, builtin).baseUrl, "https://api.minimax.io");
  write(builtin, doc(rule("minimax", undefined, "https://api.minimaxi.com")));
  fs.utimesSync(builtin, stamp, stamp);
  assert.equal(resolveCustomProvider("minimax", read, personal, builtin).baseUrl, "https://api.minimaxi.com");
});

test("cache: deleting then recreating personal config with the same mtime/size never revives its old key", (t) => {
  const { root, write, read } = fixture(t);
  const personal = write(path.join(root, "personal.json"), doc(rule("minimax", "fixture-a")));
  fs.utimesSync(personal, 1700000000, 1700000000);
  const before = fs.statSync(personal);
  assert.equal(resolveCustomProvider("minimax", read, personal).apiKey, "fixture-a");
  fs.unlinkSync(personal);
  assert.equal(resolveCustomProvider("minimax", read, personal), null);
  write(personal, doc(rule("minimax", "fixture-b")));
  fs.utimesSync(personal, before.atime, before.mtime);
  const after = fs.statSync(personal);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.size, before.size);
  assert.equal(resolveCustomProvider("minimax", read, personal).apiKey, "fixture-b");
});

for (const [dir, file] of [["/", "/个人 配置.json"], ["D:\\", "D:\\个人 配置.json"]]) {
  test(`main bridge: root-directory watch callback accepts actual filename (${dir})`, () => {
    const source = fs.readFileSync(path.join(__dirname, "../inject-main.cjs"), "utf8");
    /* v258 起额度装配拆为 createQuotaClientInstance + initQuotaWatchers（热替换循环复用）：
     * 切片覆盖常量到 initQuotaSubsystem 之前的完整两函数，测试内显式调用走原链。 */
    const start = source.indexOf("const QUOTA_SECRETS");
    const snippet = source.slice(start, source.indexOf("\nfunction initQuotaSubsystem()", start));
    const callbacks = new Map(), events = [];
    let legacyCalls = 0;
    const paths = { credsPath: file, credsDir: dir, customCfgPath: file, customCfgDir: dir,
      builtinCfgPath: file, builtinCfgDir: dir };
    /* require 桩返回旧解析哨兵：额度块必须消费 resolveHostQuotaPaths() 的结果，
     * 回退成块内 resolveQuotaPaths({ defaultHome }) 会拿到哨兵目录而红（issue #205）；
     * 调用计数哨兵零消费断言保证两桩去重后锁定仍不静默失效。 */
    const legacyPaths = { credsPath: "/legacy-home/credentials.json", credsDir: "/legacy-home",
      customCfgPath: "/legacy-home/provider_config.json", customCfgDir: "/legacy-home",
      builtinCfgPath: "", builtinCfgDir: "" };
    /* syncQuotaProviders 是切片外的模块函数：桩为 tick。注意桩定义在 Node 域，
     * 词法引用看不到 vm 全局，必须捕获 sandbox 对象按属性读 quotaClient。 */
    const sandbox = {
      require() { return { resolveQuotaPaths: () => { legacyCalls++; return legacyPaths; }, createQuotaClient() { return {
        credentialsChanged() { events.push("changed"); }, tick() { events.push("tick"); },
      }; } }; },
      resolveHostQuotaPaths: () => paths,
      app: { getPath: () => "/fixture-home" }, HERE: "/fixture-runtime", path, quotaClient: null,
      fs: { watch(d, cb) { callbacks.set(d, cb); return { on() {} }; } }, LOG() {},
      syncQuotaProviders() { try { if (sandbox.quotaClient) sandbox.quotaClient.tick(); } catch (e) { } },
      quotaEnabled: () => true, resetBadgeEnabled: () => true, quotaDataEnabled: () => true,   // v135：切片内 createQuotaClient 引用双门控
      setInterval() {}, setTimeout(cb) { cb(); return 1; }, clearTimeout() {}, Set, Map,
    };
    vm.runInNewContext(snippet, sandbox);
    const resolved = sandbox.createQuotaClientInstance();
    assert.equal(legacyCalls, 0, "块内不得回落 require 的 resolveQuotaPaths");
    sandbox.initQuotaWatchers(resolved);
    assert.ok(callbacks.has(dir), "监听目录来自共享解析，而非旧 HOME 哨兵");
    assert.equal(callbacks.size, 1, "shared directory only needs one watcher");
    const callback = callbacks.get(dir);
    callback("rename", "unrelated.json");
    assert.deepEqual(events, []);
    callback("rename", "个人 配置.json");
    assert.deepEqual(events, ["changed", "tick"]);
    callback("rename", "个人 配置.json");
    assert.deepEqual(events, ["changed", "tick", "changed", "tick"]);
  });
}

test("main bridge: initialized paths and directory watchers use shared resolution; runtime secrets stay HERE", () => {
  const source = fs.readFileSync(path.join(__dirname, "../inject-main.cjs"), "utf8");
  const start = source.indexOf("const QUOTA_SECRETS");
  const snippet = source.slice(start, source.indexOf("\nfunction initQuotaSubsystem()", start));
  const dirs = [], clients = [];
  let legacyCalls = 0;
  const paths = { credsPath: "D:\\数据 空间\\credentials.json", credsDir: "D:\\数据 空间",
    customCfgPath: "E:\\个人\\personal.json", customCfgDir: "E:\\个人",
    builtinCfgPath: "F:\\内置\\builtin.json", builtinCfgDir: "F:\\内置" };
  const sandbox = {
    /* require 桩返回旧解析哨兵：初始化路径若回退成块内 resolveQuotaPaths({ defaultHome })
     * 会拿到哨兵目录，dirs/clients 断言即红（issue #205 接线锁定）；调用计数断言保证
     * 两桩被去重成同一对象后锁定仍不静默失效。 */
    require() { return { resolveQuotaPaths: () => { legacyCalls++; return { credsPath: "/legacy-home/credentials.json",
      credsDir: "/legacy-home", customCfgPath: "/legacy-home/provider_config.json",
      customCfgDir: "/legacy-home", builtinCfgPath: "", builtinCfgDir: "" }; },
      createQuotaClient(o) { clients.push(o); return {}; } }; },
    resolveHostQuotaPaths: () => paths,
    app: { getPath: () => "/fixture-home" }, HERE: "/fixture-runtime", path, quotaClient: null,
    fs: { watch(dir) { dirs.push(dir); return { on() {} }; } }, LOG() {},
    quotaEnabled: () => true, resetBadgeEnabled: () => true, quotaDataEnabled: () => true,
    setInterval() {}, setTimeout() {}, clearTimeout() {}, Set, Map,
  };
  vm.runInNewContext(snippet, sandbox);
  sandbox.initQuotaWatchers(sandbox.createQuotaClientInstance());
  assert.equal(legacyCalls, 0, "块内不得回落 require 的 resolveQuotaPaths");
  assert.deepEqual(dirs, [paths.credsDir, paths.customCfgDir, paths.builtinCfgDir]);
  assert.equal(clients[0].credsPath, paths.credsPath);
  assert.equal(clients[0].customCfgPath, paths.customCfgPath);
  assert.equal(clients[0].secretsPath, "/fixture-runtime/quota-secrets.json");
});

/* ---------- issue #205：主进程 env 没有 ZCODE_*（宿主只注入 CLI 子进程），数据目录
 * 迁移后 ~/.zcode/v2 下读不到 provider_config/credentials，模板创建供应商拿不到
 * builtin baseUrl → 额度 chip 判 unsupported。resolveHostQuotaPaths 与宿主 bootstrap
 * 同源：读 <home>/.zcode/v2/setting.json 的 dataBaseDir，builtin 回落打包副本。 ---------- */
function hostPathsSnippet() {
  const source = fs.readFileSync(path.join(__dirname, "../inject-main.cjs"), "utf8");
  const start = source.indexOf("/* ---------- v229 宿主路径解析");
  assert.ok(start > 0, "v229 宿主路径解析段存在");
  return source.slice(start, source.indexOf("\n/* ---------- v96 额度客户端", start));
}
function runHostPaths({ home, resources, env = {} }) {
  return vm.runInNewContext(hostPathsSnippet() + "\nresolveHostQuotaPaths()", {
    require() { return { resolveQuotaPaths }; },
    app: { getPath: () => home }, path, fs, LOG() {},
    process: { env, resourcesPath: resources },
  });
}

test("main bridge: quota paths follow setting.json dataBaseDir and bundled builtin templates (issue #205)", (t) => {
  const { root } = fixture(t);
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".zcode", "v2"), { recursive: true });
  fs.writeFileSync(path.join(home, ".zcode", "v2", "setting.json"), JSON.stringify({ dataBaseDir: "  D:\\迁移 数据  " }));
  const bundled = path.join(root, "resources", "config", "provider", "zcode-builtin.json");
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.writeFileSync(bundled, "{}");
  const p = runHostPaths({ home, resources: path.join(root, "resources") });
  assert.equal(p.customCfgPath, "D:\\迁移 数据\\.zcode\\v2\\provider_config.json", "win32 迁移目录按 dataBaseDir 解析");
  assert.equal(p.credsPath, "D:\\迁移 数据\\.zcode\\v2\\credentials.json");
  assert.equal(p.customCfgDir, "D:\\迁移 数据\\.zcode\\v2");
  assert.equal(p.builtinCfgPath, bundled, "builtin 回落打包副本");
});

test("main bridge: setting.json precedence over env; relative or broken dataBaseDir ignored (issue #205)", (t) => {
  const { root } = fixture(t);
  const home = path.join(root, "home");
  const settings = path.join(home, ".zcode", "v2", "setting.json");
  const resources = path.join(root, "resources");
  const bundled = path.join(resources, "config", "provider", "zcode-builtin.json");
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.writeFileSync(bundled, "{}");
  const logs = [];
  const run = (env) => vm.runInNewContext(hostPathsSnippet() + "\nresolveHostQuotaPaths()", {
    require() { return { resolveQuotaPaths }; },
    app: { getPath: () => home }, path, fs, LOG: (...a) => logs.push(a.join(" ")),
    process: { env, resourcesPath: resources },
  });
  /* 相对路径宿主侧无稳定基准，不采纳；缺 setting.json 静默回落 home，builtin 仍取打包副本。 */
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ dataBaseDir: "zcode-data" }));
  let p = run({});
  assert.equal(p.credsPath, path.join(home, ".zcode", "v2", "credentials.json"));
  assert.equal(p.builtinCfgPath, bundled);
  assert.equal(logs.length, 0);
  /* UNC 网络路径按绝对路径采纳（Windows 目录选择器可返回此形态）。 */
  fs.writeFileSync(settings, JSON.stringify({ dataBaseDir: "\\\\server\\share\\数据" }));
  p = run({});
  assert.equal(p.credsPath, "\\\\server\\share\\数据\\.zcode\\v2\\credentials.json", "UNC 前缀照常采纳");
  fs.unlinkSync(settings);
  p = run({});
  assert.equal(p.credsPath, path.join(home, ".zcode", "v2", "credentials.json"), "缺文件静默，不记诊断");
  /* 损坏 JSON 只丢该字段并留一条诊断；BOM 前缀可解析。 */
  fs.writeFileSync(settings, "\uFEFF{ broken");
  p = run({});
  assert.equal(p.credsPath, path.join(home, ".zcode", "v2", "credentials.json"));
  assert.equal(logs.length, 1, "损坏 setting.json 记一条诊断");
  fs.writeFileSync(settings, "\uFEFF" + JSON.stringify({ dataBaseDir: path.join(root, "数据 目录") }));
  p = run({});
  assert.equal(p.credsPath, path.join(root, "数据 目录", ".zcode", "v2", "credentials.json"), "BOM 前缀照常采纳");
  /* 宿主 bootstrap 优先级：setting.json > ZCODE_DATA_BASE_DIR env；env 显式指定 builtin 时让位。 */
  p = run({ ZCODE_DATA_BASE_DIR: "/env-base", ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/env/builtin.json" });
  assert.equal(p.credsPath, path.join(root, "数据 目录", ".zcode", "v2", "credentials.json"), "setting.json 优先于 env（同宿主 setDataBaseDir > env）");
  assert.equal(p.builtinCfgPath, "/env/builtin.json", "env 显式 builtin 优先于打包副本");
  fs.unlinkSync(settings);
  p = run({ ZCODE_DATA_BASE_DIR: "/env-base", ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/env/builtin.json" });
  assert.equal(p.credsPath, "/env-base/.zcode/v2/credentials.json", "无 setting.json 时 env 照常生效");
  assert.equal(p.builtinCfgPath, "/env/builtin.json");
  /* 打包副本缺失（如便携版裁剪）不得把不存在的路径当 builtin 交给监听与解析。 */
  fs.rmSync(bundled);
  p = run({});
  assert.equal(p.builtinCfgPath, "", "打包副本缺失回落空 builtinCfgPath");
});

test("main bridge: model puller shares quota path resolution incl. migrated credentials (issue #205)", () => {
  const source = fs.readFileSync(path.join(__dirname, "../inject-main.cjs"), "utf8");
  const start = source.indexOf("/* ---------- v129 模型拉取");
  const snippet = source.slice(start, source.indexOf("\n/* ---------- v339", start));   // v258：装配已提炼为 initModelPuller，eval 即执行；结束锚=紧随其后的 v339 pending 清理段（issue #298 改段号须同步）
  const paths = { credsPath: "D:\\数据 空间\\.zcode\\v2\\credentials.json",
    customCfgPath: "D:\\数据 空间\\.zcode\\v2\\provider_config.json",
    builtinCfgPath: "E:\\res\\zcode-builtin.json" };
  const opts = [];
  vm.runInNewContext(snippet, {
    require(id) {
      if (id === "./model-puller.cjs") return { createModelPuller: (o) => { opts.push(o); return {}; } };
      if (id === "./quota-client.cjs") return { decryptValue: () => null, deriveCipherKey: () => null };
      throw new Error(id);
    },
    resolveHostQuotaPaths: () => paths, LOG() {},
    path: require("path"), __dirname: "/runtime",   // #236：cachePath 用 path.join(__dirname, …)
  });
  assert.equal(opts.length, 1);
  assert.equal(opts[0].customCfgPath, paths.customCfgPath);
  assert.equal(opts[0].credentialsPath, paths.credsPath, "credentials 不再硬编码 ~/.zcode/v2 死目录");
  assert.equal(opts[0].cachePath, require("path").join("/runtime", "model-efforts-cache.json"), "档位索引缓存落运行目录（#236）");
});


test("configuration update: same provider recovers when its missing base/key is completed", (t) => {
  const { root, write, read } = fixture(t);
  const personal = write(path.join(root, "personal.json"), doc(rule("minimax", "")));
  const calls = [];
  const client = createQuotaClient({ env: {}, customCfgPath: personal, builtinCfgPath: "", credsPath: path.join(root, "creds.json"),
    secretsPath: path.join(root, "secrets.json"), readFile: read,
    fetchImpl(url) { calls.push(url); return Promise.resolve({ status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ base_resp: { status_code: 0 }, model_remains: [{ model_name: "general", current_interval_remaining_percent: 80 }] }) }); } });
  t.after(() => client.dispose());
  client.noteProvider("minimax"); client.tick();
  assert.equal(calls.length, 0);
  write(personal, doc(rule("minimax", "new-fixture-key")));
  client.credentialsChanged(); client.tick();
  assert.equal(client.view().active, "minimax:minimax");   // 统一调度器：provider 持复合账户源（vendor:providerId）
  assert.equal(calls[0], "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains");
});
