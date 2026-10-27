/* 模型拉取（v129/v130）：为宿主自定义供应商一键拉取 /models 列表并写回 provider_config.json。
 * 基础功能收编自 HHQ-666/zcode-model-puller（MIT）；v130 算法吸收 GLQQX/zcode-model-discovery-patch
 * 与 linguo2625469/zcode-patcher：模型 id/上下文/输出/模态/思考档位的字段别名全集、
 * models.dev 公共目录补缺（只下载公开目录本地匹配，不发送 key 与模型名）、按模型写实
 * providerModelRules config（contextWindow/inputFormat/reasoningLevel/maxOutputTokens，
 * 字段名对照宿主 packages/shared/src/model-config.ts 的 strict zod schema；模板已有
 * 自洽结构（带 map 表达式）时不覆盖，无据可依的字段保持模板原样）。
 * 只读写宿主 customCfgPath（~/.zcode/v2/provider_config.json）；key 只在主进程内存中用于
 * 该 baseUrl 本域请求，绝不返回渲染端、不进日志。写入是读-改-同目录原子替换，保留未知键；
 * 写前滚动备份 .zusage-bak（单文件覆盖，不堆积）。拉取耗时对齐 cc-switch：目录只在供应商完成后
 * 宽限 1s 内搭车（cc-switch 拉列表不等目录），失败另有 10 分钟短缓存，均不拖慢弹窗。 */
"use strict";
const fs = require("fs");
const path = require("path");

const MAX_MODELS = 512;      // 单次写入与单次拉取的模型数上限，防异常网关返回巨列表撑爆弹窗
const MODEL_ID_MAX = 200;    // 单个模型 id 长度上限（含控制字符的 id 直接丢弃）
const FETCH_TIMEOUT_MS = 10000;
const MODELS_DEV_URL = "https://models.dev/models.json";   // 公共模型元数据目录（GLQQX 同源）
const MODELS_DEV_TIMEOUT_MS = 3000;   // 目录是锦上添花：超时收紧，不通的网络尽早降级
const CATALOG_GRACE_MS = 1000;        // 供应商响应后目录的额外宽限：cc-switch 拉列表不等目录，我们不拖慢主路径
const EFFORTS_MAX = 16;      // 思考档位数上限：宿主 values 无词表校验，防网关透传巨数组
const CATALOG_CACHE_MAX = 32;
const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;   // /models 与目录响应的解析上限（models.dev 全量约 1-2MB）

function sanitizeModelIds(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || id.length > MODEL_ID_MAX || /[\x00-\x1f\x7f]/.test(id)) continue;
    if (!out.includes(id)) out.push(id);
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

/* ---------- 元数据提取（GLQQX normalizeModel 的字段别名全集，字段级保守） ---------- */
function asObject(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
function positiveInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
function firstPositive(...vals) {
  for (const v of vals) { const n = positiveInt(v); if (n) return n; }
  return 0;
}
function modalityList(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const m = item.trim().toLowerCase();
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}
/* OpenRouter/models.dev 风格：architecture.input_modalities / input_modalities / modalities.input */
function rawInputModalities(src) {
  return modalityList(asObject(src.architecture).input_modalities) || modalityList(src.input_modalities)
    || modalityList(asObject(src.modalities).input);
}
function rawVisionFlag(src) {
  for (const v of [src.vision, src.supports_vision, asObject(src.architecture).vision]) {
    if (typeof v === "boolean") return v;
  }
  return undefined;
}
/* 从 /models 条目提取可信元数据；字符串条目只有 id。字段缺失一律 undefined，由调用方
 * 用目录补缺——绝不编造默认值（zcode-patcher 的假 1M/128k 模板会误导用户，不采用）。 */
/* 模型 id 别名链（cc-switch catalog_model_ids 同源）：id → slug（智谱 Responses 目录
 * {models:[{slug}]}）→ modelId → name/model（Google Gemini 风格 "models/xxx" 剥前缀） */
function rawModelId(src) {
  let v = src.id;
  if (typeof v === "string" && v.trim()) return v;
  v = src.slug;
  if (typeof v === "string" && v.trim()) return v;
  v = src.modelId;
  if (typeof v === "string" && v.trim()) return v;
  const tail = [src.name, src.model];
  for (let i = 0; i < tail.length; i++) {
    if (typeof tail[i] === "string" && tail[i].trim()) return tail[i].replace(/^models\//, "");
  }
  return "";
}
function extractModelMeta(item) {
  if (typeof item === "string") {
    return { id: item.trim(), contextWindow: 0, maxOutputTokens: 0, modalities: null, vision: undefined, efforts: [] };
  }
  const src = asObject(item);
  const rawId = rawModelId(src);
  const id = typeof rawId === "string" ? rawId.trim() : "";
  const ctx = firstPositive(src.context_length, src.contextWindow, src.context_window,
    asObject(src.limit).context, asObject(src.limits).context);
  const out = firstPositive(src.max_completion_tokens, src.max_output_tokens, src.maxOutputTokens,
    asObject(src.limit).output, asObject(src.limits).output,
    asObject(src.top_provider).max_completion_tokens);
  const modalities = rawInputModalities(src);
  const vision = rawVisionFlag(src);
  const efforts = (Array.isArray(src.supported_efforts) ? src.supported_efforts : [])
    .filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim())
    .filter((x, i, a) => a.indexOf(x) === i).slice(0, EFFORTS_MAX);
  return { id, contextWindow: ctx, maxOutputTokens: out, modalities, vision, efforts };
}

/* ---------- models.dev 目录（GLQQX）：id 精确匹配 → basename 唯一匹配 ---------- */
function canonicalBasename(value) {
  const segments = String(value ?? "").trim().toLowerCase().split("/").filter(Boolean);
  let basename = segments[segments.length - 1] || "";
  while (/^(?:gcli|go)-/.test(basename)) basename = basename.replace(/^(?:gcli|go)-/, "");
  return basename;
}
function catalogEntries(payload) {
  const out = [];
  for (const [key, value] of Object.entries(asObject(payload))) {
    const model = asObject(value);
    if (!Object.keys(model).length) continue;
    const rawId = model.id ?? model.modelId ?? model.name ?? model.model;
    const id = (typeof rawId === "string" ? rawId : key).trim();
    if (!id) continue;
    out.push({ identities: [...new Set([key.trim().toLowerCase(), id.toLowerCase()])], basename: canonicalBasename(id), model });
  }
  return out;
}
function matchCatalogEntry(entries, id) {
  const normalized = String(id).trim().toLowerCase();
  const exact = entries.filter((e) => e.identities.includes(normalized));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const basename = canonicalBasename(id);
  if (!basename) return null;
  const byBase = entries.filter((e) => e.basename === basename);
  return byBase.length === 1 ? byBase[0] : null;
}

/* 模态/视觉布尔 → 宿主 inputFormat 稀疏位（支持与否都写实；text 是缺省前提不写）。
 * 列表来源与布尔来源都没有时返回 null（无据不写）。 */
function inputFormatFrom(modalities, vision) {
  if (Array.isArray(modalities)) {
    const has = (m) => modalities.includes(m);
    return {
      supportsImage: has("image") || has("vision"),
      supportsVideo: has("video"),
      supportsAudio: has("audio"),
      supportsPdf: has("pdf"),
    };
  }
  if (typeof vision === "boolean") return { supportsImage: vision };
  return null;
}

/* 已知的「Anthropic 协议兼容子路径」后缀（cc-switch 同表，声明序即匹配优先级）；
 * baseURL 命中时追加剥离后缀再拼 /v1/models、/models 的候选（DeepSeek/Kimi/智谱 GLM 等
 * 把 Anthropic 协议挂在兼容子路径上，模型列表只在根路径下提供）。 */
const COMPAT_SUFFIXES = ["/api/claudecode", "/api/anthropic", "/apps/anthropic", "/api/coding",
  "/claudecode", "/anthropic", "/step_plan", "/coding", "/claude"];
function endsWithVersionSegment(url) {
  const last = url.slice(url.lastIndexOf("/") + 1);
  return /^v\d+$/.test(last);
}
/* 候选端点（吸收 cc-switch model_fetch.rs）：base 以任意版本段 /v{N} 结尾（/v1、智谱
 * /api/coding/paas/v4）→ {base}/models（版本号已在路径中，再补 /v1 必 404），版本段非
 * /v1 时追加 {base}/v1/models 作次候选；其余 → {base}/v1/models、{base}/models（保守
 * 兜底，我们面对的中转形态更杂）。命中兼容子路径时追加剥离后缀的两组；/apps/anthropic
 * 另追加阿里百炼的 /compatible-mode/v1/models。去重保序。 */
function candidateUrls(baseUrl) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return [];
  const out = [];
  if (endsWithVersionSegment(base)) {
    out.push(base + "/models");
    if (!/\/v1$/.test(base)) out.push(base + "/v1/models");
  } else {
    out.push(base + "/v1/models");
    out.push(base + "/models");
  }
  let stripped = null;
  for (let i = 0; i < COMPAT_SUFFIXES.length; i++) {
    if (base.length > COMPAT_SUFFIXES[i].length && base.endsWith(COMPAT_SUFFIXES[i])) {
      stripped = base.slice(0, base.length - COMPAT_SUFFIXES[i].length);
      break;
    }
  }
  if (stripped) {
    out.push(stripped + "/v1/models");
    out.push(stripped + "/models");
    if (base.endsWith("/apps/anthropic")) out.push(stripped + "/compatible-mode/v1/models");
  }
  const uniq = [];
  for (let j = 0; j < out.length; j++) if (uniq.indexOf(out[j]) < 0) uniq.push(out[j]);
  return uniq;
}

/* 供应商条目与目录条目字段级合并：供应商优先，目录只补缺（GLQQX 语义） */
function mergedMeta(providerMeta, catalogModel) {
  const cat = catalogModel ? extractModelMeta(catalogModel) : {};
  const inputFormat = inputFormatFrom(providerMeta.modalities, providerMeta.vision)
    || inputFormatFrom(cat.modalities, cat.vision);
  const meta = {};
  const ctx = providerMeta.contextWindow || cat.contextWindow;
  const out = providerMeta.maxOutputTokens || cat.maxOutputTokens;
  if (ctx) meta.contextWindow = ctx;
  if (out) meta.maxOutputTokens = out;
  if (inputFormat) meta.inputFormat = inputFormat;
  if (providerMeta.efforts.length) meta.efforts = providerMeta.efforts;
  return meta;
}

/* 响应体限长读取：异常网关的巨 JSON 不全量进内存（undici 流式读，超限中止）；
 * 无流（测试 stub / 旧运行时）回退整读。 */
async function readJsonBounded(res, maxBytes) {
  const reader = res && res.body && typeof res.body.getReader === "function" ? res.body.getReader() : null;
  if (!reader) return res.json();
  const chunks = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.length;
    if (total > maxBytes) {
      try { reader.cancel(); } catch (e) { }
      throw new Error("payload too large");
    }
    chunks.push(chunk.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function createModelPuller(opts) {
  const o = opts || {};
  const customCfgPath = String(o.customCfgPath || "");
  const log = o.log || function () { };
  const fetchImpl = o.fetchImpl || (typeof fetch === "function" ? fetch : null);
  const modelsDevUrl = o.modelsDevUrl === undefined ? MODELS_DEV_URL : String(o.modelsDevUrl);
  let applyBusy = false;   // 读-改-写竞态闸：UI 正常路径不会并发，这里防异常路径双写互相覆盖
  let catalogCache = null;   // {at, entries}：目录全量约数百 KB，成功后进程内复用
  let catalogFailedAt = 0;   // 目录失败短缓存：不通的网络环境（代理断连）每次拉取都吃满超时不可接受
  const fetchCache = new Map();   // providerId → {metaById}：applyModels 只收 id（写入字段不受渲染端注入），metaById 仅供弹窗展示

  function readProviderCfg() {
    try {
      const d = JSON.parse(fs.readFileSync(customCfgPath, "utf8"));
      if (!d || typeof d !== "object") return null;
      return d;
    } catch (e) { return null; }
  }
  function rulesOf(data) {
    return (((data || {}).config || {}).providerConfigRules || {}).providerRules || [];
  }
  function declaredModelIds(pcfg) {
    const ids = [];
    for (const key of ["personalModelIds", "modelOrder"]) {
      for (const mid of (pcfg && pcfg[key]) || []) {
        if (typeof mid === "string" && mid.trim() && !ids.includes(mid)) ids.push(mid);
      }
    }
    return ids;
  }
  /* api-key 型自定义供应商才可拉取/写入；coding-plan 型的 baseUrl/模型由宿主管 */
  function isPullable(rule) {
    const cfg = (rule && rule.config) || {};
    const access = cfg.access || {}, api = cfg.api || {};
    return access.type === "api-key" && !!api.baseUrl;
  }
  function providerView(rule) {
    const cfg = rule.config || {};
    const access = cfg.access || {}, api = cfg.api || {};
    return {
      id: String(rule.providerId || ""),
      name: String(rule.providerName || ""),
      baseUrl: String(api.baseUrl || "").replace(/\/+$/, ""),
      hasKey: !!access.apiKey,
      modelIds: declaredModelIds(cfg),
    };
  }
  function findRule(data, providerId) {
    for (const rule of rulesOf(data)) {
      if (rule && String(rule.providerId || "") === providerId) return rule;
    }
    return null;
  }
  function dropBody(res) {
    /* 非 ok 响应不读 body 时显式取消：undici 下未消费的 body 会使连接滞留池外直至 GC
     * （长驻主进程反复拉取会累积）；与 readJsonBounded 超限 cancel 同一卫生语义 */
    try { if (res && res.body && typeof res.body.cancel === "function") res.body.cancel(); } catch (e) { }
  }
  function fetchJson(url, headers, timeoutMs) {
    if (!fetchImpl) return Promise.resolve(null);
    return fetchImpl(url, { headers: headers, signal: AbortSignal.timeout(timeoutMs) })
      .then((res) => {
        if (res && res.ok) return readJsonBounded(res, RESPONSE_MAX_BYTES);
        dropBody(res);
        return null;
      })
      .catch(() => null);
  }
  function loadCatalog() {
    if (!fetchImpl || !modelsDevUrl) return Promise.resolve([]);
    if (catalogCache && Date.now() - catalogCache.at < 3600000) return Promise.resolve(catalogCache.entries);
    if (catalogFailedAt && Date.now() - catalogFailedAt < 600000) return Promise.resolve([]);   // 失败 10 分钟内不再重试（零等待降级）
    return fetchJson(modelsDevUrl, { "Accept": "application/json" }, MODELS_DEV_TIMEOUT_MS).then((payload) => {
      const entries = payload ? catalogEntries(payload) : [];
      if (entries.length) catalogCache = { at: Date.now(), entries: entries };
      else catalogFailedAt = Date.now();
      return entries;
    });
  }

  function listProviders() {
    const data = readProviderCfg();
    if (!data) return { ok: false, error: "provider config missing or unreadable", providers: [] };
    const seen = new Set(), providers = [];
    for (const rule of rulesOf(data)) {
      if (!rule || !rule.providerId || !isPullable(rule)) continue;
      const id = String(rule.providerId);
      if (seen.has(id)) continue;   // 同 id 取首条（宿主写入自身去重，防御性跳过重复项）
      seen.add(id);
      providers.push(providerView(rule));
    }
    return { ok: true, providers: providers };
  }

  async function fetchModels(providerId) {
    const data = readProviderCfg();
    const rule = data ? findRule(data, providerId) : null;
    if (!rule || !isPullable(rule)) return { ok: false, error: "provider not found" };
    const apiKey = String(((rule.config || {}).access || {}).apiKey || "").trim();
    const urls = candidateUrls((rule.config || {}).api.baseUrl);
    if (!fetchImpl) return { ok: false, error: "no network stack" };
    const headers = { "Accept": "application/json", "User-Agent": "ZCode" };
    if (apiKey) { headers["Authorization"] = "Bearer " + apiKey; headers["x-api-key"] = apiKey; }
    /* 目录与供应商请求并行；目录只在供应商完成后最多宽限 CATALOG_GRACE_MS——它是行内
     * 小字的锦上添花，绝不拖慢弹窗（cc-switch 拉列表不等目录，同款取舍） */
    const catalogPromise = loadCatalog();
    const catalogGrace = new Promise((resolve) => setTimeout(resolve, CATALOG_GRACE_MS));
    let lastError = "no candidate endpoint succeeded";
    let items = null, via = "";
    for (const url of urls) {
      try {
        const res = await fetchImpl(url, { headers: headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) {
          lastError = "HTTP " + res.status;
          dropBody(res);
          /* 404/405=路径不对才换下一候选；401/403/5xx 是凭据或服务端问题，换路径无意义
           * （cc-switch 同款，避免每个候选各等一个超时） */
          if (res.status !== 404 && res.status !== 405) return { ok: false, error: lastError };
          continue;
        }
        const body = await readJsonBounded(res, RESPONSE_MAX_BYTES);
        const list = Array.isArray(body) ? body
          : asObject(body).data || asObject(body).models || asObject(body).result || null;
        if (!Array.isArray(list)) { lastError = "no models in response"; continue; }
        items = list; via = url;
        break;
      } catch (e) {
        lastError = (e && e.name === "TimeoutError") ? "timeout" : "request failed";
      }
    }
    if (!items) return { ok: false, error: lastError };
    const entries = await Promise.race([catalogPromise, catalogGrace.then(() => (catalogCache ? catalogCache.entries : []))]);
    const ids = [], metaById = Object.create(null);   // null 原型：模型 id 来自远端，"__proto__" 等键必须可写
    for (const item of items) {
      const pm = extractModelMeta(item);
      if (!pm.id || pm.id.length > MODEL_ID_MAX || /[\x00-\x1f\x7f]/.test(pm.id)) continue;
      if (ids.includes(pm.id)) continue;
      const hit = entries.length ? matchCatalogEntry(entries, pm.id) : null;
      const meta = mergedMeta(pm, hit ? hit.model : null);
      if (Object.keys(meta).length) metaById[pm.id] = meta;
      ids.push(pm.id);
      if (ids.length >= MAX_MODELS) break;
    }
    if (!ids.length) return { ok: false, error: "no models in response" };
    ids.sort();
    fetchCache.set(providerId, { metaById: metaById });
    if (fetchCache.size > CATALOG_CACHE_MAX) fetchCache.delete(fetchCache.keys().next().value);
    return { ok: true, models: ids, metaById: metaById, via: via };
  }

  function writeProviderCfg(data) {
    const file = customCfgPath;
    /* tmp 名带 pid：applyBusy 只约束本进程，双 ZCode 实例共享 HOME 时防同路径交错写 */
    const tmp = file + ".zusage-tmp-" + process.pid;
    let mode = 0o600;
    try { mode = fs.statSync(file).mode & 0o777; } catch (e) { }
    try {
      fs.copyFileSync(file, file + ".zusage-bak");   // 滚动备份：失败不阻塞写入（原子替换本身安全）
    } catch (e) { log("backup failed:", e.message); }
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: mode });
      fs.renameSync(tmp, file);
      try { fs.chmodSync(file, mode); } catch (e2) { /* Windows/权限失败忽略：tmp 已按原 mode 创建 */ }
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { }
      throw e;
    }
  }

  /* 模板丰富度评分：维度越多越适合做新模型的填充来源 */
  function templateScore(config) {
    let n = 0;
    const props = config && config.properties;
    if (props) {
      if (props.contextWindow) n++;
      const fmt = props.inputFormat;
      if (fmt) for (const k of ["supportsImage", "supportsVideo", "supportsAudio", "supportsPdf"]) if (fmt[k]) n++;
      for (const k of ["supportsToolCall", "supportsJsonSchemaOutput", "supportsNativeWebSearch", "supportsMidConversationSystem"]) if (props[k]) n++;
    }
    const specs = config && config.optionSpecs;
    if (specs) {
      if (specs.reasoningLevel && Array.isArray(specs.reasoningLevel.values) && specs.reasoningLevel.values.length) n += 2;
      if (specs.maxOutputTokens && specs.maxOutputTokens.max) n++;
    }
    return n;
  }

  /* 按模型写实 config：以同供应商模板为底（保证 strict 校验），仅覆盖有依据的字段；
   * 模板已带 map 表达式的 optionSpecs 是与档位名自洽的整体，不覆盖（防 values 换名后 map 失配）。
   * 元数据来自主进程 fetchCache（applyModels 只收 id，渲染端无法注入任意 config 字段）。
   * 其余键、其余供应商一律原样保留。写入对象含 key，任何返回/日志不携带配置内容。 */
  function entryWithMeta(entry, meta) {
    if (!meta) return entry;
    const props = entry.properties && typeof entry.properties === "object" && !Array.isArray(entry.properties)
      ? entry.properties : (entry.properties = {});
    if (meta.contextWindow) props.contextWindow = meta.contextWindow;
    if (meta.inputFormat) {
      const fmt = props.inputFormat && typeof props.inputFormat === "object" && !Array.isArray(props.inputFormat)
        ? props.inputFormat : (props.inputFormat = {});
      Object.assign(fmt, meta.inputFormat);
    }
    if (meta.maxOutputTokens || meta.efforts) {
      const specs = entry.optionSpecs && typeof entry.optionSpecs === "object" && !Array.isArray(entry.optionSpecs)
        ? entry.optionSpecs : (entry.optionSpecs = {});
      if (meta.maxOutputTokens) {
        const limit = specs.maxOutputTokens && typeof specs.maxOutputTokens === "object"
          ? specs.maxOutputTokens : (specs.maxOutputTokens = {});
        if (typeof limit.map !== "string") limit.max = meta.maxOutputTokens;   // 带 map 的自洽结构不动
      }
      if (meta.efforts) {
        const level = specs.reasoningLevel && typeof specs.reasoningLevel === "object"
          ? specs.reasoningLevel : (specs.reasoningLevel = {});
        if (typeof level.map !== "string") level.values = meta.efforts.slice();
      }
    }
    return entry;
  }

  async function applyModels(providerId, models) {
    const wanted = sanitizeModelIds(models);
    if (!wanted.length) return { ok: false, error: "no valid models" };
    if (applyBusy) return { ok: false, error: "another write is in progress" };
    applyBusy = true;
    try {
      const data = readProviderCfg();
      const rule = data ? findRule(data, providerId) : null;
      if (!rule || !isPullable(rule)) return { ok: false, error: "provider not found" };
      const pcfg = rule.config || (rule.config = {});
      const personal = Array.isArray(pcfg.personalModelIds) ? pcfg.personalModelIds.filter((m) => typeof m === "string") : [];
      const order = Array.isArray(pcfg.modelOrder) ? pcfg.modelOrder.filter((m) => typeof m === "string") : [];
      const declared = new Set(declaredModelIds(pcfg));
      const adding = wanted.filter((m) => !declared.has(m));
      if (!adding.length) return { ok: true, added: 0 };
      if (personal.length + adding.length > MAX_MODELS || order.length + adding.length > MAX_MODELS) {
        return { ok: false, error: "too many models" };
      }
      for (const mid of adding) {
        if (!personal.includes(mid)) personal.push(mid);
        if (!order.includes(mid)) order.push(mid);
      }
      pcfg.personalModelIds = personal;
      pcfg.modelOrder = order;
      const mcr = data.config && data.config.modelConfigRules;
      const rules = mcr && Array.isArray(mcr.providerModelRules) ? mcr.providerModelRules : null;
      if (rules && mcr && typeof mcr === "object") {
        if (!Array.isArray(mcr.manualProviderModelRules)) mcr.manualProviderModelRules = [];
        const siblings = rules.filter((r) => r && typeof r === "object" && String(r.providerId || "") === providerId && r.config && typeof r.config === "object");
        if (siblings.length) {
          const cache = fetchCache.get(providerId);
          /* 模板取配置最丰富的兄弟（用户手动配全的那条），不是最后一条——最后一条可能恰好
           * 是贫瘠配置，复制后新模型看起来什么都没填（实测翻车：gpt-6.1-terra 继承 astra） */
          const template = siblings.reduce((best, r) => (templateScore(r.config) >= templateScore(best.config) ? r : best)).config;
          for (const mid of adding) {
            const entry = JSON.parse(JSON.stringify(template));
            rules.push({ modelId: mid, providerId: providerId, config: entryWithMeta(entry, cache ? cache.metaById[mid] : null) });
          }
        }
      }
      writeProviderCfg(data);
      log("added", adding.length, "models to provider", providerId);
      return { ok: true, added: adding.length };
    } finally {
      applyBusy = false;
    }
  }

  return { listProviders: listProviders, fetchModels: fetchModels, applyModels: applyModels };
}

/* 兼容导出：响应形状解析（OpenAI data / Ollama models / result / 顶层数组），供测试与
 * 消费方直接引用；fetchModels 内联使用同一形状集。 */
function parseModelsPayload(data) {
  if (Array.isArray(data)) return data;
  const obj = asObject(data);
  const list = [obj.data, obj.models, obj.result].find(Array.isArray);
  return Array.isArray(list) ? list : [];
}

module.exports = {
  createModelPuller, sanitizeModelIds, parseModelsPayload, candidateUrls,
  extractModelMeta, catalogEntries, matchCatalogEntry, inputFormatFrom, canonicalBasename,
  endsWithVersionSegment, rawModelId,
};
