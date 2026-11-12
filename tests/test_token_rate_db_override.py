#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""issue #314：token_rate.py 与 zusage.py 对 hosts.zcode.db_path 覆盖的语义一致。

规格见 specs/db-path-config-override.md；本文件里的「规则 N / 验收 N」均指该规格。
背景（issue #311 实证）：zusage 经 zcode_db_path() 读 config.json 的 hosts.zcode.db_path，
token_rate 的 DB_PATH 不读——主桥 turn-text 旁路与 prompt-submit hook 都读默认解析库，
出现「MCP 正常、逐问统计行恒显占位文案」的静默不对称。

密闭性：每个用例用临时 HOME，并剥掉会改变库解析的环境变量；脚本同目录那一跳用暂存目录
控制（仓库根 config.json 被 gitignore，开发机上可能真有一份），不触碰执行者的真实库与配置。

运行：python3 -B -m unittest discover -s tests -p 'test_*.py'
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
PLUGIN = REPO / "plugins" / "zcode-token-usage-statusbar"
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from tests.helpers.py_test_support import load_module  # noqa: E402

SID = "sess_override"
NO_DATA = "暂无已完成的模型请求"
# 会改变库解析 / 会话选择 / 状态文件位置的环境变量：用例一律先剥掉再按需设置
ISOLATED_ENV = ("ZCODE_USAGE_DB", "ZCODE_SESSION_DB_PATH", "ZCODE_SESSION_DB",
                "ZCODE_DATA_BASE_DIR", "ZCODE_SESSION_ID", "CLAUDE_SESSION_ID",
                "ZUSAGE_RATE_STATE_FILE", "ZUSAGE_PLUGIN_RUNTIME")

SCHEMA = """
create table model_usage (
  id text primary key,
  session_id text not null,
  turn_id text,
  query_source text not null,
  model_id text not null,
  status text not null,
  started_at integer not null,
  first_token_at integer,
  completed_at integer,
  time_to_first_token_ms integer,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  reasoning_tokens integer not null default 0,
  cache_read_input_tokens integer not null default 0,
  provider_id text
);
"""


def make_db(path, rows):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(path))
    con.executescript(SCHEMA)
    con.executemany("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    con.commit()
    con.close()


def usage_rows(t0):
    """上轮 turn_a + 本问 turn_b 各一段（t0 = 提问时刻）。"""
    return [
        ("a1", SID, "turn_a", "main_turn", "test-model", "completed",
         t0 - 12000, t0 - 9000, t0 - 4000, 3000, 100, 1000, 0, 0, "account:fixture"),
        ("b1", SID, "turn_b", "main_turn", "test-model", "completed",
         t0 + 1000, t0 + 4000, t0 + 9000, 3000, 200, 1200, 300, 0, "account:fixture"),
    ]


def clean_env(**extra):
    env = {k: v for k, v in os.environ.items() if k not in ISOLATED_ENV}
    env.update(extra)
    return env


def cfg(db_path):
    return {"hosts": {"zcode": {"db_path": str(db_path)}}}


def _cleanup(tmp):
    # Windows：刚退出的子进程或杀软扫描可能仍短暂持有库文件句柄，重试几轮，仍失败则放弃清理
    for attempt in range(5):
        try:
            tmp.cleanup()
            return
        except OSError:
            time.sleep(0.2 * (attempt + 1))
    shutil.rmtree(tmp.name, ignore_errors=True)


class Fixture(unittest.TestCase):
    """临时 HOME + 暂存脚本目录（token_rate.py 及其同目录依赖）+ config.json 摆放助手。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(_cleanup, self.tmp)
        self.root = Path(self.tmp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.scripts = self.root / "scripts"
        self.scripts.mkdir()
        for name in ("token_rate.py", "usage_stats.py", "runtime_lock.py"):
            shutil.copy(str(REPO / name), str(self.scripts / name))
        self.data_dir = self.home / ".zcode" / "zcode-token-usage-statusbar"

    def config_file(self, where):
        return (self.scripts if where == "script" else self.data_dir) / "config.json"

    def put(self, where, content):
        """where: 'script'（脚本同目录）| 'data'（~/.zcode/zcode-token-usage-statusbar）。
        content：dict→JSON、str→原文、bytes→原字节。"""
        f = self.config_file(where)
        f.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            f.write_bytes(content)
        elif isinstance(content, str):
            f.write_text(content, encoding="utf-8")
        else:
            f.write_text(json.dumps(content), encoding="utf-8")

    def drop(self):
        for where in ("script", "data"):
            f = self.config_file(where)
            if f.is_dir():
                shutil.rmtree(str(f))
            elif f.exists():
                f.unlink()

    def load_token_rate(self, name, **env_extra):
        """在隔离环境（临时 HOME、无库解析类环境变量）下导入暂存目录里的 token_rate.py。"""
        env = clean_env(HOME=str(self.home), USERPROFILE=str(self.home), **env_extra)
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch("pathlib.Path.home", return_value=self.home):
            return load_module(name, self.scripts / "token_rate.py")


class ConfiguredDbPathTest(Fixture):
    """token_rate._configured_db_path：读取口径（规则 3、4；验收 3–6）。"""

    def setUp(self):
        super().setUp()
        # 导入期用 ZCODE_USAGE_DB 短路：本类只测函数，不让导入读任何 config
        self.mod = self.load_token_rate("tr_override_unit",
                                        ZCODE_USAGE_DB=str(self.root / "isolated.sqlite"))
        self.a = self.root / "a" / "usage.sqlite"
        self.b = self.root / "b" / "usage.sqlite"

    def resolve(self):
        return self.mod._configured_db_path(home=self.home, script_dir=self.scripts)

    def test_no_config_files_is_unconfigured(self):
        self.assertIsNone(self.resolve())

    def test_script_dir_override(self):
        self.put("script", cfg(self.a))
        self.assertEqual(self.resolve(), self.a)

    def test_data_dir_override_when_script_dir_has_no_config(self):
        self.put("data", cfg(self.b))
        self.assertEqual(self.resolve(), self.b)

    def test_script_dir_wins_over_data_dir(self):
        self.put("script", cfg(self.a))
        self.put("data", cfg(self.b))
        self.assertEqual(self.resolve(), self.a)

    def test_empty_db_path_in_first_hop_shadows_second_hop(self):
        # 先到者整段胜出：与 zusage.host_config 的 `name not in acc` 同款，空值也遮蔽后一跳
        self.put("data", cfg(self.b))
        for value in ({"db_path": ""}, {}):
            with self.subTest(zcode=value):
                self.put("script", {"hosts": {"zcode": value}})
                self.assertIsNone(self.resolve())

    def test_first_hop_without_usable_zcode_entry_continues_to_second_hop(self):
        self.put("data", cfg(self.b))
        bad = [
            ("hosts 里没有 zcode", {"hosts": {"workbuddy": {"db_path": str(self.a)}}}),
            ("zcode 是字符串", {"hosts": {"zcode": str(self.a)}}),
            ("zcode 是 null", {"hosts": {"zcode": None}}),
            ("hosts 是字符串", {"hosts": str(self.a)}),
            ("hosts 是 null", {"hosts": None}),
            ("顶层是数组", [1, 2]),
            ("无 hosts 键", {"python_path": "python"}),
            ("损坏 JSON", "{not json"),
            ("UTF-8 BOM（zusage 同样按损坏忽略）",
             b"\xef\xbb\xbf" + json.dumps(cfg(self.a)).encode("utf-8")),
            ("非法 UTF-8", b"\xff\xfe{"),
        ]
        for label, content in bad:
            with self.subTest(label):
                self.put("script", content)
                self.assertEqual(self.resolve(), self.b)

    def test_config_path_being_a_directory_is_ignored(self):
        self.config_file("script").mkdir()
        self.put("data", cfg(self.b))
        self.assertEqual(self.resolve(), self.b)

    def test_blank_or_non_string_db_path_is_unconfigured(self):
        self.put("data", cfg(self.b))
        for value in ("", "   ", None, 0, 123, False, True, [], {}):
            with self.subTest(db_path=value):
                self.put("script", {"hosts": {"zcode": {"db_path": value}}})
                self.assertIsNone(self.resolve())

    def test_value_is_stripped(self):
        self.put("script", {"hosts": {"zcode": {"db_path": "  %s  " % self.a}}})
        self.assertEqual(self.resolve(), self.a)

    def test_no_existence_check_and_no_absolute_check(self):
        # 规则 3：显式来源即写库位；不存在的库不回落，相对路径原样保留（按进程 cwd 解析）
        self.assertFalse(self.a.exists())
        self.put("script", cfg(self.a))
        self.assertEqual(self.resolve(), self.a)
        self.put("script", cfg("relative/usage.sqlite"))
        self.assertEqual(self.resolve(), Path("relative/usage.sqlite"))

    def test_tilde_expansion(self):
        self.put("script", cfg("~/zc/usage.sqlite"))
        with mock.patch.dict(os.environ, {"HOME": str(self.home), "USERPROFILE": str(self.home)}):
            self.assertEqual(self.resolve(), self.home / "zc" / "usage.sqlite")

    def test_environment_variable_expansion(self):
        token = "%ZTUS314_DIR%" if os.name == "nt" else "$ZTUS314_DIR"   # os.path.expandvars 的平台语法
        self.put("script", cfg(token + os.sep + "usage.sqlite"))
        with mock.patch.dict(os.environ, {"ZTUS314_DIR": str(self.a.parent)}):
            self.assertEqual(self.resolve(), self.a.parent / "usage.sqlite")

    def test_unexpandable_tilde_user_never_raises(self):
        # 规则 4：DB_PATH 在导入期求值，抛异常会连带丢掉 hook 的 write_session_state。
        # POSIX 上 ~nouser 展开必抛 RuntimeError（pathlib）→ 按未配置；Windows 的 ~user 语义不抛，只验不抛
        self.put("script", cfg("~ztus314nouser/usage.sqlite"))
        value = self.resolve()
        if os.name != "nt":
            self.assertIsNone(value)

    def test_default_resolution_untouched(self):
        # 规则 5：覆盖层叠在默认解析之上、不并入它——即使两跳都配了覆盖，_default_db_path 仍给默认库，
        # 它与 zusage.resolve_db_path / inject-main resolveHostDbDir 三处镜像才继续等价
        self.put("script", cfg(self.a))
        self.put("data", cfg(self.b))
        self.assertEqual(self.mod._default_db_path(env={}, home=self.home),
                         self.home / ".zcode" / "cli" / "db" / "db.sqlite")


class CrossFileConsistencyTest(Fixture):
    """验收 7：同一份 config 夹具下，zusage.zcode_db_path 与 token_rate._configured_db_path 一致。"""

    def setUp(self):
        super().setUp()
        env = clean_env(HOME=str(self.home), USERPROFILE=str(self.home))
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch("pathlib.Path.home", return_value=self.home):
            self.zusage = load_module("zusage_override_314", REPO / "zusage.py")
        self.zusage.CONFIG_PATH = self.scripts / "config.json"
        self.mod = self.load_token_rate("tr_override_cross",
                                        ZCODE_USAGE_DB=str(self.root / "isolated.sqlite"))
        self.a = self.root / "a" / "usage.sqlite"
        self.b = self.root / "b" / "usage.sqlite"

    def assert_same(self, label):
        got = self.mod._configured_db_path(home=self.home, script_dir=self.scripts)
        with mock.patch("pathlib.Path.home", return_value=self.home), \
                mock.patch.dict(os.environ, {"HOME": str(self.home), "USERPROFILE": str(self.home),
                                             "ZTUS314_DIR": str(self.a.parent)}):
            expect_zusage = self.zusage.zcode_db_path()
        # zusage 未配置时回落模块量 DB_PATH（默认解析）；token_rate 未配置返回 None，由 _default_db_path 接手
        expected = Path(self.zusage.DB_PATH) if got is None else got
        self.assertEqual(expect_zusage, expected, label)

    def test_same_result_across_scenarios(self):
        token = "%ZTUS314_DIR%" if os.name == "nt" else "$ZTUS314_DIR"
        scenarios = [
            ("无任何 config", None, None),
            ("仅脚本同目录", cfg(self.a), None),
            ("仅数据目录", None, cfg(self.b)),
            ("两跳都有，脚本同目录胜", cfg(self.a), cfg(self.b)),
            ("脚本同目录 db_path 为空遮蔽数据目录", {"hosts": {"zcode": {"db_path": ""}}}, cfg(self.b)),
            ("脚本同目录 zcode 空对象遮蔽数据目录", {"hosts": {"zcode": {}}}, cfg(self.b)),
            ("脚本同目录无 zcode，续第二跳", {"hosts": {"workbuddy": {"db_path": "x"}}}, cfg(self.b)),
            ("zcode 非对象，续第二跳", {"hosts": {"zcode": "x"}}, cfg(self.b)),
            ("hosts 非对象，续第二跳", {"hosts": "x"}, cfg(self.b)),
            ("顶层数组，续第二跳", [1], cfg(self.b)),
            ("损坏 JSON，续第二跳", "{not json", cfg(self.b)),
            ("BOM，续第二跳", b"\xef\xbb\xbf" + json.dumps(cfg(self.a)).encode("utf-8"), cfg(self.b)),
            ("全空白 db_path", {"hosts": {"zcode": {"db_path": "   "}}}, cfg(self.b)),
            ("非字符串 db_path", {"hosts": {"zcode": {"db_path": 123}}}, cfg(self.b)),
            ("首尾空白", {"hosts": {"zcode": {"db_path": "  %s  " % self.a}}}, None),
            ("波浪号展开", cfg("~/zc/usage.sqlite"), None),
            ("环境变量展开", cfg(token + os.sep + "usage.sqlite"), None),
            ("相对路径", cfg("relative/usage.sqlite"), None),
            ("不存在的绝对路径", cfg(self.root / "nowhere" / "usage.sqlite"), None),
        ]
        for label, script, data in scenarios:
            with self.subTest(label):
                self.drop()
                if script is not None:
                    self.put("script", script)
                if data is not None:
                    self.put("data", data)
                with mock.patch.dict(os.environ, {"HOME": str(self.home), "USERPROFILE": str(self.home),
                                                  "ZTUS314_DIR": str(self.a.parent)}):
                    self.assert_same(label)


class WiringTest(Fixture):
    """模块级 DB_PATH 的组装：ZCODE_USAGE_DB > 覆盖 > 默认解析（规则 2、7；验收 2、8）。"""

    def setUp(self):
        super().setUp()
        self.a = self.root / "a" / "usage.sqlite"
        self.default = self.home / ".zcode" / "cli" / "db" / "db.sqlite"

    def test_override_applies_to_module_db_path(self):
        self.put("script", cfg(self.a))
        mod = self.load_token_rate("tr_wired_override")
        self.assertIsInstance(mod.DB_PATH, str)
        self.assertEqual(Path(mod.DB_PATH), self.a)

    def test_second_hop_override_applies_to_module_db_path(self):
        self.put("data", cfg(self.a))
        mod = self.load_token_rate("tr_wired_data")
        self.assertEqual(Path(mod.DB_PATH), self.a)

    def test_usage_db_env_beats_override(self):
        self.put("script", cfg(self.a))
        explicit = self.root / "explicit.sqlite"
        mod = self.load_token_rate("tr_wired_env", ZCODE_USAGE_DB=str(explicit))
        self.assertEqual(Path(mod.DB_PATH), explicit)

    def test_empty_usage_db_env_is_treated_as_unset(self):
        self.put("script", cfg(self.a))
        mod = self.load_token_rate("tr_wired_empty_env", ZCODE_USAGE_DB="")
        self.assertEqual(Path(mod.DB_PATH), self.a)

    def test_no_override_keeps_default_resolution(self):
        mod = self.load_token_rate("tr_wired_default")
        self.assertEqual(Path(mod.DB_PATH), self.default)

    def test_usage_db_env_short_circuits_config_reads(self):
        # 规则 7 / 验收 8：ZCODE_USAGE_DB 已设时导入不读任何 config.json——隔离接缝零额外 I/O，
        # 且不让以它隔离的测试碰执行者的真实配置。含对照组：未设时确实会读，证明监视有效。
        self.put("script", cfg(self.a))
        reads = []
        real_read_text = Path.read_text

        def spy(path_self, *args, **kwargs):
            reads.append(str(path_self))
            return real_read_text(path_self, *args, **kwargs)

        with mock.patch.object(Path, "read_text", spy):
            self.load_token_rate("tr_wired_short", ZCODE_USAGE_DB=str(self.root / "explicit.sqlite"))
        self.assertEqual([r for r in reads if r.endswith("config.json")], [])
        reads.clear()
        with mock.patch.object(Path, "read_text", spy):
            self.load_token_rate("tr_wired_control")
        self.assertTrue([r for r in reads if r.endswith("config.json")],
                        "对照组：未设 ZCODE_USAGE_DB 时应读取 config.json")


class CliSymptomTest(Fixture):
    """验收 1、2、5：#311 症状路径——主桥 turn-text 旁路 spawn 的就是
    `token_rate.py --turn --current --session <sid>`，且不传 ZCODE_USAGE_DB。"""

    def setUp(self):
        super().setUp()
        self.t0 = int(time.time() * 1000) - 60_000
        self.override_db = self.root / "elsewhere" / "usage.sqlite"   # 非默认目录、非默认文件名
        make_db(self.override_db, usage_rows(self.t0))
        self.empty_db = self.root / "empty.sqlite"
        make_db(self.empty_db, [])
        self.state = self.root / "state.json"
        self.state.write_text(json.dumps({"sessionId": SID, "ts": self.t0, "promptTs": self.t0}),
                              encoding="utf-8")

    def run_rate(self, *args, **extra_env):
        env = clean_env(HOME=str(self.home), USERPROFILE=str(self.home),
                        ZUSAGE_RATE_STATE_FILE=str(self.state), PYTHONDONTWRITEBYTECODE="1", **extra_env)
        return subprocess.run([sys.executable, str(self.scripts / "token_rate.py"), *args],
                              capture_output=True, text=True, env=env, timeout=30)

    def test_control_without_override_has_no_data(self):
        # 对照：无覆盖时默认解析不到库（临时 HOME 里没有），证明下面的用例对该症状有判别力
        r = self.run_rate("--session", SID)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(NO_DATA, r.stdout)
        r = self.run_rate("--turn", "--current", "--session", SID)
        self.assertEqual(r.stdout, "")

    def test_default_output_reads_override_db(self):
        for where in ("script", "data"):
            with self.subTest(hop=where):
                self.drop()
                self.put(where, cfg(self.override_db))
                r = self.run_rate("--session", SID)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertIn("token/s(上轮)", r.stdout)
                self.assertNotIn(NO_DATA, r.stdout)

    def test_turn_current_reads_override_db(self):
        for where in ("script", "data"):
            with self.subTest(hop=where):
                self.drop()
                self.put(where, cfg(self.override_db))
                r = self.run_rate("--turn", "--current", "--session", SID)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertIn("token/s(本轮)", r.stdout)

    def test_usage_db_env_beats_override(self):
        self.put("data", cfg(self.override_db))
        r = self.run_rate("--session", SID, ZCODE_USAGE_DB=str(self.empty_db))
        self.assertIn(NO_DATA, r.stdout)
        r = self.run_rate("--turn", "--current", "--session", SID, ZCODE_USAGE_DB=str(self.empty_db))
        self.assertEqual(r.stdout, "")

    def test_empty_usage_db_env_does_not_shadow_override(self):
        self.put("data", cfg(self.override_db))
        r = self.run_rate("--session", SID, ZCODE_USAGE_DB="")
        self.assertIn("token/s(上轮)", r.stdout)

    def test_override_to_missing_db_degrades_and_does_not_fall_back_to_default(self):
        # 规则 4：显式配置的错误应可见——默认库里明明有数据，也不回落
        make_db(self.home / ".zcode" / "cli" / "db" / "db.sqlite", usage_rows(self.t0))
        self.put("data", cfg(self.root / "nowhere" / "usage.sqlite"))
        r = self.run_rate("--session", SID)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(NO_DATA, r.stdout)
        r = self.run_rate("--turn", "--current", "--session", SID)
        self.assertEqual(r.stdout, "")

    def test_unexpandable_override_does_not_break_the_script(self):
        # 规则 4：导入期不抛，否则 hook 的 write_session_state 连带丢失
        self.put("data", cfg("~ztus314nouser/usage.sqlite"))
        r = self.run_rate("--session", SID)
        self.assertEqual(r.returncode, 0, r.stderr)


class PromptSubmitHookSymptomTest(Fixture):
    """验收 1（hook 路径）：#311 报告的「prompt-submit 背景行恒为暂无已完成的模型请求」。
    暂存最小插件树（hook + 根目录 token_rate 及其依赖），脚本同目录那一跳可控且不依赖 sync 步骤。"""

    def setUp(self):
        super().setUp()
        self.plugin = self.root / "plugin"
        (self.plugin / "hooks").mkdir(parents=True)
        shutil.copy(str(PLUGIN / "hooks" / "prompt-submit.py"), str(self.plugin / "hooks" / "prompt-submit.py"))
        for name in ("token_rate.py", "usage_stats.py", "runtime_lock.py"):
            shutil.copy(str(REPO / name), str(self.plugin / name))
        self.t0 = int(time.time() * 1000) - 60_000
        self.override_db = self.root / "elsewhere" / "usage.sqlite"
        make_db(self.override_db, usage_rows(self.t0))

    def run_hook(self):
        env = clean_env(HOME=str(self.home), USERPROFILE=str(self.home), ZCODE_SESSION_ID=SID,
                        ZUSAGE_RATE_STATE_FILE=str(self.root / "state.json"),
                        ZUSAGE_PLUGIN_RUNTIME=str(self.data_dir), PYTHONDONTWRITEBYTECODE="1")
        return subprocess.run([sys.executable, str(self.plugin / "hooks" / "prompt-submit.py")], input="",
                              capture_output=True, text=True, env=env, timeout=30)

    def background_line(self):
        r = self.run_hook()
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"]

    def test_control_without_override_reports_no_data(self):
        self.assertIn(NO_DATA, self.background_line())

    def test_background_line_reads_override_db(self):
        self.put("data", cfg(self.override_db))
        ctx = self.background_line()
        self.assertIn("token/s(上轮)", ctx)
        self.assertNotIn(NO_DATA, ctx)


if __name__ == "__main__":
    unittest.main()
