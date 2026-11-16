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

function makeFixture(overrides) {
  const o = overrides || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-tpl-"));
  const providerCfg = path.join(dir, "provider_config.json");
  const builtinCfg = path.join(dir, "zcode-builtin.json");
  const providerRule = {
    providerId: o.providerId || "opencode-go-chat",
    templateId: Object.prototype.hasOwnProperty.call(o, "templateId") ? o.templateId : "opencode-go-chat",
    providerName: "OpenCode Go (Chat)",
    config: {
      access: Object.assign({ type: "api-key", apiKey: "sk-oc" }, o.access || {}),
      api: Object.assign({ type: "openai-chat-completions" }, o.api || {}),
      modelOrder: ["deepseek-v4.1-flash"],
    },
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

test("template-created provider: enhancement resolves baseUrl/protocol from bundled templateRules", async () => {
  const f = makeFixture();
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
  assert.match(calls[0].opts.headers["x-opencode-session"], /^[0-9a-f-]{36}$/);   // OpenCode Go 路由键
  assert.equal(calls[0].body.model, "deepseek-v4.1-flash");
});

test("template merge precedence: explicit baseUrl wins, empty baseUrl falls back, explicit protocol wins", async () => {
  const calls = [];
  const explicitBase = makeFixture({ api: { baseUrl: "https://relay.example.com" } });
  const mp1 = create(explicitBase, { fetchImpl: makeFetch(calls) });
  assert.equal((await mp1.enhanceText("opencode-go-chat", "deepseek-v4.1-flash", "写个脚本")).ok, true);
  assert.equal(calls[0].url, "https://relay.example.com/chat/completions");
  assert.equal(calls[0].opts.headers["x-opencode-session"], undefined);   // 非 OpenCode Go 不附带路由键

  calls.length = 0;
  const emptyBase = makeFixture({
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

test("template lookup requires explicit templateId; matching providerId alone must not inherit the template", async () => {
  const f = makeFixture({ templateId: null });
  const calls = [];
  const mp = create(f, { fetchImpl: makeFetch(calls) });
  assert.equal(mp.resolveEnhanceHost("opencode-go-chat"), null);
  const r = await mp.enhanceText("opencode-go-chat", "deepseek-v4.1-flash", "写个脚本");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "provider");
  assert.equal(r.error, "no base url");
  assert.equal(calls.length, 0);
});

test("missing or malformed template source stays fail-closed with zero network", async () => {
  const f = makeFixture();
  fs.writeFileSync(f.builtinCfg, "{broken");
  const calls = [];
  const mp = create(f, { fetchImpl: makeFetch(calls) });
  assert.equal(mp.resolveEnhanceHost("opencode-go-chat"), null);
  const r = await mp.enhanceText("opencode-go-chat", "deepseek-v4.1-flash", "写个脚本");
  assert.equal(r.ok, false);
  assert.equal(r.error, "no base url");
  assert.equal(calls.length, 0);
});

test("personal templateRules override the bundled template (same order as quota-client)", () => {
  const f = makeFixture({ personalTemplateApi: { type: "openai-chat-completions", baseUrl: "https://relay.example.com" } });
  const mp = create(f);
  assert.equal(mp.resolveEnhanceHost("opencode-go-chat").baseUrl, "https://relay.example.com");
});

test("deleting and recreating the template between calls with the same mtime/size does not revive a stale cache", () => {
  const f = makeFixture();
  const fixed = 1700000000;   // 整秒：重建后 mtimeMs 可与原文件逐位相同，专测 ctime/birthtime 变化
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

test("corrupt template source recovers after repair with the same size and mtime", () => {
  const f = makeFixture();
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
