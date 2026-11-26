#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""负载判据：只读本机用量库，量最近一段时间的限流与子代理等首字情况。

用来判断现在该逐路派审查员还是可以同轮并发、限流失败后要不要马上续跑、派发前报多长的
预计用时。规则与阈值见 specs/review-agent-concurrency.md，工具契约见 specs/dev-loop-speed.md。

用法：
  python3 -B scripts/model_load.py                 # 近 30 分钟
  python3 -B scripts/model_load.py --minutes 60
  python3 -B scripts/model_load.py --db <库路径>   # 默认用 zusage.resolve_db_path 解析出的库
"""
import argparse
import os
import sqlite3
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SUBAGENT_PREFIX = "sess_subagent_"
CONCURRENT_MIN_REQUESTS = 5   # 恢复同轮并发：默认模型子代理请求的条数下限
FAST_MEDIAN_S = 5.0            # 等首字中位数低于它算通畅
BUSY_RATIO = 0.20              # 主会话被限流的比例达到它算拥挤
BUCKET_MS = 10 * 60 * 1000     # 明细按 10 分钟一行
_COLUMNS = ("session_id", "model_id", "query_source", "started_at", "first_token_at", "retry_count")


def default_db_path():
    sys.path.insert(0, str(ROOT))
    import zusage   # 延迟导入：只在真跑的时候加载查询库，测试可以完全不经它
    return zusage.resolve_db_path()


def load_rows(db_path, since_ms):
    """窗口内已完成（status='completed'）的请求行；进行中/取消/出错的不算，
    与 zusage 查询口径一致。库不存在或读不了时原样抛出，由 main 报错退出。"""
    path = Path(os.path.abspath(os.fspath(db_path)))
    con = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=3)
    try:
        return [dict(zip(_COLUMNS, row)) for row in con.execute(
            "select session_id, model_id, query_source, started_at, first_token_at, retry_count"
            " from model_usage where started_at >= ? and status = 'completed'", (since_ms,))]
    finally:
        con.close()


def median(values):
    ordered = sorted(values)
    if not ordered:
        return None
    mid = len(ordered) // 2
    return ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2.0


def _is_main(row):
    # 与 zusage 查询口径一致：query_source 为 NULL 视同 main_turn
    return not row["session_id"].startswith(SUBAGENT_PREFIX) and row["query_source"] in (None, "main_turn")


def _is_sub(row):
    return row["session_id"].startswith(SUBAGENT_PREFIX)


def _limited(row):
    return (row["retry_count"] or 0) > 0


def _wait_s(row):
    return (row["first_token_at"] - row["started_at"]) / 1000.0


def _cell(rows):
    main = [r for r in rows if _is_main(r)]
    waits = [_wait_s(r) for r in rows if _is_sub(r) and r["first_token_at"]]
    return {"main": len(main), "limited": sum(1 for r in main if _limited(r)),
            "sub": sum(1 for r in rows if _is_sub(r)), "sub_wait_median": median(waits)}


def summarize(rows, since_ms, until_ms):
    main = [r for r in rows if _is_main(r)]
    subs = [r for r in rows if _is_sub(r)]
    # 默认模型取窗口内主会话请求里最多的那个，不在脚本里写死
    default_model = Counter(r["model_id"] for r in main).most_common(1)[0][0] if main else None
    own = [r for r in subs if default_model is not None and r["model_id"] == default_model]
    other = [r for r in subs if default_model is None or r["model_id"] != default_model]
    own_median = median([_wait_s(r) for r in own if r["first_token_at"]])
    ratio = (sum(1 for r in main if _limited(r)) / len(main)) if main else None
    concurrent = (default_model is not None and len(own) >= CONCURRENT_MIN_REQUESTS
                  and own_median is not None and own_median < FAST_MEDIAN_S)
    buckets = []
    start = since_ms - since_ms % BUCKET_MS
    for begin in range(start, until_ms, BUCKET_MS):
        cell = _cell([r for r in rows if begin <= r["started_at"] < begin + BUCKET_MS])
        if cell["main"] or cell["sub"]:
            buckets.append(dict(begin=begin, **cell))
    return {
        "since_ms": since_ms, "until_ms": until_ms,
        "default_model": default_model,
        "main": len(main), "limited": sum(1 for r in main if _limited(r)), "ratio": ratio,
        "own": len(own), "own_wait_median": own_median,
        "other": len(other), "other_wait_median": median([_wait_s(r) for r in other if r["first_token_at"]]),
        "busy": ratio is not None and ratio >= BUSY_RATIO,
        "concurrent": concurrent,
        "buckets": buckets,
    }


def _clock(ms):
    return time.strftime("%H:%M", time.localtime(ms / 1000.0))


def _seconds(value):
    return "无样本" if value is None else f"{value:.1f} 秒"


def verdict(summary):
    if summary["default_model"] is None:
        return "无法判定（窗口内没有主会话请求），按不满足处理：逐路派发"
    parts = []
    if summary["ratio"] is not None:
        state = "拥挤" if summary["busy"] else "不拥挤"
        parts.append(f"{state}（主会话被限流 {summary['ratio'] * 100:.0f}%）")
    if summary["concurrent"]:
        parts.append(f"可同轮并发（默认模型子代理 {summary['own']} 条，中位 {_seconds(summary['own_wait_median'])}）")
    else:
        why = (f"只有 {summary['own']} 条，不足 {CONCURRENT_MIN_REQUESTS} 条" if summary["own"] < CONCURRENT_MIN_REQUESTS
               else f"中位 {_seconds(summary['own_wait_median'])}，不低于 {FAST_MEDIAN_S:.0f} 秒")
        parts.append(f"逐路派发（默认模型子代理{why}）")
    return "；".join(parts)


def format_report(summary):
    lines = [f"近 {(summary['until_ms'] - summary['since_ms']) // 60000} 分钟（{_clock(summary['since_ms'])}–{_clock(summary['until_ms'])}）"]
    if summary["default_model"] is None:
        lines.append("主会话：窗口内没有请求")
    else:
        pct = f"{summary['ratio'] * 100:.0f}%" if summary["ratio"] is not None else "-"
        lines.append(f"主会话：请求 {summary['main']} 次，被限流 {summary['limited']} 次（{pct}）；默认模型 {summary['default_model']}")
        lines.append(f"默认模型子代理：请求 {summary['own']} 条，等首字中位 {_seconds(summary['own_wait_median'])}")
        lines.append(f"其它模型子代理：请求 {summary['other']} 条，等首字中位 {_seconds(summary['other_wait_median'])}")
    if summary["buckets"]:
        lines.append("每 10 分钟： 时间  主会话请求 限流  子代理请求 等首字中位")
        for b in summary["buckets"]:
            lines.append(f"  {_clock(b['begin'])}  {b['main']:4}  {b['limited']:3}  {b['sub']:4}  {_seconds(b['sub_wait_median'])}")
    lines.append("结论：" + verdict(summary))
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="量最近的限流与子代理等首字情况（只读用量库）")
    parser.add_argument("--minutes", type=int, default=30, help="回看多少分钟，默认 30")
    parser.add_argument("--db", help="用量库路径，默认按 zusage.resolve_db_path 解析")
    args = parser.parse_args(argv)
    if args.minutes <= 0:
        parser.error("--minutes 必须是正数")
    until_ms = int(time.time() * 1000)
    since_ms = until_ms - args.minutes * 60 * 1000
    try:
        db_path = args.db or default_db_path()
        rows = load_rows(db_path, since_ms)
    except (sqlite3.Error, OSError) as exc:
        print(f"读不了用量库：{exc}", file=sys.stderr)
        return 2
    print(format_report(summarize(rows, since_ms, until_ms)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
