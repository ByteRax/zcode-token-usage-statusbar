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
        zusage._TASK_AT.clear()

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
        self.assertFalse(snap["is_sub"])
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

    def test_task_name_cache_invalidated_by_actor_insert(self):
        """dwf_actor 插行不动 part：失效键的 astamp 维度负责杀缓存——先暖缓存再插
        actor，名字必须出现（失效键缺该维度时命中旧缓存，用例红）。"""
        con = self.con()
        self.sess(con, MAIN)
        self.sess(con, WF_SID, parent=MAIN)
        self.usage(con, "w1", WF_SID, qs="workflow_child", turn="wturn")
        self.assertEqual(zusage._sub_agent_tasks(con, MAIN).get(WF_SID), None)   # 暖缓存（actor 未登记）
        con.execute(
            "insert into dwf_actor (run_id, site_id, name, session_id, time_created, time_updated)"
            " values (?,?,?,?,?,?)", (RUN, "judge-1@1", "研究员·通识", WF_SID, 5_000, 5_000))
        self.assertEqual(zusage._sub_agent_tasks(con, MAIN).get(WF_SID), "研究员·通识")

    def test_task_name_cache_invalidated_by_actor_rename(self):
        """纯改名只动 time_updated（time_created 不变）：失效键必须仍杀缓存——
        失效键退回 max(time_created) 时命中旧名，本用例红（第二轮复审 MAJOR-2）。"""
        con = self.con()
        self.sess(con, MAIN)
        self.sess(con, WF_SID, parent=MAIN)
        self.usage(con, "w1", WF_SID, qs="workflow_child", turn="wturn")
        con.execute(
            "insert into dwf_actor (run_id, site_id, name, session_id, time_created, time_updated)"
            " values (?,?,?,?,?,?)", (RUN, "judge-1@1", "旧名", WF_SID, 1_000, 1_000))
        self.assertEqual(zusage._sub_agent_tasks(con, MAIN).get(WF_SID), "旧名")   # 暖缓存
        con.execute("update dwf_actor set name='新名', time_updated=2_000 where session_id=?", (WF_SID,))
        self.assertEqual(zusage._sub_agent_tasks(con, MAIN).get(WF_SID), "新名")

    def test_normal_pool_keeps_subagents_out(self):
        """normal 桶主会话独占：普通子代理（sess_subagent_*）不得挤占主会话 top-6——
        normal 误用 ranked[:6]（只滤 sess_dwf）时本用例红（第二轮复审 MAJOR-1）。"""
        con = self.con()
        sids = []
        for i in range(6):
            sid = f"m{i}"
            self.sess(con, sid, title=f"主会话{i}")
            self.usage(con, f"r{i}", sid, qs="main_turn", completed=1_000_000 + i)
            sids.append(sid)
        sub = "sess_subagent_agent_new1"
        self.sess(con, sub, parent="m5", title="新子代理")
        self.usage(con, "ws", sub, qs="subagent", completed=9_000_000)   # 全库最新：变异态会把 m0 顶出 normal 桶
        rows = [(f"m{i}", 1_000_000 + i) for i in range(6)] + [(sub, 9_000_000)]
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
        self.assertNotIn(sub, normal_sids, "普通子代理不得进 normal 桶")
        for m in sids:
            self.assertIn(m, normal_sids, f"主会话 {m} 不得被子代理挤出 normal 桶")

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

    def test_latest_and_current_exclude_workflow_actor(self):
        """latest_sid 与 CLI current 排除工作流 actor（普通子代理保持既有候选语义）。"""
        con = self.con()
        self.sess(con, MAIN, title="父会话")
        self.sess(con, WF_SID, parent=MAIN)
        self.usage(con, "r1", MAIN, qs="main_turn", completed=1_000_000)
        self.usage(con, "w1", WF_SID, qs="workflow_child", completed=9_000_000)   # actor 全库最新
        self.assertEqual(zusage.render_current(con).find(WF_SID[-6:]), -1,
                         "current 不得落到工作流 actor 会话")
        self.assertIn("父会话", zusage.render_current(con))
        rows = [(MAIN, 1_000_000), (WF_SID, 9_000_000)]
        proxy = mock.Mock(wraps=con)
        proxy.close = mock.Mock()
        with mock.patch.object(zusage, "connect", return_value=proxy), \
             mock.patch.object(zusage, "load_config", return_value=dict(CFG)), \
             mock.patch.object(zusage, "_AGG_CACHE", {}), \
             mock.patch.object(zusage, "_scan_session_ids", return_value=rows), \
             mock.patch.object(zusage, "_remote_setup", return_value=None), \
             mock.patch.object(zusage, "_PROJ_CACHE", {}):
            snap = zusage.snapshot(force_sid="")
        self.assertEqual(snap["session"]["sid"], MAIN, "顶层 base 不被 actor 顶掉")

    def test_session_detail_includes_workflow_actor(self):
        """CLI session:<前缀> 明细的子代理段纳入工作流 actor（query_source 门）。"""
        con = self.con()
        self.sess(con, MAIN, title="父会话")
        self.sess(con, WF_SID, parent=MAIN, title="wf actor")
        self.usage(con, "w1", WF_SID, qs="workflow_child", total=300, turn="wturn")
        con.execute("insert into dwf_actor (run_id, site_id, name, session_id) values (?,?,?,?)",
                    (RUN, "judge-1@1", "研究员·通识", WF_SID))
        out = zusage.render_session_detail(con, MAIN)
        self.assertIn("研究员·通识", out, "子代理明细段应含 dwf_actor.name")
        self.assertIn(WF_SID[-6:], out)

    def test_sub_cost_and_models_include_workflow_rows(self):
        """子代理聚合费用/模型门纳入 workflow_child 行（_scope_models_cost 的门）。"""
        con = self.con()
        self.sess(con, MAIN)
        self.sess(con, WF_SID, parent=MAIN)
        self.usage(con, "w1", WF_SID, qs="workflow_child", total=300, model="GLM-5.3", turn="wturn")
        fake_pricing = mock.Mock()
        fake_pricing.merge_model_costs = lambda groups: (1.25, {"GLM-5.3": 1.25})
        with mock.patch.object(zusage, "_pricing", fake_pricing):
            snap = zusage._session_snapshot(con, MAIN, CFG)
        self.assertIn("models", snap["sub"], "无门（改回单值）时本断言红")
        self.assertEqual(snap["sub"]["models"][0]["model"], "GLM-5.3")
        self.assertEqual(snap["sub"]["models"][0]["requests"], 1)
        self.assertAlmostEqual(snap["sub"]["cost_usd"], 1.25)


if __name__ == "__main__":
    unittest.main()
