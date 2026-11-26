# -*- coding: utf-8 -*-
"""scripts/model_load.py 的行为测试：临时用量库造数，核对阈值、默认模型判定与命令行退出码。

阈值与 specs/review-agent-concurrency.md 一致（可同轮并发：默认模型子代理 ≥5 条且等首字中位 <5 秒；
拥挤：主会话限流比例 ≥20%）。不碰真实用量库。
"""
import contextlib
import io
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

from helpers.py_test_support import load_module

ROOT = Path(__file__).resolve().parents[1]
model_load = load_module("model_load_under_test", ROOT / "scripts" / "model_load.py")

MAIN = "sess_main-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
OTHER_MAIN = "sess_main-11111111-2222-3333-4444-555555555555"


def _sub(n):
    return "sess_subagent_agent_%032d" % n


def _row(session, model, started_ms, wait_s=None, retry=0, source="main_turn", status="completed"):
    first = None if wait_s is None else int(started_ms + wait_s * 1000)
    return (session, model, source, int(started_ms), first, retry, status)


class ModelLoadSummarizeTests(unittest.TestCase):
    def _summarize(self, rows):
        base = 1_800_000_000_000
        return model_load.summarize([dict(zip(model_load._COLUMNS, r)) for r in rows], base, base + 30 * 60 * 1000)

    def test_one_limited_in_five_main_requests_is_busy(self):
        base = 1_800_000_000_000
        rows = [_row(MAIN, "M-A", base + i * 1000, wait_s=2, retry=1 if i == 0 else 0) for i in range(5)]
        summary = self._summarize(rows)
        self.assertEqual((summary["main"], summary["limited"]), (5, 1))
        self.assertTrue(summary["busy"], "限流比例 20% 应判拥挤")
        self.assertIn("拥挤", model_load.verdict(summary))

    def test_below_threshold_is_not_busy(self):
        base = 1_800_000_000_000
        rows = [_row(MAIN, "M-A", base + i * 1000, wait_s=2, retry=1 if i < 3 else 0) for i in range(20)]
        summary = self._summarize(rows)
        self.assertFalse(summary["busy"], "限流比例 15% 不应判拥挤")

    def test_concurrent_requires_enough_fast_subagent_requests(self):
        base = 1_800_000_000_000
        head = [_row(MAIN, "M-A", base + i, wait_s=2) for i in range(3)]

        fast = [_row(_sub(i), "M-A", base + 10_000 + i * 1000, wait_s=2) for i in range(5)]
        self.assertTrue(self._summarize(head + fast)["concurrent"], "5 条且中位 2 秒：可同轮并发")

        few = [_row(_sub(i), "M-A", base + 10_000 + i * 1000, wait_s=2) for i in range(4)]
        self.assertFalse(self._summarize(head + few)["concurrent"], "4 条：条数不足")

        slow = [_row(_sub(i), "M-A", base + 10_000 + i * 1000, wait_s=8) for i in range(9)]
        summary = self._summarize(head + slow)
        self.assertFalse(summary["concurrent"], "9 条但中位 8 秒：不通畅")
        self.assertEqual(summary["own_wait_median"], 8.0)
        self.assertIn("逐路派发", model_load.verdict(summary))

    def test_default_model_is_the_busiest_main_model(self):
        base = 1_800_000_000_000
        rows = ([_row(MAIN, "M-A", base + i, wait_s=1) for i in range(3)]
                + [_row(OTHER_MAIN, "M-B", base + 9, wait_s=1)]
                + [_row(_sub(1), "M-A", base + 20_000, wait_s=6), _row(_sub(2), "M-FLASH", base + 20_001, wait_s=1.5)])
        summary = self._summarize(rows)
        self.assertEqual(summary["default_model"], "M-A")
        self.assertEqual((summary["own"], summary["other"]), (1, 1))
        self.assertEqual((summary["own_wait_median"], summary["other_wait_median"]), (6.0, 1.5))

    def test_auxiliary_requests_are_not_main_turns(self):
        base = 1_800_000_000_000
        rows = [_row(MAIN, "M-A", base, wait_s=1), _row(MAIN, "M-A", base + 5, wait_s=1, source="session_title")]
        summary = self._summarize(rows)
        self.assertEqual(summary["main"], 1, "标题生成这类后台小请求不算主会话请求")

    def test_null_query_source_counts_as_main_turn(self):
        # 仓库统一口径（zusage.py 全部查询）：query_source is null or 'main_turn'
        base = 1_800_000_000_000
        rows = [_row(MAIN, "M-A", base, wait_s=1, source=None), _row(MAIN, "M-A", base + 5, wait_s=1)]
        summary = self._summarize(rows)
        self.assertEqual(summary["main"], 2, "query_source 为 NULL 的行视同 main_turn")
        self.assertEqual(summary["default_model"], "M-A")

    def test_summarize_does_not_filter_status_filtering_lives_in_load_rows(self):
        # summarize 收到什么算什么；status 过滤由 load_rows 的 SQL 负责（有端到端用例锁）
        base = 1_800_000_000_000
        rows = [_row(MAIN, "M-A", base, wait_s=1), _row(MAIN, "M-A", base + 5, wait_s=1, status="cancelled")]
        summary = self._summarize(rows)
        self.assertEqual(summary["main"], 2)

    def test_no_main_requests_is_undecidable(self):
        base = 1_800_000_000_000
        summary = self._summarize([_row(_sub(1), "M-A", base, wait_s=1)])
        self.assertIsNone(summary["default_model"])
        self.assertIsNone(summary["ratio"])
        self.assertFalse(summary["busy"])
        self.assertFalse(summary["concurrent"])
        self.assertTrue(model_load.verdict(summary).startswith("无法判定"))
        self.assertIn("主会话：窗口内没有请求", model_load.format_report(summary))

    def test_requests_without_first_token_are_counted_but_not_in_median(self):
        base = 1_800_000_000_000
        rows = [_row(_sub(i), "M-A", base + i, wait_s=2) for i in range(5)] + [_row(_sub(9), "M-A", base + 99)]
        summary = self._summarize([_row(MAIN, "M-A", base, wait_s=1)] + rows)
        self.assertEqual(summary["own"], 6)
        self.assertEqual(summary["own_wait_median"], 2.0)

    def test_buckets_are_ten_minute_cells_and_skip_empty_ones(self):
        base = 1_800_000_000_000
        base -= base % model_load.BUCKET_MS          # 对齐到 10 分钟边界
        rows = ([_row(MAIN, "M-A", base + 60_000, wait_s=1), _row(MAIN, "M-A", base + 90_000, wait_s=1, retry=1)]
                + [_row(_sub(1), "M-A", base + 12 * 60_000, wait_s=3)])
        buckets = model_load.summarize([dict(zip(model_load._COLUMNS, r)) for r in rows], base, base + 30 * 60_1000)["buckets"]
        self.assertEqual(len(buckets), 2, "有请求的两个 10 分钟格各一行，空格不列")
        self.assertEqual((buckets[0]["begin"], buckets[0]["main"], buckets[0]["limited"]), (base, 2, 1))
        self.assertEqual((buckets[1]["sub"], buckets[1]["sub_wait_median"]), (1, 3.0))


class ModelLoadCliTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db = Path(self._tmp.name) / "db.sqlite"

    def _make_db(self):
        con = sqlite3.connect(self.db)
        con.execute("create table model_usage (session_id text, model_id text, query_source text,"
                    " started_at integer, first_token_at integer, retry_count integer, status text)")
        con.commit()
        con.close()

    def _insert(self, rows):
        con = sqlite3.connect(self.db)
        con.executemany("insert into model_usage values (?, ?, ?, ?, ?, ?, ?)", rows)
        con.commit()
        con.close()

    def _run(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = model_load.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_missing_database_exits_non_zero_without_a_report(self):
        code, out, err = self._run("--db", str(self.db))
        self.assertEqual(code, 2)
        self.assertEqual(out, "", "读不了库就不输出半份结论")
        self.assertIn("读不了用量库", err)

    def test_cli_reads_the_requested_window(self):
        self._make_db()
        now = time.time() * 1000
        self._insert([_row(MAIN, "M-A", now - 5 * 60_000, wait_s=2),
                      _row(MAIN, "M-A", now - 45 * 60_000, wait_s=2),
                      _row(_sub(1), "M-A", now - 6 * 60_000, wait_s=3)])
        code, out, _ = self._run("--db", str(self.db), "--minutes", "30")
        self.assertEqual(code, 0)
        self.assertIn("近 30 分钟", out)
        self.assertIn("主会话：请求 1 次，被限流 0 次（0%）", out, "窗口外（45 分钟前）的请求不计入")
        self.assertIn("默认模型子代理：请求 1 条", out)
        self.assertTrue(out.rstrip().splitlines()[-1].startswith("结论："), out)

    def test_cli_counts_null_source_and_excludes_non_completed(self):
        # 端到端锁两个口径：NULL query_source 视同 main_turn；只有 status='completed' 进统计
        self._make_db()
        now = time.time() * 1000
        self._insert([_row(MAIN, "M-A", now - 60_000, wait_s=2, source=None),
                      _row(MAIN, "M-A", now - 50_000, retry=3, status="running"),
                      _row(MAIN, "M-A", now - 40_000, retry=2, status="cancelled")])
        code, out, _ = self._run("--db", str(self.db), "--minutes", "30")
        self.assertEqual(code, 0)
        self.assertIn("主会话：请求 1 次，被限流 0 次（0%）", out,
                      "running/cancelled 的行不进统计：若被计入会是 3 次、限流 2 次")
        self.assertIn("结论：不拥挤", out)
        self.assertIn("逐路派发", out)

    def test_cli_opens_the_database_read_only(self):
        self._make_db()
        before = self.db.read_bytes()
        self.assertEqual(self._run("--db", str(self.db))[0], 0)
        self.assertEqual(self.db.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
