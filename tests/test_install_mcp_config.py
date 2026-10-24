# -*- coding: utf-8 -*-
"""install.py 宿主 config.json 写入契约回归（2026-10-24 夜间扫描）。

覆盖：
- 旧 MCP 注册名迁移用原始字符串遍历匹配（json.dumps 转义反斜杠，Windows 路径永不命中）。
- 合法 JSON 非对象 → 拒绝改写（不裸崩 AttributeError、不默默重建）。
- --dry-run 不创建 ~/.zcode/commands 目录（帮助文本承诺不写任何文件）。
- 写入走同目录临时文件 + os.replace（截断写窗口消除）。

运行：python3 -B -m unittest discover -s tests -p 'test_install_mcp_config.py'
"""
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("install_mcp_config_test", ROOT / "install.py")
installer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(installer)


class McpConfigTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.home = self.root / "home"
        self.here = self.root / "repo"
        self.data = self.root / "data"
        for d in (self.home, self.here, self.data):
            d.mkdir(parents=True)
        (self.here / "usage.command.md").write_text("# /usage\n", encoding="utf-8")
        self.config = self.home / ".zcode" / "cli" / "config.json"
        self.config.parent.mkdir(parents=True)
        self.commands = self.home / ".zcode" / "commands"
        for p, v in ((installer, "ZCODE_CONFIG"), (installer, "DATA_DIR"), (installer, "HERE"), (installer, "COMMANDS_DIR")):
            patcher = mock.patch.object(p, v, {"ZCODE_CONFIG": self.config, "DATA_DIR": self.data,
                                               "HERE": self.here, "COMMANDS_DIR": self.commands}[v])
            patcher.start()
            self.addCleanup(patcher.stop)
        sudo = mock.patch.object(installer, "_sudo_user", lambda: None)   # 防真实 sudo 环境走 chown 分支
        sudo.start()
        self.addCleanup(sudo.stop)

    def test_old_name_migration_matches_windows_backslash_paths(self):
        data_dir = Path(r"C:\Users\u\zcode-plugin")
        win_path = str(data_dir / "usage_mcp.py")   # 与 install.py 拼接 ours 的同一形式
        self.config.write_text(json.dumps({"mcp": {"servers": {
            "token-usage": {"command": r"C:\Python39\python.exe", "args": [win_path]},
        }}}), encoding="utf-8")
        with mock.patch.object(installer, "DATA_DIR", data_dir), mock.patch("builtins.print"):
            ok = installer.register_mcp(dry=False, dev=False)
        self.assertTrue(ok)
        data = json.loads(self.config.read_text(encoding="utf-8"))
        self.assertNotIn("token-usage", data["mcp"]["servers"],
                         "旧注册被迁移移除（曾因 json.dumps 反斜杠转义永不匹配而残留）")
        self.assertIn(installer.MCP_NAME, data["mcp"]["servers"])

    def test_non_object_config_is_rejected_not_crashing(self):
        self.config.write_text(json.dumps(["not", "an", "object"]), encoding="utf-8")
        with mock.patch("builtins.print"):
            self.assertFalse(installer.register_mcp(dry=False, dev=False))
        self.assertEqual(json.loads(self.config.read_text(encoding="utf-8")), ["not", "an", "object"],
                         "非对象配置不被改写也不被重建")
        with mock.patch("builtins.print"):
            self.assertFalse(installer.remove_mcp(dry=False))
        self.assertEqual(json.loads(self.config.read_text(encoding="utf-8")), ["not", "an", "object"])

    def test_dry_run_does_not_create_commands_dir(self):
        with mock.patch("builtins.print"):
            self.assertTrue(installer.install_command(dry=True))
        self.assertFalse(self.commands.exists(), "dry-run 承诺不写任何文件（含建目录）")
        self.assertTrue(installer.install_command(dry=False))
        self.assertTrue((self.commands / "usage.md").exists())

    def test_config_write_is_atomic_same_dir_replace(self):
        self.config.write_text(json.dumps({"mcp": {"servers": {}}}), encoding="utf-8")
        real_replace, replaced = os.replace, []

        def spy(src, dst):
            replaced.append((Path(src).parent, Path(dst)))
            return real_replace(src, dst)

        with mock.patch.object(installer.os, "replace", side_effect=spy), mock.patch("builtins.print"):
            self.assertTrue(installer.register_mcp(dry=False, dev=False))
        self.assertEqual(len(replaced), 1, "写入经同目录临时文件 + os.replace")
        self.assertEqual(replaced[0][0], self.config.parent, "临时文件与目标同目录")
        self.assertEqual(replaced[0][1], self.config)
        data = json.loads(self.config.read_text(encoding="utf-8"))
        self.assertIn(installer.MCP_NAME, data["mcp"]["servers"])
        self.assertFalse(list(self.config.parent.glob("*.zusage.tmp")), "不留临时文件")

    def test_atomic_write_preserves_original_file_mode(self):
        import stat as stat_mod
        self.config.write_text(json.dumps({"mcp": {"servers": {}}}), encoding="utf-8")
        self.config.chmod(0o600)
        with mock.patch("builtins.print"):
            self.assertTrue(installer.register_mcp(dry=False, dev=False))
        self.assertEqual(stat_mod.S_IMODE(self.config.stat().st_mode), 0o600,
                         "os.replace 按新文件落权限，须按原 mode 归位（umask 不放宽 0600）")

    def test_non_object_mcp_sections_are_rejected(self):
        for body in ({"mcp": "oops"}, {"mcp": {"servers": [1, 2]}}, {"mcp": []}):
            self.config.write_text(json.dumps(body), encoding="utf-8")
            with mock.patch("builtins.print"):
                self.assertFalse(installer.register_mcp(dry=False, dev=False), body)
            self.assertEqual(json.loads(self.config.read_text(encoding="utf-8")), body, "异常段不重建不崩")


if __name__ == "__main__":
    unittest.main()
