#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""issue #279 及查漏补缺：本地用量库路径解析（宿主 agent 会话库镜像序）。

宿主写 model_usage 的是 agent 进程，其库路径链（v3.17.1
packages/services/src/onboarding/localUsageEvidence.resolveAgentSessionDbPath；
3.18.0 bundle 复核仍只认 env/CLI config/HOME 默认，不消费 dataBaseDir）
不消费 dataBaseDir：env ZCODE_SESSION_DB_PATH / ZCODE_SESSION_DB（双别名按 env
键序取后）→ ~/.zcode/cli/config.json 的 storage.sessionDbPath（CLI config 恒在
HOME 不随迁）→ 默认 ~/.zcode/cli/db/db.sqlite。3.17.x 实测迁移用户库又在
<dataBaseDir>/.zcode/cli/db/db.sqlite（copyDataDirectory 不搬 .zcode/cli）——
第 3 级做存在性兼容；但「该位置有库必为真实写入位」被 issue #294 证伪（陈旧
迁移库 + HOME 活跃库并存），两库并存时按写入新鲜度仲裁（db.sqlite/-wal 最新
mtime，-shm 不算；候选不落后才采纳，HOME 库未建仍采纳）。规格见
specs/db-path-stale-arbitration.md。zusage.py 与 token_rate.py 各自内联同源
实现，本文件锁定解析顺序、容错、新鲜度仲裁与两份实现的一致性。

运行：python3 -B -m unittest discover -s tests -p 'test_*.py'
"""
import json
import os
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
        (self.home / ".zcode" / "cli").mkdir(parents=True)
        self.migrated = Path(self.tmp.name) / "migrated"
        self.migrated_db = self.migrated / ".zcode" / "cli" / "db" / "db.sqlite"
        self.zusage = load_module("zusage_dbpath", REPO / "zusage.py")

    def write_setting(self, data_base_dir, encoding="utf-8"):
        f = self.home / ".zcode" / "v2" / "setting.json"
        f.write_text(json.dumps({"dataBaseDir": data_base_dir}), encoding=encoding)

    def write_cli_config(self, session_db_path):
        f = self.home / ".zcode" / "cli" / "config.json"
        payload = {"storage": {"sessionDbPath": session_db_path}} if session_db_path is not None \
            else {"other": True}
        f.write_text(json.dumps(payload), encoding="utf-8")

    def touch_migrated_db(self):
        self.migrated_db.parent.mkdir(parents=True, exist_ok=True)
        self.migrated_db.write_bytes(b"")

    def touch_home_db(self):
        db = self.home / ".zcode" / "cli" / "db" / "db.sqlite"
        db.parent.mkdir(parents=True, exist_ok=True)
        db.write_bytes(b"")
        return db

    @staticmethod
    def stamp(path, sec):
        os.utime(path, (sec, sec))

    def expect(self, base):
        return Path(base) / ".zcode" / "cli" / "db" / "db.sqlite"

    # ---- 第 1 级：env ZCODE_SESSION_DB_PATH / ZCODE_SESSION_DB ----

    def test_env_session_db_path_absolute_wins(self):
        p = self.zusage.resolve_db_path(
            env={"ZCODE_SESSION_DB_PATH": str(self.migrated_db)}, home=self.home)
        self.assertEqual(p, self.migrated_db)

    def test_env_session_db_alias(self):
        p = self.zusage.resolve_db_path(
            env={"ZCODE_SESSION_DB": str(self.migrated_db)}, home=self.home)
        self.assertEqual(p, self.migrated_db)

    def test_env_double_alias_later_key_wins(self):
        # 宿主 env adapter 按键序赋值（后者覆盖）：两个都设时取 env 键序靠后的
        p = self.zusage.resolve_db_path(env={
            "ZCODE_SESSION_DB_PATH": str(self.migrated_db),
            "ZCODE_SESSION_DB": str(self.home / "later.sqlite"),
        }, home=self.home)
        self.assertEqual(p, self.home / "later.sqlite")
        p = self.zusage.resolve_db_path(env={
            "ZCODE_SESSION_DB": str(self.home / "later.sqlite"),
            "ZCODE_SESSION_DB_PATH": str(self.migrated_db),
        }, home=self.home)
        self.assertEqual(p, self.migrated_db)

    def test_env_double_alias_later_blank_discards_source(self):
        # 后一个别名为空值：宿主 pickEnvSessionDbPath 取后（含空）再判空 → 弃用整个
        # env 来源落 config/默认；不得回取前一个非空别名（与 agent 实际写库位一致）。
        # 空串（非空白）才能区分旧「跳过 falsy 取前非空」语义，故诱饵路径 + '' 都要用。
        decoy = self.home / "decoy" / "db.sqlite"
        self.touch_migrated_db()
        self.write_setting(str(self.migrated))
        p = self.zusage.resolve_db_path(env={
            "ZCODE_SESSION_DB_PATH": str(decoy),
            "ZCODE_SESSION_DB": "",
        }, home=self.home)
        self.assertEqual(p, self.migrated_db)
        p = self.zusage.resolve_db_path(env={
            "ZCODE_SESSION_DB_PATH": str(decoy),
            "ZCODE_SESSION_DB": "  ",
        }, home=self.home)
        self.assertEqual(p, self.migrated_db)

    def test_env_session_db_tilde_expanded(self):
        p = self.zusage.resolve_db_path(
            env={"ZCODE_SESSION_DB_PATH": "~/custom/db.sqlite"}, home=self.home)
        self.assertEqual(p, self.home / "custom" / "db.sqlite")

    def test_env_session_db_relative_ignored(self):
        # 相对路径宿主按 agent 工作区 cwd 解析、无法镜像：忽略该来源逐级回落
        p = self.zusage.resolve_db_path(
            env={"ZCODE_SESSION_DB_PATH": "relative/db.sqlite"}, home=self.home)
        self.assertEqual(p, self.expect(self.home))

    def test_env_session_db_blank_ignored(self):
        p = self.zusage.resolve_db_path(env={"ZCODE_SESSION_DB_PATH": "   "}, home=self.home)
        self.assertEqual(p, self.expect(self.home))

    def test_env_session_db_windows_drive_accepted(self):
        p = self.zusage.resolve_db_path(
            env={"ZCODE_SESSION_DB_PATH": "D:\\data\\db.sqlite"}, home=self.home)
        self.assertTrue(str(p).startswith("D:"))

    # ---- 第 2 级：~/.zcode/cli/config.json 的 storage.sessionDbPath ----

    def test_cli_config_session_db_path_wins(self):
        self.write_cli_config("~/custom/db.sqlite")
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        self.assertEqual(p, self.home / "custom" / "db.sqlite")

    def test_cli_config_absolute_wins(self):
        self.write_cli_config(str(self.migrated_db))
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        self.assertEqual(p, self.migrated_db)

    def test_cli_config_relative_ignored(self):
        self.write_cli_config("relative/db.sqlite")
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        self.assertEqual(p, self.expect(self.home))

    def test_cli_config_corrupted_ignored(self):
        f = self.home / ".zcode" / "cli" / "config.json"
        f.write_text("{broken", encoding="utf-8")
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        self.assertEqual(p, self.expect(self.home))

    def test_cli_config_beats_databasedir_existing(self):
        # 显式 CLI 配置优先于 dataBaseDir 存在性分支
        self.touch_migrated_db()
        self.write_setting(str(self.migrated))
        self.write_cli_config("~/custom/db.sqlite")
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        self.assertEqual(p, self.home / "custom" / "db.sqlite")

    # ---- 第 3 级：dataBaseDir 迁移目录（存在性兼容）----

    def test_databasedir_with_existing_db_wins(self):
        self.touch_migrated_db()
        self.write_setting(str(self.migrated))
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        self.assertEqual(p, self.migrated_db)

    def test_databasedir_without_db_falls_back_to_home(self):
        # v3.17.1 宿主 agent 链不随迁：迁移目录无库时回落 HOME 默认
        self.write_setting(str(self.migrated))
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        self.assertEqual(p, self.expect(self.home))

    def test_env_data_base_dir_with_existing_db_wins(self):
        self.touch_migrated_db()
        p = self.zusage.resolve_db_path(
            env={"ZCODE_DATA_BASE_DIR": str(self.migrated)}, home=self.home)
        self.assertEqual(p, self.migrated_db)

    def test_setting_json_beats_env_data_base_dir(self):
        self.touch_migrated_db()
        other = Path(self.tmp.name) / "other"
        (other / ".zcode" / "cli" / "db").mkdir(parents=True)
        (other / ".zcode" / "cli" / "db" / "db.sqlite").write_bytes(b"")
        self.write_setting(str(self.migrated))
        p = self.zusage.resolve_db_path(
            env={"ZCODE_DATA_BASE_DIR": str(other)}, home=self.home)
        self.assertEqual(p, self.migrated_db)

    def test_databasedir_relative_rejected(self):
        self.write_setting("relative/dir")
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        self.assertEqual(p, self.expect(self.home))

    def test_databasedir_tilde_value_rejected(self):
        # dataBaseDir 只采纳绝对路径（宿主引导语义），~ 值不入存在性分支
        self.write_setting("~/abs-sub")
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        self.assertEqual(p, self.expect(self.home))

    def test_databasedir_corrupted_setting_falls_back(self):
        f = self.home / ".zcode" / "v2" / "setting.json"
        f.write_text("{not json", encoding="utf-8")
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        self.assertEqual(p, self.expect(self.home))

    def test_databasedir_corrupted_setting_env_marker_still_effective(self):
        # setting.json 损坏不连累 ZCODE_DATA_BASE_DIR 迁移标记（与 Node 侧同构）
        self.touch_migrated_db()
        f = self.home / ".zcode" / "v2" / "setting.json"
        f.write_text("{not json", encoding="utf-8")
        p = self.zusage.resolve_db_path(
            env={"ZCODE_DATA_BASE_DIR": str(self.migrated)}, home=self.home)
        self.assertEqual(p, self.migrated_db)

    def test_databasedir_bom_tolerated(self):
        self.touch_migrated_db()
        self.write_setting(str(self.migrated), encoding="utf-8-sig")
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        self.assertEqual(p, self.migrated_db)

    # ---- 第 3 级仲裁（issue #294）：两库并存按写入新鲜度取舍 ----

    def test_stale_migrated_db_falls_back_to_fresh_home(self):
        # #294 主场景：迁移目录库是历史遗留（更旧），写库方已在 HOME——读 HOME 默认库
        self.touch_migrated_db()
        home_db = self.touch_home_db()
        self.stamp(self.migrated_db, 1_700_000_000)
        self.stamp(home_db, 1_700_001_000)
        self.write_setting(str(self.migrated))
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        self.assertEqual(p, self.expect(self.home))

    def test_fresh_migrated_db_beats_home_by_wal(self):
        # #279 两库并存真迁移：候选库仅 -wal 更新也算持续写入，仍采纳候选
        self.touch_migrated_db()
        home_db = self.touch_home_db()
        self.stamp(self.migrated_db, 1_700_000_000)
        wal = self.migrated_db.parent / "db.sqlite-wal"
        wal.write_bytes(b"")
        self.stamp(wal, 1_700_002_000)
        self.stamp(home_db, 1_700_001_000)
        self.write_setting(str(self.migrated))
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        self.assertEqual(p, self.migrated_db)

    def test_stale_migrated_db_home_absent_still_adopted(self):
        # HOME 库未建：候选是唯一数据源，陈旧也采纳（#279 全数据在迁移目录）
        self.touch_migrated_db()
        self.stamp(self.migrated_db, 1_700_000_000)
        self.write_setting(str(self.migrated))
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        self.assertEqual(p, self.migrated_db)

    def test_shm_touch_does_not_count_as_write(self):
        # -shm 只读连接也会更新，不入仲裁：仅 -shm 新的候选仍视为陈旧
        self.touch_migrated_db()
        home_db = self.touch_home_db()
        self.stamp(self.migrated_db, 1_700_000_000)
        shm = self.migrated_db.parent / "db.sqlite-shm"
        shm.write_bytes(b"")
        self.stamp(shm, 1_700_003_000)
        self.stamp(home_db, 1_700_001_000)
        self.write_setting(str(self.migrated))
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        self.assertEqual(p, self.expect(self.home))

    def test_equal_freshness_tie_adopts_candidate(self):
        # 新鲜度恰等（mtime 粒度量化可出现）：按 >= 语义采纳候选，与旧存在性行为连续
        self.touch_migrated_db()
        home_db = self.touch_home_db()
        self.stamp(self.migrated_db, 1_700_000_000)
        self.stamp(home_db, 1_700_000_000)
        self.write_setting(str(self.migrated))
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        self.assertEqual(p, self.migrated_db)

    def test_explicit_env_source_skips_freshness_arbitration(self):
        # 规格产品规则 5：显式 env 来源不经仲裁——用户指定的库就是写库位，
        # 即便它比 HOME 默认库旧（变异：在第 1 级误加仲裁时本用例变红）
        self.touch_migrated_db()
        home_db = self.touch_home_db()
        self.stamp(self.migrated_db, 1_700_000_000)
        self.stamp(home_db, 1_700_001_000)
        p = self.zusage.resolve_db_path(
            env={"ZCODE_SESSION_DB_PATH": str(self.migrated_db)}, home=self.home)
        self.assertEqual(p, self.migrated_db)

    def test_explicit_cli_config_skips_freshness_arbitration(self):
        # 同上：CLI config storage.sessionDbPath 命中即返回，不与 HOME 库比新鲜度
        self.touch_migrated_db()
        home_db = self.touch_home_db()
        self.stamp(self.migrated_db, 1_700_000_000)
        self.stamp(home_db, 1_700_001_000)
        self.write_cli_config(str(self.migrated_db))
        p = self.zusage.resolve_db_path(env={}, home=self.home)
        self.assertEqual(p, self.migrated_db)

    def test_env_data_base_dir_stale_candidate_same_arbitration(self):
        # env 迁移标记与 setting.json 同走存在性分支，仲裁同款
        self.touch_migrated_db()
        home_db = self.touch_home_db()
        self.stamp(self.migrated_db, 1_700_000_000)
        self.stamp(home_db, 1_700_001_000)
        p = self.zusage.resolve_db_path(
            env={"ZCODE_DATA_BASE_DIR": str(self.migrated)}, home=self.home)
        self.assertEqual(p, self.expect(self.home))

    def test_missing_home_dirs_all_fall_back(self):
        p = self.zusage.resolve_db_path(env={}, home=self.home / "nowhere")
        self.assertEqual(p, (self.home / "nowhere") / ".zcode" / "cli" / "db" / "db.sqlite")


class ModuleWiringTest(unittest.TestCase):
    """模块级 DB_PATH 接线：导入即按解析器取路径，不等首次查询。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir(parents=True)
        self.db = self.home / "custom" / "db.sqlite"

    def test_zusage_db_path_follows_session_db_env_at_import(self):
        with mock.patch.dict("os.environ", {"ZCODE_SESSION_DB_PATH": str(self.db)}), \
                mock.patch("pathlib.Path.home", return_value=self.home):
            mod = load_module("zusage_wired", REPO / "zusage.py")
        self.assertEqual(mod.DB_PATH, self.db)

    def test_token_rate_db_path_follows_env_keeps_usage_db_override(self):
        env = {"ZCODE_SESSION_DB_PATH": str(self.db)}
        with mock.patch.dict("os.environ", env), \
                mock.patch("pathlib.Path.home", return_value=self.home):
            mod = load_module("token_rate_wired", REPO / "token_rate.py")
        self.assertEqual(Path(mod.DB_PATH), self.db)
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
        (self.home / ".zcode" / "cli").mkdir(parents=True)
        self.migrated = Path(self.tmp.name) / "migrated"
        self.migrated_db = self.migrated / ".zcode" / "cli" / "db" / "db.sqlite"
        self.zusage = load_module("zusage_sync", REPO / "zusage.py")
        self.token_rate = load_module("token_rate_sync", REPO / "token_rate.py")

    def write_setting(self, value, encoding="utf-8"):
        f = self.home / ".zcode" / "v2" / "setting.json"
        f.write_text(json.dumps({"dataBaseDir": value}), encoding=encoding)

    def write_cli_config(self, value):
        f = self.home / ".zcode" / "cli" / "config.json"
        f.write_text(json.dumps({"storage": {"sessionDbPath": value}}), encoding="utf-8")

    @staticmethod
    def stamp(path, sec):
        os.utime(path, (sec, sec))

    def assert_same(self, env, home=None):
        a = self.zusage.resolve_db_path(env=env, home=home or self.home)
        b = self.token_rate._default_db_path(env=env, home=home or self.home)
        self.assertEqual(a, b, msg=f"env={env}")

    def test_same_result_across_scenarios(self):
        scenarios = [
            {},
            {"ZCODE_SESSION_DB_PATH": str(self.migrated_db)},
            {"ZCODE_SESSION_DB": "~/custom/db.sqlite"},
            {"ZCODE_SESSION_DB_PATH": "relative/db.sqlite"},
            {"ZCODE_SESSION_DB_PATH": "   "},
            {"ZCODE_DATA_BASE_DIR": str(self.migrated)},
            {"ZCODE_SESSION_DB_PATH": str(self.migrated_db), "ZCODE_SESSION_DB": "~/custom/db.sqlite"},
            {"ZCODE_SESSION_DB_PATH": str(self.migrated_db), "ZCODE_SESSION_DB": ""},
        ]
        for env in scenarios:
            self.assert_same(env)
        # config.sessionDbPath（~/ 展开与相对忽略）
        self.write_cli_config("~/custom/db.sqlite")
        self.assert_same({})
        self.write_cli_config("relative/db.sqlite")
        self.assert_same({})
        (self.home / "custom").mkdir(parents=True, exist_ok=True)
        (self.home / "custom" / "db.sqlite").write_bytes(b"")
        # setting dataBaseDir：有库命中、无库回落
        f = self.home / ".zcode" / "cli" / "config.json"
        f.unlink()
        self.write_setting(str(self.migrated))
        self.assert_same({})
        self.migrated_db.parent.mkdir(parents=True, exist_ok=True)
        self.migrated_db.write_bytes(b"")
        self.assert_same({})
        self.assertEqual(self.token_rate._default_db_path(env={}, home=self.home),
                         self.migrated_db)
        # issue #294 两库并存仲裁：陈旧候选两份镜像同判回落 HOME；-wal 更新同判采纳候选
        home_db = self.home / ".zcode" / "cli" / "db" / "db.sqlite"
        home_db.parent.mkdir(parents=True, exist_ok=True)
        home_db.write_bytes(b"")
        self.stamp(self.migrated_db, 1_700_000_000)
        self.stamp(home_db, 1_700_001_000)
        self.assert_same({})
        self.assertEqual(self.zusage.resolve_db_path(env={}, home=self.home),
                         self.home / ".zcode" / "cli" / "db" / "db.sqlite")
        # 显式来源不经仲裁：env 指定较旧库仍原样返回（两镜像同判）
        self.assert_same({"ZCODE_SESSION_DB_PATH": str(self.migrated_db)})
        wal = self.migrated_db.parent / "db.sqlite-wal"
        wal.write_bytes(b"")
        self.stamp(wal, 1_700_002_000)
        self.assert_same({})
        self.assertEqual(self.token_rate._default_db_path(env={}, home=self.home),
                         self.migrated_db)
        # BOM 写入两份实现都必须容忍
        self.write_setting(str(self.migrated), encoding="utf-8-sig")
        self.assert_same({})


if __name__ == "__main__":
    unittest.main()
