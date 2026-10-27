const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const M = require(path.join(__dirname, "..", "model-puller.cjs"));

const MODELS_DEV_TEST_URL = "https://models.dev.test/json";

function tmpCfgPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zusage-mp-")), "provider_config.json");
}

function writeCfg(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function sampleCfg() {
  return {
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "custom-relay",
            providerName: "我的中转",
            config: {
              access: { type: "api-key", apiKey: "sk-secret-1" },
              api: { baseUrl: "https://relay.example.com" },
              personalModelIds: ["gpt-4o"],
              modelOrder: ["gpt-4o", "glm-4.6"],
            },
          },
          {
            providerId: "plan-provider",
            providerName: "套餐型（不可拉取）",
            config: { access: { type: "coding-plan-api-key" }, api: { baseUrl: "https://bigmodel.cn" } },
          },
          {
            providerId: "no-base",
            providerName: "无 baseUrl",
            config: { access: { type: "api-key", apiKey: "sk-x" }, api: {} },
          },
        ],
      },
      modelConfigRules: {
        manualProviderModelRules: [],
        providerModelRules: [
          { modelId: "gpt-4o", providerId: "custom-relay", config: { enabled: true, properties: { contextWindow: 128000 } } },
        ],
      },
      someFutureKey: { keep: true },
    },
  };
}

function createPuller(file, routes) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const hit = routes.find((r) => r.url === url);
    if (!hit) throw new Error("unexpected url " + url);
    if (hit.status && hit.status !== 200) return { ok: false, status: hit.status };
    return { ok: true, status: 200, json: async () => hit.body };
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL });
  return { mp, calls };
}
const providerCalls = (calls) => calls.filter((c) => c.url.indexOf("models.dev.test") < 0);

/* ---------- 纯函数 ---------- */
test("non-ok response bodies are cancelled (undici connection hygiene)", async () => {
  const file = tmpCfgPath();
  writeCfg(file, sampleCfg());
  let cancelled = 0;
  const impl = async (url) => {
    if (url === MODELS_DEV_TEST_URL) {
      return { ok: false, status: 500, body: { cancel: () => { cancelled++; } } };
    }
    if (url === "https://relay.example.com/v1/models") {
      return { ok: false, status: 404, body: { cancel: () => { cancelled++; } } };
    }
    return { ok: true, status: 200, json: async () => ["m1"], body: null };
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL });
  const r = await mp.fetchModels("custom-relay");
  assert.equal(r.ok, true);
  assert.equal(cancelled, 2);   // 目录 500 + 候选 404 两条非 ok 响应都被显式取消
});

test("slow catalog does not block the popup: grace window caps the wait", async () => {
  const file = tmpCfgPath();
  writeCfg(file, sampleCfg());
  let settled = false;
  const impl = async (url) => {
    if (url === MODELS_DEV_TEST_URL) {
      return new Promise((resolve) => setTimeout(() => { settled = true; resolve({ ok: true, status: 200, json: async () => ({}) }); }, 5000));
    }
    return { ok: true, status: 200, json: async () => ["fast-model"], body: null };
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL });
  const started = Date.now();
  const r = await mp.fetchModels("custom-relay");
  const elapsed = Date.now() - started;
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ["fast-model"]);
  assert.ok(elapsed < 3000, "should not wait for the slow catalog, took " + elapsed + "ms");   // 宽限 1s 封顶，不等 5s 目录
  assert.equal(r.metaById["fast-model"], undefined);   // 目录未到：无元数据降级
  assert.equal(settled, false);
});

test("catalog failure is cached briefly: retry within TTL skips the network wait", async () => {
  const file = tmpCfgPath();
  writeCfg(file, sampleCfg());
  let devCalls = 0;
  const impl = async (url) => {
    if (url === MODELS_DEV_TEST_URL) { devCalls++; return { ok: false, status: 503, body: null }; }
    return { ok: true, status: 200, json: async () => ["m1"], body: null };
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL });
  await mp.fetchModels("custom-relay");
  const r2 = await mp.fetchModels("custom-relay");
  assert.equal(r2.ok, true);
  assert.equal(devCalls, 1);   // 第二次拉取不再等目录超时（失败缓存生效）
});

test("candidateUrls: v{N} segments, plain base, compat-suffix stripping (cc-switch semantics)", () => {
  assert.deepEqual(M.candidateUrls("https://x.com/v1"), ["https://x.com/v1/models"]);   // 版本段在路径中，不再补 /v1
  assert.deepEqual(M.candidateUrls("https://x.com"), ["https://x.com/v1/models", "https://x.com/models"]);
  assert.deepEqual(M.candidateUrls("https://x.com/"), ["https://x.com/v1/models", "https://x.com/models"]);
  assert.deepEqual(M.candidateUrls("  "), []);
  // 智谱 Coding Plan：/v4 结尾 → /models 主候选 + /v1/models 兜底次候选
  assert.deepEqual(M.candidateUrls("https://open.bigmodel.cn/api/coding/paas/v4"),
    ["https://open.bigmodel.cn/api/coding/paas/v4/models", "https://open.bigmodel.cn/api/coding/paas/v4/v1/models"]);
  // Anthropic 兼容子路径剥离：追加根路径两组
  assert.deepEqual(M.candidateUrls("https://api.deepseek.com/anthropic"),
    ["https://api.deepseek.com/anthropic/v1/models", "https://api.deepseek.com/anthropic/models",
      "https://api.deepseek.com/v1/models", "https://api.deepseek.com/models"]);
  // 阿里百炼 /apps/anthropic：额外追加 compatible-mode 路径
  assert.deepEqual(M.candidateUrls("https://dashscope.aliyuncs.com/apps/anthropic"),
    ["https://dashscope.aliyuncs.com/apps/anthropic/v1/models", "https://dashscope.aliyuncs.com/apps/anthropic/models",
      "https://dashscope.aliyuncs.com/v1/models", "https://dashscope.aliyuncs.com/models",
      "https://dashscope.aliyuncs.com/compatible-mode/v1/models"]);
  assert.deepEqual(M.candidateUrls(""), []);
});

test("sanitizeModelIds: filters, dedupes, caps", () => {
  assert.deepEqual(M.sanitizeModelIds([" a ", "a", "b", 42, null, "b\nc", "x".repeat(201)]), ["a", "b"]);
  const many = Array.from({ length: 600 }, (_, i) => "m" + i);
  assert.equal(M.sanitizeModelIds(many).length, 512);
  assert.equal(M.sanitizeModelIds("not-an-array").length, 0);
});

test("parseModelsPayload: openai data / ollama models / result / bare array", () => {
  assert.deepEqual(M.parseModelsPayload({ data: [{ id: "a" }, { id: "b" }] }), [{ id: "a" }, { id: "b" }]);
  assert.deepEqual(M.parseModelsPayload({ models: [{ name: "llama3" }] }), [{ name: "llama3" }]);
  assert.deepEqual(M.parseModelsPayload({ result: ["a"] }), ["a"]);
  assert.deepEqual(M.parseModelsPayload(["a", { id: "b" }]), ["a", { id: "b" }]);
  assert.deepEqual(M.parseModelsPayload({ error: "nope" }), []);
  assert.deepEqual(M.parseModelsPayload(null), []);
});

/* ---------- 元数据提取（字段别名全集） ---------- */
test("extractModelMeta: slug alias and models/ prefix stripping (cc-switch catalog shape)", () => {
  assert.equal(M.extractModelMeta({ slug: "glm-5.3" }).id, "glm-5.3");   // 智谱 Responses {models:[{slug}]}
  assert.equal(M.extractModelMeta({ name: "models/gemini-2.0-flash" }).id, "gemini-2.0-flash");   // Gemini 风格前缀
  assert.equal(M.extractModelMeta({ id: "openai/gpt" }).id, "openai/gpt");   // id 优先且不剥前缀
});

test("extractModelMeta: id/modelId/name/model aliases, context/output aliases, top_provider", () => {
  assert.deepEqual(M.extractModelMeta(" bare-id "), { id: "bare-id", contextWindow: 0, maxOutputTokens: 0, modalities: null, vision: undefined, efforts: [] });
  const m1 = M.extractModelMeta({ modelId: "m1", contextWindow: 200000, limits: { output: 32000 } });
  assert.equal(m1.id, "m1");
  assert.equal(m1.contextWindow, 200000);
  assert.equal(m1.maxOutputTokens, 32000);
  const m2 = M.extractModelMeta({
    name: "m2", context_window: "400000", max_completion_tokens: 64000,
    top_provider: { max_completion_tokens: 8192 },
  });
  assert.equal(m2.contextWindow, 400000);
  assert.equal(m2.maxOutputTokens, 64000);   // 供应商顶层优先于 top_provider
  const m3 = M.extractModelMeta({ id: "m3", top_provider: { max_completion_tokens: 8192 } });
  assert.equal(m3.maxOutputTokens, 8192);
  assert.equal(M.extractModelMeta(42).id, "");
});

test("extractModelMeta: modalities, vision flag, efforts dedupe+cap", () => {
  const m = M.extractModelMeta({
    id: "x",
    architecture: { input_modalities: ["text", "image", "Image"], vision: true },
    supported_efforts: ["off", "high", "off", "", 42, "max"],
  });
  assert.deepEqual(m.modalities, ["text", "image"]);
  assert.equal(m.vision, true);
  assert.deepEqual(m.efforts, ["off", "high", "max"]);
  assert.equal(M.extractModelMeta({ id: "y", supports_vision: false }).vision, false);
  assert.equal(M.extractModelMeta({ id: "z", supported_efforts: Array.from({ length: 30 }, (_, i) => "e" + i) }).efforts.length, 16);
});

test("catalogEntries/matchCatalogEntry: exact, basename, ambiguity rejected", () => {
  const entries = M.catalogEntries({
    "openai/gpt-4o": { id: "gpt-4o", limit: { context: 128000, output: 16384 } },
    "vendor-a/dup": { id: "dup", context_length: 1000 },
    "vendor-b/dup": { id: "dup", context_length: 2000 },
    "google/gemini-3-pro": { id: "gemini-3-pro", architecture: { input_modalities: ["text", "image"] } },
  });
  assert.equal(M.matchCatalogEntry(entries, "gpt-4o").model.context_length, undefined);
  assert.ok(M.matchCatalogEntry(entries, "gpt-4o"));
  assert.ok(M.matchCatalogEntry(entries, "OpenAI/GPT-4O"));   // 大小写归一
  assert.ok(M.matchCatalogEntry(entries, "gemini-3-pro"));
  assert.equal(M.matchCatalogEntry(entries, "nope"), null);
  assert.equal(M.matchCatalogEntry(entries, "dup"), null);   // 双条目歧义：宁缺毋滥
  assert.equal(M.canonicalBasename("gcli/gemini-3-pro"), "gemini-3-pro");
  assert.equal(M.canonicalBasename("go-x/y"), "y");
});

test("inputFormatFrom: modalities map to sparse host bits; vision bool fallback; none → null", () => {
  assert.deepEqual(M.inputFormatFrom(["text", "image", "pdf"], undefined),
    { supportsImage: true, supportsVideo: false, supportsAudio: false, supportsPdf: true });
  assert.deepEqual(M.inputFormatFrom(["vision"], undefined),
    { supportsImage: true, supportsVideo: false, supportsAudio: false, supportsPdf: false });
  assert.deepEqual(M.inputFormatFrom(undefined, false), { supportsImage: false });
  assert.equal(M.inputFormatFrom(undefined, undefined), null);
});

/* ---------- listProviders ---------- */
test("listProviders: only api-key providers with baseUrl; modelIds merged; no apiKey in output", () => {
  const file = tmpCfgPath();
  writeCfg(file, sampleCfg());
  const mp = M.createModelPuller({ customCfgPath: file });
  const r = mp.listProviders();
  assert.equal(r.ok, true);
  assert.equal(r.providers.length, 1);
  const p = r.providers[0];
  assert.equal(p.id, "custom-relay");
  assert.equal(p.name, "我的中转");
  assert.equal(p.baseUrl, "https://relay.example.com");
  assert.equal(p.hasKey, true);
  assert.deepEqual(p.modelIds, ["gpt-4o", "glm-4.6"]);
  assert.equal(JSON.stringify(r).includes("sk-secret-1"), false);
});

test("listProviders: missing file and broken json fail closed", () => {
  const missing = M.createModelPuller({ customCfgPath: tmpCfgPath() });
  assert.equal(missing.listProviders().ok, false);
  const file = tmpCfgPath();
  fs.writeFileSync(file, "{broken");
  const mp = M.createModelPuller({ customCfgPath: file });
  const r = mp.listProviders();
  assert.equal(r.ok, false);
  assert.deepEqual(r.providers, []);
});

/* ---------- fetchModels ---------- */
test("fetchModels: first candidate 404 falls through; auth headers only on provider request", async () => {
  const file = tmpCfgPath();
  writeCfg(file, sampleCfg());
  const { mp, calls } = createPuller(file, [
    { url: MODELS_DEV_TEST_URL, body: {} },
    { url: "https://relay.example.com/v1/models", status: 404 },
    { url: "https://relay.example.com/models", body: { data: [{ id: "b" }, { id: "a" }] } },
  ]);
  const r = await mp.fetchModels("custom-relay");
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ["a", "b"]);
  assert.equal(r.via, "https://relay.example.com/models");
  const pc = providerCalls(calls);
  assert.equal(pc.length, 2);
  assert.equal(pc[0].opts.headers.Authorization, "Bearer sk-secret-1");
  assert.equal(pc[0].opts.headers["x-api-key"], "sk-secret-1");
  const devCall = calls.find((c) => c.url === MODELS_DEV_TEST_URL);
  assert.equal(devCall.opts.headers.Authorization, undefined);   // key 绝不发往公共目录
  assert.equal(JSON.stringify(r).includes("sk-secret-1"), false);
});

test("fetchModels: no key omits auth headers; unknown/coding-plan provider rejected", async () => {
  const cfg = sampleCfg();
  cfg.config.providerConfigRules.providerRules[0].config.access.apiKey = "";
  const file = tmpCfgPath();
  writeCfg(file, cfg);
  const { mp, calls } = createPuller(file, [
    { url: MODELS_DEV_TEST_URL, body: {} },
    { url: "https://relay.example.com/v1/models", body: ["m1"] },
  ]);
  const r = await mp.fetchModels("custom-relay");
  assert.equal(r.ok, true);
  assert.equal(providerCalls(calls)[0].opts.headers.Authorization, undefined);
  assert.equal((await mp.fetchModels("no-such-provider")).error, "provider not found");
  assert.equal((await mp.fetchModels("plan-provider")).error, "provider not found");
});

test("fetchModels: 401 aborts immediately (credential issue), 404/405 fall through", async () => {
  const file = tmpCfgPath();
  writeCfg(file, sampleCfg());
  const { mp, calls } = createPuller(file, [
    { url: MODELS_DEV_TEST_URL, status: 500 },   // 目录挂了
    { url: "https://relay.example.com/v1/models", status: 401 },
    { url: "https://relay.example.com/models", body: ["never-reached"] },
  ]);
  const r = await mp.fetchModels("custom-relay");
  assert.equal(r.ok, false);
  assert.equal(r.error, "HTTP 401");   // 凭据问题不空耗后续候选超时（cc-switch 同款）
  assert.equal(providerCalls(calls).length, 1);

  const file2 = tmpCfgPath();
  writeCfg(file2, sampleCfg());
  const { mp: mp2, calls: calls2 } = createPuller(file2, [
    { url: MODELS_DEV_TEST_URL, body: {} },
    { url: "https://relay.example.com/v1/models", status: 405 },
    { url: "https://relay.example.com/models", body: { nothing: true } },
  ]);
  const r2 = await mp2.fetchModels("custom-relay");
  assert.equal(r2.ok, false);
  assert.equal(r2.error, "no models in response");   // 405/404=路径问题，继续试完报最后错误
  assert.equal(providerCalls(calls2).length, 2);
});

test("fetchModels: catalog fills missing metadata; provider fields win; bare-string items ok", async () => {
  const file = tmpCfgPath();
  writeCfg(file, sampleCfg());
  const { mp } = createPuller(file, [
    {
      url: MODELS_DEV_TEST_URL, body: {
        "openai/gpt-4o": { id: "gpt-4o", limit: { context: 128000, output: 16384 }, architecture: { input_modalities: ["text", "image"] } },
        "test/relay-only": { id: "relay-only", context_length: 777 },
      },
    },
    {
      url: "https://relay.example.com/v1/models", body: {
        data: [
          "gpt-4o",                                  // 裸字符串：全部走目录
          { id: "relay-only", max_output_tokens: 4096 },   // 供应商部分字段：ctx 由目录补、output 供应商优先
          { id: "unknown-model", supported_efforts: ["off", "high"] },   // 目录没有：只带供应商字段
        ],
      },
    },
  ]);
  const r = await mp.fetchModels("custom-relay");
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ["gpt-4o", "relay-only", "unknown-model"]);
  assert.deepEqual(r.metaById["gpt-4o"],
    { contextWindow: 128000, maxOutputTokens: 16384, inputFormat: { supportsImage: true, supportsVideo: false, supportsAudio: false, supportsPdf: false } });
  assert.deepEqual(r.metaById["relay-only"], { contextWindow: 777, maxOutputTokens: 4096 });
  assert.deepEqual(r.metaById["unknown-model"], { efforts: ["off", "high"] });
});

test("fetchModels: prototype-key model ids survive (null-prototype metaById)", async () => {
  const file = tmpCfgPath();
  writeCfg(file, sampleCfg());
  const { mp } = createPuller(file, [
    { url: MODELS_DEV_TEST_URL, body: {} },
    {
      url: "https://relay.example.com/v1/models", body: {
        data: ["__proto__", "constructor", { id: "meta-proto", supported_efforts: ["off"] }],
      },
    },
  ]);
  const r = await mp.fetchModels("custom-relay");
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ["__proto__", "constructor", "meta-proto"]);
  assert.equal(Object.getPrototypeOf(r.metaById), null);   // null 原型：原型污染键不可能
  assert.deepEqual(r.metaById["meta-proto"], { efforts: ["off"] });   // "__proto__" 是普通自有键，可写可读
  r.metaById["__proto__"] = { efforts: ["low"] };
  assert.deepEqual(r.metaById["__proto__"], { efforts: ["low"] });
});

/* ---------- applyModels ---------- */
test("applyModels: appends ids, clones template, keeps unknown keys, writes backup", async () => {
  const file = tmpCfgPath();
  writeCfg(file, sampleCfg());
  const mp = M.createModelPuller({ customCfgPath: file });
  const r = await mp.applyModels("custom-relay", ["glm-4.6", "new-model", "glm-4.6"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r, { ok: true, added: 1 });   // glm-4.6 已声明，仅 new-model 新增
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  const rule = after.config.providerConfigRules.providerRules[0].config;
  assert.deepEqual(rule.personalModelIds, ["gpt-4o", "new-model"]);
  assert.deepEqual(rule.modelOrder, ["gpt-4o", "glm-4.6", "new-model"]);
  const rules = after.config.modelConfigRules.providerModelRules;
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[1], { modelId: "new-model", providerId: "custom-relay", config: { enabled: true, properties: { contextWindow: 128000 } } });
  assert.deepEqual(after.config.someFutureKey, { keep: true });
  assert.deepEqual(after.config.modelConfigRules.manualProviderModelRules, []);
  assert.ok(fs.existsSync(file + ".zusage-bak"));
});

test("applyModels: all models already declared writes nothing new", async () => {
  const file = tmpCfgPath();
  writeCfg(file, sampleCfg());
  const before = fs.readFileSync(file, "utf8");
  const mp = M.createModelPuller({ customCfgPath: file });
  const r = await mp.applyModels("custom-relay", ["gpt-4o", "glm-4.6"]);
  assert.deepEqual(r, { ok: true, added: 0 });
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("applyModels: rejects unknown provider, broken json, and fully-invalid model lists", async () => {
  const file = tmpCfgPath();
  writeCfg(file, sampleCfg());
  const mp = M.createModelPuller({ customCfgPath: file });
  assert.equal((await mp.applyModels("ghost", ["a"])).error, "provider not found");
  assert.equal((await mp.applyModels("plan-provider", ["a"])).error, "provider not found");
  assert.equal((await mp.applyModels("custom-relay", ["  ", 42, ""])).error, "no valid models");

  const broken = tmpCfgPath();
  fs.writeFileSync(broken, "{oops");
  const mp2 = M.createModelPuller({ customCfgPath: broken });
  assert.equal((await mp2.applyModels("custom-relay", ["a"])).error, "provider not found");
});

test("applyModels: provider without template rules still updates id lists, leaves rules untouched", async () => {
  const cfg = sampleCfg();
  cfg.config.modelConfigRules = {};
  const file = tmpCfgPath();
  writeCfg(file, cfg);
  const mp = M.createModelPuller({ customCfgPath: file });
  const r = await mp.applyModels("custom-relay", ["fresh-1"]);
  assert.equal(r.ok, true);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(after.config.modelConfigRules, {});   // 无 providerModelRules：不新建结构
  assert.deepEqual(after.config.providerConfigRules.providerRules[0].config.personalModelIds, ["gpt-4o", "fresh-1"]);
});

test("applyModels: writes fetched metadata into new model entries; existing entries untouched", async () => {
  const file = tmpCfgPath();
  writeCfg(file, sampleCfg());
  const { mp } = createPuller(file, [
    { url: MODELS_DEV_TEST_URL, body: {} },
    {
      url: "https://relay.example.com/v1/models", body: {
        data: [
          { id: "brand-new", context_length: 262144, max_output_tokens: 32000, architecture: { input_modalities: ["text", "image", "pdf"] }, supported_efforts: ["off", "low", "high"] },
        ],
      },
    },
  ]);
  await mp.fetchModels("custom-relay");
  const r = await mp.applyModels("custom-relay", ["brand-new"]);
  assert.deepEqual(r, { ok: true, added: 1 });
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  const rules = after.config.modelConfigRules.providerModelRules;
  const entry = rules.find((x) => x.modelId === "brand-new");
  assert.deepEqual(entry.config.properties.contextWindow, 262144);
  assert.deepEqual(entry.config.properties.inputFormat, { supportsImage: true, supportsVideo: false, supportsAudio: false, supportsPdf: true });
  assert.deepEqual(entry.config.optionSpecs.reasoningLevel.values, ["off", "low", "high"]);
  assert.equal(entry.config.optionSpecs.maxOutputTokens.max, 32000);
  // 已有模型条目原样保留（手改保护）
  const gpt = rules.find((x) => x.modelId === "gpt-4o");
  assert.deepEqual(gpt.config, { enabled: true, properties: { contextWindow: 128000 } });
});

test("applyModels: template is the richest sibling, not the last one", async () => {
  const cfg = sampleCfg();
  const rules = cfg.config.modelConfigRules.providerModelRules;
  // 末条是贫瘠配置（仅 enabled），首条最丰富（能力位+推理档+输出上限）
  rules.push({ modelId: "poor-tail", providerId: "custom-relay", config: { enabled: true } });
  rules[0].config.optionSpecs = {
    reasoningLevel: { values: ["low", "medium", "high"] },
    maxOutputTokens: { max: 32000 },
  };
  const file = tmpCfgPath();
  writeCfg(file, cfg);
  const { mp } = createPuller(file, [
    { url: MODELS_DEV_TEST_URL, body: {} },
    { url: "https://relay.example.com/v1/models", body: { data: ["brand-new"] } },
  ]);
  await mp.fetchModels("custom-relay");
  await mp.applyModels("custom-relay", ["brand-new"]);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  const entry = after.config.modelConfigRules.providerModelRules.find((x) => x.modelId === "brand-new");
  assert.deepEqual(entry.config.properties.contextWindow, 128000);   // 继承自最富兄弟而非贫瘠末条
  assert.deepEqual(entry.config.optionSpecs.reasoningLevel.values, ["low", "medium", "high"]);
  assert.equal(entry.config.optionSpecs.maxOutputTokens.max, 32000);
});

test("applyModels: template specs with map expressions are not overwritten; plain values updated", async () => {
  const cfg = sampleCfg();
  const tpl = cfg.config.modelConfigRules.providerModelRules[0].config;
  tpl.optionSpecs = {
    reasoningLevel: { values: ["off", "high"], map: "off->none;high->high" },
    maxOutputTokens: { max: 8192, map: "maxOutput" },
  };
  const file = tmpCfgPath();
  writeCfg(file, cfg);
  const { mp } = createPuller(file, [
    { url: MODELS_DEV_TEST_URL, body: {} },
    {
      url: "https://relay.example.com/v1/models", body: {
        data: [{ id: "meta-model", context_length: 99000, max_output_tokens: 99000, supported_efforts: ["low"] }],
      },
    },
  ]);
  await mp.fetchModels("custom-relay");
  await mp.applyModels("custom-relay", ["meta-model"]);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  const entry = after.config.modelConfigRules.providerModelRules.find((x) => x.modelId === "meta-model");
  assert.deepEqual(entry.config.optionSpecs.reasoningLevel, { values: ["off", "high"], map: "off->none;high->high" });
  assert.deepEqual(entry.config.optionSpecs.maxOutputTokens, { max: 8192, map: "maxOutput" });
  assert.equal(entry.config.properties.contextWindow, 99000);   // 无 map 概念的字段照常写实
});

test("applyModels: no fetch cache (stale id path) still appends with pure template", async () => {
  const file = tmpCfgPath();
  writeCfg(file, sampleCfg());
  const mp = M.createModelPuller({ customCfgPath: file });
  const r = await mp.applyModels("custom-relay", ["no-fetch-before"]);
  assert.deepEqual(r, { ok: true, added: 1 });
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  const entry = after.config.modelConfigRules.providerModelRules.find((x) => x.modelId === "no-fetch-before");
  assert.deepEqual(entry.config, { enabled: true, properties: { contextWindow: 128000 } });
});

test("applyModels: preserves original file mode (posix)", { skip: process.platform === "win32" }, async () => {
  const file = tmpCfgPath();
  writeCfg(file, sampleCfg());
  fs.chmodSync(file, 0o600);
  const mp = M.createModelPuller({ customCfgPath: file });
  await mp.applyModels("custom-relay", ["mode-check"]);
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
});
