# -*- coding: utf-8 -*-
"""SessionStart 输出通道回归；HOME、运行时和 asar 全部使用临时夹具。"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


PLUGIN = Path(__file__).resolve().parents[1] / "plugins" / "zcode-token-usage-statusbar"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SessionStartChannelTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / "home"
        self.runtime = self.root / "runtime"
        self.asar = self.root / "client" / "resources" / "app.asar"
        self.home.mkdir()
        self.runtime.mkdir()
        self.asar.parent.mkdir(parents=True)
        environment = {"HOME": str(self.home), "USERPROFILE": str(self.home),
                       "ZUSAGE_PLUGIN_RUNTIME": str(self.runtime), "ZUSAGE_PLUGIN_ASAR": str(self.asar),
                       "ZCODE_SESSION_ID": "sess_channel_test", "PYTHONDONTWRITEBYTECODE": "1",
                       # 子进程输出编码必须与父进程的解码一致：默认中文 Windows 上清空环境会
                       # 丢掉全局 PYTHONUTF8，子进程按 GBK 写中文诊断、父进程读线程按
                       # UTF-8 解码直接抛 UnicodeDecodeError（stdout 收成 None，测试炸在
                       # json.loads(None)）。补回 UTF-8 模式保证两种 locale 的机器行为一致。
                       "PYTHONUTF8": "1",
                       "PATH": os.environ.get("PATH", ""),
                       **{name: os.environ[name] for name in ("SystemRoot", "TEMP", "TMP")
                          if os.name == "nt" and name in os.environ}}
        self.patch(mock.patch.dict(os.environ, environment, clear=True))
        self.patch(mock.patch.object(sys, "path", list(sys.path)))
        self.installer = load_module("channel_installer", PLUGIN / "overlay_install.py")
        self.notice = load_module("channel_notice", PLUGIN / "restart_notice.py")
        self.pi = load_module("channel_patch_install", PLUGIN / "patch_install.py")
        self.hook = load_module("channel_session_start", PLUGIN / "hooks" / "session-start.py")
        self.updater = mock.Mock(spec=["start_auto_update"])
        self.rate = mock.Mock(spec=["write_session_state"])
        self.patch(mock.patch.dict(sys.modules, {"overlay_install": self.installer,
                   "restart_notice": self.notice, "plugin_auto_update": self.updater,
                   "token_rate": self.rate}))
        self.patch(mock.patch.object(self.installer, "load_patch_install", return_value=self.pi))
        self.sync = self.patch(mock.patch.object(self.installer, "sync_runtime", return_value={"changed": []}))
        self.install = self.patch(mock.patch.object(self.pi, "install", return_value=False))
        self.pi.set_runtime(self.runtime)
        self.pi.set_target(self.asar)
        self.make_asar()
        self.config = self.runtime / "config.json"
        self.config.write_text('{"plugin_auto_update": false, "python_path": "custom"}', encoding="utf-8")

    def patch(self, patcher):
        result = patcher.start()
        self.addCleanup(patcher.stop)
        return result

    def make_asar(self, injected=False):
        entry = b"official;" + (self.pi.INJECT_LINE.encode("utf-8") if injected else b"")
        header = {"files": {"out": {"files": {"main": {"files": {"index.js": {
            "offset": "0", "size": len(entry)}}}}}}}
        raw = json.dumps(header, separators=(",", ":")).encode("utf-8")
        aligned = (len(raw) + 7) // 4 * 4
        self.asar.write_bytes(struct.pack("<4I", 4, aligned + 4, aligned, len(raw)) + raw +
                              b"\0" * (aligned - len(raw) - 4) + entry)

    def invoke(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, "stdin", io.StringIO('{"source": "resume"}')), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.hook.main()
        output = json.loads(stdout.getvalue())
        self.assertEqual(stdout.getvalue(), json.dumps(output, ensure_ascii=False) + "\n")
        self.assertIsNot(output.get("continue"), False)
        self.assertNotEqual(output.get("decision"), "block")
        self.assertNotIn("stopReason", output)
        self.assertTrue(output["suppressOutput"])
        self.assertEqual(list(self.home.iterdir()), [])
        diagnostic = self.runtime / "plugin-session-start.json"
        if diagnostic.exists():
            record = json.loads(diagnostic.read_text(encoding="utf-8"))
            self.assertEqual(record["result"], output)
            self.assertEqual(record["source"], "resume")
            self.assertEqual(record["sessionId"], "sess_channel_test")
            self.assertEqual(record["pluginRoot"], str(PLUGIN))
            self.assertGreater(record["time"], 0)
        return output, stderr.getvalue()

    def context(self, output):
        specific = output.get("hookSpecificOutput")
        self.assertIsInstance(specific, dict, "SessionStart 提示不能只留在 systemMessage")
        self.assertEqual(specific["hookEventName"], "SessionStart")
        self.assertIsInstance(specific["additionalContext"], str)
        self.assertIn(output["systemMessage"], specific["additionalContext"])
        self.assertNotIn("additionalContext", output, "避免同一提示通过两个有效通道重复注入")
        return specific["additionalContext"]

    def test_run_hook_resolution_sync_and_install_errors_reach_context_and_diagnostic(self):
        for target in ("resolve_paths", "sync_runtime", "_install_overlay"):
            with self.subTest(target=target), mock.patch.object(
                    self.installer, target, side_effect=OSError("fixture denied: " + target)):
                before = self.asar.read_bytes()
                output, errors = self.invoke()
                self.assertIn("自检失败（已忽略）", self.context(output))
                self.assertIn("fixture denied: " + target, self.context(output))
                self.assertEqual(self.asar.read_bytes(), before)
                self.assertEqual(errors, "")
                self.assertTrue((self.runtime / "plugin-session-start.json").is_file())
        self.assertEqual(self.rate.write_session_state.call_count, 3)

    def test_entry_catches_unexpected_run_hook_failure_with_context_and_diagnostic(self):
        with mock.patch.object(self.installer, "run_hook", side_effect=RuntimeError("fixture bootstrap failed")):
            output, errors = self.invoke()
        self.assertIn("fixture bootstrap failed", self.context(output))
        self.assertEqual(errors, "")
        self.assertTrue((self.runtime / "plugin-session-start.json").is_file())

    def test_entry_import_failure_keeps_json_and_context_without_notice_helper(self):
        with mock.patch.dict(sys.modules, {"overlay_install": None, "restart_notice": None}):
            output, errors = self.invoke()
        self.assertIn("自检失败（已忽略）", self.context(output))
        self.assertIn("会话启动诊断写入失败", errors)
        self.assertFalse((self.runtime / "plugin-session-start.json").exists())

    def test_diagnostic_failure_does_not_hide_error_context_or_pollute_stdout(self):
        self.sync.side_effect = ValueError("fixture corrupt record")
        with mock.patch.object(self.installer, "_atomic_write", side_effect=OSError("fixture diagnostic denied")):
            output, errors = self.invoke()
        self.assertIn("fixture corrupt record", self.context(output))
        self.assertIn("会话启动诊断写入失败", errors)
        self.assertIn("fixture diagnostic denied", errors)
        self.assertFalse((self.runtime / "plugin-session-start.json").exists())

    def test_uninstalled_nudge_repeats_context_and_preserves_disabled_config(self):
        self.config.write_text('{"plugin_auto_install_overlay": false, "plugin_auto_update": false, '
                               '"python_path": "custom", "other": 7}', encoding="utf-8")
        legacy = self.runtime / ".plugin-overlay-nudge"
        legacy.write_text("1", encoding="utf-8")
        for _ in range(2):
            output, _ = self.invoke()
            self.assertIn("用户可见·安装提醒", self.context(output))
            self.assertIn("install-overlay", self.context(output))
            self.assertNotIn("请完全退出 ZCode", self.context(output))
        self.install.assert_not_called()
        config = json.loads(self.config.read_text(encoding="utf-8"))
        self.assertIs(config["plugin_auto_install_overlay"], False)
        self.assertIs(config["plugin_auto_update"], False)
        self.assertEqual(config["python_path"], "custom")
        self.assertEqual(config["other"], 7)
        self.assertEqual(config["asar_path"], str(self.asar))
        self.assertEqual(legacy.read_text(encoding="utf-8"), "1")

    def test_corrupt_or_nonboolean_config_keeps_nudge_without_auto_install(self):
        for raw in ("{broken", "null", '{"plugin_auto_install_overlay": "false"}'):
            with self.subTest(raw=raw):
                self.config.write_text(raw, encoding="utf-8")
                output, _ = self.invoke()
                self.assertIn("用户可见·安装提醒", self.context(output))
                if raw in ("{broken", "null"):
                    self.assertEqual(self.config.read_text(encoding="utf-8"), raw)
                else:
                    self.assertEqual(json.loads(self.config.read_text())["plugin_auto_install_overlay"], "false")
        self.install.assert_not_called()

    def test_unfinished_auto_install_nudge_restores_monitor_flags_and_redirects_logs(self):
        def unfinished(before_publish):
            self.assertEqual(os.environ["ZUSAGE_NO_MONITOR"], "1")
            self.assertEqual(os.environ["ZUSAGE_MONITOR_QUIET"], "1")
            print("fixture install unfinished")
            return False
        self.install.side_effect = unfinished
        with mock.patch.dict(os.environ, {"ZUSAGE_NO_MONITOR": "custom", "ZUSAGE_MONITOR_QUIET": "0"}):
            for _ in range(2):
                output, errors = self.invoke()
                self.assertIn("自动安装未完成", self.context(output))
                self.assertIn("install-overlay", self.context(output))
                self.assertIn("fixture install unfinished", errors)
                self.assertEqual(os.environ["ZUSAGE_NO_MONITOR"], "custom")
                self.assertEqual(os.environ["ZUSAGE_MONITOR_QUIET"], "0")

    def test_pending_install_failure_nudges_full_quit_instead_of_retry(self):
        # issue #120：客户端运行中、待收尾包已排定的失败，重试 /install-overlay 无法
        # 前进（只会再 repack 一次再失败）；提示必须指向「完全退出 ZCode 等自动收尾」，
        # 并保留卸载豁免出口，不能继续引导无效重试。
        self.install.side_effect = lambda before_publish: False
        with mock.patch.object(self.pi, "pending_tmp", return_value={"operation": "install"}) as pending, \
                mock.patch.object(self.pi, "client_running", return_value=True):
            output, _ = self.invoke()
        pending.assert_called_with("install")   # 变异 M15 补强：操作类型必须锁死为 install
        context = self.context(output)
        self.assertIn("已排定", context)
        self.assertIn("完全退出 ZCode", context)
        self.assertNotIn("install-overlay 重试", context)
        self.assertIn("uninstall-overlay", context)

    def test_pending_without_running_client_keeps_retry_hint(self):
        # 待收尾包有效但客户端未在跑（如杀软瞬时占用的 POSIX 场景）：重试仍然有意义，
        # 维持原有提示。
        self.install.side_effect = lambda before_publish: False
        with mock.patch.object(self.pi, "pending_tmp", return_value={"operation": "install"}), \
                mock.patch.object(self.pi, "client_running", return_value=False):
            output, _ = self.invoke()
        context = self.context(output)
        self.assertIn("自动安装未完成", context)
        self.assertIn("install-overlay", context)

    def test_install_exception_restores_previously_absent_monitor_flags(self):
        self.install.side_effect = OSError("fixture install denied")
        output, _ = self.invoke()
        self.assertIn("fixture install denied", self.context(output))
        self.assertNotIn("ZUSAGE_NO_MONITOR", os.environ)
        self.assertNotIn("ZUSAGE_MONITOR_QUIET", os.environ)

    def test_installed_restart_notice_reaches_context_and_does_not_mutate_marker(self):
        self.make_asar(injected=True)
        self.notice.record_restart(self.runtime)
        marker = self.runtime / self.notice.MARKER
        before = (marker.read_bytes(), marker.stat().st_mtime_ns)
        self.sync.return_value = {"changed": ["inject-main.cjs"]}
        output, _ = self.invoke()
        self.assertIn("用户可见·重启提醒", self.context(output))
        self.assertIn("inject-main.cjs", self.context(output))
        self.assertIn("请完全退出 ZCode", self.context(output))
        self.assertEqual((marker.read_bytes(), marker.stat().st_mtime_ns), before)
        self.install.assert_not_called()

    def test_successful_auto_install_reaches_restart_context(self):
        def install(before_publish):
            import runtime_lock
            installation = {"asar": str(self.asar), "entryHash": "a" * 64}
            before_publish(installation)
            with runtime_lock.publish_install(self.runtime, installation):
                self.make_asar(injected=True)
            print("fixture installed")
            return True
        self.install.side_effect = install
        output, errors = self.invoke()
        self.assertIn("用户可见·重启提醒", self.context(output))
        self.assertIn("请完全退出 ZCode", self.context(output))
        self.assertIn("fixture installed", errors)

    def test_incomplete_restart_record_uses_install_context(self):
        self.make_asar(injected=True)
        self.notice.record_restart(self.runtime, {"state": "pending-sync", "hashes": {"inject-main.cjs": "a" * 64}})
        (self.runtime / "plugin-runtime-pending.json").write_text("{}", encoding="utf-8")
        output, _ = self.invoke()
        self.assertIn("用户可见·安装提醒", self.context(output))
        self.assertIn("同步尚未完成", self.context(output))
        self.assertNotIn("请完全退出 ZCode", self.context(output))

    def test_no_marker_or_unreadable_client_stays_silent(self):
        for readable in (True, False):
            with self.subTest(readable=readable):
                if readable:
                    self.make_asar(injected=True)
                else:
                    self.asar.write_bytes(b"fixture unreadable asar")
                output, _ = self.invoke()
                self.assertEqual(output, {"suppressOutput": True})
        self.install.assert_not_called()

    def test_optout_suppresses_normal_and_failed_selfcheck_without_config_changes(self):
        optout = self.runtime / ".plugin-overlay-optout"
        optout.write_text("1", encoding="utf-8")
        self.notice.record_restart(self.runtime)
        before = self.config.read_bytes()
        for fail in (False, True):
            with self.subTest(fail=fail):
                self.sync.side_effect = OSError("fixture opted-out failure") if fail else None
                output, errors = self.invoke()
                self.assertEqual(output, {"suppressOutput": True})
                self.assertEqual("fixture opted-out failure" in errors, fail)
                self.assertEqual(self.config.read_bytes(), before)
                self.assertEqual(optout.read_text(encoding="utf-8"), "1")
        self.install.assert_not_called()

    def test_optout_suppresses_entry_and_import_failures(self):
        (self.runtime / ".plugin-overlay-optout").write_text("1", encoding="utf-8")
        with mock.patch.object(self.installer, "run_hook", side_effect=RuntimeError("fixture entry denied")):
            output, errors = self.invoke()
        self.assertEqual(output, {"suppressOutput": True})
        self.assertIn("fixture entry denied", errors)
        self.assertTrue((self.runtime / "plugin-session-start.json").is_file())
        with mock.patch.dict(sys.modules, {"overlay_install": None}):
            output, errors = self.invoke()
        self.assertEqual(output, {"suppressOutput": True})
        self.assertIn("自检失败", errors)

    def test_unreadable_optout_in_entry_failure_keeps_legal_json(self):
        stat = Path.stat
        def unreadable(path, *args, **kwargs):
            if path.name == ".plugin-overlay-optout":
                raise PermissionError("fixture stat denied")
            return stat(path, *args, **kwargs)
        with mock.patch.object(self.installer, "run_hook", side_effect=RuntimeError("fixture entry denied")), \
                mock.patch.object(Path, "stat", unreadable):
            output, errors = self.invoke()
        self.assertEqual(output, {"suppressOutput": True})
        self.assertIn("fixture entry denied", errors)

    def test_background_update_failure_is_stderr_only_and_keeps_restart_context(self):
        self.make_asar(injected=True)
        self.notice.record_restart(self.runtime)
        self.updater.start_auto_update.side_effect = OSError("fixture updater denied")
        output, errors = self.invoke()
        self.assertIn("用户可见·重启提醒", self.context(output))
        self.assertIn("后台更新启动失败（已忽略）", errors)
        self.assertIn("fixture updater denied", errors)

    def test_process_failure_exits_zero_and_emits_single_json_with_diagnostic(self):
        script = ("import runpy, sys; sys.path.insert(0, {!r}); import overlay_install; "
                  "overlay_install.sync_runtime = lambda runtime, target_asar=None: (_ for _ in ()).throw(ValueError('fixture sync rejected')); "
                  "runpy.run_path({!r}, run_name='__main__')"
                  ).format(str(PLUGIN), str(PLUGIN / "hooks" / "session-start.py"))
        environment = dict(os.environ)
        environment.pop("ZCODE_SESSION_ID")
        process = subprocess.run([sys.executable, "-B", "-c", script], input='{"source": "startup"}',
                                 capture_output=True, text=True, env=environment, cwd=str(self.home), timeout=10)
        self.assertEqual(process.returncode, 0, process.stderr)
        output = json.loads(process.stdout)
        self.assertEqual(process.stdout, json.dumps(output, ensure_ascii=False) + "\n")
        self.assertIn("fixture sync rejected", self.context(output))
        self.assertTrue(output["suppressOutput"])
        self.assertNotIn("decision", output)
        record = json.loads((self.runtime / "plugin-session-start.json").read_text(encoding="utf-8"))
        self.assertEqual(record["result"], output)
        self.assertEqual(record["source"], "startup")
        self.assertEqual(record["sessionId"], "")
        self.assertEqual(list(self.home.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
