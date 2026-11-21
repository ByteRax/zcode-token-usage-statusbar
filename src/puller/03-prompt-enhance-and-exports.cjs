
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
    /* 设置页「从宿主选择」直连：zcode.z.ai 路由的 host 公告携带 deviceMid（resolveEnhanceHost），
     * 直连请求同样必须带 X-Device-Mid（review R3 复审 A 相邻 MAJOR）。 */
    const directDeviceMid = direct && typeof direct.deviceMid === "string" ? direct.deviceMid.trim() : "";
    const planSrc = direct ? null : PLAN_SOURCES[String(providerId || "")];
    if (!direct && !planSrc && !rule) return { ok: false, kind: "provider", error: "provider not found" };
    const cfg = direct ? { access: { type: "api-key", apiKey: direct.apiKey }, api: { type: direct.protocol, baseUrl: direct.baseUrl } } : effectiveRuleConfig(rule);
    const access = cfg.access || {}, api = cfg.api || {};
    if (!planSrc && access.type !== "api-key") return { ok: false, kind: "provider", error: "provider is not api-key type" };
    const apiType = planSrc ? "anthropic-messages" : String(api.type || "");
    if (!planSrc && apiType !== "openai-chat-completions" && apiType !== "openai-responses" && apiType !== "anthropic-messages") {
      return { ok: false, kind: "unsupported", error: "unsupported api type: " + (apiType || "(empty)") };
    }
    const external = o.signal && typeof o.signal.addEventListener === "function" ? o.signal : null;
    const isBigmodelPlan = !!planSrc && planSrc.fam === "bigmodel";
    let baseUrl = String((planSrc ? planBaseUrl(providerId) : api.baseUrl) || "").trim().replace(/\/+$/, "");
    /* zcode.z.ai 会话网关（specs/plan-glr-credential.md 补篇）：GLr accessToken 是
     * bigmodel.cn 项目域凭据，打该网关恒 401（2026-11-21 真机实测）——该路由必须用
     * zcodejwttoken（会话 JWT）+ X-Device-Mid（额度链 zcode-start 同款口径）。
     * v2 条目 key 属 open.bigmodel.cn 端点：无设备头打 zcode.z.ai 恒 400 code 3001
     * （review R3-A），不用于该路由——zcode 路由仅认会话 JWT，会话不可得即迁移表值路由。 */
    const isZcodeSessionRoute = !!planSrc && /(^|\.)zcode\.z\.ai$/.test((() => { try { return new URL(baseUrl).hostname.toLowerCase(); } catch (e) { return ""; } })());
    let apiKey = "", zcodeSession = null;
    if (planSrc) {
      if (isBigmodelPlan) {
        /* GLr 时代凭据序（specs/plan-glr-credential.md）：v2 条目明文 key（3.18 宿主/旧机器，
         * 属 open.bigmodel.cn 端点）→ 按路由分流：zcode.z.ai 仅认会话 JWT+设备号（会话不可得
         * 即以 entry key/GLr 迁移表值路由为主路由）；bigmodel.cn 用 GLr 换发 token（3.19.x
         * 宿主运行时解析对等）→ 均不可用诚实报 plan_auth。
         * OAuth 直连兜底已移除——v344 实测被网关 500 code 1234 拒，绝不该作为 fallback 重现。 */
        if (isZcodeSessionRoute) {
          zcodeSession = readZcodeSessionCred();
          if (zcodeSession) {
            apiKey = zcodeSession.token;
          } else {
            const entryKey = planEntryKeyOf(providerId);
            apiKey = entryKey || (await planGLrTokenOf(providerId, external));
            if (apiKey) {
              baseUrl = String((PLAN_SOURCES[String(providerId)] || {}).baseUrl || baseUrl).trim().replace(/\/+$/, "");
              log("enhance zcode session cred unavailable; riding table route with " + (entryKey ? "v2 entry key" : "GLr token"));
            }
          }
        } else {
          apiKey = planEntryKeyOf(providerId) || (await planGLrTokenOf(providerId, external));
        }
        if (!apiKey) {
          if (external && external.aborted) return { ok: false, kind: "cancelled", error: "cancelled" };
          return { ok: false, kind: "plan_auth", error: "plan conversation key unavailable" };
        }
      } else {
        /* zai 家族端点未实测，维持 planKeyOf（条目 key 优先、OAuth 兜底）诚实尝试。 */
        apiKey = planKeyOf(providerId);
      }
    } else {
      apiKey = String(access.apiKey || "").trim();
    }
    if (!baseUrl) return { ok: false, kind: "provider", error: "no base url" };
    if (!apiKey) return { ok: false, kind: "auth", error: planSrc ? "plan token unavailable" : "no api key" };
    const userContent = enhanceUserContent(text);
    const buildRequest = (base, key, deviceMid) => {
      const headers = { "Content-Type": "application/json", "User-Agent": "ZCode" };   // fetchModels 同款 UA：网关拒绝无 UA 请求（实测缺 UA 时 anthropic 端点 500 code 1234）
      if (deviceMid) headers["X-Device-Mid"] = deviceMid;   // zcode.z.ai 必带头（缺头 400 code 3001，额度链同款）
      if (isOpenCodeGoBaseUrl(base)) headers["x-opencode-session"] = randomUUID();   // OpenCode Go 路由键，缺失 400 MissingSessionID
      const req = { headers: headers };
      if (apiType === "openai-chat-completions") {
        req.url = base + "/chat/completions";
        headers["Authorization"] = "Bearer " + key;
        req.body = { model: mid, messages: [{ role: "system", content: ENHANCE_SYSTEM_PROMPT }, { role: "user", content: userContent }], max_tokens: ENHANCE_MAX_TOKENS, stream: false };
      } else if (apiType === "openai-responses") {
        req.url = base + "/responses";
        headers["Authorization"] = "Bearer " + key;
        req.body = { model: mid, input: [{ role: "system", content: ENHANCE_SYSTEM_PROMPT }, { role: "user", content: userContent }], max_output_tokens: ENHANCE_MAX_TOKENS, stream: false };
      } else {
        req.url = anthropicBaseWithV1(base) + "/messages";
        headers["x-api-key"] = key;
        headers["anthropic-version"] = "2023-06-01";
        headers["Authorization"] = "Bearer " + key;
        req.body = { model: mid, max_tokens: ENHANCE_MAX_TOKENS, system: ENHANCE_SYSTEM_PROMPT, messages: [{ role: "user", content: userContent }], stream: true };
      }
      return req;
    };
    /* legKey=本腿实际发送的凭据（review 后置 R3-A/D：maskSecrets 必须配对本腿 secret，
     * 降级腿复用主腿闭包变量会把 GLr token 原样带进 detail 回渲染端）；maxAttempts：
     * 降级腿限单次（双腿满配最坏 ≈107s 越过渲染端 75s 兜底）；legTag=日志腿标识。 */
    const runAttempts = async (req, legKey, maxAttempts, legTag) => {
      let lastFail = null;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
          const res = await fetchImpl(req.url, { headers: req.headers, body: JSON.stringify(req.body), method: "POST", redirect: "error", signal: ctl.signal });
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
            try { errorDetail = maskSecrets(String(await readEnhanceBody(res)), legKey).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").slice(0, 500); } catch (e) { }   // 必须在取消响应体之前读取；正文过 maskSecrets（必传本腿凭据，R3-A/D——无兜底，漏传即暴露而非静默错脱敏）
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
            log("enhance http " + lastFail.status + " leg=" + (legTag || "primary") + " (" + attempt + ")");
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
    };
    let result = await runAttempts(buildRequest(baseUrl, apiKey, zcodeSession ? zcodeSession.deviceMid : directDeviceMid), apiKey, 2, "primary");
    if (planSrc && isBigmodelPlan && result && !result.ok && (result.kind === "path" || result.status === 401)) {
      const primaryHost = (() => { try { return new URL(baseUrl).hostname.toLowerCase(); } catch (e) { return ""; } })();
      if (/(^|\.)zcode\.z\.ai$/.test(primaryHost)) {
        /* 双路由降级（2026-11-21 真机实测）：zcode.z.ai 对话端点的 WAF 3012 间歇出现
         * （同形请求曾 200 也曾 405，billing 同头形正常——网关侧状态非客户端可判定）。
         * 主路由 path/401 时改走 open.bigmodel.cn + GLr token（该端点接受项目域凭据，
         * individual 全链实测 200；纯 start-plan 账号会得到诚实的 1113 balance 文案）。 */
        const altBase = String((PLAN_SOURCES[String(providerId)] || {}).baseUrl || "").trim().replace(/\/+$/, "");
        if (altBase && altBase !== baseUrl && !(external && external.aborted)) {
          const glr = await planGLrTokenOf(providerId, external);
          if (glr) {
            log("enhance dual-route fallback engaged (primary " + result.status + ")");
            const r2 = await runAttempts(buildRequest(altBase, glr, null), glr, 1, "fallback");   // 降级腿：单次 + 本腿凭据脱敏
            if (r2 && (r2.ok || r2.kind === "balance")) return r2;   // 降级成功或给出更可行动的 balance 文案
            return result;   // 双败：主路由的 path/401 更具诊断性
          }
        }
      }
    }
    return result;
  }

  function resolveEnhanceHost(providerId) {
    const planSrc = PLAN_SOURCES[String(providerId || "")];
    if (planSrc) {   // 套餐源（BigModel/Start Plan 等）：凭据主进程内解析，协议恒 anthropic。
      // 不沿用 planListable 的同族去重——增强选套餐是计费池选择，Start Plan 与个人档需分列；仅跳过 team（与个人同凭据同端点的纯重复）。
      if (/team/.test(String(providerId))) return null;
      if (!planTokenOf(providerId)) return null;
      const isBigmodel = planSrc.fam === "bigmodel";
      const base = planBaseUrl(providerId);
      const isZcode = isBigmodel && /(^|\.)zcode\.z\.ai$/.test((() => { try { return new URL(base).hostname.toLowerCase(); } catch (e) { return ""; } })());
      /* zcode.z.ai 路由仅认会话 JWT（与 enhanceText 同语义，review R3 复审 A）：entry key
       * 属 open.bigmodel.cn 端点、无设备头打 zcode 恒 400——会话不可得即公告表值路由。 */
      let zcodeSession = null;
      let apiKey = "";
      if (isZcode) {
        zcodeSession = readZcodeSessionCred();
        if (zcodeSession) apiKey = zcodeSession.token;
      } else {
        apiKey = isBigmodel ? planEntryKeyOf(providerId) : planKeyOf(providerId);
        if (isBigmodel && !apiKey) apiKey = glrMemoToken();
      }
      if (!apiKey) return null;   // zcode 路由无会话即不公告（默认模式仍经 enhanceText 迁移表值路由可用）
      const entry = readV2BuiltinEntry(planSrc);
      if (!isBigmodel && entry && entry.enabled === false) return null;   // bigmodel 已由 planEntryKeyOf 判定
      /* deviceMid 随 host 公告：设置页「从宿主选择」直连（enhanceProvider）路径补
       * X-Device-Mid（review R3 复审 A 相邻 MAJOR——74503d7 起直连缺头对 zcode 路由恒 400）。 */
      return { providerId: String(providerId), baseUrl: base, protocol: "anthropic-messages", apiKey: apiKey, deviceMid: zcodeSession ? zcodeSession.deviceMid : undefined, plan: true };
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
