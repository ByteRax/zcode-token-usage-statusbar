"""model_usage 水位延长聚合缓存（specs/perf-lag-reduction.md §8）。

宿主请求完成才一次性 INSERT，流式期间 model_usage 恒定：TTL 过期后若水位未变继续复用，
有新请求完成（水位变）立即重算；内存库/桩连接退回纯 TTL。
"""
import importlib.util
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("zusage_wm", ROOT / "zusage.py")
zusage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(zusage)

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


def _clear_caches():
    for name in ("_AGG_CACHE", "_AGG_WM", "_PROJ_CACHE", "_PROJ_WM", "_SPEED_CACHE", "_SPEED_WM"):
        getattr(zusage, name).clear()


class WatermarkCacheTests(unittest.TestCase):
    def setUp(self):
        _clear_caches()
        self.addCleanup(_clear_caches)
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        # 默认回归不得触碰个人配置/库：snapshot 路径会解析 ~/.zcode 下的配置，统一指向临时 HOME
        env = {k: v for k, v in os.environ.items() if not k.startswith("ZCODE_")}
        env.update(HOME=self.td.name, USERPROFILE=self.td.name)
        patcher = mock.patch.dict(os.environ, env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.con = sqlite3.connect(str(Path(self.td.name) / "db.sqlite"))
        self.addCleanup(self.con.close)
        self.con.row_factory = sqlite3.Row
        self.con.executescript(SCHEMA)
        self.con.execute(
            "insert into session (id, title, parent_id, project_id, directory, time_created)"
            " values ('s1','t',null,'proj','/w/p',100)")
        self.n = 0
        self.add_row()

    def add_row(self):
        self.n += 1
        self.con.execute(
            "insert into model_usage (id, session_id, turn_id, query_source, provider_id,"
            " model_id, status, started_at, first_token_at, completed_at, input_tokens,"
            " output_tokens, reasoning_tokens, cache_read_input_tokens,"
            " cache_creation_input_tokens, computed_total_tokens, tool_call_count, retry_count)"
            " values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            ("r%d" % self.n, "s1", "t%d" % self.n, "main_turn", "account:test", "GLM-5.3", "completed",
             1000, 1500, 3500, 60, 30, 5, 40, 2, 100, 1, 0))
        self.con.commit()

    @staticmethod
    def expire(cache, key, ms):
        ts, val = cache[key]
        cache[key] = (ts - ms, val)

    # ---- 水位本身 ----
    def test_watermark_changes_on_insert_and_is_none_for_memory_db(self):
        w1 = zusage._usage_watermark(self.con)
        self.assertIsNotNone(w1)
        self.add_row()
        w2 = zusage._usage_watermark(self.con)
        self.assertNotEqual(w1, w2)
        mem = sqlite3.connect(":memory:")
        self.addCleanup(mem.close)
        mem.executescript(SCHEMA)
        self.assertIsNone(zusage._usage_watermark(mem), "内存库无库身份：不做水位缓存")
        self.assertIsNone(zusage._usage_watermark(object()), "桩连接取不到水位：降级而非抛错")

    # ---- _cached_agg ----
    def test_agg_reuses_after_ttl_while_watermark_unchanged(self):
        calls = []
        fn = lambda: calls.append(1) or len(calls)
        self.assertEqual(zusage._cached_agg("k", zusage._WmFn(fn, self.con)), 1)
        self.expire(zusage._AGG_CACHE, "k", zusage._AGG_TTL_MS + 1)
        self.assertEqual(zusage._cached_agg("k", zusage._WmFn(fn, self.con)), 1, "TTL 过期但水位未变：复用")
        self.assertEqual(len(calls), 1)

    def test_agg_recomputes_when_new_request_completes(self):
        calls = []
        fn = lambda: calls.append(1) or len(calls)
        zusage._cached_agg("k", zusage._WmFn(fn, self.con))
        self.expire(zusage._AGG_CACHE, "k", zusage._AGG_TTL_MS + 1)
        self.add_row()
        self.assertEqual(zusage._cached_agg("k", zusage._WmFn(fn, self.con)), 2, "水位变：立即重算")

    def test_agg_recomputes_after_max_age_even_if_watermark_unchanged(self):
        # 兜底上限须是「有限的几十秒」量级：既大于 TTL（否则水位延长无意义），又不能被改成近似无限
        self.assertGreater(zusage._WM_MAX_AGE_MS, zusage._AGG_TTL_MS)
        self.assertLessEqual(zusage._WM_MAX_AGE_MS, 30 * 1000)
        calls = []
        fn = lambda: calls.append(1) or len(calls)
        zusage._cached_agg("k", zusage._WmFn(fn, self.con))
        self.expire(zusage._AGG_CACHE, "k", zusage._WM_MAX_AGE_MS + 1)
        self.assertEqual(zusage._cached_agg("k", zusage._WmFn(fn, self.con)), 2, "兜底：超过 _WM_MAX_AGE_MS 必重算")

    def test_within_ttl_hits_never_query_the_watermark(self):
        """TTL 内命中不得查水位（不碰库）：三条缓存各验一次——名副其实的『TTL 内行为不变』。"""
        calls = []
        fn = lambda: calls.append(1) or len(calls)
        dbkey = zusage._db_cache_key(self.con)
        pkey = ("proj", "/w/p", False)
        zusage._cached_agg("k", zusage._WmFn(fn, self.con))
        zusage._cached_project(dbkey, pkey, fn, self.con)
        zusage._speed_history_cached(self.con, "s1")
        self.add_row()
        boom = mock.patch.object(zusage, "_usage_watermark", side_effect=AssertionError("TTL 内不得查水位"))
        with boom:
            self.assertEqual(zusage._cached_agg("k", zusage._WmFn(fn, self.con)), 1)
            self.assertEqual(zusage._cached_project(dbkey, pkey, fn, self.con), 2)
            zusage._speed_history_cached(self.con, "s1")

    def test_agg_without_connection_or_with_memory_db_is_pure_ttl(self):
        calls = []
        fn = lambda: calls.append(1) or len(calls)
        zusage._cached_agg("a", fn)
        self.expire(zusage._AGG_CACHE, "a", zusage._AGG_TTL_MS + 1)
        self.assertEqual(zusage._cached_agg("a", fn), 2, "不传 con：纯 TTL")
        mem = sqlite3.connect(":memory:")
        self.addCleanup(mem.close)
        mem.executescript(SCHEMA)
        zusage._cached_agg("m", zusage._WmFn(fn, mem))
        self.expire(zusage._AGG_CACHE, "m", zusage._AGG_TTL_MS + 1)
        self.assertEqual(zusage._cached_agg("m", zusage._WmFn(fn, mem)), 4, "内存库：纯 TTL")

    def test_watermark_is_read_before_compute_so_concurrent_insert_forces_recompute(self):
        """fn 执行期间库里新增一行：存下的水位是计算前的，下一帧必须重算而不是把旧结果当最新。"""
        calls = []

        def fn():
            calls.append(1)
            if len(calls) == 1:
                self.add_row()     # 模拟计算期间宿主完成了新请求
            return len(calls)

        zusage._cached_agg("k", zusage._WmFn(fn, self.con))
        self.expire(zusage._AGG_CACHE, "k", zusage._AGG_TTL_MS + 1)
        self.assertEqual(zusage._cached_agg("k", zusage._WmFn(fn, self.con)), 2)

    # ---- _cached_project ----
    def test_project_cache_reuses_until_watermark_changes(self):
        dbkey = zusage._db_cache_key(self.con)
        key = ("proj", "/w/p", False)
        full = (dbkey, key)
        calls = []
        fn = lambda: calls.append(1) or len(calls)
        self.assertEqual(zusage._cached_project(dbkey, key, fn, self.con), 1)
        self.expire(zusage._PROJ_CACHE, full, zusage._AGG_TTL_MS + 1)
        self.assertEqual(zusage._cached_project(dbkey, key, fn, self.con), 1)
        self.expire(zusage._PROJ_CACHE, full, 1)
        self.add_row()
        self.assertEqual(zusage._cached_project(dbkey, key, fn, self.con), 2)

    def test_project_usage_end_to_end_picks_up_new_request_after_ttl(self):
        """真聚合路径：流式期间复用，完成新请求后 TTL 一过立即反映（不等 _WM_MAX_AGE_MS）。"""
        p1 = zusage._project_usage(self.con, "s1")
        self.assertEqual(p1["requests"], 1)
        dbkey = zusage._db_cache_key(self.con)
        full = next(k for k in zusage._PROJ_CACHE if k[0] == dbkey)
        self.expire(zusage._PROJ_CACHE, full, zusage._AGG_TTL_MS + 1)
        self.assertEqual(zusage._project_usage(self.con, "s1")["requests"], 1, "水位未变：复用")
        self.add_row()
        self.expire(zusage._PROJ_CACHE, full, 1)
        self.assertEqual(zusage._project_usage(self.con, "s1")["requests"], 2, "水位变：重算")

    # ---- speed_history ----
    def test_speed_history_cached_reuses_until_watermark_changes(self):
        calls = []
        real = zusage._speed_history

        def counting(con, sid=""):
            calls.append(1)
            return real(con, sid)

        zusage._speed_history = counting
        self.addCleanup(setattr, zusage, "_speed_history", real)
        key = zusage._db_cache_key(self.con)
        h1 = zusage._speed_history_cached(self.con, "s1")
        self.expire(zusage._SPEED_CACHE, key, zusage._SPEED_HISTORY_TTL_MS + 1)
        h2 = zusage._speed_history_cached(self.con, "s1")
        self.assertIs(h1, h2, "水位未变：返回同一缓存对象（流式期间不重扫全库）")
        self.assertEqual(len(calls), 1)
        self.add_row()
        self.expire(zusage._SPEED_CACHE, key, 1)
        h3 = zusage._speed_history_cached(self.con, "s1")
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(h3["turns"]), len(h1["turns"]) + 1)
        self.expire(zusage._SPEED_CACHE, key, zusage._WM_MAX_AGE_MS + 1)
        zusage._speed_history_cached(self.con, "s1")
        self.assertEqual(len(calls), 3, "超过 _WM_MAX_AGE_MS 兜底重算")

    def test_cache_dicts_stay_bounded(self):
        for i in range(20):
            zusage._cached_agg(("k", i), zusage._WmFn(lambda: 1, self.con))
        self.assertLessEqual(len(zusage._AGG_CACHE), 9)
        self.assertLessEqual(len(zusage._AGG_WM), 9)

    # ---- 评审补强：三条缓存的水位读取顺序 / 清空同步 / 水位缺失时丢弃 / _WmFn 接线 ----
    def test_project_cache_reads_watermark_before_compute(self):
        dbkey = zusage._db_cache_key(self.con)
        key = ("proj", "/w/p", False)
        full = (dbkey, key)
        calls = []

        def fn():
            calls.append(1)
            if len(calls) == 1:
                self.add_row()     # 计算期间宿主完成新请求
            return len(calls)

        zusage._cached_project(dbkey, key, fn, self.con)
        self.expire(zusage._PROJ_CACHE, full, zusage._AGG_TTL_MS + 1)
        self.assertEqual(zusage._cached_project(dbkey, key, fn, self.con), 2)

    def test_speed_history_cache_reads_watermark_before_compute(self):
        calls = []
        real = zusage._speed_history

        def racing(con, sid=""):
            calls.append(1)
            if len(calls) == 1:
                self.add_row()
            return real(con, sid)

        zusage._speed_history = racing
        self.addCleanup(setattr, zusage, "_speed_history", real)
        key = zusage._db_cache_key(self.con)
        zusage._speed_history_cached(self.con, "s1")
        self.expire(zusage._SPEED_CACHE, key, zusage._SPEED_HISTORY_TTL_MS + 1)
        zusage._speed_history_cached(self.con, "s1")
        self.assertEqual(len(calls), 2, "计算期间的新写入使存下的水位偏旧，下一帧必须重算")

    def test_watermark_dicts_never_keep_orphans_when_caches_overflow(self):
        """缓存超上限整体 clear 时水位字典必须同步清空（否则残留水位与新值错配）。"""
        for i in range(12):
            zusage._cached_agg(("k", i), zusage._WmFn(lambda: 1, self.con))
        self.assertLessEqual(len(zusage._AGG_CACHE), 9)
        self.assertTrue(set(zusage._AGG_WM) <= set(zusage._AGG_CACHE))
        dbkey = zusage._db_cache_key(self.con)
        for i in range(70):
            zusage._cached_project(dbkey, ("p", i), lambda: 1, self.con)
        self.assertLessEqual(len(zusage._PROJ_CACHE), 65)
        self.assertTrue(set(zusage._PROJ_WM) <= set(zusage._PROJ_CACHE))
        for i in range(7):   # 每个库文件一个键，超过 4 个触发 clear
            con = sqlite3.connect(str(Path(self.td.name) / ("speed%d.sqlite" % i)))
            self.addCleanup(con.close)
            con.row_factory = sqlite3.Row
            con.executescript(SCHEMA)
            con.execute("insert into session (id, title, project_id, directory, time_created)"
                        " values ('s','t','p','/d',1)")
            con.commit()
            zusage._speed_history_cached(con, "s")
        self.assertLessEqual(len(zusage._SPEED_CACHE), 5)
        self.assertTrue(set(zusage._SPEED_WM) <= set(zusage._SPEED_CACHE))

    def test_watermark_entry_is_dropped_when_watermark_becomes_unavailable(self):
        """重算时取不到水位（内存库/桩连接/查询失败）：旧水位必须丢弃，不能残留去给陈旧值续命。"""
        mem = sqlite3.connect(":memory:")
        self.addCleanup(mem.close)
        mem.executescript(SCHEMA)
        fn = lambda: 1
        zusage._cached_agg("k", zusage._WmFn(fn, self.con))
        self.assertIn("k", zusage._AGG_WM)
        self.expire(zusage._AGG_CACHE, "k", zusage._AGG_TTL_MS + 1)
        zusage._cached_agg("k", zusage._WmFn(fn, mem))
        self.assertNotIn("k", zusage._AGG_WM)
        dbkey = zusage._db_cache_key(self.con)
        key = ("proj", "/w/p", False)
        full = (dbkey, key)
        zusage._cached_project(dbkey, key, fn, self.con)
        self.assertIn(full, zusage._PROJ_WM)
        self.expire(zusage._PROJ_CACHE, full, zusage._AGG_TTL_MS + 1)
        zusage._cached_project(dbkey, key, fn, None)
        self.assertNotIn(full, zusage._PROJ_WM)
        zusage._speed_history_cached(self.con, "s1")
        skey = dbkey
        self.assertIn(skey, zusage._SPEED_WM)
        self.expire(zusage._SPEED_CACHE, skey, zusage._SPEED_HISTORY_TTL_MS + 1)
        real = zusage._usage_watermark
        zusage._usage_watermark = lambda con: None
        self.addCleanup(setattr, zusage, "_usage_watermark", real)
        zusage._speed_history_cached(self.con, "s1")
        self.assertNotIn(skey, zusage._SPEED_WM)

    def test_scan_session_ids_is_wired_to_the_watermark(self):
        rows1 = zusage._scan_session_ids(self.con)
        self.expire(zusage._AGG_CACHE, "scan", zusage._AGG_TTL_MS + 1)
        self.assertIs(zusage._scan_session_ids(self.con), rows1, "水位未变：TTL 过期后复用")
        self.add_row()
        self.expire(zusage._AGG_CACHE, "scan", 1)
        self.assertIsNot(zusage._scan_session_ids(self.con), rows1, "新请求完成：立即重算")

    def test_snapshot_passes_the_connection_to_the_today_caches(self):
        """snapshot 里的 scan / today / todayrate / todaydetail 都必须经 _WmFn 带上连接，否则水位延长静默失效。"""
        seen = {}

        def recorder(key, fn):
            seen[key if isinstance(key, str) else key[0]] = getattr(fn, "wm_con", None)
            return fn()

        with mock.patch.object(zusage, "_cached_agg", side_effect=recorder), \
             mock.patch.object(zusage, "load_config", return_value={"context_window": 200000}), \
             mock.patch.object(zusage, "_remote_setup", return_value=None):
            zusage.snapshot(serve_con=self.con)
        for name in ("scan", "today", "todayrate", "todaydetail"):
            self.assertIn(name, seen, name)
            self.assertIs(seen[name], self.con, "%s 未携带连接：水位延长缓存对它失效" % name)

    def test_watermark_carries_database_identity(self):
        """_AGG_CACHE 的键不含库身份，水位里的 dbkey 是换库时的唯一防线：两库 max(rowid) 相同也不得互用缓存。"""
        other = sqlite3.connect(str(Path(self.td.name) / "other.sqlite"))
        self.addCleanup(other.close)
        other.row_factory = sqlite3.Row
        other.executescript(SCHEMA)
        other.execute(
            "insert into model_usage (id, session_id, turn_id, query_source, provider_id, model_id, status,"
            " started_at, completed_at) values ('x','s','t','main_turn','p','m','completed',1,2)")
        other.commit()
        self.assertEqual(self.con.execute("select max(rowid) from model_usage").fetchone()[0],
                         other.execute("select max(rowid) from model_usage").fetchone()[0], "夹具前提：两库 max(rowid) 相同")
        calls = []
        fn = lambda: calls.append(1) or len(calls)
        zusage._cached_agg("k", zusage._WmFn(fn, self.con))
        self.expire(zusage._AGG_CACHE, "k", zusage._AGG_TTL_MS + 1)
        self.assertEqual(zusage._cached_agg("k", zusage._WmFn(fn, other)), 2, "换库：水位含 dbkey，必须重算")

    def _insert_raw(self, rid):
        self.con.execute(
            "insert into model_usage (id, session_id, turn_id, query_source, provider_id, model_id, status,"
            " started_at, completed_at) values (?,?,?,?,?,?,?,?,?)",
            (rid, "s1", "tx" + rid, "main_turn", "account:test", "GLM-5.3", "completed", 1000, 3500))
        self.con.commit()

    def test_watermark_follows_rowid_not_id_or_row_count(self):
        """水位必须是 max(rowid)：id 是文本主键、不随插入顺序单调；删一行再插一行行数不变也必须变。"""
        w0 = zusage._usage_watermark(self.con)
        self._insert_raw("!low")                       # id 字典序小于既有 r1：max(id) 不变，max(rowid) 必变
        w1 = zusage._usage_watermark(self.con)
        self.assertNotEqual(w1, w0, "新行 id 小于既有 id 时水位仍必须变化（不能是 max(id)）")
        self.con.execute("delete from model_usage where id = 'r1'")
        self.con.commit()
        self._insert_raw("zz-new")                     # 行数不变（删 1 插 1）：count(*) 不变，max(rowid) 必变
        w2 = zusage._usage_watermark(self.con)
        self.assertNotEqual(w2, w1, "删一行再插一行行数不变时水位仍必须变化（不能是 count(*)）")

    def test_watermark_query_failure_degrades_to_pure_ttl(self):
        """max(rowid) 查询本身抛 sqlite3.Error（如表缺失/列漂移）：返回 None，缓存退回纯 TTL 而不抛。"""
        bare = sqlite3.connect(str(Path(self.td.name) / "bare.sqlite"))
        self.addCleanup(bare.close)
        bare.execute("create table session (id text primary key)")
        bare.commit()                                   # 文件库（有 dbkey）但没有 model_usage 表
        self.assertIsNone(zusage._usage_watermark(bare))
        calls = []
        fn = lambda: calls.append(1) or len(calls)
        self.assertEqual(zusage._cached_agg("k", zusage._WmFn(fn, bare)), 1)
        self.expire(zusage._AGG_CACHE, "k", zusage._AGG_TTL_MS + 1)
        self.assertEqual(zusage._cached_agg("k", zusage._WmFn(fn, bare)), 2, "取不到水位：TTL 过期即重算")

    # ---- 第 4 轮：重算之后存下的必须是『新水位』，否则复用永久失效（静默退化为纯 TTL，数据不错但治理收益丢失）----
    def test_agg_keeps_reusing_after_a_recompute(self):
        calls = []
        fn = lambda: calls.append(1) or len(calls)
        zusage._cached_agg("k", zusage._WmFn(fn, self.con))                      # 计算 #1
        self.expire(zusage._AGG_CACHE, "k", zusage._AGG_TTL_MS + 1)
        self.add_row()
        self.assertEqual(zusage._cached_agg("k", zusage._WmFn(fn, self.con)), 2)   # 水位变：重算 #2，须存下新水位
        self.expire(zusage._AGG_CACHE, "k", zusage._AGG_TTL_MS + 1)
        self.assertEqual(zusage._cached_agg("k", zusage._WmFn(fn, self.con)), 2, "重算后水位未再变：继续复用，不得再算")
        self.assertEqual(len(calls), 2)

    def test_project_keeps_reusing_after_a_recompute(self):
        dbkey = zusage._db_cache_key(self.con)
        key = ("proj", "/w/p", False)
        full = (dbkey, key)
        calls = []
        fn = lambda: calls.append(1) or len(calls)
        zusage._cached_project(dbkey, key, fn, self.con)
        self.expire(zusage._PROJ_CACHE, full, zusage._AGG_TTL_MS + 1)
        self.add_row()
        self.assertEqual(zusage._cached_project(dbkey, key, fn, self.con), 2)
        self.expire(zusage._PROJ_CACHE, full, zusage._AGG_TTL_MS + 1)
        self.assertEqual(zusage._cached_project(dbkey, key, fn, self.con), 2)
        self.assertEqual(len(calls), 2)

    def test_speed_history_keeps_reusing_after_a_recompute(self):
        calls = []
        real = zusage._speed_history

        def counting(con, sid=""):
            calls.append(1)
            return real(con, sid)

        zusage._speed_history = counting
        self.addCleanup(setattr, zusage, "_speed_history", real)
        key = zusage._db_cache_key(self.con)
        zusage._speed_history_cached(self.con, "s1")
        self.expire(zusage._SPEED_CACHE, key, zusage._SPEED_HISTORY_TTL_MS + 1)
        self.add_row()
        zusage._speed_history_cached(self.con, "s1")                              # 水位变：重算，须存下新水位
        self.expire(zusage._SPEED_CACHE, key, zusage._SPEED_HISTORY_TTL_MS + 1)
        zusage._speed_history_cached(self.con, "s1")
        self.assertEqual(len(calls), 2, "重算后水位未再变：继续复用")

    def test_empty_speed_history_is_not_extended_by_the_watermark(self):
        """空轮表可能是查询降级的结果：不享受水位延长，TTL 一过就重试（与改动前的 2s 重试语义一致）。"""
        calls = []

        def empty(con, sid=""):
            calls.append(1)
            return {"turns": [], "sids": [], "snames": [], "pids": [], "mnames": [], "truncated": False}

        real = zusage._speed_history
        zusage._speed_history = empty
        self.addCleanup(setattr, zusage, "_speed_history", real)
        key = zusage._db_cache_key(self.con)
        zusage._speed_history_cached(self.con, "s1")
        self.assertNotIn(key, zusage._SPEED_WM)
        self.expire(zusage._SPEED_CACHE, key, zusage._SPEED_HISTORY_TTL_MS + 1)
        zusage._speed_history_cached(self.con, "s1")
        self.assertEqual(len(calls), 2, "空轮表：TTL 过期即重试，不因水位未变而续用")

    # ---- 冻结时钟下的确定性边界（TTL 用 `<`，兜底上限用 `>=`）----
    FROZEN = 1_800_000_000.0   # 秒

    def _prime_at(self, kind, age_ms):
        """在『当前冻结时刻 - age_ms』建立缓存条目，返回 (调用函数, 调用计数)。"""
        dbkey = zusage._db_cache_key(self.con)
        pkey = ("proj", "/w/p", False)
        calls = []
        if kind == "agg":
            fn = lambda: calls.append(1) or len(calls)
            call = lambda: zusage._cached_agg("k", zusage._WmFn(fn, self.con))
        elif kind == "project":
            fn = lambda: calls.append(1) or len(calls)
            call = lambda: zusage._cached_project(dbkey, pkey, fn, self.con)
        else:
            real = zusage._speed_history

            def counting(con, sid=""):
                calls.append(1)
                return real(con, sid)

            zusage._speed_history = counting
            self.addCleanup(setattr, zusage, "_speed_history", real)
            call = lambda: zusage._speed_history_cached(self.con, "s1")
        with mock.patch.object(zusage.time, "time", return_value=self.FROZEN - age_ms / 1000.0):
            call()
        return call, calls

    def test_ttl_boundary_is_exclusive_for_all_three_caches(self):
        """恰好经过一个 TTL 即视为过期（`<` 而非 `<=`）：此时水位若已变必须重算，不得当作 TTL 命中。"""
        for kind, ttl in (("agg", zusage._AGG_TTL_MS), ("project", zusage._AGG_TTL_MS),
                          ("speed", zusage._SPEED_HISTORY_TTL_MS)):
            with self.subTest(kind=kind):
                _clear_caches()
                call, calls = self._prime_at(kind, ttl)
                self.assertEqual(len(calls), 1)
                self.add_row()                                    # 水位变
                with mock.patch.object(zusage.time, "time", return_value=self.FROZEN):
                    call()
                self.assertEqual(len(calls), 2, "%s：恰过 TTL 且水位已变，必须重算" % kind)
                _clear_caches()
                call, calls = self._prime_at(kind, ttl - 1)       # 差 1ms：仍在 TTL 内
                self.add_row()
                with mock.patch.object(zusage.time, "time", return_value=self.FROZEN):
                    call()
                self.assertEqual(len(calls), 1, "%s：TTL 内（差 1ms）即使水位已变也命中（TTL 内行为不变）" % kind)

    def test_max_age_boundary_is_inclusive_for_all_three_caches(self):
        """水位未变时：存活满 _WM_MAX_AGE_MS 恰好即兜底重算（`>=`），差 1ms 仍复用。"""
        for kind in ("agg", "project", "speed"):
            with self.subTest(kind=kind):
                _clear_caches()
                call, calls = self._prime_at(kind, zusage._WM_MAX_AGE_MS)
                with mock.patch.object(zusage.time, "time", return_value=self.FROZEN):
                    call()
                self.assertEqual(len(calls), 2, "%s：恰满兜底上限必须重算" % kind)
                _clear_caches()
                call, calls = self._prime_at(kind, zusage._WM_MAX_AGE_MS - 1)
                with mock.patch.object(zusage.time, "time", return_value=self.FROZEN):
                    call()
                self.assertEqual(len(calls), 1, "%s：差 1ms 水位未变仍复用" % kind)


if __name__ == "__main__":
    unittest.main()
