# -*- coding: utf-8 -*-
"""快照预估费用链（v202）：四维度 cost_usd 聚合口径与模块缺失降级。

口径：completed 行按 (model_id, provider_id) 分组计价后求和；同模型多 provider
各按其厂牌价分别计；模块缺失（旧运行目录无 token_pricing.py）时字段省略/None，
不显假 0。缓存全部内存库隔离，不触真库与真实 pricing-cache.json。

运行：python3 -B -m unittest discover -s tests -p 'test_statusbar_cost.py'
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


zusage = load("statusbar_cost_zusage", REPO / "zusage.py")

# 只建 _session_snapshot/_project_usage 实际读取的表与列（同 test_statusbar_rate 漂移夹具）
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
create table part (id text primary key, session_id text, data text, time_created integer, time_updated integer);
"""

START = 1_000_000


def ins(con, rid, sid, model, provider, inp, out, cr=0, cw=0,
        turn="t1", status="completed", completed=START + 1000, qsource=None):
    total = max(0, inp + out)
    con.execute(
        "insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (rid, sid, turn, qsource, "", provider, model, status, START,
         START, completed, 1000, 10, inp, out, 0, cr, cw, total, 0, 0, 0))


class CostBase(unittest.TestCase):
    def fixture(self):
        con = sqlite3.connect(":memory:")
        self.addCleanup(con.close)
        con.row_factory = sqlite3.Row
        con.executescript(SCHEMA)
        con.execute("insert into session (id, title, project_id, directory, time_created)"
                    " values ('s', 't', 'proj_repo', '/repo', 100)")
        return con

    def tearDown(self):
        zusage._AGG_CACHE.clear()
        zusage._PROJ_CACHE.clear()


class SessionCostTests(CostBase):
    def test_session_and_model_costs(self):
        """会话总额 = 各 (模型, provider) 分组之和；models 带各分组费用。"""
        con = self.fixture()
        # GLM-5.3 双通道：zhipuai input 1.19516 / zai 1.4（各 1M input，无缓存输出）
        ins(con, "r1", "s", "GLM-5.3", "account:bigmodel-x", 1_000_000, 0)
        ins(con, "r2", "s", "GLM-5.3", "account:zai-x", 1_000_000, 0)
        models, total = zusage._session_models_cost(con, "s")
        by = {m["model"]: m for m in models}
        self.assertAlmostEqual(by["GLM-5.3"]["cost_usd"], 1.19516 + 1.4)
        self.assertEqual(by["GLM-5.3"]["requests"], 2)
        self.assertEqual(by["GLM-5.3"]["total"], 2_000_000)
        self.assertAlmostEqual(total, 1.19516 + 1.4)
        models.sort(key=lambda m: -m["total"])   # snapshot 内同款排序后断言字段仍在
        self.assertIn("cost_usd", models[0])

    def test_session_snapshot_carries_cost_and_turn_cost(self):
        con = self.fixture()
        ins(con, "r1", "s", "GLM-5.3", "account:bigmodel-x", 1_000_000, 0)
        snap = zusage._session_snapshot(con, "s", {"context_window": 200000})
        self.assertIn("cost_usd", snap)
        self.assertAlmostEqual(snap["cost_usd"], 1.19516)
        self.assertAlmostEqual(snap["last_turn"]["cost_usd"], 1.19516)
        for m in snap["models"]:
            self.assertIn("cost_usd", m)

    def test_turn_cost_scoped_to_turn(self):
        """本轮费用只取当前 turn_id 的行，历史轮不混入。"""
        con = self.fixture()
        ins(con, "r1", "s", "GLM-5.3", "account:bigmodel-x", 1_000_000, 0, turn="t1",
            completed=START + 1000)
        ins(con, "r2", "s", "GLM-5.3", "account:bigmodel-x", 2_000_000, 0, turn="t2",
            completed=START + 9000)
        lt = zusage._session_snapshot(con, "s", {"context_window": 200000})["last_turn"]
        self.assertAlmostEqual(lt["cost_usd"], 2 * 1.19516)   # 最近轮 t2

    def test_last_rates_attached(self):
        """last.rates（v202 当前模型牌价）：价目表命中条目四价+键；模块缺失时字段省略。"""
        con = self.fixture()
        ins(con, "r1", "s", "GLM-5.3", "account:bigmodel-x", 1_000_000, 0)
        snap = zusage._session_snapshot(con, "s", {"context_window": 200000})
        rates = snap["last"]["rates"]
        self.assertEqual(rates["key"], "glm-5.3")
        self.assertAlmostEqual(rates["input"], 1.19516)
        self.assertIn("cache_read", rates)
        with mock.patch.object(zusage, "_pricing", None):
            snap2 = zusage._session_snapshot(con, "s", {"context_window": 200000})
            self.assertNotIn("rates", snap2["last"])

    def test_sub_aggregate_carries_cost_and_models(self):
        """sub 汇总（v202）：子代理群预估费用与模型明细（query_source='subagent' 同口径）。"""
        con = self.fixture()
        con.execute("insert into session (id, title, parent_id, project_id, directory, time_created)"
                    " values ('s_sub1', 't', 's', 'proj_repo', '/repo', 101)")
        ins(con, "r1", "s_sub1", "GLM-5.3", "account:bigmodel-x", 1_000_000, 0, qsource="subagent")
        ins(con, "r2", "s_sub1", "GLM-5.3", "account:bigmodel-x", 500_000, 0, qsource="subagent")
        snap = zusage._session_snapshot(con, "s", {"context_window": 200000})
        sub = snap["sub"]
        self.assertAlmostEqual(sub["cost_usd"], round(1.5 * 1.19516, 8))
        by = {m["model"]: m for m in sub["models"]}
        self.assertEqual(by["GLM-5.3"]["requests"], 2)
        self.assertAlmostEqual(by["GLM-5.3"]["cost_usd"], sub["cost_usd"])
        # 主会话行不计入子代理群
        ins(con, "r3", "s", "GLM-5.3", "account:bigmodel-x", 1_000_000, 0)
        snap2 = zusage._session_snapshot(con, "s", {"context_window": 200000})
        self.assertAlmostEqual(snap2["sub"]["cost_usd"], round(1.5 * 1.19516, 8))

    def test_sub_item_carries_per_task_cost_and_models(self):
        """sub.list 单项（v217 统一浮层任务页）：每子会话模型明细/费用按该子会话分组，
        跨任务不串；价表缺失（_pricing=None）时字段省略不造零值。"""
        con = self.fixture()
        con.execute("insert into session (id, title, parent_id, project_id, directory, time_created)"
                    " values ('s_sub1', 't1', 's', 'proj_repo', '/repo', 101)")
        con.execute("insert into session (id, title, parent_id, project_id, directory, time_created)"
                    " values ('s_sub2', 't2', 's', 'proj_repo', '/repo', 102)")
        ins(con, "r1", "s_sub1", "GLM-5.3", "account:bigmodel-x", 1_000_000, 0, qsource="subagent")
        ins(con, "r2", "s_sub2", "claude-opus-5-5", "account:bigmodel-x", 2_000_000, 0, qsource="subagent")
        snap = zusage._session_snapshot(con, "s", {"context_window": 200000})
        items = {it["sid"]: it for it in snap["sub"]["list"]}
        self.assertAlmostEqual(items["s_sub1"]["cost_usd"], 1.19516)
        # s_sub2 只断言「逐任务分组正确」（任务内费用=该任务模型行费用），不锁死牌价
        self.assertAlmostEqual(items["s_sub2"]["cost_usd"],
                               items["s_sub2"]["models"][0]["cost_usd"])
        self.assertNotAlmostEqual(items["s_sub1"]["cost_usd"], items["s_sub2"]["cost_usd"])
        self.assertEqual([m["model"] for m in items["s_sub1"]["models"]], ["GLM-5.3"])
        self.assertEqual([m["model"] for m in items["s_sub2"]["models"]], ["claude-opus-5-5"])
        with mock.patch.object(zusage, "_pricing", None):
            snap3 = zusage._session_snapshot(con, "s", {"context_window": 200000})
            it3 = {it["sid"]: it for it in snap3["sub"]["list"]}
            self.assertNotIn("cost_usd", it3["s_sub1"])
            self.assertNotIn("models", it3["s_sub1"])

    def test_error_rows_excluded(self):
        con = self.fixture()
        ins(con, "r1", "s", "GLM-5.3", "account:bigmodel-x", 1_000_000, 0)
        ins(con, "r2", "s", "GLM-5.3", "account:bigmodel-x", 5_000_000, 0, status="error")
        _, total = zusage._session_models_cost(con, "s")
        self.assertAlmostEqual(total, 1.19516)

    def test_module_missing_degrades(self):
        """价表模块缺失（旧运行目录）：models 退回 v163 结构（无 cost_usd）、总额 None、
        快照无 cost_usd 字段——消费端按缺字段隐藏，不显假 0。"""
        con = self.fixture()
        ins(con, "r1", "s", "GLM-5.3", "account:bigmodel-x", 1_000_000, 0)
        with mock.patch.object(zusage, "_pricing", None):
            models, total = zusage._session_models_cost(con, "s")
            self.assertIsNone(total)
            self.assertNotIn("cost_usd", models[0])
            snap = zusage._session_snapshot(con, "s", {"context_window": 200000})
            self.assertNotIn("cost_usd", snap)
            self.assertNotIn("cost_usd", snap["last_turn"])


class ScopeCostTests(CostBase):
    def test_turn_and_period_scope(self):
        con = self.fixture()
        ins(con, "r1", "s", "GLM-5.3", "account:bigmodel-x", 1_000_000, 0, turn="t1")
        ins(con, "r2", "s", "GLM-5.3", "account:bigmodel-x", 1_000_000, 0, turn="t2",
            completed=START + 5000)
        turn_cost = zusage._scope_cost(con, "session_id=? and turn_id=?", ("s", "t2"))
        self.assertAlmostEqual(turn_cost, 1.19516)
        period = zusage._scope_cost(con, "completed_at between ? and ?",
                                    (START, START + 20000))
        self.assertAlmostEqual(period, 2 * 1.19516)

    def test_light_snapshot_carries_cost_only(self):
        """轻量行带 cost_usd 但不带 models（与 tools/models 瘦身同款契约）。"""
        con = self.fixture()
        ins(con, "r1", "s", "GLM-5.3", "account:bigmodel-x", 1_000_000, 0)
        lr = zusage._light_snapshot(con, "s", {"context_window": 200000})
        self.assertIn("cost_usd", lr)
        self.assertAlmostEqual(lr["cost_usd"], 1.19516)
        self.assertNotIn("models", lr)


class ProjectCostTests(CostBase):
    def test_project_cost_sums_sessions_and_per_model(self):
        con = self.fixture()
        con.execute("insert into session (id, title, parent_id, project_id, directory, time_created)"
                    " values ('s2', 't', 's', 'proj_repo', '/repo', 101)")
        ins(con, "r1", "s", "GLM-5.3", "account:bigmodel-x", 1_000_000, 0)
        ins(con, "r2", "s2", "GLM-5.3", "account:zai-x", 1_000_000, 0)
        ins(con, "r3", "s2", "claude-opus-5-5", "account:anthropic-x", 0, 1_000_000)
        pj = zusage._project_usage(con, "s", with_models=True)
        self.assertAlmostEqual(pj["cost_usd"], 1.19516 + 1.4 + 20.0)
        by = {m["model"]: m for m in pj["models"]}
        self.assertAlmostEqual(by["GLM-5.3"]["cost_usd"], 1.19516 + 1.4)
        self.assertAlmostEqual(by["claude-opus-5-5"]["cost_usd"], 20.0)

    def test_project_cost_present_without_models(self):
        """轻量行项目聚合（with_models=False）也带费用——models 仍为空契约不变。"""
        con = self.fixture()
        ins(con, "r1", "s", "GLM-5.3", "account:bigmodel-x", 1_000_000, 0)
        pj = zusage._project_usage(con, "s", with_models=False)
        self.assertAlmostEqual(pj["cost_usd"], 1.19516)
        self.assertEqual(pj["models"], [])

    def test_project_cost_none_when_module_missing(self):
        con = self.fixture()
        ins(con, "r1", "s", "GLM-5.3", "account:bigmodel-x", 1_000_000, 0)
        with mock.patch.object(zusage, "_pricing", None):
            pj = zusage._project_usage(con, "s", with_models=True)
            self.assertIsNone(pj["cost_usd"])   # JSON null，消费端按缺字段隐藏
            self.assertNotIn("cost_usd", pj["models"][0])


if __name__ == "__main__":
    unittest.main()
