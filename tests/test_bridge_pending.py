# -*- coding: utf-8 -*-
"""issue #67：renderer 桥在受保护安装目录/客户端运行中的补装闭环。

复现两层根因并锁定新契约：
1) ensure_deployed 的就地 os.replace 被拒（权限不足/客户端占用）不再静默吞掉：
   返回 replace-failed 并保留完整 stage，交给调用方转存；
2) patch_install.publish_external_pending 把 stage 发布为 TMP+sidecar，
   finalize（客户端退出后）真正把桥落进 asar——issue 的端到端场景；
3) overlay_install 侧 pending / 权限不足要向 hook 输出可见提示，不再只写 stderr；
4) sudo_hint 在 Windows 打印可执行的管理员指引，而不是 unix 的 sudo 命令。
"""
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
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import renderer_bridge as bridge                     # noqa: E402
import test_renderer_bridge as rb                    # noqa: E402

INSTALLER_PATH = ROOT / "plugins" / "zcode-token-usage-statusbar" / "overlay_install.py"


def load_installer():
    spec = importlib.util.spec_from_file_location("bridge_pending_overlay_install", str(INSTALLER_PATH))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BridgePendingTests(unittest.TestCase):
    """replace 被拒 → stage 保留 → publish_external_pending → finalize 落桥。"""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="bridge-pending-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.target = self.root / "app.asar"
        self.pin = mock.patch.object(bridge, "HOST_TARGETS",
                                     [rb.synthetic_target(bridge.NEWEST, rb.MINI)])
        self.pin.start()
        self.addCleanup(self.pin.stop)
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        (self.runtime / "inject-main.cjs").write_text("// fixture", encoding="utf-8")
        spec = importlib.util.spec_from_file_location("bridge_pending_patch_install", str(ROOT / "patch_install.py"))
        self.pi = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.pi)
        self.pi.set_target(self.target)
        self.pi.set_runtime(self.runtime)
        env = mock.patch.dict(os.environ, {"HOME": str(self.root / "home"),
                                           "ZUSAGE_NO_MONITOR": "1", "ZUSAGE_MONITOR_QUIET": ""})
        env.start()
        self.addCleanup(env.stop)
        syntax = mock.patch.object(self.pi, "syntax_check", return_value=True)
        syntax.start()
        self.addCleanup(syntax.stop)
        process = mock.patch.object(self.pi, "client_running", return_value=False)
        process.start()
        self.addCleanup(process.stop)
        # 桥补丁发生在 asar 已注入之后（run_hook 只在 injected/install ok 后补桥）：
        # 夹具带注入行主入口，self_check(expect=install) 才能通过；注入行必须指向
        # self.pi 的 runtime（self_check 按精确字节比对）
        rb.archive(self.target, extra={"/out/main/index.js":
                                       b"console.log('official v1');\n" +
                                       self.pi.INJECT_LINE.encode()})

    def replace_refused(self, stage, destination):
        # 只拒绝落到目标 asar 的发布（权限/占用场景）；其余 replace 正常执行
        if Path(destination) == self.target:
            raise OSError(5, "拒绝访问", str(destination))
        return self.real_replace(stage, destination)

    def test_replace_failure_returns_stage_and_pending_flow_deploys_bridge(self):
        before = self.target.read_bytes()
        self.real_replace = bridge.os.replace
        with mock.patch.object(bridge.os, "replace", side_effect=self.replace_refused):
            result = bridge.ensure_deployed(self.target)
        self.assertEqual(result["status"], "replace-failed")
        self.assertEqual(result["version"], bridge.HOST_VERSION)
        self.assertIn("拒绝访问", result["detail"])
        stage = Path(result["stage"])
        self.assertTrue(stage.is_file(), "stage 必须保留给调用方转存")
        self.assertIn("source", result)
        # asar 本体未被破坏；stage 是完整带桥包
        self.assertEqual(self.target.read_bytes(), before)
        self.assertIn(bridge.MARKER, rb.read(stage))
        # 转存为待替换包：sidecar 合法、来源指纹绑定当前 asar
        meta = self.pi.publish_external_pending(stage, source=result["source"])
        self.assertFalse(stage.exists(), "stage 已被消费")
        self.assertTrue(self.pi.TMP.is_file())
        self.assertEqual(self.pi.pending_tmp(operation="install"), meta)
        # 客户端退出后收尾：桥真正落进 asar（issue 的端到端场景）
        self.assertTrue(self.pi.finalize_tmp(operation="install"))
        self.assertFalse(self.pi.TMP.exists())
        self.assertIn(bridge.MARKER, rb.read(self.target))
        self.assertEqual(bridge.ensure_deployed(self.target)["status"], "present")

    def test_publish_refuses_when_asar_changed_and_cleans_stage(self):
        self.real_replace = bridge.os.replace
        with mock.patch.object(bridge.os, "replace", side_effect=self.replace_refused):
            result = bridge.ensure_deployed(self.target)
        stage = Path(result["stage"])
        # 官方升级重写了 asar：转存必须拒绝（防旧包覆盖新版），stage 被清理
        rb.archive(self.target, module=rb.MINI + b" ")
        with self.assertRaises(self.pi.PendingTmpError):
            self.pi.publish_external_pending(stage, source=result["source"])
        self.assertFalse(stage.exists())
        self.assertFalse(self.pi.TMP.exists())
        self.assertFalse(self.pi.TMP_META.exists())

    def test_publish_refuses_pending_remove_inside_lock(self):
        # TOCTOU 防线（二审）：锁外快照漏读没关系，publish 拿锁后必须自己拒绝
        # 已成立的 remove pending，否则并发卸载会被自动补桥静默回滚
        self.real_replace = bridge.os.replace
        with mock.patch.object(bridge.os, "replace", side_effect=self.replace_refused):
            first = bridge.ensure_deployed(self.target)
        self.pi.publish_external_pending(Path(first["stage"]), source=first["source"])
        self.pi._cancel_pending_install()
        self.assertEqual(self.pi.pending_operation(), "cancelled")
        with mock.patch.object(bridge.os, "replace", side_effect=self.replace_refused):
            second = bridge.ensure_deployed(self.target)
        stage2 = Path(second["stage"])
        # 直接把 sidecar 标成 remove（模拟用户卸载排定 pending remove）
        meta = self.pi._load_tmp_metadata()
        meta["operation"] = "remove"
        self.pi._atomic_tmp_metadata(meta)
        with self.assertRaises(self.pi.PendingTmpError):
            self.pi.publish_external_pending(stage2, source=second["source"])
        self.assertEqual(self.pi.pending_operation(), "remove", "remove 意图未被覆盖")
        self.assertFalse(stage2.exists())
        stage2.unlink(missing_ok=True)

    def test_bridge_stage_without_injection_line_is_refused(self):
        # 主注入还在 pending（asar 尚无注入行）时，桥 stage 不含注入行——
        # self_check(expect=install) 防线必须拒绝，不能用无注入行的包覆盖主链
        plain = self.root / "plain.asar"
        rb.archive(plain, extra={"/out/main/index.js": b"console.log('official v1');\n"})
        before = plain.read_bytes()
        real_replace = bridge.os.replace

        def refuse_plain(stage, destination):
            if Path(destination) == plain:
                raise OSError(5, "拒绝访问", str(destination))
            return real_replace(stage, destination)

        with mock.patch.object(bridge.os, "replace", side_effect=refuse_plain):
            result = bridge.ensure_deployed(plain)
        self.assertEqual(result["status"], "replace-failed")
        self.pi.set_target(plain)
        with self.assertRaises(self.pi.PendingTmpError):
            self.pi.publish_external_pending(Path(result["stage"]), source=result["source"])
        self.assertEqual(plain.read_bytes(), before)

    def test_crashed_stage_leftovers_are_cleaned_on_next_ensure(self):
        orphan = self.root / ".zusage-bridge-deadbeef"
        orphan.write_bytes(b"stale")
        stale_time = os.stat(orphan).st_mtime - 3600
        os.utime(orphan, (stale_time, stale_time))
        fresh = self.root / ".zusage-bridge-justnow"
        fresh.write_bytes(b"fresh")   # 刚产生的 stage（并发移交窗口）不能被误删
        self.assertEqual(bridge.ensure_deployed(self.target)["status"], "patched")
        self.assertFalse(orphan.exists())
        self.assertTrue(fresh.exists())

    def test_permission_error_is_flagged_from_stage_build(self):
        # 权限场景 1（Program Files 只读 ACL）：stage 构建阶段就 PermissionError——
        # permission 标记的生产端必须钉住，否则 Windows 静默失效可原样回归
        before = self.target.read_bytes()
        with mock.patch.object(bridge.tempfile, "mkstemp",
                               side_effect=PermissionError(13, "Permission denied")):
            result = bridge.ensure_deployed(self.target)
        self.assertEqual(result["status"], "skipped-error")
        self.assertIs(result.get("permission"), True)
        self.assertEqual(self.target.read_bytes(), before)
        self.assertFalse(list(self.root.glob(".zusage-bridge-*")))

    def test_publish_crash_keeps_previous_tmp_in_journal(self):
        # 已有合法 TMP 时再次 publish 崩溃于 rename 前：journal 必须记 previous_tmp，
        # 恢复链（_owned_tmp_metadata）才能认领旧包而不是丢弃重装（变异审查补网）
        self.real_replace = bridge.os.replace
        with mock.patch.object(bridge.os, "replace", side_effect=self.replace_refused):
            first = bridge.ensure_deployed(self.target)
        self.pi.publish_external_pending(Path(first["stage"]), source=first["source"])
        first_tmp = self.pi.pending_tmp(operation="install")
        # 第二轮：asar 未变仍缺桥 → 再次 replace 被拒 → 新 stage → publish 在
        # rename(stage→TMP) 前崩溃（journal 已写、rename 未发生窗口）
        with mock.patch.object(bridge.os, "replace", side_effect=self.replace_refused):
            second = bridge.ensure_deployed(self.target)
        stage2 = Path(second["stage"])
        real_publish_replace = os.replace

        def crash_before_tmp(stage, destination):
            if Path(destination) == self.pi.TMP:
                raise OSError(5, "拒绝访问", str(destination))
            return real_publish_replace(stage, destination)
        with mock.patch.object(self.pi.os, "replace", side_effect=crash_before_tmp):
            with self.assertRaises(OSError):
                self.pi.publish_external_pending(stage2, source=second["source"])
        journal = json.loads(self.pi.TMP_META.read_text(encoding="utf-8"))
        self.assertIn("previous_tmp", journal)
        self.assertEqual(journal["previous_tmp"]["sha256"], first_tmp["tmp"]["sha256"])
        self.pi._owned_tmp_metadata()   # 不抛 PendingTmpError：旧包可被认领恢复
        stage2.unlink(missing_ok=True)


class OverlayBridgeNoticeTests(unittest.TestCase):
    """overlay_install.ensure_renderer_bridge / run_hook 的可见反馈。"""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="bridge-notice-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.installer = load_installer()
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        self.plugin = self.root / "plugin"
        self.plugin.mkdir()
        for name in ("patch_install.py", "renderer_bridge.py", "restart_notice.py",
                     "install_monitor.py", "runtime_lock.py"):
            source = ROOT / "plugins" / "zcode-token-usage-statusbar" / name
            if source.exists():
                (self.plugin / name).write_bytes(source.read_bytes())
        notice_spec = importlib.util.spec_from_file_location(
            "bridge_pending_restart_notice", str(self.plugin / "restart_notice.py"))
        notice = importlib.util.module_from_spec(notice_spec)
        notice_spec.loader.exec_module(notice)
        self.notice = notice
        for name, module in (("restart_notice", notice),):
            patcher = mock.patch.dict(sys.modules, {name: module})
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = mock.patch.object(self.installer, "PLUGIN_ROOT", self.plugin)
        patcher.start()
        self.addCleanup(patcher.stop)

    def pi_stub(self, writable=True):
        pi = mock.Mock()
        pi.ASAR = self.root / "app.asar"
        pi.target_writable.return_value = writable
        return pi

    def ensure_quiet_env(self):
        return mock.patch.dict(os.environ, {"ZUSAGE_NO_MONITOR": "1", "ZUSAGE_MONITOR_QUIET": ""})

    def test_replace_failed_becomes_pending_with_quiet_monitor(self):
        stage = self.root / "stage.asar"
        stage.write_bytes(b"bridged archive")
        result = {"status": "replace-failed", "version": "3.16.2",
                  "detail": "拒绝访问", "stage": str(stage), "source": {"sha256": "x"}}
        bridge_module = mock.Mock()
        bridge_module.ensure_deployed.return_value = result
        pi = self.pi_stub()
        pi.publish_external_pending.return_value = {"validated": True}
        with mock.patch.dict(sys.modules, {"renderer_bridge": bridge_module}), \
                self.ensure_quiet_env():
            with contextlib.redirect_stderr(io.StringIO()):
                outcome = self.installer.ensure_renderer_bridge(pi, quiet_monitor=True)
        self.assertEqual(outcome["status"], "pending")
        pi.publish_external_pending.assert_called_once_with(
            stage, source=result["source"], operation="install")
        pi.launch_monitor.assert_called_once()

    def test_pending_publish_failure_falls_back_to_skipped_error_and_cleans_stage(self):
        stage = self.root / "stage.asar"
        stage.write_bytes(b"bridged archive")
        result = {"status": "replace-failed", "version": "3.16.2",
                  "detail": "拒绝访问", "stage": str(stage), "source": None}
        bridge_module = mock.Mock()
        bridge_module.ensure_deployed.return_value = result
        pi = self.pi_stub()
        pi.publish_external_pending.side_effect = OSError("disk full")
        with mock.patch.dict(sys.modules, {"renderer_bridge": bridge_module}), \
                self.ensure_quiet_env():
            with contextlib.redirect_stderr(io.StringIO()):
                outcome = self.installer.ensure_renderer_bridge(pi, quiet_monitor=True)
        self.assertEqual(outcome["status"], "skipped-error")
        self.assertIn("pending publish failed", outcome["detail"])
        self.assertFalse(stage.exists())
        pi.launch_monitor.assert_not_called()

    def test_pending_publish_permission_error_keeps_flag(self):
        # 权限场景在 publish 阶段爆发（目录可读但 TMP 落盘被拒）也要保留标记
        stage = self.root / "stage.asar"
        stage.write_bytes(b"bridged archive")
        result = {"status": "replace-failed", "version": "3.16.2",
                  "detail": "拒绝访问", "stage": str(stage), "source": None}
        bridge_module = mock.Mock()
        bridge_module.ensure_deployed.return_value = result
        pi = self.pi_stub()
        pi.publish_external_pending.side_effect = PermissionError(5, "拒绝访问")
        with mock.patch.dict(sys.modules, {"renderer_bridge": bridge_module}), \
                self.ensure_quiet_env():
            with contextlib.redirect_stderr(io.StringIO()):
                outcome = self.installer.ensure_renderer_bridge(pi, quiet_monitor=True)
        self.assertEqual(outcome["status"], "skipped-error")
        self.assertIs(outcome.get("permission"), True)
        self.assertFalse(stage.exists())
        # 消费端闭环：该结果经 _bridge_notice 必须产出权限提示
        self.assertIn("受保护目录", self.installer._bridge_notice({}, outcome, pi)["systemMessage"])

    def test_pending_remove_intent_wins_over_auto_bridge(self):
        stage = self.root / "stage.asar"
        stage.write_bytes(b"bridged archive")
        result = {"status": "replace-failed", "version": "3.16.2",
                  "detail": "拒绝访问", "stage": str(stage), "source": None}
        bridge_module = mock.Mock()
        bridge_module.ensure_deployed.return_value = result
        pi = self.pi_stub()
        pi.pending_operation.return_value = "remove"
        with mock.patch.dict(sys.modules, {"renderer_bridge": bridge_module}), \
                self.ensure_quiet_env():
            with contextlib.redirect_stderr(io.StringIO()):
                outcome = self.installer.ensure_renderer_bridge(pi, quiet_monitor=True)
        self.assertEqual(outcome["status"], "skipped-error")
        self.assertIn("卸载", outcome["detail"])
        self.assertFalse(stage.exists())
        pi.publish_external_pending.assert_not_called()
        pi.launch_monitor.assert_not_called()

    def test_quiet_monitor_env_contract_and_restore(self):
        stage = self.root / "stage.asar"
        stage.write_bytes(b"bridged archive")
        result = {"status": "replace-failed", "version": "3.16.2",
                  "detail": "拒绝访问", "stage": str(stage), "source": None}
        bridge_module = mock.Mock()
        bridge_module.ensure_deployed.return_value = result
        pi = self.pi_stub()
        seen = {}

        def launch(epoch):
            seen["quiet"] = os.environ.get("ZUSAGE_MONITOR_QUIET")
            seen["no_monitor"] = os.environ.get("ZUSAGE_NO_MONITOR")
        pi.launch_monitor.side_effect = launch
        pre = {name: os.environ.get(name) for name in ("ZUSAGE_MONITOR_QUIET", "ZUSAGE_NO_MONITOR")}
        with mock.patch.dict(os.environ, {"ZUSAGE_MONITOR_QUIET": "",
                                          "ZUSAGE_NO_MONITOR": ""}), \
                mock.patch.dict(sys.modules, {"renderer_bridge": bridge_module}):
            with contextlib.redirect_stderr(io.StringIO()):
                outcome = self.installer.ensure_renderer_bridge(pi, quiet_monitor=True)
        self.assertEqual(outcome["status"], "pending")
        self.assertEqual(seen, {"quiet": "1", "no_monitor": "1"})
        # 调用后进程环境必须还原进入前的值，不污染同 hook 里的后续逻辑
        self.assertEqual({name: os.environ.get(name) for name in pre}, pre)

    def hook_output(self, bridge_result, writable=True, injected=True):
        bridge_module = mock.Mock()
        bridge_module.ensure_deployed.return_value = bridge_result
        pi = self.pi_stub(writable=writable)
        with mock.patch.dict(sys.modules, {"renderer_bridge": bridge_module}), \
                mock.patch.object(self.installer, "resolve_paths", return_value=(self.runtime, pi)), \
                mock.patch.object(self.installer, "sync_runtime", return_value={"changed": []}), \
                mock.patch.object(self.installer, "injected_status", return_value=injected), \
                mock.patch.object(self.installer, "save_runtime_config"), \
                self.ensure_quiet_env():
            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                outcome = self.installer.run_hook()
        return outcome, stdout.getvalue()

    def test_run_hook_reports_pending_and_permission_but_not_other_errors(self):
        pending = {"status": "pending", "version": "3.16.2", "detail": ""}
        outcome, stdout = self.hook_output(pending)
        self.assertIn("hookSpecificOutput", outcome)
        self.assertIn("退出 ZCode", outcome["systemMessage"])
        self.assertEqual(stdout, "")
        # 权限不足按真实 PermissionError 标记判定（Windows 的 os.access 看不见 ACL，
        # target_writable() 恒 True 的 Program Files 场景也必须提示）
        denied = {"status": "skipped-error", "version": None,
                  "detail": "[WinError 5] 拒绝访问", "permission": True}
        outcome, stdout = self.hook_output(denied, writable=True)
        self.assertIn("管理员" if os.name == "nt" else "sudo", outcome["systemMessage"])
        self.assertIn(str(self.root / "app.asar"), outcome["systemMessage"])
        self.assertEqual(stdout, "")
        # 无权限标记的普通失败仍走 stderr 静默（版本不识别等），不打扰用户
        plain = dict(denied); plain.pop("permission")
        outcome, stdout = self.hook_output(plain)
        self.assertNotIn("systemMessage", outcome)
        self.assertEqual(stdout, "")

    def test_windows_permission_notice_uses_administrator_hint(self):
        denied = {"status": "skipped-error", "version": None,
                  "detail": "[WinError 5] 拒绝访问", "permission": True}
        # 直接单测 _bridge_notice：mock 全局 os.name 会让 pathlib 在非 Windows 上
        # 实例化 WindowsPath，无法走完整 run_hook
        with mock.patch.object(self.installer.os, "name", "nt"):
            outcome = self.installer._bridge_notice({}, denied, self.pi_stub())
        self.assertIn("管理员", outcome["systemMessage"])
        self.assertIn("overlay_install.py", outcome["systemMessage"])
        self.assertNotIn("sudo", outcome["systemMessage"])

    def test_run_hook_does_not_override_primary_install_notice(self):
        bridge_module = mock.Mock()
        bridge_module.ensure_deployed.return_value = {"status": "pending", "version": "3.16.2", "detail": ""}
        pi = self.pi_stub()
        primary = {"suppressOutput": True, "systemMessage": "更重要的安装/重启提示",
                   "hookSpecificOutput": {"hookEventName": "SessionStart",
                                          "additionalContext": "primary"}}
        with mock.patch.dict(sys.modules, {"renderer_bridge": bridge_module}), \
                mock.patch.object(self.installer, "resolve_paths", return_value=(self.runtime, pi)), \
                mock.patch.object(self.installer, "sync_runtime", return_value={"changed": []}), \
                mock.patch.object(self.installer, "injected_status", return_value=True), \
                mock.patch.object(self.installer, "save_runtime_config"), \
                mock.patch.object(self.notice, "session_notice", return_value=primary), \
                self.ensure_quiet_env():
            with contextlib.redirect_stdout(io.StringIO()):
                outcome = self.installer.run_hook()
        self.assertEqual(outcome["systemMessage"], "更重要的安装/重启提示")


class RealHookChainTests(unittest.TestCase):
    """hook 路径 + 真实 patch_install/renderer_bridge 全链（BLOCKER 回归）：
    publish/syntax 检查的 [check] 输出不得污染 hook stdout。"""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="bridge-real-chain-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.target = self.root / "app.asar"
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        (self.runtime / "inject-main.cjs").write_text("// fixture", encoding="utf-8")
        spec = importlib.util.spec_from_file_location("real_chain_patch_install", str(ROOT / "patch_install.py"))
        self.pi = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.pi)
        self.pi.set_target(self.target)
        self.pi.set_runtime(self.runtime)
        self.pin = mock.patch.object(bridge, "HOST_TARGETS",
                                     [rb.synthetic_target(bridge.NEWEST, rb.MINI)])
        self.pin.start()
        self.addCleanup(self.pin.stop)
        rb.archive(self.target, extra={"/out/main/index.js":
                                       b"console.log('official v1');\n" + self.pi.INJECT_LINE.encode()})
        self.installer = load_installer()
        notice_spec = importlib.util.spec_from_file_location(
            "real_chain_restart_notice", str(ROOT / "plugins" / "zcode-token-usage-statusbar" / "restart_notice.py"))
        notice = importlib.util.module_from_spec(notice_spec)
        notice_spec.loader.exec_module(notice)
        patcher = mock.patch.dict(sys.modules, {"restart_notice": notice})
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = mock.patch.object(self.installer, "PLUGIN_ROOT",
                                    ROOT / "plugins" / "zcode-token-usage-statusbar")
        patcher.start()
        self.addCleanup(patcher.stop)
        env = mock.patch.dict(os.environ, {"HOME": str(self.root / "home"),
                                           "ZUSAGE_NO_MONITOR": "1", "ZUSAGE_MONITOR_QUIET": ""})
        env.start()
        self.addCleanup(env.stop)
        for name, patcher in (("syntax_check", mock.patch.object(self.pi, "syntax_check", return_value=True)),
                              ("launch_monitor", mock.patch.object(self.pi, "launch_monitor", return_value=None)),
                              ("client_running", mock.patch.object(self.pi, "client_running", return_value=False))):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_hook_stdout_stays_pure_json_through_real_pending_chain(self):
        real_replace = bridge.os.replace
        # pi.ASAR 经 set_target resolve（macOS 上 /var→/private/var 符号链接会改写
        # 路径），拒绝判定必须与 resolve 后的目标比较
        refused_target = self.pi.ASAR

        def replace_refused(stage, destination):
            if Path(destination) == refused_target:
                raise OSError(5, "拒绝访问", str(destination))
            return real_replace(stage, destination)

        with mock.patch.object(bridge.os, "replace", side_effect=replace_refused), \
                mock.patch.object(self.installer, "resolve_paths", return_value=(self.runtime, self.pi)), \
                mock.patch.object(self.installer, "sync_runtime", return_value={"changed": []}), \
                mock.patch.object(self.installer, "injected_status", return_value=True), \
                mock.patch.object(self.installer, "save_runtime_config"), \
                mock.patch.dict(sys.modules, {"plugin_auto_update": mock.Mock()}):
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(io.StringIO()):
                outcome = self.installer.run_hook()
        self.assertEqual(stdout.getvalue(), "", "hook stdout 只能是 hook JSON")
        self.assertIn("退出 ZCode", outcome.get("systemMessage", ""))
        self.assertTrue(self.pi.TMP.is_file())
        self.assertEqual(self.pi.pending_tmp(operation="install")["operation"], "install")
        self.pi.launch_monitor.assert_called_once()


class SudoHintWindowsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="sudo-hint-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        spec = importlib.util.spec_from_file_location(
            "sudo_hint_patch_install", str(ROOT / "patch_install.py"))
        self.pi = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.pi)
        self.pi.set_target(self.root / "app.asar")
        self.pi._LANG = "en"

    def test_windows_hint_is_actionable_not_sudo(self):
        self.pi.IS_WIN = True
        # 插件目录形态：patch_install.py 旁边有 overlay_install.py
        (self.root / "overlay_install.py").write_text("# plugin installer", encoding="utf-8")
        output = io.StringIO()
        with mock.patch.object(self.pi, "__file__", str(self.root / "patch_install.py")), \
                contextlib.redirect_stdout(output):
            self.pi.sudo_hint("install")
        text = output.getvalue()
        self.assertNotIn("sudo env", text)   # 夹具路径本身可能含 "sudo"，按命令形状断言
        self.assertIn("administrator", text.lower())
        self.assertIn("overlay_install.py", text)
        self.assertIn("install", text)

    def test_posix_hint_keeps_sudo_with_home_path(self):
        self.pi.IS_WIN = False
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.pi.sudo_hint("remove")
        text = output.getvalue()
        self.assertIn("sudo", text)
        self.assertIn("HOME=", text)
        self.assertIn("remove", text)


if __name__ == "__main__":
    unittest.main()
