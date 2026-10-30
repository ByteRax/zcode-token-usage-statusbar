# -*- coding: utf-8 -*-
"""项目累计（v159）：zusage._project_usage 聚合口径与 snapshot 注入/降级。

口径：session.project_id 同项目的全部主会话 + 其子代理会话（completed），
turns 按 session_id+turn_id 组合去重，worktree（不同 directory→project_id）不混入。
漂移夹具沿用 test_statusbar_rate 的最小表集（session 无 project_id 列）。

运行：python3 -B -m unittest discover -s tests -p 'test_*.py'
"""
import importlib.util
import sqlite3
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


zusage = load("project_usage_zusage", REPO / "zusage.py")

SCHEMA = """
create table session (id text primary key, title text, parent_id text, project_id text,
  directory text, time_created integer, summary_additions integer, summary_deletions integer,
  summary_files integer);
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

# 漂移库：session 表无 project_id/directory 列（旧宿主库形态），_project_usage 走降级
DRIFT_SCHEMA = """
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


class FixtureBase(unittest.TestCase):
    def fixture(self, schema=SCHEMA):
        con = sqlite3.connect(":memory:")
        self.addCleanup(con.close)
        con.row_factory = sqlite3.Row
        con.executescript(schema)
        return con

    def sess(self, con, sid, project="proj_repo", directory="/repo", parent=None):
        con.execute(
            "insert into session (id, title, parent_id, project_id, directory, time_created)"
            " values (?,?,?,?,?,?)", (sid, "t", parent, project, directory, 100))

    def usage(self, con, rid, sid, turn="t1", started=1000, completed=2000, total=100,
              status="completed", model="GLM-5.3"):
        con.execute(
            "insert into model_usage (id, session_id, turn_id, query_source, provider_id,"
            " model_id, status, started_at, first_token_at, completed_at, input_tokens,"
            " output_tokens, reasoning_tokens, cache_read_input_tokens,"
            " cache_creation_input_tokens, computed_total_tokens, tool_call_count, retry_count)"
            " values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (rid, sid, turn, "main_turn", "account:test", model, status, started,
             started + 10, completed, 60, 30, 5, 40, 2, total, 1, 0))


class ProjectUsageAggTests(FixtureBase):
    def test_aggregates_project_sessions_including_subagents(self):
        con = self.fixture()
        self.sess(con, "m1")
        self.sess(con, "m2")
        self.sess(con, "sess_subagent_x", parent="m1")   # 子代理：project_id 随父
        self.sess(con, "w1", project="proj_repo_worktrees-x", directory="/repo/.worktrees/x")
        self.usage(con, "r1", "m1", turn="t1", total=100)
        self.usage(con, "r2", "m1", turn="t2", started=2500, completed=3000, total=200)
        self.usage(con, "r3", "m2", turn="t1", total=50)
        self.usage(con, "r4", "sess_subagent_x", turn="t1", total=50)
        self.usage(con, "r5", "w1", turn="t1", total=999)   # worktree 独立项目
        p = zusage._project_usage(con, "m1")
        self.assertEqual(p["sessions"], 3)                  # m1/m2/子代理；worktree 不算
        self.assertEqual(p["turns"], 4)                     # m1/t1 m1/t2 m2/t1 sub/t1
        self.assertEqual(p["requests"], 4)
        self.assertEqual(p["total"], 400)                   # 不含 worktree 的 999
        self.assertEqual(p["input"], 240)
        self.assertEqual(p["output"], 120)
        self.assertEqual((p["started"], p["last_at"]), (1000, 3000))
        # 从子代理会话查询也归属同一项目（project_id 随父复制）
        self.assertEqual(zusage._project_usage(con, "sess_subagent_x")["total"], 400)

    def test_turn_id_reuse_counts_per_session(self):
        con = self.fixture()
        self.sess(con, "m1")
        self.sess(con, "m2")
        self.usage(con, "r1", "m1", turn="t1")
        self.usage(con, "r2", "m2", turn="t1")   # 同名 turn_id 跨会话各计一轮
        self.assertEqual(zusage._project_usage(con, "m1")["turns"], 2)

    def test_failed_requests_excluded(self):
        con = self.fixture()
        self.sess(con, "m1")
        self.usage(con, "r1", "m1", total=100)
        self.usage(con, "r2", "m1", turn="t2", total=500, status="error")
        p = zusage._project_usage(con, "m1")
        self.assertEqual((p["requests"], p["total"], p["turns"]), (1, 100, 1))

    def test_unknown_or_projectless_session_returns_none(self):
        con = self.fixture()
        self.sess(con, "m1", project=None, directory=None)
        self.assertIsNone(zusage._project_usage(con, "nope"))
        self.assertIsNone(zusage._project_usage(con, "m1"))

    def test_models_top8_desc_and_more_count(self):
        con = self.fixture()
        self.sess(con, "m1")
        self.sess(con, "m2")
        for i in range(10):   # 10 个模型：m1 5 个、m2 5 个，总量互不相同
            self.usage(con, f"r{i}", "m1" if i % 2 == 0 else "m2",
                       turn=f"t{i}", total=100 * (i + 1), model=f"model-{i}")
        self.usage(con, "rx", "m2", turn="tx", total=5000, model="model-0")  # 提升总量
        p = zusage._project_usage(con, "m1", with_models=True)
        self.assertEqual([m["model"] for m in p["models"][:3]], ["model-0", "model-9", "model-8"])
        self.assertEqual(len(p["models"]), 8)          # 截前 8
        self.assertEqual(p["models_more"], 2)          # 共 10 个模型
        self.assertEqual(p["models"][0]["requests"], 2)  # model-0: m1 一条 + m2 一条
        # 不取模型（轻量行）：字段空
        p2 = zusage._project_usage(con, "m1", with_models=False)
        self.assertEqual((p2["models"], p2["models_more"]), ([], 0))

    def test_session_snapshot_models_light_rows_without(self):
        con = self.fixture()
        self.sess(con, "m1")
        self.usage(con, "r1", "m1", total=100, model="GLM-5.3")
        self.usage(con, "r2", "m1", turn="t2", total=50, model="gpt-6.1-sol")
        full = zusage._session_snapshot(con, "m1", {"context_window": 200000})
        self.assertEqual([m["model"] for m in full["models"]], ["GLM-5.3", "gpt-6.1-sol"])
        self.assertEqual(full["models"][0]["total"], 100)
        light = zusage._light_snapshot(con, "m1", {"context_window": 200000})
        self.assertNotIn("models", light)


class ProjectSnapshotInjectTests(FixtureBase):
    def snapshot_with(self, con, force_sid):
        proxy = mock.Mock(wraps=con)
        proxy.close = mock.Mock()
        with mock.patch.object(zusage, "connect", return_value=proxy), \
             mock.patch.object(zusage, "load_config", return_value={"context_window": 200000}), \
             mock.patch.object(zusage, "_AGG_CACHE", {}), \
             mock.patch.object(zusage, "_day_start", return_value=zusage._day_start()), \
             mock.patch.object(zusage, "_scan_session_ids", return_value=self.scan_rows), \
             mock.patch.object(zusage, "_remote_setup", return_value=None):
            return zusage.snapshot(force_sid=force_sid)

    def test_snapshot_injects_project_into_local_pool_rows(self):
        con = self.fixture()
        self.sess(con, "m1")
        self.sess(con, "m2")
        self.sess(con, "w1", project="proj_repo_worktrees-x", directory="/repo/.worktrees/x")
        self.usage(con, "r1", "m1", turn="t1", total=100, completed=3000)
        self.usage(con, "r2", "m2", turn="t1", total=50)
        self.usage(con, "r3", "w1", turn="t1", total=999)
        self.scan_rows = [("m1", 3000), ("m2", 2000), ("w1", 900)]
        snap = self.snapshot_with(con, "m1")
        # latest 行与顶层 session 同对象，注入一次两边可见
        self.assertIs(snap["recent"][0], snap["session"])
        self.assertEqual(snap["session"]["project"]["total"], 150)
        by_sid = {r["sid"]: r for r in snap["recent"]}
        self.assertEqual(by_sid["m2"]["project"]["total"], 150)
        self.assertEqual(by_sid["w1"]["project"]["total"], 999)
        # 完整行的项目聚合带模型明细；会话快照同样带
        self.assertEqual(by_sid["m2"]["project"]["models"][0]["model"], "GLM-5.3")
        self.assertEqual(snap["session"]["models"][0]["model"], "GLM-5.3")

    def test_snapshot_not_local_force_sid_has_no_project(self):
        con = self.fixture()
        self.sess(con, "m1")
        self.usage(con, "r1", "m1", total=100)
        self.scan_rows = [("m1", 2000)]
        snap = self.snapshot_with(con, "ghost")
        ghost = next(r for r in snap["recent"] if r["sid"] == "ghost")
        self.assertEqual(snap["not_local"], ["ghost"])
        self.assertNotIn("project", ghost)

    def test_snapshot_drift_schema_degrades_without_project(self):
        con = self.fixture(schema=DRIFT_SCHEMA)
        con.execute("insert into session (id, title) values ('s', 't')")
        con.execute(
            "insert into model_usage (id, session_id, turn_id, status, started_at, completed_at)"
            " values ('r1', 's', 't1', 'completed', 1000, 2000)")
        self.scan_rows = [("s", 2000)]
        snap = self.snapshot_with(con, "s")
        self.assertNotIn("project", snap["session"])
        for row in snap["recent"]:
            self.assertNotIn("project", row)


if __name__ == "__main__":
    unittest.main()
