import importlib.util
import io
import json
import os
import sqlite3
import sys
import time
import unittest
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


if __name__ == "__main__":
    unittest.main()
