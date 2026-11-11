# -*- coding: utf-8 -*-
"""工作流子代理（sess_dwf-*，query_source='workflow_child'）在统计链中的归类与可见性。

规格：specs/workflow-support.md。运行：python3 -B -m unittest tests/test_workflow_sessions.py
"""
import importlib.util
import sqlite3
import unittest
from unittest import mock
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


zusage = load("workflow_sessions_zusage", REPO / "zusage.py")

CFG = {"context_window": 200000}
RUN = "dwfrun-0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b"
WF_SID = "sess_dwf-" + RUN + "-judge-1@1"
SUB_SID = "sess_subagent_agentX1"
MAIN = "s"

# 与 test_statusbar_rate 同款最小 schema；dwf_actor 两列足够 _sub_agent_tasks 反查
SCHEMA = """
create table session (id text primary key, title text, parent_id text, time_created integer,
  summary_additions integer, summary_deletions integer, summary_files integer,
  project_id text, directory text);
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
create table part (session_id text, data text, time_created integer, time_updated integer);
create table dwf_actor (id integer primary key autoincrement, run_id text, site_id text,
  name text, resolved_model text, session_id text, time_created integer, time_updated integer);
"""


class WorkflowSessionTests(unittest.TestCase):
    def setUp(self):
        # 夹具互相独立：covers 60s TTL 与任务名缓存都按库键缓存，必须每用例重置
        zusage._COVERS_CACHE.update(ts=0.0, set=frozenset())
        zusage._TASK_CACHE.clear()

    def con(self, with_actor_table=True):
        con = sqlite3.connect(":memory:")
        self.addCleanup(con.close)
        con.row_factory = sqlite3.Row
        script = SCHEMA if with_actor_table else SCHEMA.replace(
            "create table dwf_actor (id integer primary key autoincrement, run_id text, site_id text,\n"
            "  name text, resolved_model text, session_id text, time_created integer, time_updated integer);", "")
        con.executescript(script)
        return con

    def sess(self, con, sid, parent=None, title=""):
        con.execute("insert into session (id, title, parent_id, time_created) values (?,?,?,1000)",
                    (sid, title, parent))

    def usage(self, con, rid, sid, qs="main_turn", total=100, output=441, started=1_000_000,
              first=1_001_000, completed=1_010_000, model="GLM-5.3", turn="turn1"):
        con.execute(
            "insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (rid, sid, turn, qs, "", "account:test", model, "completed", started, first,
             completed, completed - started, completed - first, 10, output, 0, 0, 0,
             total, 0, 0, 0))

    def test_is_sub_sid_and_kind(self):
        self.assertTrue(zusage._is_sub_sid(SUB_SID))
        self.assertTrue(zusage._is_sub_sid(WF_SID))
        self.assertFalse(zusage._is_sub_sid(MAIN))
        self.assertEqual(zusage._sub_kind_of(SUB_SID), "agent")
        self.assertEqual(zusage._sub_kind_of(WF_SID), "workflow")
        self.assertEqual(zusage._sub_kind_of(MAIN), "")

    def test_sub_list_includes_workflow_actor(self):
        """父会话的 sub 段纳入工作流 actor：行、is_sub/sub_kind、速率分量、任务名。"""
        con = self.con()
        self.sess(con, MAIN, title="父会话")
        self.sess(con, WF_SID, parent=MAIN, title="wf actor")
        self.usage(con, "r1", MAIN, qs="main_turn")
        self.usage(con, "w1", WF_SID, qs="workflow_child", output=200, total=300,
                   started=2_000_000, first=2_001_000, completed=2_010_000, turn="wturn1")
        con.execute("insert into dwf_actor (run_id, site_id, name, session_id) values (?,?,?,?)",
                    (RUN, "judge-1@1", "研究员·通识", WF_SID))
        snap = zusage._session_snapshot(con, MAIN, CFG)
        self.assertTrue(snap["is_sub"] is False or snap["is_sub"] is False)   # 主会话自身恒 False
        self.assertEqual(snap["sub_kind"], "")
        sub = snap["sub"]
        self.assertEqual(sub["requests"], 1)
        self.assertEqual(len(sub["list"]), 1)
        item = sub["list"][0]
        self.assertEqual(item["sid"], WF_SID)
        self.assertEqual(item["task"], "研究员·通识")   # dwf_actor.name 反查
        self.assertEqual(item["total"], 300)
        self.assertEqual(item["tps_out"], 200)          # 分量原样下发（run 级加权的数据源）
        self.assertEqual(item["tps_gen"], 9000)         # completed-first = 2_010_000-2_001_000
        self.assertGreater(item["tps_avg"], 0)

    def test_workflow_rows_keep_main_turn_purity(self):
        """主格会话均（avg_tps）保持 main_turn 纯净：workflow_child 行不进分子分母。"""
        con = self.con()
        self.sess(con, MAIN)
        self.usage(con, "r1", MAIN, qs="main_turn")   # 441 tok / 9.0s 首字窗口 → 102.2 t/s（同款口径）
        base = zusage._session_snapshot(con, MAIN, CFG)["avg_tps"]
        self.sess(con, WF_SID, parent=MAIN)
        self.usage(con, "w1", WF_SID, qs="workflow_child", output=5000, total=6000,
                   started=3_000_000, first=3_000_100, completed=3_001_000, turn="wturn")
        snap = zusage._session_snapshot(con, MAIN, CFG)
        self.assertEqual(snap["avg_tps"], base)
        self.assertNotEqual(snap["sub"]["rate_avg"], 0)   # 子代理口径已纳入（含工作流段）

    def test_task_name_without_dwf_actor_table(self):
        """旧宿主/WorkBuddy 无 dwf_* 表：fail-closed 跳过，不抛错、无任务名。"""
        con = self.con(with_actor_table=False)
        self.sess(con, MAIN)
        self.sess(con, WF_SID, parent=MAIN)
        self.usage(con, "w1", WF_SID, qs="workflow_child", turn="wturn")
        tasks = zusage._sub_agent_tasks(con, MAIN)
        self.assertNotIn(WF_SID, tasks)

    def test_snapshot_pool_excludes_workflow_sessions(self):
        """快照池分桶：sess_dwf 不进 normal 主会话桶（防挤占 top-6 / CLI current 误选）；
        与 sess_subagent 一致进子代理桶（行 is_sub=true 可辨）。"""
        con = self.con()
        self.sess(con, MAIN)
        self.usage(con, "r1", MAIN, qs="main_turn", completed=3_000_000)
        self.sess(con, WF_SID, parent=MAIN)
        self.usage(con, "w1", WF_SID, qs="workflow_child", completed=1_000_000)
        rows = [(MAIN, 3_000_000), (WF_SID, 1_000_000)]
        proxy = mock.Mock(wraps=con)
        proxy.close = mock.Mock()
        with mock.patch.object(zusage, "connect", return_value=proxy), \
             mock.patch.object(zusage, "load_config", return_value=dict(CFG)), \
             mock.patch.object(zusage, "_AGG_CACHE", {}), \
             mock.patch.object(zusage, "_scan_session_ids", return_value=rows), \
             mock.patch.object(zusage, "_remote_setup", return_value=None), \
             mock.patch.object(zusage, "_PROJ_CACHE", {}):
            snap = zusage.snapshot(force_sid="")
        recent = snap.get("recent", [])
        normal_sids = [row["sid"] for row in recent if not row.get("is_sub")]
        self.assertNotIn(WF_SID, normal_sids, "工作流 actor 会话不得进主会话桶")
        self.assertIn(MAIN, normal_sids)
        wf_rows = [row for row in recent if row["sid"] == WF_SID]
        for row in wf_rows:
            self.assertTrue(row["is_sub"])
            self.assertEqual(row["sub_kind"], "workflow")

    def test_snapshot_is_sub_kind_fields(self):
        """快照行 is_sub/sub_kind 对 sess_dwf 行为 True/workflow（light 与 full 同源）。"""
        con = self.con()
        self.sess(con, WF_SID, parent=MAIN)
        self.usage(con, "w1", WF_SID, qs="workflow_child")
        full = zusage._session_snapshot(con, WF_SID, CFG)
        light = zusage._light_snapshot(con, WF_SID, CFG)
        for row in (full, light):
            self.assertTrue(row["is_sub"])
            self.assertEqual(row["sub_kind"], "workflow")


if __name__ == "__main__":
    unittest.main()
