
  /* 增强提示词（v344）：provider/model 凭据解析与 probeModel 同款（套餐源 planTokenOf
   * 内存解密；自定义供应商限 api-key 型），anthropic 走 SSE 流式聚合、openai 两型非流式 POST；单次 30s 超时×2 次尝试（含 1.2s 退避 ≈61s）。fail-closed：
   * 无 key/不支持协议/空响应一律回 {ok:false}，绝不把失败包装成成功。 */
  async function enhanceText(providerId, modelId, draft, opts) {
    providerId = planAliasId(providerId);   // issue #336：builtin: 旧形套餐 id 归一
    const o = opts || {};
    const mid = sanitizeModelIds([modelId])[0] || "";
    if (!mid) return { ok: false, kind: "invalid_model", error: "invalid model id" };
    const text = typeof draft === "string" ? draft : "";
    if (!text.trim() || text.length > (Number.isFinite(o.draftMax) ? o.draftMax : ENHANCE_DRAFT_MAX)) {
      return { ok: false, kind: "invalid_input", error: "draft length out of range" };
    }
    if (!fetchImpl) return { ok: false, kind: "network", error: "no network stack" };
    const data = readProviderCfg();
    const rule = data ? findRule(data, providerId) : null;
    const direct = o.enhanceProvider && typeof o.enhanceProvider === "object" ? o.enhanceProvider : null;
    const planSrc = direct ? null : PLAN_SOURCES[String(providerId || "")];
    if (!direct && !planSrc && !rule) return { ok: false, kind: "provider", error: "provider not found" };
    const cfg = direct ? { access: { type: "api-key", apiKey: direct.apiKey }, api: { type: direct.protocol, baseUrl: direct.baseUrl } } : effectiveRuleConfig(rule);
    const access = cfg.access || {}, api = cfg.api || {};
    if (!planSrc && access.type !== "api-key") return { ok: false, kind: "provider", error: "provider is not api-key type" };
    const apiType = planSrc ? "anthropic-messages" : String(api.type || "");
    if (!planSrc && apiType !== "openai-chat-completions" && apiType !== "openai-responses" && apiType !== "anthropic-messages") {
      return { ok: false, kind: "unsupported", error: "unsupported api type: " + (apiType || "(empty)") };
    }
    const baseUrl = String((planSrc ? planSrc.baseUrl : api.baseUrl) || "").trim().replace(/\/+$/, "");
    let apiKey = "";
    if (planSrc) {
      if (planSrc.enhanceRequiresV2Key && !planEntryKeyOf(providerId)) {
        /* issue #429：start-plan 增强的唯一可用凭据=宿主写入 v2 config 的项目 key
         * （OAuth 直连 messages 被网关 500 拒，v344 实测；spec「未实现前诚实报 auth」落地）。
         * 条目缺失/disabled/key 不可用（纯 Start Plan、宿主关闭 coding plan）不再发必败
         * 请求（disabled 条目 key 无资源包时恒 429 1113），诚实报 plan_auth；
         * zai 家族端点未实测，维持 planKeyOf 诚实尝试。 */
        return { ok: false, kind: "plan_auth", error: "plan conversation key unavailable" };
      }
      apiKey = planKeyOf(providerId);
    } else {
      apiKey = String(access.apiKey || "").trim();
    }
    if (!baseUrl) return { ok: false, kind: "provider", error: "no base url" };
    if (!apiKey) return { ok: false, kind: "auth", error: planSrc ? "plan token unavailable" : "no api key" };
    let url = "", body = null;
    const headers = { "Content-Type": "application/json", "User-Agent": "ZCode" };   // fetchModels 同款 UA：网关拒绝无 UA 请求（实测缺 UA 时 anthropic 端点 500 code 1234）
    if (isOpenCodeGoBaseUrl(baseUrl)) headers["x-opencode-session"] = randomUUID();   // OpenCode Go 路由键，缺失 400 MissingSessionID
    const userContent = enhanceUserContent(text);
    if (apiType === "openai-chat-completions") {
      url = baseUrl + "/chat/completions";
      headers["Authorization"] = "Bearer " + apiKey;
      body = { model: mid, messages: [{ role: "system", content: ENHANCE_SYSTEM_PROMPT }, { role: "user", content: userContent }], max_tokens: ENHANCE_MAX_TOKENS, stream: false };
    } else if (apiType === "openai-responses") {
      url = baseUrl + "/responses";
      headers["Authorization"] = "Bearer " + apiKey;
      body = { model: mid, input: [{ role: "system", content: ENHANCE_SYSTEM_PROMPT }, { role: "user", content: userContent }], max_output_tokens: ENHANCE_MAX_TOKENS, stream: false };
    } else {
      url = anthropicBaseWithV1(baseUrl) + "/messages";
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      headers["Authorization"] = "Bearer " + apiKey;
      body = { model: mid, max_tokens: ENHANCE_MAX_TOKENS, system: ENHANCE_SYSTEM_PROMPT, messages: [{ role: "user", content: userContent }], stream: true };
    }
    const external = o.signal && typeof o.signal.addEventListener === "function" ? o.signal : null;
    let lastFail = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (external && external.aborted) return { ok: false, kind: "cancelled", error: "cancelled" };
      if (attempt) {
        const aborted = await new Promise((resolve) => {
          const t = setTimeout(() => { clean(); resolve(false); }, 1200);
          if (t && typeof t.unref === "function") t.unref();   // 超时兜底定时器契约：不挂起主进程事件循环
          const onAbort = () => { clean(); resolve(true); };
          const clean = () => { clearTimeout(t); if (external) external.removeEventListener("abort", onAbort); };
          if (external) external.addEventListener("abort", onAbort, { once: true });
          if (external && external.aborted) onAbort();
        });
        if (aborted) return { ok: false, kind: "cancelled", error: "cancelled" };
      }
      const ctl = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ENHANCE_TIMEOUT_MS);
      if (timer && typeof timer.unref === "function") timer.unref();
      const onExternalAbort = () => ctl.abort();
      if (external) external.addEventListener("abort", onExternalAbort, { once: true });
      try {
        if (external && external.aborted) return { ok: false, kind: "cancelled", error: "cancelled" };
        const res = await fetchImpl(url, { headers: headers, body: JSON.stringify(body), method: "POST", redirect: "error", signal: ctl.signal });
        if (res && res.ok) {
          let value, serverModel, usage;
          if (apiType === "anthropic-messages") {
            const stream = await readAnthropicStream(res);
            value = stream.text; serverModel = stream.serverModel; usage = stream.usage;
          } else {
            const raw = await readEnhanceBody(res);
            let payload;
            try { payload = JSON.parse(raw); } catch (e) { return { ok: false, kind: "parse", error: "invalid json response" }; }
            if (!payload || (apiType === "openai-responses" ? payload.status !== "completed" : !(payload.choices && payload.choices[0] && payload.choices[0].finish_reason === "stop")) || (Array.isArray(payload.output) && payload.output.some(item => item && item.status && item.status !== "completed"))) {
              return { ok: false, kind: "parse", error: "incomplete completion" };
            }
            value = enhanceUnwrapText(payload);
            if (typeof payload.model === "string" && payload.model) serverModel = payload.model;
            const u = payload.usage || {};
            if (apiType === "openai-responses" && (Number.isFinite(u.input_tokens) || Number.isFinite(u.output_tokens))) usage = { inputTokens: u.input_tokens ?? null, outputTokens: u.output_tokens ?? null, totalTokens: Number.isFinite(u.total_tokens) ? u.total_tokens : (Number.isFinite(u.input_tokens) && Number.isFinite(u.output_tokens) ? u.input_tokens + u.output_tokens : null) };
            else if (Number.isFinite(u.prompt_tokens) || Number.isFinite(u.completion_tokens)) usage = { inputTokens: Number.isFinite(u.prompt_tokens) ? u.prompt_tokens : null, outputTokens: Number.isFinite(u.completion_tokens) ? u.completion_tokens : null, totalTokens: Number.isFinite(u.total_tokens) ? u.total_tokens : (Number.isFinite(u.prompt_tokens) && Number.isFinite(u.completion_tokens) ? u.prompt_tokens + u.completion_tokens : null) };
          }
          if (external && external.aborted) return { ok: false, kind: "cancelled", error: "cancelled" };
          if (timedOut) throw Object.assign(new Error("timeout"), { name: "AbortError" });
          const enhanced = stripEnhanceFences(value, text);
          if (!enhanced) return { ok: false, kind: "empty", error: "empty completion" };
          return { ok: true, text: enhanced, model: mid, serverModel: serverModel || mid, usage: usage || undefined };
        }
        if (!res.ok) {
          let errorDetail = "";
          try { errorDetail = maskSecrets(String(await readEnhanceBody(res)), apiKey).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").slice(0, 500); } catch (e) { }   // 必须在取消响应体之前读取；正文过 maskSecrets 防凭据回显
          if (res && res.body && typeof res.body.cancel === "function") {
            try { Promise.resolve(res.body.cancel()).catch(() => { }); } catch (e) { }
          }
          if (external && external.aborted) return { ok: false, kind: "cancelled", error: "cancelled" };
          if (timedOut) throw Object.assign(new Error("timeout"), { name: "AbortError" });
          lastFail = { ok: false, kind: classifyProbeStatus(res ? res.status : 0), status: res ? res.status : 0, error: "HTTP " + (res ? res.status : 0) };
          if (balanceEnhanceError(errorDetail)) {
            /* issue #429：BigModel 1113「余额不足或无可用资源包」按 HTTP 429 返回，与真实
             * 并发限流同状态码——按错误体分类为 kind "balance"，error 置空让渲染端 kindMap
             * 给「套餐额度或资源包不足」文案，不再诱导用户当限流重试。确定性失败不重试。 */
            lastFail.kind = "balance";
            delete lastFail.error;
          }
          if (errorDetail) lastFail.detail = errorDetail;
          log("enhance http " + lastFail.status + " (" + attempt + ")");
          if (lastFail.kind !== "server") return lastFail;
        }
      } catch (e) {
        if (external && external.aborted) return { ok: false, kind: "cancelled", error: "cancelled" };
        if (e && e.enhanceParse) return { ok: false, kind: "parse", error: "invalid or incomplete stream" };
        lastFail = { ok: false, kind: timedOut ? "timeout" : "network", error: timedOut ? "timeout" : "request failed" };
      } finally {
        clearTimeout(timer);
        if (external) external.removeEventListener("abort", onExternalAbort);
      }
    }
    return lastFail;
  }

  function resolveEnhanceHost(providerId) {
    const planSrc = PLAN_SOURCES[String(providerId || "")];
    if (planSrc) {   // 套餐源（BigModel/Start Plan 等）：凭据 planKeyOf 主进程内解析，协议恒 anthropic。
      // 不沿用 planListable 的同族去重——增强选套餐是计费池选择，Start Plan 与个人档需分列；仅跳过 team（与个人同凭据同端点的纯重复）。
      if (/team/.test(String(providerId))) return null;
      if (!planTokenOf(providerId)) return null;
      /* issue #429：start-plan 增强唯一可用凭据=宿主 v2 项目 key（OAuth 兜底对 messages
       * 必败，v344 实测）——无可用 key 不提供必败 host；zai 家族维持诚实尝试。 */
      if (planSrc.enhanceRequiresV2Key && !planEntryKeyOf(providerId)) return null;
      const entry = readV2BuiltinEntry(planSrc);
      if (entry && entry.enabled === false) return null;
      const apiKey = planKeyOf(providerId);
      return apiKey ? { providerId: String(providerId), baseUrl: planSrc.baseUrl, protocol: "anthropic-messages", apiKey: apiKey, plan: true } : null;
    }
    const data = readProviderCfg(), rule = data ? findRule(data, providerId) : null;
    if (!rule || !modelPullerRuleAllowed(rule)) return null;
    const cfg = effectiveRuleConfig(rule), api = cfg.api || {}, access = cfg.access || {};
    if (access.type !== "api-key" || !access.apiKey || !api.baseUrl || !["openai-chat-completions", "openai-responses", "anthropic-messages"].includes(api.type)) return null;
    return { providerId, baseUrl: String(api.baseUrl).replace(/\/+$/, ""), protocol: api.type, apiKey: String(access.apiKey) };
  }
  function modelPullerRuleAllowed(rule) { return rule && rule.enabled !== false && (!rule.config || rule.config.enabled !== false); }
  function listEnhanceHosts() {
    const data = readProviderCfg();
    const hosts = [];
    for (const rule of rulesOf(data)) {
      const d = resolveEnhanceHost(String(rule.providerId || ""));
      if (d && !PLAN_SOURCES[String(rule.providerId || "")]) hosts.push({ id: d.providerId, name: String(rule.providerName || d.providerId).slice(0, 160), baseUrl: d.baseUrl, protocol: d.protocol });
    }
    for (const planId of Object.keys(PLAN_SOURCES)) {   // 套餐源（BigModel/Start Plan 等）凭据可用即列出，与 listProviders 同门控
      const d = resolveEnhanceHost(planId);
      if (d) hosts.push({ id: d.providerId, name: PLAN_SOURCES[planId].name, baseUrl: d.baseUrl, protocol: d.protocol });
    }
    return hosts;
  }
  async function listEnhanceModels(config, signal) {
    const base = config.protocol === "anthropic-messages" ? anthropicBaseWithV1(config.baseUrl) : config.baseUrl.replace(/\/+$/, "");
    const url = new URL(base + "/models");
    const headers = { Accept: "application/json", "User-Agent": "ZCode" };
    if (config.protocol === "anthropic-messages") {
      headers["x-api-key"] = config.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else headers.Authorization = "Bearer " + config.apiKey;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal) signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, FETCH_TIMEOUT_MS);
    if (timer && timer.unref) timer.unref();
    try {
      if (signal && signal.aborted) return { ok: false, error: "cancelled" };
      const res = await fetchImpl(url.toString(), { headers, signal: controller.signal, redirect: "error" });
      if (!res.ok) { dropBody(res); return { ok: false, error: "HTTP " + res.status }; }
      const data = await readJsonBounded(res, RESPONSE_MAX_BYTES);
      const ids = sanitizeModelIds(parseModelsPayload(data).map(item => typeof item === "string" ? item : rawModelId(asObject(item))));
      return { ok: true, models: ids.filter(id => !config.apiKey || !id.includes(config.apiKey)) };
    } catch (e) { return { ok: false, error: "model list unavailable" }; }
    finally { clearTimeout(timer); if (signal) signal.removeEventListener("abort", abort); }
  }
  return { enhanceProviderVersion: 1, listProviders: listProviders, fetchModels: fetchModels, applyModels: applyModels, probeModel: probeModel, enhanceText: enhanceText, listEnhanceModels: listEnhanceModels, listEnhanceHosts: listEnhanceHosts, resolveEnhanceHost: resolveEnhanceHost, dispose: () => { disposed = true; fetchCache.clear(); } };
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
  endsWithVersionSegment, rawModelId, apiCatalogEntries, buildEffortsIndex,
  anthropicBaseWithV1, classifyProbeStatus, maskSecrets, probeRepairCandidates,
  auxWireValue, reasoningWireField, acceptedEffortsFromSnippet,
  catalogHitsFor, catalogAgreedValue, agreedCapabilities,
  enhanceUnwrapText, stripEnhanceFences, enhanceUserContent,
};
