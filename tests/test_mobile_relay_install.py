# -*- coding: utf-8 -*-
"""安装入口的 relay 旧代升级与 asar 待替换合并。"""
import contextlib
import hashlib
import io
import json
import os
import shutil
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

from tests.helpers.py_test_support import load_module, make_asar

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import mobile_relay_patch as mobile
import renderer_bridge as bridge

BODY = (b'function attach(){return Q.relayProtocol=Ce,Q.disposeBridge=()=>{}}'
        b'function Fg(h,y){let D=h.currentBridge;return!D||D.degraded?!1:'
        b'D.relayProtocol?.acceptPayload(y)??!1}'
        b'new X({onRawTransportPayload:s(ve=>Fg(ye,ve),"onRawTransportPayload")});')
ANCHOR = b'onRawTransportPayload:s(ve=>Fg(ye,ve),"onRawTransportPayload")'
LEGACY = (b'onRawTransportPayload:s(ve=>(ve&&ve.zuUp?((globalThis.'
          b'__zusageRelayUplinkQueue=globalThis.__zusageRelayUplinkQueue||[]).push(ve),'
          b'true):0)||Fg(ye,ve),"onRawTransportPayload")')
OLD_V2 = (b'onRawTransportPayload:s(ve=>(ve&&ve.zuUp?((__zuBridge)=>'
          b'((globalThis.__zusageRelayUplinkQueue=globalThis.__zusageRelayUplinkQueue||[]).push('
          b'{frame:ve,b:__zuBridge,relay:__zuBridge?__zuBridge.relayProtocol:void 0}),true))'
          b'(ye.currentBridge):0)||Fg(ye,ve),"onRawTransportPayload")')


class MobileInstallTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="mobile-install-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.target = self.root / "app.asar"
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        (self.runtime / "inject-main.cjs").write_text("// fixture", encoding="utf-8")
        self.pi = load_module("mobile_install_pi", ROOT / "patch_install.py")
        self.pi.set_target(self.target)
        self.pi.set_runtime(self.runtime)
        self.installer = load_module("mobile_install_plugin", ROOT / "plugins" /
                                     "zcode-token-usage-statusbar" / "overlay_install.py")
        self.standalone = load_module("mobile_install_standalone", ROOT / "install.py")
        target = bridge.NEWEST
        names, pane = target["names"], target["pane"]
        signature = ','.join(pane.get(k, "t") for k in ("paneId", "sessionId", "workspacePath",
                                                "workspaceIdentity", "remoteSessionId"))
        renderer = (f'const {names["registry"]}=new Map;function {names["key"]}(e){{return e.workspacePath}}'
                    f'function {names["topic"]}(e){{return e}}function SessionPane({signature}){{return {{').encode()
        renderer += pane["anchor"] + b'children:null}}export{ ' + names["registry"].encode() + b' };'
        pin = dict(target, sha256=hashlib.sha256(renderer).hexdigest())
        self.pin = mock.patch.object(bridge, "HOST_TARGETS", [pin])
        self.pin.start()
        self.addCleanup(self.pin.stop)
        self.renderer = renderer
        self._write_legacy_asar()

    def _write_legacy_asar(self):
        """重建「loader 注入行在位 + 旧代 relay 注入」的目标 asar（handover 用例按 owner 复位）。"""
        stash = mobile.inject_for(b"relayProtocol=Ce,Q.disposeBridge")
        old = BODY.replace(b"relayProtocol=Ce,", b"relayProtocol=Ce," + stash).replace(ANCHOR, LEGACY)
        target = bridge.NEWEST
        make_asar(self.target, files={"package.json": json.dumps({"name": "@zcode/desktop", "type": "module", "version": target["version"]}).encode(),
                                     "out/main/index.js": old + self.pi.INJECT_LINE.encode(),
                                     target["asset"]: self.renderer})
        # Relay derives against this synthetic main bundle rather than the real pinned hash.
        p = mock.patch.object(mobile, "MOBILE_RELAY_TARGETS", [])
        p.start()
        self.addCleanup(p.stop)
        for attr, value in (("syntax_check", True), ("client_running", False)):
            p = mock.patch.object(self.pi, attr, return_value=value)
            p.start()
            self.addCleanup(p.stop)
        p = mock.patch.object(self.pi, "launch_monitor")
        self.monitor = p.start()
        self.addCleanup(p.stop)
        self.env = mock.patch.dict(os.environ, {"HOME": str(self.root / "home"), "ZUSAGE_NO_MONITOR": "1"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def _enable_mobile_relay(self):
        (self.runtime / "config.json").write_text('{"mobile_relay": {"enabled": true}}', encoding="utf-8")

    def test_real_hook_upgrades_already_injected_legacy(self):
        with mock.patch.object(self.installer, "resolve_paths", return_value=(self.runtime, self.pi)), \
             mock.patch.object(self.installer, "sync_runtime"), \
             mock.patch.object(self.installer, "injected_status", return_value=True), \
             mock.patch.object(self.installer, "save_runtime_config"), \
             mock.patch.dict(sys.modules, {"plugin_auto_update": mock.Mock()}), \
             contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
            result = self.installer.run_hook()
        self.assertEqual(out.getvalue(), "")
        self.assertNotIn("systemMessage", result)
        self.assertEqual(mobile.check_deployed(self.target)["uplink_generation"], 2)
        self.assertTrue(self.pi.self_check(self.target, expect=True))

    def test_locked_target_defers_second_patch_until_next_session(self):
        real_replace = os.replace
        def replace(src, dst):
            if Path(dst) == self.pi.ASAR:
                raise PermissionError("locked")
            return real_replace(src, dst)
        with mock.patch.object(os, "replace", side_effect=replace), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.installer.ensure_renderer_bridge(self.pi)["status"], "pending")
            before = self.pi.TMP.read_bytes(), self.pi.TMP_META.read_bytes()
            self.assertEqual(self.installer.ensure_mobile_relay_stash(self.pi)["status"], "deferred")
            self.assertEqual((self.pi.TMP.read_bytes(), self.pi.TMP_META.read_bytes()), before)
        self.assertTrue(self.pi.finalize_tmp())
        self.assertEqual(self.installer.ensure_mobile_relay_stash(self.pi)["status"], "patched")
        self.assertEqual(mobile.check_deployed(self.target)["uplink_generation"], 2)

    def test_remove_and_invalid_pending_are_never_overwritten(self):
        real_replace = os.replace
        def replace(src, dst):
            if Path(dst) == self.pi.ASAR:
                raise PermissionError("locked")
            return real_replace(src, dst)
        with mock.patch.object(os, "replace", side_effect=replace), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.installer.ensure_renderer_bridge(self.pi)["status"], "pending")
        meta = self.pi._load_tmp_metadata()
        meta["operation"] = "remove"
        self.pi._atomic_tmp_metadata(meta)
        before = self.pi.TMP.read_bytes(), self.pi.TMP_META.read_bytes(), self.target.read_bytes()
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.installer.ensure_mobile_relay_stash(self.pi)["status"], "deferred")
            self.assertEqual(self.standalone.ensure_mobile_relay_stash(self.pi)["status"], "deferred")
        self.assertEqual((self.pi.TMP.read_bytes(), self.pi.TMP_META.read_bytes(), self.target.read_bytes()), before)
        self.pi.TMP_META.write_text("invalid", encoding="utf-8")
        before = self.pi.TMP.read_bytes(), self.pi.TMP_META.read_bytes()
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.installer.ensure_mobile_relay_stash(self.pi)["status"], "deferred")
        self.assertEqual((self.pi.TMP.read_bytes(), self.pi.TMP_META.read_bytes()), before)

    def test_explicit_plugin_install_upgrades_legacy(self):
        with mock.patch.object(self.installer, "resolve_paths", return_value=(self.runtime, self.pi)), \
             mock.patch.object(self.installer, "sync_runtime"), \
             mock.patch.object(self.installer, "_install_overlay", return_value=True), \
             mock.patch.object(self.installer, "save_runtime_config"), \
             mock.patch.object(self.installer, "chown_runtime_to_user"), \
             mock.patch.object(sys, "argv", ["overlay_install.py", "install"]), \
             contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as exit_code:
                self.installer.main()
        self.assertEqual(exit_code.exception.code, 0)
        self.assertEqual(mobile.check_deployed(self.target)["uplink_generation"], 2)

    def test_standalone_install_upgrades_legacy_and_dry_run_does_not(self):
        with mock.patch.object(self.standalone, "copy_runtime"), \
             mock.patch.object(self.standalone, "prepare_config"), \
             mock.patch.object(self.standalone, "remember_asar"), \
             mock.patch.object(self.pi, "install", return_value=True), \
             mock.patch.dict(sys.modules, {"patch_install": self.pi}), \
             mock.patch.object(sys, "argv", ["install.py", "--asar", str(self.target), "--no-mcp", "--dry-run"]), \
             contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.standalone.main(), 0)
            self.assertEqual(mobile.check_deployed(self.target)["uplink_generation"], 1)
            sys.argv.remove("--dry-run")
            self.assertEqual(self.standalone.main(), 0)
        self.assertEqual(mobile.check_deployed(self.target)["uplink_generation"], 2)

    def test_failed_mobile_replace_hands_over_to_pending_chain(self):
        real_replace = os.replace
        def replace(src, dst):
            if Path(dst) == self.pi.ASAR:
                raise PermissionError("locked")
            return real_replace(src, dst)
        for owner in (self.installer, self.standalone):
            with self.subTest(owner=owner.__name__):
                self.pi.TMP.unlink(missing_ok=True)     # 前 owner 失败残留不得干扰本 owner 归因
                self.pi.TMP_META.unlink(missing_ok=True)
                self._write_legacy_asar()
                original = self.target.read_bytes()
                (self.runtime / ".plugin-restart-required").unlink(missing_ok=True)
                with mock.patch.object(os, "replace", side_effect=replace), \
                        contextlib.redirect_stderr(io.StringIO()):
                    result = owner.ensure_mobile_relay_stash(self.pi)
                self.assertEqual(result["status"], "pending")
                self.assertEqual(self.pi.pending_operation(), "install")
                self.assertEqual(self.target.read_bytes(), original)
                self.assertEqual(list(self.root.glob(".mobile-relay-*")), [])
                self.monitor.assert_called()
                if owner is self.installer:
                    # 转存当轮记录 pending-install 标记（带 stage 入口指纹，swap 后销账用）
                    marker = json.loads((self.runtime / ".plugin-restart-required")
                                        .read_text(encoding="utf-8"))
                    self.assertEqual(marker["state"], "pending-install")
                    self.assertEqual(marker["installation"]["entryHash"],
                                     hashlib.sha256(self.pi.entry_bytes_of(self.pi.TMP)).hexdigest())
                else:
                    # 独立链不写重启标记（restart_notice.py 不在独立运行目录分发清单）
                    self.assertFalse((self.runtime / ".plugin-restart-required").exists())
                # 完全退出后监控收尾：补丁落位
                self.assertTrue(self.pi.finalize_tmp())
                self.assertEqual(mobile.check_deployed(self.target)["uplink_generation"], 2)
                self.monitor.reset_mock()

    def test_mobile_publish_failure_falls_back_to_skipped_error_and_cleans_stage(self):
        def takeover(stage, source=None, operation="install"):
            # 不预删 stage：锁外前置失败窗口（publish 的 finally 在锁体内不覆盖）
            # 由调用方兜底清理——本用例同时锁定该兜底
            raise OSError("[Errno 5] Input/output error")
        real_replace = os.replace
        def replace(src, dst):
            if Path(dst) == self.pi.ASAR:
                raise PermissionError("locked")
            return real_replace(src, dst)
        for owner in (self.installer, self.standalone):
            with self.subTest(owner=owner.__name__), \
                    mock.patch.object(os, "replace", side_effect=replace), \
                    mock.patch.object(self.pi, "publish_external_pending", side_effect=takeover), \
                    contextlib.redirect_stderr(io.StringIO()):
                result = owner.ensure_mobile_relay_stash(self.pi)
                self.assertEqual(result["status"], "skipped-error")
                self.assertIn("pending publish failed", result["detail"])
                self.assertFalse(self.pi.TMP.exists())
                self.assertFalse(self.pi.TMP_META.exists())
                self.assertEqual(list(self.root.glob(".mobile-relay-*")), [])
        self.monitor.assert_not_called()

    def test_mobile_quiet_monitor_env_set_and_restored_for_hook_chain(self):
        # 外层环境可能自带这两个变量（维护机 shell 预设过 ZUSAGE_MONITOR_QUIET=1）：
        # patch.dict 隔离出受控前值，测试不随执行环境漂移
        with mock.patch.dict(os.environ):
            os.environ.pop("ZUSAGE_MONITOR_QUIET", None)
            real_replace = os.replace
            def replace(src, dst):
                if Path(dst) == self.pi.ASAR:
                    raise PermissionError("locked")
                return real_replace(src, dst)
            captured = {}
            def launch(epoch):
                captured["no_monitor"] = os.environ.get("ZUSAGE_NO_MONITOR")
                captured["quiet"] = os.environ.get("ZUSAGE_MONITOR_QUIET")
            try:
                with mock.patch.object(os, "replace", side_effect=replace), \
                        mock.patch.object(self.pi, "launch_monitor", side_effect=launch), \
                        contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    result = self.installer.ensure_mobile_relay_stash(self.pi, quiet_monitor=True)
                self.assertEqual(result["status"], "pending")
                self.assertEqual(captured, {"no_monitor": "1", "quiet": "1"})   # SessionStart 静默不弹黑窗
                self.assertIsNone(os.environ.get("ZUSAGE_MONITOR_QUIET"))       # 调用后还原进前值
                self.assertEqual(os.environ.get("ZUSAGE_NO_MONITOR"), "1")      # setUp 既有值不动
            finally:
                self.pi.TMP.unlink(missing_ok=True)
                self.pi.TMP_META.unlink(missing_ok=True)
                (self.runtime / ".plugin-restart-required").unlink(missing_ok=True)

    def test_mobile_fingerprint_failure_still_hands_over_without_marker(self):
        real_replace = os.replace
        def replace(src, dst):
            if Path(dst) == self.pi.ASAR:
                raise PermissionError("locked")
            return real_replace(src, dst)
        real_entry = self.pi.entry_bytes_of
        calls = {"n": 0}
        def flaky_entry(path):
            # 仅指纹预取被杀毒锁住；publish 内部 self_check 随后恢复，走真实现
            calls["n"] += 1
            if calls["n"] == 1:
                raise OSError("av lock")
            return real_entry(path)
        try:
            with mock.patch.object(os, "replace", side_effect=replace), \
                    mock.patch.object(self.pi, "entry_bytes_of", side_effect=flaky_entry), \
                    contextlib.redirect_stderr(io.StringIO()):
                result = self.installer.ensure_mobile_relay_stash(self.pi)
            self.assertEqual(result["status"], "pending")
            self.assertGreaterEqual(calls["n"], 2)
            # 宁缺勿假：指纹取不到不写标记，缺 installation 的 pending-install 无法销账
            self.assertFalse((self.runtime / ".plugin-restart-required").exists())
            self.assertTrue(self.pi.TMP.exists())
        finally:
            self.pi.TMP.unlink(missing_ok=True)
            self.pi.TMP_META.unlink(missing_ok=True)

    def test_already_installed_does_not_copy_archive(self):
        self.assertEqual(self.standalone.ensure_mobile_relay_stash(self.pi)["status"], "patched")
        with mock.patch.object(shutil, "copy2", side_effect=AssertionError("copy forbidden")), \
                mock.patch.object(mobile, "_sweep_stale_stages", side_effect=AssertionError("write forbidden")), \
                mock.patch.object(mobile.asar, "bounded_mkstemp", side_effect=AssertionError("stage forbidden")):
            self.assertEqual(self.standalone.ensure_mobile_relay_stash(self.pi)["status"], "present")
            self.assertEqual(self.installer.ensure_mobile_relay_stash(self.pi)["status"], "present")

    def test_busy_lock_defers(self):
        # 锁窗口改造后锁获取下沉到 ensure_deployed 短锁：mock 那一层，并免掉 hook 侧退避 sleep
        with mock.patch("runtime_lock.file_lock", side_effect=TimeoutError("busy")), \
                mock.patch("time.sleep"):
            self.assertEqual(self.installer.ensure_mobile_relay_stash(self.pi)["status"], "deferred")
            self.assertEqual(self.standalone.ensure_mobile_relay_stash(self.pi)["status"], "deferred")

    def test_busy_lock_retries_once_then_succeeds(self):
        calls = {"n": 0}
        from runtime_lock import file_lock as real_file_lock

        def flaky_lock(path, timeout=10.0):
            calls["n"] += 1
            if calls["n"] == 1:
                raise TimeoutError("busy")
            return real_file_lock(path, timeout=timeout)

        with mock.patch("runtime_lock.file_lock", side_effect=flaky_lock), \
                mock.patch("time.sleep"):
            self.assertEqual(self.installer.ensure_mobile_relay_stash(self.pi)["status"], "patched")
        self.assertEqual(calls["n"], 2)

    def test_busy_lock_skips_retry_when_first_round_over_budget(self):
        # 首轮已含整包构建 + 等锁（>15s 预算）：不再退避重试，避免顶破 hook 60s
        # 被宿主杀掉——那样连限频提示都发不出
        calls = {"ensure": 0}

        def slow_ensure(path):
            calls["ensure"] += 1
            return {"status": "deferred", "detail": "runtime lock is busy: x"}

        with mock.patch.object(mobile, "ensure_deployed", side_effect=slow_ensure), \
                mock.patch("time.monotonic", side_effect=[0.0, 16.0]), \
                mock.patch("time.sleep"):
            result = self.installer.ensure_mobile_relay_stash(self.pi)
        self.assertEqual(result["status"], "deferred")
        self.assertEqual(calls["ensure"], 1)

    def test_failed_first_install_does_not_patch_untrusted_pending(self):
        for entry in ("hook", "plugin", "standalone"):
            for operation in ("remove", "invalid"):
                with self.subTest(entry=entry, operation=operation):
                    self.pi.prepare_tmp({}, source=self.pi.source_fingerprint(self.target))
                    if operation == "remove":
                        meta = self.pi._load_tmp_metadata()
                        meta["operation"] = "remove"
                        self.pi._atomic_tmp_metadata(meta)
                    else:
                        self.pi.TMP_META.write_text("invalid", encoding="utf-8")
                    before = self.pi.TMP.read_bytes(), self.pi.TMP_META.read_bytes()
                    try:
                        with contextlib.ExitStack() as stack:
                            for patcher in (
                                mock.patch.object(self.installer, "resolve_paths", return_value=(self.runtime, self.pi)),
                                mock.patch.object(self.installer, "sync_runtime"),
                                mock.patch.object(self.installer, "injected_status", return_value=False),
                                mock.patch.object(self.installer, "save_runtime_config"),
                                mock.patch.object(self.installer, "chown_runtime_to_user"),
                                mock.patch.object(self.installer, "_install_overlay", return_value=False),
                                mock.patch.object(self.standalone, "copy_runtime"),
                                mock.patch.object(self.standalone, "prepare_config"),
                                mock.patch.object(self.standalone, "remember_asar"),
                                mock.patch.object(self.pi, "install", return_value=False),
                                mock.patch.dict(sys.modules, {"patch_install": self.pi, "plugin_auto_update": mock.Mock()}),
                                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()),
                            ):
                                stack.enter_context(patcher)
                            patches = [stack.enter_context(mock.patch.object(owner, name)) for owner, name in (
                                (self.installer, "ensure_renderer_bridge"), (self.installer, "ensure_mobile_relay_stash"),
                                (self.standalone, "ensure_mobile_relay_stash"))]
                            if entry == "hook":
                                self.installer.run_hook()
                            elif entry == "plugin":
                                with mock.patch.object(sys, "argv", ["overlay_install.py", "install"]):
                                    with self.assertRaises(SystemExit):
                                        self.installer.main()
                            else:
                                with mock.patch.object(sys, "argv", ["install.py", "--asar", str(self.target), "--no-mcp", "--dev"]):
                                    self.assertEqual(self.standalone.main(), 1)
                            for patcher in patches:
                                patcher.assert_not_called()
                        self.assertEqual((self.pi.TMP.read_bytes(), self.pi.TMP_META.read_bytes()), before)
                    finally:
                        self.pi.TMP.unlink(missing_ok=True)
                        self.pi.TMP_META.unlink(missing_ok=True)

    def test_compatibility_notice_survives_mobile_deferral_in_both_hook_paths(self):
        for already_installed in (True, False):
            with self.subTest(already_installed=already_installed), contextlib.ExitStack() as stack:
                (self.runtime / ".plugin-compat-notice.json").unlink(missing_ok=True)
                for patcher in (
                    mock.patch.object(self.installer, "resolve_paths", return_value=(self.runtime, self.pi)),
                    mock.patch.object(self.installer, "sync_runtime"),
                    mock.patch.object(self.installer, "injected_status", return_value=already_installed),
                    mock.patch.object(self.installer, "save_runtime_config"),
                    mock.patch.object(self.installer, "_host_build", return_value="99.0.0"),
                    mock.patch.object(self.installer, "_host_registered", return_value=False),
                    mock.patch.object(self.installer, "_install_overlay", return_value=True),
                    mock.patch.object(self.installer, "ensure_renderer_bridge", return_value={"status": "skipped-unknown"}),
                    mock.patch.object(self.installer, "ensure_mobile_relay_stash", return_value={"status": "deferred"}),
                    mock.patch.object(self.installer, "_revive_orphan_pending"),
                    mock.patch.dict(sys.modules, {"plugin_auto_update": mock.Mock()}),
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()),
                ):
                    stack.enter_context(patcher)
                result = self.installer.run_hook()
                self.assertIn("99.0.0", result["systemMessage"])
                self.assertIn("99.0.0", result["hookSpecificOutput"]["additionalContext"])
                self.assertIn("兼容性提醒", result["hookSpecificOutput"]["additionalContext"])
                self.assertNotIn("手机远控增强尚未就绪", result["systemMessage"])

    def test_mobile_notice_preserves_existing_output_or_reports_deferral(self):
        self._enable_mobile_relay()
        existing = {"hookSpecificOutput": {"additionalContext": "original"}}
        self.assertIs(self.installer._mobile_pending_notice(existing, self.pi, {"status": "deferred"}), existing)
        self.assertEqual(existing, {"hookSpecificOutput": {"additionalContext": "original"}})
        output = {"suppressOutput": True}
        self.installer._mobile_pending_notice(output, self.pi, {"status": "deferred"})
        message = output["systemMessage"]
        self.assertIn("手机远控增强尚未就绪", message)
        self.assertIn("完全退出", message)
        self.assertIn("/install-overlay", message)
        self.assertNotIn("mobile_relay_patch.py", message)   # 会话提示给免终端路径，命令行仅保留在 CLI
        self.assertIn("手机远控增强尚未就绪", output["hookSpecificOutput"]["additionalContext"])

    def test_mobile_notice_splits_pending_and_waiting_from_manual_command(self):
        self._enable_mobile_relay()
        # pending：已排定自动收尾，不给手动命令
        scheduled = {"suppressOutput": True}
        self.installer._mobile_pending_notice(scheduled, self.pi, {"status": "pending"})
        message = scheduled["systemMessage"]
        self.assertIn("已排定", message)
        self.assertIn("完全退出", message)
        self.assertIn("自动完成", message)
        self.assertNotIn("mobile_relay_patch.py", message)
        # deferred + 既有待替换操作/bridge pending：等待收尾后自动补装，不给手动命令
        for detail in ("existing pending operation", "bridge pending"):
            waiting = {"suppressOutput": True}
            self.installer._mobile_pending_notice(waiting, self.pi,
                                                  {"status": "deferred", "detail": detail})
            self.assertIn("自动补装", waiting["systemMessage"])
            self.assertNotIn("mobile_relay_patch.py", waiting["systemMessage"])
        # 其余 deferred（锁超时等）：免终端重试路径，不给命令行
        manual = {"suppressOutput": True}
        self.installer._mobile_pending_notice(manual, self.pi,
                                              {"status": "deferred", "detail": "lock busy"})
        self.assertIn("手机远控增强尚未就绪", manual["systemMessage"])
        self.assertNotIn("mobile_relay_patch.py", manual["systemMessage"])
        # skipped-error 保持静默
        quiet = {"suppressOutput": True}
        self.assertIs(self.installer._mobile_pending_notice(
            quiet, self.pi, {"status": "skipped-error", "detail": "no host"}), quiet)
        self.assertNotIn("systemMessage", quiet)

    def test_deferred_notice_rate_limited_within_24h(self):
        self._enable_mobile_relay()
        first = {"suppressOutput": True}
        self.installer._mobile_pending_notice(first, self.pi,
                                              {"status": "deferred", "detail": "lock busy"})
        self.assertIn("手机远控增强尚未就绪", first["systemMessage"])
        second = {"suppressOutput": True}
        self.assertIs(self.installer._mobile_pending_notice(second, self.pi,
                                                            {"status": "deferred", "detail": "lock busy"}),
                      second)
        self.assertNotIn("systemMessage", second)   # 24h 内同一 deferred 状态不重复打扰
        # 状态文件损坏时放行：宁可重复提醒，不静默吞掉可修复的指引
        (self.runtime / ".mobile-deferred-notice.json").write_text("broken", encoding="utf-8")
        third = {"suppressOutput": True}
        self.installer._mobile_pending_notice(third, self.pi,
                                              {"status": "deferred", "detail": "lock busy"})
        self.assertIn("手机远控增强尚未就绪", third["systemMessage"])

    def test_mobile_notice_silent_while_relay_disabled(self):
        # issue #455：推送开关未开启（缺省）时手机补丁提示一律静默——口径同主桥
        # mobileEnabled()，仅 mobile_relay.enabled 对象内显式 true 算开启。
        config = self.runtime / "config.json"
        states = ({"status": "pending"},
                  {"status": "deferred", "detail": "existing pending operation"},
                  {"status": "deferred", "detail": "bridge pending"},
                  {"status": "deferred", "detail": "lock busy"})
        for raw in (None, "{}", '{"mobile_relay": {"enabled": false}}', '{"mobile_relay": {}}',
                    '{"mobile_relay": true}', '{"mobile_relay": []}', '{"mobile_relay": "on"}',
                    '{"mobile_relay": {"enabled": "true"}}', '{"mobile_relay": {"enabled": 1}}',
                    "[1, 2]", "{not json"):
            if raw is None:
                config.unlink(missing_ok=True)
            else:
                config.write_text(raw, encoding="utf-8")
            # 每种配置开头清掉限频文件：否则前一种配置泄露的 24h 时间戳会把后面的
            # 「尚未就绪」子用例挡成静默，变成碰巧通过
            (self.runtime / ".mobile-deferred-notice.json").unlink(missing_ok=True)
            for state in states:
                with self.subTest(config=raw, state=state):
                    out = {"suppressOutput": True}
                    self.assertIs(self.installer._mobile_pending_notice(out, self.pi, state), out)
                    self.assertEqual(out, {"suppressOutput": True})
        # 静默不占用 24h 限频：之后开启开关，提示不受此前静默影响
        self.assertFalse((self.runtime / ".mobile-deferred-notice.json").exists())
        self._enable_mobile_relay()
        enabled = {"suppressOutput": True}
        self.installer._mobile_pending_notice(enabled, self.pi, {"status": "deferred", "detail": "lock busy"})
        self.assertIn("手机远控增强尚未就绪", enabled["systemMessage"])

    def test_mobile_notice_gate_mirrors_host_config_parsing(self):
        # 配置解析口径对齐主桥 readCfg（fs.readFileSync utf8 + JSON.parse）：别处的非法
        # UTF-8 字节按替换字符解码、配置仍有效；NaN/Infinity 字面量或 BOM 让 JSON.parse
        # 抛出，整份配置按损坏处理（推送未开启）。
        config = self.runtime / "config.json"
        config.write_bytes(b'{"mobile_relay": {"enabled": true}, "note": "\xff\xfe"}')
        decoded = {"suppressOutput": True}
        self.installer._mobile_pending_notice(decoded, self.pi, {"status": "pending"})
        self.assertIn("已排定", decoded["systemMessage"])
        for raw in (b'{"mobile_relay": {"enabled": true}, "x": NaN}',
                    b'{"mobile_relay": {"enabled": true}, "x": -Infinity}',
                    b"\xef\xbb\xbf" + b'{"mobile_relay": {"enabled": true}}'):
            with self.subTest(config=raw):
                config.write_bytes(raw)
                out = {"suppressOutput": True}
                self.assertEqual(self.installer._mobile_pending_notice(out, self.pi, {"status": "pending"}),
                                 {"suppressOutput": True})

    def _run_hook_while_asar_locked(self):
        """真实 hook 链 + asar 被运行中客户端占用：桥补装转存 pending，手机补丁按
        「bridge pending」让位——issue #455 报告的会话路径。"""
        real_replace = os.replace

        def replace(src, dst):
            if Path(dst) == self.pi.ASAR:
                raise PermissionError("locked")
            return real_replace(src, dst)
        with mock.patch.object(os, "replace", side_effect=replace), \
             mock.patch.object(self.installer, "resolve_paths", return_value=(self.runtime, self.pi)), \
             mock.patch.object(self.installer, "sync_runtime"), \
             mock.patch.object(self.installer, "save_runtime_config"), \
             mock.patch.dict(sys.modules, {"plugin_auto_update": mock.Mock()}), \
             contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
            result = self.installer.run_hook()
        self.assertEqual(out.getvalue(), "")
        return result

    def test_hook_mobile_waiting_notice_follows_relay_toggle(self):
        # 已注入与刚安装成功两条 hook 分支：推送开关未开启（缺配置，或在 ⚙ 面板里关掉后
        # 写入的显式 false）时整条会话静默；开启时照旧提示等待自动补装，不带手动命令
        config = self.runtime / "config.json"
        marker = self.runtime / ".plugin-restart-required"
        for injected in (True, False):
            for relay in (None, False, True):
                with self.subTest(injected=injected, relay=relay):
                    self.pi.TMP.unlink(missing_ok=True)
                    self.pi.TMP_META.unlink(missing_ok=True)
                    marker.unlink(missing_ok=True)
                    if relay is None:
                        config.unlink(missing_ok=True)
                    else:
                        config.write_text(json.dumps({"mobile_relay": {"enabled": relay}}), encoding="utf-8")
                    with mock.patch.object(self.installer, "injected_status", return_value=injected), \
                         mock.patch.object(self.installer, "_install_overlay", return_value=True):
                        result = self._run_hook_while_asar_locked()
                    # 门控只管会话文字：待替换包与 ⚙ 红点标记照常落定
                    self.assertTrue(self.pi.TMP.is_file())
                    self.assertTrue(marker.is_file())
                    if relay:
                        self.assertIn("手机中继补丁暂缓", result["systemMessage"])
                        self.assertIn("自动补装", result["systemMessage"])
                        self.assertNotIn("mobile_relay_patch.py", result["systemMessage"])
                        self.assertIn("自动补装", result["hookSpecificOutput"]["additionalContext"])
                    else:
                        self.assertEqual(result, {"suppressOutput": True})

    def test_hook_fresh_install_keeps_mobile_patch_logic_while_relay_disabled(self):
        # 门控只管会话文字：刚安装成功分支在推送未开启（缺配置）时仍补手机补丁；补丁
        # 就地写入且客户端在运行时仍写 ⚙ 红点标记，只是不再发会话文字
        marker = self.runtime / ".plugin-restart-required"
        for running in (False, True):
            with self.subTest(client_running=running), contextlib.ExitStack() as stack:
                marker.unlink(missing_ok=True)
                (self.runtime / "config.json").unlink(missing_ok=True)
                out = io.StringIO()
                for patcher in (
                    mock.patch.object(self.installer, "resolve_paths", return_value=(self.runtime, self.pi)),
                    mock.patch.object(self.installer, "sync_runtime"),
                    mock.patch.object(self.installer, "injected_status", return_value=False),
                    mock.patch.object(self.installer, "_install_overlay", return_value=True),
                    mock.patch.object(self.installer, "save_runtime_config"),
                    mock.patch.object(self.installer, "ensure_renderer_bridge", return_value={"status": "present"}),
                    mock.patch.object(self.installer, "ensure_mobile_relay_stash", return_value={"status": "patched"}),
                    mock.patch.object(self.pi, "client_running", return_value=running),
                    mock.patch.dict(sys.modules, {"plugin_auto_update": mock.Mock()}),
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()),
                ):
                    stack.enter_context(patcher)
                result = self.installer.run_hook()
                self.assertEqual(out.getvalue(), "")
                self.installer.ensure_mobile_relay_stash.assert_called_once_with(self.pi, quiet_monitor=True)
            self.assertEqual(result, {"suppressOutput": True})
            if running:
                recorded = json.loads(marker.read_text(encoding="utf-8"))
                self.assertEqual((recorded["state"], recorded["asarPatch"]), ("installed", True))
            else:
                self.assertFalse(marker.exists())

    def test_standalone_remove_clears_mobile_injection(self):
        with mock.patch.object(sys, "argv", ["install.py", "--remove", "--asar", str(self.target),
                                             "--no-mcp"]), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.standalone.main(), 0)
        self.assertEqual(mobile.check_deployed(self.target)["status"], "absent")
        # 原始前缀逐字节还原（loader 注入行与两段 mobile 注入都不再存在）
        self.assertEqual(self.pi.entry_bytes_of(self.target), BODY)

    def test_plugin_remove_clears_mobile_injection(self):
        with mock.patch.object(self.installer, "resolve_paths", return_value=(self.runtime, self.pi)), \
                mock.patch.object(self.installer, "chown_runtime_to_user"), \
                mock.patch.object(sys, "argv", ["overlay_install.py", "remove"]), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as exit_code:
                self.installer.main()
        self.assertEqual(exit_code.exception.code, 0)
        self.assertEqual(mobile.check_deployed(self.target)["status"], "absent")
        self.assertEqual(self.pi.entry_bytes_of(self.target), BODY)
        self.assertTrue((self.runtime / ".plugin-overlay-optout").exists())

    def _write_target(self, uplink_hook):
        stash = mobile.inject_for(b"relayProtocol=Ce,Q.disposeBridge")
        body = BODY.replace(b"relayProtocol=Ce,", b"relayProtocol=Ce," + stash)
        body = body.replace(ANCHOR, uplink_hook)
        make_asar(self.target, files={
            "package.json": json.dumps({"name": "@zcode/desktop", "type": "module",
                                        "version": bridge.NEWEST["version"]}).encode(),
            "out/main/index.js": body + self.pi.INJECT_LINE.encode()})

    def test_remove_clears_v1_and_v2_injections_for_both_owners(self):
        for generation, hook in (("v1", LEGACY), ("v2", OLD_V2)):
            for owner in ("standalone", "plugin"):
                with self.subTest(generation=generation, owner=owner):
                    self._write_target(hook)
                    self.assertEqual(mobile.check_deployed(self.target)["uplink_generation"],
                                     1 if generation == "v1" else 2)
                    with contextlib.ExitStack() as stack:
                        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                        stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                        if owner == "standalone":
                            stack.enter_context(mock.patch.object(
                                sys, "argv", ["install.py", "--remove", "--asar", str(self.target),
                                              "--no-mcp"]))
                            self.assertEqual(self.standalone.main(), 0)
                        else:
                            stack.enter_context(mock.patch.object(
                                self.installer, "resolve_paths", return_value=(self.runtime, self.pi)))
                            stack.enter_context(mock.patch.object(
                                self.installer, "chown_runtime_to_user"))
                            stack.enter_context(mock.patch.object(
                                sys, "argv", ["overlay_install.py", "remove"]))
                            with self.assertRaises(SystemExit) as exit_code:
                                self.installer.main()
                            self.assertEqual(exit_code.exception.code, 0)
                    self.assertEqual(mobile.check_deployed(self.target)["status"], "absent")
                    self.assertEqual(self.pi.entry_bytes_of(self.target), BODY)
                    self.assertEqual(list(self.root.glob(".mobile-relay-*")), [])

    def test_hook_records_restart_marker_when_mobile_patched_while_client_runs(self):
        with mock.patch.object(self.pi, "client_running", return_value=True), \
                mock.patch.object(self.installer, "resolve_paths", return_value=(self.runtime, self.pi)), \
                mock.patch.object(self.installer, "sync_runtime"), \
                mock.patch.object(self.installer, "injected_status", return_value=True), \
                mock.patch.object(self.installer, "save_runtime_config"), \
                mock.patch.dict(sys.modules, {"plugin_auto_update": mock.Mock()}), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = self.installer.run_hook()
        marker = json.loads((self.runtime / ".plugin-restart-required").read_text(encoding="utf-8"))
        self.assertEqual(marker["state"], "installed")
        self.assertIs(marker.get("asarPatch"), True)
        self.assertEqual(marker.get("hashes"), {})
        self.assertNotIn("installation", marker)
        self.assertNotIn("publishedAt", marker)
        self.assertNotIn("systemMessage", result)

    def test_plugin_install_records_restart_marker_while_client_runs(self):
        with mock.patch.object(self.pi, "client_running", return_value=True), \
                mock.patch.object(self.installer, "resolve_paths", return_value=(self.runtime, self.pi)), \
                mock.patch.object(self.installer, "sync_runtime"), \
                mock.patch.object(self.installer, "_install_overlay", return_value=True), \
                mock.patch.object(self.installer, "save_runtime_config"), \
                mock.patch.object(self.installer, "chown_runtime_to_user"), \
                mock.patch.object(sys, "argv", ["overlay_install.py", "install"]), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as exit_code:
                self.installer.main()
        self.assertEqual(exit_code.exception.code, 0)
        marker = json.loads((self.runtime / ".plugin-restart-required").read_text(encoding="utf-8"))
        self.assertEqual(marker["state"], "installed")
        self.assertIs(marker.get("asarPatch"), True)
        self.assertNotIn("installation", marker)

    def test_remove_survives_mobile_patch_import_failure(self):
        with mock.patch.dict(sys.modules, {"mobile_relay_patch": None}), \
                mock.patch.object(sys, "argv", ["install.py", "--remove", "--asar", str(self.target),
                                                "--no-mcp"]), \
                contextlib.redirect_stdout(io.StringIO()) as out, \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.standalone.main(), 0)
        self.assertIn("补丁清理未完成", out.getvalue())
        self.assertIs(self.pi.injected_state(), False)        # 主卸载仍完成
        self.assertNotEqual(mobile.check_deployed(self.target)["status"], "absent")

    def test_standalone_patched_while_client_runs_promises_restart(self):
        with mock.patch.object(self.standalone, "load_lang_from_config", return_value=None), \
                mock.patch.object(self.pi, "client_running", return_value=True), \
                mock.patch.object(self.standalone, "copy_runtime"), \
                mock.patch.object(self.standalone, "prepare_config"), \
                mock.patch.object(self.standalone, "remember_asar"), \
                mock.patch.object(self.pi, "install", return_value=True), \
                mock.patch.dict(sys.modules, {"patch_install": self.pi}), \
                mock.patch.object(sys, "argv", ["install.py", "--asar", str(self.target), "--no-mcp"]), \
                contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.standalone.main(), 0)
        text = out.getvalue()
        self.assertIn("完全退出", text)
        self.assertIn("全部完成", text)

    def test_standalone_deferred_reports_action_not_complete(self):
        with mock.patch.object(self.standalone, "load_lang_from_config", return_value=None), \
                mock.patch.object(self.standalone, "ensure_mobile_relay_stash",
                                  return_value={"status": "deferred", "detail": "busy"}), \
                mock.patch.object(self.standalone, "copy_runtime"), \
                mock.patch.object(self.standalone, "prepare_config"), \
                mock.patch.object(self.standalone, "remember_asar"), \
                mock.patch.object(self.pi, "install", return_value=True), \
                mock.patch.dict(sys.modules, {"patch_install": self.pi}), \
                mock.patch.object(sys, "argv", ["install.py", "--asar", str(self.target), "--no-mcp"]), \
                contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.standalone.main(), 0)
        text = out.getvalue()
        self.assertIn("手机中继补丁尚未就绪", text)
        self.assertIn("完全退出", text)
        self.assertIn("mobile_relay_patch.py", text)
        self.assertIn("apply --asar", text)
        self.assertNotIn("全部完成", text)

    def test_plugin_cli_reports_patched_pending_and_waiting(self):
        def run_cli(mobile_result):
            with mock.patch.object(self.installer, "resolve_paths", return_value=(self.runtime, self.pi)), \
                    mock.patch.object(self.installer, "sync_runtime"), \
                    mock.patch.object(self.installer, "_install_overlay", return_value=True), \
                    mock.patch.object(self.installer, "ensure_renderer_bridge", return_value={"status": "present"}), \
                    mock.patch.object(self.installer, "ensure_mobile_relay_stash", return_value=mobile_result), \
                    mock.patch.object(self.installer, "save_runtime_config"), \
                    mock.patch.object(self.installer, "chown_runtime_to_user"), \
                    mock.patch.object(sys, "argv", ["overlay_install.py", "install"]), \
                    contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as exit_code:
                    self.installer.main()
            self.assertEqual(exit_code.exception.code, 0)
            return out.getvalue()

        text = run_cli({"status": "patched"})
        self.assertIn("手机中继补丁已写入", text)   # 此前插件 CLI patched 静默，用户无法区分成败
        self.assertIn("下次打开 ZCode", text)
        with mock.patch.object(self.pi, "client_running", return_value=True):
            text = run_cli({"status": "patched"})
        self.assertIn("请完全退出并重开 ZCode 后生效", text)   # 运行中=要求完全重启
        text = run_cli({"status": "pending"})
        self.assertIn("已排定", text)
        self.assertIn("自动完成", text)
        self.assertNotIn("mobile_relay_patch.py", text)
        text = run_cli({"status": "deferred", "detail": "existing pending operation"})
        self.assertIn("自动补装", text)
        self.assertNotIn("mobile_relay_patch.py", text)
        text = run_cli({"status": "deferred", "detail": "lock busy"})
        self.assertIn("手机远控增强尚未就绪", text)
        self.assertIn("mobile_relay_patch.py", text)   # CLI 保留命令行高级选项

    def test_standalone_reports_scheduled_and_waiting(self):
        def run_standalone(mobile_result):
            with mock.patch.object(self.standalone, "load_lang_from_config", return_value=None), \
                    mock.patch.object(self.standalone, "ensure_mobile_relay_stash", return_value=mobile_result), \
                    mock.patch.object(self.standalone, "copy_runtime"), \
                    mock.patch.object(self.standalone, "prepare_config"), \
                    mock.patch.object(self.standalone, "remember_asar"), \
                    mock.patch.object(self.pi, "install", return_value=True), \
                    mock.patch.dict(sys.modules, {"patch_install": self.pi}), \
                    mock.patch.object(sys, "argv", ["install.py", "--asar", str(self.target), "--no-mcp"]), \
                    contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(self.standalone.main(), 0)
            return out.getvalue()

        text = run_standalone({"status": "pending"})
        self.assertIn("已排定", text)
        self.assertIn("自动完成", text)
        self.assertNotIn("mobile_relay_patch.py", text)
        self.assertNotIn("全部完成", text)   # pending 不得承诺全部完成
        self.assertNotIn("尚未生效", text)   # 汇总行 pending 单列，不得误指独立命令
        text = run_standalone({"status": "deferred", "detail": "existing pending operation"})
        self.assertIn("重跑本安装", text)   # 独立链无 SessionStart hook：重跑安装补装
        self.assertNotIn("mobile_relay_patch.py", text)

    def test_standalone_helper_upgrades_legacy(self):
        with contextlib.redirect_stderr(io.StringIO()):
            result = self.standalone.ensure_mobile_relay_stash(self.pi)
        self.assertEqual(result["status"], "patched")
        self.assertEqual(mobile.check_deployed(self.target)["uplink_generation"], 2)


if __name__ == "__main__":
    unittest.main()
