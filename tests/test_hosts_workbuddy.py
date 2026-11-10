# -*- coding: utf-8 -*-
"""宿主适配回归：默认仍是 ZCode（装不装 WorkBuddy 都不影响原行为），
显式选择 workbuddy 时改读 ~/.workbuddy/workbuddy.db 的会话级表，并按能力表降级。

夹具只用临时库，不读真实 ZCode/WorkBuddy 数据；WorkBuddy 表结构以本机官方库为准
（sessions + session_usage，后者的 credit_json 是 {计价条目: credit}）。
"""
import importlib.util
import io
import json
import os
import sqlite3
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]

spec = importlib.util.spec_from_file_location("zusage_hosts_test", ROOT / "zusage.py")
zusage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(zusage)

WB_SCHEMA = """
create table sessions (
  id text primary key, cwd text, user_id text, title text, custom_title text, status text,
  created_at integer, updated_at integer, last_activity_at integer, deleted_at integer,
  is_playground integer default 0, is_background_automation integer,
  model text, context_window integer
);
create table session_usage (
  session_id text primary key, used integer not null, size integer not null,
  updated_at integer not null, credit_json text
);
"""


def _now_ms():
    return int(time.time() * 1000)


class WorkBuddyFixture:
    """一份最小 WorkBuddy 库：两个会话（一个进行中、一个已完成），含坏 credit_json 行。"""

    def __init__(self, root):
        self.path = Path(root) / "workbuddy.db"
        now = _now_ms()
        con = sqlite3.connect(str(self.path))
        con.executescript(WB_SCHEMA)
        con.executemany(
            "insert into sessions (id, cwd, user_id, title, custom_title, status, created_at,"
            " updated_at, last_activity_at, deleted_at, is_playground, is_background_automation,"
            " model, context_window) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [
                ("sess-live-0001", "D:/work/alpha", "u1", "进行中的会话", None, "working",
                 now - 3600_000, now - 60_000, now - 60_000, None, 0, None,
                 "deepseek-v4.1-flash", 1000000),
                ("sess-done-0002", "D:/work/beta", "u1", "已完成的会话", "自定义标题", "completed",
                 now - 3 * 86400_000, now - 2 * 86400_000, now - 2 * 86400_000, None, 0, None,
                 "deepseek-v4-pro", 300000),
                ("sess-bad-0003", "D:/work/alpha", "u1", "坏 credit", None, "completed",
                 now - 4 * 86400_000, now - 4 * 86400_000, now - 4 * 86400_000, None, 0, None,
                 None, None),
                ("sess-del-0004", "D:/work/alpha", "u1", "已删除", None, "completed",
                 now - 5 * 86400_000, now - 5 * 86400_000, now - 5 * 86400_000, now - 4 * 86400_000,
                 0, None, "deepseek-v4-pro", 300000),
            ],
        )
        con.executemany(
            "insert into session_usage (session_id, used, size, updated_at, credit_json)"
            " values (?,?,?,?,?)",
            [
                # 进行中：两条计价条目 + 一条非数值（应跳过）
                ("sess-live-0001", 83004, 1000000, now - 60_000,
                 json.dumps({"01a1a635": 2.5, "01a1a636": 1.0, "x": "n/a"})),
                # size=0 → 回退 sessions.context_window
                ("sess-done-0002", 44583, 0, now - 2 * 86400_000,
                 json.dumps({"01a19ce": 0.72, "01a19cf": 0.65})),
                # 损坏 JSON → credit 0，不整行失败
                ("sess-bad-0003", 1200, 300000, now - 4 * 86400_000, "{not json"),
                # 已软删除会话不应出现在结果里
                ("sess-del-0004", 999, 300000, now - 5 * 86400_000, json.dumps({"a": 9.9})),
            ],
        )
        con.commit()
        con.close()


class HostResolutionTests(unittest.TestCase):
    def setUp(self):
        zusage.set_host(None)
        self._env = mock.patch.dict(os.environ, {}, clear=False)
        self._env.start()
        # 保存/恢复而不是裸 pop：裸 pop 会把整个测试进程的变量删掉，影响后续用例
        for name in ("ZUSAGE_HOST", "ZUSAGE_WORKBUDDY_DB"):
            if name in os.environ:
                saved = os.environ.pop(name)
                self.addCleanup(os.environ.__setitem__, name, saved)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(zusage.set_host, None)
        self.addCleanup(self._env.stop)
        self.fixture = WorkBuddyFixture(self.tmp.name)

    def _write_config(self, payload):
        cfg = Path(self.tmp.name) / "config.json"
        cfg.write_text(json.dumps(payload), encoding="utf-8")
        return cfg

    def test_default_stays_zcode_even_when_workbuddy_db_exists(self):
        """装了 WorkBuddy 也不能改变原宿主行为：默认恒定 zcode（auto 才是显式选择）。"""
        missing = Path(self.tmp.name) / "none.sqlite"
        with mock.patch.object(zusage, "DB_PATH", missing), \
                mock.patch.object(zusage, "CONFIG_PATH", Path(self.tmp.name) / "absent.json"), \
                mock.patch.dict(os.environ, {"ZUSAGE_WORKBUDDY_DB": str(self.fixture.path)}):
            self.assertEqual(zusage.resolve_host(), zusage.HOST_ZCODE)
            self.assertEqual(zusage.host_source(), "default")
            self.assertNotEqual(zusage.host_db_path(), self.fixture.path)

    def test_config_host_selects_workbuddy_and_is_reported(self):
        cfg = self._write_config({"host": "workbuddy"})
        with mock.patch.object(zusage, "CONFIG_PATH", cfg), \
                mock.patch.dict(os.environ, {"ZUSAGE_WORKBUDDY_DB": str(self.fixture.path)}):
            self.assertEqual(zusage.resolve_host(), zusage.HOST_WORKBUDDY)
            self.assertEqual(zusage.host_source(), "config")
            self.assertEqual(zusage.host_db_path(), Path(str(self.fixture.path)))
            self.assertEqual(zusage.host_label(), "WorkBuddy")

    def test_env_then_cli_override_precedence(self):
        cfg = self._write_config({"host": "zcode"})
        with mock.patch.object(zusage, "CONFIG_PATH", cfg):
            with mock.patch.dict(os.environ, {"ZUSAGE_HOST": "WorkBuddy"}):
                self.assertEqual(zusage.resolve_host(), zusage.HOST_WORKBUDDY)   # 大小写不敏感
                self.assertEqual(zusage.host_source(), "env")
                zusage.set_host("wb")                                            # 别名
                self.assertEqual(zusage.resolve_host(), zusage.HOST_WORKBUDDY)
                self.assertEqual(zusage.host_source(), "cli")
                zusage.set_host(None)
                self.assertEqual(zusage.resolve_host(), zusage.HOST_WORKBUDDY)

    def test_unknown_host_is_rejected(self):
        with self.assertRaises(ValueError):
            zusage.set_host("claude-code")
        self.assertIsNone(zusage.normalize_host(""))
        self.assertIsNone(zusage.normalize_host("nope"))

    def test_auto_mode_only_when_zcode_db_missing(self):
        cfg = self._write_config({"host": "auto"})
        zcode_db = Path(self.tmp.name) / "zcode.sqlite"
        sqlite3.connect(str(zcode_db)).close()
        with mock.patch.object(zusage, "CONFIG_PATH", cfg), \
                mock.patch.object(zusage, "DB_PATH", zcode_db), \
                mock.patch.dict(os.environ, {"ZUSAGE_WORKBUDDY_DB": str(self.fixture.path)}):
            self.assertEqual(zusage.resolve_host(), zusage.HOST_ZCODE)   # 两库都在 → 仍选 zcode
            self.assertEqual(zusage.host_source(), "auto")
        with mock.patch.object(zusage, "CONFIG_PATH", cfg), \
                mock.patch.object(zusage, "DB_PATH", Path(self.tmp.name) / "gone.sqlite"), \
                mock.patch.dict(os.environ, {"ZUSAGE_WORKBUDDY_DB": str(self.fixture.path)}):
            self.assertEqual(zusage.resolve_host(), zusage.HOST_WORKBUDDY)

    def test_capability_table_marks_workbuddy_gaps(self):
        caps = zusage.host_caps(zusage.HOST_WORKBUDDY)
        self.assertTrue(caps["context"])
        self.assertTrue(caps["credits"])
        # 逐请求用量来自会话正文（providerData.rawUsage），token/速度/工具都可得
        self.assertTrue(caps["tokens"])
        self.assertTrue(caps["tps"])
        self.assertTrue(caps["cost"])        # 价表全覆盖时费用可得（未收录模型另按「不可得」）
        zcode_caps = zusage.host_caps(zusage.HOST_ZCODE)
        self.assertTrue(zcode_caps["tokens"])
        self.assertFalse(zcode_caps["credits"])

    def test_capability_table_degrades_when_optional_modules_missing(self):
        """正文解析/价表是可分发文件：缺了就不要再声称拿到那些指标。"""
        with mock.patch.object(zusage, "_wb_usage", None):
            caps = zusage.host_caps(zusage.HOST_WORKBUDDY)
            self.assertFalse(caps["tokens"])
            self.assertFalse(caps["tps"])
            self.assertFalse(caps["cost"])
            self.assertTrue(caps["context"])   # 上下文只需 session_usage，仍可得
        missing_pricing = mock.Mock(_pricing=None)
        with mock.patch.object(zusage, "_wb_usage", missing_pricing):
            caps = zusage.host_caps(zusage.HOST_WORKBUDDY)
            self.assertTrue(caps["tokens"])
            self.assertFalse(caps["cost"])     # 没有价表就没有费用


class WorkBuddySnapshotTests(unittest.TestCase):
    def setUp(self):
        zusage.set_host(None)
        if "ZUSAGE_HOST" in os.environ:
            saved = os.environ.pop("ZUSAGE_HOST")
            self.addCleanup(os.environ.__setitem__, "ZUSAGE_HOST", saved)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(zusage.set_host, None)
        self.fixture = WorkBuddyFixture(self.tmp.name)
        self.cfg_path = Path(self.tmp.name) / "config.json"
        self.cfg_path.write_text(json.dumps({"host": "workbuddy", "context_window": 128000}),
                                 encoding="utf-8")
        # 正文解析也读 WORKBUDDY_HOME：不隔离会读到本机真实会话，今日聚合串味
        patcher = mock.patch.dict(os.environ, {"ZUSAGE_WORKBUDDY_DB": str(self.fixture.path),
                                               "WORKBUDDY_HOME": self.tmp.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        cfg_patcher = mock.patch.object(zusage, "CONFIG_PATH", self.cfg_path)
        cfg_patcher.start()
        self.addCleanup(cfg_patcher.stop)
        # 价表缓存重定向到临时目录（并拦截测试内 _wb_ready_pricing 的 configure 重指回
        # 仓库/运行目录）：不隔离会读开发机真实 pricing-cache.json，改价同步后随机红
        real_configure = zusage._pricing.configure
        pricing = mock.patch.object(
            zusage._pricing, "configure",
            lambda *a, **k: real_configure({}, config_dir=self.tmp.name))
        pricing.start()
        self.addCleanup(pricing.stop)

    def test_snapshot_shape_caps_and_values(self):
        snap = zusage.snapshot()
        self.assertEqual(snap["host"], "workbuddy")
        self.assertTrue(snap["caps"]["tokens"])   # 正文解析提供逐请求用量
        for key in ("session", "last_turn", "last", "today", "recent", "context_window",
                    "code", "tools", "known_sids", "local_error", "not_local"):
            self.assertIn(key, snap)   # 消费端按既有键读取，缺键即坏帧
        base = snap["session"]
        self.assertEqual(base["sid"], "sess-live-0001")     # 最后活动最新
        self.assertEqual(base["ctx"], 83004)
        self.assertEqual(base["context_window"], 1000000)
        self.assertAlmostEqual(base["credits"], 3.5, places=4)   # 非数值条目被跳过
        self.assertEqual(base["credit_entries"], 2)
        self.assertTrue(base["active"])                      # status=working
        self.assertEqual(base["title"], "进行中的会话")
        # 已软删除的会话不进快照
        self.assertNotIn("sess-del-0004", [r["sid"] for r in snap["recent"]])
        # 今日口径：活跃会话含进行中那个；新建会话只算今天创建的
        self.assertEqual(snap["today"]["sessions"], 1)
        self.assertEqual(snap["today"]["new_sessions"], 1)
        # 今日 credit 来自正文聚合（此处无正文 → 0），会话 credit 来自 credit_json 兜底
        self.assertEqual(snap["today"]["credits"], 0)
        # 夹具没有会话正文：逐请求字段仍为 0，但不伪造（capability 声明可得）
        self.assertEqual(snap["today"]["input"], 0)
        self.assertEqual(snap["today"]["total"], 0)
        self.assertEqual(base["input"], 0)

    def test_window_from_session_usage_is_not_marked_as_fallback(self):
        """size 命中就是权威窗口，不能标成「回退值」（之前标记写反了）。"""
        snap = zusage.snapshot()
        live = next(r for r in snap["recent"] if r["sid"] == "sess-live-0001")
        self.assertEqual(live["context_window"], 1000000)
        self.assertFalse(live["context_auto"])

    def test_window_falls_back_to_session_context_window(self):
        snap = zusage.snapshot()
        done = next(r for r in snap["recent"] if r["sid"] == "sess-done-0002")
        self.assertEqual(done["context_window"], 300000)   # size=0 → sessions.context_window
        self.assertTrue(done["context_auto"])
        self.assertEqual(done["title"], "自定义标题")        # custom_title 优先

    def test_force_sid_is_hoisted_and_unknown_reported(self):
        snap = zusage.snapshot(force_sid="sess-done-0002,nope-xyz")
        self.assertEqual(snap["session"]["sid"], "sess-done-0002")
        self.assertEqual(snap["recent"][0]["sid"], "sess-done-0002")
        self.assertIn("sess-done-0002", snap["known_sids"])
        self.assertEqual(snap["not_local"], ["nope-xyz"])

    def test_broken_credit_json_and_null_model_do_not_crash(self):
        snap = zusage.snapshot()
        bad = next(r for r in snap["recent"] if r["sid"] == "sess-bad-0003")
        self.assertEqual(bad["credits"], 0.0)
        self.assertEqual(bad["model"], "")
        self.assertEqual(bad["context_window"], 300000)

    def test_missing_db_degrades_instead_of_raising(self):
        gone = Path(self.tmp.name) / "gone.db"
        with mock.patch.dict(os.environ, {"ZUSAGE_WORKBUDDY_DB": str(gone)}):
            snap = zusage.snapshot()
            self.assertEqual(snap["host"], "workbuddy")
            self.assertTrue(snap["local_error"])
            self.assertEqual(snap["recent"], [])
            self.assertEqual(snap["session"]["sid"], "")
            self.assertEqual(snap["today"]["sessions"], 0)


class WorkBuddyReportTests(unittest.TestCase):
    """报表分支：同一批 render_* 入口按连接宿主分派，输出不含 token 分项假值。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(zusage.set_host, None)
        fixture = WorkBuddyFixture(self.tmp.name)
        self.con = zusage._open_ro(fixture.path, "select 1 from session_usage limit 1")
        self.con.zusage_host = zusage.HOST_WORKBUDDY
        self.addCleanup(self.con.close)
        self._lang = mock.patch.object(zusage, "_LANG", "zh")
        self._lang.start()
        self.addCleanup(self._lang.stop)
        # 报表里的今日/项目/模型聚合读的是会话正文目录，必须隔离到临时 HOME
        env = mock.patch.dict(os.environ, {"WORKBUDDY_HOME": self.tmp.name})
        env.start()
        self.addCleanup(env.stop)
        real_configure = zusage._pricing.configure
        pricing = mock.patch.object(
            zusage._pricing, "configure",
            lambda *a, **k: real_configure({}, config_dir=self.tmp.name))
        pricing.start()
        self.addCleanup(pricing.stop)

    def test_session_row_carries_speed_points_for_hover_chart(self):
        """悬停速度卡要画柱状图：每段必须有时间戳与用量，不能只给 tps 数值。"""
        proj = Path(self.tmp.name) / "projects" / "d-work-alpha"
        proj.mkdir(parents=True)
        (proj / "sess-live-0001.jsonl").write_text(
            json.dumps({"type": "message", "role": "user", "timestamp": 1000,
                        "cwd": "D:/work/alpha"}, ensure_ascii=False) + "\n" +
            json.dumps({"type": "function_call", "timestamp": 3000, "cwd": "D:/work/alpha",
                        "providerData": {"conversationRequestId": "r1", "stepSeq": 1,
                                         "model": "deepseek-v4.1-flash",
                                         "rawUsage": {"prompt_tokens": 1000, "completion_tokens": 200,
                                                      "completion_tokens_details": {"reasoning_tokens": 10},
                                                      "prompt_tokens_details": {"cached_tokens": 900},
                                                      "credit": 0.1}}}, ensure_ascii=False) + "\n",
            encoding="utf-8")
        live = next(r for r in zusage._wb_rows(self.con) if r["sid"] == "sess-live-0001")
        pts = live.get("speed_points") or []
        self.assertEqual(len(pts), 1)
        self.assertEqual(pts[0]["ts"], 3000)
        self.assertEqual(pts[0]["output"], 200)
        self.assertGreater(pts[0]["tps"], 0)

    def test_dispatch_follows_connection_host(self):
        self.assertEqual(zusage.host_of(self.con), zusage.HOST_WORKBUDDY)
        text = zusage.render_current(self.con)
        self.assertIn("WorkBuddy 当前会话", text)
        self.assertIn("83.0K", text)          # 上下文用量
        self.assertIn("credit 3.50", text)
        # 夹具没有正文：如实说明只能显示上下文与 credit，不编造 token/速度
        self.assertIn("没有会话正文记录", text)
        self.assertNotIn("t/s", text)

    def test_today_sessions_models_workspace_session(self):
        today = zusage.render_today(self.con)
        self.assertIn("[WorkBuddy]", today)
        self.assertIn("0 个会话", today)                      # 无正文 → 今日聚合为空
        sessions = zusage.render_sessions(self.con, 5)
        self.assertIn("[sess-liv]", sessions)
        self.assertNotIn("已删除", sessions)                 # 软删除会话不出现
        models = zusage.render_models(self.con, 7)
        self.assertIn("没有请求", models)                     # 无正文 → 无模型明细
        workspaces = zusage.render_workspace(self.con, "alpha")
        self.assertIn("D:/work/alpha", workspaces)
        self.assertIn("[WorkBuddy]", workspaces)
        self.assertIn("未找到目录含", zusage.render_workspace(self.con, "zzz-none"))
        detail = zusage.render_session_detail(self.con, "sess-done")
        self.assertIn("自定义标题", detail)
        self.assertIn("300.0K", detail)                      # 上下文窗口回退值
        self.assertIn("命中 3 个会话", zusage.render_session_detail(self.con, "sess-"))
        self.assertIn("没有", zusage.render_session_detail(self.con, "absent"))

    def test_days_buckets_by_session_creation_day(self):
        text = zusage.render_days(self.con, 5)
        self.assertIn("近 5 天每日", text)
        self.assertEqual(len([ln for ln in text.splitlines() if ln.startswith("  20")]), 5)


class HostCliTests(unittest.TestCase):
    def setUp(self):
        zusage.set_host(None)
        if "ZUSAGE_HOST" in os.environ:
            saved = os.environ.pop("ZUSAGE_HOST")
            self.addCleanup(os.environ.__setitem__, "ZUSAGE_HOST", saved)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(zusage.set_host, None)

    def test_extract_host_flag_positions_and_errors(self):
        self.assertEqual(zusage._extract_host_flag(["--host", "workbuddy", "sessions", "3"]),
                         (["sessions", "3"], "workbuddy"))
        self.assertEqual(zusage._extract_host_flag(["json", "--host=zcode", "sess-1"]),
                         (["json", "sess-1"], "zcode"))
        self.assertEqual(zusage._extract_host_flag(["now"]), (["now"], None))
        with self.assertRaises(ValueError):
            zusage._extract_host_flag(["--host"])

    def test_host_command_reports_current_and_both_databases(self):
        fixture = WorkBuddyFixture(self.tmp.name)
        cfg = Path(self.tmp.name) / "config.json"
        cfg.write_text(json.dumps({"host": "workbuddy"}), encoding="utf-8")
        out = io.StringIO()
        with mock.patch.object(zusage, "CONFIG_PATH", cfg), \
                mock.patch.object(zusage, "DB_PATH", Path(self.tmp.name) / "zcode.sqlite"), \
                mock.patch.dict(os.environ, {"ZUSAGE_WORKBUDDY_DB": str(fixture.path)}), \
                redirect_stdout(out):
            code = zusage.main(["host"])
        text = out.getvalue()
        self.assertEqual(code, 0)
        self.assertIn("WorkBuddy", text)
        self.assertIn("config.host", text)
        self.assertIn("4 条用量记录", text)
        self.assertIn("不存在", text)          # zcode 库缺失也如实标注
        self.assertIn("可用指标", text)
        self.assertIn("cost", text.split("可用指标")[1])   # 费用已可算

    def test_host_command_shows_agent_source_without_keyerror(self):
        """WorkBuddy 构建零配置（host_source=agent）跑自检入口：来源如实显示，不崩。"""
        fixture = WorkBuddyFixture(self.tmp.name)
        out = io.StringIO()
        with mock.patch.object(zusage, "CONFIG_PATH", Path(self.tmp.name) / "absent.json"), \
                mock.patch.object(zusage.Path, "home", return_value=Path(self.tmp.name)), \
                mock.patch.object(zusage, "DB_PATH", Path(self.tmp.name) / "zcode.sqlite"), \
                mock.patch.dict(os.environ, {"ZUSAGE_WORKBUDDY_DB": str(fixture.path),
                                             "ZUSAGE_AGENT": "workbuddy"}), \
                redirect_stdout(out):
            code = zusage.main(["host"])
        text = out.getvalue()
        self.assertEqual(code, 0)
        self.assertIn("workbuddy", text)
        self.assertIn("跟随客户端构建", text)
        self.assertNotIn("Traceback", text)

    def test_invalid_host_flag_exits_two_without_traceback(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = zusage.main(["--host", "nope", "now"])
        self.assertEqual(code, 2)
        self.assertIn("unknown host", out.getvalue())
        self.assertNotIn("Traceback", out.getvalue())


if __name__ == "__main__":
    unittest.main()
