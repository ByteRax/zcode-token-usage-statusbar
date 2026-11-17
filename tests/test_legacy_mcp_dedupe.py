# -*- coding: utf-8 -*-
"""插件渠道清理独立安装遗留 MCP 注册的回归。

背景：仓库根 install.py 会把 MCP 服务写进 ~/.zcode/cli/config.json 的 mcp.servers；
插件渠道另由 .mcp.json 注册同一工具。两条渠道并存时宿主每个会话各拉起一份
usage_mcp.py（插件侧还多一个 node 包装），内存翻倍。插件 SessionStart 只清理
指向本插件脚本的遗留条目，其它 MCP 一律不动。

运行：python3 -B -m unittest discover -s tests -p 'test_legacy_mcp_dedupe.py'
"""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.helpers.py_test_support import load_module

PLUGIN = Path(__file__).resolve().parents[1] / "plugins" / "zcode-token-usage-statusbar"


class LegacyMcpDedupeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / "home"
        self.runtime = self.home / ".zcode" / "zcode-token-usage-statusbar"
        self.plugin_root = self.root / "plugin-cache"
        self.config = self.root / "cli-config.json"
        for directory in (self.home, self.runtime, self.plugin_root):
            directory.mkdir(parents=True)
        self.module = load_module("legacy_mcp_installer", PLUGIN / "overlay_install.py")
        environment = {"ZUSAGE_PLUGIN_HOST_CONFIG": str(self.config),
                       "ZUSAGE_PLUGIN_RUNTIME": str(self.runtime),
                       "PYTHONDONTWRITEBYTECODE": "1"}
        patcher = mock.patch.dict(os.environ, environment)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("ZUSAGE_KEEP_LEGACY_MCP", None)

    def write_servers(self, servers):
        self.config.write_text(json.dumps({"mcp": {"servers": servers}}, ensure_ascii=False, indent=2),
                               encoding="utf-8")

    def read_servers(self):
        return json.loads(self.config.read_text(encoding="utf-8"))["mcp"]["servers"]

    def entry(self, script=None, **extra):
        data = {"command": "C:\\Python314\\python.exe", "args": [str(script or self.runtime / "usage_mcp.py")]}
        data.update(extra)
        return data

    def dedupe(self):
        return self.module.dedupe_legacy_mcp(self.runtime, plugin_root=self.plugin_root)

    def test_removes_legacy_registration_and_keeps_other_servers(self):
        self.write_servers({"zcode-token-usage-statusbar": self.entry(),
                            "other-tool": {"command": "node", "args": ["other.js"]}})
        with mock.patch("sys.stderr"):
            self.assertEqual(self.dedupe(), "removed")
        servers = self.read_servers()
        self.assertNotIn("zcode-token-usage-statusbar", servers)
        self.assertEqual(servers["other-tool"], {"command": "node", "args": ["other.js"]},
                         "用户其它 MCP 服务不得被动")

    def test_removes_historical_registration_names(self):
        self.write_servers({"token-usage": self.entry(),
                            "zusage": self.entry(self.plugin_root / "usage_mcp.py"),
                            "keep": {"command": "node", "args": ["keep.js"]}})
        with mock.patch("sys.stderr"):
            self.assertEqual(self.dedupe(), "removed")
        self.assertEqual(self.read_servers(), {"keep": {"command": "node", "args": ["keep.js"]}},
                         "历史名 token-usage/zusage 与插件目录副本都要清掉")

    def test_keeps_same_name_pointing_elsewhere(self):
        foreign = self.root / "some-other-project" / "usage_mcp.py"
        self.write_servers({"zusage": self.entry(foreign)})
        before = self.config.read_bytes()
        self.assertEqual(self.dedupe(), "absent")
        self.assertEqual(self.config.read_bytes(), before, "同名但指向别处的服务不得删除")

    def test_keeps_entry_with_custom_keys(self):
        self.write_servers({"zcode-token-usage-statusbar": self.entry(env={"FOO": "bar"})})
        before = self.config.read_bytes()
        self.assertEqual(self.dedupe(), "absent")
        self.assertEqual(self.config.read_bytes(), before, "带自定义键的条目可能是用户手改的，保留")

    def test_absent_leaves_file_mtime_untouched(self):
        self.write_servers({"other-tool": {"command": "node", "args": ["other.js"]}})
        before = self.config.stat().st_mtime_ns
        self.assertEqual(self.dedupe(), "absent")
        self.assertEqual(self.config.stat().st_mtime_ns, before, "无遗留项时不重写宿主配置")
        self.assertFalse(self.config.with_name(self.config.name + ".zusage-mcp.bak").exists())

    def test_invalid_json_is_never_rewritten(self):
        self.config.write_text("{not-json", encoding="utf-8")
        self.assertEqual(self.dedupe(), "skipped-invalid")
        self.assertEqual(self.config.read_text(encoding="utf-8"), "{not-json")

    def test_non_object_mcp_section_is_never_rewritten(self):
        self.config.write_text(json.dumps({"mcp": {"servers": ["not", "an", "object"]}}), encoding="utf-8")
        before = self.config.read_bytes()
        self.assertEqual(self.dedupe(), "skipped-invalid")
        self.assertEqual(self.config.read_bytes(), before, "结构异常不猜、不重建")

    def test_backup_keeps_pre_change_content(self):
        original = {"zcode-token-usage-statusbar": self.entry(), "other": {"command": "node", "args": ["o.js"]}}
        self.write_servers(original)
        with mock.patch("sys.stderr"):
            self.assertEqual(self.dedupe(), "removed")
        backup = json.loads(self.config.with_name(self.config.name + ".zusage-mcp.bak")
                            .read_text(encoding="utf-8"))
        self.assertEqual(backup["mcp"]["servers"], original, "备份必须是改前内容，供手动恢复")

    def test_idempotent_second_run_is_absent(self):
        self.write_servers({"zcode-token-usage-statusbar": self.entry()})
        with mock.patch("sys.stderr"):
            self.assertEqual(self.dedupe(), "removed")
        before = self.config.stat().st_mtime_ns
        self.assertEqual(self.dedupe(), "absent")
        self.assertEqual(self.config.stat().st_mtime_ns, before)

    def test_escape_hatch_keeps_registration(self):
        self.write_servers({"zcode-token-usage-statusbar": self.entry()})
        before = self.config.read_bytes()
        with mock.patch.dict(os.environ, {"ZUSAGE_KEEP_LEGACY_MCP": "1"}):
            self.assertEqual(self.dedupe(), "skipped-env")
        self.assertEqual(self.config.read_bytes(), before)

    def test_no_temporary_files_left_behind(self):
        self.write_servers({"zcode-token-usage-statusbar": self.entry()})
        with mock.patch("sys.stderr"):
            self.assertEqual(self.dedupe(), "removed")
        leftovers = [path.name for path in self.config.parent.iterdir()
                     if path.name.startswith("." + self.config.name + ".")]
        self.assertEqual(leftovers, [], "原子写入不留临时文件")

    def test_keeps_runtime_file_that_is_not_usage_mcp(self):
        # 文件名门：历史名条目指向运行目录内其它文件（如常驻查询脚本）不得误删。
        self.write_servers({"zusage": self.entry(self.runtime / "zusage.py")})
        before = self.config.read_bytes()
        self.assertEqual(self.dedupe(), "absent")
        self.assertEqual(self.config.read_bytes(), before)

    def test_keeps_non_history_name_pointing_at_plugin_script(self):
        # 名字门：白名单外的自定义名即使指向本插件脚本也保留。
        self.write_servers({"my-own-zusage": self.entry()})
        before = self.config.read_bytes()
        self.assertEqual(self.dedupe(), "absent")
        self.assertEqual(self.config.read_bytes(), before)

    def test_lock_is_acquired_before_writing(self):
        # 并发保护：写入前必须在运行目录锁内（file_lock 被调用且路径正确）。
        self.write_servers({"zcode-token-usage-statusbar": self.entry()})
        spy = mock.MagicMock(wraps=self.module.file_lock)
        with mock.patch.object(self.module, "file_lock", spy), mock.patch("sys.stderr"):
            self.assertEqual(self.dedupe(), "removed")
        self.assertEqual(spy.call_count, 1)
        self.assertEqual(Path(spy.call_args[0][0]), self.runtime / "legacy-mcp.lock")

    def test_busy_lock_returns_skipped_locked(self):
        self.write_servers({"zcode-token-usage-statusbar": self.entry()})
        before = self.config.read_bytes()
        with mock.patch.object(self.module, "file_lock", side_effect=TimeoutError("busy")), \
                mock.patch("sys.stderr"):
            self.assertEqual(self.dedupe(), "skipped-locked")
        self.assertEqual(self.config.read_bytes(), before, "锁忙时不得改写宿主配置")
        self.assertFalse(self.config.with_name(self.config.name + ".zusage-mcp.bak").exists())

    def test_non_object_mcp_section_itself_is_never_rewritten(self):
        self.config.write_text(json.dumps({"mcp": "not-an-object"}), encoding="utf-8")
        before = self.config.read_bytes()
        self.assertEqual(self.dedupe(), "skipped-invalid")
        self.assertEqual(self.config.read_bytes(), before, "mcp 段本身非对象也按结构异常保留")

    @unittest.skipUnless(os.name == "nt", "Windows 路径分隔符归一")
    def test_windows_backslash_path_is_recognized(self):
        script = str(self.runtime / "usage_mcp.py").replace("/", "\\")
        self.write_servers({"zcode-token-usage-statusbar": self.entry(script)})
        with mock.patch("sys.stderr"):
            self.assertEqual(self.dedupe(), "removed")


if __name__ == "__main__":
    unittest.main()
