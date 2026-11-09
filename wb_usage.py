# -*- coding: utf-8 -*-
"""WorkBuddy 会话用量解析（只读，标准库）。

数据源：`~/.workbuddy/projects/<项目>/<sessionId>.jsonl` 的会话正文。
每次模型调用在 `providerData` 里带了完整的 `rawUsage`（prompt/completion/思考/缓存/credit）
与 `conversationRequestId` + `stepSeq`，所以 WorkBuddy 并非只有会话级数据：

    providerData.rawUsage = {
      prompt_tokens, completion_tokens, total_tokens,
      completion_tokens_details.reasoning_tokens,
      prompt_tokens_details.cached_tokens,
      prompt_cache_hit_tokens / prompt_cache_miss_tokens,
      cache_read_input_tokens, cache_creation_input_tokens, prompt_cache_write_tokens,
      credit
    }

口径（与 ZCode 侧对齐，能对齐的对齐、对不齐的写清楚）：
- 一次「请求」= 一次模型调用（request × step）；同一 (request, step) 可能在 reasoning 与
  function_call 两条记录里重复出现，按 request+step 去重。
- 轮（turn）= 用户消息条数（`type=message, role=user`）。
- 生成耗时：模型响应的 timestamp − 触发它的上一条记录（用户消息或工具结果）的 timestamp，
  即「模型开始出字 → 出完」，工具执行时间不含在内；含思考与网络往返，所以速度是近似值。
  窗口 < 200ms 视为无有效样本（与 ZCode `MIN_GEN_MS` 同口径）。
- 工具调用 = `function_call` 记录数；错误 = `function_call_result` 里非 completed 的条数。
- 费用：按模型分组走 token_pricing 的牌价（MODEL_ALIASES 处理 v4.1 这类命名差异）；价表查不到就不算，返回 None 并在 cost_unknown 里点名，绝不按兜底均价冒充。
- code 变更：WorkBuddy 没有逐会话增删行统计，返回 None（展示层按不可用处理）。

缓存：按 (path, mtime_ns, size) 记住解析结果；文件不变就不重复解析。
"""
import json
import os
from datetime import datetime
from pathlib import Path

MIN_GEN_MS = 200
MAX_GEN_MS = 3_600_000
_SESSION_TIMEOUT_MS = 30 * 60 * 1000

_CACHE = {}
_CACHE_MAX = 512   # 本机会话数可上百；上限太小会反复全量重解析（0.9s/帧）

# 价表是可选增强：旧构建/精简包里没有 token_pricing.py 时，费用整体降级为「不可得」，
# 其余指标照常，不因缺价表把整帧拖垮。
try:
    import token_pricing as _pricing
except ImportError:   # pragma: no cover - 仅在精简部署里发生
    _pricing = None

# WorkBuddy 的模型 id 与价表条目名不总一致：**逐条显式映射**，不做通用模糊替换——
# 错配一个牌价（把 pro 按 flash 计价）比老实写「不可得」更糟。新增别名时把依据写在右边。
MODEL_ALIASES = {
    # 价表里唯一带 v4.1 的条目（models.dev 的 mistral 渠道，2026-10-17 版）；
    # 官方 family 只到 v4，直接按 v4 计价会低估
    "deepseek-v4.1-flash": "deepseek-v4-1-flash-1017",
}


def price_alias(model_id):
    """WorkBuddy 模型 id → 价表查询名；无别名时原样返回（归一为小写）。"""
    name = str(model_id or "").strip().lower()
    return MODEL_ALIASES.get(name, name)


def model_cost(model_id, inp, out, cache_read, cache_write):
    """单模型费用（美元）。返回 (usd|None, meta)。

    None = 该模型在价表里查不到（lookup 落到 default 兜底）= 费用**不可得**，
    调用方必须如实标注，不能拿 DEFAULT_RATES 的 $1/$5 冒充真实牌价。
    meta 带命中键与四价，供报表和浮层说明「按哪条牌价算的」。
    """
    name = str(model_id or "")
    blank = {"model": name, "priced": False}
    if _pricing is None:
        return None, dict(blank, reason="no-pricing")
    key = price_alias(name)
    try:
        rates, hit, level = _pricing.lookup_full(key)
        if level == "default":
            return None, dict(blank, reason="not-in-table")
        usd = _pricing.compute_group_cost(key, "", inp, out, cache_read, cache_write)
    except Exception:   # noqa: BLE001 — 计价失败不影响其它指标
        return None, dict(blank, reason="calc-failed")
    return usd, {
        "model": name, "priced": True, "usd": usd, "key": hit, "level": level,
        "rates": {k: round(float(rates[k]), 6)
                  for k in ("input", "output", "cache_read", "cache_write")},
    }


def cost_of_requests(reqs):
    """一组请求 → (总额|None, 模型明细列表, 未定价模型名列表)。

    按模型分组后各自计价：**只把价表命中的模型计入总额**，未命中的进
    `cost_unknown`，上层据此显示「部分预估」而不是假装全额。
    """
    groups = {}
    for r in reqs:
        g = groups.setdefault(r.get("model") or "", {"input": 0, "output": 0,
                                                    "cache_read": 0, "cache_write": 0,
                                                    "requests": 0})
        g["requests"] += 1
        g["input"] += r.get("prompt", 0)
        g["output"] += r.get("output", 0)
        g["cache_read"] += r.get("cache_read", 0)
        g["cache_write"] += r.get("cache_write", 0)
    total, priced, models, unknown = 0.0, 0, [], []
    for name, g in groups.items():
        usd, meta = model_cost(name, g["input"], g["output"], g["cache_read"], g["cache_write"])
        meta.update({"input": g["input"], "output": g["output"], "requests": g["requests"]})
        if usd is None:
            unknown.append(name or "?")
        else:
            total += usd
            priced += 1
        models.append(meta)
    models.sort(key=lambda m: -m["input"])
    return (round(total, 8) if priced else None), models, unknown


def projects_root(home=None):
    base = Path(home) if home else Path(os.environ.get("WORKBUDDY_HOME") or (Path.home() / ".workbuddy"))
    return base / "projects"


def transcript_paths(home=None):
    """所有会话 JSONL（新到旧）。目录结构 projects/<cwd-slug>/<sessionId>.jsonl。"""
    root = projects_root(home)
    if not root.is_dir():
        return []
    try:
        files = [p for p in root.glob("*/*.jsonl") if p.is_file()]
    except OSError:
        return []
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return files


def session_file(sid, home=None):
    """按 sessionId 找正文文件（可能分布在多个项目目录下）。"""
    root = projects_root(home)
    if not root.is_dir() or not sid:
        return None
    for p in root.glob(f"*/{sid}.jsonl"):
        if p.is_file():
            return p
    return None


def _norm_path(value):
    """路径比较归一：统一斜杠、去尾斜杠、小写（Windows 盘符/分隔符在记录里不一致）。"""
    return str(value or "").replace("\\", "/").rstrip("/").lower()


def _num(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return int(value) if float(value).is_integer() else value


def _usage_of(rec):
    """取一条记录的用量与身份；不是模型调用返回 None。"""
    pd = rec.get("providerData")
    if not isinstance(pd, dict):
        return None
    raw = pd.get("rawUsage")
    if not isinstance(raw, dict):
        return None
    details_out = raw.get("completion_tokens_details") if isinstance(raw.get("completion_tokens_details"), dict) else {}
    details_in = raw.get("prompt_tokens_details") if isinstance(raw.get("prompt_tokens_details"), dict) else {}
    prompt = _num(raw.get("prompt_tokens")) or 0
    output = _num(raw.get("completion_tokens")) or 0
    reasoning = _num(details_out.get("reasoning_tokens")) or _num(raw.get("completion_thinking_tokens")) or 0
    cache_read = (_num(details_in.get("cached_tokens")) or _num(raw.get("prompt_cache_hit_tokens"))
                  or _num(raw.get("cache_read_input_tokens")) or 0)
    cache_write = (_num(raw.get("cache_creation_input_tokens"))
                   or _num(raw.get("prompt_cache_write_tokens")) or 0)
    return {
        "req": str(pd.get("conversationRequestId") or ""),
        "step": _num(pd.get("stepSeq")),
        "model": str(pd.get("model") or pd.get("requestModelId") or ""),
        "agent": str(pd.get("agent") or ""),
        "prompt": int(prompt),
        "output": int(output),
        "reasoning": int(reasoning),
        "cache_read": int(cache_read),
        "cache_write": int(cache_write),
        "credit": float(raw.get("credit") or 0.0),
        "ts": _num(rec.get("timestamp")) or 0,
    }


def parse_transcript(path):
    """解析单个会话正文 → {requests, turns, tool_calls, tool_errors, ...}。失败返回空结构。

    扫描是单趟顺序的：`trigger_ts` 记「上一条能触发模型调用的记录」（用户消息 / 工具结果），
    遇到带 rawUsage 的记录时，gen_ms = 该记录时间 − trigger_ts —— 即模型出字到出完，
    工具执行时间天然不含在内。同一步（request+step）可能在 reasoning 与 function_call
    两条记录里重复，按 key 去重，保留第一条的时间与最大的用量。"""
    path = Path(path)
    empty = {"requests": [], "turns": 0, "tool_calls": 0, "tool_errors": 0,
             "started": 0, "last_at": 0, "cwd": "", "model": "", "title": "",
             "credit": 0.0, "messages": 0, "tools": [], "tool_events": [],
             "turn_starts": []}
    try:
        st = path.stat()
    except OSError:
        return empty
    key = (str(path), st.st_mtime_ns, st.st_size)
    hit = _CACHE.get(key)
    if hit is not None:
        return hit

    seen = {}
    order = []
    tools = {}
    pending = {}
    events = []
    turn_starts = []
    turns = tool_calls = tool_errors = 0
    started = last_at = 0
    cwd = model = title = ""
    trigger_ts = 0
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                rtype = rec.get("type")
                ts = _num(rec.get("timestamp")) or 0
                if rec.get("cwd") and not cwd:
                    cwd = str(rec["cwd"])
                if ts:
                    started = started or ts
                    last_at = max(last_at, ts)

                if rtype == "message":
                    if rec.get("role") == "user":
                        turns += 1
                        turn_starts.append(ts)
                        trigger_ts = ts or trigger_ts
                elif rtype == "ai-title":
                    title = str(rec.get("aiTitle") or title)
                elif rtype == "function_call":
                    tool_calls += 1
                    name = str(rec.get("name") or "?")
                    slot = tools.setdefault(name, {"name": name, "count": 0,
                                                   "errors": 0, "ms": 0})
                    slot["count"] += 1
                    if rec.get("callId"):
                        pending[rec["callId"]] = {"name": name, "ts": ts}
                    events.append({"ts": ts, "name": name, "error": False, "kind": "call"})
                elif rtype == "function_call_result":
                    failed = str(rec.get("status") or "").lower() not in ("completed", "ok", "success")
                    call = pending.pop(rec.get("callId"), None) or {}
                    name = call.get("name") or str(rec.get("name") or "?")
                    slot = tools.setdefault(name, {"name": name, "count": 0, "errors": 0, "ms": 0})
                    if failed:
                        tool_errors += 1
                        slot["errors"] += 1
                    started_ms = call.get("ts") or 0
                    if started_ms and ts > started_ms:      # 工具耗时：调用 → 结果
                        slot["ms"] += ts - started_ms
                    events.append({"ts": ts, "name": name, "error": failed, "kind": "result"})
                    trigger_ts = ts or trigger_ts      # 下一步模型调用的起点
                    continue

                usage = _usage_of(rec)
                if not usage:
                    continue
                usage_key = (usage["req"], usage["step"]) if usage["req"] else ("", usage["ts"])
                gen = (ts - trigger_ts) if trigger_ts and ts > trigger_ts else 0
                prev = seen.get(usage_key)
                if prev is None:
                    usage["gen_ms"] = gen if MIN_GEN_MS <= gen <= MAX_GEN_MS else 0
                    seen[usage_key] = usage
                    order.append(usage_key)
                elif usage["output"] > prev["output"]:
                    prev.update({k: usage[k] for k in ("prompt", "output", "reasoning",
                                                       "cache_read", "cache_write", "credit")})
                if not model:
                    model = usage["model"]
    except OSError:
        return empty

    requests = [seen[k] for k in order]
    requests.sort(key=lambda r: r["ts"])
    for r in requests:
        r["tps"] = (round(r["output"] / (r["gen_ms"] / 1000.0), 1)
                    if r.get("gen_ms") and r["output"] else 0)
    result = {
        "requests": requests,
        "turns": turns,
        "tool_calls": tool_calls,
        "tool_errors": tool_errors,
        "started": started,
        "last_at": last_at,
        "cwd": cwd,
        "model": model,
        "title": title,
        "credit": round(sum(r["credit"] for r in requests), 4),
        "messages": len(requests),
        "tools": sorted(tools.values(), key=lambda t: -t["count"]),
        "tool_events": events,
        "turn_starts": turn_starts,
    }
    if len(_CACHE) > _CACHE_MAX:
        _CACHE.clear()
    _CACHE[key] = result
    return result


def summarize(parsed):
    """把逐请求列表压成与 ZCode 快照同名的汇总字段。"""
    reqs = parsed.get("requests") or []
    tokens_in = sum(r["prompt"] for r in reqs)
    out = sum(r["output"] for r in reqs)
    rea = sum(r["reasoning"] for r in reqs)
    crd = sum(r["cache_read"] for r in reqs)
    cwr = sum(r["cache_write"] for r in reqs)
    total = tokens_in + out
    rated = [r for r in reqs if r.get("gen_ms")]
    rated_out = sum(r["output"] for r in rated)
    gen_ms = sum(r["gen_ms"] for r in rated)
    cost, cost_models, cost_unknown = cost_of_requests(reqs)
    return {
        "turns": parsed.get("turns", 0),
        "requests": len(reqs),
        "input": tokens_in,
        "output": out,
        "reasoning": rea,
        "cache_read": crd,
        "cache_write": cwr,
        "total": total,
        "tool_calls": parsed.get("tool_calls", 0),
        "tool_errors": parsed.get("tool_errors", 0),
        "credits": round(sum(r["credit"] for r in reqs), 4),
        "cost_usd": cost,
        "cost_models": cost_models,
        "cost_unknown": cost_unknown,
        "cost_partial": bool(cost_unknown),
        "avg_tps": round(rated_out / (gen_ms / 1000.0), 1) if gen_ms and rated_out else 0,
        "last_tps": rated[-1]["tps"] if rated else 0,
        "started": parsed.get("started", 0),
        "last_at": parsed.get("last_at", 0),
    }


def last_turn(parsed, max_steps=200):
    """最后一条请求所在轮（同一 request id）的汇总。"""
    reqs = parsed.get("requests") or []
    if not reqs:
        return {}
    req_id = reqs[-1]["req"]
    group = [r for r in reqs if req_id and r["req"] == req_id] or [reqs[-1]]
    group = group[-max_steps:]
    out = sum(r["output"] for r in group)
    rated = [r for r in group if r.get("gen_ms")]
    gen = sum(r["gen_ms"] for r in rated)
    cost, cost_models, cost_unknown = cost_of_requests(group)
    starts = parsed.get("turn_starts") or []
    start_ts = starts[-1] if starts else (group[0]["ts"] if group else 0)
    end_ts = parsed.get("last_at") or (group[-1]["ts"] if group else 0)
    # 本轮工具数：最后一条用户消息之后的所有调用事件；错误数结果事件
    events = [e for e in (parsed.get("tool_events") or [])
              if start_ts and start_ts <= e["ts"] <= end_ts]
    return {
        "requests": len(group),
        "retries": 0,
        "tool_calls": sum(1 for e in events if e.get("kind") == "call"),
        "tool_errors": sum(1 for e in events if e.get("kind") == "result" and e["error"]),
        "input": sum(r["prompt"] for r in group),
        "output": out,
        "reasoning": sum(r["reasoning"] for r in group),
        "cache_read": sum(r["cache_read"] for r in group),
        "cache_write": sum(r["cache_write"] for r in group),
        "total": sum(r["prompt"] + r["output"] for r in group),
        "cost_usd": cost,
        "cost_unknown": cost_unknown,
        "cost_models": cost_models,
        "cost_partial": bool(cost_unknown),
        "duration_ms": gen,
        "ttft_ms": 0,
        "started": group[0]["ts"] if group else 0,
        "ended": group[-1]["ts"] if group else 0,
        "avg_duration_ms": round(gen / len(group)) if group else 0,
        "avg_ttft_ms": 0,
        "tps": round(out / (gen / 1000.0), 1) if gen and out else 0,
        "rated_output": sum(r["output"] for r in rated),
        "unrated_output": out - sum(r["output"] for r in rated),
        "gen_ms": gen,
        "credits": round(sum(r["credit"] for r in group), 4),
    }


def day_bounds(now=None):
    now = now or datetime.now()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(start.timestamp() * 1000), int((start.timestamp() + 86400) * 1000)


def aggregate_since(since_ms, home=None):
    """跨会话按时间窗聚合（今日/项目用）。只看窗口内有活动的文件，避免全量扫描。"""
    totals = {"requests": 0, "input": 0, "output": 0, "reasoning": 0, "cache_read": 0,
              "cache_write": 0, "total": 0, "credits": 0.0, "sessions": 0,
              "tool_calls": 0, "tool_errors": 0, "by_model": {}, "by_cwd": {},
              "cost_usd": None, "cost_unknown": [], "first_at": 0, "last_at": 0}
    for path in transcript_paths(home):
        try:
            if path.stat().st_mtime * 1000 < since_ms:
                continue
        except OSError:
            continue
        parsed = parse_transcript(path)
        reqs = [r for r in parsed.get("requests") or [] if r["ts"] >= since_ms]
        if not reqs:
            continue
        totals["sessions"] += 1
        for r in reqs:
            if r["ts"]:
                if not totals["first_at"] or r["ts"] < totals["first_at"]:
                    totals["first_at"] = r["ts"]
                if r["ts"] > totals["last_at"]:
                    totals["last_at"] = r["ts"]
            totals["requests"] += 1
            totals["input"] += r["prompt"]
            totals["output"] += r["output"]
            totals["reasoning"] += r["reasoning"]
            totals["cache_read"] += r["cache_read"]
            totals["cache_write"] += r["cache_write"]
            totals["total"] += r["prompt"] + r["output"]
            totals["credits"] += r["credit"]
            m = totals["by_model"].setdefault(r["model"] or "?", {
                "model": r["model"] or "?", "requests": 0, "total": 0, "credits": 0.0,
                "input": 0, "output": 0, "cache_read": 0, "cache_write": 0})
            m["requests"] += 1
            m["total"] += r["prompt"] + r["output"]
            m["credits"] += r["credit"]
            m["input"] += r["prompt"]
            m["output"] += r["output"]
            m["cache_read"] += r["cache_read"]
            m["cache_write"] += r["cache_write"]
        key = _norm_path(parsed.get("cwd"))
        c = totals["by_cwd"].setdefault(key, {"requests": 0, "total": 0, "sessions": 0})
        c["sessions"] += 1
        c["requests"] += len(reqs)
        c["total"] += sum(r["prompt"] + r["output"] for r in reqs)
        totals["tool_calls"] += parsed.get("tool_calls", 0)
        totals["tool_errors"] += parsed.get("tool_errors", 0)
    totals["credits"] = round(totals["credits"], 4)
    total_cost, unknown = 0.0, []
    for m in totals["by_model"].values():
        usd, meta = model_cost(m["model"], m["input"], m["output"],
                               m["cache_read"], m["cache_write"])
        if usd is None:
            m["priced"] = False
            unknown.append(m["model"])
        else:
            m["priced"] = True
            m["cost_usd"] = usd
            m["rates"] = meta.get("rates")
            m["price_key"] = meta.get("key")
            total_cost += usd
    totals["cost_usd"] = round(total_cost, 8) if len(unknown) < len(totals["by_model"]) else None
    totals["cost_unknown"] = unknown
    totals["cost_partial"] = bool(unknown)
    totals["by_model"] = sorted(totals["by_model"].values(), key=lambda m: -m["total"])
    return totals


def aggregate_cwd(cwd, home=None):
    """同一工作区的跨会话聚合（项目累计）。只解析 cwd 命中的文件，命中结果按文件缓存。"""
    cwd = str(cwd or "")
    out = {"sessions": 0, "requests": 0, "turns": 0, "input": 0, "output": 0,
           "cache_read": 0, "total": 0,
           "credits": 0.0, "tool_calls": 0, "tool_errors": 0,
           "cost_usd": None, "cost_unknown": [], "cost_partial": False,
           "priced_sessions": 0, "first_at": 0, "last_at": 0, "models": []}
    if not cwd:
        return out
    for path in transcript_paths(home):
        parsed = parse_transcript(path)
        if _norm_path(parsed.get("cwd")) != _norm_path(cwd):
            continue
        summ = summarize(parsed)
        out["sessions"] += 1
        out["requests"] += summ["requests"]
        out["input"] += summ["input"]
        out["output"] += summ["output"]
        out["cache_read"] += summ["cache_read"]
        out["total"] += summ["total"]
        out["credits"] += summ["credits"]
        out["turns"] += summ["turns"]
        out["tool_calls"] += summ["tool_calls"]
        out["tool_errors"] += summ["tool_errors"]
        started, last = summ.get("started") or 0, summ.get("last_at") or 0
        if started and (not out["first_at"] or started < out["first_at"]):
            out["first_at"] = started
        if last > out["last_at"]:
            out["last_at"] = last
        # 按模型合并（同一模型可能出现在多个会话）
        by_model = {m["model"]: m for m in out["models"]}
        for m in summ.get("cost_models") or []:
            name = m.get("model") or "?"
            slot = by_model.get(name)
            if slot is None:
                slot = by_model[name] = {"model": name, "requests": 0, "input": 0,
                                         "output": 0, "priced": bool(m.get("priced")),
                                         "cost_usd": None, "rates": m.get("rates")}
                out["models"].append(slot)
            slot["requests"] += int(m.get("requests") or 0)
            slot["input"] += int(m.get("input") or 0)
            slot["output"] += int(m.get("output") or 0)
            if m.get("usd") is not None:
                slot["cost_usd"] = (slot["cost_usd"] or 0.0) + m["usd"]
        if summ.get("cost_usd") is not None:
            out["cost_usd"] = (out["cost_usd"] or 0.0) + summ["cost_usd"]
            out["priced_sessions"] += 1
        for name in summ.get("cost_unknown") or []:
            if name not in out["cost_unknown"]:
                out["cost_unknown"].append(name)
    out["credits"] = round(out["credits"], 4)
    if out["cost_usd"] is not None:
        out["cost_usd"] = round(out["cost_usd"], 8)
    for m in out["models"]:
        if m["cost_usd"] is not None:
            m["cost_usd"] = round(m["cost_usd"], 8)
    out["models"].sort(key=lambda m: -m["input"])
    out["cost_partial"] = bool(out["cost_unknown"])
    return out


def fmt(n):
    n = n or 0
    if n >= 1_000_000_000:
        return f"{n / 1e9:.2f}B"
    if n >= 1_000_000:
        return f"{n / 1e6:.2f}M"
    if n >= 1_000:
        return f"{n / 1e3:.1f}K"
    return str(int(n))


def render(sid=None, home=None):
    """CLI 文本报表（排查用）。"""
    path = session_file(sid, home) if sid else (transcript_paths(home) or [None])[0]
    if not path:
        return "未找到 WorkBuddy 会话正文（projects/*/*.jsonl）"
    parsed = parse_transcript(path)
    s = summarize(parsed)
    lt = last_turn(parsed)
    lines = [
        f"■ WorkBuddy 会话 {parsed.get('title') or path.stem}",
        f"  文件 {path}",
        f"  模型 {parsed.get('model') or '?'}  轮 {s['turns']}  请求 {s['requests']}  "
        f"工具 {s['tool_calls']}（错误 {s['tool_errors']}）",
        f"  input {fmt(s['input'])}（cache read {fmt(s['cache_read'])}）  "
        f"output {fmt(s['output'])}（思考 {fmt(s['reasoning'])}）  合计 {fmt(s['total'])}",
        f"  credit {s['credits']:.2f}  平均速度 {s['avg_tps']} t/s  最近一段 {s['last_tps']} t/s",
        f"  本轮 请求 {lt.get('requests', 0)}  合计 {fmt(lt.get('total', 0))}  "
        f"耗时 {round((lt.get('duration_ms') or 0) / 1000, 1)}s  {lt.get('tps', 0)} t/s",
    ]
    return "\n".join(lines)


if __name__ == "__main__":
    import sys
    print(render(sys.argv[1] if len(sys.argv) > 1 else None))
