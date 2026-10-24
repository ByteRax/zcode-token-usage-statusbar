# -*- coding: utf-8 -*-
"""查询链健壮性回归：坏帧/NULL 列/损坏库不能带崩进程或整帧快照。

覆盖（2026-10-24 夜间扫描）：
- usage_mcp 对非对象消息与非对象 params 按未知帧跳过（曾 AttributeError 杀进程）。
- _scan_session_ids 遇全 NULL completed_at 的会话不再 TypeError（曾击穿整帧快照）。
- render_current / _session_snapshot 的 NULL title、NULL duration_ms 归一（口径对齐轻快照）。
- _provider_fallback 列漂移按空串降级。
- 损坏数据库（非 SQLite 文件）CLI 输出友好提示而非 traceback。

运行：python3 -B -m unittest discover -s tests -p 'test_query_robustness.py'
"""
import importlib.util
import io
import sqlite3
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


zusage = load("query_robust_zusage", REPO / "zusage.py")
usage_mcp = load("query_robust_usage_mcp", REPO / "usage_mcp.py")

SCHEMA = """
create table session (id text primary key, title text, parent_id text, time_created integer,
  directory text,
  summary_additions integer, summary_deletions integer, summary_files integer);
create table model_usage (id text primary key, session_id text, turn_id text, query_source text,
  agent text, provider_id text, model_id text, status text, started_at integer, first_token_at integer,
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


def fixture(con):
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return con


class ScanSessionIdsTests(unittest.TestCase):
    def setUp(self):
        zusage._AGG_CACHE.clear()   # "scan" 键全局缓存，测试间必须清

    def _con(self):
        con = fixture(sqlite3.connect(":memory:"))
        self.addCleanup(con.close)
        return con

    def _scan(self, con):
        zusage._AGG_CACHE.clear()
        return [tuple(r) for r in zusage._scan_session_ids(con)]

    def test_all_null_completed_session_does_not_raise(self):
        """崩溃残留的全 NULL 会话（未完成行）不得让 max() 比较抛 TypeError。"""
        con = self._con()
        con.execute("insert into model_usage (id, session_id, status, started_at) values ('r','s','running',100)")
        self.assertEqual(self._scan(con), [("s", 0)])

    def test_mixed_sessions_pick_latest_completed(self):
        con = self._con()
        con.execute("insert into session (id, title) values ('a', 'A'), ('b', 'B')")
        con.execute("insert into model_usage (id, session_id, status, started_at, completed_at)"
                    " values ('r1','a','running',100, NULL)")
        con.execute("insert into model_usage (id, session_id, status, started_at, completed_at)"
                    " values ('r2','b','completed',200, 5000)")
        self.assertEqual(self._scan(con), [("a", 0), ("b", 5000)])
        zusage._AGG_CACHE.clear()
        # render_current 全链不崩且选中 b
        self.assertIn("B", zusage.render_current(con))

    def test_render_current_null_title(self):
        con = self._con()
        con.execute("insert into session (id, title) values ('s', NULL)")
        con.execute("insert into model_usage (id, session_id, status, started_at, completed_at)"
                    " values ('r','s','completed',100, 5000)")
        zusage._AGG_CACHE.clear()
        # NULL title 曾 TypeError；现在应正常渲染（空标题）
        self.assertIn("当前会话", zusage.render_current(con))


class SnapshotNullTests(unittest.TestCase):
    def test_null_title_and_duration_normalize(self):
        con = fixture(sqlite3.connect(":memory:"))
        self.addCleanup(con.close)
        con.execute("insert into session (id, title) values ('s', NULL)")
        con.execute("insert into model_usage (id, session_id, status, query_source, started_at, completed_at,"
                    " duration_ms, time_to_first_token_ms, input_tokens, output_tokens)"
                    " values ('r','s','completed','main_turn',100, 5000, NULL, 50, 10, 100)")
        snap = zusage._session_snapshot(con, "s", {"context_window": 200000})
        self.assertEqual(snap["title"], "")            # 曾输出 None（轻快照恒 ""）
        self.assertEqual(snap["last"]["duration_ms"], 0)  # 曾输出 None（轻快照恒 0）


class ProviderFallbackTests(unittest.TestCase):
    def test_missing_column_degrades_to_empty(self):
        con = sqlite3.connect(":memory:")
        self.addCleanup(con.close)
        con.execute("create table model_usage (id text)")
        self.assertEqual(zusage._provider_fallback(con), "")

    def test_returns_latest_account_provider(self):
        con = fixture(sqlite3.connect(":memory:"))
        self.addCleanup(con.close)
        con.execute("insert into model_usage (id, session_id, status, query_source, provider_id, completed_at)"
                    " values ('r','s','completed','main_turn','account:bigmodel-start-plan', 900)")
        con.execute("insert into model_usage (id, session_id, status, query_source, provider_id, completed_at)"
                    " values ('r2','s','completed','main_turn','custom:relay', 1000)")
        self.assertEqual(zusage._provider_fallback(con), "account:bigmodel-start-plan")

    def test_none_con(self):
        self.assertEqual(zusage._provider_fallback(None), "")


class CorruptDbTests(unittest.TestCase):
    def test_cli_prints_friendly_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "db.sqlite"
            bad.write_bytes(b"this is definitely not a sqlite file" * 8)
            out = io.StringIO()
            with mock.patch.object(zusage, "DB_PATH", bad), redirect_stdout(out):
                rc = zusage.main(["now"])
            self.assertEqual(rc, 1)
            self.assertIn("查询失败", out.getvalue())


class McpBadFrameTests(unittest.TestCase):
    def _run(self, frames):
        import types

        class _Stdin:
            def __iter__(self):
                return iter(frames)

        buf = io.StringIO()
        con = types.SimpleNamespace(close=lambda: None)
        with mock.patch.object(sys, "stdin", _Stdin()), redirect_stdout(buf), \
                mock.patch.object(usage_mcp.zusage, "connect", lambda: con), \
                mock.patch.object(usage_mcp.zusage, "render_today", lambda c: "ok"):
            usage_mcp.main()   # 修复前：首帧即 AttributeError
        return buf.getvalue()

    def test_non_object_and_bad_params_frames_are_skipped(self):
        frames = [
            '[{"jsonrpc":"2.0","id":1,"method":"ping"}]',          # batch 数组
            '"just a string"',
            '{"jsonrpc":"2.0","id":2,"method":"initialize","params":null}',
            '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":[]}',
            '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"arguments":{"scope":"today"}}}',
            'not json at all',
        ]
        out = self._run(frames)
        self.assertIn('"id": 2', out)   # params null 的 initialize 仍正常应答
        self.assertIn('"id": 4', out)   # 合法 tools/call 正常应答
        self.assertIn("ok", out)
        self.assertNotIn('"id": 1', out)          # 非对象帧静默跳过
        # params 非对象的 tools/call 归一为无参调用，走错误应答而不是带崩进程
        self.assertIn('"id": 3', out)
        self.assertIn('"isError": true', out)



class ScnetEstimateTests(unittest.TestCase):
    def test_sql_failure_degrades_to_none_not_zero_credits(self):
        """聚合 SQL 失败（列漂移）按未配置软隐藏，不显示 0.00/全新套餐（fail-closed）。"""
        con = sqlite3.connect(":memory:")
        self.addCleanup(con.close)
        con.execute("create table model_usage (id text)")   # 缺列：SELECT 必失败
        cfg = {"enabled": True, "planCredits": 500.0,
               "modelPatterns": {"GLM*": "glm-4.6"}}
        with mock.patch.object(zusage, "_scnet_source_cfg", return_value=cfg):
            self.assertIsNone(zusage._scnet_estimate(con))


class CliCountTests(unittest.TestCase):
    def test_invalid_and_nonpositive_arguments_exit_with_message(self):
        out = io.StringIO()
        with redirect_stdout(out):
            with self.assertRaises(SystemExit) as ctx:
                zusage._cli_count(["days", "x"], 7)
        self.assertEqual(ctx.exception.code, 2)
        self.assertIn("无效参数", out.getvalue())
        out2 = io.StringIO()
        with redirect_stdout(out2):
            with self.assertRaises(SystemExit):
                zusage._cli_count(["watch", "0"], 5)   # 曾忙循环
        out3 = io.StringIO()
        with redirect_stdout(out3):
            self.assertEqual(zusage._cli_count(["days"], 7), 7)     # 缺省
            self.assertEqual(zusage._cli_count(["days", "14"], 7), 14)

if __name__ == "__main__":
    unittest.main()
