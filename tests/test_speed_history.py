import importlib.util
import io
import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("zusage_v254", ROOT / "zusage.py")
zusage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(zusage)

SCHEMA = """
create table session (id text primary key, title text, parent_id text, time_created integer,
  project_id text, directory text);
create table model_usage (id text primary key, session_id text, turn_id text, query_source text,
  provider_id text, model_id text, status text, started_at integer, first_token_at integer,
  completed_at integer, input_tokens integer, output_tokens integer, reasoning_tokens integer,
  cache_read_input_tokens integer, cache_creation_input_tokens integer);
"""


class SpeedHistoryTests(unittest.TestCase):
    def setUp(self):
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self._seq = 0
        self.con.executescript(SCHEMA)
        zusage._COVERS_CACHE.update(ts=0.0, set=frozenset())
        zusage._AGG_CACHE.clear()

    def tearDown(self):
        self.con.close()

    def sess(self, sid, title="", pid="proj_a", directory="/work/proj-a", parent=None):
        self.con.execute("insert into session values (?,?,?,?,?,?)",
                         (sid, title, parent, 0, pid, directory))

    def row(self, rid, sid, tid, out, gen_ms, inp=1000, model="glm", provider="p",
            qs="main_turn", status="completed", completed=None, reasoning=0, with_ft=True):
        # gen_ms = completed_at - first_token_at 的有效生成窗口
        self._seq += 1
        start = completed or (1000000 + self._seq * 100000)
        ft = start - gen_ms if with_ft else None
        self.con.execute(
            "insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (rid, sid, tid, qs, provider, model, status, start - gen_ms - 500,
             ft, start, inp, out, reasoning, 0, 0))

    def test_per_turn_weighted_speed_and_exclusions(self):
        self.sess("s1", "会话一")
        # 一轮三请求：两段有效 + 一段无效 gen_ms（100ms < 200ms 门槛），速度 = Σout/Σms
        self.row("a1", "s1", "t1", 100, 1000, model="glm")
        self.row("a2", "s1", "t1", 300, 2000, model="glm2")
        self.row("a3", "s1", "t1", 999, 100, model="glm")   # 无效段：不进分子/分母
        # 辅助源与子代理不计
        self.row("a4", "s1", "t2", 5000, 1000, qs="subagent")
        self.row("a5", "s1", "t3", 5000, 1000, qs="session_title")
        # 另一轮
        self.row("a6", "s1", "t4", 200, 4000, model="glm")
        self.con.commit()
        h = zusage._speed_history(self.con, "s1")
        self.assertEqual(len(h["turns"]), 2)
        t1, t2 = h["turns"]
        self.assertAlmostEqual(t1["out"], 400)
        self.assertAlmostEqual(t1["ms"], 3000)
        # 速度不由 Python 存 v，但 out/ms 足以唯一决定加权速度
        self.assertAlmostEqual(t1["out"] / (t1["ms"] / 1000), 400 / 3)
        self.assertEqual(t1["n"], 3)       # 含无效段请求数
        self.assertEqual(t1["o"], 1399)    # 轮内全部输出（含无效碎段）
        self.assertEqual(len(t1["msl"]), 2)  # 两个有效模型
        self.assertEqual(t1["msl"][0][0] >= t1["msl"][1][0] or t1["msl"][0][1] >= t1["msl"][1][1], True)

    def test_invalid_generation_window_dropped_not_zero_speed(self):
        self.sess("s1")
        self.row("b1", "s1", "t1", 500, 100)    # gen_ms < 200ms 无效
        self.row("b2", "s1", "t2", 500, 4000000)  # > 1h 无效
        self.con.commit()
        h = zusage._speed_history(self.con, "s1")
        self.assertEqual(h["turns"], [], "无效轮整轮丢弃，绝不显 0 t/s")

    def test_completed_only_and_null_turn_id_grouped_per_session(self):
        self.sess("s1")
        self.row("c1", "s1", "t1", 100, 1000)
        self.row("c2", "s1", "t1", 100, 1000, status="error")
        self.row("c3", "s1", None, 200, 1000)
        self.con.commit()
        h = zusage._speed_history(self.con, "s1")
        self.assertEqual(len(h["turns"]), 2)
        self.assertEqual(h["turns"][0]["o"], 100, "失败请求不进轮")
        self.assertEqual(h["turns"][1]["o"], 200, "NULL turn_id 旧行归并一组")

    def test_project_scope_uses_project_id_and_subagent_sessions(self):
        self.sess("s1", "主会话")
        self.sess("s2", "同项目另一会话")
        self.sess("sub1", "子代理", parent="s1")
        self.sess("s3", "别的项目", pid="proj_b", directory="/work/proj-b")
        self.row("d1", "s1", "t1", 100, 1000)
        self.row("d2", "s2", "t1", 100, 1000)
        self.row("d3", "sub1", "t1", 100, 1000)
        self.row("d4", "s3", "t1", 100, 1000)
        self.con.commit()
        h = zusage._speed_history(self.con, "s1")
        self.assertEqual(len(h["turns"]), 4, "全库轮表：所有项目的会话都在单一事实源里")
        self.assertEqual(h["source"], "local")
        # 范围由渲染端按本 pane sid + pids 判定；帧里 sids/pids 一一对应
        self.assertEqual(len(h["sids"]), len(h["pids"]))
        i_s3 = h["sids"].index("s3")
        self.assertEqual(h["pids"][i_s3][0], "proj_b")

    def test_index_tables_and_delta_timestamps_are_lossless(self):
        self.sess("s1", "会话一")
        self.row("e1", "s1", "t1", 100, 1000, completed=1000000)
        self.row("e2", "s1", "t2", 200, 2000, completed=2000000)
        self.con.commit()
        h = zusage._speed_history(self.con, "s1")
        self.assertEqual(len(h["sids"]), 1)
        self.assertEqual(h["snames"][0], "会话一")
        self.assertEqual(h["pids"][0][1], "proj-a")
        self.assertIn("glm", h["mnames"])
        # delta 还原绝对完成时刻
        acc, absolutes = 0, []
        for t in h["turns"]:
            acc += t["t"]
            absolutes.append(acc)
        self.assertEqual(absolutes, [1000000, 2000000])
        self.assertTrue(all("v" not in t for t in h["turns"]), "不存单点 t/s，渲染端统一加权")

    def test_cost_field_absent_when_pricing_module_missing(self):
        self.sess("s1")
        self.row("f1", "s1", "t1", 100, 1000)
        self.con.commit()
        with mock.patch.object(zusage, "_pricing", None):
            h = zusage._speed_history(self.con, "s1")
        self.assertNotIn("c", h["turns"][0])

    def test_column_drift_and_safe_wrapper_never_raise(self):
        self.con.executescript("""
        create table legacy_session (id text primary key, title text);
        """)
        # 模拟旧库：session 无 project_id/directory —— 可选增强字段应降级而非抛异常
        self.con.execute("drop table session")
        self.con.executescript("create table session (id text primary key, title text, parent_id text, time_created integer)")
        self.con.execute("insert into session values ('s1','old',null,0)")
        self.row("g1", "s1", "t1", 100, 1000)
        self.con.commit()
        h = zusage._speed_history_safe(self.con, "s1")
        self.assertIsNotNone(h)
        self.assertEqual(len(h["turns"]), 1)
        self.assertTrue(all(isinstance(x, list) for x in h["pids"]))

    def test_cross_day_and_cross_month_turns_keep_absolute_completion(self):
        self.sess("s1")
        self.row("h1", "s1", "t1", 100, 1000, completed=1000000)
        self.row("h2", "s1", "t2", 100, 1000, completed=1000000 + 40 * 86400000)
        self.con.commit()
        h = zusage._speed_history(self.con, "s1")
        acc = 0
        for t in h["turns"]:
            acc += t["t"]
        self.assertEqual(acc, 1000000 + 40 * 86400000)

    def test_bounded_scan_caps_turns(self):
        self.sess("s1")
        old = zusage._SPEED_HISTORY_MAX_TURNS
        zusage._SPEED_HISTORY_MAX_TURNS = 3
        try:
            for i in range(8):
                self.row("i%d" % i, "s1", "t%d" % i, 100, 1000, completed=1000000 + i * 100000)
            self.con.commit()
            h = zusage._speed_history(self.con, "s1")
            self.assertLessEqual(len(h["turns"]), 3)
            self.assertTrue(h["truncated"])
        finally:
            zusage._SPEED_HISTORY_MAX_TURNS = old

    def test_speed_segments_legacy_contract_unchanged(self):
        self.sess("s1")
        self.row("j1", "s1", "t1", 100, 1000)
        self.row("j2", "s1", "t2", 300, 1000)
        self.con.commit()
        covers = zusage._provider_first_token_covers(self.con)
        segs = zusage._speed_segments(self.con, "s1", covers)
        self.assertGreaterEqual(len(segs), 1)
        for s in segs:
            self.assertIn("v", s)
            self.assertIn("t", s)
            self.assertIn("i", s)
            self.assertIn("o", s)
            self.assertIn("n", s)
            self.assertIsInstance(s["v"], float)


if __name__ == "__main__":
    unittest.main()


class SpeedHistoryEmptyTests(unittest.TestCase):
    def setUp(self):
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.con.executescript(SCHEMA)
        zusage._COVERS_CACHE.update(ts=0.0, set=frozenset())
        zusage._SPEED_CACHE.clear()

    def tearDown(self):
        self.con.close()

    def test_empty_library_returns_empty_frame_without_exception(self):
        self.con.execute("insert into session values ('s1','empty',null,0,'proj_a','/p/a')")
        self.con.commit()
        h = zusage._speed_history(self.con, "s1")
        self.assertEqual(h["turns"], [])
        self.assertEqual(h["sids"], [])
        self.assertEqual(h["snames"], [])
        self.assertEqual(h["pids"], [])
        self.assertEqual(h["mnames"], [])
        self.assertFalse(h["truncated"])
        self.assertIsNotNone(zusage._speed_history_safe(self.con, "s1"), "空库不降级成 None")

    def test_only_auxiliary_requests_still_yield_empty_frame(self):
        self.con.execute("insert into session values ('s1','aux',null,0,'proj_a','/p/a')")
        self.con.execute("insert into model_usage values ('a','s1','t1','subagent','p','glm','completed',1000,1100,5000,100,300,0,0,0)")
        self.con.commit()
        h = zusage._speed_history_safe(self.con, "s1")
        self.assertIsNotNone(h)
        self.assertEqual(h["turns"], [])

    def test_sid_is_diagnostic_only_not_a_filter(self):
        self.con.execute("insert into session values ('s1','one',null,0,'proj_a','/p/a')")
        self.con.execute("insert into session values ('s2','two',null,0,'proj_b','/p/b')")
        self.con.execute("insert into model_usage values ('a','s1','t1','main_turn','p','glm','completed',1000,1100,5000,100,300,0,0,0)")
        self.con.execute("insert into model_usage values ('b','s2','t1','main_turn','p','glm','completed',2000,2100,6000,100,300,0,0,0)")
        self.con.commit()
        a = zusage._speed_history(self.con, "s1")
        b = zusage._speed_history(self.con, "s2")
        self.assertEqual([t["t"] for t in a["turns"]], [t["t"] for t in b["turns"]],
                         "全库轮表与传入 sid 无关，范围由渲染端按本 pane 判定")
        self.assertEqual(len(a["sids"]), 2)

    def test_cost_never_claims_full_price(self):
        self.con.execute("insert into session values ('s1','cost',null,0,'proj_a','/p/a')")
        self.con.execute("insert into model_usage values ('a','s1','t1','main_turn','p','glm','completed',1000,1100,5000,100,300,0,0,0)")
        self.con.commit()
        h = zusage._speed_history(self.con, "s1")
        # 价表可能含兜底均价，不置 cf → 展示层恒标「含兜底估价」
        self.assertNotIn("cf", h["turns"][0])


class SpeedHistoryFrameTests(unittest.TestCase):
    """v255：桌面快照链每一帧都必须带统一轮表（常驻 serve / legacySpawn 一次性 json），
    远端子查询与 CLI 手工 json 保持原 stdout 契约；避免 Tooltip 在 V2 与旧卡间闪回。"""

    def setUp(self):
        # 用仓库完整夹具建库：snapshot 的今日/费用/工具等查询都依赖真实表结构，
        # 简化 SCHEMA 会让 _today_detail 缺列后走既有异常分支，掩盖本类要测的门控。
        spec = importlib.util.spec_from_file_location("frame_schema", ROOT / "tests/test_statusbar_rate.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.con.executescript(mod.SCHEMA)
        self.con.execute("insert into session(id,title) values ('s1','one')")
        self.con.execute("""insert into model_usage
            (id,session_id,turn_id,query_source,provider_id,model_id,status,
             started_at,first_token_at,completed_at,input_tokens,output_tokens,
             reasoning_tokens,cache_read_input_tokens,cache_creation_input_tokens)
            values ('a','s1','t1','main_turn','p','glm','completed',1000,1100,5000,100,300,0,0,0)""")
        self.con.commit()
        zusage._COVERS_CACHE.update(ts=0.0, set=frozenset())
        zusage._AGG_CACHE.clear()
        zusage._SPEED_CACHE.clear()

    def tearDown(self):
        self.con.close()

    def frame(self, argv, env=None):
        out = io.StringIO()
        with mock.patch.object(zusage, "connect", return_value=self.con), \
                mock.patch.object(zusage, "load_config", return_value={"context_window": 1}), \
                mock.patch.dict(os.environ, env or {}, clear=False), \
                mock.patch.object(zusage.sys, "stdout", out):
            zusage.main(argv)
        return json.loads(out.getvalue())

    def test_explicit_include_speed_history_gate(self):
        with mock.patch.object(zusage, "connect", return_value=self.con), \
                mock.patch.object(zusage, "load_config", return_value={"context_window": 1}):
            self.assertIn("speed_history", zusage.snapshot("s1", include_speed_history=True))
            self.assertNotIn("speed_history", zusage.snapshot("s1"))

    def test_serve_frame_has_history(self):
        request = json.dumps({"sids": ["s1"], "scopes": []})
        out = io.StringIO()
        with mock.patch.object(zusage, "connect", return_value=self.con), \
                mock.patch.object(zusage, "load_config", return_value={"context_window": 1}), \
                mock.patch.object(zusage.sys, "stdout", out), \
                mock.patch.object(zusage.sys, "stdin", io.StringIO(request + "\n")):
            zusage.main(["serve"])
        d = json.loads(out.getvalue())
        self.assertEqual(len(d["speed_history"]["turns"]), 1)

    def test_desktop_oneshot_json_frame_has_history(self):
        request = json.dumps({"sids": ["s1"], "scopes": []})
        d = self.frame(["json", request])
        self.assertEqual(len(d["speed_history"]["turns"]), 1,
                         "常驻进程回退帧缺轮表会让 V2 闪回旧版整卡")

    def test_remote_child_json_keeps_stdout_contract(self):
        d = self.frame(["json", "s1"], {"ZUSAGE_REMOTE_CHILD": "1"})
        self.assertNotIn("speed_history", d,
                         "远端子查询 stdout 不夹带桌面增强字段")
        self.assertNotIn("error", d)

    def test_lean_serve_frame_omits_desktop_fields(self):
        request = json.dumps({"sids": ["s1"], "scopes": [], "lean": True})
        out = io.StringIO()
        with mock.patch.object(zusage, "connect", return_value=self.con), \
                mock.patch.object(zusage, "load_config", return_value={"context_window": 1}), \
                mock.patch.object(zusage.sys, "stdout", out), \
                mock.patch.object(zusage.sys, "stdin", io.StringIO(request + "\n")):
            zusage.main(["serve"])
        d = json.loads(out.getvalue())
        self.assertNotIn("speed_history", d, "手机中继 lean 请求不计算桌面轮表")
        self.assertNotIn("all_projects", d, "lean 同时关闭 all_projects")

    def test_lean_oneshot_json_frame_omits_desktop_fields(self):
        request = json.dumps({"sids": ["s1"], "scopes": [], "lean": True})
        d = self.frame(["json", request])
        self.assertNotIn("speed_history", d, "常驻回退的一次性 json 复用同一 lean 请求")
        self.assertNotIn("all_projects", d)

    def test_lean_requires_explicit_boolean_true(self):
        request = json.dumps({"sids": ["s1"], "scopes": [], "lean": "true"})
        d = self.frame(["json", request])
        self.assertIn("speed_history", d, "非布尔真值不能当作 lean")
        self.assertIn("all_projects", d)
        self.assertFalse(zusage._query_lean("s1"))
        self.assertTrue(zusage._query_lean(json.dumps({"sids": ["s1"], "lean": True})))

    def test_failed_scan_falls_back_to_recent_success(self):
        # v257：完成轮瞬间的写窗口可能让全库扫描偶发失败；safe 应回退最近一次成功轮表，
        # 否则热重载后首帧恰逢失败时渲染端粘性为空，Tooltip 闪回旧版整卡。
        zusage._SPEED_CACHE.clear()
        with mock.patch.object(zusage, "_speed_history_cached",
                               side_effect=sqlite3.OperationalError("database is locked")):
            self.assertIsNone(zusage._speed_history_safe(self.con, "s1"),
                              "无任何成功值时仍降级 None")
        good = zusage._speed_history(self.con, "s1")
        zusage._SPEED_CACHE.clear()
        zusage._SPEED_CACHE[("k",)] = (int(time.time() * 1000), good)
        with mock.patch.object(zusage, "_speed_history_cached",
                               side_effect=sqlite3.OperationalError("database is locked")):
            self.assertIs(zusage._speed_history_safe(self.con, "s1"), good,
                          "扫描失败回退最近成功轮表（跨 dbkey）")
        zusage._SPEED_CACHE[("k",)] = (int(time.time() * 1000) - zusage._SPEED_HISTORY_STALE_MS - 1000, good)
        with mock.patch.object(zusage, "_speed_history_cached",
                               side_effect=sqlite3.OperationalError("database is locked")):
            self.assertIsNone(zusage._speed_history_safe(self.con, "s1"),
                              "超过 stale 上限不回退陈旧值")


class SpeedModelDetailTests(unittest.TestCase):
    """v384（specs/speed-tooltip-v3.md §1.1）：msl 扩为 [mIdx, out, ms, n] 四元组 +
    mkeys 身份表。旧渲染器只读 [0]/[1] 不受影响；渲染端 spdUnpack 的旧帧兼容是
    渲染侧契约，这里锁定 Python 产出的形状与身份正确性。"""

    def setUp(self):
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self._seq = 0
        self.con.executescript(SCHEMA)
        zusage._COVERS_CACHE.update(ts=0.0, set=frozenset())
        zusage._SPEED_CACHE.clear()
        zusage._DAYS_CACHE.clear()

    def tearDown(self):
        self.con.close()

    def row(self, rid, sid, tid, out, gen_ms, model="glm", provider="p", completed=None):
        self._seq += 1
        start = completed or (1000000 + self._seq * 100000)
        self.con.execute(
            "insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (rid, sid, tid, "main_turn", provider, model, "completed", start - gen_ms - 500,
             start - gen_ms, start, 1000, out, 0, 0, 0))

    def test_msl_tuple_carries_per_model_window_and_request_count(self):
        self.con.execute("insert into session values ('s1','一',null,0,'proj','/w/a')")
        # 一轮两模型：glm 有 1 条有效行 + 1 条无效窗口行；glm2 仅 1 条有效行
        self.row("a1", "s1", "t1", 100, 1000, model="glm")
        self.row("a2", "s1", "t1", 999, 100, model="glm")    # 无效窗口：不进 out/ms，但 n 计入
        self.row("a3", "s1", "t1", 300, 2000, model="glm2")
        self.con.commit()
        h = zusage._speed_history(self.con, "s1")
        names = h["mnames"]
        t1 = h["turns"][0]
        self.assertEqual(len(t1["msl"]), 2, "仅 out>0 的模型入列")
        for e in t1["msl"]:
            self.assertEqual(len(e), 4, "v384 msl 为 [mIdx, out, ms, n] 四元组")
            self.assertTrue(all(isinstance(x, int) for x in e), "ms/n 为 int")
        by_name = {names[e[0]]: e for e in t1["msl"]}
        self.assertEqual(by_name["glm"][1:], [100, 1000, 2], "out=有效输出、ms=Σ有效窗口、n 含无效窗口行")
        self.assertEqual(by_name["glm2"][1:], [300, 2000, 1])

    def test_mkeys_parallel_to_mnames_with_provider_identity(self):
        self.con.execute("insert into session values ('s1','一',null,0,'proj','/w/a')")
        # 同名模型不同 provider → 三个独立身份（显示名都是 model_id）；provider 缺失用空串
        self.row("b1", "s1", "t1", 100, 1000, model="glm", provider="pa", completed=1000000)
        self.row("b2", "s1", "t2", 200, 2000, model="glm", provider="pb", completed=2000000)
        self.row("b3", "s1", "t3", 300, 3000, model="glm", provider="", completed=3000000)
        self.con.commit()
        h = zusage._speed_history(self.con, "s1")
        self.assertEqual(len(h["mkeys"]), len(h["mnames"]), "mkeys 与 mnames 平行")
        self.assertEqual(h["mnames"], ["glm", "glm", "glm"])
        self.assertEqual(h["mkeys"], ["pa\x1fglm", "pb\x1fglm", "\x1fglm"])
        # 轮内 msl[0] 的 mIdx 指回正确身份（delta 还原绝对完成时刻定位 t1）
        acc, by_time = 0, {}
        for t in h["turns"]:
            acc += t["t"]
            by_time[acc] = t
        t1 = by_time[1000000]
        self.assertEqual(h["mkeys"][t1["msl"][0][0]], "pa\x1fglm")
        self.assertEqual(t1["msl"][0][1:], [100, 1000, 1])


class SpeedDaysTests(unittest.TestCase):
    """v384（specs/speed-tooltip-v3.md §1.2）：全历史按本地自然日聚合。锁定跨日/空日、
    月末与跨年日界、日级 out/ms/n/turns、每模型 tn、msl 打平五元组（仅 out>0 入列）、
    >8 模型截断 capFlag、truncated 探针与 550 日上限。固定日期用例把
    _SPEED_DAYS_MAX_DAYS 临时放大到 4000，避免 550 日窗口随运行日期推移把 2025 年
    夹具推出窗口（也顺带锁常量是动态读取的）。"""

    def setUp(self):
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.con.executescript(SCHEMA)
        self.con.execute("insert into session values ('s1','一',null,0,'proj','/w/a')")
        zusage._COVERS_CACHE.update(ts=0.0, set=frozenset())
        zusage._DAYS_CACHE.clear()
        zusage._DAYS_WM.clear()

    def tearDown(self):
        self.con.close()

    @staticmethod
    def ms(y, m, d, hh=12):
        return int(datetime(y, m, d, hh).timestamp() * 1000)

    def row(self, rid, tid, out, gen_ms, completed, model="glm", provider="p"):
        self.con.execute(
            "insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (rid, "s1", tid, "main_turn", provider, model, "completed", completed - gen_ms - 500,
             completed - gen_ms, completed, 1000, out, 0, 0, 0))

    def bucket(self, sd, date):
        """days[i] = start + i*864e5 的本地日索引（spec §1.2 的下标契约）。"""
        start_date = datetime.fromtimestamp(sd["start"] / 1000).date()
        return sd["days"][(date - start_date).days]

    def test_cross_month_and_year_day_buckets(self):
        old = zusage._SPEED_DAYS_MAX_DAYS
        zusage._SPEED_DAYS_MAX_DAYS = 4000
        try:
            self.row("c1", "t1", 50, 500, self.ms(2025, 11, 30, 23), model="glm")
            self.row("c2", "t2", 60, 600, self.ms(2025, 12, 1, 1), model="glm2")
            self.row("c3", "t3", 70, 700, self.ms(2025, 12, 31, 23), model="glm")
            self.row("c4", "t4", 80, 800, self.ms(2026, 1, 1, 1), model="glm2")
            self.con.commit()
            sd = zusage._speed_days(self.con)
            self.assertEqual(len(sd["days"]), 4000)
            self.assertEqual(sd["v"], 1)
            self.assertEqual(sd["source"], "local")
            self.assertEqual(self.bucket(sd, datetime(2025, 11, 30).date())[:4], [50, 500, 1, 1], "月末 11-30")
            self.assertEqual(self.bucket(sd, datetime(2025, 12, 1).date())[:4], [60, 600, 1, 1], "次月 12-01")
            self.assertEqual(self.bucket(sd, datetime(2025, 12, 31).date())[:4], [70, 700, 1, 1], "年末 12-31")
            self.assertEqual(self.bucket(sd, datetime(2026, 1, 1).date())[:4], [80, 800, 1, 1], "跨年 01-01")
            # msl 为打平五元组序列（新形态，msl[0] 是数字），mIdx 指回 mnames/mkeys 可还原
            b = self.bucket(sd, datetime(2025, 12, 31).date())
            self.assertTrue(all(isinstance(x, int) for x in b[5]), "msl 打平：无内层列表")
            self.assertEqual(sd["mkeys"][b[5][0]], "p\x1fglm")
            self.assertEqual(b[5][:5], [sd["mnames"].index("glm"), 70, 700, 1, 1])
            self.assertFalse(any(self.bucket(sd, datetime(2025, 12, 15).date())), "无数据日为全零桶")
        finally:
            zusage._SPEED_DAYS_MAX_DAYS = old

    def test_empty_days_are_zero_buckets(self):
        today = datetime.now().date()
        base = int(datetime(today.year, today.month, today.day, 10).timestamp() * 1000)
        self.row("d1", "t1", 100, 1000, base - 2 * 86400000)
        self.row("d2", "t2", 100, 1000, base)
        self.con.commit()
        sd = zusage._speed_days(self.con)
        self.assertEqual(len(sd["days"]), 550, "缺省常量下窗口恒 550 日")
        self.assertEqual(self.bucket(sd, today)[:4], [100, 1000, 1, 1])
        self.assertEqual(self.bucket(sd, today - timedelta(days=1)), [0, 0, 0, 0, 0, 0], "空日补零桶")
        self.assertEqual(self.bucket(sd, today - timedelta(days=2))[:4], [100, 1000, 1, 1])
        self.assertEqual(sd["truncated"], 0, "窗口内无更早数据不标截断")

    def test_day_counts_include_invalid_rows_and_model_tn(self):
        now = int(datetime.now().timestamp() * 1000)
        # 同一天：t1 一条有效 + 一条无效；t2 一条有效 → turns=2、n=3、out=150、ms=1500
        self.row("e1", "t1", 100, 1000, now)
        self.row("e2", "t1", 999, 100, now)      # 无效窗口：n 计入，out/ms 不计
        self.row("e3", "t2", 50, 500, now)
        self.con.commit()
        sd = zusage._speed_days(self.con)
        b = self.bucket(sd, datetime.fromtimestamp(now / 1000).date())
        self.assertEqual(b[:4], [150, 1500, 3, 2])
        msl_glm = b[5][:5]   # 唯一模型 glm 的打平条目
        self.assertEqual(msl_glm[3], 3, "模型 n=当日该模型已完成行数（含无效窗口行）")
        self.assertEqual(msl_glm[4], 2, "tn=当日含该模型已完成行的 distinct 轮数")

    def test_null_turn_id_rows_count_independently(self):
        now = int(datetime.now().timestamp() * 1000)
        # turn_id 为 NULL 的旧行：日级 turns 与模型 tn 都按每行一个独立计次（函数注释即契约；
        # _speed_turns 的 NULL 行按会话归并一组是轮表口径，日桶采用更细的可控口径）
        self.row("f1", None, 100, 1000, now)
        self.row("f2", None, 100, 1000, now + 1000)
        self.con.commit()
        sd = zusage._speed_days(self.con)
        b = self.bucket(sd, datetime.fromtimestamp(now / 1000).date())
        self.assertEqual(b[2], 2)
        self.assertEqual(b[3], 2, "NULL turn_id 行逐行独立计次")
        self.assertEqual(b[5][4], 2, "打平条目第 5 位=tn")

    def test_model_list_capped_at_8_with_exact_totals(self):
        now = int(datetime.now().timestamp() * 1000)
        outs = []
        for i in range(13):
            out = 1000 - i
            self.row("g%d" % i, "tg%d" % i, out, 900 - i, now, model="mx%d" % i)
            outs.append(out)
        self.con.commit()
        sd = zusage._speed_days(self.con)
        b = self.bucket(sd, datetime.fromtimestamp(now / 1000).date())
        self.assertEqual(b[4], 1, "capFlag=1 表示模型列表截断（13 > _SPEED_DAYS_MAX_MODELS=8）")
        self.assertEqual(len(b[5]), 8 * 5, "打平五元组 × 8 个模型")
        self.assertEqual(b[0], sum(outs), "日级 out 不随模型截断失真")
        self.assertEqual(b[2], 13)
        self.assertEqual(b[3], 13)
        self.assertEqual(b[5][1::5], sorted(outs, reverse=True)[:8], "打平 out 槽位按降序取前 8")
        self.assertEqual(b[5][0::5], list(range(8)), "mIdx 与 mnames 前 8 位对齐（降序入列顺序）")

    def test_exactly_8_models_sets_no_capflag(self):
        now = int(datetime.now().timestamp() * 1000)
        for i in range(8):
            self.row("g8_%d" % i, "tg8_%d" % i, 500 - i, 400, now, model="me%d" % i)
        self.con.commit()
        sd = zusage._speed_days(self.con)
        b = self.bucket(sd, datetime.fromtimestamp(now / 1000).date())
        self.assertEqual(b[4], 0, "恰好 8 个 out>0 模型不置 capFlag")
        self.assertEqual(len(b[5]), 8 * 5)

    def test_zero_output_models_excluded_from_model_list(self):
        now = int(datetime.now().timestamp() * 1000)
        # glmz 只有无效窗口行（out=0）：计入日级 n/turns，但不进 msl 身份列表（与
        # _speed_turns「仅 out>0 入列」一致）；身份表仍收集（行在窗口内有桶归属）
        self.row("gz1", "t1", 100, 1000, now, model="glm")
        self.row("gz2", "t2", 999, 100, now, model="glmz")     # 无效窗口 → glmz out=0
        self.row("gz3", "t3", 0, 1000, now, model="glmz")      # 有效窗口但 0 输出 → out 仍 0
        self.con.commit()
        sd = zusage._speed_days(self.con)
        b = self.bucket(sd, datetime.fromtimestamp(now / 1000).date())
        self.assertEqual(b[:4], [100, 1000, 3, 3], "out=0 模型的行仍计入日级 out/ms/n/turns")
        self.assertEqual(len(b[5]), 5, "打平 msl 只含 glm 一个五元组")
        self.assertEqual(sd["mnames"][b[5][0]], "glm")
        self.assertIn("glmz", sd["mnames"], "out=0 模型仍进身份表（其行有桶归属）")

    def test_truncated_probe_and_550_day_cap(self):
        today = datetime.now().date()
        base = int(datetime(today.year, today.month, today.day, 10).timestamp() * 1000)
        self.row("h1", "t1", 100, 1000, base)
        self.row("h2", "t2", 100, 1000, base - 600 * 86400000, model="glm2")   # 早于 550 日窗口
        self.con.commit()
        sd = zusage._speed_days(self.con)
        self.assertEqual(sd["truncated"], 1, "存在早于窗口起点的已完成行置 1")
        self.assertEqual(len(sd["days"]), 550)
        self.assertEqual(sum(d[2] for d in sd["days"]), 1, "窗口前行不进任何日桶")
        self.assertEqual(sum(d[0] for d in sd["days"]), 100)
        self.assertNotIn("glm2", sd["mnames"], "窗口前模型不进身份表（其行无任何桶可引用）")

    def test_same_name_models_split_by_provider_in_days(self):
        now = int(datetime.now().timestamp() * 1000)
        self.row("i1", "t1", 100, 1000, now, model="glm", provider="pa")
        self.row("i2", "t2", 200, 2000, now, model="glm", provider="")
        self.con.commit()
        sd = zusage._speed_days(self.con)
        self.assertEqual(sd["mnames"].count("glm"), 2)
        self.assertEqual(sorted(sd["mkeys"]), ["\x1fglm", "pa\x1fglm"])
        b = self.bucket(sd, datetime.fromtimestamp(now / 1000).date())
        self.assertEqual(len(b[5]), 2 * 5, "同名牌不同 provider 是两个独立打平条目")
        self.assertEqual(b[3], 2, "(sid, turn_id) 复合键：不同轮不归并")


class SpeedDaysFrameTests(unittest.TestCase):
    """v384 门控矩阵（specs/speed-tooltip-v3.md §1.2）：serve 帧与桌面一次性 json 带
    speed_days；远端子查询（ZUSAGE_REMOTE_CHILD=1）与手机 lean 请求不带——开关点与
    include_speed_history 完全一致。夹具沿 SpeedHistoryFrameTests（完整表集防既有异常
    分支掩盖门控）。"""

    def setUp(self):
        zusage._DAYS_CACHE.clear()
        zusage._DAYS_WM.clear()
        zusage._COVERS_CACHE.update(ts=0.0, set=frozenset())
        spec = importlib.util.spec_from_file_location("days_frame_schema", ROOT / "tests/test_statusbar_rate.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.con.executescript(mod.SCHEMA)
        self.con.execute("insert into session(id,title) values ('s1','one')")
        # completed_at 取当前时刻（speed_days 只聚合 550 日窗口内的行，1970 年代时间戳
        # 会被窗口起点守卫跳过——这正是 SpeedDaysTests 锁定的行为）
        now = int(time.time() * 1000)
        self.con.execute("""insert into model_usage
            (id,session_id,turn_id,query_source,provider_id,model_id,status,
             started_at,first_token_at,completed_at,input_tokens,output_tokens,
             reasoning_tokens,cache_read_input_tokens,cache_creation_input_tokens)
            values ('a','s1','t1','main_turn','p','glm','completed',?,?,?,100,300,0,0,0)""",
            (now - 4000, now - 3000, now))
        self.con.commit()
        zusage._COVERS_CACHE.update(ts=0.0, set=frozenset())

    def tearDown(self):
        self.con.close()

    def frame(self, argv, env=None):
        out = io.StringIO()
        with mock.patch.object(zusage, "connect", return_value=self.con), \
                mock.patch.object(zusage, "load_config", return_value={"context_window": 1}), \
                mock.patch.dict(os.environ, env or {}, clear=False), \
                mock.patch.object(zusage.sys, "stdout", out):
            zusage.main(argv)
        return json.loads(out.getvalue())

    def test_explicit_include_speed_days_gate(self):
        with mock.patch.object(zusage, "connect", return_value=self.con), \
                mock.patch.object(zusage, "load_config", return_value={"context_window": 1}):
            self.assertIn("speed_days", zusage.snapshot("s1", include_speed_days=True))
            self.assertNotIn("speed_days", zusage.snapshot("s1"),
                             "CLI 报表 / MCP / zusage json 缺省不带")

    def test_serve_frame_has_speed_days(self):
        request = json.dumps({"sids": ["s1"], "scopes": []})
        out = io.StringIO()
        with mock.patch.object(zusage, "connect", return_value=self.con), \
                mock.patch.object(zusage, "load_config", return_value={"context_window": 1}), \
                mock.patch.object(zusage.sys, "stdout", out), \
                mock.patch.object(zusage.sys, "stdin", io.StringIO(request + "\n")):
            zusage.main(["serve"])
        d = json.loads(out.getvalue())
        sd = d["speed_days"]
        self.assertEqual(sd["v"], 1)
        self.assertEqual(len(sd["days"]), 550)
        self.assertEqual(sum(day[2] for day in sd["days"]), 1)

    def test_desktop_oneshot_json_frame_has_speed_days(self):
        request = json.dumps({"sids": ["s1"], "scopes": []})
        d = self.frame(["json", request])
        self.assertIn("speed_days", d, "常驻回退帧（legacySpawn json）同链携带")

    def test_remote_child_json_keeps_stdout_contract(self):
        d = self.frame(["json", "s1"], {"ZUSAGE_REMOTE_CHILD": "1"})
        self.assertNotIn("speed_days", d, "远端子查询 stdout 不夹带桌面增强字段")
        self.assertNotIn("error", d)

    def test_lean_serve_frame_omits_speed_days(self):
        request = json.dumps({"sids": ["s1"], "scopes": [], "lean": True})
        out = io.StringIO()
        with mock.patch.object(zusage, "connect", return_value=self.con), \
                mock.patch.object(zusage, "load_config", return_value={"context_window": 1}), \
                mock.patch.object(zusage.sys, "stdout", out), \
                mock.patch.object(zusage.sys, "stdin", io.StringIO(request + "\n")):
            zusage.main(["serve"])
        d = json.loads(out.getvalue())
        self.assertNotIn("speed_days", d, "手机中继 lean 请求不计算日桶帧")

    def test_lean_oneshot_json_frame_omits_speed_days(self):
        request = json.dumps({"sids": ["s1"], "scopes": [], "lean": True})
        d = self.frame(["json", request])
        self.assertNotIn("speed_days", d, "常驻回退的一次性 json 复用同一 lean 请求")


class SpeedDaysCacheTests(unittest.TestCase):
    """v384：_speed_days_cached/_speed_days_safe 镜像轮表缓存语义——TTL 过期后水位未变
    续用、水位变重算、扫描失败 50ms 重试后回退最近成功帧（stale 上限共用）。水位需要
    真实文件库身份，用临时目录文件库（内存库 _db_cache_key=None 走不缓存分支）。"""

    def setUp(self):
        zusage._DAYS_CACHE.clear()
        zusage._DAYS_WM.clear()
        zusage._COVERS_CACHE.update(ts=0.0, set=frozenset())
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        self.con = sqlite3.connect(str(Path(self.td.name) / "db.sqlite"))
        self.addCleanup(self.con.close)
        self.con.row_factory = sqlite3.Row
        self.con.executescript(SCHEMA)
        self.con.execute("insert into session values ('s1','一',null,0,'proj','/w/a')")
        self.n = 0
        self.add_row()
        self.addCleanup(zusage._DAYS_CACHE.clear)
        self.addCleanup(zusage._DAYS_WM.clear)

    def add_row(self, model="glm"):
        self.n += 1
        # completed_at 取当前时刻：speed_days 只聚合窗口内行，epoch 初期的行会产生空帧，
        # 而空帧不延长水位（镜像 _speed_history_cached 语义）会让续用用例失去前提
        now = int(time.time() * 1000)
        self.con.execute(
            "insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            ("r%d" % self.n, "s1", "t%d" % self.n, "main_turn", "p", model, "completed",
             now - 2000, now - 1000, now, 60, 30, 0, 0, 0))
        self.con.commit()

    @staticmethod
    def expire(cache, key, ms):
        ts, val = cache[key]
        cache[key] = (ts - ms, val)

    def test_cached_reuses_until_watermark_changes(self):
        calls = []
        real = zusage._speed_days

        def counting(con):
            calls.append(1)
            return real(con)

        zusage._speed_days = counting
        self.addCleanup(setattr, zusage, "_speed_days", real)
        key = zusage._db_cache_key(self.con)
        zusage._speed_days_cached(self.con)
        self.assertEqual(len(calls), 1)
        self.expire(zusage._DAYS_CACHE, key, zusage._SPEED_HISTORY_TTL_MS + 1)
        zusage._speed_days_cached(self.con)
        self.assertEqual(len(calls), 1, "TTL 过期但水位未变：续用")
        self.expire(zusage._DAYS_CACHE, key, 1)
        self.add_row()   # 新请求完成 → 水位变 → 立即重算
        zusage._speed_days_cached(self.con)
        self.assertEqual(len(calls), 2, "水位变：重算")

    def test_safe_falls_back_to_recent_success(self):
        with mock.patch.object(zusage, "_speed_days_cached",
                               side_effect=sqlite3.OperationalError("database is locked")):
            self.assertIsNone(zusage._speed_days_safe(self.con), "无任何成功值时仍降级 None")
        good = zusage._speed_days(self.con)
        zusage._DAYS_CACHE.clear()
        zusage._DAYS_CACHE[("k",)] = (int(time.time() * 1000), good)
        with mock.patch.object(zusage, "_speed_days_cached",
                               side_effect=sqlite3.OperationalError("database is locked")):
            self.assertIs(zusage._speed_days_safe(self.con), good, "扫描失败回退最近成功日桶帧")
        zusage._DAYS_CACHE[("k",)] = (int(time.time() * 1000) - zusage._SPEED_HISTORY_STALE_MS - 1000, good)
        with mock.patch.object(zusage, "_speed_days_cached",
                               side_effect=sqlite3.OperationalError("database is locked")):
            self.assertIsNone(zusage._speed_days_safe(self.con), "超过 stale 上限不回退陈旧值")


if __name__ == "__main__":
    unittest.main()
