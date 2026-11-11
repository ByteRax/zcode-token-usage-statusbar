# -*- coding: utf-8 -*-
"""全部项目统计（v331，specs/all-projects-usage.md）：zusage._all_projects_usage
聚合口径与 snapshot 门控。

口径：归属单元=会话（派生会话沿 parent 链取根会话项目身份，环守卫）；项目键=
(project_id, 归一化目录) 与 _project_usage 的 issue #248 语义一致；project_id 为空
或会话已删的请求单列未归属桶；totals==Σ projects 对账恒成立；速率/耗时为全局加权
而非项目均值再平均；桌面快照链（serve/桌面 json）带顶层 all_projects，
CLI 报表/MCP/远端子查询 stdout 不带（桌面 json 与 CLI 手工 json 是同一命令，按
ZUSAGE_REMOTE_CHILD 区分）。

运行：python3 -B -m unittest discover -s tests -p 'test_*.py'
"""
import importlib.util
import io
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


zusage = load("all_projects_zusage", REPO / "zusage.py")

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

# 漂移库：session 表无 project_id/directory 列（旧宿主库形态），可选增强字段整体降级
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
    def setUp(self):
        zusage._PROJ_CACHE.clear()
        zusage._PROJ_WM.clear()
        zusage._AGG_CACHE.clear()
        # 同 test_statusbar_rate 纪律：60s TTL 会跨测试串库，covers 必须逐用例重置
        zusage._COVERS_CACHE.update(ts=0.0, set=frozenset())

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
              status="completed", model="GLM-5.3", dur=3000, ttft=300,
              inp=60, out=30, qs="main_turn"):
        con.execute(
            "insert into model_usage (id, session_id, turn_id, query_source, provider_id,"
            " model_id, status, started_at, first_token_at, completed_at, duration_ms,"
            " time_to_first_token_ms, input_tokens, output_tokens, reasoning_tokens,"
            " cache_read_input_tokens, cache_creation_input_tokens, computed_total_tokens,"
            " tool_call_count, retry_count)"
            " values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (rid, sid, turn, qs, "account:test", model, status, started,
             started + 100, completed, dur, ttft, inp, out, 5, 40, 2, total, 1, 0))


class AllProjectsAggTests(FixtureBase):
    def test_two_projects_dedup_and_global_ledger(self):
        con = self.fixture()
        self.sess(con, "m1")                                    # 项目 A（proj_repo /repo）
        self.sess(con, "sub1", parent="m1")                     # A 的子代理
        self.sess(con, "m2", project="proj_b", directory="/b")  # 项目 B
        self.usage(con, "r1", "m1", turn="t1", total=100)
        self.usage(con, "r2", "sub1", turn="t1", total=50)
        self.usage(con, "r3", "m2", turn="t1", total=500, model="claude-sonnet-5")
        ap = zusage._all_projects_usage(con)
        # 全局 KPI = 两项目真实去重汇总（子代理计入其项目，不重复计全局）
        self.assertEqual(ap["requests"], 3)
        self.assertEqual(ap["sessions"], 3)
        self.assertEqual(ap["turns"], 3)
        self.assertEqual(ap["total"], 650)
        self.assertEqual(ap["input"], 180)
        self.assertEqual(ap["cache_read"], 120)
        # 项目明细：降序、归属正确、账本恒等（totals==Σ projects）
        by_name = {p["name"]: p for p in ap["projects"]}
        self.assertEqual(by_name["b"]["total"], 500)
        self.assertEqual(by_name["repo"]["total"], 150)   # 主会话+子代理
        self.assertEqual(sum(p["total"] for p in ap["projects"]), ap["total"])
        self.assertEqual(sum(p["requests"] for p in ap["projects"]), ap["requests"])
        # 模型明细合并两项目同模型：claude 1 次 / GLM 2 次
        models = {m["model"]: m for m in ap["models"]}
        self.assertEqual(models["GLM-5.3"]["requests"], 2)
        self.assertEqual(models["GLM-5.3"]["total"], 150)
        self.assertEqual(models["claude-sonnet-5"]["requests"], 1)
        self.assertEqual([m["model"] for m in ap["models"]], ["claude-sonnet-5", "GLM-5.3"])   # total 降序
        self.assertFalse(any(p.get("unattributed") for p in ap["projects"]))

    def test_parent_chain_root_attribution(self):
        con = self.fixture()
        self.sess(con, "m1")
        self.sess(con, "s1", parent="m1")
        self.sess(con, "s2", parent="s1")        # 子代理的子代理：沿链归到 m1
        self.sess(con, "orphan", project="proj_x", directory="/x", parent="missing")   # 父缺失：按自身身份
        self.sess(con, "mo", project="proj_x", directory="/x")
        self.usage(con, "r1", "s2", total=70)
        self.usage(con, "r2", "orphan", total=30)
        self.usage(con, "r3", "mo", total=20)
        ap = zusage._all_projects_usage(con)
        by_name = {p["name"]: p for p in ap["projects"]}
        self.assertEqual(by_name["repo"]["total"], 70)
        self.assertEqual(by_name["x"]["total"], 50)   # orphan 与主会话同项目
        self.assertEqual(len(ap["projects"]), 2)

    def test_cjk_slug_collision_dirs_separate(self):
        # issue #248 语义在全局聚合同样成立：同 project_id 不同归一化目录 = 不同项目
        con = self.fixture()
        coll = "proj_d-projects-shared"
        self.sess(con, "m1", project=coll, directory="D:\\Projects\\Shared\\项目甲")
        self.sess(con, "m2", project=coll, directory="d:/projects/shared/项目乙/")
        self.usage(con, "r1", "m1", total=100)
        self.usage(con, "r2", "m2", total=500)
        ap = zusage._all_projects_usage(con)
        names = {p["name"]: p["total"] for p in ap["projects"]}
        self.assertEqual(names, {"项目甲": 100, "项目乙": 500})

    def test_unattributed_bucket_keeps_ledger(self):
        # project_id 为空 + 会话已删（model_usage.session_id 不在会话表）→ 未归属桶；
        # 绝不并入任何具名项目，totals==Σ projects 恒成立
        con = self.fixture()
        self.sess(con, "m1")
        self.sess(con, "mu", project="", directory="")
        self.usage(con, "r1", "m1", total=100)
        self.usage(con, "r2", "mu", total=20)
        self.usage(con, "r3", "ghost-sess", total=15)
        ap = zusage._all_projects_usage(con)
        unattr = [p for p in ap["projects"] if p.get("unattributed")]
        self.assertEqual(len(unattr), 1)
        self.assertEqual(unattr[0]["total"], 35)   # 20 + 15
        self.assertEqual(unattr[0]["name"], "")
        named = [p for p in ap["projects"] if not p.get("unattributed")]
        self.assertEqual([p["total"] for p in named], [100])
        self.assertEqual(sum(p["total"] for p in ap["projects"]), ap["total"])

    def test_projectless_with_directory_merges_single_bucket(self):
        # project_id 为空的会话即使带目录也并入单一未归属桶（目录不足以安全归属），
        # 与会话已删的 ghost 请求同桶——渲染端恒至多一行「未归属项目」
        con = self.fixture()
        self.sess(con, "u1", project="", directory="/some/dir")
        self.sess(con, "u2", project="", directory="/other/dir")
        self.usage(con, "r1", "u1", total=10)
        self.usage(con, "r2", "u2", total=20)
        self.usage(con, "r3", "ghost", total=30)
        ap = zusage._all_projects_usage(con)
        unattr = [p for p in ap["projects"] if p.get("unattributed")]
        self.assertEqual(len(unattr), 1)
        self.assertEqual(unattr[0]["total"], 60)
        self.assertEqual(unattr[0]["name"], "")
        self.assertEqual(len(ap["projects"]), 1)

    def test_weighted_averages_not_mean_of_project_means(self):
        con = self.fixture()
        self.sess(con, "a1", project="proj_a", directory="/a")
        self.sess(con, "b1", project="proj_b", directory="/b")
        # A：1 行 dur=1000ms、输出 100 tok/gen1000ms；B：2 行 dur=9000ms、各 300 tok/gen1000ms
        self.usage(con, "r1", "a1", dur=1000, ttft=100, out=100)
        self.usage(con, "r2", "b1", dur=9000, ttft=100, out=300)
        self.usage(con, "r3", "b1", turn="t2", dur=9000, ttft=100, out=300)
        ap = zusage._all_projects_usage(con)
        # 平均耗时：Σdur/Σ样本 = 19000/3，非两项目均值 (1000+9000)/2
        self.assertEqual(ap["avg_duration_ms"], round(19000 / 3))
        # 平均输出速度：Σ有效输出 ÷ Σ生成窗口 = 700/3s，非 (100+300)/2
        self.assertAlmostEqual(ap["avg_tps"], round(700 / 3, 1), places=1)
        self.assertEqual(ap["duration_ms"], 19000)

    def test_failed_and_non_main_turn_rows_excluded_from_rate(self):
        con = self.fixture()
        self.sess(con, "m1")
        self.usage(con, "r1", "m1", total=100)                                 # main_turn：速率样本
        self.usage(con, "r2", "m1", turn="t2", total=500, status="error")      # 失败行不计数
        self.usage(con, "r3", "m1", turn="t3", total=50, qs="compact")         # 辅助源不计速率但计入总量
        ap = zusage._all_projects_usage(con)
        self.assertEqual(ap["requests"], 2)      # completed 恒计（同今日/项目口径）；error 排除
        self.assertEqual(ap["total"], 150)
        # 速率只吃 main_turn completed：仅 r1。行带 reasoning（usage 夹具固定 5）→
        # 非 covers provider 默认窗口 completed−started=1000ms（思考在首字后随流，v303 口径）
        self.assertAlmostEqual(ap["avg_tps"], round(30 / 1.0, 1), places=1)

    def test_empty_db_zero_totals_and_empty_lists(self):
        con = self.fixture()
        ap = zusage._all_projects_usage(con)
        self.assertEqual(ap["requests"], 0)
        self.assertEqual(ap["total"], 0)
        self.assertEqual(ap["projects"], [])
        self.assertEqual(ap["models"], [])
        self.assertEqual((ap["started"], ap["last_at"]), (0, 0))
        self.assertEqual(ap["avg_tps"], 0)

    def test_models_case_insensitive_merge(self):
        con = self.fixture()
        self.sess(con, "m1")
        self.sess(con, "m2", project="proj_b", directory="/b")
        self.usage(con, "r1", "m1", total=100, model="GLM-5.3")
        self.usage(con, "r2", "m2", total=200, model="glm-5.3")
        ap = zusage._all_projects_usage(con)
        self.assertEqual(len(ap["models"]), 1)
        self.assertEqual(ap["models"][0]["model"], "GLM-5.3")   # 规范展示名保留大写
        self.assertEqual(ap["models"][0]["total"], 300)

    def test_same_total_projects_stable_name_order(self):
        con = self.fixture()
        self.sess(con, "m1", project="proj_b", directory="/b")
        self.sess(con, "m2", project="proj_a", directory="/a")
        self.usage(con, "r1", "m1", total=100)
        self.usage(con, "r2", "m2", total=100)
        ap = zusage._all_projects_usage(con)
        self.assertEqual([p["name"] for p in ap["projects"]], ["a", "b"])   # 同值二级键名称升序


class _FakePricing:
    """确定性计价替身：cost=(inp+out+cr+cw)*1e-6，per-model 累加——只测聚合拆分/对账
    管道，不依赖真实牌价；lookup_full 供 _model_rates 取 rates。"""

    def merge_model_costs(self, groups):
        total = 0.0
        per = {}
        for model, prov, inp, out, cr, cw in groups:
            c = (inp + out + cr + cw) * 1e-6
            total += c
            per[model] = round(per.get(model, 0.0) + c, 8)
        return round(total, 8), per

    def lookup_full(self, model_id, provider_id):
        r = {"input": 1.0, "output": 2.0, "cache_read": 0.1, "cache_write": 0.2}
        return r, (model_id or "") + "/" + (provider_id or ""), True


class AllProjectsCostTests(FixtureBase):
    """计价链（评审补口）：per-key groups/mnames 与全局 ggroups/gnames 的拆分、
    projects cost 与全局 cost/models[].cost_usd 的对账、价表缺失降级。"""

    def test_cost_reconciles_per_project_and_global(self):
        con = self.fixture()
        self.sess(con, "m1")                                    # A：model-a
        self.sess(con, "m2", project="proj_b", directory="/b")  # B：model-b + model-a
        self.usage(con, "r1", "m1", total=100, model="model-a")
        self.usage(con, "r2", "m2", total=50, model="model-b")
        self.usage(con, "r3", "m2", turn="t2", total=70, model="model-a")
        with mock.patch.object(zusage, "_pricing", _FakePricing()):
            ap = zusage._all_projects_usage(con)
        by_name = {p["name"]: p for p in ap["projects"]}
        # usage 夹具固定 inp60/out30/cr40/cw2 → 单行 132e-6；跨项目不串桶
        self.assertAlmostEqual(by_name["repo"]["cost_usd"], 132e-6, places=9)
        self.assertAlmostEqual(by_name["b"]["cost_usd"], 264e-6, places=9)
        self.assertAlmostEqual(ap["cost_usd"], 396e-6, places=9)
        self.assertAlmostEqual(sum(p["cost_usd"] for p in ap["projects"]),
                               ap["cost_usd"], places=9)
        models = {m["model"]: m for m in ap["models"]}
        self.assertAlmostEqual(models["model-a"]["cost_usd"], 264e-6, places=9)   # 跨项目合并
        self.assertAlmostEqual(models["model-b"]["cost_usd"], 132e-6, places=9)
        self.assertTrue(all(m.get("rates", {}).get("input") == 1.0 for m in ap["models"]))

    def test_pricing_missing_degrades_costs_to_none(self):
        con = self.fixture()
        self.sess(con, "m1")
        self.usage(con, "r1", "m1", total=100)
        with mock.patch.object(zusage, "_pricing", None):
            ap = zusage._all_projects_usage(con)
        self.assertIsNone(ap["cost_usd"])
        self.assertIsNone(ap["projects"][0]["cost_usd"])
        self.assertTrue(all("cost_usd" not in m for m in ap["models"]), "明细仍产出，仅无价")


class AllProjectsCacheTests(FixtureBase):
    def test_memory_db_no_cache_file_db_cached_with_ttl(self):
        con = self.fixture()
        self.sess(con, "m1")
        self.usage(con, "r1", "m1", total=100)
        zusage._all_projects_usage(con)   # 内存库：不缓存
        self.assertFalse(any(k[1] == zusage._ALLPROJ_CACHE_KEY for k in zusage._PROJ_CACHE))
        with tempfile.TemporaryDirectory() as td:
            fcon = sqlite3.connect(str(Path(td) / "db.sqlite"))
            self.addCleanup(fcon.close)
            fcon.row_factory = sqlite3.Row
            fcon.executescript(SCHEMA)
            self.sess(fcon, "m1")
            self.usage(fcon, "r1", "m1", total=100)
            full = (zusage._db_cache_key(fcon), zusage._ALLPROJ_CACHE_KEY)
            self.assertEqual(zusage._all_projects_usage(fcon)["total"], 100)
            self.assertIn(full, zusage._PROJ_CACHE)
            self.usage(fcon, "r2", "m1", turn="t2", total=200)
            self.assertEqual(zusage._all_projects_usage(fcon)["total"], 100, "TTL 内命中旧值")
            ts, val = zusage._PROJ_CACHE[full]
            zusage._PROJ_CACHE[full] = (ts - zusage._AGG_TTL_MS - 1, val)
            self.assertEqual(zusage._all_projects_usage(fcon)["total"], 300, "TTL 过期重算")
            # 水位语义（specs §5）：水位=model_usage max(rowid)。新请求落库使水位变化 →
            # TTL 过期后 _wm_alive 判失败立即重算（不等 20s 上限）
            self.usage(fcon, "r9", "m1", turn="t9", total=400)
            ts, val = zusage._PROJ_CACHE[full]
            zusage._PROJ_CACHE[full] = (ts - zusage._AGG_TTL_MS - 1, val)
            self.assertEqual(zusage._all_projects_usage(fcon)["total"], 700, "水位变化即重算")
            # 仅 session 表变更（无新 model_usage 行）：水位未变 → TTL 过期仍续用（20s 兜底）
            self.sess(fcon, "m2")
            ts, val = zusage._PROJ_CACHE[full]
            zusage._PROJ_CACHE[full] = (ts - zusage._AGG_TTL_MS - 1, val)
            self.assertEqual(zusage._all_projects_usage(fcon)["total"], 700, "水位未变续用")


class AllProjectsCapTests(FixtureBase):
    def test_projects_cap_truncates_list_keeps_totals(self):
        con = self.fixture()
        for i in range(5):
            sid = f"m{i}"
            self.sess(con, sid, project=f"proj_{i}", directory=f"/p{i}")
            self.usage(con, f"r{i}", sid, total=100 * (i + 1))
        with mock.patch.object(zusage, "_ALLPROJ_MAX_PROJECTS", 3):
            ap = zusage._all_projects_usage(con)
        self.assertEqual(len(ap["projects"]), 3)
        self.assertTrue(ap["projects_truncated"])
        self.assertEqual(ap["projects_total"], 5)    # 截断前真实项目数（明细表提示用）
        self.assertEqual(ap["requests"], 5)          # totals 恒为全量真值
        self.assertEqual(ap["total"], 1500)
        self.assertEqual(ap["projects"][0]["total"], 500)   # 降序保留头部

    def test_no_cap_flag_below_limit(self):
        con = self.fixture()
        self.sess(con, "m1")
        self.usage(con, "r1", "m1", total=100)
        ap = zusage._all_projects_usage(con)
        self.assertNotIn("projects_truncated", ap)


class AllProjectsSnapshotTests(FixtureBase):
    def snapshot_with(self, con, force_sid, **kw):
        proxy = mock.Mock(wraps=con)
        proxy.close = mock.Mock()
        with mock.patch.object(zusage, "connect", return_value=proxy), \
             mock.patch.object(zusage, "load_config", return_value={"context_window": 200000}), \
             mock.patch.object(zusage, "_AGG_CACHE", {}), \
             mock.patch.object(zusage, "_scan_session_ids", return_value=[(force_sid, 2000)]), \
             mock.patch.object(zusage, "_remote_setup", return_value=None):
            return zusage.snapshot(force_sid=force_sid, **kw)

    def test_snapshot_gate_default_off_desktop_on(self):
        con = self.fixture()
        self.sess(con, "m1")
        self.usage(con, "r1", "m1", total=100, completed=3000)
        snap = self.snapshot_with(con, "m1")
        self.assertNotIn("all_projects", snap)   # CLI 报表/MCP/远端 stdout 契约不带
        snap2 = self.snapshot_with(con, "m1", include_all_projects=True)
        ap = snap2["all_projects"]
        self.assertEqual(ap["total"], 100)
        self.assertEqual(ap["projects"][0]["name"], "repo")

    def test_snapshot_drift_schema_degrades_without_field(self):
        con = self.fixture(schema=DRIFT_SCHEMA)
        con.execute("insert into session (id, title) values ('s', 't')")
        con.execute(
            "insert into model_usage (id, session_id, turn_id, status, started_at, completed_at)"
            " values ('r1', 's', 't1', 'completed', 1000, 2000)")
        snap = self.snapshot_with(con, "s", include_all_projects=True)
        self.assertNotIn("all_projects", snap, "列漂移按无字段降级，不拖垮整帧")


class AllProjectsFrameGateTests(unittest.TestCase):
    """serve/桌面 json 帧携带、远端子查询（ZUSAGE_REMOTE_CHILD=1）不带——
    夹具沿 test_speed_history.SpeedHistoryFrameTests（完整表集防既有异常分支掩盖门控）。"""

    def setUp(self):
        zusage._PROJ_CACHE.clear()
        zusage._PROJ_WM.clear()
        zusage._AGG_CACHE.clear()
        # 同 test_statusbar_rate 纪律：60s TTL 会跨测试串库，covers 必须逐用例重置
        zusage._COVERS_CACHE.update(ts=0.0, set=frozenset())
        spec = importlib.util.spec_from_file_location("frame_schema", REPO / "tests/test_statusbar_rate.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.con.executescript(mod.SCHEMA)
        self.con.execute("insert into session(id,title,project_id,directory) values ('s1','one','proj_repo','/repo')")
        self.con.execute("""insert into model_usage
            (id,session_id,turn_id,query_source,provider_id,model_id,status,
             started_at,first_token_at,completed_at,input_tokens,output_tokens,
             reasoning_tokens,cache_read_input_tokens,cache_creation_input_tokens)
            values ('a','s1','t1','main_turn','p','glm','completed',1000,1100,5000,100,300,0,0,0)""")
        self.con.commit()
        zusage._COVERS_CACHE.update(ts=0.0, set=frozenset())
        self.addCleanup(self.con.close)

    def frame(self, argv, env=None):
        out = io.StringIO()
        with mock.patch.object(zusage, "connect", return_value=self.con), \
                mock.patch.object(zusage, "load_config", return_value={"context_window": 1}), \
                mock.patch.dict(os.environ, env or {}, clear=False), \
                mock.patch.object(zusage.sys, "stdout", out):
            zusage.main(argv)
        return json.loads(out.getvalue())

    def test_serve_frame_carries_all_projects(self):
        request = json.dumps({"sids": ["s1"], "scopes": []})
        out = io.StringIO()
        with mock.patch.object(zusage, "connect", return_value=self.con), \
                mock.patch.object(zusage, "load_config", return_value={"context_window": 1}), \
                mock.patch.object(zusage.sys, "stdout", out), \
                mock.patch.object(zusage.sys, "stdin", io.StringIO(request + "\n")):
            zusage.main(["serve"])
        d = json.loads(out.getvalue())
        self.assertIn("all_projects", d)
        self.assertGreaterEqual(d["all_projects"]["requests"], 1)

    def test_desktop_oneshot_json_frame_carries_all_projects(self):
        request = json.dumps({"sids": ["s1"], "scopes": []})
        d = self.frame(["json", request])
        self.assertIn("all_projects", d, "常驻回退帧（legacySpawn json）同链携带")
        self.assertGreaterEqual(d["all_projects"]["requests"], 1)

    def test_remote_child_json_keeps_stdout_contract(self):
        d = self.frame(["json", "s1"], {"ZUSAGE_REMOTE_CHILD": "1"})
        self.assertNotIn("all_projects", d, "远端子查询 stdout 不夹带桌面增强字段")
        self.assertNotIn("speed_history", d)
        self.assertNotIn("error", d)


if __name__ == "__main__":
    unittest.main()
