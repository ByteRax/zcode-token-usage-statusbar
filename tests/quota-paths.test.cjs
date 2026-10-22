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
  assert.equal(client.view().active, "minimax");
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
    const start = source.indexOf('  const { createQuotaClient, resolveQuotaPaths }');
    const snippet = source.slice(start, source.indexOf('\n} catch (e) {', start));
    const callbacks = new Map(), events = [];
    const paths = { credsPath: file, credsDir: dir, customCfgPath: file, customCfgDir: dir,
      builtinCfgPath: file, builtinCfgDir: dir };
    vm.runInNewContext(snippet, {
      require() { return { resolveQuotaPaths: () => paths, createQuotaClient() { return {
        credentialsChanged() { events.push("changed"); }, tick() { events.push("tick"); },
      }; } }; },
      app: { getPath: () => "/fixture-home" }, HERE: "/fixture-runtime", path, quotaClient: null,
      fs: { watch(d, cb) { callbacks.set(d, cb); return { on() {} }; } }, LOG() {},
      quotaEnabled: () => true, setInterval() {}, setTimeout(cb) { cb(); return 1; }, clearTimeout() {}, Set, Map,
    });
    assert.equal(callbacks.size, 1, "shared directory only needs one watcher");
    const callback = callbacks.get(dir);
    callback("rename", "unrelated.json");
    assert.deepEqual(events, []);
    callback("rename", "个人 配置.json");
    assert.deepEqual(events, ["changed", "tick"]);
    callback("change", Buffer.from("个人 配置.json"));
    assert.deepEqual(events, ["changed", "tick", "changed", "tick"]);
  });
}

test("main bridge: initialized paths and directory watchers use shared resolution; runtime secrets stay HERE", () => {
  const source = fs.readFileSync(path.join(__dirname, "../inject-main.cjs"), "utf8");
  const start = source.indexOf('  const { createQuotaClient, resolveQuotaPaths }');
  const end = source.indexOf('\n} catch (e) {', start);
  const snippet = source.slice(start, end);
  const dirs = [], clients = [];
  const paths = { credsPath: "D:\\数据 空间\\credentials.json", credsDir: "D:\\数据 空间",
    customCfgPath: "E:\\个人\\personal.json", customCfgDir: "E:\\个人",
    builtinCfgPath: "F:\\内置\\builtin.json", builtinCfgDir: "F:\\内置" };
  vm.runInNewContext(snippet, {
    require() { return { resolveQuotaPaths: () => paths, createQuotaClient(o) { clients.push(o); return {}; } }; },
    app: { getPath: () => "/fixture-home" }, HERE: "/fixture-runtime", path, quotaClient: null,
    fs: { watch(dir) { dirs.push(dir); return { on() {} }; } }, LOG() {},
    setInterval() {}, setTimeout() {}, clearTimeout() {}, Set, Map,
  });
  assert.deepEqual(dirs, [paths.credsDir, paths.customCfgDir, paths.builtinCfgDir]);
  assert.equal(clients[0].credsPath, paths.credsPath);
  assert.equal(clients[0].customCfgPath, paths.customCfgPath);
  assert.equal(clients[0].secretsPath, "/fixture-runtime/quota-secrets.json");
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
  assert.equal(client.view().active, "minimax");
  assert.equal(calls[0], "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains");
});
