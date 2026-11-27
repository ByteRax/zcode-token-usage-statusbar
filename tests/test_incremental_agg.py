import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta
from unittest import mock

import zusage


def setUpModule():
    if zusage._pricing is not None:
        zusage._pricing.start_refresh = lambda *a, **k: None


def _anchor(now_ms, seconds, span_ms=10_000):
    """now 之前 seconds 秒的夹具锚点，并保证 [t0, t0+span] 整段落在同一个本地日内：「今天」用量的断言不能
    因为跑在零点前后而变红。锚点前 60 秒贴着日界时，夹具行（最远 +9.2 秒）会跨到次日、today 桶只数到一部分，
    这时把锚点挪回前一天。夹具行永远落在过去，不会被 _speed_days 当成未来时间戳丢掉。"""
    t0 = now_ms - seconds * 1000
    day = zusage._day_start(datetime.fromtimestamp(t0 / 1000.0))
    day_end_ms = zusage._epoch_ms(day + timedelta(days=1))
    if t0 + span_ms >= day_end_ms:
        t0 = day_end_ms - max(span_ms, seconds * 1000) - 1000
    return t0


def _make_db(path):
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.executescript(
        """
        CREATE TABLE session (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            directory TEXT,
            parent_id TEXT,
            title TEXT
        );
        CREATE TABLE model_usage (
            id TEXT PRIMARY KEY,
            session_id TEXT,
            turn_id TEXT,
            model_id TEXT,
            provider_id TEXT,
            status TEXT,
            query_source TEXT,
            input_tokens INTEGER,
            output_tokens INTEGER,
            reasoning_tokens INTEGER,
            cache_read_input_tokens INTEGER,
            cache_creation_input_tokens INTEGER,
            computed_total_tokens INTEGER,
            tool_call_count INTEGER,
            retry_count INTEGER,
            duration_ms INTEGER,
            time_to_first_token_ms INTEGER,
            started_at INTEGER,
            first_token_at INTEGER,
            completed_at INTEGER
        );
        """
    )
    return con


def _insert_usage(con, uid, sid, tid, model="glm-4.5", prov="account:glm",
                  qs="main_turn", inp=1000, outp=200, cr=500, cw=50,
                  st=1000, ft=1200, ct=3200, tc=1, ret=0, status="completed"):
    con.execute(
        """INSERT INTO model_usage (
            id, session_id, turn_id, model_id, provider_id, status, query_source,
            input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens,
            cache_creation_input_tokens, computed_total_tokens, tool_call_count,
            retry_count, duration_ms, time_to_first_token_ms, started_at,
            first_token_at, completed_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (uid, sid, tid, model, prov, status, qs, inp, outp, 0, cr, cw,
         inp + outp, tc, ret, ct - st, ft - st, st, ft, ct),
    )
    con.commit()


def _unpack_sd(sd):
    mkeys = sd["mkeys"]
    out = []
    for b in sd["days"]:
        if b[2] == 0:
            continue
        msl = b[5]
        models = {}
        for i in range(0, len(msl), 5):
            models[mkeys[msl[i]]] = msl[i + 1:i + 5]
        out.append((b[:5], models, b[6] if len(b) > 6 else None))
    return sd["truncated"], out


class IncrementalAggTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db_path = os.path.join(self.tmp.name, "db.sqlite")
        self.con = _make_db(self.db_path)
        self.addCleanup(self.con.close)
        for name in ("_AGG_CACHE", "_AGG_WM", "_PROJ_CACHE", "_PROJ_WM",
                     "_SPEED_CACHE", "_SPEED_WM", "_DAYS_CACHE", "_DAYS_WM",
                     "_INCR_STATES"):
            getattr(zusage, name).clear()
        zusage._COVERS_CACHE.update(ts=0.0, set=frozenset())

    def _clear_outer_caches(self):
        for name in ("_AGG_CACHE", "_AGG_WM", "_PROJ_CACHE", "_PROJ_WM",
                     "_SPEED_CACHE", "_SPEED_WM", "_DAYS_CACHE", "_DAYS_WM"):
            getattr(zusage, name).clear()

    def _snapshot_all(self, now_ms, anchor_ms=None):
        # 「今天」的窗口按夹具行所在的本地日算（日界与产品 _day_start 同款），不按测试机此刻的日期：
        # 零点后一分钟内跑时锚点已是昨天，按此刻取日界 today 桶恒空
        day = zusage._day_start(datetime.fromtimestamp((anchor_ms if anchor_ms is not None else now_ms) / 1000.0))
        s_ms, e_ms = zusage._epoch_ms(day), zusage._epoch_ms(day + timedelta(days=1))
        return {
            "scan": sorted(tuple(r) for r in zusage._scan_session_ids(self.con)),
            "fbk": zusage._provider_fallback_uncached(self.con),
            "today": tuple(zusage._today_usage(self.con, s_ms, e_ms)),
            "ap": zusage._all_projects_usage(self.con),
            "sh": zusage._speed_history(self.con),
            "sd": _unpack_sd(zusage._speed_days(self.con)),
        }

    def test_incremental_matches_full_across_inserts_and_multi_step_turn(self):
        now_ms = int(datetime.now().timestamp() * 1000)
        t0 = _anchor(now_ms, 60)
        self.con.execute(
            "INSERT INTO session VALUES (?,?,?,?,?)",
            ("s1", "proj_a", "/tmp/proj_a", None, "first"),
        )
        _insert_usage(self.con, "u1", "s1", "t1", st=t0, ft=t0 + 200, ct=t0 + 2200)
        self.con.commit()

        # 首帧建基线
        base_incr = self._snapshot_all(now_ms, t0)
        self.assertEqual(len(zusage._INCR_STATES), 1)
        st = next(iter(zusage._INCR_STATES.values()))
        self.assertEqual(st.last_rowid, 1)

        # 同轮 t1 追加第 2 次请求 + 新会话 s2（子代理）+ 新轮 t2
        self.con.execute(
            "INSERT INTO session VALUES (?,?,?,?,?)",
            ("s2", "proj_a", "/tmp/proj_a", "s1", "sub"),
        )
        _insert_usage(self.con, "u2", "s1", "t1", model="glm-4.6", prov="account:glm",
                      st=t0 + 3000, ft=t0 + 3300, ct=t0 + 5300, inp=1200, outp=300)
        _insert_usage(self.con, "u3", "s2", "t_sub", qs="subagent", prov="custom:x",
                      st=t0 + 4000, ft=t0 + 4200, ct=t0 + 6200, inp=500, outp=100)
        _insert_usage(self.con, "u4", "s1", "t2", model="glm-4.5", prov="account:zai",
                      st=t0 + 7000, ft=t0 + 7200, ct=t0 + 9200, inp=800, outp=150)

        self._clear_outer_caches()
        incr_res = self._snapshot_all(now_ms, t0)
        self.assertEqual(st.last_rowid, 4)

        # 禁用增量跑全量对照
        self._clear_outer_caches()
        with mock.patch.object(zusage, "_incr_get", return_value=None):
            full_res = self._snapshot_all(now_ms, t0)

        self.assertEqual(incr_res, full_res)
        self.assertEqual(incr_res["fbk"], "account:zai")
        self.assertEqual(incr_res["today"][0], 4)
        self.assertEqual(incr_res["today"][11], 3)  # distinct turns: t1, t_sub, t2

    def test_delete_triggers_full_rebuild(self):
        now_ms = int(datetime.now().timestamp() * 1000)
        t0 = _anchor(now_ms, 30)
        self.con.execute("INSERT INTO session VALUES (?,?,?,?,?)", ("s1", "p1", "/tmp/p1", None, "s1"))
        _insert_usage(self.con, "u1", "s1", "t1", st=t0, ft=t0 + 100, ct=t0 + 1100)
        _insert_usage(self.con, "u2", "s1", "t2", st=t0 + 2000, ft=t0 + 2100, ct=t0 + 3100)

        self._snapshot_all(now_ms, t0)
        st_old = next(iter(zusage._INCR_STATES.values()))

        # 删除第一行，max(rowid) 不变但 count(*) 减少
        self.con.execute("DELETE FROM model_usage WHERE id='u1'")
        self.con.commit()
        self._clear_outer_caches()

        res = self._snapshot_all(now_ms, t0)
        st_new = next(iter(zusage._INCR_STATES.values()))
        self.assertIsNot(st_new, st_old)
        self.assertEqual(res["today"][0], 1)

    def test_session_metadata_change_reflected_without_rebuild(self):
        now_ms = int(datetime.now().timestamp() * 1000)
        t0 = _anchor(now_ms, 20)
        self.con.execute("INSERT INTO session VALUES (?,?,?,?,?)", ("s1", "p1", "/tmp/alpha", None, "old-title"))
        _insert_usage(self.con, "u1", "s1", "t1", st=t0, ft=t0 + 100, ct=t0 + 1100)
        self._snapshot_all(now_ms, t0)

        self.con.execute("UPDATE session SET title='new-title', directory='/tmp/beta' WHERE id='s1'")
        self.con.commit()
        self._clear_outer_caches()

        res = self._snapshot_all(now_ms, t0)
        self.assertEqual(res["ap"]["projects"][0]["name"], "beta")
        self.assertEqual(res["sh"]["snames"][0], "new-title")

    def test_cross_day_and_rebuild_ttl(self):
        d1 = datetime(2026, 11, 20, 12, 0, 0)
        t0 = int(d1.timestamp() * 1000)
        self.con.execute("INSERT INTO session VALUES (?,?,?,?,?)", ("s1", "p1", "/tmp/p1", None, "s1"))
        _insert_usage(self.con, "u1", "s1", "t1", st=t0, ft=t0 + 100, ct=t0 + 1100)

        with mock.patch.object(zusage, "_day_start", return_value=datetime(2026, 11, 20, 0, 0, 0)):
            r1 = zusage._today_usage(self.con, t0 - 3600_000, t0 + 3600_000)
            self.assertEqual(r1[0], 1)
            st1 = next(iter(zusage._INCR_STATES.values()))

        # 跨自然日：自动重建基线
        d2 = datetime(2026, 11, 21, 0, 0, 0)
        with mock.patch.object(zusage, "_day_start", return_value=d2):
            self._clear_outer_caches()
            r2 = zusage._today_usage(self.con, int(d2.timestamp() * 1000), int((d2 + timedelta(days=1)).timestamp() * 1000))
            self.assertEqual(r2[0], 0)
            st2 = next(iter(zusage._INCR_STATES.values()))
            self.assertIsNot(st2, st1)

    def test_memory_db_and_missing_cols_fallback(self):
        mem = _make_db(":memory:")
        self.addCleanup(mem.close)
        self.assertIsNone(zusage._incr_get(mem))

        slim_path = os.path.join(self.tmp.name, "slim.sqlite")
        slim = sqlite3.connect(slim_path)
        self.addCleanup(slim.close)
        slim.execute("CREATE TABLE model_usage (id TEXT PRIMARY KEY, session_id TEXT)")
        slim.commit()
        self.assertIsNone(zusage._incr_get(slim))


if __name__ == "__main__":
    unittest.main()
