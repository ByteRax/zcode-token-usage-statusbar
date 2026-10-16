# -*- coding: utf-8 -*-
"""状态条「生成速度」（zusage._session_snapshot 的 last.tps）与逐问速率行同一计时口径。

运行：python3 -B -m unittest discover -s tests -p 'test_*.py'
"""
import importlib.util
import sqlite3
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PLUGIN = REPO / "plugins" / "zcode-token-usage-statusbar"
if str(PLUGIN) not in sys.path:
    sys.path.append(str(PLUGIN))   # token_rate 依赖同目录的 runtime_lock


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


zusage = load("statusbar_rate_zusage", REPO / "zusage.py")
token_rate = load("statusbar_rate_token_rate", PLUGIN / "token_rate.py")

# 只建 _session_snapshot 实际读取的表与列
SCHEMA = """
create table session (id text primary key, title text, parent_id text, time_created integer,
  summary_additions integer, summary_deletions integer, summary_files integer);
create table model_usage (id text primary key, session_id text, turn_id text, query_source text,
  agent text, model_id text, status text, started_at integer, first_token_at integer,
  completed_at integer, duration_ms integer, time_to_first_token_ms integer, input_tokens integer,
  output_tokens integer, reasoning_tokens integer, cache_read_input_tokens integer,
  cache_creation_input_tokens integer, computed_total_tokens integer, tool_call_count integer,
  retry_count integer, context_exceeded integer);
create table turn_usage (session_id text, turn_id text, status text, model_request_count integer,
  model_retry_count integer, tool_call_count integer, tool_error_count integer, input_tokens integer,
  output_tokens integer, reasoning_tokens integer, cache_read_input_tokens integer,
  cache_creation_input_tokens integer, computed_total_tokens integer, duration_ms integer,
  time_to_first_token_ms integer);
create table tool_usage (session_id text, tool_name text, status text, duration_ms integer);
"""


class StatusbarRateTests(unittest.TestCase):
    def tps(self, model, reasoning=0, first_token=True):
        """与真库显示 753.2 t/s 的那次请求同款数据：输出 1074，首字 13661ms，总耗时 15087ms。"""
        con = sqlite3.connect(":memory:")
        self.addCleanup(con.close)
        con.row_factory = sqlite3.Row
        con.executescript(SCHEMA)
        con.execute("insert into session (id, title) values ('s', 't')")
        start = 1_000_000
        con.execute("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    ("r1", "s", "turn", "main_turn", "", model, "completed", start,
                     start + 13661 if first_token else None, start + 15087, 15087,
                     13661 if first_token else None, 10, 1074, reasoning, 0, 0, 1084, 0, 0, 0))
        return zusage._session_snapshot(con, "s", {"context_window": 200000})["last"]["tps"]

    def test_claude_unreported_thinking_counts_from_request_start(self):
        # 回归：按首字窗口曾显示 1074 ÷ 1.426s = 753.2 t/s。
        self.assertEqual(self.tps("claude-opus-5-5"), 71.2)

    def test_window_rule_for_other_models_is_unchanged(self):
        self.assertEqual(self.tps("GLM-5.3"), 753.2)                    # 无思考：首字窗口
        self.assertEqual(self.tps("gpt-6.1-sol", reasoning=224), 71.2)  # 上报思考：整段
        # 缺首字 + 无思考段：窗口起点本就是 first_token_at，严格口径不评分；单条记录
        # 没有更早的有效请求可回退，留空（chip 隐藏）。2026-10-16 修复前（v77.2）这里
        # 曾退化用 duration_ms 估算，1074 tok/15.087s 得到的 71.2 看着"合理"，但那只是
        # 巧合——真库 11 token/6.173s 的尾巴请求用同一公式会显示 1.8 t/s 这种荒谬值，
        # 本质是把等待期当成了生成期。
        self.assertIsNone(self.tps("GLM-5.3", first_token=False))
        # 思考段窗口起点本就是 started_at（不看 first_token_at），缺首字不影响评分，
        # 严格口径直接给出 71.2——这两条根本不会走到我的回退分支。
        self.assertEqual(self.tps("claude-opus-5-5", first_token=False), 71.2)
        self.assertEqual(self.tps("gpt-6.1-sol", reasoning=224, first_token=False), 71.2)

    def test_missing_first_token_falls_back_to_last_valid_request(self):
        """回归（2026-10-16 真库案例）：缺首字的请求不可信，v77.3 向前找最近一条严格口径
        评分通过的请求顶上显示，而不是像 v77.2 那样用它自己的总耗时硬算。"""
        con = sqlite3.connect(":memory:")
        self.addCleanup(con.close)
        con.row_factory = sqlite3.Row
        con.executescript(SCHEMA)
        con.execute("insert into session (id, title) values ('s', 't')")
        base = 1_000_000
        # 有效请求：441 token，首字后 4316ms 产出 → 102.2 t/s（真库原始数字）
        con.execute("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    ("r1", "s", "turn", "main_turn", "", "GLM-5.3", "completed", base,
                     base + 10000 - 4316, base + 10000, 10000, 4316, 10, 441, 0, 0, 0, 451, 0, 0, 0))
        # 缺首字的小尾巴请求：11 token，总耗时 6173ms（v77.2 会算出 11/6.173≈1.8 t/s）
        con.execute("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    ("r2", "s", "turn", "main_turn", "", "GLM-5.3", "completed", base + 10000,
                     None, base + 10000 + 6173, 6173, None, 10, 11, 0, 0, 0, 21, 0, 0, 0))
        last = zusage._session_snapshot(con, "s", {"context_window": 200000})["last"]
        self.assertEqual(last["tps"], 102.2)                       # 回退到 r1 的真实速度
        self.assertEqual(last["rateUnavailableReason"], "missingGenerationWindow")  # 明细仍诚实

    def test_same_record_entrypoints_match_all_window_boundaries(self):
        for model, reasoning in (("plain", 0), ("thinking", 20), ("claude", 0)):
            for duration in (199, 200, 3599999, 3600000):
                with self.subTest(model=model, duration=duration):
                    con = sqlite3.connect(":memory:")
                    con.row_factory = sqlite3.Row
                    con.executescript(SCHEMA)
                    con.execute("insert into session (id, title) values ('s', 't')")
                    start = 1000000
                    con.execute("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                ("r1", "s", "turn", "main_turn", "", model, "completed", start,
                                 start, start + duration, duration, 0, 10, 100, reasoning,
                                 0, 0, 110, 0, 0, 0))
                    record = con.execute("select * from model_usage").fetchone()
                    rate = token_rate.to_item(record)
                    last = zusage._session_snapshot(con, "s", {"context_window": 200000})["last"]
                    self.assertEqual(last["tps"], rate["tokPerSec"])
                    self.assertEqual(last["genMs"], rate["genMs"])
                    self.assertEqual(last["ratedOutput"], rate["ratedOutput"])
                    self.assertEqual(last["unratedOutput"], rate["unratedOutput"])
                    self.assertEqual(rate["tokPerSec"] is not None, 200 <= duration < 3600000)
                    con.close()

    def test_rule_matches_rate_line(self):
        models = ["claude-opus-5-5", "anthropic/claude-3.7-sonnet", "Claude-Sonnet-4",
                  "GLM-5.3", "gpt-6.1-sol", "", None]
        expected = [True, True, True, False, False, False, False]
        self.assertEqual([zusage.hides_reasoning(m) for m in models], expected)
        self.assertEqual([token_rate.hides_reasoning(m) for m in models], expected)


if __name__ == "__main__":
    unittest.main()
