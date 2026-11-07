/* ---------- BigModel/Z.ai monitor 归一化（v96 口径不变） ---------- */
function isNoPlanMessage(msg) {
  const m = String(msg || "").toLowerCase();
  const compact = m.replace(/[\s_-]/g, "");
  return compact.indexOf("codingplan") >= 0 &&
    ["不存在", "没有", "未开通", "not exist", "not found", "not have", "doesn't have", "no coding plan", "not subscribed"]
      .some((kw) => m.indexOf(kw) >= 0);
}
function pctOf(limit) {
  if (typeof limit.percentage === "number" && limit.percentage >= 0) {
    if (typeof limit.currentValue === "number" && typeof limit.usage === "number" &&
        limit.usage > 0 && limit.currentValue >= 0) {
      return Math.round(clampPct((limit.currentValue / limit.usage) * 100) * 10) / 10;
    }
    return Math.round(clampPct(limit.percentage) * 10) / 10;
  }
  if (typeof limit.currentValue === "number" && typeof limit.usage === "number" &&
      limit.usage > 0 && limit.currentValue >= 0) {
    return Math.round(clampPct((limit.currentValue / limit.usage) * 100) * 10) / 10;
  }
  return null;
}
function resetOf(v) {
  if (typeof v === "number" && isFinite(v)) {
    if (v <= 0) return null;
    return v < 1e12 ? v * 1000 : v;
  }
  if (typeof v === "string" && v) return v;
  return null;
}
function usageDetailsOf(limit) {
  const out = [];
  if (Array.isArray(limit && limit.usageDetails)) {
    for (const u of limit.usageDetails) {
      if (u && typeof u === "object" && typeof u.modelCode === "string" && u.modelCode) {
        out.push({ modelCode: u.modelCode, displayName: typeof u.displayName === "string" ? u.displayName : "", usage: typeof u.usage === "number" ? u.usage : null });
      }
    }
  }
  return out;
}
function normalizeQuotaBody(body) {
  if (!body || typeof body !== "object") throw qErr("parse_error", "non-object body");
  if (body.success === false) {
    const msg = String(body.msg || "");
    if (isNoPlanMessage(msg)) return { noPlan: true };
    throw qErr("network_error", "business error: " + msg.slice(0, 80));
  }
  const data = body.data;
  if (!data || typeof data !== "object" || !Array.isArray(data.limits)) {
    throw qErr("parse_error", "missing data.limits");
  }
  const windows = { fiveHour: null, weekly: null };
  let tools = null;
  const unknownUnits = [];
  const unclassified = [];
  const models = [];
  const seenModel = {};
  for (const limit of data.limits) {
    if (!limit || typeof limit !== "object") continue;
    const type = String(limit.type || "").toUpperCase();
    if (type === "TIME_LIMIT") {
      if (!tools) {
        tools = {
          used: typeof limit.currentValue === "number" ? limit.currentValue : null,
          total: typeof limit.usage === "number" ? limit.usage : null,
          resetsAt: resetOf(limit.nextResetTime),
        };
      }
      continue;
    }
    if (type !== "TOKENS_LIMIT" && type !== "CREDIT_LIMIT") continue;
    const entry = { percent: pctOf(limit), resetsAt: resetOf(limit.nextResetTime), details: usageDetailsOf(limit) };
    for (const m of entry.details) {
      const key = m.displayName || m.modelCode;
      if (!seenModel[key]) { seenModel[key] = 1; models.push(key); }
    }
    const u = typeof limit.unit === "number" ? limit.unit : null;
    if (u === 3) { if (!windows.fiveHour) windows.fiveHour = entry; }
    else if (u === 6) { if (!windows.weekly) windows.weekly = entry; }
    else if (u === null) unclassified.push(entry);
    else unknownUnits.push(u);
  }
  unclassified.sort((a, b) => {
    const ra = a.resetsAt == null ? -1 : (typeof a.resetsAt === "string" ? 0 : a.resetsAt);
    const rb = b.resetsAt == null ? -1 : (typeof b.resetsAt === "string" ? 0 : b.resetsAt);
    return ra - rb;
  });
  for (const entry of unclassified) {
    if (!windows.fiveHour) windows.fiveHour = entry;
    else if (!windows.weekly) windows.weekly = entry;
  }
  return { level: typeof data.level === "string" ? data.level : "", windows, tools, models, unknownUnits };
}
/* Start Plan（ZCode 免费档，如 1024 Dev Day）归一化：zcode.z.ai billing/balance 的
 * plans[]（权益/订阅）+ balances[]（按模型分桶的 one_time 发放池）。过期判定与宿主
 * 3.16.3 实测行为同款（符号随版本轮换）：status=active 但 ends_at 已过（按 server_time
 * 时钟）就地改判过期；过期 plan 关联的桶一并过滤。只聚合 meter=model_usage 桶（当前
 * 接口只发放模型用量）；percent 自算（原始 units，比服务端整数百分比更准）。resetsAt
 * 语义是「到期」不是周期重置。 */
function zcodeStartTs(v) {
  const n = typeof v === "number" && isFinite(v) && v > 0 ? (v < 1e12 ? v * 1000 : v) : 0;
  return n || null;
}
function zcodeStartStamp(ms) {   // 展示契约 yyyy-MM-dd HH:mm（本地时区，同 overlay qTime）
  const d = new Date(ms);
  const pad = (n) => (n < 10 ? "0" : "") + n;
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
function normalizeZcodeStartBalance(body, nowMs) {
  if (!body || typeof body !== "object") throw qErr("parse_error", "non-object body");
  /* 错误信封判定（实测形状）：balance 端点失败时只带 code/msg（如 3001 parameter
   * error），没有 success:false 字段。code 非 0/200 或 success===false 一律按业务错误
   * 退避（network_error），未知业务码不作 no_plan 猜测——无套餐的结构信号是 code 0
   * 且 plans 无 active 项。 */
  if (body.success === false || (body.code !== undefined && body.code !== 0 && body.code !== 200)) {
    throw qErr("network_error", "business error: " + String(body.msg || "").slice(0, 80));
  }
  const data = body.data;
  if (!data || typeof data !== "object") throw qErr("parse_error", "missing data");
  const serverMs = zcodeStartTs(data.server_time);   // 秒/毫秒自适应（与 resetOf/zcodeStartTs 同款，防端点单位变化后全量误判过期）
  const t = serverMs || (typeof nowMs === "number" && isFinite(nowMs) ? nowMs : Date.now());
  const plans = Array.isArray(data.plans) ? data.plans : [];
  const activePlans = [];
  for (const p of plans) {
    if (!p || typeof p !== "object") continue;
    const endMs = zcodeStartTs(p.ends_at);
    if (String(p.status || "").toLowerCase() === "active" && endMs && endMs > t) activePlans.push(p);
  }
  if (!activePlans.length) return { noPlan: true };
  activePlans.sort((a, b) => (typeof b.priority === "number" ? b.priority : -1) - (typeof a.priority === "number" ? a.priority : -1));
  const top = activePlans[0];
  const planIds = new Set(activePlans.map((p) => String(p.plan_id || "")));
  const buckets = [];
  for (const b of (Array.isArray(data.balances) ? data.balances : [])) {
    if (!b || typeof b !== "object") continue;
    if (String(b.meter || "") !== "model_usage") continue;
    if (b.plan_id != null && !planIds.has(String(b.plan_id))) continue;
    const total = typeof b.total_units === "number" && isFinite(b.total_units) && b.total_units > 0 ? b.total_units : null;
    if (!total) continue;
    const expiresAt = zcodeStartTs(b.expires_at);
    if (expiresAt && expiresAt <= t) continue;   // 已到期死桶不计入聚合
    const used = typeof b.used_units === "number" && isFinite(b.used_units) && b.used_units >= 0 ? b.used_units : 0;
    buckets.push({
      name: typeof b.show_name === "string" && b.show_name ? b.show_name : "",
      used,
      total,
      expiresAt: expiresAt || 0,
    });
  }
  buckets.sort((a, b) => b.total - a.total);
  const sumOf = (k) => buckets.reduce((acc, x) => acc + x[k], 0);
  let expiresMax = 0;
  for (const x of buckets) if (x.expiresAt > expiresMax) expiresMax = x.expiresAt;
  const models = [];
  const seen = {};
  for (const x of buckets) if (x.name && !seen[x.name]) { seen[x.name] = 1; models.push(x.name); }
  const windows = { daily: null, fiveHour: null, weekly: null, monthly: null, plan: null };
  if (buckets.length) {
    const totalAll = sumOf("total");
    /* 只出百分比与到期：tooltip 窗口行的金额明细是货币格式（quotaBalanceText），
     * token 绝对量进去会变成 500000000.00；宿主 tooltip 同样只展示百分比。 */
    windows.plan = {
      percent: Math.round(clampPct((sumOf("used") / totalAll) * 100) * 10) / 10,   // 服务端超耗时钳 100，与其余归一化路径同款
      resetsAt: expiresMax || null,
      expires: true,   // one_time 发放池：到期语义，渲染端按此切「到期」文案
    };
  }
  return {
    level: "Start",
    plan: {
      productName: top.name && typeof top.name === "string" ? top.name : "ZCode Start Plan",
      validStart: zcodeStartTs(top.starts_at) ? zcodeStartStamp(zcodeStartTs(top.starts_at)) : null,
      validEnd: zcodeStartTs(top.ends_at) ? zcodeStartStamp(zcodeStartTs(top.ends_at)) : null,
    },
    windows,
    models,
  };
}
/* ---------- 重置卡（reset opportunity）归一化 ----------
 * 宿主 packages/services bigmodelUsageQuotaProvider 的 reset status schema 转写：
 * 信封 { code: 0, data: { available_five_hour_resets: [{expire_at}], available_week_resets: [...],
 * latest_*_reset_history, has_unread_history } }。只采信两个机会数组（白名单字段
 * expire_at）；秒/毫秒自适应，保留最近七天过期及未来的记录，统计仅含严格未过期卡。
 * 数组及其中每条正有限数字时间戳均须合法；都为空数组是合法零卡。绝不调用领取端点。 */
function resetExpireMs(v) {
  if (typeof v !== "number" || !isFinite(v) || v <= 0) return null;
  return v < 1e12 ? v * 1000 : v;
}
function normalizeResetStatus(body, nowMs) {
  if (!body || typeof body !== "object") throw qErr("parse_error", "non-object body");
  if (typeof body.code !== "number" || !isFinite(body.code)) throw qErr("parse_error", "invalid reset code");
  if (body.code !== 0 || body.success === false) throw qErr("network_error", "business error: " + String(body.msg || "").slice(0, 80));
  const data = body.data;
  if (!data || typeof data !== "object" || !Array.isArray(data.available_five_hour_resets) || !Array.isArray(data.available_week_resets))
    throw qErr("parse_error", "missing reset arrays");
  const t = typeof nowMs === "number" && isFinite(nowMs) ? nowMs : Date.now();
  const pick = (arr) => {
    const out = [];
    for (const it of arr) {
      const ms = it && typeof it === "object" ? resetExpireMs(it.expire_at) : null;
      if (ms == null) throw qErr("parse_error", "invalid reset expire_at");
      if (ms >= t - 7 * 24 * 60 * 60 * 1000) out.push({ expireAt: ms });
    }
    out.sort((a, b) => a.expireAt - b.expireAt);
    return out;
  };
  const fiveHour = pick(data.available_five_hour_resets);
  const week = pick(data.available_week_resets);
  const valid = fiveHour.concat(week).filter((card) => card.expireAt > t);
  return {
    fiveHour, week,
    count: valid.length,
    expireAt: valid.length ? Math.min(...valid.map((card) => card.expireAt)) : 0,
  };
}
/* 网页控制台的同族列表端点（bigmodel.cn /api/biz/customer-package-reset/list，实测宿主
 * OAuth 裸 authorization 可查，与 subscription 同款头；ZCode 桌面客户端未引用此端点）。
 * 只用于补充「未使用或近 7 天已过期」的逐卡列表与上次重置时间（status 端点没有过期历史）。
 * 信封 code 0/200；形状不符返回 null（可选数据静默降级，绝不拖累 status 主链），不抛错。 */
function normalizeResetList(body, nowMs) {
  if (!body || typeof body !== "object") return null;
  if ((body.code !== 0 && body.code !== 200) || body.success === false) return null;
  const data = body.data;
  if (!data || typeof data !== "object" || !Array.isArray(data.fiveHourResets) || !Array.isArray(data.weekResets)) return null;
  const t = typeof nowMs === "number" && isFinite(nowMs) ? nowMs : Date.now();
  /* 逐卡白名单：expireTime（服务端 UTC+8）+ grantType + available；过期超 7 天丢弃。
   * grantType 是行首展示值（用户规格 2026-10-28），列表端点有而 status 没有。 */
  const pickCards = (arr) => {
    const out = [];
    for (const it of arr) {
      if (!it || typeof it !== "object") continue;
      const stamp = subscriptionTimestamp(it.expireTime);
      const ms = stamp && stamp.at != null ? stamp.at : null;
      if (ms == null) continue;
      const available = it.available === true;
      if (!available && t - ms > 7 * 24 * 60 * 60 * 1000) continue;
      out.push({ expireAt: ms, grantType: typeof it.grantType === "string" ? it.grantType.slice(0, 24) : "",
        available });
    }
    out.sort((a, b) => a.expireAt - b.expireAt);
    return out;
  };
  const cleanStamp = (v) => (typeof v === "string" && subscriptionTimestamp(v) ? v : null);
  return {
    list: { fiveHour: pickCards(data.fiveHourResets), week: pickCards(data.weekResets) },
    lastFiveHour: cleanStamp(data.lastFiveHourResetTime),
    lastWeek: cleanStamp(data.lastWeekResetTime),
  };
}
/* 订阅周期字段语义（与宿主 bigmodelUsageQuotaMapper.pickCurrentSubscriptionExpireTime 语义对齐且更严）：
 * - nextRenewTime：非自动续费=当前权益结束日；自动续费=下次扣费日（不是最终到期）。
 *   接受纯日期与宿主同款日期时间（空格/T 分隔、可选秒、Z 或 ±hh:mm 偏移；无偏移按
 *   服务端 UTC+8 解释）。
 * - valid 区间可能超前一个计费周期（issue：年度套餐显示 2028-03-14），只有包含
 *   "当前时刻"的区间才能作为权益边界回退；端点带时刻按精确时刻比较（续费日当天
 *   10:00 前未来区间不算生效），仅日期端点按服务端日历日左闭右开；未来/过期/反转/
 *   非法日历或非法时刻（25:99 等）一律整段不采信。
 * - 仅日期的续费边界覆盖整个服务端日：续费日当天上午不清除当前权益显示；
 *   带时刻的续费边界在时刻过后按陈旧数据处理（隐藏日期，不显示下一年）。
 * - currentRenewTime 是当前周期起点；缺失或非法时不暴露，不用未来 valid 起点冒充。 */
const SUB_TZ_OFFSET_MS = 8 * 3600 * 1000;   // BigModel 服务端日历 Asia/Shanghai
function serviceDayMs(day, endExclusive) {
  const y = Number(day.slice(0, 4)), mo = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10)) + (endExclusive ? 1 : 0);
  return Date.UTC(y, mo - 1, d) - SUB_TZ_OFFSET_MS;   // 服务端日的 00:00（endExclusive=次日 00:00）
}
/* 解析单个订阅时间值 → { day, at }；at=精确时刻 ms（值带时刻时），纯日期为 null。
 * 形状/日历/时刻任一非法返回 null（整值拒绝）。 */
function subscriptionTimestamp(value) {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?)?$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  const day = m[1] + "-" + m[2] + "-" + m[3];
  if (m[4] === undefined) return { day: day, at: null };
  const hh = Number(m[4]), mi = Number(m[5]);
  const ss = m[6] === undefined ? 0 : Number(m[6]);
  if (hh > 23 || mi > 59 || ss > 59) return null;
  let at = Date.UTC(y, mo - 1, d, hh, mi, ss);
  if (m[7] === undefined) at -= SUB_TZ_OFFSET_MS;   // 无偏移：服务端时区
  else if (m[7] !== "Z") {
    const offsetHour = Number(m[7].slice(1, 3)), offsetMinute = Number(m[7].slice(-2));
    // ISO 8601：分钟 00-59，小时上限 ±14:00；超界偏移视同非法值
    if (offsetMinute > 59 || offsetHour > 14 || (offsetHour === 14 && offsetMinute > 0)) return null;
    at += (m[7][0] === "+" ? -1 : 1) * (offsetHour * 60 + offsetMinute) * 60000;
  }
  return { day: day, at: at };
}
function parseValidPeriod(value, now) {
  if (typeof value !== "string") return null;
  /* 时刻 token 吸收时偏移必须带冒号（±hh:mm）：免冒号变体会把紧随的下一个日期
   * （"16:28:31-2027-02-28"）误吞成偏移。 */
  const tokens = value.match(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?/g);
  if (!tokens || tokens.length < 2) return null;
  const start = subscriptionTimestamp(tokens[0]);
  const end = subscriptionTimestamp(tokens[tokens.length - 1]);
  if (!start || !end || start.day > end.day) return null;
  const startMs = start.at != null ? start.at : serviceDayMs(start.day, false);
  const endMs = end.at != null ? end.at : serviceDayMs(end.day, false);   // 仅日期末端：日粒度右开
  return { start: start.day, end: end.day, current: startMs <= now && now < endMs };
}
function normalizeSubscriptionPlan(body, nowMs) {
  const data = body && typeof body === "object" && Array.isArray(body.data) ? body.data : null;
  if (!data) return null;
  const active = data.filter((e) => e && typeof e === "object" && e.status === "VALID" && e.inCurrentPeriod === true);
  if (active.length !== 1) return null;
  const s = active[0];
  const now = typeof nowMs === "number" && isFinite(nowMs) ? nowMs : Date.now();
  const autoRenew = s.autoRenew === true || s.autoRenew === 1;
  const nextRenew = subscriptionTimestamp(s.nextRenewTime);
  const currentRenew = subscriptionTimestamp(s.currentRenewTime);
  const valid = parseValidPeriod(s.valid, now);
  const out = {
    version: typeof s.version === "string" ? s.version.slice(0, 8) : "",
    productName: typeof s.productName === "string" ? s.productName.slice(0, 40) : "",
    validStart: "",
    validEnd: "",
  };
  /* 续费边界时刻：带时刻按精确时刻；纯日期覆盖整个服务端日（当天上午仍属当前权益，
   * 服务端 10:00 扣费惯例下不到时刻不清除；时刻已过=陈旧行，不采信）。 */
  const renewBoundary = nextRenew && (nextRenew.at != null ? nextRenew.at : serviceDayMs(nextRenew.day, true)) > now
    ? nextRenew : null;
  if (renewBoundary && currentRenew && currentRenew.day <= renewBoundary.day) out.validStart = currentRenew.day;
  else if (renewBoundary && valid && valid.current) out.validStart = valid.start;
  if (renewBoundary) {
    if (autoRenew) {
      out.renewAt = renewBoundary.day;   // 自动续费：下次扣费日，不声称最终到期
    } else {
      out.validEnd = renewBoundary.day;   // 非自动续费：nextRenewTime 即当前权益结束日
    }
    return out;
  }
  if (valid && valid.current) {
    out.validStart = valid.start;
    if (!autoRenew) out.validEnd = valid.end;
    else out.periodEnd = valid.end;   // 自动续费且无有效扣费日：仅记录当前周期末端
  }
  return out;
}

/* ---------- 余额工具 ---------- */
/* "CNY 110.00" / "¥110.00" / "$12.5" / 110.5 → {amount, currency}；解析不了返回 null */
function parseCurrencyAmount(v, currencyHint) {
  if (typeof v === "number" && isFinite(v)) return { amount: v, currency: currencyHint || "" };
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^([A-Z]{3}|¥|\$)?\s*([\d,]+(?:\.\d+)?)$/);
  if (!m) return null;
  const cur = m[1] === "¥" ? "CNY" : m[1] === "$" ? "USD" : (m[1] || currencyHint || "");
  return { amount: parseFloat(m[2].replace(/,/g, "")), currency: cur };
}
function num(v) {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string" && /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(v.trim())) {
    const value = Number(v);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}
/* 通用窗口行收集：[{period|type, percentUsed|percent|utilization|usage_percentage, resetsAt|reset_at|resets_at|resetTime}] */
function collectWindows(list, defs) {
  const out = {};
  if (!Array.isArray(list)) return out;
  const names = new Map(defs.map((d) => (Array.isArray(d) ? [d[0], d[1]] : [d.match, d.name])));
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const key = String(e.type || e.period || e.window || "").toLowerCase().replace(/[\s_-]/g, "");
    const name = names.get(key);
    if (!name || out[name]) continue;
    let pct = num(e.percentUsed);
    if (pct == null) pct = num(e.percent);
    if (pct == null) pct = num(e.utilization);
    // usage_percentage（ZenMux 0-1 已用小数）：仅在前面字段都缺失时兜底，>1 视作已是百分数
    if (pct == null && e.usage_percentage != null) pct = e.usage_percentage <= 1 ? e.usage_percentage * 100 : e.usage_percentage;
    if (pct == null || !isFinite(pct) || pct < 0) continue;
    out[name] = { percent: Math.round(clampPct(pct) * 10) / 10, resetsAt: resetOf(e.resetsAt != null ? e.resetsAt : (e.resets_at != null ? e.resets_at : e.resetTime)) };
  }
  return out;
}

