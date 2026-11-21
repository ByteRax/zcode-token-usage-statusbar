# -*- coding: utf-8 -*-
"""v421 会话压缩边界表（zusage._session_compactions[_safe]）回归。

宿主时间线「上下文已压缩」分隔线统计标注的数据源：query_source='compact' 行按
started_at 序与 DOM 第 k 条 success 分隔线一一对应，前后边界取相邻已完成
main_turn 的 input（input>0 守卫），缓存三列取压缩后首请求。
"""
import sqlite3
import unittest

from tests.helpers.py_test_support import load_module

ZUSAGE = load_module("zusage_test", "zusage.py")


def make_db():
    con = sqlite3.connect(":memory:")
    con.execute(
        """create table model_usage(
             id integer primary key, session_id text, query_source text,
             status text, started_at integer, completed_at integer,
             input_tokens integer, output_tokens integer,
             cache_read_input_tokens integer, cache_creation_input_tokens integer,
             model_id text)"""
    )
    return con


def req(con, sid, started, completed, input_tokens, query_source="main_turn",
        status="completed", cr=0, cw=0, model="glm-4.6"):
    con.execute(
        "insert into model_usage(session_id, query_source, status, started_at,"
        " completed_at, input_tokens, output_tokens, cache_read_input_tokens,"
        " cache_creation_input_tokens, model_id) values(?,?,?,?,?,?,?,?,?,?)",
        (sid, query_source, status, started, completed, input_tokens, 10, cr, cw, model),
    )


class SessionCompactionsTest(unittest.TestCase):
    def test_boundary_alignment_and_cache_fields(self):
        con = make_db()
        sid = "s1"
        req(con, sid, 100, 200, 1000)                    # 压缩前 main_turn
        req(con, sid, 300, 400, 1200)                    # 压缩前末条（=before）
        con.execute(
            "insert into model_usage(session_id, query_source, status, started_at,"
            " completed_at, input_tokens, output_tokens, cache_read_input_tokens,"
            " cache_creation_input_tokens, model_id) values(?,?,?,?,?,?,?,?,?,?)",
            (sid, "compact", "completed", 500, 900, 2000, 3210, 0, 0, "glm-4.6"),
        )                                                # 压缩总结请求（摘要输出 3,210）
        req(con, sid, 950, 990, 0)                       # 零值空行：必须被 input>0 守卫跳过
        req(con, sid, 1000, 1100, 480, cr=100, cw=20)    # 压缩后首条（=after，带缓存）
        req(con, sid, 1200, 1300, 500, cr=480)           # 更晚请求：不得污染 after
        out = ZUSAGE._session_compactions(con, [sid])
        self.assertEqual(len(out[sid]), 1)
        rec = out[sid][0]
        self.assertEqual(rec["ts"], 900)                 # ts=compact 行完成时刻
        self.assertEqual(rec["b"], 1200)                 # 压缩前末条 main_turn input
        self.assertEqual(rec["a"], 480)                  # 压缩后首条（input>0）main_turn input
        self.assertEqual(rec["cr"], 100)
        self.assertEqual(rec["cw"], 20)
        self.assertEqual(rec["out"], 3210)               # v428：摘要长度=compact 行 output
        self.assertEqual(rec["dur"], 400)                # v428：压缩耗时=completed-started
        self.assertNotIn("alt", rec)                     # 同模型执行：不产 alt

    def test_missing_completed_at_falls_back_to_started_at(self):
        """v433 兜底锁：compact 行 completed_at=NULL 时 after 窗口随 done_at 用 started_at 兜底。"""
        con = make_db()
        sid = "s1"
        req(con, sid, 100, 200, 1000)
        req(con, sid, 300, 400, 1200)
        con.execute(
            "insert into model_usage(session_id, query_source, status, started_at,"
            " completed_at, input_tokens, output_tokens, cache_read_input_tokens,"
            " cache_creation_input_tokens, model_id) values(?,?,?,?,?,?,?,?,?,?)",
            (sid, "compact", "completed", 500, None, 2000, 3210, 0, 0, "glm-4.6"),
        )                                                # completed_at 缺失：done_at 兜底 started_at=500
        req(con, sid, 600, 700, 480)                     # 压缩后首条
        rec = ZUSAGE._session_compactions(con, [sid])[sid][0]
        self.assertEqual(rec["a"], 480, "completed_at 缺失不得让 after 窗口塌陷到 >0 取错首条")
        self.assertEqual(rec["ts"], 500)                 # ts 侧既有兜底（completed_at or started_at or 0）

    def test_non_main_turn_rows_never_pollute_boundaries(self):
        """v433 竞争场景锁：before/after 只取 main_turn——变异删掉 query_source 过滤时本例必红。"""
        con = make_db()
        sid = "s1"
        req(con, sid, 100, 200, 1000)
        req(con, sid, 300, 400, 1200)                                    # 压缩前末条 main_turn（=before）
        req(con, sid, 450, 470, 900, query_source="sub")                 # 竞争行：比 main_turn 更晚的非 main_turn（input>0）
        req(con, sid, 500, 900, 2000, query_source="compact")
        req(con, sid, 960, 980, 700, query_source="sub")                 # after 侧竞争行：早于真正的压缩后首条
        req(con, sid, 1000, 1100, 480)
        rec = ZUSAGE._session_compactions(con, [sid])[sid][0]
        self.assertEqual(rec["b"], 1200, "before 只取 main_turn（sub 行更晚也不得当选）")
        self.assertEqual(rec["a"], 480, "after 只取 main_turn（更早的 sub 行不得当选）")
        self.assertNotIn("alt", rec)

    def test_alt_model_when_compaction_model_differs(self):
        con = make_db()
        sid = "s1"
        req(con, sid, 100, 200, 1000)
        req(con, sid, 300, 400, 1200, model="glm-4.5-air")
        req(con, sid, 500, 900, 2000, query_source="compact", model="glm-4.5-air")
        req(con, sid, 1000, 1100, 480, model="glm-4.6")   # 会话已切回 glm-4.6
        rec = ZUSAGE._session_compactions(con, [sid])[sid][0]
        self.assertEqual(rec["alt"], "glm-4.5-air")      # 压缩执行者≠会话模型 → 带 alt
        # 压缩后无请求：无法比对，不产 alt
        con2 = make_db()
        req(con2, "s2", 100, 200, 1000, model="glm-4.5-air")
        req(con2, "s2", 500, 900, 2000, query_source="compact", model="glm-4.5-air")
        rec2 = ZUSAGE._session_compactions(con2, ["s2"])["s2"][0]
        self.assertNotIn("alt", rec2)
        self.assertNotIn("a", rec2)

    def test_ordering_matches_multiple_compactions(self):
        con = make_db()
        sid = "s2"
        req(con, sid, 100, 150, 900)
        req(con, sid, 200, 300, 1000, query_source="compact")
        req(con, sid, 400, 450, 400)
        req(con, sid, 500, 600, 800, query_source="compact")
        req(con, sid, 700, 750, 350)
        out = ZUSAGE._session_compactions(con, [sid])
        self.assertEqual([r["ts"] for r in out[sid]], [300, 600])
        self.assertEqual([(r["b"], r["a"]) for r in out[sid]], [(900, 400), (400, 350)])

    def test_sessions_without_compactions_omitted(self):
        con = make_db()
        req(con, "plain", 100, 200, 500)
        self.assertIsNone(ZUSAGE._session_compactions(con, ["plain"]))

    def test_unfinished_compaction_row_not_a_boundary(self):
        con = make_db()
        sid = "s3"
        req(con, sid, 100, 200, 900)
        req(con, sid, 300, 400, 1000, query_source="compact", status="failed")
        self.assertIsNone(ZUSAGE._session_compactions(con, [sid]))

    def test_before_after_absent_when_no_adjacent_turn(self):
        con = make_db()
        sid = "s4"
        req(con, sid, 500, 900, 2000, query_source="compact")
        out = ZUSAGE._session_compactions(con, [sid])
        # ts/out/dur 恒带，b/a/cr/cw 省略（消费端不拼数字段）
        self.assertEqual(out[sid], [{"ts": 900, "out": 10, "dur": 400}])

    def test_safe_wrapper_swallows_missing_table(self):
        con = sqlite3.connect(":memory:")
        self.assertIsNone(ZUSAGE._session_compactions_safe(con, ["s1"]))
        self.assertIsNone(ZUSAGE._session_compactions_safe(None, ["s1"]))
        self.assertIsNone(ZUSAGE._session_compactions_safe(con, []))


if __name__ == "__main__":
    unittest.main()
