#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""issue #279：宿主 dataBaseDir 数据目录迁移后的本地用量库路径解析。

zusage.py 与 token_rate.py 各自内联同源解析（setting.json 的 dataBaseDir 绝对值 >
ZCODE_DATA_BASE_DIR env > <home>；setting.json 恒在 <home>/.zcode/v2 不随迁移走，
同宿主 desktopDataBaseDirBootstrap 与注入侧 resolveHostQuotaPaths 语义），
本文件锁定解析顺序、容错与两份实现的一致性。

运行：python3 -B -m unittest discover -s tests -p 'test_*.py'
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from tests.helpers.py_test_support import load_module  # noqa: E402


class ResolveDbPathTest(unittest.TestCase):
    """zusage.resolve_db_path 的解析顺序与容错。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        (self.home / ".zcode" / "v2").mkdir(parents=True)
        self.migrated = Path(self.tmp.name) / "migrated"
        self.zusage = load_module("zusage_dbpath", REPO / "zusage.py")

    def write_setting(self, data_base_dir, encoding="utf-8"):
        f = self.home / ".zcode" / "v2" / "setting.json"
        f.write_text(json.dumps({"dataBaseDir": data_base_dir}), encoding=encoding)

    def expect(self, base):
        return Path(base) / ".zcode" / "cli" / "db" / "db.sqlite"

    def test_default_home_without_setting_and_env(self):
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        self.assertEqual(p, self.expect(self.home))

    def test_setting_json_absolute_databasedir_wins(self):
        self.write_setting(str(self.migrated))
        p = self.zusage.resolve_db_path(
            env={"ZCODE_DATA_BASE_DIR": str(self.home)}, home=self.home)
        self.assertEqual(p, self.expect(self.migrated))

    def test_windows_drive_and_unc_values_accepted(self):
        self.write_setting("D:\\data")
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        # POSIX 上不解析盘符路径，只验证该值被采纳为基目录（真实展开在 Windows Python）
        self.assertTrue(str(p).startswith("D:"))
        self.write_setting("\\\\server\\share")
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        self.assertTrue(str(p).startswith("\\\\"))

    def test_relative_databasedir_ignored_falls_to_env(self):
        self.write_setting("relative/dir")
        p = self.zusage.resolve_db_path(
            env={"ZCODE_DATA_BASE_DIR": str(self.migrated)}, home=self.home)
        self.assertEqual(p, self.expect(self.migrated))

    def test_relative_databasedir_and_no_env_falls_to_home(self):
        self.write_setting("relative/dir")
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        self.assertEqual(p, self.expect(self.home))

    def test_corrupted_setting_json_falls_to_env(self):
        f = self.home / ".zcode" / "v2" / "setting.json"
        f.write_text("{not json", encoding="utf-8")
        p = self.zusage.resolve_db_path(
            env={"ZCODE_DATA_BASE_DIR": str(self.migrated)}, home=self.home)
        self.assertEqual(p, self.expect(self.migrated))

    def test_bom_tolerated(self):
        self.write_setting(str(self.migrated), encoding="utf-8-sig")
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        self.assertEqual(p, self.expect(self.migrated))

    def test_non_string_and_empty_databasedir_ignored(self):
        f = self.home / ".zcode" / "v2" / "setting.json"
        f.write_text(json.dumps({"dataBaseDir": 123}), encoding="utf-8")
        p = self.zusage.resolve_db_path(
            env={"ZCODE_DATA_BASE_DIR": str(self.migrated)}, home=self.home)
        self.assertEqual(p, self.expect(self.migrated))
        self.write_setting("")
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        self.assertEqual(p, self.expect(self.home))

    def test_env_only(self):
        p = self.zusage.resolve_db_path(
            env={"ZCODE_DATA_BASE_DIR": str(self.migrated)}, home=self.home)
        self.assertEqual(p, self.expect(self.migrated))

    def test_missing_setting_file(self):
        p = self.zusage.resolve_db_path(env={}, home=self.home / "nowhere")
        self.assertEqual(p, self.expect(self.home / "nowhere"))


class ModuleWiringTest(unittest.TestCase):
    """模块级 DB_PATH 接线：导入即按解析器取路径，不等首次查询。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir(parents=True)
        self.migrated = Path(self.tmp.name) / "migrated"

    def test_zusage_db_path_follows_env_at_import(self):
        env = {"ZCODE_DATA_BASE_DIR": str(self.migrated)}
        with mock.patch.dict("os.environ", env), \
                mock.patch("pathlib.Path.home", return_value=self.home):
            mod = load_module("zusage_wired", REPO / "zusage.py")
        self.assertEqual(mod.DB_PATH,
                         self.migrated / ".zcode" / "cli" / "db" / "db.sqlite")

    def test_token_rate_default_follows_env_keeps_usage_db_override(self):
        env = {"ZCODE_DATA_BASE_DIR": str(self.migrated)}
        with mock.patch.dict("os.environ", env), \
                mock.patch("pathlib.Path.home", return_value=self.home):
            mod = load_module("token_rate_wired", REPO / "token_rate.py")
        self.assertEqual(Path(mod.DB_PATH),
                         self.migrated / ".zcode" / "cli" / "db" / "db.sqlite")
        # ZCODE_USAGE_DB 仍是最高优先（插件逐问脚本隔离接缝，AGENTS §6）
        env["ZCODE_USAGE_DB"] = str(self.home / "explicit.sqlite")
        with mock.patch.dict("os.environ", env), \
                mock.patch("pathlib.Path.home", return_value=self.home):
            mod = load_module("token_rate_wired2", REPO / "token_rate.py")
        self.assertEqual(Path(mod.DB_PATH), self.home / "explicit.sqlite")


class CrossFileConsistencyTest(unittest.TestCase):
    """zusage.resolve_db_path 与 token_rate._default_db_path 是两份同源实现，行为须一致。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        (self.home / ".zcode" / "v2").mkdir(parents=True)
        self.migrated = Path(self.tmp.name) / "migrated"
        self.zusage = load_module("zusage_sync", REPO / "zusage.py")
        self.token_rate = load_module("token_rate_sync", REPO / "token_rate.py")

    def write_setting(self, value):
        f = self.home / ".zcode" / "v2" / "setting.json"
        f.write_text(json.dumps({"dataBaseDir": value}), encoding="utf-8")

    def test_same_result_across_scenarios(self):
        scenarios = [
            ({}, None),
            ({"ZCODE_DATA_BASE_DIR": str(self.migrated)}, None),
            ({"ZCODE_DATA_BASE_DIR": str(self.home)}, str(self.migrated)),
            ({"ZCODE_DATA_BASE_DIR": str(self.migrated)}, "relative/dir"),
        ]
        for env, setting in scenarios:
            if setting is not None:
                self.write_setting(setting)
            else:
                f = self.home / ".zcode" / "v2" / "setting.json"
                if f.exists():
                    f.unlink()
            a = self.zusage.resolve_db_path(env=env, home=self.home)
            b = self.token_rate._default_db_path(env=env, home=self.home)
            self.assertEqual(a, b, msg=f"env={env} setting={setting}")


if __name__ == "__main__":
    unittest.main()
