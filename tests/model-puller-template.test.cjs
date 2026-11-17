const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const M = require(path.join(__dirname, "..", "model-puller.cjs"));

/* 模板创建的供应商（宿主 zcode-builtin.json templateRules）：个人 provider_config
 * 只存 templateId + apiKey，baseUrl/protocol 在打包模板里。issue #123 已让额度链
 * 合并模板；增强链也必须合并，否则「跟随当前会话」增强报 no base url。 */

const MODELS_DEV_TEST_URL = "https://models.dev.test/json";
const TEMPLATE_BASE = "https://opencode.ai/zen/go/v1";

function writeTemplate(file, api, extra) {
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        templateRules: [Object.assign({
          templateId: "opencode-go-chat",
          config: { access: { type: "api-key", apiKeyManagementUrl: "https://opencode.ai/auth" }, api: api },
        }, extra || {})],
      },
    },
  }));
}

function makeFixture(t, overrides) {
  const o = overrides || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-tpl-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const providerCfg = path.join(dir, "provider_config.json");
  const builtinCfg = path.join(dir, "zcode-builtin.json");
  const providerCfgShape = {
    access: Object.assign({ type: "api-key", apiKey: "sk-oc" }, o.access || {}),
    modelOrder: ["deepseek-v4.1-flash"],
  };
  // noApi：issue #383 真实形状——模板供应商个人规则只有 templateId + access，连 api 对象都没有
  if (!o.noApi) providerCfgShape.api = Object.assign({ type: "openai-chat-completions" }, o.api || {});
  const providerRule = {
    providerId: o.providerId || "opencode-go-chat",
    templateId: Object.prototype.hasOwnProperty.call(o, "templateId") ? o.templateId : "opencode-go-chat",
    providerName: "OpenCode Go (Chat)",
    config: providerCfgShape,
  };
  const personal = { config: { providerConfigRules: { providerRules: [providerRule] } } };
  if (o.personalTemplateApi) {
    personal.config.providerConfigRules.templateRules = [{
      templateId: "opencode-go-chat",
      config: { api: o.personalTemplateApi },
    }];
  }
  fs.writeFileSync(providerCfg, JSON.stringify(personal));
  writeTemplate(builtinCfg, Object.assign({ type: "openai-chat-completions", baseUrl: TEMPLATE_BASE }, o.templateApi || {}));
  return { dir, providerCfg, builtinCfg, providerRule };
}

function makeFetch(calls) {
  return async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    calls.push({ url, opts: requestOpts, body: requestOpts && requestOpts.body ? JSON.parse(requestOpts.body) : null });
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "增强结果" } }], model: "deepseek-v4.1-flash" }) };
  };
}

function create(f, opts) {
  return M.createModelPuller({
    customCfgPath: f.providerCfg,
    builtinCfgPath: f.builtinCfg,
    fetchImpl: makeFetch([]),
    modelsDevUrl: MODELS_DEV_TEST_URL,
    modelsDevApiUrl: "",
    ...opts,
  });
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("template-created provider: enhancement resolves baseUrl/protocol from bundled templateRules", async (t) => {
  const f = makeFixture(t);
  const calls = [];
  const mp = create(f, { fetchImpl: makeFetch(calls) });

  const host = mp.resolveEnhanceHost("opencode-go-chat");
  assert.equal(host.baseUrl, TEMPLATE_BASE);
  assert.equal(host.protocol, "openai-chat-completions");
  assert.equal(host.apiKey, "sk-oc");
  assert.deepEqual(mp.listEnhanceHosts().map((h) => h.id), ["opencode-go-chat"]);

  const r = await mp.enhanceText("opencode-go-chat", "deepseek-v4.1-flash", "写个脚本");
  assert.equal(r.ok, true);
  assert.equal(r.text, "增强结果");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TEMPLATE_BASE + "/chat/completions");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer sk-oc");
  assert.match(calls[0].opts.headers["x-opencode-session"], UUID_V4_RE);   // OpenCode Go 路由键：v4 形状
  assert.equal(calls[0].body.model, "deepseek-v4.1-flash");

  // 每请求新路由键：固定 UUID（哪怕合法 v4）不能复用
  const r2 = await mp.enhanceText("opencode-go-chat", "deepseek-v4.1-flash", "再写一个");
  assert.equal(r2.ok, true);
  assert.match(calls[1].opts.headers["x-opencode-session"], UUID_V4_RE);
  assert.notEqual(calls[1].opts.headers["x-opencode-session"], calls[0].opts.headers["x-opencode-session"]);
});

test("template merge precedence: explicit baseUrl wins, empty baseUrl falls back, explicit protocol wins", async (t) => {
  const calls = [];
  const explicitBase = makeFixture(t, { api: { baseUrl: "https://relay.example.com" } });
  const mp1 = create(explicitBase, { fetchImpl: makeFetch(calls) });
  assert.equal((await mp1.enhanceText("opencode-go-chat", "deepseek-v4.1-flash", "写个脚本")).ok, true);
  assert.equal(calls[0].url, "https://relay.example.com/chat/completions");
  assert.equal(calls[0].opts.headers["x-opencode-session"], undefined);   // 非 OpenCode Go 不附带路由键

  calls.length = 0;
  const emptyBase = makeFixture(t, {
    api: { type: "openai-chat-completions", baseUrl: "" },
    templateApi: { type: "anthropic-messages", baseUrl: TEMPLATE_BASE },   // 显式协议必须压过模板协议
  });
  const mp2 = create(emptyBase, { fetchImpl: makeFetch(calls) });
  const host = mp2.resolveEnhanceHost("opencode-go-chat");
  assert.equal(host.baseUrl, TEMPLATE_BASE);
  assert.equal(host.protocol, "openai-chat-completions");
  assert.equal((await mp2.enhanceText("opencode-go-chat", "deepseek-v4.1-flash", "写个脚本")).ok, true);
  assert.equal(calls[0].url, TEMPLATE_BASE + "/chat/completions");
});

test("template lookup requires explicit templateId; matching providerId alone must not inherit the template", async (t) => {
  const f = makeFixture(t, { templateId: null });
  const calls = [];
  const mp = create(f, { fetchImpl: makeFetch(calls) });
  assert.equal(mp.resolveEnhanceHost("opencode-go-chat"), null);
  const r = await mp.enhanceText("opencode-go-chat", "deepseek-v4.1-flash", "写个脚本");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "provider");
  assert.equal(r.error, "no base url");
  assert.equal(calls.length, 0);
});

test("missing or malformed template source stays fail-closed with zero network", async (t) => {
  const f = makeFixture(t);
  fs.writeFileSync(f.builtinCfg, "{broken");
  const calls = [];
  const mp = create(f, { fetchImpl: makeFetch(calls) });
  assert.equal(mp.resolveEnhanceHost("opencode-go-chat"), null);
  const r = await mp.enhanceText("opencode-go-chat", "deepseek-v4.1-flash", "写个脚本");
  assert.equal(r.ok, false);
  assert.equal(r.error, "no base url");
  assert.equal(calls.length, 0);
});

test("personal templateRules override the bundled template (same order as quota-client)", (t) => {
  const f = makeFixture(t, { personalTemplateApi: { type: "openai-chat-completions", baseUrl: "https://relay.example.com" } });
  const mp = create(f);
  assert.equal(mp.resolveEnhanceHost("opencode-go-chat").baseUrl, "https://relay.example.com");
});

test("deleting and recreating the template between calls with the same mtime/size does not revive a stale cache", (t) => {
  const f = makeFixture(t);
  const fixed = 1700000000;   // 整秒：重建后 mtimeMs 可与原文件逐位相同，专测 ctime/birthtime 双保险（Linux 老内核 birthtime 可能恒 0，ctime 兜底）
  fs.utimesSync(f.builtinCfg, fixed, fixed);
  const mp = create(f);
  assert.equal(mp.resolveEnhanceHost("opencode-go-chat").baseUrl, TEMPLATE_BASE);
  const before = fs.statSync(f.builtinCfg);

  const replaced = TEMPLATE_BASE.replace("/go/", "/GO/");
  assert.equal(replaced.length, TEMPLATE_BASE.length);
  fs.unlinkSync(f.builtinCfg);   // 两次调用之间删除重建：不能依赖中间一次 stat 失败来清缓存
  writeTemplate(f.builtinCfg, { type: "openai-chat-completions", baseUrl: replaced });
  fs.utimesSync(f.builtinCfg, fixed, fixed);
  const after = fs.statSync(f.builtinCfg);

  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(mp.resolveEnhanceHost("opencode-go-chat").baseUrl, replaced);
});

test("corrupt template source recovers after repair with the same size and mtime", (t) => {
  const f = makeFixture(t);
  const fixed = 1700000001;
  const valid = fs.readFileSync(f.builtinCfg);
  const corrupt = Buffer.concat([Buffer.from("{broken"), Buffer.alloc(valid.length - 7, 0x20)]);
  assert.equal(corrupt.length, valid.length);
  fs.writeFileSync(f.builtinCfg, corrupt);
  fs.utimesSync(f.builtinCfg, fixed, fixed);
  const mp = create(f);
  assert.equal(mp.resolveEnhanceHost("opencode-go-chat"), null);   // 损坏先 fail-closed
  fs.writeFileSync(f.builtinCfg, valid);
  fs.utimesSync(f.builtinCfg, fixed, fixed);
  assert.equal(mp.resolveEnhanceHost("opencode-go-chat").baseUrl, TEMPLATE_BASE);   // 修复后恢复
});

test("direct enhanceProvider (enhance-custom) bypasses rules and templates entirely", async (t) => {
  // 生产路径 inject-main prompt-enhance-v2：自定义供应商增强恒以 enhance-custom + opts.enhanceProvider
  // 直连，不走 providerRules/templateRules；同名干扰规则与模板在场也不得影响目的地与凭据。
  const f = makeFixture(t, { providerId: "enhance-custom", api: { baseUrl: "https://wrong-rule.example.com" } });
  const calls = [];
  const mp = create(f, { fetchImpl: makeFetch(calls) });
  const r = await mp.enhanceText("enhance-custom", "m1", "写个脚本", {
    enhanceProvider: { apiKey: "sk-direct", protocol: "openai-chat-completions", baseUrl: "https://direct.example.com/v1" },
  });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://direct.example.com/v1/chat/completions");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer sk-direct");
  assert.equal(calls[0].opts.headers["x-opencode-session"], undefined);
});

test("OpenCode Go route-key boundary: exact host+path only, lookalike domains and paths get no header", async (t) => {
  const cases = [
    ["https://opencode.ai/zen/go/v1", true],
    ["https://api.opencode.ai/zen/go/v1/", true],   // 子域 + 尾斜杠 + 大小写不敏感
    ["https://OPENCODE.AI/zen/go/v1", true],
    ["https://opencode.ai/zen", false],
    ["https://opencode.ai/zen/go/v1/extra", false],
    ["https://evilopencode.ai/zen/go/v1", false],
    ["https://opencode.ai.evil.test/zen/go/v1", false],
  ];
  for (const [base, expectHeader] of cases) {
    const f = makeFixture(t, { api: { baseUrl: base } });
    const calls = [];
    const mp = create(f, { fetchImpl: makeFetch(calls) });
    const r = await mp.enhanceText("opencode-go-chat", "m1", "草稿");
    assert.equal(r.ok, true, base);
    assert.equal(calls[0].url, base.replace(/\/+$/, "") + "/chat/completions", base);
    if (expectHeader) assert.match(calls[0].opts.headers["x-opencode-session"], UUID_V4_RE, base);
    else assert.equal(calls[0].opts.headers["x-opencode-session"], undefined, base);
  }
});

test("corrupt bundled template keeps personal templateRules readable (partial-read preservation)", (t) => {
  // readTemplateRules 的 failed 分支：单文件损坏只跳过该文件、保留已读到的模板且不缓存。
  const f = makeFixture(t, { personalTemplateApi: { type: "openai-chat-completions", baseUrl: "https://personal-relay.example.com" } });
  fs.writeFileSync(f.builtinCfg, "{broken");
  const mp = create(f);
  assert.equal(mp.resolveEnhanceHost("opencode-go-chat").baseUrl, "https://personal-relay.example.com");
});

test("template access backfills omitted personal access.type (mirror of quota #123)", (t) => {
  const f = makeFixture(t);
  // 个人 access 只有 apiKey、无 type：模板 access.type=api-key 必须回填，否则增强被 access 门拒绝
  const personal = JSON.parse(fs.readFileSync(f.providerCfg, "utf8"));
  personal.config.providerConfigRules.providerRules[0].config.access = { apiKey: "sk-oc" };
  fs.writeFileSync(f.providerCfg, JSON.stringify(personal));
  const mp = create(f);
  const host = mp.resolveEnhanceHost("opencode-go-chat");
  assert.ok(host);
  assert.equal(host.baseUrl, TEMPLATE_BASE);
  assert.equal(host.apiKey, "sk-oc");
});

test("numeric templateId is normalized to string on both rule and template sides", (t) => {
  const f = makeFixture(t, { templateId: 123 });
  const tpl = JSON.parse(fs.readFileSync(f.builtinCfg, "utf8"));
  tpl.config.providerConfigRules.templateRules[0].templateId = 123;
  fs.writeFileSync(f.builtinCfg, JSON.stringify(tpl));
  const mp = create(f);
  assert.equal(mp.resolveEnhanceHost("opencode-go-chat").baseUrl, TEMPLATE_BASE);
});

test("builtinCfgPath defaults to process.resourcesPath; explicit ZCODE_BUILTIN_PROVIDER_CONFIG_FILE yields", (t) => {
  const f = makeFixture(t);
  // 热更窗口：旧冷 loader 不传 builtinCfgPath，由 Electron resourcesPath 推导打包模板
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-tpl-res-"));
  const bundled = path.join(resources, "config", "provider", "zcode-builtin.json");
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.copyFileSync(f.builtinCfg, bundled);
  Object.defineProperty(process, "resourcesPath", { value: resources, configurable: true, writable: true });
  const savedEnv = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  // 全局态恢复放 finally：任一清理步骤抛异常也不把 resourcesPath/env 泄漏给后续用例
  t.after(() => {
    try { fs.rmSync(resources, { recursive: true, force: true }); }
    finally {
      delete process.resourcesPath;
      if (savedEnv === undefined) delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
      else process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = savedEnv;
    }
  });
  const mp = M.createModelPuller({ customCfgPath: f.providerCfg, fetchImpl: makeFetch([]), modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "" });
  assert.equal(mp.resolveEnhanceHost("opencode-go-chat").baseUrl, TEMPLATE_BASE);
  // 宿主显式指定 builtin 文件时兜底让位（与 resolveHostQuotaPaths 同语义）：不猜打包副本
  process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = path.join(f.dir, "nonexistent-builtin.json");
  const mp2 = M.createModelPuller({ customCfgPath: f.providerCfg, fetchImpl: makeFetch([]), modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "" });
  assert.equal(mp2.resolveEnhanceHost("opencode-go-chat"), null);
});

test("applyModels never persists template-merged fields into the personal rule (read-only merge contract)", async (t) => {
  // 写回隔离守卫：模板合并只参与增强读取；applyModels 成功后个人 access/api 必须逐字不变，
  // 不得混入模板的 apiKeyManagementUrl/baseUrl 等字段（H4 变异 killer）。
  const f = makeFixture(t, { api: { baseUrl: "https://my-relay.example.com/v1" } });
  const before = JSON.parse(fs.readFileSync(f.providerCfg, "utf8")).config.providerConfigRules.providerRules[0];
  const accessBefore = JSON.parse(JSON.stringify(before.config.access));
  const apiBefore = JSON.parse(JSON.stringify(before.config.api));
  const builtinBefore = fs.readFileSync(f.builtinCfg, "utf8");
  const mp = create(f);
  const r = await mp.applyModels("opencode-go-chat", ["new-model-x"]);
  assert.equal(r.ok, true);
  assert.equal(r.added, 1);
  const after = JSON.parse(fs.readFileSync(f.providerCfg, "utf8")).config.providerConfigRules.providerRules[0];
  assert.deepEqual(after.config.access, accessBefore, "access must not gain template fields");
  assert.deepEqual(after.config.api, apiBefore, "api must keep the personal baseUrl verbatim");
  assert.ok(after.config.personalModelIds.includes("new-model-x"));
  // builtin 模板文件字节不变（只读承诺）
  assert.equal(fs.readFileSync(f.builtinCfg, "utf8"), builtinBefore);
});

test("template provider joins the pull chain: listProviders/fetchModels resolve merged config", async (t) => {
  // issue #383：拉取主链曾只读原始 rule.config，模板供应商被 isPullable 全部拒绝 → providers: []
  const f = makeFixture(t);
  const calls = [];
  const fetchImpl = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    calls.push({ url, opts: requestOpts });
    return { ok: true, status: 200, json: async () => ({ data: [{ id: "m-2" }, { id: "m-1" }] }) };   // 无 body reader 时 readJsonBounded 走 res.json()
  };
  const mp = create(f, { fetchImpl });
  const listed = mp.listProviders();
  assert.equal(listed.ok, true);
  const view = listed.providers.find((p) => p.id === "opencode-go-chat");
  assert.ok(view, "template provider must be listed");
  assert.equal(view.baseUrl, TEMPLATE_BASE);
  assert.equal(view.hasKey, true);

  const r = await mp.fetchModels("opencode-go-chat");
  assert.equal(r.ok, true);
  assert.equal(r.via, TEMPLATE_BASE + "/models");   // base 以 /v1 结尾：首候选 {base}/models
  assert.deepEqual(r.models, ["m-1", "m-2"]);
  assert.equal(calls[0].opts.headers["User-Agent"], "ZCode");
});

test("probeModel mirrors host runtime: template provider probes the template endpoint with host headers", async (t) => {
  // 口径更新（issue #383）：宿主真实请求本就使用模板 baseUrl，probe 镜像宿主才是正确口径；
  // 旧「probeModel keeps raw rule.config semantics」锁定的窄口径随拉取链合并一并废止。
  const f = makeFixture(t);
  const calls = [];
  const mp = create(f, { fetchImpl: makeFetch(calls) });
  const r = await mp.probeModel("opencode-go-chat", "deepseek-v4.1-flash");
  assert.equal(r.ok, true);
  assert.ok(calls.length >= 1);
  assert.equal(calls[0].url, TEMPLATE_BASE + "/chat/completions");
  assert.equal(calls[0].opts.headers["User-Agent"], "ZCode");
  assert.match(calls[0].opts.headers["x-opencode-session"], UUID_V4_RE);   // OpenCode Go 路由键，与增强链同款
  // 每请求新路由键（镜像增强链「固定 UUID 不能复用」口径）：连探两次，键互不相等
  const r2 = await mp.probeModel("opencode-go-chat", "deepseek-v4.1-flash");
  assert.equal(r2.ok, true);
  const keys = calls.map((c) => c.opts.headers["x-opencode-session"]).filter(Boolean);
  assert.ok(keys.length >= 2);
  assert.equal(new Set(keys).size, keys.length);
});

test("disabled provider (enabled:false at rule or config level) is not pullable (mirror enhance gate)", async (t) => {
  const f = makeFixture(t);
  const mp = create(f);
  const raw = JSON.parse(fs.readFileSync(f.providerCfg, "utf8"));
  // config 级 enabled 是宿主 strict schema 不产出的形状（enabled 只在 rule 层），只能来自手改文件；
  // 插件按 modelPullerRuleAllowed 既有语义防御性拒绝（增强链同款），与 rule 级一并锁定
  raw.config.providerConfigRules.providerRules[0].config.enabled = false;
  fs.writeFileSync(f.providerCfg, JSON.stringify(raw));
  assert.equal(mp.listProviders().providers.length, 0);
  assert.equal((await mp.fetchModels("opencode-go-chat")).error, "provider not found");
  assert.equal((await mp.probeModel("opencode-go-chat", "m1")).kind, "provider");
  // rule 级 enabled:false 同判
  const raw2 = JSON.parse(fs.readFileSync(f.providerCfg, "utf8"));
  delete raw2.config.providerConfigRules.providerRules[0].config.enabled;
  raw2.config.providerConfigRules.providerRules[0].enabled = false;
  fs.writeFileSync(f.providerCfg, JSON.stringify(raw2));
  assert.equal(mp.listProviders().providers.length, 0);
});

test("pull cache survives a path repair in the same session (meta lands via applyModels)", async (t) => {
  // 拉取 → 探测触发路径修复（source 迁移）→ 应用：缓存身份随修复同步迁移，metaById 不被守卫丢弃
  const bare = "https://relay.example.com";
  const f = makeFixture(t, { noApi: true, templateApi: { type: "openai-chat-completions", baseUrl: bare } });
  const raw = JSON.parse(fs.readFileSync(f.providerCfg, "utf8"));
  raw.config.modelConfigRules = { providerModelRules: [], manualProviderModelRules: [] };
  fs.writeFileSync(f.providerCfg, JSON.stringify(raw));
  const fetchImpl = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    if (url === bare + "/chat/completions") return { ok: false, status: 404, body: { cancel() { } }, text: async () => "not found" };
    if (url.endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [{ id: "m1", context_length: 4096 }] }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "增强结果" } }] }) };
  };
  const mp = create(f, { fetchImpl });
  assert.equal((await mp.fetchModels("opencode-go-chat")).ok, true);   // 候选 bare+"/v1/models" 命中
  assert.equal((await mp.probeModel("opencode-go-chat", "m1")).ok, true);   // 探测 404 → 修复写回 bare+"/v1"
  const r = await mp.applyModels("opencode-go-chat", ["m1"]);
  assert.equal(r.ok, true);
  const after = JSON.parse(fs.readFileSync(f.providerCfg, "utf8"));
  const rule = after.config.modelConfigRules.providerModelRules.find((x) => x.modelId === "m1");
  assert.ok(rule, "model rule written");
  assert.equal(rule.config.properties.contextWindow, 4096);   // 缓存迁移：修复后 meta 仍随 applyModels 落盘
});

test("repair write-back failure is logged, not swallowed silently", async (t) => {
  const bare = "https://relay.example.com";
  const f = makeFixture(t, { noApi: true, templateApi: { type: "openai-chat-completions", baseUrl: bare } });
  const logs = [];
  const fetchImpl = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    if (url === bare + "/chat/completions") return { ok: false, status: 404, body: { cancel() { } }, text: async () => "not found" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "增强结果" } }] }) };
  };
  const mp = create(f, { fetchImpl, log: (...args) => logs.push(args.map(String).join(" ")) });
  const origWrite = fs.writeFileSync;   // 临时注入写失败（跨平台稳于 chmod）：修复候选已命中、写回必抛
  fs.writeFileSync = () => { throw new Error("injected write failure"); };
  let r;
  try { r = await mp.probeModel("opencode-go-chat", "m1"); }
  finally { fs.writeFileSync = origWrite; }
  assert.equal(r.ok, false);
  assert.equal(r.repaired, undefined);
  assert.ok(logs.some((line) => line.includes("probe repair write-back failed")), JSON.stringify(logs));
});

test("template change mid-probe aborts the in-flight probe (source identity follows merged config)", async (t) => {
  const f = makeFixture(t);
  const calls = [];
  const fetchImpl = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    calls.push({ url });
    writeTemplate(f.builtinCfg, { type: "openai-chat-completions", baseUrl: "https://moved.example.com/v1" });   // 在途请求期间模板换端点
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "增强结果" } }] }) };
  };
  const mp = create(f, { fetchImpl });
  const r = await mp.probeModel("opencode-go-chat", "deepseek-v4.1-flash");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "provider");
  assert.equal(r.error, "provider changed");
});

test("path repair writes back into the personal rule of a template provider (sparse api, baseUrl only)", async (t) => {
  // 模板 baseUrl 少 /v1 → 探测 404 → 邻域候选命中 → 个人规则无 api 对象时补建、只写 baseUrl；
  // api.type 仍由模板承载不代写，其余个人字段与模板文件字节原样（显式配置覆盖模板）。
  const bare = "https://relay.example.com";
  const f = makeFixture(t, { noApi: true, templateApi: { type: "openai-chat-completions", baseUrl: bare } });
  const calls = [];
  const fetchImpl = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    calls.push({ url });
    if (url === bare + "/chat/completions") return { ok: false, status: 404, body: { cancel() { } }, text: async () => "not found" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "增强结果" } }] }) };
  };
  const mp = create(f, { fetchImpl });
  const r = await mp.probeModel("opencode-go-chat", "m1");
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired, { from: bare, to: bare + "/v1" });
  const after = JSON.parse(fs.readFileSync(f.providerCfg, "utf8")).config.providerConfigRules.providerRules[0];
  assert.equal(after.config.api.baseUrl, bare + "/v1");
  assert.equal(after.config.api.type, undefined);   // api.type 不代写，仍由模板承载
  assert.equal(after.config.access.apiKey, "sk-oc");
  assert.equal(fs.readFileSync(f.builtinCfg, "utf8").includes(bare), true);   // 模板文件只读契约
});
