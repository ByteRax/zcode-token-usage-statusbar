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
const providerCalls = (calls) => calls.filter((c) => c.url.indexOf("models.dev") < 0);   // 含默认 api.json 档位目录（#236 按需拉取）

/* ---------- 纯函数 ---------- */
/* ---------- 套餐源（v134）：OAuth 型智谱套餐 ---------- */
const PLAN_ID = "account:bigmodel-individual-coding-plan";
const PLAN_CFG = {
  config: {
    providerConfigRules: {
      providerRules: [
        { providerId: PLAN_ID, config: { personalModelIds: ["GLM-5.3-FlashX"], modelOrder: ["GLM-5.3", "GLM-5.3-Flash", "GLM-5.3-FlashX"] } },
      ],
    },
  },
};

function createPlanPuller(file, routes, opts) {
  let cancelled = 0;
  const impl = async (url, o) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel: () => cancelled++ } };
    const hit = routes.find((r) => r.url === url);
    if (!hit) throw new Error("unexpected url " + url);
    return { ok: true, status: 200, json: async () => hit.body, body: null, authHeader: o.headers.Authorization };
  };
  const mp = M.createModelPuller({
    customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL,
    credentialsPath: "/tmp/creds.json",
    decryptValue: () => "plan-oauth-token",
    ...opts,
  });
  return { mp, impl };
}

test("plan source: listed when token decrypts, hidden when it does not", async () => {
  const file = tmpCfgPath();
  writeCfg(file, PLAN_CFG);
  fs.writeFileSync("/tmp/creds.json", JSON.stringify({ "oauth:bigmodel:access_token": "enc:xxx" }));
  const { mp } = createPlanPuller(file, []);
  const r = await mp.listProviders();
  assert.equal(r.ok, true);
  assert.equal(r.providers.length, 1);
  assert.equal(r.providers[0].id, PLAN_ID);
  assert.equal(r.providers[0].name, "BigModel Coding Plan");
  assert.equal(r.providers[0].baseUrl, "https://open.bigmodel.cn/api/anthropic");
  assert.deepEqual(r.providers[0].modelIds, ["GLM-5.3-FlashX", "GLM-5.3", "GLM-5.3-Flash"]);   // personalModelIds+modelOrder 合并口径

  const noTok = createPlanPuller(file, [], { decryptValue: () => null });
  assert.equal((await noTok.mp.listProviders()).providers.length, 0);
  assert.equal((await noTok.mp.fetchModels(PLAN_ID)).error, "provider not found");
});

test("plan source: fetches anthropic models endpoint with oauth bearer and normalizes case", async () => {
  const file = tmpCfgPath();
  writeCfg(file, PLAN_CFG);
  fs.writeFileSync("/tmp/creds.json", JSON.stringify({ "oauth:bigmodel:access_token": "enc:xxx" }));
  let seenAuth = "";
  const routes = [{
    url: "https://open.bigmodel.cn/api/anthropic/v1/models",
    get body() {
      return { data: [{ id: "glm-5.3-flashx" }, { id: "glm-4.7" }, { id: "glm-5.2" }] };
    },
  }];
  const { mp } = createPlanPuller(file, routes);
  const origImpl = (await (async () => null)()) ;
  const r = await mp.fetchModels(PLAN_ID);
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ["GLM-4.7", "GLM-5.2", "GLM-5.3-FlashX"]);   // 小写端点 → 宿主官方规范大小写，排序去重
  assert.equal(r.metaById["GLM-5.3-FlashX"], undefined);   // 套餐无元数据，纯 id 追加

  const r2 = await mp.applyModels(PLAN_ID, ["GLM-5.3-FlashX", "glm-4.7"]);
  assert.deepEqual(r2, { ok: true, added: 1 });   // FlashX 归一后命中已配置项；仅 glm-4.7→GLM-4.7 新增
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  const rule = after.config.providerConfigRules.providerRules[0].config;
  assert.ok(rule.personalModelIds.includes("GLM-4.7"));
  assert.ok(!rule.personalModelIds.includes("glm-4.7"));   // 不写小写重复项
});

test("plan source: applyModels bootstraps personal rule on fresh env (issue #226)", async () => {
  const file = tmpCfgPath();
  /* 全新环境：宿主初始 encode 的形状（schemaVersion + 空规则两容器），从未手动保存过模型；
   * 预置一条无关 api-key 规则，断言自建是追加不是替换 */
  writeCfg(file, {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          { providerId: "custom-relay", config: { access: { type: "api-key", apiKey: "sk-1" }, api: { baseUrl: "https://relay.example.com" } } },
        ],
      },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  });
  fs.writeFileSync("/tmp/creds.json", JSON.stringify({ "oauth:bigmodel:access_token": "enc:xxx" }));
  const { mp } = createPlanPuller(file, []);
  const r = await mp.applyModels(PLAN_ID, ["GLM-5.3-FlashX", "glm-5.3"]);
  assert.deepEqual(r, { ok: true, added: 2 });
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  const rules = after.config.providerConfigRules.providerRules;
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0], {   // 无关规则原样保留
    providerId: "custom-relay",
    config: { access: { type: "api-key", apiKey: "sk-1" }, api: { baseUrl: "https://relay.example.com" } },
  });
  const rule = rules[1];
  /* 严格同构：无 providerName/enabled/access 等多余键（宿主 strict schema + superRefine） */
  assert.deepEqual(rule, {
    providerId: PLAN_ID,
    config: { personalModelIds: ["GLM-5.3-FlashX", "GLM-5.3"], modelOrder: ["GLM-5.3-FlashX", "GLM-5.3"] },
  });
  assert.deepEqual(after.config.modelConfigRules.providerModelRules, [
    { modelId: "GLM-5.3-FlashX", providerId: PLAN_ID, config: { enabled: true } },   // 宿主 addPersonalModel 最小骨架
    { modelId: "GLM-5.3", providerId: PLAN_ID, config: { enabled: true } },
  ]);
  assert.deepEqual(after.config.modelConfigRules.manualProviderModelRules, []);
  assert.equal(after.schemaVersion, 1);   // 宿主版本键原样保留
});

test("plan source: applyModels refuses when providerRules is not an in-file array (no host skeleton rebuild)", async () => {
  const file = tmpCfgPath();
  writeCfg(file, { schemaVersion: 1, config: {} });   // providerConfigRules 缺失：结构缺口过大
  fs.writeFileSync("/tmp/creds.json", JSON.stringify({ "oauth:bigmodel:access_token": "enc:xxx" }));
  const { mp } = createPlanPuller(file, []);
  assert.equal((await mp.applyModels(PLAN_ID, ["GLM-5.3"])).error, "provider not found");
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(after.config, {});   // 未动文件结构

  const nonArray = tmpCfgPath();   // providerRules 存在但非数组：同一守卫拒绝
  writeCfg(nonArray, { schemaVersion: 1, config: { providerConfigRules: { providerRules: {} } } });
  const mpNA = M.createModelPuller({
    customCfgPath: nonArray, fetchImpl: async () => null, modelsDevUrl: MODELS_DEV_TEST_URL,
    credentialsPath: "/tmp/creds.json", decryptValue: () => "plan-oauth-token",
  });
  assert.equal((await mpNA.applyModels(PLAN_ID, ["GLM-5.3"])).error, "provider not found");
  assert.deepEqual(JSON.parse(fs.readFileSync(nonArray, "utf8")).config.providerConfigRules, { providerRules: {} });

  const missing = tmpCfgPath();   // 文件不存在：不代宿主创建 provider_config.json
  fs.writeFileSync("/tmp/creds.json", JSON.stringify({ "oauth:bigmodel:access_token": "enc:xxx" }));
  const mp2 = M.createModelPuller({
    customCfgPath: missing, fetchImpl: async () => null, modelsDevUrl: MODELS_DEV_TEST_URL,
    credentialsPath: "/tmp/creds.json", decryptValue: () => "plan-oauth-token",
  });
  assert.equal((await mp2.applyModels(PLAN_ID, ["GLM-5.3"])).error, "provider not found");
  assert.equal(fs.existsSync(missing), false);
});

test("plan source: applyModels without modelConfigRules writes only id lists", async () => {
  const file = tmpCfgPath();
  writeCfg(file, { schemaVersion: 1, config: { providerConfigRules: { providerRules: [] } } });
  fs.writeFileSync("/tmp/creds.json", JSON.stringify({ "oauth:bigmodel:access_token": "enc:xxx" }));
  const { mp } = createPlanPuller(file, []);
  const r = await mp.applyModels(PLAN_ID, ["GLM-5.3"]);
  assert.deepEqual(r, { ok: true, added: 1 });
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.config.modelConfigRules, undefined);   // 不越权创建规则容器，只写 id 列表
  assert.deepEqual(after.config.providerConfigRules.providerRules[0].config, { personalModelIds: ["GLM-5.3"], modelOrder: ["GLM-5.3"] });
});

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

test("extractModelMeta: efforts sorted by strength ladder; unknown words keep order at tail (#236)", () => {
  /* 宿主默认档=values 末项、辅助调用取首项：写入前必须按强度梯排序，供应商/目录原始顺序不可信 */
  assert.deepEqual(M.extractModelMeta({ id: "x", supported_efforts: ["high", "none", "low"] }).efforts, ["none", "low", "high"]);
  assert.deepEqual(M.extractModelMeta({ id: "x", supported_efforts: ["max", "off"] }).efforts, ["off", "max"]);
  assert.deepEqual(M.extractModelMeta({ id: "x", supported_efforts: ["mega", "medium", "beta"] }).efforts, ["medium", "mega", "beta"]);
  assert.deepEqual(M.extractModelMeta({ id: "x", supported_efforts: ["High", "low", "HIGH"] }).efforts, ["low", "High", "HIGH"]);   // 梯子按小写判级，去重仍大小写敏感
});

test("extractModelMeta: GitHub Copilot capabilities aliases (#236 实测格式)", () => {
  const m = M.extractModelMeta({
    id: "copilot-x",
    capabilities: {
      supports: { reasoning_effort: ["medium", "low", "high"], vision: true },
      limits: { max_context_window_tokens: 200000, max_output_tokens: 16384 },
    },
  });
  assert.deepEqual(m.efforts, ["low", "medium", "high"]);
  assert.equal(m.contextWindow, 200000);
  assert.equal(m.maxOutputTokens, 16384);
  assert.equal(m.vision, true);
  assert.equal(M.extractModelMeta({ id: "n", capabilities: {} }).contextWindow, 0);
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

/* ---------- issue #236：拉取时同步写实提供商侧模型配置 ---------- */

const FRESH_CFG = () => ({
  schemaVersion: 1,
  config: {
    providerConfigRules: {
      providerRules: [
        { providerId: "fresh-relay", config: { access: { type: "api-key", apiKey: "sk-fresh" }, api: { baseUrl: "https://fresh.example.com" } } },
      ],
    },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
  },
});

test("applyModels: fresh api-key provider with zero siblings writes minimal skeleton plus evidenced meta (#236)", async () => {
  const file = tmpCfgPath();
  writeCfg(file, FRESH_CFG());
  const { mp } = createPuller(file, [
    { url: MODELS_DEV_TEST_URL, body: {} },
    { url: "https://fresh.example.com/v1/models", body: { data: [{ id: "new-1", context_length: 262144, architecture: { input_modalities: ["text", "image"] }, supported_efforts: ["high", "low"] }] } },
  ]);
  await mp.fetchModels("fresh-relay");
  const r = await mp.applyModels("fresh-relay", ["new-1"]);
  assert.deepEqual(r, { ok: true, added: 1 });
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  const entry = after.config.modelConfigRules.providerModelRules[0];
  /* 最小骨架同构宿主 addPersonalModel；有据字段直接写实——稀疏个人规则字段级覆盖内置，
   * map 继承宿主 apiType catch-all（选中档位原样透传），绝不生成 map */
  assert.deepEqual(entry, {
    modelId: "new-1", providerId: "fresh-relay",
    config: {
      enabled: true,
      properties: { contextWindow: 262144, inputFormat: { supportsImage: true, supportsVideo: false, supportsAudio: false, supportsPdf: false } },
      optionSpecs: { reasoningLevel: { values: ["low", "high"] } },
    },
  });
  assert.deepEqual(after.config.modelConfigRules.manualProviderModelRules, []);   // 红线：手动规则容器绝不写入
});

test("applyModels: fresh api-key provider with bare string list writes only enabled skeleton (#236)", async () => {
  const file = tmpCfgPath();
  writeCfg(file, FRESH_CFG());
  const { mp } = createPuller(file, [
    { url: MODELS_DEV_TEST_URL, body: {} },
    { url: "https://fresh.example.com/v1/models", body: { data: ["plain-1"] } },
  ]);
  await mp.fetchModels("fresh-relay");
  const r = await mp.applyModels("fresh-relay", ["plain-1"]);
  assert.deepEqual(r, { ok: true, added: 1 });
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  const entry = after.config.modelConfigRules.providerModelRules[0];
  assert.deepEqual(entry.config, { enabled: true });   // 无据不写：骨架即全部
});

test("api.json efforts catalog: on-demand background fetch, merged from cache on next pull (#236)", async () => {
  const file = tmpCfgPath();
  writeCfg(file, sampleCfg());
  let apiCalls = 0;
  const impl = async (url) => {
    if (url === "https://models.dev/api.json") {
      apiCalls++;
      return {
        ok: true, status: 200, body: null,
        json: async () => ({
          p1: { models: {
            "glm-5.2": { reasoning_options: [{ type: "effort", values: ["max", "medium", "high"] }] },
          } },
          p2: { models: {
            "ok-model": { reasoning_options: [{ type: "effort", values: ["medium", "low"] }, { type: "effort", values: [null, "high"] }, { type: "budget_tokens", min: 1, max: 8 }] },
          } },
        }),
      };
    }
    if (url === MODELS_DEV_TEST_URL) return { ok: true, status: 200, json: async () => ({}) };
    if (url === "https://relay.example.com/v1/models") return { ok: true, status: 200, body: null, json: async () => ({ data: ["glm-5.2", "ok-model"] }) };
    throw new Error("unexpected url " + url);
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL });
  const r = await mp.fetchModels("custom-relay");
  assert.equal(r.ok, true);
  assert.equal(r.metaById["glm-5.2"], undefined);   // 首轮：目录未就绪，按需触发后台拉取不阻塞
  assert.equal(r.effortsFetching, true);   // #236：触发后台补拉时渲染端据此显示「档位补拉中」
  let merged = false;
  for (let i = 0; i < 50 && !merged; i++) {   // 等后台目录落地（stub 全微任务链，2ms 轮询足够）
    await new Promise((resolve) => setTimeout(resolve, 2));
    const probe = await mp.fetchModels("custom-relay");
    if (probe.metaById["ok-model"] && probe.metaById["ok-model"].efforts.length) {
      merged = true;
      assert.deepEqual(probe.metaById["ok-model"].efforts, ["low", "medium", "high"]);   // 多 option 合并 + null 过滤 + 梯子排序
      assert.equal(probe.metaById["glm-5.2"].efforts.join("/"), "medium/high/max");
    }
  }
  assert.ok(merged, "api catalog efforts never merged");
  const callsAfter = apiCalls;
  await mp.fetchModels("custom-relay");
  assert.equal(apiCalls, callsAfter);   // 缓存 1h：后续拉取不再打网络
  assert.equal(apiCalls, 1);
});

test("api.json efforts catalog: toggle-only and cross-provider ambiguous entries are skipped (#236)", async () => {
  const file = tmpCfgPath();
  writeCfg(file, sampleCfg());
  const impl = async (url) => {
    if (url === "https://models.dev/api.json") {
      return {
        ok: true, status: 200, body: null,
        json: async () => ({
          p1: { models: { "t-only": { reasoning_options: [{ type: "toggle" }] }, "dup-model": { reasoning_options: [{ type: "effort", values: ["low"] }] } } },
          p2: { models: { "dup-model": { reasoning_options: [{ type: "effort", values: ["high"] }] } } },
        }),
      };
    }
    if (url === MODELS_DEV_TEST_URL) return { ok: true, status: 200, json: async () => ({}) };
    return { ok: true, status: 200, body: null, json: async () => ({ data: ["t-only", "dup-model"] }) };
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL });
  await mp.fetchModels("custom-relay");
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 2));   // 等缓存落地
  const r = await mp.fetchModels("custom-relay");
  assert.equal(r.ok, true);
  assert.equal(r.metaById["t-only"], undefined);    // toggle=内置默认两档已覆盖，不采纳
  assert.equal(r.metaById["dup-model"], undefined);   // 跨 provider 歧义：宁缺毋滥
});

test("api.json efforts catalog: empty modelsDevApiUrl disables the source entirely", async () => {
  const file = tmpCfgPath();
  writeCfg(file, sampleCfg());
  let apiCalls = 0;
  const impl = async (url) => {
    if (url === "https://models.dev/api.json") { apiCalls++; throw new Error("must not fetch"); }
    if (url === MODELS_DEV_TEST_URL) return { ok: true, status: 200, json: async () => ({}) };
    return { ok: true, status: 200, body: null, json: async () => ({ data: ["m1"] }) };
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "" });
  const r = await mp.fetchModels("custom-relay");
  assert.equal(r.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(apiCalls, 0);
});

test("plan source: catalog fills GLM meta within grace; apply writes evidenced fields (#236)", async () => {
  const file = tmpCfgPath();
  writeCfg(file, {
    config: {
      providerConfigRules: { providerRules: [{ providerId: PLAN_ID, config: { personalModelIds: [], modelOrder: [] } }] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  });
  fs.writeFileSync("/tmp/creds.json", JSON.stringify({ "oauth:bigmodel:access_token": "enc:xxx" }));
  const impl = async (url) => {
    if (url === "https://open.bigmodel.cn/api/anthropic/v1/models") {
      return { ok: true, status: 200, body: null, json: async () => ({ data: [{ id: "glm-5.2" }] }) };
    }
    if (url === MODELS_DEV_TEST_URL) {
      return { ok: true, status: 200, body: null, json: async () => ({ "zhipuai/glm-5.2": { id: "glm-5.2", limit: { context: 200000, output: 32000 }, architecture: { input_modalities: ["text", "image"] } } }) };
    }
    throw new Error("unexpected url " + url);
  };
  const mp = M.createModelPuller({
    customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL,
    credentialsPath: "/tmp/creds.json", decryptValue: () => "plan-oauth-token",
  });
  const r = await mp.fetchModels(PLAN_ID);
  assert.equal(r.ok, true);
  assert.deepEqual(r.metaById["GLM-5.2"], { contextWindow: 200000, maxOutputTokens: 32000, inputFormat: { supportsImage: true, supportsVideo: false, supportsAudio: false, supportsPdf: false } });
  const r2 = await mp.applyModels(PLAN_ID, ["GLM-5.2"]);
  assert.deepEqual(r2, { ok: true, added: 1 });
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  const entry = after.config.modelConfigRules.providerModelRules.find((x) => x.modelId === "GLM-5.2");
  assert.deepEqual(entry.config, {
    enabled: true,
    properties: { contextWindow: 200000, inputFormat: { supportsImage: true, supportsVideo: false, supportsAudio: false, supportsPdf: false } },
    optionSpecs: { maxOutputTokens: { max: 32000 } },
  });
});

/* ---------- #236 缓存落盘与 24h 刷新 ---------- */

const API_STUB_URL = "https://models.dev/api.json";   // 默认 modelsDevApiUrl

function apiIndexPayload() {
  return {
    p1: { models: {
      "glm-5.2": { reasoning_options: [{ type: "effort", values: ["max", "high"] }] },
      "solo-model": { reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }] },
    } },
    pa: { models: { "dup-model": { reasoning_options: [{ type: "effort", values: ["low"] }] } } },
    pb: { models: { "dup-model": { reasoning_options: [{ type: "effort", values: ["high"] }] } } },
  };
}

test("api.json efforts cache: persists lightweight index; fresh process uses it with zero network (#236)", async () => {
  const file = tmpCfgPath();
  writeCfg(file, sampleCfg());
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-mp-cache-"));
  const cacheFile = path.join(cacheDir, "model-efforts-cache.json");
  let apiCalls = 0;
  const listing = { ok: true, status: 200, body: null, json: async () => ({ data: ["glm-5.2", "dup-model", "solo-model"] }) };
  const mp1 = M.createModelPuller({
    customCfgPath: file, modelsDevUrl: MODELS_DEV_TEST_URL, cachePath: cacheFile,
    fetchImpl: async (url) => {
      if (url === API_STUB_URL) { apiCalls++; return { ok: true, status: 200, body: null, json: async () => apiIndexPayload() }; }
      if (url === MODELS_DEV_TEST_URL) return { ok: true, status: 200, json: async () => ({}) };
      return listing;
    },
  });
  const r1 = await mp1.fetchModels("custom-relay");
  assert.equal(r1.effortsFetching, true);   // 首轮无索引：触发后台下载
  for (let i = 0; i < 50 && apiCalls < 1; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  await new Promise((resolve) => setTimeout(resolve, 10));   // 等解析+落盘链走完
  assert.equal(apiCalls, 1);
  const saved = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  assert.equal(saved.v, 1);
  assert.ok(saved.at > 0);
  assert.deepEqual(saved.e["glm-5.2"], ["high", "max"]);   // 索引按小写归一 + 梯排序
  assert.deepEqual(saved.e["solo-model"], ["low", "medium", "high"]);
  assert.equal(saved.e["dup-model"], null);   // 跨 provider 歧义：落盘为 null 永不采纳
  assert.ok(saved.b && typeof saved.b === "object");

  /* 冷启动（模拟重启）：全新实例、api URL 一律拒绝，档位纯来自缓存文件 */
  const mp2 = M.createModelPuller({
    customCfgPath: file, modelsDevUrl: MODELS_DEV_TEST_URL, cachePath: cacheFile,
    fetchImpl: async (url) => {
      if (url === API_STUB_URL) { apiCalls++; throw new Error("must not fetch"); }
      if (url === MODELS_DEV_TEST_URL) return { ok: true, status: 200, json: async () => ({}) };
      return listing;
    },
  });
  const r2 = await mp2.fetchModels("custom-relay");
  assert.equal(r2.effortsFetching, undefined);   // 索引新鲜：不触发刷新
  assert.deepEqual(r2.metaById["glm-5.2"].efforts, ["high", "max"]);
  assert.deepEqual(r2.metaById["solo-model"].efforts, ["low", "medium", "high"]);
  assert.equal(r2.metaById["dup-model"], undefined);   // 歧义键不采纳
  assert.equal(apiCalls, 1);   // 全程零下载
});

test("api.json efforts cache: index older than 24h still merges and triggers one refresh (#236)", async () => {
  const file = tmpCfgPath();
  writeCfg(file, sampleCfg());
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-mp-stale-"));
  const cacheFile = path.join(cacheDir, "model-efforts-cache.json");
  fs.writeFileSync(cacheFile, JSON.stringify({ v: 1, at: Date.now() - 25 * 3600 * 1000, e: { "glm-5.2": ["high", "max"] }, b: {} }));
  let apiCalls = 0;
  const mp = M.createModelPuller({
    customCfgPath: file, modelsDevUrl: MODELS_DEV_TEST_URL, cachePath: cacheFile,
    fetchImpl: async (url) => {
      if (url === API_STUB_URL) { apiCalls++; return { ok: true, status: 200, body: null, json: async () => apiIndexPayload() }; }
      if (url === MODELS_DEV_TEST_URL) return { ok: true, status: 200, json: async () => ({}) };
      return { ok: true, status: 200, body: null, json: async () => ({ data: ["glm-5.2"] }) };
    },
  });
  const r = await mp.fetchModels("custom-relay");
  assert.equal(r.ok, true);
  assert.deepEqual(r.metaById["glm-5.2"].efforts, ["high", "max"]);   // stale-while-revalidate：旧索引先顶上
  assert.equal(r.effortsFetching, true);   // 同时触发后台刷新
  for (let i = 0; i < 50 && apiCalls < 1; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(apiCalls, 1);
  const savedAt = JSON.parse(fs.readFileSync(cacheFile, "utf8")).at;
  assert.ok(savedAt > Date.now() - 60 * 1000);   // 刷新后文件时间戳已重置
  const r2 = await mp.fetchModels("custom-relay");
  assert.equal(r2.effortsFetching, undefined);   // 新索引 24h 内不再刷新
  assert.equal(apiCalls, 1);
});

test("api.json efforts cache: corrupt cache file is ignored and re-downloaded (#236)", async () => {
  const file = tmpCfgPath();
  writeCfg(file, sampleCfg());
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-mp-bad-"));
  const cacheFile = path.join(cacheDir, "model-efforts-cache.json");
  fs.writeFileSync(cacheFile, "{broken");
  let apiCalls = 0;
  const mp = M.createModelPuller({
    customCfgPath: file, modelsDevUrl: MODELS_DEV_TEST_URL, cachePath: cacheFile,
    fetchImpl: async (url) => {
      if (url === API_STUB_URL) { apiCalls++; return { ok: true, status: 200, body: null, json: async () => apiIndexPayload() }; }
      if (url === MODELS_DEV_TEST_URL) return { ok: true, status: 200, json: async () => ({}) };
      return { ok: true, status: 200, body: null, json: async () => ({ data: ["glm-5.2"] }) };
    },
  });
  const r = await mp.fetchModels("custom-relay");
  assert.equal(r.effortsFetching, true);
  for (let i = 0; i < 50 && apiCalls < 1; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(apiCalls, 1);
  const saved = JSON.parse(fs.readFileSync(cacheFile, "utf8"));   // 损坏文件被有效索引覆盖
  assert.deepEqual(saved.e["glm-5.2"], ["high", "max"]);
});

test("api.json efforts cache: basename fallback via index when mid absent (#236)", () => {
  const entries = M.apiCatalogEntries({ p1: { models: { "glm-5.2": { reasoning_options: [{ type: "effort", values: ["low", "max"] }] } } } });
  const index = M.buildEffortsIndex(entries);
  assert.deepEqual(index.e["glm-5.2"], ["low", "max"]);
  assert.deepEqual(index.b["glm-5.2"], ["low", "max"]);
});

test("api.json efforts cache: malformed key shapes fail closed to empty cache and re-download (#236)", async () => {
  const file = tmpCfgPath();
  writeCfg(file, sampleCfg());
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-mp-shape-"));
  const cacheFile = path.join(cacheDir, "model-efforts-cache.json");
  /* 字符串/数字冒充词表：穿透到 values 会写坏宿主 provider_config 规则（整份配置解析失败） */
  fs.writeFileSync(cacheFile, JSON.stringify({ v: 1, at: Date.now(), e: { "glm-x": "high" }, b: {} }));
  let apiCalls = 0;
  const mp = M.createModelPuller({
    customCfgPath: file, modelsDevUrl: MODELS_DEV_TEST_URL, cachePath: cacheFile,
    fetchImpl: async (url) => {
      if (url === API_STUB_URL) { apiCalls++; return { ok: true, status: 200, body: null, json: async () => apiIndexPayload() }; }
      if (url === MODELS_DEV_TEST_URL) return { ok: true, status: 200, json: async () => ({}) };
      return { ok: true, status: 200, body: null, json: async () => ({ data: ["glm-5.2"] }) };
    },
  });
  const r = await mp.fetchModels("custom-relay");
  assert.equal(r.ok, true);
  assert.equal(r.effortsFetching, true);   // 非法形状=空缓存：走重新下载
  for (let i = 0; i < 50 && apiCalls < 1; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(apiCalls, 1);
  const saved = JSON.parse(fs.readFileSync(cacheFile, "utf8"));   // 非法文件被合法索引覆盖
  assert.deepEqual(saved.e["glm-5.2"], ["high", "max"]);
  assert.equal("glm-x" in saved.e, false);
});

test("api.json efforts cache: prototype-named model ids stay fail-closed through the file-loaded index (#236)", async () => {
  const file = tmpCfgPath();
  writeCfg(file, sampleCfg());
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-mp-proto-"));
  const cacheFile = path.join(cacheDir, "model-efforts-cache.json");
  /* b.constructor 为 JSON.parse 的自有 null 键（合法形状）；e/b 均无 toString/hasOwnProperty 自有键 */
  fs.writeFileSync(cacheFile, JSON.stringify({ v: 1, at: Date.now(), e: { "glm-5.2": ["high", "max"] }, b: { constructor: null } }));
  const mp = M.createModelPuller({
    customCfgPath: file, modelsDevUrl: MODELS_DEV_TEST_URL, cachePath: cacheFile,
    fetchImpl: async (url) => {
      if (url === API_STUB_URL) throw new Error("must not fetch");
      if (url === MODELS_DEV_TEST_URL) return { ok: true, status: 200, json: async () => ({}) };
      return { ok: true, status: 200, body: null, json: async () => ({ data: ["constructor", "toString", "hasOwnProperty", "glm-5.2"] }) };
    },
  });
  const r = await mp.fetchModels("custom-relay");   // 锁定双保险回归：sanitize 重建 null 原型图后删单守卫行为中性，守卫+null 原型双删须被本用例捕获
  assert.equal(r.ok, true);
  assert.deepEqual(r.metaById["glm-5.2"].efforts, ["high", "max"]);   // 合法键正常命中
  assert.equal(r.metaById["constructor"], undefined);   // 原型名不穿透（fail-closed 宁缺毋滥）
  assert.equal(r.metaById["toString"], undefined);
  assert.equal(r.metaById["hasOwnProperty"], undefined);
});
