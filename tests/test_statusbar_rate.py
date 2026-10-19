# -*- coding: utf-8 -*-
"""状态条「生成速度」（zusage._session_snapshot 的 last.tps）与逐问速率行同一计时口径。

运行：python3 -B -m unittest discover -s tests -p 'test_*.py'
"""
import importlib.util
import sqlite3
import sys
import unittest
from pathlib import Path
from unittest import mock

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
        # 缺首字且无更早的有效请求可回退：不可信，返回 0（2026-10-16 修复前曾退化用总耗时
        # 硬算，等待期被当成生成期；真库 11 token/6.173s 的尾巴请求曾借此显示 1.8 t/s）
        self.assertEqual(self.tps("GLM-5.3", first_token=False), 0)

    def test_rule_matches_rate_line(self):
        models = ["claude-opus-5-5", "anthropic/claude-3.7-sonnet", "Claude-Sonnet-4",
                  "GLM-5.3", "gpt-6.1-sol", "", None]
        expected = [True, True, True, False, False, False, False]
        self.assertEqual([zusage.hides_reasoning(m) for m in models], expected)
        self.assertEqual([token_rate.hides_reasoning(m) for m in models], expected)

    def _insert_row(self, con, rid, model, started_at, completed_at, output_tokens,
                     first_token_at=None, reasoning=0, turn_id="turn"):
        con.execute("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (rid, "s", turn_id, "main_turn", "", model, "completed", started_at,
                     first_token_at, completed_at, completed_at - started_at,
                     (completed_at - first_token_at) if first_token_at else None,
                     10, output_tokens, reasoning, 0, 0, output_tokens + 10, 0, 0, 0))

    def test_missing_first_token_falls_back_to_last_valid_request(self):
        """回归（2026-10-16 真库案例）：first_token_at 缺失的请求不可信——等待期会被当成
        生成期。状态栏应向前找最近一条时间戳完整的请求代替，而非用它自己的总耗时硬算。"""
        con = sqlite3.connect(":memory:")
        self.addCleanup(con.close)
        con.row_factory = sqlite3.Row
        con.executescript(SCHEMA)
        con.execute("insert into session (id, title) values ('s', 't')")
        base = 1_000_000
        # 有效请求：441 token，首字后 4316ms 产出 → 102.2 t/s（真库原始数字）
        self._insert_row(con, "r1", "GLM-5.3", base, base + 10000, 441,
                          first_token_at=base + 10000 - 4316)
        # 缺首字的小尾巴请求：11 token，总耗时 6173ms（旧逻辑会算出 11/6.173≈1.8 t/s）
        self._insert_row(con, "r2", "GLM-5.3", base + 10000, base + 10000 + 6173, 11,
                          first_token_at=None)
        tps = zusage._session_snapshot(con, "s", {"context_window": 200000})["last"]["tps"]
        self.assertEqual(tps, 102.2)   # 回退到 r1 的真实速度，而非 1.8

    def test_missing_first_token_with_no_valid_fallback_is_zero(self):
        """全部请求都缺首字时拿不到可信速度，返回 0（chip 按既有约定隐藏，不新增文案）。"""
        con = sqlite3.connect(":memory:")
        self.addCleanup(con.close)
        con.row_factory = sqlite3.Row
        con.executescript(SCHEMA)
        con.execute("insert into session (id, title) values ('s', 't')")
        base = 1_000_000
        self._insert_row(con, "r1", "GLM-5.3", base, base + 6173, 11, first_token_at=None)
        tps = zusage._session_snapshot(con, "s", {"context_window": 200000})["last"]["tps"]
        self.assertEqual(tps, 0)

    def test_tooltip_rate_and_span_follow_valid_sample(self):
        con = sqlite3.connect(":memory:")
        self.addCleanup(con.close)
        con.row_factory = sqlite3.Row
        con.executescript(SCHEMA)
        con.execute("insert into session (id, title, time_created) values ('s', 't', 900000)")
        self._insert_row(con, "r1", "GLM-5.3", 1000000, 1010000, 441,
                         first_token_at=1005684)
        self._insert_row(con, "r2", "GLM-5.3", 1010000, 1016173, 11)
        for completed_turn in (False, True):
            with self.subTest(completed_turn=completed_turn):
                if completed_turn:
                    con.execute("insert into turn_usage (session_id,turn_id,status,output_tokens,duration_ms) "
                                "values ('s','turn','completed',452,99000)")
                snap = zusage._session_snapshot(con, "s", {"context_window": 200000})
                self.assertEqual(snap["last"]["tps"], 102.2)
                self.assertEqual((snap["last"]["startedAt"], snap["last"]["endedAt"]),
                                 (1000000, 1010000))
                self.assertEqual(snap["last"]["duration_ms"], 6173)
                turn = snap["last_turn"]
                self.assertEqual(turn["tps"], 102.2)
                self.assertEqual(turn["rated_output"], 441)
                self.assertEqual(turn["unrated_output"], 11)
                self.assertEqual(turn["gen_ms"], 4316)
                self.assertEqual((turn["started"], turn["ended"]), (1000000, 1016173))
                self.assertEqual(turn["duration_ms"], 99000 if completed_turn else 16173)

    def test_turn_rate_is_weighted_and_excludes_invalid_windows(self):
        con = sqlite3.connect(":memory:")
        self.addCleanup(con.close)
        con.row_factory = sqlite3.Row
        con.executescript(SCHEMA)
        con.execute("insert into session (id,title) values ('s','t')")
        self._insert_row(con, "r1", "GLM-5.3", 1000, 5000, 100, first_token_at=3000)
        self._insert_row(con, "r2", "claude-sonnet", 10000, 14000, 300, first_token_at=13000)
        self._insert_row(con, "r3", "GLM-5.3", 15000, 15100, 50, first_token_at=15001)
        self._insert_row(con, "r4", "GLM-5.3", 16000, 3616000, 70, first_token_at=16000)
        turn = zusage._session_snapshot(con, "s", {"context_window": 200000})["last_turn"]
        self.assertEqual(turn["tps"], 66.7)
        self.assertEqual(turn["gen_ms"], 6000)
        self.assertEqual(turn["rated_output"], 400)
        self.assertEqual(turn["unrated_output"], 120)

    def test_unrated_request_does_not_publish_speed_sample_span(self):
        con = sqlite3.connect(":memory:")
        self.addCleanup(con.close)
        con.row_factory = sqlite3.Row
        con.executescript(SCHEMA)
        con.execute("insert into session (id,title) values ('s','t')")
        self._insert_row(con, "r1", "GLM-5.3", 1000, 5000, 100)
        snap = zusage._session_snapshot(con, "s", {"context_window": 200000})
        self.assertEqual(snap["last_turn"]["tps"], 0)
        self.assertEqual(snap["last_turn"]["unrated_output"], 100)
        self.assertEqual((snap["last"]["startedAt"], snap["last"]["endedAt"]), (0, 0))

    def test_today_cache_keeps_totals_and_span_together_across_midnight(self):
        con = sqlite3.connect(":memory:")
        self.addCleanup(con.close)
        con.row_factory = sqlite3.Row
        con.executescript(SCHEMA)
        day = zusage._day_start()
        start = zusage._epoch_ms(day)
        proxy = mock.Mock(wraps=con)
        proxy.close = mock.Mock()
        with mock.patch.object(zusage, "connect", return_value=proxy), \
             mock.patch.object(zusage, "load_config", return_value={"context_window": 200000}), \
             mock.patch.object(zusage, "_AGG_CACHE", {}), \
             mock.patch.object(zusage, "_day_start", return_value=day) as day_start, \
             mock.patch.object(zusage, "_scan_session_ids", return_value=[]), \
             mock.patch.object(zusage, "_remote_setup", return_value=None):
            empty = zusage.snapshot()["today"]
            self.assertEqual((empty["requests"], empty["started"], empty["last_at"]), (0, 0, 0))
            self._insert_row(con, "r1", "GLM-5.3", start + 1000, start + 5000, 100)
            cached = zusage.snapshot()["today"]
            self.assertEqual(cached, empty)
            zusage._AGG_CACHE.clear()
            updated = zusage.snapshot()["today"]
            self.assertEqual((updated["requests"], updated["started"], updated["last_at"]),
                             (1, start + 1000, start + 5000))
            day_start.return_value = day + zusage.timedelta(days=1)
            tomorrow = zusage.snapshot()["today"]
            self.assertEqual((tomorrow["requests"], tomorrow["started"], tomorrow["last_at"]), (0, 0, 0))

    def test_session_span_excludes_failed_requests_in_full_and_light_snapshots(self):
        con = sqlite3.connect(":memory:")
        self.addCleanup(con.close)
        con.row_factory = sqlite3.Row
        con.executescript(SCHEMA)
        con.execute("insert into session (id,title,time_created) values ('s','t',500)")
        self._insert_row(con, "r1", "GLM-5.3", 1000, 5000, 100, first_token_at=2000)
        self._insert_row(con, "error", "GLM-5.3", 6000, 9000, 100)
        con.execute("update model_usage set status='error' where id='error'")
        for fn in (zusage._session_snapshot, zusage._light_snapshot):
            with self.subTest(snapshot=fn.__name__):
                snap = fn(con, "s", {"context_window": 200000})
                self.assertEqual((snap["started"], snap["last_at"]), (1000, 5000))
                self.assertEqual(snap["requests"], 1)

    def test_today_span_uses_start_of_requests_completed_today(self):
        con = sqlite3.connect(":memory:")
        con.row_factory = sqlite3.Row
        con.executescript(SCHEMA)
        day = zusage._epoch_ms(zusage._day_start())
        self._insert_row(con, "old", "GLM-5.3", day - 10000, day - 1000, 100)
        self._insert_row(con, "cross", "GLM-5.3", day - 5000, day + 1000, 100)
        self._insert_row(con, "failed", "GLM-5.3", day - 20000, day + 2000, 100)
        con.execute("update model_usage set status='error' where id='failed'")
        with mock.patch.object(zusage, "connect", return_value=con), \
             mock.patch.object(zusage, "load_config", return_value={"context_window": 200000}), \
             mock.patch.object(zusage, "_cached_agg", side_effect=lambda key, fn: fn()), \
             mock.patch.object(zusage, "_scan_session_ids", return_value=[]), \
             mock.patch.object(zusage, "_remote_setup", return_value=None):
            today = zusage.snapshot()["today"]
        self.assertEqual(today["requests"], 1)
        self.assertEqual((today["started"], today["last_at"]), (day - 5000, day + 1000))


if __name__ == "__main__":
    unittest.main()
