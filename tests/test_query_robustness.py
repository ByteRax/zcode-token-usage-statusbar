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
            '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"token_usage","arguments":{"scope":"today"}}}',
            'not json at all',
        ]
        out = self._run(frames)
        self.assertIn('"id": 2', out)   # params null 的 initialize 仍正常应答
        self.assertIn('"id": 4', out)   # 合法 tools/call 正常应答
        self.assertIn("ok", out)
        self.assertNotIn('"id": 1', out)          # 非对象帧按 -32600 回错（id null），不静默
        # params 非对象归一为 {} → 无 name：按未知工具报错而不是带崩进程
        self.assertIn('"id": 3, "error"', out)
        self.assertIn("-32602", out)



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


class McpProtocolTests(unittest.TestCase):
    """2026-10-24 第 4 轮：JSON-RPC/MCP 规范符合性（ping/-32700/通知/未知工具/协议版本）。"""

    def _run(self, frames):
        import types

        class _Stdin:
            def __iter__(self):
                return iter(frames)

        buf = io.StringIO()
        con = types.SimpleNamespace(close=lambda: None)

        class _Err(list):
            pass

        import contextlib

        with mock.patch.object(sys, "stdin", _Stdin()), redirect_stdout(buf), \
                mock.patch.object(usage_mcp.zusage, "connect", lambda: con), \
                mock.patch.object(usage_mcp.zusage, "render_today", lambda c: "ok"):
            usage_mcp.main()
        return buf.getvalue()

    def test_ping_returns_empty_result(self):
        out = self._run(['{"jsonrpc":"2.0","id":1,"method":"ping"}'])
        self.assertIn('"id": 1, "result": {}', out)

    def test_bad_json_gets_parse_error_with_null_id(self):
        out = self._run(["{not json"])
        self.assertIn("-32700", out)
        self.assertIn('"id": null', out)

    def test_batch_frame_gets_invalid_request(self):
        out = self._run(["[]"])
        self.assertIn("-32600", out)

    def test_notification_gets_no_reply(self):
        out = self._run(['{"jsonrpc":"2.0","method":"tools/list"}'])   # 无 id = 通知
        self.assertEqual(out, "")

    def test_unknown_tool_name_is_rejected(self):
        out = self._run(['{"jsonrpc":"2.0","id":7,"method":"tools/call",'
                         '"params":{"name":"other_tool","arguments":{"scope":"today"}}}'])
        self.assertIn("-32602", out)
        self.assertIn("other_tool", out)
        self.assertNotIn("ok", out, "未知工具名不得执行 token_usage")

    def test_initialize_declares_only_supported_protocol_version(self):
        out = self._run(['{"jsonrpc":"2.0","id":2,"method":"initialize",'
                         '"params":{"protocolVersion":"2099-01-01"}}'])
        self.assertIn(usage_mcp.PROTOCOL_VERSION, out)
        self.assertNotIn("2099-01-01", out)


class SessionPrefixTests(unittest.TestCase):
    """2026-10-24 第 4 轮：前缀含 LIKE 通配符（真实会话 id 含 _）须按字面匹配。"""

    def test_underscore_prefix_matches_literal_only(self):
        con = fixture(sqlite3.connect(":memory:"))
        self.addCleanup(con.close)
        for sid, title in (("session_abc123", "right"), ("sessionXabc123", "wrong")):
            con.execute("insert into session (id, title) values (?, ?)", (sid, title))
            con.execute("insert into model_usage (id, session_id, status, query_source, model_id,"
                        " started_at, completed_at, input_tokens, output_tokens)"
                        " values (?, ?, 'completed', 'main_turn', 'GLM-5.3', 100, 200, 10, 100)",
                        ("r" + sid, sid))
        text = zusage.render_session_detail(con, "session_ab")
        self.assertIn("right", text)
        self.assertNotIn("wrong", text)

    def test_empty_prefix_is_rejected(self):
        con = fixture(sqlite3.connect(":memory:"))
        self.addCleanup(con.close)
        self.assertIn("前缀", zusage.render_session_detail(con, "  "))


class McpNullIdTests(unittest.TestCase):
    """显式 "id": null 是请求不是通知（复查 MINOR）：须回 id null，不得静默。"""

    def _run(self, frames):
        import types

        class _Stdin:
            def __iter__(self):
                return iter(frames)

        buf = io.StringIO()
        with mock.patch.object(sys, "stdin", _Stdin()), redirect_stdout(buf):
            usage_mcp.main()
        return buf.getvalue()

    def test_explicit_null_id_request_gets_a_null_id_response(self):
        out = self._run(['{"jsonrpc":"2.0","id":null,"method":"ping"}'])
        self.assertIn('"id": null, "result": {}', out)
