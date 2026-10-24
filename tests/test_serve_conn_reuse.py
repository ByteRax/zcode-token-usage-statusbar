# -*- coding: utf-8 -*-
"""serve 常驻连接复用回归（fork perf/only 同源收编）。

覆盖：跨请求复用同一连接、snapshot 一次性路径每调用自开自关、连接死亡后探活重建、
空闲超阈值重建、库文件被替换（st_ino 变化）重建、空闲连接不碍 WAL checkpoint。
"""
import importlib.util
import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("zusage_serve_test", REPO / "zusage.py")
zusage = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(zusage)

# 与 test_statusbar_rate 同款：snapshot 全链实际读取的表与列
SCHEMA = """
create table session (id text primary key, title text, parent_id text, time_created integer,
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


class ServeReuseTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.db = Path(tmp.name) / "db.sqlite"
        self.make_db()
        self.conns = []
        real_connect = zusage.connect
        calls = []

        def counting_connect():
            calls.append(1)
            con = real_connect()
            self.conns.append(con)
            return con

        self.calls = calls
        self.db_patch = mock.patch.object(zusage, "DB_PATH", self.db)
        self.db_patch.start()
        self.addCleanup(self.db_patch.stop)
        self.conn_patch = mock.patch.object(zusage, "connect", counting_connect)
        self.conn_patch.start()
        self.addCleanup(self.conn_patch.stop)
        zusage._AGG_CACHE.clear()

    def make_db(self, with_row=True):
        con = sqlite3.connect(self.db)
        try:
            con.executescript(SCHEMA)
            if with_row:
                con.execute("insert into session (id, title) values ('s1', 't')")
                con.execute("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            ("r1", "s1", "turn", "main_turn", "", "account:test", "model-x", "completed",
                             1_000_000, 1_013_661, 1_015_087, 15087, 13661, 10, 1074, 0, 0, 0, 1084, 0, 0, 0))
            con.commit()
        finally:
            con.close()

    def run_serve(self, lines):
        out = io.StringIO()
        stdin = io.StringIO("".join(lines))
        with mock.patch.object(zusage.sys, "stdin", stdin), mock.patch.object(zusage.sys, "stdout", out):
            zusage.serve()
        return [json.loads(x) for x in out.getvalue().splitlines()]

    def test_serve_reuses_one_connection_across_requests(self):
        payloads = self.run_serve(["\n", "\n", ""])
        self.assertEqual(len(payloads), 2)
        for p in payloads:
            self.assertNotIn("error", p)
            self.assertFalse(p.get("local_error"))
        self.assertEqual(len(self.calls), 1, "两请求应只建一次连接")
        self.assertEqual(len(self.conns), 1)

    def test_snapshot_oneshot_path_opens_and_closes_per_call(self):
        zusage.snapshot()
        zusage.snapshot()
        self.assertEqual(len(self.calls), 2, "无 serve_con 时每次自建自关")
        for con in self.conns:
            self.assertRaises(sqlite3.ProgrammingError, con.execute, "select 1")

    def test_serve_rebuilds_after_connection_death(self):
        payloads = self.run_serve(["\n"])
        self.assertEqual(len(self.calls), 1)
        self.conns[0].close()   # 模拟查询期出错被 snapshot 就地 close：探活必须重建
        payloads = self.run_serve(["\n", ""])
        self.assertEqual(len(payloads), 1)
        self.assertNotIn("error", payloads[0])
        self.assertEqual(len(self.calls), 2, "死连接探活后应重建")

    def test_serve_recycles_after_idle_threshold(self):
        with mock.patch.object(zusage, "_SERVE_IDLE_S", -1.0):   # 任意空闲即回收
            payloads = self.run_serve(["\n", "\n", ""])
        self.assertEqual(len(payloads), 2)
        for p in payloads:
            self.assertNotIn("error", p)
        self.assertEqual(len(self.calls), 2, "空闲超阈值后应重建")

    def test_serve_recycles_when_db_file_replaced(self):
        payloads = self.run_serve(["\n"])
        self.assertEqual(len(self.calls), 1)
        self.db.unlink()
        self.make_db()   # 新 inode：stat 必变
        payloads = self.run_serve(["\n", ""])
        self.assertEqual(len(payloads), 1)
        self.assertNotIn("error", payloads[0])
        self.assertEqual(len(self.calls), 2, "库文件被替换后应重建")

    def test_idle_connection_does_not_block_wal_checkpoint(self):
        writer = sqlite3.connect(self.db)
        self.addCleanup(writer.close)
        writer.execute("pragma journal_mode=wal")
        writer.execute("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       ("r2", "s1", "turn", "main_turn", "", "account:test", "model-x", "completed",
                        2_000_000, 2_013_661, 2_015_087, 15087, 13661, 10, 1074, 0, 0, 0, 1084, 0, 0, 0))
        writer.commit()   # WAL 现在有未 checkpoint 的页
        reader = zusage.connect()
        self.addCleanup(reader.close)
        reader.execute("select count(*) from model_usage").fetchall()   # 游标穷尽：不持读锁
        ckpt = writer.execute("pragma wal_checkpoint(truncate)").fetchone()
        self.assertEqual(ckpt[0], 0, "空闲复用连接不得阻塞 WAL checkpoint（busy=1 即回归）")


if __name__ == "__main__":
    unittest.main()
