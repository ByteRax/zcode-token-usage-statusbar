# -*- coding: utf-8 -*-
"""WorkBuddy 正文用量解析回归（wb_usage.py）。

夹具直接用官方格式的最小 JSONL：session-meta / user message / function_call(带 rawUsage)
/ function_call_result / ai-title。锁住「同一 request+step 只算一次」「工具错误归到工具名」
「生成窗口按触发者时间算」这些容易写错的口径。
"""
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]

spec = importlib.util.spec_from_file_location("wb_usage_test", ROOT / "wb_usage.py")
wb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wb)

SID = "0ec5ca32-2a8f-4d36-8de2-c7f2ff0299e2"


def usage(prompt, completion, reasoning=0, cached=0, credit=0.1):
    return {
        "prompt_tokens": prompt, "completion_tokens": completion,
        "total_tokens": prompt + completion,
        "completion_tokens_details": {"reasoning_tokens": reasoning, "cached_tokens": 0},
        "prompt_tokens_details": {"cached_tokens": cached},
        "prompt_cache_hit_tokens": cached, "prompt_cache_miss_tokens": prompt - cached,
        "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0,
        "prompt_cache_write_tokens": 0, "credit": credit,
    }


def rec(rtype, ts, **kw):
    base = {"id": f"{rtype}-{ts}", "type": rtype, "timestamp": ts, "sessionId": SID,
            "cwd": "d:\\work\\demo", "_meta": {}}
    base.update(kw)
    return base


def call(ts, req, step, prompt, completion, tool="Bash", model="deepseek-v4.1-flash", **kw):
    return rec("function_call", ts, callId=f"c-{req}-{step}", name=tool,
               providerData={"conversationRequestId": req, "stepSeq": step, "model": model,
                             "agent": "cli", "rawUsage": usage(prompt, completion, **kw)})


def result(ts, req, step, status="completed", tool="Bash"):
    return rec("function_call_result", ts, callId=f"c-{req}-{step}", name=tool, status=status,
               providerData={"conversationRequestId": req, "stepSeq": step})


class ParseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "projects" / "d-work-demo"
        self.root.mkdir(parents=True)
        self.path = self.root / f"{SID}.jsonl"

    def write(self, rows):
        self.path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
                             encoding="utf-8")
        wb._CACHE.clear()

    def test_turns_requests_tools_and_errors(self):
        self.write([
            rec("session-meta", 1000),
            rec("message", 1000, role="user", content=[]),
            rec("ai-title", 1100, aiTitle="演示会话"),
            call(3000, "r1", 1, 1000, 100, cached=800, credit=0.2),
            result(3500, "r1", 1),
            call(6000, "r1", 2, 1200, 200, reasoning=50, cached=900, credit=0.3),
            result(6800, "r1", 2, status="incomplete"),
            rec("message", 9000, role="user", content=[]),
            call(12000, "r2", 1, 1500, 300, tool="Edit", credit=0.4),
        ])
        parsed = wb.parse_transcript(self.path)
        self.assertEqual(parsed["turns"], 2)
        self.assertEqual(len(parsed["requests"]), 3)          # 三次模型调用
        self.assertEqual(parsed["tool_calls"], 3)
        self.assertEqual(parsed["tool_errors"], 1)
        self.assertEqual(parsed["title"], "演示会话")
        self.assertEqual(parsed["model"], "deepseek-v4.1-flash")
        self.assertAlmostEqual(parsed["credit"], 0.9, places=4)
        by_tool = {t["name"]: t for t in parsed["tools"]}
        self.assertEqual(by_tool["Bash"]["count"], 2)
        self.assertEqual(by_tool["Bash"]["errors"], 1)        # 错误归属到发起调用的工具
        self.assertEqual(by_tool["Edit"]["count"], 1)

        summ = wb.summarize(parsed)
        self.assertEqual(summ["requests"], 3)
        self.assertEqual(summ["input"], 3700)                 # 1000+1200+1500
        self.assertEqual(summ["output"], 600)
        self.assertEqual(summ["reasoning"], 50)
        self.assertEqual(summ["cache_read"], 1700)
        self.assertEqual(summ["total"], 4300)
        self.assertEqual(summ["tool_calls"], 3)

    def test_generation_window_uses_trigger_timestamp(self):
        self.write([
            rec("message", 1000, role="user", content=[]),
            call(3000, "r1", 1, 1000, 500),          # 用户消息 → 响应：2000ms
            result(3500, "r1", 1),
            call(4000, "r1", 2, 1000, 100),          # 工具结果 → 响应：500ms
        ])
        parsed = wb.parse_transcript(self.path)
        first, second = parsed["requests"][0], parsed["requests"][1]
        self.assertEqual(first["gen_ms"], 2000)
        self.assertEqual(first["tps"], 250.0)
        self.assertEqual(second["gen_ms"], 500)
        self.assertEqual(second["tps"], 200.0)

    def test_dedupes_same_request_step(self):
        """同一步在 reasoning 与 function_call 两条记录里都会带 rawUsage，只算一次（取较大值）。"""
        rows = [
            rec("message", 1000, role="user", content=[]),
            rec("reasoning", 3000, providerData={"conversationRequestId": "r1", "stepSeq": 1,
                                                 "model": "m", "rawUsage": usage(1000, 80)}),
            call(3010, "r1", 1, 1000, 120),
        ]
        self.write(rows)
        parsed = wb.parse_transcript(self.path)
        self.assertEqual(len(parsed["requests"]), 1)
        self.assertEqual(parsed["requests"][0]["output"], 120)
        self.assertEqual(wb.summarize(parsed)["total"], 1120)

    def test_bad_lines_and_missing_usage_are_tolerated(self):
        self.path.write_text(
            '{"type":"message","role":"user","timestamp":1000}\n'
            '{not json\n'
            '{"type":"function_call","timestamp":2000,"providerData":{}}\n'
            '{"type":"function_call","timestamp":3000,"providerData":{"rawUsage":'
            '{"prompt_tokens":10,"completion_tokens":5}}}\n',
            encoding="utf-8")
        wb._CACHE.clear()
        parsed = wb.parse_transcript(self.path)
        self.assertEqual(parsed["turns"], 1)
        self.assertEqual(len(parsed["requests"]), 1)          # 只有带 rawUsage 的那条算请求
        self.assertEqual(parsed["requests"][0]["prompt"], 10)

    def test_aggregates_are_path_and_window_scoped(self):
        self.write([
            rec("message", 1000, role="user", content=[]),
            call(3000, "r1", 1, 100, 10),
        ])
        with mock.patch.dict(os.environ, {"WORKBUDDY_HOME": self.tmp.name}):
            proj = wb.aggregate_cwd("D:/work/demo")            # 大小写与分隔符都该归一
            self.assertEqual(proj["sessions"], 1)
            self.assertEqual(proj["total"], 110)
            today = wb.aggregate_since(0)
            self.assertEqual(today["requests"], 1)
            future = wb.aggregate_since(10 ** 15)
            self.assertEqual(future["requests"], 0)

    def test_tool_durations_and_turn_tool_counts(self):
        """工具耗时 = 调用→结果；本轮工具数按「最后一条用户消息之后」统计，且只数调用。"""
        self.write([
            rec("message", 1000, role="user", content=[]),
            call(3000, "r1", 1, 1000, 100, tool="Bash"),
            result(3500, "r1", 1, tool="Bash"),
            call(6000, "r1", 2, 1200, 100, tool="Edit"),
            result(6400, "r1", 2, tool="Edit", status="incomplete"),
        ])
        parsed = wb.parse_transcript(self.path)
        by_tool = {t["name"]: t for t in parsed["tools"]}
        self.assertEqual(by_tool["Bash"]["ms"], 500)
        self.assertEqual(by_tool["Edit"]["ms"], 400)
        turn = wb.last_turn(parsed)
        self.assertEqual(turn["tool_calls"], 2)     # 两次调用（结果事件不重复计数）
        self.assertEqual(turn["tool_errors"], 1)    # 一条结果失败

    def test_missing_file_returns_empty(self):
        parsed = wb.parse_transcript(self.root / "不存在.jsonl")
        self.assertEqual(parsed["requests"], [])
        self.assertEqual(parsed["turns"], 0)


class CostTests(unittest.TestCase):
    """预估费用：别名映射、未收录模型不冒充 0、聚合求和、价表缺失降级。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # 价表缓存重定向到临时目录：读开发机真实 pricing-cache.json 的话，models.dev
        # 改价经 12h 同步落盘后，下面的精确牌价断言会随机红（内置表本身是确定的）
        wb._pricing.configure({}, config_dir=self.tmp.name)
        self.root = Path(self.tmp.name) / "projects" / "d-work-demo"
        self.root.mkdir(parents=True)
        self.path = self.root / f"{SID}.jsonl"

    def write(self, rows):
        self.path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
                             encoding="utf-8")
        wb._CACHE.clear()

    def test_non_object_json_lines_are_skipped(self):
        """合法 JSON 但非对象（数组/字符串行）必须跳过：单行坏正文不能炸整帧解析。"""
        self.path.write_text(
            "[1, 2]\n"
            '"str-line"\n'
            + json.dumps(rec("message", 1000, role="user", content=[]), ensure_ascii=False) + "\n"
            + json.dumps(call(3000, "r1", 1, 100, 10), ensure_ascii=False) + "\n",
            encoding="utf-8")
        wb._CACHE.clear()
        parsed = wb.parse_transcript(self.path)
        self.assertEqual(parsed["turns"], 1)
        self.assertEqual(len(parsed["requests"]), 1)
        self.assertEqual(parsed["requests"][0]["prompt"], 100)

    def test_alias_resolves_v41_to_the_only_v41_entry(self):
        # 价表里官方 family 只到 v4；v4.1 必须走别名，否则会按 v4 低估
        self.assertEqual(wb.price_alias("DeepSeek-V4.1-Flash"), "deepseek-v4-1-flash-1017")
        self.assertEqual(wb.price_alias("deepseek-v4-pro"), "deepseek-v4-pro")
        usd, meta = wb.model_cost("deepseek-v4.1-flash", 1_000_000, 100_000, 0, 0)
        self.assertIsNotNone(usd)
        self.assertTrue(meta["priced"])
        self.assertEqual(meta["key"], "deepseek-v4-1-flash-1017")
        self.assertAlmostEqual(usd, 1_000_000 * 0.3 / 1e6 + 100_000 * 1.2 / 1e6, places=8)

    def test_unpriced_model_is_none_instead_of_fallback_rates(self):
        usd, meta = wb.model_cost("hy4-preview", 1_000_000, 100_000, 0, 0)
        self.assertIsNone(usd)                  # 不拿 DEFAULT_RATES 的 $1/$5 冒充
        self.assertFalse(meta["priced"])
        self.assertEqual(meta["reason"], "not-in-table")

    def test_summary_counts_only_priced_models_and_flags_partial(self):
        self.write([
            rec("message", 1000, role="user", content=[]),
            call(3000, "r1", 1, 1000, 100),
            call(4000, "r2", 1, 2000, 200, model="hy4-preview"),
        ])
        summ = wb.summarize(wb.parse_transcript(self.path))
        self.assertIsNotNone(summ["cost_usd"])
        self.assertTrue(summ["cost_partial"])
        self.assertEqual(summ["cost_unknown"], ["hy4-preview"])
        by_model = {m["model"]: m for m in summ["cost_models"]}
        self.assertTrue(by_model["deepseek-v4.1-flash"]["priced"])
        self.assertNotIn("cost_usd", by_model["hy4-preview"])

    def test_aggregates_sum_cost_and_merge_unknown_models(self):
        self.write([
            rec("message", 1000, role="user", content=[]),
            call(3000, "r1", 1, 1000, 100),
            call(4000, "r2", 1, 2000, 200, model="hy4-preview"),
        ])
        with mock.patch.dict(os.environ, {"WORKBUDDY_HOME": self.tmp.name}):
            today = wb.aggregate_since(0)
            proj = wb.aggregate_cwd("D:/work/demo")
        for agg in (today, proj):
            self.assertIsNotNone(agg["cost_usd"])
            self.assertTrue(agg["cost_partial"])
            self.assertEqual(agg["cost_unknown"], ["hy4-preview"])

    def test_project_aggregate_has_model_breakdown(self):
        self.write([
            rec("message", 1000, role="user", content=[]),
            call(3000, "r1", 1, 1000, 100),
            call(4000, "r1", 2, 1200, 100),
        ])
        with mock.patch.dict(os.environ, {"WORKBUDDY_HOME": self.tmp.name}):
            proj = wb.aggregate_cwd("D:/work/demo")
        self.assertEqual(proj["turns"], 1)
        self.assertEqual(len(proj["models"]), 1)
        self.assertEqual(proj["models"][0]["requests"], 2)
        self.assertIsNotNone(proj["models"][0]["cost_usd"])

    def test_missing_pricing_module_degrades_to_unavailable(self):
        with mock.patch.object(wb, "_pricing", None):
            usd, meta = wb.model_cost("deepseek-v4.1-flash", 1000, 100, 0, 0)
            self.assertIsNone(usd)
            self.assertEqual(meta["reason"], "no-pricing")
            parsed = wb.summarize({"requests": [], "turns": 0})
            self.assertIsNone(parsed["cost_usd"])


if __name__ == "__main__":
    unittest.main()
