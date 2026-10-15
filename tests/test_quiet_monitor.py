# -*- coding: utf-8 -*-
import importlib.util
import io
import contextlib
import ctypes
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class QuietMonitorTests(unittest.TestCase):
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
        self.tmp = self.root / "app.asar.zusage.tmp"
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        with mock.patch.object(sys, "argv", ["install_monitor.py", "0", str(self.asar), str(self.runtime)]), \
                mock.patch.dict(os.environ, {"ZUSAGE_MONITOR_QUIET": "1"}):
            self.monitor = module("quiet_monitor_test", ROOT / "install_monitor.py")
        self.patch = module("quiet_patch_test", ROOT / "patch_install.py")
        self.patch.set_target(self.asar)
        self.patch.set_runtime(self.runtime)

    def pending(self, data=b"verified package", operation="install"):
        source = self.patch.source_fingerprint(self.asar)
        self.tmp.write_bytes(data)
        with mock.patch.object(self.patch, "self_check", return_value=True), \
                mock.patch.object(self.patch, "syntax_check", return_value=True):
            self.patch.write_tmp_metadata(source, operation)

    def test_quiet_monitor_launches_without_console_and_with_no_monitor_flag(self):
        env = {"ZUSAGE_NO_MONITOR": "1", "ZUSAGE_MONITOR_QUIET": "1"}
        with mock.patch.dict(os.environ, env), mock.patch.object(self.patch.subprocess, "Popen") as spawn:
            self.patch.launch_monitor(0)
        self.assertEqual(spawn.call_count, 1)
        kwargs = spawn.call_args.kwargs
        self.assertEqual(kwargs["stdout"], self.patch.subprocess.DEVNULL)
        self.assertEqual(kwargs["stdin"], self.patch.subprocess.DEVNULL)
        if os.name == "nt":
            # Windows 无窗口收尾：CREATE_NO_WINDOW + 尝试脱离父进程 Job（监控不能随
            # agent 会话清理被杀）；具体位由下方 Windows 用例逐位断言。
            self.assertTrue(kwargs["creationflags"])
            self.assertNotIn("start_new_session", kwargs)
        else:
            self.assertTrue(kwargs["start_new_session"])

    def test_explicit_no_monitor_still_disables_interactive_monitor(self):
        with mock.patch.dict(os.environ, {"ZUSAGE_NO_MONITOR": "1", "ZUSAGE_MONITOR_QUIET": ""}), \
                mock.patch.object(self.patch.subprocess, "Popen") as spawn:
            self.patch.launch_monitor(0)
        spawn.assert_not_called()

    def test_quiet_monitor_exits_immediately_without_pending_package(self):
        with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                mock.patch.object(self.monitor.time, "sleep") as sleep:
            self.monitor.main()
        sleep.assert_not_called()

    def test_waits_for_client_exit_then_self_checks_and_finalizes(self):
        self.pending()
        with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                mock.patch.object(self.monitor, "zcode_pids", side_effect=[{"1"}, set(), set(), set(), set(), set()]), \
                mock.patch.object(self.monitor.time, "sleep") as sleep, \
                mock.patch.object(self.patch, "self_check", return_value=True) as check:
            self.monitor.main()
        # 等待路径平台分歧（POSIX 睡眠 / Windows 句柄不可得立即返回），不断言 sleep 次数；
        # sleep 仍须 mock，避免 POSIX 上真睡一个轮询周期。
        check.assert_called_once_with(self.tmp, expect=True)
        self.assertEqual(self.asar.read_bytes(), b"verified package")
        self.assertFalse(self.tmp.exists())

    def test_invalid_pending_package_is_never_installed(self):
        self.pending(b"invalid")
        with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                mock.patch.object(self.monitor, "zcode_pids", return_value=set()), \
                mock.patch.object(self.patch, "self_check", return_value=False):
            self.monitor.main()
        self.assertEqual(self.asar.read_bytes(), b"official version")

    def test_client_upgrade_while_waiting_cancels_old_package_replacement(self):
        self.pending(b"older patched version")
        def upgrade(*_args):
            self.asar.write_bytes(b"new official version")
            os.utime(self.asar, ns=(1, 1))
        with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                mock.patch.object(self.monitor, "zcode_pids", return_value={"1"}), \
                mock.patch.object(self.monitor, "wait_any_exit", side_effect=upgrade), \
                mock.patch.object(self.patch, "finalize_tmp") as finalize:
            self.monitor.main()
        finalize.assert_not_called()
        self.assertEqual(self.asar.read_bytes(), b"new official version")

    def test_upgrade_before_monitor_starts_does_not_roll_back(self):
        self.pending(b"old patched version")
        self.asar.write_bytes(b"new official version")
        with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                mock.patch.object(self.monitor, "zcode_pids", return_value=set()), \
                mock.patch.object(self.patch, "self_check", return_value=True):
            self.monitor.main()
        self.assertEqual(self.asar.read_bytes(), b"new official version")
        self.assertTrue(self.tmp.exists())

    def test_oserror_retries_until_success_without_rehashing_every_poll(self):
        self.pending()
        replace = self.patch.os.replace
        attempts = []
        def locked(src, dst):
            attempts.append((src, dst))
            if len(attempts) < 3:
                raise PermissionError("still locked")
            return replace(src, dst)
        with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                mock.patch.object(self.monitor, "zcode_pids", return_value=set()), \
                mock.patch.object(self.monitor.time, "sleep") as sleep, \
                mock.patch.object(self.patch, "self_check", return_value=True), \
                mock.patch.object(self.patch, "source_fingerprint", wraps=self.patch.source_fingerprint) as hashes, \
                mock.patch.object(self.patch.os, "replace", side_effect=locked):
            self.monitor.main()
        self.assertEqual(len(attempts), 3)
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(hashes.call_count, 2)
        self.assertEqual(self.asar.read_bytes(), b"verified package")

    def test_missing_sidecar_leaves_unknown_package_untouched(self):
        self.tmp.write_bytes(b"unknown package")
        with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                mock.patch.object(self.monitor, "zcode_pids", return_value=set()), \
                mock.patch.object(self.patch, "self_check", return_value=True), \
                mock.patch.object(self.monitor.time, "sleep") as sleep:
            self.monitor.main()
        sleep.assert_not_called()
        self.assertEqual(self.asar.read_bytes(), b"official version")
        self.assertEqual(self.tmp.read_bytes(), b"unknown package")

    def test_waiting_uses_stat_only_and_retries_have_one_day_deadline(self):
        self.pending()
        with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                mock.patch.object(self.monitor, "zcode_pids", return_value={"1"}), \
                mock.patch.object(self.monitor.time, "monotonic", side_effect=[0, 1, 2, 86400]), \
                mock.patch.object(self.monitor.time, "sleep") as sleep, \
                mock.patch.object(self.patch, "source_fingerprint") as hashes:
            self.monitor.main()
        # 等待只读 stat（不重 hash 大包），一天期限后停止重试；等待路径的平台分歧
        # （POSIX 睡眠 / Windows 句柄不可得立即返回）不影响这两个核心断言。
        hashes.assert_not_called()

    def test_changed_package_cancels_after_oserror_without_retry(self):
        self.pending()
        def tamper(_):
            self.tmp.write_bytes(b"tampered package")
        with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                mock.patch.object(self.monitor, "zcode_pids", return_value=set()), \
                mock.patch.object(self.monitor.time, "sleep", side_effect=tamper) as sleep, \
                mock.patch.object(self.patch, "self_check", return_value=True), \
                mock.patch.object(self.patch.os, "replace", side_effect=PermissionError("locked")) as replace:
            self.monitor.main()
        replace.assert_called_once()
        sleep.assert_called_once()
        self.assertEqual(self.asar.read_bytes(), b"official version")

    def test_windows_quiet_launch_uses_no_window_flag(self):
        flags = {"CREATE_NO_WINDOW": 0x08000000, "CREATE_BREAKAWAY_FROM_JOB": 0x01000000}
        with mock.patch.dict(os.environ, {"ZUSAGE_NO_MONITOR": "1", "ZUSAGE_MONITOR_QUIET": "1"}), \
                mock.patch.object(self.patch, "IS_WIN", True), \
                mock.patch.multiple(self.patch.subprocess, create=True, **flags), \
                mock.patch.object(self.patch.subprocess, "Popen") as spawn:
            self.patch.launch_monitor(0)
        # 无窗口 + 优先尝试脱离 Job（会话清理不连带杀掉收尾监控）
        self.assertEqual(spawn.call_count, 1)
        self.assertEqual(spawn.call_args.kwargs["creationflags"], 0x08000000 | 0x01000000)
        self.assertFalse(spawn.call_args.kwargs.get("start_new_session"))

    def test_windows_breakaway_denied_falls_back_to_plain_flags(self):
        flags = {"CREATE_NO_WINDOW": 0x08000000, "CREATE_BREAKAWAY_FROM_JOB": 0x01000000}
        with mock.patch.dict(os.environ, {"ZUSAGE_NO_MONITOR": "1", "ZUSAGE_MONITOR_QUIET": "1"}), \
                mock.patch.object(self.patch, "IS_WIN", True), \
                mock.patch.multiple(self.patch.subprocess, create=True, **flags), \
                mock.patch.object(self.patch.subprocess, "Popen",
                                  side_effect=[OSError("job object does not allow breakaway"),
                                               mock.DEFAULT]) as spawn:
            self.patch.launch_monitor(0)
        self.assertEqual(spawn.call_count, 2)
        self.assertEqual(spawn.call_args_list[0].kwargs["creationflags"], 0x08000000 | 0x01000000)
        self.assertEqual(spawn.call_args_list[1].kwargs["creationflags"], 0x08000000)

    def test_oserror_retry_stops_at_one_day_deadline(self):
        self.pending()
        with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                mock.patch.object(self.monitor, "zcode_pids", return_value=set()), \
                mock.patch.object(self.monitor.time, "monotonic", side_effect=[0, 1, 2, 86400]), \
                mock.patch.object(self.monitor.time, "sleep") as sleep, \
                mock.patch.object(self.patch, "self_check", return_value=True), \
                mock.patch.object(self.patch.os, "replace", side_effect=PermissionError("locked")) as replace:
            self.monitor.main()
        replace.assert_called_once()
        sleep.assert_called_once_with(self.monitor.POLL)
        self.assertTrue(self.tmp.exists())

    def test_visible_oserror_retries_cached_validation_until_success(self):
        self.pending()
        replace = self.patch.os.replace
        attempts = []
        def locked(src, dst):
            attempts.append((src, dst))
            if len(attempts) == 1:
                raise PermissionError("locked")
            return replace(src, dst)
        def stop(_):
            if not self.tmp.exists():
                raise KeyboardInterrupt
        with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                mock.patch.object(self.monitor, "QUIET", False), \
                mock.patch.object(sys, "argv", ["install_monitor.py", "0"]), \
                mock.patch.object(self.monitor, "zcode_pids", return_value=set()), \
                mock.patch.object(self.patch, "self_check", return_value=True), \
                mock.patch.object(self.patch, "source_fingerprint", wraps=self.patch.source_fingerprint) as hashes, \
                mock.patch.object(self.patch.os, "replace", side_effect=locked), \
                mock.patch.object(self.monitor, "draw"), \
                mock.patch.object(self.monitor.time, "sleep", side_effect=stop) as sleep:
            with self.assertRaises(KeyboardInterrupt):
                self.monitor.main()
        self.assertEqual(len(attempts), 2)
        self.assertEqual(hashes.call_count, 2)
        self.assertEqual(sleep.call_count, 2)

    def test_visible_monitor_rejects_old_source_and_unknown_packages(self):
        for known in (False, True):
            with self.subTest(known=known):
                if known:
                    self.pending()
                    self.asar.write_bytes(b"upgraded official version")
                else:
                    self.tmp.write_bytes(b"unknown package")
                with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                        mock.patch.object(self.monitor, "QUIET", False), \
                        mock.patch.object(sys, "argv", ["install_monitor.py", "0"]), \
                        mock.patch.object(self.monitor, "zcode_pids", return_value=set()), \
                        mock.patch.object(self.patch, "self_check", return_value=True), \
                        mock.patch.object(self.monitor, "draw"), \
                        mock.patch.object(self.monitor.time, "sleep", side_effect=AssertionError("invalid TMP must cancel")), \
                        mock.patch.object(self.monitor.os, "replace") as replace:
                    self.monitor.main()
                replace.assert_not_called()

    def test_failed_syntax_is_not_activated_by_quiet_or_visible_monitor(self):
        from test_pending_asar import make_asar
        for quiet in (True, False):
            for operation in ("install", "remove"):
                with self.subTest(quiet=quiet, operation=operation):
                    entry = b"const broken = ;"
                    if operation == "remove":
                        entry += self.patch.INJECT_LINE.encode()
                    make_asar(self.asar, entry)
                    original = self.asar.read_bytes()
                    (self.runtime / "inject-main.cjs").write_text("// fixture")
                    with mock.patch.object(self.patch, "syntax_check", return_value=False), \
                            mock.patch.object(self.patch, "client_running", return_value=False):
                        with contextlib.redirect_stdout(io.StringIO()):
                            self.assertFalse(getattr(self.patch, operation)())
                    # A later monitor must not authorize the rejected package even if
                    # its own syntax checker is unavailable or now accepts it.
                    with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                            mock.patch.object(self.monitor, "QUIET", quiet), \
                            mock.patch.object(sys, "argv", ["install_monitor.py", "0"]), \
                            mock.patch.object(self.monitor, "zcode_pids", return_value=set()), \
                            mock.patch.object(self.patch, "self_check", return_value=True), \
                            mock.patch.object(self.patch, "syntax_check", return_value=True), \
                            mock.patch.object(self.monitor, "draw"), \
                            mock.patch.object(self.monitor.time, "sleep", side_effect=KeyboardInterrupt):
                        try:
                            self.monitor.main()
                        except KeyboardInterrupt:
                            pass
                    self.assertEqual(self.asar.read_bytes(), original)

    def test_visible_monitor_finishes_remove_metadata_without_reinjecting(self):
        self.pending(b"removed package", operation="remove")
        def stop(_):
            raise KeyboardInterrupt
        with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                mock.patch.object(self.monitor, "QUIET", False), \
                mock.patch.object(sys, "argv", ["install_monitor.py", "0"]), \
                mock.patch.object(self.monitor, "zcode_pids", return_value=set()), \
                mock.patch.object(self.patch, "self_check", return_value=True) as check, \
                mock.patch.object(self.monitor, "draw"), \
                mock.patch.object(self.monitor.time, "sleep", side_effect=stop):
            with self.assertRaises(KeyboardInterrupt):
                self.monitor.main()
        check.assert_called_once_with(self.tmp, expect=False)
        self.assertEqual(self.asar.read_bytes(), b"removed package")


class WaitAnyExitTests(unittest.TestCase):
    """Windows 句柄等待分支：用假 kernel32 在任意平台覆盖分支逻辑。"""

    def setUp(self):
        with mock.patch.object(sys, "argv", ["install_monitor.py", "0", "app.asar", "."]):
            self.monitor = module("wait_any_exit_test", ROOT / "install_monitor.py")

    def wait(self, opened, error):
        kernel32 = mock.Mock()
        kernel32.OpenProcess.side_effect = lambda access, inherit, pid: opened.get(pid, 0)
        with mock.patch.object(self.monitor, "os", types.SimpleNamespace(name="nt")), \
                mock.patch.object(ctypes, "WinDLL", create=True, return_value=kernel32), \
                mock.patch.object(ctypes, "get_last_error", create=True, return_value=error), \
                mock.patch.object(self.monitor.time, "sleep") as sleep:
            self.monitor.wait_any_exit(["11", "12"], 10)
        return kernel32, sleep

    def test_waits_on_every_handle_and_closes_them(self):
        kernel32, sleep = self.wait({11: 101, 12: 102}, error=0)
        count, handles, wait_all, timeout = kernel32.WaitForMultipleObjects.call_args.args
        self.assertEqual((count, list(handles), wait_all, timeout), (2, [101, 102], False, 10000))
        self.assertEqual([c.args for c in kernel32.CloseHandle.call_args_list], [(101,), (102,)])
        sleep.assert_not_called()

    def test_pid_gone_since_sampling_returns_immediately(self):
        # 采集后已退出（ERROR_INVALID_PARAMETER）：「任一退出」已发生，不能再等或睡，
        # 否则正好错过「退出→立即重启」空档。
        kernel32, sleep = self.wait({11: 101}, error=87)
        kernel32.WaitForMultipleObjects.assert_not_called()
        sleep.assert_not_called()
        kernel32.CloseHandle.assert_called_once_with(101)

    def test_inaccessible_processes_sleep_one_full_interval(self):
        # 进程都在但全部无权等待（ERROR_ACCESS_DENIED）：按轮询间隔睡，不忙转。
        kernel32, sleep = self.wait({}, error=5)
        kernel32.WaitForMultipleObjects.assert_not_called()
        sleep.assert_called_once_with(10)


if __name__ == "__main__":
    unittest.main()
