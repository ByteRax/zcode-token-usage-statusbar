# -*- coding: utf-8 -*-
"""issue #163：usage_mcp 启动时复活待收尾包监控（独立链无 SessionStart hook，
monitor 被关闭后 pending 永久搁浅——MCP 进程由宿主随会话启动拉起，是独立链
唯一的会话级补救入口）。夹具与 test_quiet_monitor 同款：临时 asar + 真 sidecar。"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class ReviveMonitorTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir()
        home = mock.patch.dict(os.environ, {"HOME": str(self.home), "USERPROFILE": str(self.home)})
        home.start()
        self.addCleanup(home.stop)
        self.asar = self.root / "app.asar"
        self.asar.write_bytes(b"official version")
        self.data_dir = self.home / ".zcode" / "zcode-token-usage-statusbar"
        self.data_dir.mkdir(parents=True)
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        self.usage_mcp = module("revive_usage_mcp_test", ROOT / "usage_mcp.py")
        self.patch = module("revive_patch_test", ROOT / "patch_install.py")
        self.patch.set_target(self.asar)
        self.patch.set_runtime(self.data_dir)

    def write_config(self, directory, **changes):
        cfg = {"asar_path": str(self.asar)}
        cfg.update(changes)
        (directory / "config.json").write_text(json.dumps(cfg), encoding="utf-8")

    def pending(self):
        source = self.patch.source_fingerprint(self.asar)
        tmp = self.asar.with_name("app.asar.zusage.tmp")
        tmp.write_bytes(b"pending package")
        with mock.patch.object(self.patch, "self_check", return_value=True), \
                mock.patch.object(self.patch, "syntax_check", return_value=True):
            self.patch.write_tmp_metadata(source, "install")

    def revive(self, usage_mcp_dir):
        """以 usage_mcp 位于 usage_mcp_dir 的形态执行 revive，返回 (launch_mock, 捕获的调用时环境)。"""
        captured = {}

        def launch(epoch):
            captured["quiet"] = os.environ.get("ZUSAGE_MONITOR_QUIET")

        with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                mock.patch.dict(os.environ, {"ZUSAGE_MONITOR_QUIET": ""}), \
                mock.patch.object(self.usage_mcp, "__file__", str(usage_mcp_dir / "usage_mcp.py")), \
                mock.patch.object(self.patch, "launch_monitor", side_effect=launch) as launch_mock:
            self.usage_mcp.revive_finalize_monitor()
        return launch_mock, captured

    def cancel_pending(self):
        """把待收尾 sidecar 翻成 cancelled（optout/remove 撤销后的遗留 journal）。"""
        meta = json.loads(self.asar.with_name("app.asar.zusage.tmp.json").read_text(encoding="utf-8"))
        meta["operation"] = "cancelled"
        self.asar.with_name("app.asar.zusage.tmp.json").write_text(json.dumps(meta), encoding="utf-8")

    def test_pending_without_monitor_is_revived_quietly(self):
        # 独立链形态：usage_mcp 与 config 同在运行目录，revive 以该目录为 RUNTIME。
        self.write_config(self.runtime)
        self.pending()
        launch, captured = self.revive(self.runtime)
        self.assertEqual(launch.call_count, 1)
        self.assertEqual(captured["quiet"], "1")   # 静默收尾，不弹窗打断查询
        self.assertEqual(self.patch.RUNTIME.resolve(), self.runtime.resolve())

    def test_plugin_layout_falls_back_to_standard_data_dir(self):
        # 插件链形态：usage_mcp 在插件目录（无 config.json），config 回退标准数据
        # 目录——RUNTIME 必须跟随 config 所在目录（sidecar 记录的运行时目录），
        # 用插件目录会被收尾来源授权拒绝。
        plugin_dir = self.root / "plugin-cache"
        plugin_dir.mkdir()
        self.write_config(self.data_dir)
        self.pending()
        launch, _ = self.revive(plugin_dir)
        self.assertEqual(launch.call_count, 1)
        self.assertEqual(self.patch.RUNTIME.resolve(), self.data_dir.resolve())

    def test_no_pending_package_does_not_spawn(self):
        self.write_config(self.runtime)
        launch, _ = self.revive(self.runtime)
        launch.assert_not_called()

    def test_cancelled_journal_is_not_a_pending_package(self):
        # review 2026-10-31：cancelled 的 journal（卸载撤销/发布中断遗留）不是待收尾
        # 包——拉起只会得到一个被来源授权立即拒绝退出的监控进程，每次会话白拉一个。
        self.write_config(self.runtime)
        self.pending()
        self.cancel_pending()
        launch, _ = self.revive(self.runtime)
        launch.assert_not_called()

    def test_launch_failure_hint_never_reaches_stdout(self):
        # launch_monitor 的启动失败提示（OSError 分支）若落进 stdout 会污染 stdio
        # JSON-RPC 通道；revive 必须把它重定向到 stderr。
        self.write_config(self.runtime)
        self.pending()
        stdout = io.StringIO()
        with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                mock.patch.dict(os.environ, {"ZUSAGE_MONITOR_QUIET": ""}), \
                mock.patch.object(self.usage_mcp, "__file__", str(self.runtime / "usage_mcp.py")), \
                mock.patch.object(self.patch.subprocess, "Popen", side_effect=OSError("boom")), \
                contextlib.redirect_stdout(stdout):
            self.usage_mcp.revive_finalize_monitor()
        self.assertEqual(stdout.getvalue(), "")   # stdout 协议通道零污染

    def test_missing_config_or_asar_record_skips_revive(self):
        for describe, setup in (("no config file", lambda: None),
                                ("config without asar_path", lambda: self.write_config(self.runtime, asar_path=None))):
            with self.subTest(describe=describe):
                setup()
                launch, _ = self.revive(self.runtime)
                launch.assert_not_called()

    def test_held_monitor_lock_prevents_second_revive(self):
        # 已有监控存活（实例锁被持有）：不叠加进程。
        self.write_config(self.runtime)
        self.pending()
        with self.patch.monitor_instance_lock() as acquired:
            self.assertTrue(acquired)
            launch, _ = self.revive(self.runtime)
        launch.assert_not_called()

    def test_revive_failure_never_breaks_the_server(self):
        # config 损坏：revive 必须静默吞掉（诊断走 stderr），不影响 MCP 查询服务。
        (self.runtime / "config.json").write_text("{not json", encoding="utf-8")
        launch, _ = self.revive(self.runtime)
        launch.assert_not_called()
        with mock.patch.object(sys, "stdin", io.StringIO("")):
            self.usage_mcp.main()   # 不抛出即通过：坏 config 不带崩 server


if __name__ == "__main__":
    unittest.main()
