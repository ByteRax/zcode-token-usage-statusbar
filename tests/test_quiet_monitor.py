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
        # cmd[1] 必须指向同目录 install_monitor.py（issue #163 review 加固：兄弟不变式
        # 由 RUNTIME_FILES 清单与 copy_runtime 同目录复制保证，此处断言防改名/换目录回归）
        self.assertTrue(spawn.call_args.args[0][1].endswith("install_monitor.py"))
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

    def test_monitor_lock_is_exclusive_and_released_after_use(self):
        # issue #120：同目标的监控实例锁必须互斥，释放后可重新获取（进程退出等价释放）。
        with self.patch.monitor_instance_lock() as first:
            self.assertTrue(first)
            with self.patch.monitor_instance_lock() as second:
                self.assertFalse(second)
        with self.patch.monitor_instance_lock() as third:
            self.assertTrue(third)

    def test_launch_monitor_skips_spawn_while_another_monitor_holds_lock(self):
        # issue #120：同目标的存活监控已持有实例锁时，不再拉起新监控进程；
        # 锁释放后恢复正常拉起。
        with self.patch.monitor_instance_lock() as held:
            self.assertTrue(held)
            with mock.patch.dict(os.environ, {"ZUSAGE_NO_MONITOR": "1", "ZUSAGE_MONITOR_QUIET": "1"}), \
                    mock.patch.object(self.patch.subprocess, "Popen") as spawn:
                self.patch.launch_monitor(0)
            spawn.assert_not_called()
        with mock.patch.dict(os.environ, {"ZUSAGE_NO_MONITOR": "1", "ZUSAGE_MONITOR_QUIET": "1"}), \
                mock.patch.object(self.patch.subprocess, "Popen") as spawn:
            self.patch.launch_monitor(0)
        self.assertEqual(spawn.call_count, 1)

    def test_second_monitor_instance_exits_without_running_the_loop(self):
        # issue #120：SessionStart 每次自动安装都会尝试拉起监控；已有实例持锁时
        # 后来者必须立即退出，不得随会话数线性堆积，也不得碰待收尾包。
        # self_check 须 mock：夹具 TMP 是非 asar 裸字节，去重守卫一旦被删（回归），
        # 真实 self_check 会在 zcode_pids 之前抛 PendingTmpError 静默返回，可观测
        # 状态与守卫早退完全一致，本用例会空转（review 变异 M10）。
        self.pending()
        with self.patch.monitor_instance_lock() as held:
            self.assertTrue(held)
            with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                    mock.patch.object(self.patch, "self_check", return_value=True), \
                    mock.patch.object(self.monitor, "zcode_pids", side_effect=[set(), set()]) as pids, \
                    mock.patch.object(self.patch, "finalize_tmp") as finalize:
                self.monitor.main()
            pids.assert_not_called()
            finalize.assert_not_called()
            self.assertEqual(self.asar.read_bytes(), b"official version")

    def test_lock_file_unavailable_degrades_to_legacy_behavior(self):
        # 变异 M8 补强（issue #120 review）：锁文件无法创建（只读目录等）时按持有
        # 处理——不挡收尾主职责，launch_monitor 照常拉起，与无去重的旧行为一致。
        with mock.patch.object(self.patch.os, "open", side_effect=OSError("fixture denied")), \
                self.patch.monitor_instance_lock() as held:
            self.assertTrue(held)
        with mock.patch.dict(os.environ, {"ZUSAGE_NO_MONITOR": "1", "ZUSAGE_MONITOR_QUIET": "1"}), \
                mock.patch.object(self.patch.os, "open", side_effect=OSError("fixture denied")), \
                mock.patch.object(self.patch.subprocess, "Popen") as spawn:
            self.patch.launch_monitor(0)
        self.assertEqual(spawn.call_count, 1)

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
                mock.patch.object(self.patch, "self_check", return_value=True), \
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

    def test_waiting_prewarms_once_and_retries_have_one_day_deadline(self):
        self.pending()
        with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                mock.patch.object(self.monitor, "zcode_pids", return_value={"1"}), \
                mock.patch.object(self.monitor.time, "monotonic", side_effect=[0, 1, 2, 86400]), \
                mock.patch.object(self.monitor.time, "sleep") as sleep, \
                mock.patch.object(self.patch, "self_check", return_value=True), \
                mock.patch.object(self.patch, "source_fingerprint", wraps=self.patch.source_fingerprint) as hashes:
            self.monitor.main()
        # 等待期预校验焐热缓存（issue #72）：大包只 hash 一轮（ASAR+TMP 各一次），
        # 后续轮询 stat 命中缓存不再重 hash；一天期限后停止重试。等待路径的平台分歧
        # （POSIX 睡眠 / Windows 句柄不可得立即返回）不影响这两个核心断言。
        # self_check 须 mock：夹具 TMP 是非 asar 裸字节，真 self_check 会在首轮预热即抛
        # PendingTmpError 提前取消收尾——那样第 2、3 个 monotonic 值从未消费，
        # 「此后轮询命中缓存」与「一天期限」两段就没有真正执行过（review F1）。
        self.assertEqual(hashes.call_count, 2)

    def test_exit_window_finalize_is_prewarmed_stat_and_rename_only(self):
        # 回归（issue #72）：退出窗口只有数秒且新实例亚秒级重开 asar，窗口内
        # finalize 不得再 hash 大包——哈希必须在等待期完成，进程全退后只剩 rename。
        self.pending()
        events = []
        real_hash = self.patch.source_fingerprint
        real_replace = self.patch.os.replace
        pids_iter = iter([{"1"}] + [set()] * 6)
        seen_exit = []
        def pids_recorder():
            pids = next(pids_iter)
            if not pids and not seen_exit:
                seen_exit.append(True)   # 只记首次观察到进程全退，后续 client_closed 复查不重复记
                events.append("exit")
            return pids
        def hash_recorder(path, *args, **kwargs):
            events.append("hash")
            return real_hash(path, *args, **kwargs)
        def replace_recorder(src, dst):
            events.append("replace")
            return real_replace(src, dst)
        with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                mock.patch.object(self.monitor, "zcode_pids", side_effect=pids_recorder), \
                mock.patch.object(self.monitor, "wait_any_exit"), \
                mock.patch.object(self.monitor.time, "sleep") as sleep, \
                mock.patch.object(self.patch, "self_check", return_value=True), \
                mock.patch.object(self.patch, "source_fingerprint", side_effect=hash_recorder), \
                mock.patch.object(self.patch.os, "replace", side_effect=replace_recorder):
            self.monitor.main()
        # 哈希必须全部发生在等待轮（客户端仍在跑）：首次观察到进程全退（exit）之后
        # 不得再出现 hash——若把哈希挪进退出窗口，事件序会变成 exit 在前（review F2）。
        self.assertEqual(events, ["hash", "hash", "exit", "replace"])
        self.assertEqual(self.asar.read_bytes(), b"verified package")
        self.assertFalse(self.tmp.exists())

    def test_visible_monitor_prewarms_once_during_waiting(self):
        # 回归（issue #72 复审）：可见监控 main() 的等待轮与 quiet_finalize 同款预热；
        # 若该路径回退为 stat-only（哈希推迟到首次 finalize），等待期 hash 数为 0，
        # 本用例必须红——此前没有任何测试锁定 main() 这处调用（review F3）。
        self.pending()
        with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                mock.patch.object(self.monitor, "QUIET", False), \
                mock.patch.object(sys, "argv", ["install_monitor.py", "0"]), \
                mock.patch.object(self.monitor, "zcode_pids", side_effect=[{"1"}] * 3 + [KeyboardInterrupt]), \
                mock.patch.object(self.monitor, "wait_any_exit"), \
                mock.patch.object(self.monitor.time, "monotonic", side_effect=[0, 1, 2, 3]), \
                mock.patch.object(self.monitor.time, "sleep"), \
                mock.patch.object(self.monitor, "draw"), \
                mock.patch.object(self.patch, "self_check", return_value=True), \
                mock.patch.object(self.patch, "source_fingerprint", wraps=self.patch.source_fingerprint) as hashes:
            with self.assertRaises(KeyboardInterrupt):
                self.monitor.main()
        # 启动采集与两轮完整等待（第三轮在进程探测处中断）中只有首轮 hash 一轮
        # （ASAR+TMP 各一次），此后 stat 命中缓存。
        self.assertEqual(hashes.call_count, 2)

    def test_prewarm_cache_revalidates_new_sidecar_generation(self):
        # issue #72 复审：verified 缓存键=完整 sidecar meta。新一代 sidecar（如 SessionStart
        # 重建 TMP）必须令缓存失配并重新全量 hash+self_check，不得沿用旧世代的结论
        # （review F4：缓存键若退化为 is None，旧缓存会跳过新世代的重校验）。
        self.pending(b"first generation")
        verified = {}
        with mock.patch.object(self.patch, "self_check", return_value=True), \
                mock.patch.object(self.patch, "source_fingerprint", wraps=self.patch.source_fingerprint) as hashes:
            self.patch.pending_tmp(operation=None, verify_hash=True, verified=verified)
            first_round = hashes.call_count
        self.pending(b"second generation")
        with mock.patch.object(self.patch, "self_check", return_value=True), \
                mock.patch.object(self.patch, "source_fingerprint", wraps=self.patch.source_fingerprint) as hashes:
            self.patch.pending_tmp(operation=None, verify_hash=True, verified=verified)
            second_round = hashes.call_count
        self.assertEqual(first_round, 2)
        self.assertEqual(second_round, 2)   # 新世代重新全量校验，而非命中旧缓存
        self.assertEqual(verified["metadata"]["tmp"]["sha256"],
                         self.patch.source_fingerprint(self.tmp)["sha256"])

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

    def test_quiet_monitor_gives_up_on_unwritable_target_after_replace_failure(self):
        # issue #130：无提权 monitor 在受保护目录上 replace 重试注定失败（恒
        # PermissionError），空转一天还占着实例锁、挡住提权重跑重建收尾——
        # replace 失败且目标不可写时必须立即退出（锁随进程释放，不进入下一轮睡眠）。
        self.pending()
        attempts = []
        def denied(src, dst):
            attempts.append((src, dst))
            raise PermissionError("protected directory")
        with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                mock.patch.object(self.monitor, "zcode_pids", return_value=set()), \
                mock.patch.object(self.patch, "target_writable", return_value=False), \
                mock.patch.object(self.patch, "self_check", return_value=True), \
                mock.patch.object(self.monitor.time, "sleep",
                                  side_effect=AssertionError("unwritable target must not retry")), \
                mock.patch.object(self.patch.os, "replace", side_effect=denied):
            self.monitor.main()
        self.assertEqual(len(attempts), 1)
        self.assertTrue(self.tmp.exists())
        with self.patch.monitor_instance_lock() as acquired:
            self.assertTrue(acquired)   # 锁已释放：提权重跑能立即拉起新监控接管

    def test_visible_monitor_reports_unwritable_target_and_stops_retrying(self):
        # issue #130：客户端已退出但 replace 因权限失败时，「文件仍被占用？」与
        # 继续重试都是错误导向——受保护目录上应显示管理员指引并退出（仅保留 BYE
        # 提示停留，不再进入 POLL 重试循环）。
        self.pending()
        def no_retry(seconds):
            if seconds == self.monitor.POLL:
                raise AssertionError("unwritable target must not retry")
        with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                mock.patch.object(self.monitor, "QUIET", False), \
                mock.patch.object(sys, "argv", ["install_monitor.py", "0"]), \
                mock.patch.object(self.monitor, "zcode_pids", return_value=set()), \
                mock.patch.object(self.patch, "target_writable", return_value=False), \
                mock.patch.object(self.patch, "self_check", return_value=True), \
                mock.patch.object(self.monitor, "draw") as draw, \
                mock.patch.object(self.monitor.time, "sleep", side_effect=no_retry), \
                mock.patch.object(self.patch.os, "replace",
                                  side_effect=PermissionError("protected directory")):
            self.monitor.main()
        output = "\n".join(draw.call_args.args[0])
        self.assertIn("管理员", output)
        self.assertNotIn("仍被占用", output)

    def test_visible_monitor_pending_footer_warns_when_elevated(self):
        # issue #130：提权 monitor 是受保护目录上唯一能收尾的进程，「本窗口可随时
        # 关闭，不影响安装结果」在此不成立——关窗即杀死唯一收尾者且系统不会重建。
        # issue #163：非提权同样不能保留原文案——独立链没有 SessionStart hook，
        # 关窗后 pending 无人收尾会永久搁浅（插件链也要等下次会话才重建）。页脚
        # 按提权身份区分重建门槛，且警告仅限有待收尾包时（review 变异 M9：合取项
        # `pending is not None` 若缺失，安装完成等待重启等无 pending 态也会误警告）。
        def stop(_):
            raise KeyboardInterrupt
        def draw_once(with_pending, elevated):
            if with_pending:
                self.pending()
            else:
                self.tmp.unlink(missing_ok=True)   # 清掉上一轮的夹具包，确保 pending=None
                self.patch.TMP_META.unlink(missing_ok=True)
            with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                    mock.patch.object(self.monitor, "QUIET", False), \
                    mock.patch.object(sys, "argv", ["install_monitor.py", "0"]), \
                    mock.patch.object(self.monitor, "zcode_pids", return_value={"1"}), \
                    mock.patch.object(self.monitor, "wait_any_exit", side_effect=KeyboardInterrupt), \
                    mock.patch.object(self.monitor.time, "monotonic", return_value=0), \
                    mock.patch.object(self.patch, "is_elevated", return_value=elevated), \
                    mock.patch.object(self.patch, "self_check", return_value=True), \
                    mock.patch.object(self.monitor, "draw") as draw, \
                    mock.patch.object(self.monitor.time, "sleep", side_effect=stop):
                with self.assertRaises(KeyboardInterrupt):
                    self.monitor.main()
            return "\n".join(draw.call_args.args[0])
        for elevated in (True, False):
            with self.subTest(elevated=elevated, pending=True):
                output = draw_once(True, elevated)
                self.assertNotIn("可随时关闭", output)
                self.assertIn("保持本窗口", output)
                if elevated:
                    self.assertIn("管理员", output)
                else:
                    self.assertIn("重新运行安装", output)
                    self.assertNotIn("管理员", output)
        for elevated in (True, False):
            with self.subTest(elevated=elevated, pending=False):
                output = draw_once(False, elevated)
                self.assertIn("可随时关闭", output)
                self.assertNotIn("保持本窗口", output)

    def test_visible_monitor_footer_is_benign_once_finalize_finished(self):
        # review 2026-10-31：提权 monitor 完成 asar 替换后的成功屏上，「收尾未完成前请
        # 保持本窗口开启」是自相矛盾文案——收尾已落定，关窗不再影响结果。
        self.pending()
        draws = []
        def stop(_):
            raise KeyboardInterrupt
        with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                mock.patch.object(self.monitor, "QUIET", False), \
                mock.patch.object(sys, "argv", ["install_monitor.py", "0"]), \
                mock.patch.object(self.monitor, "zcode_pids", return_value=set()), \
                mock.patch.object(self.patch, "is_elevated", return_value=True), \
                mock.patch.object(self.patch, "self_check", return_value=True), \
                mock.patch.object(self.monitor, "draw", side_effect=lambda lines: draws.append("\n".join(lines))), \
                mock.patch.object(self.monitor.time, "sleep", side_effect=stop):
            with self.assertRaises(KeyboardInterrupt):
                self.monitor.main()
        self.assertTrue(draws, "at least one frame drawn")
        output = draws[-1]
        self.assertIn("替换完成", output)
        self.assertIn("可随时关闭", output)
        self.assertNotIn("保持本窗口", output)

    def test_visible_monitor_footer_is_benign_when_finalize_denied(self):
        # finalize_denied 终屏的指引是「以管理员身份重跑安装」：本窗口已确定无法收尾，
        # 「保持本窗口开启」在此既矛盾又错误（关窗不会停止任何东西）。
        self.pending()
        draws = []
        def stop(_):
            raise KeyboardInterrupt
        with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                mock.patch.object(self.monitor, "QUIET", False), \
                mock.patch.object(sys, "argv", ["install_monitor.py", "0"]), \
                mock.patch.object(self.monitor, "zcode_pids", return_value=set()), \
                mock.patch.object(self.patch, "is_elevated", return_value=True), \
                mock.patch.object(self.patch, "target_writable", return_value=False), \
                mock.patch.object(self.patch, "self_check", return_value=True), \
                mock.patch.object(self.patch.os, "replace",
                                  side_effect=PermissionError("protected directory")), \
                mock.patch.object(self.monitor, "draw", side_effect=lambda lines: draws.append("\n".join(lines))), \
                mock.patch.object(self.monitor.time, "sleep", side_effect=stop):
            with self.assertRaises(KeyboardInterrupt):
                self.monitor.main()
        self.assertTrue(draws, "at least one frame drawn")
        output = draws[-1]
        self.assertIn("管理员", output)
        self.assertIn("可随时关闭", output)
        self.assertNotIn("保持本窗口", output)

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

    def test_visible_monitor_fallback_hint_includes_asar_path(self):
        # 回归（issue #14 同款根因，复审后追加 --runtime）：窗口模式"也可手动执行"提示若不带
        # --asar/--runtime，standalone 跑该命令会用默认猜测路径、且会被 sidecar 来源授权
        # 校验拒绝；patch_install.py 自身三处同文案已有专门测试，这里补窗口监控拼接的这处。
        # issue #163：脚本还要指向运行目录副本，clone 删除后裸文件名无处可解析。
        self.tmp.write_bytes(b"pending")
        def stop(_):
            raise KeyboardInterrupt
        with mock.patch.object(self.monitor, "QUIET", False), \
                mock.patch.object(sys, "argv", ["install_monitor.py", "0"]), \
                mock.patch.object(self.monitor, "patch_module", return_value=self.patch), \
                mock.patch.object(self.patch, "pending_tmp", return_value={"operation": "install"}), \
                mock.patch.object(self.monitor, "zcode_pids", return_value=set()), \
                mock.patch.object(self.monitor, "finalize_tmp", return_value=False), \
                mock.patch.object(self.monitor, "draw") as draw, \
                mock.patch.object(self.monitor.time, "sleep", side_effect=stop):
            with self.assertRaises(KeyboardInterrupt):
                self.monitor.main()
        lines = draw.call_args.args[0]
        output = "\n".join(lines)
        tool = self.monitor.RUNTIME_DIR / "patch_install.py"
        self.assertIn(f'--asar "{self.asar}"', output)
        self.assertIn(f'--runtime "{self.patch.RUNTIME}"', output)
        self.assertIn(f'python "{tool}"', output)

    def test_visible_monitor_upgrade_hint_points_at_runtime_copy(self):
        # issue #163 review（变异 M9 守护）：「已重启但未检测到注入加载」的请重新运行
        # 提示同样要指向运行目录副本，裸文件名在 clone 删除后无法执行。
        # 进程序列：启动采集 {"1"}（旧实例），随后新实例 {"2"}（与采集不相交）；
        # 时间序列：t0=100 → 轮1 now=100（记 new_since，显示「正在确认」）→ 轮2 now=221
        # （超过 CONFIRM_WAIT=120，进入升级提示分支）；sleep 首次放行、二次中断收帧。
        with mock.patch.dict(sys.modules, {"patch_install": self.patch}), \
                mock.patch.object(self.monitor, "QUIET", False), \
                mock.patch.object(sys, "argv", ["install_monitor.py", "0"]), \
                mock.patch.object(self.monitor, "patch_module", return_value=self.patch), \
                mock.patch.object(self.monitor, "zcode_pids", side_effect=[{"1"}, {"2"}, {"2"}]), \
                mock.patch.object(self.monitor.time, "time", side_effect=[100, 100, 221]), \
                mock.patch.object(self.monitor, "draw") as draw, \
                mock.patch.object(self.monitor.time, "sleep", side_effect=[None, KeyboardInterrupt()]):
            with self.assertRaises(KeyboardInterrupt):
                self.monitor.main()
        output = "\n".join(draw.call_args.args[0])
        tool = self.monitor.RUNTIME_DIR / "patch_install.py"
        self.assertIn("请重新运行", output)
        self.assertIn(f'python "{tool}"', output)
        self.assertNotIn('python patch_install.py', output)

    def test_visible_monitor_remove_fallback_hint_has_no_runtime_flag(self):
        # remove 不走来源授权的 runtime 校验，提示不该带这个用不上的参数。
        self.tmp.write_bytes(b"pending")
        def stop(_):
            raise KeyboardInterrupt
        with mock.patch.object(self.monitor, "QUIET", False), \
                mock.patch.object(sys, "argv", ["install_monitor.py", "0"]), \
                mock.patch.object(self.monitor, "patch_module", return_value=self.patch), \
                mock.patch.object(self.patch, "pending_tmp", return_value={"operation": "remove"}), \
                mock.patch.object(self.monitor, "zcode_pids", return_value=set()), \
                mock.patch.object(self.monitor, "finalize_tmp", return_value=False), \
                mock.patch.object(self.monitor, "draw") as draw, \
                mock.patch.object(self.monitor.time, "sleep", side_effect=stop):
            with self.assertRaises(KeyboardInterrupt):
                self.monitor.main()
        output = "\n".join(draw.call_args.args[0])
        self.assertIn(f'remove --asar "{self.asar}"', output)
        self.assertNotIn("--runtime", output)

    def test_visible_monitor_upgrade_reinstall_hint_includes_asar_path(self):
        # 回归：ZCode 官方升级覆盖 asar 后提示"重新运行 install"（无 --finalize，不涉及
        # sidecar，不需要 --runtime），同样必须带 --asar 才能 standalone 跑通。
        with mock.patch.object(self.monitor, "QUIET", False), \
                mock.patch.object(sys, "argv", ["install_monitor.py", "0"]), \
                mock.patch.object(self.monitor, "zcode_pids", side_effect=[{"1"}, {"2"}, {"2"}]), \
                mock.patch.object(self.monitor, "diag_fresh", return_value=None), \
                mock.patch.object(self.monitor, "CONFIRM_WAIT", -1), \
                mock.patch.object(self.monitor, "draw") as draw, \
                mock.patch.object(self.monitor.time, "sleep", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.monitor.main()
        output = "\n".join(draw.call_args.args[0])
        self.assertIn(f'--asar "{self.asar}"', output)


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
