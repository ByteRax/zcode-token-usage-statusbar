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
        stash = mobile.inject_for(b"relayProtocol=Ce,Q.disposeBridge")
        old = BODY.replace(b"relayProtocol=Ce,", b"relayProtocol=Ce," + stash).replace(ANCHOR, LEGACY)
        make_asar(self.target, files={"package.json": json.dumps({"name": "@zcode/desktop", "type": "module", "version": target["version"]}).encode(),
                                     "out/main/index.js": old + self.pi.INJECT_LINE.encode(),
                                     target["asset"]: renderer})
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

    def test_failed_mobile_replace_never_publishes_pending(self):
        real_replace = os.replace
        def replace(src, dst):
            if Path(dst) == self.pi.ASAR:
                raise PermissionError("locked")
            return real_replace(src, dst)
        original = self.target.read_bytes()
        for owner in (self.installer, self.standalone):
            with self.subTest(owner=owner.__name__), \
                    mock.patch.object(os, "replace", side_effect=replace), \
                    mock.patch.object(self.pi, "_publish_pending", side_effect=AssertionError("publish forbidden")), \
                    mock.patch.object(self.pi, "publish_external_pending", side_effect=AssertionError("publish forbidden")):
                result = owner.ensure_mobile_relay_stash(self.pi)
                self.assertEqual(result["status"], "deferred")
                self.assertFalse(self.pi.TMP.exists())
                self.assertFalse(self.pi.TMP_META.exists())
                self.assertEqual(self.target.read_bytes(), original)
                self.assertEqual(list(self.root.glob(".mobile-relay-*")), [])
        self.monitor.assert_not_called()

    def test_already_installed_does_not_copy_archive(self):
        self.assertEqual(self.standalone.ensure_mobile_relay_stash(self.pi)["status"], "patched")
        with mock.patch.object(shutil, "copy2", side_effect=AssertionError("copy forbidden")), \
                mock.patch.object(mobile, "_sweep_stale_stages", side_effect=AssertionError("write forbidden")), \
                mock.patch.object(mobile.tempfile, "mkstemp", side_effect=AssertionError("stage forbidden")):
            self.assertEqual(self.standalone.ensure_mobile_relay_stash(self.pi)["status"], "present")
            self.assertEqual(self.installer.ensure_mobile_relay_stash(self.pi)["status"], "present")

    def test_busy_lock_defers(self):
        with mock.patch.object(self.pi, "_target_lock", side_effect=TimeoutError("busy")):
            self.assertEqual(self.installer.ensure_mobile_relay_stash(self.pi)["status"], "deferred")
            self.assertEqual(self.standalone.ensure_mobile_relay_stash(self.pi)["status"], "deferred")

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
                self.assertNotIn("手机中继补丁尚未就绪", result["systemMessage"])

    def test_mobile_notice_preserves_existing_output_or_reports_deferral(self):
        existing = {"hookSpecificOutput": {"additionalContext": "original"}}
        self.assertIs(self.installer._mobile_pending_notice(existing, self.pi, {"status": "deferred"}), existing)
        self.assertEqual(existing, {"hookSpecificOutput": {"additionalContext": "original"}})
        output = {"suppressOutput": True}
        self.installer._mobile_pending_notice(output, self.pi, {"status": "deferred"})
        message = output["systemMessage"]
        self.assertIn("手机中继补丁尚未就绪", message)
        self.assertIn("完全退出", message)
        self.assertIn("mobile_relay_patch.py", message)
        self.assertIn("apply --asar", message)
        self.assertIn("手机中继补丁尚未就绪", output["hookSpecificOutput"]["additionalContext"])

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

    def test_standalone_helper_upgrades_legacy(self):
        with contextlib.redirect_stderr(io.StringIO()):
            result = self.standalone.ensure_mobile_relay_stash(self.pi)
        self.assertEqual(result["status"], "patched")
        self.assertEqual(mobile.check_deployed(self.target)["uplink_generation"], 2)


if __name__ == "__main__":
    unittest.main()
