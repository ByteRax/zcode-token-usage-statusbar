# -*- coding: utf-8 -*-
"""Usage rate calculations shared by CLI and snapshots; no database or host state."""
import math

MIN_GEN_MS = 200
MAX_GEN_MS = 3_600_000


def hides_reasoning(model_id):
    return "claude" in (model_id or "").lower()


def round1(value):
    rounded = round(value, 1)
    return int(rounded) if rounded == int(rounded) else rounded


def _number(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value))


def query_first_token_covers(con):
    """「首块即落章」provider 集合（zusage._provider_first_token_covers 与
    token_rate.first_token_covers 共用单一事实源）：对该 provider 的
    (reasoning_tokens, time_to_first_token_ms) 做最小二乘斜率，<2.0 ms/token 说明
    首字时间不随推理量增长——思考在首字后随输出流出，首字窗口已含思考；样本 <5
    或推理量无变化不判（走 started_at 推理前置默认）。"""
    if con is None:
        return frozenset()
    try:
        rows = con.execute(
            """select provider_id, count(*) n,
                      sum(reasoning_tokens) sx, sum(time_to_first_token_ms) sy,
                      sum(reasoning_tokens * time_to_first_token_ms) sxy,
                      sum(reasoning_tokens * reasoning_tokens) sxx
               from model_usage
               where reasoning_tokens > 0 and time_to_first_token_ms is not null
                 and provider_id is not null
               group by provider_id""").fetchall()
    except Exception:
        return frozenset()
    out = set()
    for r in rows:
        n = r[1] or 0
        sx = r[2] or 0
        denom = n * (r[5] or 0) - sx * sx
        if n < 5 or denom <= 0:
            continue
        slope = (n * (r[4] or 0) - sx * (r[3] or 0)) / denom
        if slope < 2.0:
            out.add(r[0])
    return frozenset(out)


def request_stats(row, covers=frozenset()):
    """Output includes reasoning. Missing/invalid generation windows stay unrated.
    Thinking rows default to the started_at window (thinking before the first token);
    providers in `covers` stream thinking after the first token, so their thinking is
    already inside the first-token window and the window stays first_token_at-based."""
    output = row["output_tokens"] or 0
    reasoning = row["reasoning_tokens"] or 0
    completed = row["completed_at"]
    thinking = reasoning > 0 or hides_reasoning(row["model_id"])
    try:
        pid = row["provider_id"]
    except (KeyError, IndexError):
        pid = None
    start = row["started_at"] if thinking and pid not in covers else row["first_token_at"]
    duration = completed - start if _number(completed) and _number(start) and completed > start else None
    reason = None
    if duration is None:
        reason = "missingGenerationWindow"
    elif not MIN_GEN_MS <= duration < MAX_GEN_MS:
        reason = "generationWindowOutOfRange"
    elif not _number(output) or output <= 0:
        reason = "noOutput"
    rated = reason is None
    ttft = row["time_to_first_token_ms"]
    return {
        "model": row["model_id"],
        "outputTokens": output,
        "reasoningTokens": reasoning,
        "ttftMs": ttft if _number(ttft) and ttft >= 0 else None,
        "genMs": duration,
        "tokPerSec": round1(output / duration * 1000) if rated else None,
        "completedAt": completed,
        "ratedOutput": output if rated else 0,
        "unratedOutput": 0 if rated else output,
        "rateUnavailableReason": reason,
    }


def aggregate_requests(items):
    """Weighted rate uses only rated output/windows, never all output as numerator."""
    items = list(items)
    rated = [item for item in items if item["tokPerSec"] is not None]
    output = sum(item["outputTokens"] for item in items)
    rated_output = sum(item["outputTokens"] for item in rated)
    duration = sum(item["genMs"] for item in rated)
    return {
        "requests": len(items),
        "rated": len(rated),
        "unrated": len(items) - len(rated),
        "totalOutput": output,
        "totalReasoning": sum(item["reasoningTokens"] for item in items),
        "ratedOutput": rated_output,
        "unratedOutput": output - rated_output,
        "rateCoverage": rated_output / output if output > 0 else None,
        "genMs": duration,
        "tokPerSec": round1(rated_output / duration * 1000) if rated else None,
        "peak": max((item["tokPerSec"] for item in rated), default=None),
    }
