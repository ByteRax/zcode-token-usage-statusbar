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
        self.assertEqual(self.tps("GLM-5.3", first_token=False), 71.2)  # 缺首字：退化总耗时

    def test_rule_matches_rate_line(self):
        models = ["claude-opus-5-5", "anthropic/claude-3.7-sonnet", "Claude-Sonnet-4",
                  "GLM-5.3", "gpt-6.1-sol", "", None]
        expected = [True, True, True, False, False, False, False]
        self.assertEqual([zusage.hides_reasoning(m) for m in models], expected)
        self.assertEqual([token_rate.hides_reasoning(m) for m in models], expected)


if __name__ == "__main__":
    unittest.main()
