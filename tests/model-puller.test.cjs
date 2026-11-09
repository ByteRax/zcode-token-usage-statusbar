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
      return new Promise((resolve) => {
        const t = setTimeout(() => { settled = true; resolve({ ok: true, status: 200, json: async () => ({}) }); }, 5000);
        if (t && typeof t.unref === "function") t.unref();
      });
    }
    return { ok: true, status: 200, json: async () => ["fast-model"], body: null };
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL, catalogGraceMs: 60 });
  const started = Date.now();
  const r = await mp.fetchModels("custom-relay");
  const elapsed = Date.now() - started;
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ["fast-model"]);
  assert.ok(elapsed < 1000, "should not wait for the slow catalog, took " + elapsed + "ms");   // 宽限封顶，不等 5s 目录
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

/* ---------- v309 模型探测：确认添加前按宿主同款语义发最小请求 ---------- */

test("probe URL helpers: anthropic base gains /v1, status classes, secrets masked", () => {
  assert.equal(M.anthropicBaseWithV1("https://relay.example.com"), "https://relay.example.com/v1");   // 宿主 normalizeAnthropicBaseURL 同款：无 /v1 补 /v1
  assert.equal(M.anthropicBaseWithV1("https://relay.example.com/"), "https://relay.example.com/v1");   // 尾斜杠先剥
  assert.equal(M.anthropicBaseWithV1("https://relay.example.com/v1"), "https://relay.example.com/v1");   // 已带 /v1 不重复
  assert.equal(M.anthropicBaseWithV1("https://open.bigmodel.cn/api/anthropic"), "https://open.bigmodel.cn/api/anthropic/v1");
  assert.equal(M.anthropicBaseWithV1(""), "");
  assert.equal(M.classifyProbeStatus(401), "auth");
  assert.equal(M.classifyProbeStatus(403), "auth");
  assert.equal(M.classifyProbeStatus(404), "path");
  assert.equal(M.classifyProbeStatus(405), "path");
  assert.equal(M.classifyProbeStatus(429), "rate");
  assert.equal(M.classifyProbeStatus(400), "bad_request");
  assert.equal(M.classifyProbeStatus(500), "server");
  assert.equal(M.classifyProbeStatus(503), "server");
  assert.equal(M.classifyProbeStatus(418), "http");
  const masked = M.maskSecrets('{"error":"Invalid token sk-LiveAbcdef123456 for Bearer sk-SecretValue99"}');
  assert.equal(masked, '{"error":"Invalid token sk-*** for Bearer sk-***"}');
  assert.ok(!masked.includes("Abcdef123456") && !masked.includes("SecretValue99"));
});

function probeCfg(types) {
  return {
    config: {
      providerConfigRules: {
        providerRules: [
          { providerId: "chat-relay", config: { access: { type: "api-key", apiKey: "sk-secret-1" }, api: { type: "openai-chat-completions", baseUrl: "https://relay.example.com" } } },
          { providerId: "resp-relay", config: { access: { type: "api-key", apiKey: "sk-secret-2" }, api: { type: "openai-responses", baseUrl: "https://relay.example.com/v1/" } } },
          { providerId: "claude-relay", config: { access: { type: "api-key", apiKey: "sk-secret-3" }, api: { type: "anthropic-messages", baseUrl: "https://relay.example.com" } } },
          { providerId: "weird-relay", config: { access: { type: "api-key", apiKey: "sk-secret-4" }, api: { type: "future-api", baseUrl: "https://relay.example.com" } } },
        ],
      },
    },
  };
}

function probePuller(file, handler) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts);
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL });
  return { mp, calls };
}

test("probe mirrors host URL semantics: openai types never gain /v1, anthropic does", async () => {
  const file = tmpCfgPath();
  writeCfg(file, probeCfg());
  const { mp, calls } = probePuller(file, () => ({ ok: true, status: 200 }));
  const ok1 = await mp.probeModel("chat-relay", "gemini-3.8-flash");
  assert.equal(ok1.ok, true);
  assert.equal(ok1.url, "https://relay.example.com/chat/completions");   // 回归锚：Base URL 少 /v1 时不补——宿主 createOpenAICompatible 同款，2026-11-09 OpenHub-Gemini 405 实案 */
  assert.equal(ok1.status, 200);
  assert.ok(typeof ok1.latencyMs === "number");
  const ok2 = await mp.probeModel("resp-relay", "gpt-6.1-sol");
  assert.equal(ok2.url, "https://relay.example.com/v1/responses");   // trailing slash stripped, /v1 kept as user wrote
  const ok3 = await mp.probeModel("claude-relay", "claude-sonnet-5-5");
  assert.equal(ok3.url, "https://relay.example.com/v1/messages");   // anthropic 宿主 normalize 同款补 /v1
  const bases = calls.filter((c) => { const b = JSON.parse(c.opts.body); return b.reasoning_effort === undefined && b.reasoning === undefined && (b.max_tokens === 16 || b.max_output_tokens === 16); });   // v311 起基础探测后还有 aux 档位验证请求（responses 型 aux 用嵌套 reasoning 字段），按形状定位
  assert.equal(bases.length, 3);
  const req = bases[0].opts;
  assert.equal(req.method, "POST");
  assert.equal(req.headers.Authorization, "Bearer sk-secret-1");
  assert.equal(req.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(req.body), { model: "gemini-3.8-flash", messages: [{ role: "user", content: "ping" }], max_tokens: 16, stream: false });
  const req3 = bases[2].opts;
  assert.equal(req3.headers["x-api-key"], "sk-secret-3");   // 宿主 withAnthropicAuthorizationHeader 同款双头
  assert.equal(req3.headers["anthropic-version"], "2023-06-01");
  assert.equal(req3.headers.Authorization, "Bearer sk-secret-3");
  assert.deepEqual(JSON.parse(req3.body), { model: "claude-sonnet-5-5", max_tokens: 16, messages: [{ role: "user", content: "ping" }] });
});

test("probe classifies failures and masks the error snippet", async () => {
  const file = tmpCfgPath();
  writeCfg(file, probeCfg());
  const { mp } = probePuller(file, (url) => {
    if (url.endsWith("/chat/completions")) return { ok: false, status: 405, text: async () => '<html>405 for key sk-LiveZzzz9999</html>' };
    if (url.endsWith("/v1/messages")) return { ok: false, status: 401, text: async () => '{"error":{"message":"Invalid token sk-LiveAbcdef123456"}}' };
    if (url.endsWith("/responses")) throw Object.assign(new Error("boom"), { name: "TimeoutError" });
    return { ok: true, status: 200 };
  });
  const p405 = await mp.probeModel("chat-relay", "gemini-3.8-flash");
  assert.equal(p405.ok, false);
  assert.equal(p405.kind, "path");   // 405=路径不对（OpenHub 实案），展示宿主实际请求 URL
  assert.equal(p405.status, 405);
  assert.equal(p405.url, "https://relay.example.com/chat/completions");
  assert.ok(p405.snippet.includes("405") && !p405.snippet.includes("sk-LiveZzzz9999"));
  const p401 = await mp.probeModel("claude-relay", "claude-sonnet-5-5");
  assert.equal(p401.kind, "auth");
  assert.ok(p401.snippet.includes("sk-***") && !p401.snippet.includes("Abcdef123456"));
  const pTimeout = await mp.probeModel("resp-relay", "gpt-6.1-sol");
  assert.equal(pTimeout.kind, "timeout");
  const net = probePuller(file, () => { throw new Error("ECONNREFUSED"); });
  const pNet = await net.mp.probeModel("chat-relay", "m");
  assert.equal(pNet.kind, "network");
});

test("probe fail-closed on structural problems; plan source probes anthropic messages with oauth bearer", async () => {
  const file = tmpCfgPath();
  writeCfg(file, probeCfg());
  fs.writeFileSync("/tmp/creds.json", JSON.stringify({ "oauth:bigmodel:access_token": "enc:xxx" }));
  const seen = [];
  const mp = M.createModelPuller({
    customCfgPath: file, modelsDevUrl: MODELS_DEV_TEST_URL,
    credentialsPath: "/tmp/creds.json", decryptValue: () => "plan-oauth-token",
    fetchImpl: async (url, opts) => { seen.push({ url, auth: opts.headers.Authorization }); return { ok: true, status: 200 }; },
  });
  assert.equal((await mp.probeModel("missing", "m")).kind, "provider");
  assert.equal((await mp.probeModel("weird-relay", "m")).kind, "unsupported");
  assert.equal((await mp.probeModel("chat-relay", "bad\x01id")).kind, "invalid_model");
  assert.equal((await mp.probeModel("chat-relay", "")).kind, "invalid_model");
  const plan = await mp.probeModel(PLAN_ID, "GLM-5.3-FlashX");
  assert.equal(plan.ok, true);
  assert.equal(seen[seen.length - 1].url, "https://open.bigmodel.cn/api/anthropic/v1/messages");   // 套餐源与运行协议同源（Anthropic messages）
  assert.equal(seen[seen.length - 1].auth, "Bearer plan-oauth-token");
});

/* ---------- v310 路径错配自动修复：±/v1 候选实测命中即写回 provider_config ---------- */

test("probe auto-repairs a missing /v1 base, retests and persists the fix", async () => {
  const file = tmpCfgPath();
  writeCfg(file, probeCfg());
  const { mp, calls } = probePuller(file, (url) => {
    if (url === "https://relay.example.com/chat/completions") return { ok: false, status: 405, text: async () => "405" };   // OpenHub 实案形状
    if (url === "https://relay.example.com/v1/chat/completions") return { ok: true, status: 200 };
    throw new Error("unexpected " + url);
  });
  const r = await mp.probeModel("chat-relay", "gemini-3.8-flash");
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://relay.example.com/v1/chat/completions");
  assert.deepEqual(r.repaired, { from: "https://relay.example.com", to: "https://relay.example.com/v1" });
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const rule = saved.config.providerConfigRules.providerRules.find((p) => p.providerId === "chat-relay");
  assert.equal(rule.config.api.baseUrl, "https://relay.example.com/v1");   // 修复写回 provider_config
  assert.equal(fs.existsSync(file + ".zusage-bak"), true);   // 与 applyModels 同款滚动备份
  assert.ok(calls.some((c) => c.url === "https://relay.example.com/v1/chat/completions" && JSON.parse(c.opts.body).model === "gemini-3.8-flash"));   // 修复后按新 base 重试
});

test("probe auto-repairs an extra /v1 by stripping it (reverse direction)", async () => {
  const file = tmpCfgPath();
  writeCfg(file, probeCfg());
  const { mp } = probePuller(file, (url) => {
    if (url === "https://relay.example.com/v1/responses") return { ok: false, status: 404, text: async () => "404" };
    if (url === "https://relay.example.com/responses") return { ok: true, status: 200 };
    throw new Error("unexpected " + url);
  });
  const r = await mp.probeModel("resp-relay", "gpt-6.1-sol");
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired, { from: "https://relay.example.com/v1", to: "https://relay.example.com" });
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const rule = saved.config.providerConfigRules.providerRules.find((p) => p.providerId === "resp-relay");
  assert.equal(rule.config.api.baseUrl, "https://relay.example.com");
});

test("probe repair discloses tried candidates when they also fail; config untouched", async () => {
  const file = tmpCfgPath();
  writeCfg(file, probeCfg());
  const { mp } = probePuller(file, () => ({ ok: false, status: 405, text: async () => "405" }));
  const r = await mp.probeModel("chat-relay", "gemini-3.8-flash");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "path");
  assert.deepEqual(r.tried, ["https://relay.example.com/v1/chat/completions"]);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const rule = saved.config.providerConfigRules.providerRules.find((p) => p.providerId === "chat-relay");
  assert.equal(rule.config.api.baseUrl, "https://relay.example.com");   // 未命中不写回
});

test("probe repair is single-flight per provider: one candidate test and one write for concurrent probes", async () => {
  const file = tmpCfgPath();
  writeCfg(file, probeCfg());
  const variantHits = [];
  const { mp } = probePuller(file, (url) => {
    if (url === "https://relay.example.com/chat/completions") return { ok: false, status: 405, text: async () => "405" };
    if (url === "https://relay.example.com/v1/chat/completions") { variantHits.push(1); return { ok: true, status: 200 }; }
    throw new Error("unexpected " + url);
  });
  const [a, b, c] = await Promise.all([
    mp.probeModel("chat-relay", "m1"),
    mp.probeModel("chat-relay", "m2"),
    mp.probeModel("chat-relay", "m3"),
  ]);
  assert.equal(variantHits.length, 7, "单飞语义：变体 URL 命中 = 1 次候选实测 + 3 次修复后重试 + 3 次 aux 档位验证（v311；候选实测单飞破坏时远大于此）");   // 候选实测单飞
  assert.ok(a.repaired && b.repaired && c.repaired, "并发探测共享同一次修复，各自重试均带 repaired 标记");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.config.providerConfigRules.providerRules.find((p) => p.providerId === "chat-relay").config.api.baseUrl, "https://relay.example.com/v1");
});

test("probe repair never touches anthropic/plan sources (no mismatch dimension)", async () => {
  const file = tmpCfgPath();
  writeCfg(file, probeCfg());
  fs.writeFileSync("/tmp/creds.json", JSON.stringify({ "oauth:bigmodel:access_token": "enc:xxx" }));
  const urls = [];
  const mp = M.createModelPuller({
    customCfgPath: file, modelsDevUrl: MODELS_DEV_TEST_URL,
    credentialsPath: "/tmp/creds.json", decryptValue: () => "plan-oauth-token",
    fetchImpl: async (url) => { urls.push(url); return { ok: false, status: 404, text: async () => "404" }; },
  });
  const claude = await mp.probeModel("claude-relay", "claude-sonnet-5-5");   // anthropic 型宿主自动补 /v1：无 ±/v1 错配
  assert.equal(claude.kind, "path");
  assert.equal(claude.tried, undefined);
  const plan = await mp.probeModel(PLAN_ID, "GLM-5.3-FlashX");
  assert.equal(plan.kind, "path");
  assert.equal(urls.filter((u) => u.indexOf("/messages") > 0).length, 2);   // 各一次原始请求，无修复候选
  assert.ok(urls.every((u) => u.indexOf("/chat/completions") < 0));
  assert.equal(M.probeRepairCandidates("", "openai-chat-completions").length, 0);
  assert.equal(M.probeRepairCandidates("https://x", "anthropic-messages").length, 0);
  assert.deepEqual(M.probeRepairCandidates("https://x/", "openai-responses"), [{ base: "https://x/v1", url: "https://x/v1/responses" }]);
});

/* ---------- v311 辅助档位写实：values[0] wire 值被严格上游拒绝时自动修复 ---------- */

test("reasoning helpers: aux wire mapping and accepted-set parsing stop at the boundary", () => {
  assert.equal(M.auxWireValue("disabled"), "none");   // 内置两档最低 disabled 的 catch-all wire 值（宿主测试实际发送的词）
  assert.equal(M.auxWireValue("enabled"), "high");
  assert.equal(M.auxWireValue("minimal"), "minimal");
  assert.deepEqual(M.reasoningWireField("openai-chat-completions", "low"), { reasoning_effort: "low" });
  assert.deepEqual(M.reasoningWireField("openai-responses", "low"), { reasoning: { effort: "low" } });
  const real = '[{"error":{"code":400,"message":"Expected \'reasoning_effort\' to be one of: \'high\', \'low\', \'max\', \'medium\', \'minimal\'; found \'none\'.","status":"INVALID_ARGUMENT"}}]';
  const parsed = M.acceptedEffortsFromSnippet(real);
  assert.deepEqual(parsed, ["high", "low", "max", "medium", "minimal"]);   // 真实报错形状（用户实报）
  assert.equal(parsed.includes("none"), false);   // "found 'none'" 在分号之后，不是接受集成员
  assert.equal(M.acceptedEffortsFromSnippet("some other error"), null);
});

function auxProbeCfg() {
  return {
    config: {
      providerConfigRules: {
        providerRules: [
          { providerId: "gem-relay", config: { access: { type: "api-key", apiKey: "sk-secret-1" }, api: { type: "openai-chat-completions", baseUrl: "https://relay.example.com/v1" } } },
        ],
      },
      modelConfigRules: {
        manualProviderModelRules: [],
        providerModelRules: [
          { modelId: "gemini-3.8-flash", providerId: "gem-relay", config: { enabled: true } },
        ],
      },
    },
  };
}

test("aux probe: default none rejected heals the ladder parsed from the error text", async () => {
  const file = tmpCfgPath();
  writeCfg(file, auxProbeCfg());
  const bodies = [];
  const { mp } = probePuller(file, (url, opts) => {
    const body = JSON.parse(opts.body);
    bodies.push(body);
    if (body.reasoning_effort === undefined || body.reasoning_effort === "none") {
      return { ok: body.reasoning_effort === undefined, status: 400, text: async () => '[{"error":{"code":400,"message":"Expected \'reasoning_effort\' to be one of: \'high\', \'low\', \'max\', \'medium\', \'minimal\'; found \'none\'.","status":"INVALID_ARGUMENT"}}]' };
    }
    return { ok: true, status: 200 };
  });
  const r = await mp.probeModel("gem-relay", "gemini-3.8-flash");
  assert.equal(r.ok, true);
  assert.deepEqual(r.effortFixed, { values: ["minimal", "low", "medium", "high", "max"] });   // 梯序∩接受集
  // 基础探测不带 reasoning 字段；aux 验证发 "none" 被拒；写实验证发 "minimal"
  assert.equal(bodies[0].reasoning_effort, undefined);
  assert.equal(bodies[1].reasoning_effort, "none");
  assert.equal(bodies[2].reasoning_effort, "minimal");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const modelRule = saved.config.modelConfigRules.providerModelRules.find((x) => x.modelId === "gemini-3.8-flash" && x.providerId === "gem-relay");
  assert.deepEqual(modelRule.config.optionSpecs.reasoningLevel.values, ["minimal", "low", "medium", "high", "max"]);   // 稀疏 values-only 写实
  assert.equal(modelRule.config.enabled, true);   // 原有键保留
  assert.equal(modelRule.config.optionSpecs.reasoningLevel.map, undefined);   // 绝不生成 map（红线）
});

test("aux probe: healthy upstream (accepts none) is left untouched", async () => {
  const file = tmpCfgPath();
  writeCfg(file, auxProbeCfg());
  const { mp, calls } = probePuller(file, () => ({ ok: true, status: 200 }));
  const r = await mp.probeModel("gem-relay", "gemini-3.8-flash");
  assert.equal(r.ok, true);
  assert.equal(r.effortFixed, undefined);
  assert.equal(calls.length, 2);   // 基础 + aux 验证，无写实请求
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const modelRule = saved.config.modelConfigRules.providerModelRules.find((x) => x.modelId === "gemini-3.8-flash");
  assert.equal(modelRule.config.optionSpecs, undefined);   // 无据不写
});

test("aux probe: written values[0] is validated; unparseable error falls back to per-candidate probing", async () => {
  const file = tmpCfgPath();
  writeCfg(file, auxProbeCfg());
  const rule = JSON.parse(fs.readFileSync(file, "utf8"));
  rule.config.modelConfigRules.providerModelRules[0].config = { enabled: true, optionSpecs: { reasoningLevel: { values: ["none", "minimal", "high"] } } };
  writeCfg(file, rule);
  const seen = [];
  const { mp } = probePuller(file, (url, opts) => {
    const effort = JSON.parse(opts.body).reasoning_effort;
    seen.push(effort === undefined ? "(base)" : effort);
    if (effort === undefined || effort === "none") return { ok: effort === undefined, status: 400, text: async () => '{"error":{"message":"Invalid reasoning_effort value."}}' };   // 无接受集可解析但点名词段
    return { ok: true, status: 200 };   // minimal 起全部可用
  });
  const r = await mp.probeModel("gem-relay", "gemini-3.8-flash");
  assert.equal(r.ok, true);
  assert.deepEqual(r.effortFixed, { values: ["minimal"] });   // 写实前 values[0]="none"（梯排序后），被拒；解析失败逐候选，minimal 首个可用
  assert.deepEqual(seen, ["(base)", "none", "minimal"]);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const modelRule = saved.config.modelConfigRules.providerModelRules.find((x) => x.modelId === "gemini-3.8-flash");
  assert.deepEqual(modelRule.config.optionSpecs.reasoningLevel.values, ["minimal"]);
});

test("aux probe: nothing passes fails closed with reasoning kind; config untouched", async () => {
  const file = tmpCfgPath();
  writeCfg(file, auxProbeCfg());
  const { mp } = probePuller(file, (url, opts) => {
    const effort = JSON.parse(opts.body).reasoning_effort;
    if (effort === undefined) return { ok: true, status: 200 };
    return { ok: false, status: 400, text: async () => '[{"error":{"message":"Expected \'reasoning_effort\' to be one of: \'high\', \'low\', \'max\', \'medium\', \'minimal\'; found \'none\'."}}]' };
  });
  const r = await mp.probeModel("gem-relay", "gemini-3.8-flash");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "reasoning");   // 渲染端给「思考档位被上游拒绝」文案 + 接受集披露
  assert.deepEqual(r.accepted, ["high", "low", "max", "medium", "minimal"]);
  assert.equal(r.snippet.includes("sk-"), false);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const modelRule = saved.config.modelConfigRules.providerModelRules.find((x) => x.modelId === "gemini-3.8-flash");
  assert.equal(modelRule.config.optionSpecs, undefined);   // 修复不成不动配置
});

test("aux probe: un-added model heals fetchCache metadata for the follow-up apply write", async () => {
  const file = tmpCfgPath();
  const noModelRule = auxProbeCfg();
  noModelRule.config.modelConfigRules.providerModelRules = [];   // 未添加场景：无模型规则，写实只能进 fetchCache 元数据
  writeCfg(file, noModelRule);
  fs.writeFileSync("/tmp/models-list.json", "");
  const mp = M.createModelPuller({
    customCfgPath: file,
    fetchImpl: async (url, opts) => {
      if (url.endsWith("/v1/models")) return { ok: true, status: 200, json: async () => ({ data: [{ id: "gemini-3.8-flash", supported_efforts: ["none", "minimal", "high"] }] }) };
      const effort = JSON.parse(opts.body).reasoning_effort;
      if (effort === undefined || effort === "none") return { ok: effort === undefined, status: 400, text: async () => '[{"error":{"message":"Expected \'reasoning_effort\' to be one of: \'high\', \'low\', \'max\', \'medium\', \'minimal\'; found \'none\'."}}]' };
      return { ok: true, status: 200 };
    },
    modelsDevUrl: MODELS_DEV_TEST_URL,
  });
  await mp.fetchModels("gem-relay");   // 拉取会话建立 fetchCache（supported_efforts 含 none）
  const r = await mp.probeModel("gem-relay", "gemini-3.8-flash");
  assert.equal(r.ok, true);
  assert.deepEqual(r.effortFixed, { values: ["minimal", "low", "medium", "high", "max"] });   // 上游接受集是权威（声明里的 none 本就被拒）
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.config.modelConfigRules.providerModelRules.find((x) => x.modelId === "gemini-3.8-flash"), undefined);   // 探测不新建规则（防与 applyModels 双写）
  const applied = await mp.applyModels("gem-relay", ["gemini-3.8-flash"]);
  assert.equal(applied.ok, true);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  const modelRule = after.config.modelConfigRules.providerModelRules.find((x) => x.modelId === "gemini-3.8-flash" && x.providerId === "gem-relay");
  assert.deepEqual(modelRule.config.optionSpecs.reasoningLevel.values, ["minimal", "low", "medium", "high", "max"]);   // applyModels 按修复后元数据落盘
});

/* ---------- v312 输入类型/模型能力自动匹配：目录一致性收割 + 确认流正证据实测 ---------- */

test("catalog agreement: ambiguous multi-provider hits resolve only when all agree", () => {
  const entries = M.catalogEntries({
    "a/flash-x": { id: "flash-x", modalities: { input: ["text", "image", "pdf"], output: ["text"] }, tool_call: false },
    "b/flash-x": { id: "flash-x", modalities: { input: ["text", "image", "pdf"], output: ["text"] }, tool_call: false },
  });
  assert.equal(entries.length, 2);
  assert.equal(M.matchCatalogEntry(entries, "flash-x"), null);   // 逐条匹配仍守歧义
  const caps = M.agreedCapabilities(entries, "flash-x");
  assert.deepEqual(caps.inputFormat, { supportsImage: true, supportsVideo: false, supportsAudio: false, supportsPdf: true });
  assert.equal(caps.supportsToolCall, false);   // 显式 false 负证据采纳
  assert.equal(caps.supportsJsonSchemaOutput, undefined);   // 目录缺字段不猜
  const disagree = M.catalogEntries({
    "a/flash-y": { id: "flash-y", modalities: { input: ["text"], output: ["text"] } },
    "b/flash-y": { id: "flash-y", modalities: { input: ["text", "image"], output: ["text"] } },
  });
  assert.equal(M.agreedCapabilities(disagree, "flash-y").inputFormat, undefined);   // 分歧放弃
  const gap = M.catalogEntries({
    "a/flash-z": { id: "flash-z", modalities: { input: ["text", "pdf"], output: ["text"] } },
    "b/flash-z": { id: "flash-z", tool_call: true },   // 一条缺模态证据：该字段整体放弃（tool_call 一致 false/true 与模态互不影响）
  });
  assert.equal(M.agreedCapabilities(gap, "flash-z").inputFormat, undefined);
});

test("capability probes write positive evidence only; explicit user false is never overridden", async () => {
  const file = tmpCfgPath();
  writeCfg(file, auxProbeCfg());
  const kinds = [];
  const { mp, calls } = probePuller(file, (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.tools) { kinds.push("toolHistory"); return { ok: true, status: 200 }; }
    if (Array.isArray(body.messages) && body.messages.length === 3) { kinds.push("midConv"); return { ok: true, status: 200 }; }
    if (body.response_format) { kinds.push("jsonSchema"); return { ok: true, status: 200 }; }
    if (Array.isArray(body.messages) && Array.isArray(body.messages[0].content)) { kinds.push("image"); return { ok: true, status: 200 }; }
    kinds.push(body.reasoning_effort === undefined ? "base" : "aux");
    return { ok: true, status: 200 };
  });
  const r = await mp.probeModel("gem-relay", "gemini-3.8-flash", { caps: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.capabilitiesFixed, ["image", "jsonSchema", "midConv"]);
  assert.equal(r.warnings, undefined);   // stub 全 200：工具历史正常
  assert.deepEqual(kinds, ["base", "aux", "image", "jsonSchema", "midConv", "toolHistory"]);   // 顺序契约（v313 末位工具历史探测）
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const modelRule = saved.config.modelConfigRules.providerModelRules.find((x) => x.modelId === "gemini-3.8-flash" && x.providerId === "gem-relay");
  assert.equal(modelRule.config.properties.inputFormat.supportsImage, true);
  assert.equal(modelRule.config.properties.supportsJsonSchemaOutput, true);
  assert.equal(modelRule.config.properties.supportsMidConversationSystem, true);
  assert.equal(modelRule.config.properties.supportsToolCall, undefined);

  // 用户显式 false 不被覆盖；已证实的字段不再重复探测
  const cfg2 = JSON.parse(fs.readFileSync(file, "utf8"));
  cfg2.config.modelConfigRules.providerModelRules[0].config.properties.supportsJsonSchemaOutput = false;
  writeCfg(file, cfg2);
  const seen2 = [];
  const mp2 = M.createModelPuller({
    customCfgPath: file, fetchImpl: async (url, opts) => {
      const body = JSON.parse(opts.body);
      seen2.push(body.tools ? "toolHistory" : body.response_format ? "jsonSchema" : (Array.isArray(body.messages) && body.messages.length === 3) ? "midConv" : Array.isArray(body.messages) && Array.isArray(body.messages[0].content) ? "image" : "other");
      return { ok: true, status: 200 };
    }, modelsDevUrl: MODELS_DEV_TEST_URL,
  });
  const r2 = await mp2.probeModel("gem-relay", "gemini-3.8-flash", { caps: true });
  assert.equal(r2.capabilitiesFixed, undefined);   // image/midConv 已在规则、jsonSchema 用户显式 false：正证据全部跳过
  assert.deepEqual(seen2, ["other", "other", "toolHistory"]);   // base+aux 计 other；仅剩 toolHistory 警告级探测（无 fetchCache 会话不去重）
  const saved2 = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved2.config.modelConfigRules.providerModelRules[0].config.properties.supportsJsonSchemaOutput, false);
});

test("capability probes fail open: 4xx/network writes nothing", async () => {
  const file = tmpCfgPath();
  writeCfg(file, auxProbeCfg());
  const { mp } = probePuller(file, (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.tools) return { ok: true, status: 200 };   // 工具历史正常
    if (Array.isArray(body.messages) && body.messages.length === 3) return { ok: false, status: 400, text: async () => "bad" };
    if (body.response_format) return { ok: true, status: 200 };
    if (Array.isArray(body.messages) && Array.isArray(body.messages[0].content)) throw new Error("ECONNRESET");
    return { ok: true, status: 200 };
  });
  const r = await mp.probeModel("gem-relay", "gemini-3.8-flash", { caps: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.capabilitiesFixed, ["jsonSchema"]);   // 只有正证据项写入
  assert.equal(r.warnings, undefined);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const modelRule = saved.config.modelConfigRules.providerModelRules.find((x) => x.modelId === "gemini-3.8-flash");
  assert.equal(modelRule.config.properties.inputFormat, undefined);   // 图片探测网络失败：不写
  assert.equal(modelRule.config.properties.supportsMidConversationSystem, undefined);   // 400：不写
  assert.equal(modelRule.config.properties.supportsJsonSchemaOutput, true);
});

test("capability probes only run with the caps flag and only for chat-completions", async () => {
  const file = tmpCfgPath();
  writeCfg(file, auxProbeCfg());
  let capRequests = 0;
  const { mp } = probePuller(file, (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.response_format || (Array.isArray(body.messages) && (body.messages.length === 3 || Array.isArray(body.messages[0].content)))) capRequests++;
    return { ok: true, status: 200 };
  });
  await mp.probeModel("gem-relay", "gemini-3.8-flash");   // 无 caps 标志
  assert.equal(capRequests, 0);
  // 未落盘模型 + 无拉取会话：无处写实，不虚报
  const r = await mp.probeModel("gem-relay", "un-added-model", { caps: true });
  assert.equal(r.ok, true);
  assert.equal(r.capabilitiesFixed, undefined);
});

test("tool-history probe: channel rejection warns without writing config; session-deduped", async () => {
  const file = tmpCfgPath();
  writeCfg(file, auxProbeCfg());
  let toolHistoryCalls = 0;
  const mp = M.createModelPuller({
    customCfgPath: file, modelsDevUrl: MODELS_DEV_TEST_URL,
    fetchImpl: async (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      if (url === MODELS_DEV_TEST_URL) return { ok: true, status: 200, json: async () => ({}) };
      if (url.endsWith("/v1/models")) return { ok: true, status: 200, json: async () => ({ data: ["gemini-3.8-flash"] }) };   // 预热 fetchCache（拉取会话）
      if (body && body.tools) {
        toolHistoryCalls++;
        return { ok: false, status: 400, text: async () => '{"error":{"code":"400001","message":"Invalid request parameters."}}' };
      }
      return { ok: true, status: 200 };
    },
  });
  await mp.fetchModels("gem-relay");
  const r1 = await mp.probeModel("gem-relay", "gemini-3.8-flash", { caps: true });
  assert.equal(r1.ok, true);   // 模型本身可达，警告不判失败
  assert.deepEqual(r1.warnings, ["toolHistory"]);
  assert.deepEqual(r1.capabilitiesFixed, ["image", "jsonSchema", "midConv"]);   // 正证据项照常实测写入
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const modelRule = saved.config.modelConfigRules.providerModelRules.find((x) => x.modelId === "gemini-3.8-flash");
  assert.equal(modelRule.config.properties.supportsJsonSchemaOutput, true);   // 正证据落盘
  assert.equal(modelRule.config.properties.supportsToolCall, undefined);   // 警告性质：toolHistory 绝不写配置（supportsToolCall:false 会让宿主对带工具请求直接报错）
  const r2 = await mp.probeModel("gem-relay", "gemini-3.8-flash", { caps: true });
  assert.equal(toolHistoryCalls, 1, "探测结论按拉取会话去重（fetchCache 标记）");
  assert.deepEqual(r2.warnings, ["toolHistory"]);   // 去重后仍回放缓存结论
});

test("fetchModels merges agreed capabilities into meta; applyModels persists them", async () => {
  const file = tmpCfgPath();
  writeCfg(file, auxProbeCfg());
  const mp = M.createModelPuller({
    customCfgPath: file,
    modelsDevUrl: MODELS_DEV_TEST_URL,
    fetchImpl: async (url, opts) => {
      if (url === MODELS_DEV_TEST_URL) {
        return { ok: true, status: 200, json: async () => ({
          "a/gem-amb": { id: "gem-amb", modalities: { input: ["text", "image", "pdf"], output: ["text"] }, tool_call: false },
          "b/gem-amb": { id: "gem-amb", modalities: { input: ["text", "image", "pdf"], output: ["text"] }, tool_call: false },
        }) };
      }
      if (url.endsWith("/v1/models")) return { ok: true, status: 200, json: async () => ({ data: ["gem-amb"] }) };
      return { ok: true, status: 200 };
    },
  });
  const r = await mp.fetchModels("gem-relay");
  assert.equal(r.ok, true);
  const meta = r.metaById["gem-amb"];
  assert.deepEqual([meta.inputFormat.supportsImage, meta.inputFormat.supportsPdf, meta.supportsToolCall], [true, true, false]);
  const applied = await mp.applyModels("gem-relay", ["gem-amb"]);
  assert.equal(applied.ok, true);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const modelRule = saved.config.modelConfigRules.providerModelRules.find((x) => x.modelId === "gem-amb" && x.providerId === "gem-relay");
  assert.equal(modelRule.config.properties.inputFormat.supportsPdf, true);
  assert.equal(modelRule.config.properties.supportsToolCall, false);
});

/* ---------- v314 规格补全：确认流用拉取会话元数据回填缺失的窗口/输出上限 ---------- */

test("spec enrichment backfills missing contextWindow/maxOutputTokens; never overwrites", async () => {
  const file = tmpCfgPath();
  writeCfg(file, auxProbeCfg());
  const mp = M.createModelPuller({
    customCfgPath: file, modelsDevUrl: MODELS_DEV_TEST_URL,
    fetchImpl: async (url, opts) => {
      if (url === MODELS_DEV_TEST_URL) return { ok: true, status: 200, json: async () => ({}) };
      if (url.endsWith("/v1/models")) return { ok: true, status: 200, json: async () => ({ data: [{ id: "gemini-3.8-flash", limit: { context: 1048576, output: 65536 } }] }) };
      return { ok: true, status: 200 };
    },
  });
  await mp.fetchModels("gem-relay");   // 拉取会话建立 meta（1048576/65536）
  const r = await mp.probeModel("gem-relay", "gemini-3.8-flash", { caps: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.specEnriched, ["contextWindow", "maxOutputTokens"]);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const modelRule = saved.config.modelConfigRules.providerModelRules.find((x) => x.modelId === "gemini-3.8-flash");
  assert.equal(modelRule.config.properties.contextWindow, 1048576);
  assert.equal(modelRule.config.optionSpecs.maxOutputTokens.max, 65536);   // 89642 事故的回归锁：baseline 不再落内置 128000
  assert.equal(modelRule.config.optionSpecs.reasoningLevel, undefined);   // 不越权动其它键

  // 已写值不覆盖（append-only 语义延展到补全）：窗口已有值保持，仅回填缺失的输出上限
  const before = JSON.parse(fs.readFileSync(file, "utf8"));
  const rule0 = before.config.modelConfigRules.providerModelRules.find((x) => x.modelId === "gemini-3.8-flash");
  rule0.config.properties.contextWindow = 128000;   // 用户侧已写：绝不覆盖
  delete rule0.config.optionSpecs.maxOutputTokens;
  writeCfg(file, before);
  const r2 = await mp.probeModel("gem-relay", "gemini-3.8-flash", { caps: true });
  assert.deepEqual(r2.specEnriched, ["maxOutputTokens"]);
  const saved2 = JSON.parse(fs.readFileSync(file, "utf8"));
  const rule2 = saved2.config.modelConfigRules.providerModelRules.find((x) => x.modelId === "gemini-3.8-flash");
  assert.equal(rule2.config.properties.contextWindow, 128000);   // 中转报告值不被目录 1M 覆盖
  assert.equal(rule2.config.optionSpecs.maxOutputTokens.max, 65536);
});
