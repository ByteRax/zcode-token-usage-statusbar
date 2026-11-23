/* 模型拉取（v129/v130）：为宿主自定义供应商一键拉取 /models 列表并写回 provider_config.json。
 * 基础功能收编自 HHQ-666/zcode-model-puller（MIT）；v130 算法吸收 GLQQX/zcode-model-discovery-patch
 * 与 linguo2625469/zcode-patcher：模型 id/上下文/输出/模态/思考档位的字段别名全集、
 * models.dev 公共目录补缺（只下载公开目录本地匹配，不发送 key 与模型名）、按模型写实
 * providerModelRules config（contextWindow/inputFormat/reasoningLevel/maxOutputTokens，
 * 字段名对照宿主 packages/shared/src/model-config.ts 的 strict zod schema；模板已有
 * 自洽结构（带 map 表达式）时不覆盖，无据可依的字段保持模板原样）。
 * issue #236：零兄弟 api-key 供应商首拉也写每模型最小骨架 {enabled:true}+有据元数据（稀疏
 * 个人规则字段级覆盖内置，map 继承宿主 apiType catch-all；绝不生成 map、绝不写
 * manualProviderModelRules）；档位按强度梯排序（宿主默认档=values 末项）；GitHub Copilot
 * capabilities 别名；models.dev api.json 档位目录（reasoning_options→effort 词表）只在缺
 * 档位证据时后台拉取补缺；套餐源接目录补缺。
 * v309 模型探测：「确认添加并保存」先探测后写入——按宿主同款 URL 语义（openai 两型不自动
 * 补 /v1、anthropic 归一化补 /v1）发最小对话请求，Base URL 少 /v1 这类错配在写入前原样
 * 暴露；结果按状态分类、错误摘录脱敏后回渲染端；修复成功才写配置，不走 candidateUrls。
 * 读写宿主 customCfgPath（~/.zcode/v2/provider_config.json）；只读宿主打包 builtinCfgPath
 * 的 templateRules（模板供应商的 baseUrl/protocol 来源）；key 只在主进程内存中用于
 * 该 baseUrl 本域请求，绝不返回渲染端、不进日志。写入是读-改-同目录原子替换，保留未知键；
 * 写前滚动备份 .zusage-bak（单文件覆盖，不堆积）。拉取耗时对齐 cc-switch：目录只在供应商完成后
 * 宽限 1s 内搭车（cc-switch 拉列表不等目录），失败另有 10 分钟短缓存，均不拖慢弹窗。 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHash, randomUUID } = require("crypto");

const MAX_MODELS = 512;      // 单次写入与单次拉取的模型数上限，防异常网关返回巨列表撑爆弹窗
const MODEL_ID_MAX = 200;    // 单个模型 id 长度上限（含控制字符的 id 直接丢弃）
const FETCH_TIMEOUT_MS = 10000;
const MODELS_DEV_URL = "https://models.dev/models.json";   // 公共模型元数据目录（GLQQX 同源）
const MODELS_DEV_TIMEOUT_MS = 3000;   // 目录是锦上添花：超时收紧，不通的网络尽早降级
const CATALOG_GRACE_MS = 1000;        // 供应商响应后目录的额外宽限：cc-switch 拉列表不等目录，我们不拖慢主路径
const MODELS_DEV_API_URL = "https://models.dev/api.json";   // 档位目录（#236）：models.json 无 effort 词表（实测 0/608），api.json 才有（约 6MB）
const MODELS_DEV_API_TIMEOUT_MS = 8000;   // 大体量只走后台：超时不阻塞任何用户路径
const API_CACHE_MAX_AGE_MS = 24 * 3600 * 1000;   // 档位索引缓存生命周期：≥24h 触发一次后台刷新（stale-while-revalidate）
const PROBE_TIMEOUT_MS = 15000;   // 单模型探测超时：聚合网关上游冷启动实测可达 10s+，太短会假报失败
const PROBE_SNIPPET_MAX = 200;    // 错误摘录回渲染端的长度上限（先脱敏再截断）

/* ---------- 内置套餐源（v134）：OAuth 型套餐的模型拉取 ----------
 * 智谱 Coding Plan 是宿主内置 OAuth 供应商（account:bigmodel-individual-coding-plan），
 * 不在 provider_config 的 api-key 规则里；凭据在宿主 credentials.json 加密存储
 * （oauth:bigmodel:access_token），运行端点默认 Anthropic（宿主
 * legacyZCodeConfigProviderReader 的 BIGMODEL_CODING_PLAN_ANTHROPIC_BASE_URL）。
 * cc-switch#3471 实证：OpenAI 普通端点（/api/paas/v4）与 Coding Plan（/api/coding/paas/v4）
 * 分离，套餐误用普通端点会 429——列模型三端点对套餐 token 均放行（实测），此处固定用与
 * 运行协议同源的 Anthropic models 端点。写入目标=套餐 personal 规则的
 * personalModelIds/modelOrder（宿主自身也写这两键，实测）；全新环境宿主尚未创建该规则时
 * （首次官方保存才隐式创建）按同构骨架自建（issue #226），id 按宿主官方规范大小写归一。 */
var PLAN_SOURCES = {
  /* fam 对齐 quota-client 的 HOST_ALT_CRED_KEYS（issue #393）：宿主 3.18+ 新式登录态下
   * credKey 旧平铺键整键缺席时按家族回退新式键（bigmodel→oauth:linked_bigmodel、
   * zai→oauth:zai_cn:access_token），取值统一走 planTokenOf。目录不变量：同 fam 条目
   * 共用同一 credKey（planListable 家族去重按 credKey，两划分当前恒重合）。 */
  "account:bigmodel-individual-coding-plan": {
    name: "BigModel Coding Plan",
    endpoint: "https://open.bigmodel.cn/api/anthropic/v1/models",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    fam: "bigmodel",
    credKey: "oauth:bigmodel:access_token",
    /* 增强链鉴权（v344，只说 bigmodel 家族的 messages 直连）：宿主对话走 v2/config.json 的
     * builtin provider options.apiKey（明文 key + anthropic 协议 + /api/anthropic，实测正常）；
     * credentials.json 的 OAuth access_token 直连 messages 端点被网关以 500「网络错误 code 1234」
     * 拒绝（stream 真/假、有无 UA 均复现）——bigmodel 增强鉴权用宿主同款 key，不再以 OAuth
     * access_token 作直连兜底（GLr 时代经 location 换发短时 token）。范围之外照旧走 OAuth：
     * zai 家族增强（planKeyOf：v2 key 优先、OAuth 兜底）与套餐模型列表/探测
     * （planTokenOf）仍用 OAuth access_token 直连。 */
    v2ConfigKey: "builtin:bigmodel-coding-plan",
  },
  /* issue #336（v345）：接入宿主其余 5 个套餐 id——增强链此前只认 bigmodel individual，
   * 其余套餐全部落 "provider not found"。端点/凭据同源宿主 config.json 的 builtin 条目
   * （options.baseURL / options.apiKey，宿主对话同款）；凭据取序沿用 planKeyOf 既有口径。
   * 注意：zai 团队条目与个人共享宿主 builtin:zai-coding-plan 凭据（宿主同款映射）；
   * start-plan 两条走 zcode.z.ai 网关（baseURL 取自宿主 config.json 实测值）。 */
  "account:zai-individual-coding-plan": {
    name: "Z.ai Coding Plan",
    endpoint: "https://api.z.ai/api/anthropic/v1/models",
    baseUrl: "https://api.z.ai/api/anthropic",
    fam: "zai",
    credKey: "oauth:zai:access_token",
    v2ConfigKey: "builtin:zai-coding-plan",
  },
  "account:zai-team-coding-plan": {
    name: "Z.ai Coding Plan (team)",
    endpoint: "https://api.z.ai/api/anthropic/v1/models",
    baseUrl: "https://api.z.ai/api/anthropic",
    fam: "zai",
    credKey: "oauth:zai:access_token",
    v2ConfigKey: "builtin:zai-coding-plan",
  },
  "account:zai-start-plan": {
    name: "Z.ai Start Plan",
    endpoint: "https://api.z.ai/api/anthropic/v1/models",
    baseUrl: "https://api.z.ai/api/anthropic",
    fam: "zai",
    credKey: "oauth:zai:access_token",
    /* zai 家族 start-plan：凭据走 planKeyOf 统一口径（v2 key 优先、OAuth 兜底），
     * api.z.ai anthropic 端点未实测（无 zai 测试账号）——诚实尝试，失败按上游错误展示。 */
    v2ConfigKey: "builtin:zai-coding-plan",
  },
  "account:bigmodel-team-coding-plan": {
    name: "BigModel Coding Plan (team)",
    endpoint: "https://open.bigmodel.cn/api/anthropic/v1/models",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    fam: "bigmodel",
    credKey: "oauth:bigmodel:access_token",
    /* issue #442：团队套餐是独立计费池——v2 条目 key 与 GLr location 都属个人项目
     * （location 键名 team===null），对团队源绝不可用。增强凭据=团队项目 PAT
     * （planTeamPatOf，额度链同款三步换发）；zai 团队未实测维持 planKeyOf 诚实尝试。 */
    teamPat: true,
    v2ConfigKey: "builtin:bigmodel-coding-plan",
  },
  "account:bigmodel-start-plan": {
    name: "BigModel Start Plan",
    endpoint: "https://open.bigmodel.cn/api/anthropic/v1/models",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    fam: "bigmodel",
    credKey: "oauth:bigmodel:access_token",
    /* issue #336 终案（2026-11-14 实测 200 ×3 头形）：start-plan 推理与 coding plan 同走
     * open.bigmodel.cn/api/anthropic，凭据=宿主在 bigmodel 账号下发放的**项目 API key**
     * （名字 zcode-api-key，usageScene=CODING_PLAN，id.secret 形态）——3.18 宿主曾写入
     * v2 config 的 builtin:bigmodel-coding-plan 条目（本机三头形实测 200）。此前按旧
     * config 注释打 zcode.z.ai + 会话 JWT 是双重错误（网关错+凭据错 → 401/3012 WAF）。
     * 3.19.x 起（specs/plan-glr-credential.md）：宿主 builtin 套餐改 zhipu-account 运行时
     * 内存换发（GLr），v2 config.json 不再存在；表值 baseUrl 仅供 runtime 配置缺读时兜底，
     * 3.19.1 runtime 权威路由把 start-plan 指向 zcode.z.ai/api/v1/zcode-plan/anthropic。
     * issue #429：disabled 条目的 key 无资源包会恒 429 1113，照取必败；GLr 换发实现后
     * bigmodel 家族凭据序=条目 key → GLr token → plan_auth（OAuth 直连兜底已移除）。 */
    v2ConfigKey: "builtin:bigmodel-coding-plan",
  },
};

/* 宿主旧形套餐 id（builtin:*，宿主迁移函数将其归一为 account:*；渲染端 data-provider
 * 偶发旧形）→ PLAN_SOURCES 规范键。拉模型/写入/探测/增强四条入口统一在入口处归一。 */
var PLAN_ID_ALIASES = {
  "builtin:zai-coding-plan": "account:zai-individual-coding-plan",
  "builtin:zai-team-coding-plan": "account:zai-team-coding-plan",
  "builtin:zai-start-plan": "account:zai-start-plan",
  "builtin:bigmodel-coding-plan": "account:bigmodel-individual-coding-plan",
  "builtin:bigmodel-team-coding-plan": "account:bigmodel-team-coding-plan",
  "builtin:bigmodel-start-plan": "account:bigmodel-start-plan",
};
function planAliasId(v) { return PLAN_ID_ALIASES[String(v || "")] || String(v || ""); }

/* 宿主官方 GLM 模型规范 id（packages/shared/src/official-glm-model-id.ts）：套餐 models
 * 端点返回小写，personal 规则用规范大小写——写入前归一，防止同模型两套写法 */
var OFFICIAL_GLM_MODEL_IDS = [
  "GLM-5.3", "GLM-5.3-Flash", "GLM-5.3-FlashX", "GLM-5V-Turbo", "GLM-5.2", "GLM-5.1", "GLM-5.1-Highspeed",
  "GLM-5", "GLM-5-Turbo", "GLM-4.7", "GLM-4.7-FlashX", "GLM-4.7-Flash", "GLM-4.6",
  "GLM-4.5-Air", "GLM-4.5", "GLM-4.6V", "GLM-4.6V-Flash", "GLM-4.6V-FlashX",
  "GLM-4.1V-Thinking-FlashX", "GLM-4.1V-Thinking-Flash", "GLM-4-FlashX-250414",
  "GLM-4-Flash-250414", "GLM-4V-Flash",
];
var OFFICIAL_GLM_BY_LOWER = new Map(OFFICIAL_GLM_MODEL_IDS.map((id) => [id.toLowerCase(), id]));
function normalizePlanModelId(id) { return OFFICIAL_GLM_BY_LOWER.get(String(id).toLowerCase()) || id; }
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
  for (const v of [src.vision, src.supports_vision, asObject(src.architecture).vision, asObject(asObject(src.capabilities).supports).vision]) {
    if (typeof v === "boolean") return v;
  }
  return undefined;
}
/* 思考档位排序：宿主把 values.at(-1) 当默认最高档、辅助调用取 values[0] 当最低档，供应商
 * 与目录的原始顺序都不可信——按已知强度梯排序（issue #236）；未知词保持原始相对顺序排尾 */
const EFFORT_LADDER = ["off", "disabled", "none", "minimal", "low", "medium", "high", "xhigh", "max"];
function effortListFrom(raw) {
  const seen = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (typeof item !== "string") continue;
    const v = item.trim();
    if (v && !seen.includes(v)) seen.push(v);
  }
  const rank = (v) => { const i = EFFORT_LADDER.indexOf(v.toLowerCase()); return i < 0 ? EFFORT_LADDER.length : i; };
  const ranked = seen.slice().sort((a, b) => rank(a) - rank(b));
  return ranked.length > EFFORTS_MAX ? ranked.slice(ranked.length - EFFORTS_MAX) : ranked;   // 超限截尾保最强档（宿主默认档=values.at(-1)）
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
  const capLimits = asObject(asObject(src.capabilities).limits);
  const capSupports = asObject(asObject(src.capabilities).supports);
  const ctx = firstPositive(src.context_length, src.contextWindow, src.context_window,
    asObject(src.limit).context, asObject(src.limits).context, capLimits.max_context_window_tokens);
  const out = firstPositive(src.max_completion_tokens, src.max_output_tokens, src.maxOutputTokens,
    asObject(src.limit).output, asObject(src.limits).output,
    asObject(src.top_provider).max_completion_tokens, capLimits.max_output_tokens);
  const modalities = rawInputModalities(src);
  const vision = rawVisionFlag(src);
  /* supported_efforts（聚合网关实测）+ capabilities.supports.reasoning_effort（GitHub Copilot
   * /models 实测）：都是 wire effort 词表，归一并按强度梯排序，绝不从布尔能力推导档位 */
  const efforts = effortListFrom([].concat(Array.isArray(src.supported_efforts) ? src.supported_efforts : [],
    capSupports.reasoning_effort));
  /* 能力位只采信显式布尔（models.dev tool_call/structured_output 与同形富字段），缺省 undefined */
  const structuredOutput = typeof src.structured_output === "boolean" ? src.structured_output
    : typeof capSupports.structured_output === "boolean" ? capSupports.structured_output : undefined;
  const toolCall = typeof src.tool_call === "boolean" ? src.tool_call
    : typeof capSupports.tool_call === "boolean" ? capSupports.tool_call : undefined;
  return { id, contextWindow: ctx, maxOutputTokens: out, modalities, vision, efforts, structuredOutput, toolCall };
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

/* api.json 是 {provider:{models:{mid:{...}}}} 嵌套：摊平为与 models.json 同形条目；
 * identity 含 "provider/mid" 与裸 mid，跨 provider 同名由 matchCatalogEntry 歧义守卫放弃 */
function apiCatalogEntries(payload) {
  const out = [];
  const provs = asObject(payload);
  for (const pid of Object.keys(provs)) {
    const models = asObject(asObject(provs[pid]).models);
    for (const mid of Object.keys(models)) {
      const model = asObject(models[mid]);
      const m = String(mid).trim();
      if (!Object.keys(model).length || !m) continue;
      out.push({ identities: [(pid + "/" + m).toLowerCase(), m.toLowerCase()], basename: canonicalBasename(m), model: model });
    }
  }
  return out;
}
/* api.json reasoning_options：仅 effort 档位词表可映射宿主 values——toggle 等于内置默认
 * 两档、budget_tokens 无法用 values 表达，均不采纳；值即 wire effort 词表，过滤非字符串 */
function catalogEffortsOf(model) {
  const opts = asObject(model).reasoning_options;
  if (!Array.isArray(opts)) return [];
  const vals = [];
  for (const opt of opts) {
    const o = asObject(opt);
    if (o.type === "effort" && Array.isArray(o.values)) {
      for (const v of o.values) vals.push(v);   // 逐个 push：目录响应可控边界外不用 spread（巨数组 RangeError 风险）
    }
  }
  return effortListFrom(vals);
}
/* 从 api 目录条目构建轻量档位索引：identity（含 "provider/mid" 复合键）与 basename 各一份，
 * 唯一命中存词表、多义存 null（与 matchCatalogEntry 宁缺毋滥同语义）；无词表条目仍参与
 * 多义计数（同名模型存在于多 provider 时整体放弃，不从单侧取值） */
function buildEffortsIndex(entries) {
  const eCnt = Object.create(null), eVal = Object.create(null);
  const bCnt = Object.create(null), bVal = Object.create(null);
  for (const entry of entries) {
    const values = catalogEffortsOf(entry.model);
    for (const key of entry.identities) {
      eCnt[key] = (eCnt[key] || 0) + 1;
      if (values.length) eVal[key] = values;
    }
    if (entry.basename) {
      bCnt[entry.basename] = (bCnt[entry.basename] || 0) + 1;
      if (values.length) bVal[entry.basename] = values;
    }
  }
  const e = Object.create(null), b = Object.create(null);
  for (const key of Object.keys(eCnt)) e[key] = eCnt[key] > 1 ? null : (eVal[key] || null);
  for (const key of Object.keys(bCnt)) b[key] = bCnt[key] > 1 ? null : (bVal[key] || null);
  return { e: e, b: b };
}
/* 索引查询：mid 精确（含复合键）唯一→词表、多义→null（不回退 basename，与
 * matchCatalogEntry 歧义守卫同款）；无精确键才回退 basename 唯一命中 */
function apiEffortsFor(index, id) {
  const norm = String(id == null ? "" : id).trim().toLowerCase();
  if (!norm) return null;
  if (Object.prototype.hasOwnProperty.call(index.e, norm)) return index.e[norm];
  const base = canonicalBasename(norm);
  if (base && Object.prototype.hasOwnProperty.call(index.b, base)) return index.b[base];
  return null;
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

/* 供应商条目与目录条目字段级合并：供应商优先，目录次之，一致性收割兜底（v312 agreed：
 * 多 provider 歧义但全同意的可加证据），其余键只补缺（GLQQX 语义） */
function mergedMeta(providerMeta, catalogModel, agreed) {
  const cat = catalogModel ? extractModelMeta(catalogModel) : {};
  const inputFormat = inputFormatFrom(providerMeta.modalities, providerMeta.vision)
    || inputFormatFrom(cat.modalities, cat.vision)
    || (agreed && agreed.inputFormat);
  const meta = {};
  const ctx = providerMeta.contextWindow || cat.contextWindow;
  const out = providerMeta.maxOutputTokens || cat.maxOutputTokens;
  if (ctx) meta.contextWindow = ctx;
  if (out) meta.maxOutputTokens = out;
  if (inputFormat) meta.inputFormat = inputFormat;
  if (providerMeta.efforts.length) meta.efforts = providerMeta.efforts;
  const structured = typeof providerMeta.structuredOutput === "boolean" ? providerMeta.structuredOutput
    : typeof cat.structuredOutput === "boolean" ? cat.structuredOutput : agreed && agreed.supportsJsonSchemaOutput;
  const tools = typeof providerMeta.toolCall === "boolean" ? providerMeta.toolCall
    : typeof cat.toolCall === "boolean" ? cat.toolCall : agreed && agreed.supportsToolCall;
  if (typeof structured === "boolean") meta.supportsJsonSchemaOutput = structured;
  if (typeof tools === "boolean") meta.supportsToolCall = tools;
  if (providerMeta.midConversationSystem === true || cat.midConversationSystem === true) meta.supportsMidConversationSystem = true;
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
