# -*- coding: utf-8 -*-
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

PLUGIN = Path(__file__).resolve().parents[1] / "plugins" / "zcode-token-usage-statusbar"
spec = importlib.util.spec_from_file_location("restart_notice_test", PLUGIN / "restart_notice.py")
notice = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notice)


class RestartNoticeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.runtime = Path(temporary.name) / "runtime"
        patcher = mock.patch.object(notice, "installation_status", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def pending_sync(self):
        content = b"new loader"
        digest = hashlib.sha256(content).hexdigest()
        notice.record_restart(self.runtime, {"state": "pending-sync", "hashes": {"inject-main.cjs": digest}})
        (self.runtime / "inject-main.cjs").write_bytes(content)
        (self.runtime / "plugin-runtime.json").write_text(json.dumps({"hashes": {"inject-main.cjs": digest}}))

    def test_uninstalled_pending_sync_requires_install_not_restart(self):
        self.pending_sync()
        original = (self.runtime / notice.MARKER).read_bytes()
        with mock.patch.object(notice, "installation_status", return_value=False):
            context = notice.reminder_context(self.runtime)
        self.assertIn("用户可见·安装提醒", context)
        self.assertIn("/install-overlay", context)
        self.assertIn("/uninstall-overlay", context)
        self.assertNotIn("请完全退出 ZCode", context)
        self.assertEqual((self.runtime / notice.MARKER).read_bytes(), original)

    def test_installed_complete_sync_requires_restart(self):
        self.pending_sync()
        context = notice.reminder_context(self.runtime)
        self.assertIn("用户可见·重启提醒", context)
        self.assertIn("请完全退出 ZCode", context)

    def test_incomplete_or_corrupt_sync_never_claims_restart_is_sufficient(self):
        self.pending_sync()
        for content in (None, "{bad", "{}"):
            with self.subTest(content=content):
                record = self.runtime / "plugin-runtime.json"
                if content is None:
                    record.unlink()
                else:
                    record.write_text(content)
                context = notice.reminder_context(self.runtime)
                self.assertIn("同步尚未完成", context)
                self.assertIn("install-overlay", context)
                self.assertNotIn("请完全退出 ZCode", context)

    def test_optout_suppresses_leftover_marker_without_probing_client(self):
        notice.record_restart(self.runtime)
        (self.runtime / ".plugin-overlay-optout").write_text("1")
        with mock.patch.object(notice, "installation_status", side_effect=AssertionError("client probed")):
            self.assertEqual(notice.reminder_context(self.runtime), "")
        self.assertTrue((self.runtime / notice.MARKER).exists())

    def test_unknown_client_does_not_request_restart(self):
        notice.record_restart(self.runtime)
        with mock.patch.object(notice, "installation_status", return_value=None):
            self.assertEqual(notice.reminder_context(self.runtime), "")

    def test_session_notice_only_reads_prepublication_intent(self):
        notice.record_restart(self.runtime, {"state": "pending-install", "publishedAt": 1})
        marker = self.runtime / notice.MARKER
        before = (marker.read_bytes(), marker.stat().st_mtime_ns)
        output = notice.session_notice(self.runtime, {"suppressOutput": True})
        self.assertEqual(set(output), {"suppressOutput", "systemMessage", "hookSpecificOutput"})
        context = output["hookSpecificOutput"]
        self.assertEqual(context["hookEventName"], "SessionStart")
        self.assertEqual(set(context), {"hookEventName", "additionalContext"})
        self.assertIn("第一行", context["additionalContext"])
        self.assertIn("所有窗口", context["additionalContext"])
        self.assertIn("重开会话无效", context["additionalContext"])
        self.assertGreater(json.loads(marker.read_text())["createdAt"], 0)
        self.assertEqual((marker.read_bytes(), marker.stat().st_mtime_ns), before)
        self.assertIn("> **" + output["systemMessage"] + "**", context["additionalContext"])

    def test_corrupt_marker_is_conservative_and_read_only(self):
        notice.record_restart(self.runtime)
        marker = self.runtime / notice.MARKER
        for journal in (False, True):
            if journal:
                (self.runtime / "plugin-runtime-pending.json").write_text("{}")
            for content in ("{bad", "[]", "null", '{"state":"unknown"}',
                            '{"state":"installed","hashes":null}',
                            '{"hashes":{"../other":"' + "a" * 64 + '"}}'):
                with self.subTest(journal=journal, content=content):
                    marker.write_text(content)
                    before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.runtime.iterdir()}
                    output = notice.session_notice(self.runtime, {"suppressOutput": True}, injected=True)
                    self.assertIn("install-overlay", output["systemMessage"])
                    self.assertNotIn("请完全退出 ZCode", output["systemMessage"])
                    self.assertIn("> **" + output["systemMessage"] + "**",
                                  output["hookSpecificOutput"]["additionalContext"])
                    self.assertEqual(before, {p.name: (p.read_bytes(), p.stat().st_mtime_ns)
                                              for p in self.runtime.iterdir()})

    def test_session_notice_does_not_rebuild_acknowledged_marker(self):
        import runtime_lock
        notice.record_restart(self.runtime, {"state": "pending-install", "installation": {"asar": "fixture", "entryHash": "a" * 64}})
        with runtime_lock.publish_install(self.runtime, {"asar": "fixture", "entryHash": "a" * 64}):
            pass
        marker = json.loads((self.runtime / notice.MARKER).read_text())
        self.assertTrue(runtime_lock.ack_restart(self.runtime, {"_loadedAt": marker["publishedAt"] + 1})["cleared"])
        self.assertEqual(notice.session_notice(self.runtime, {"suppressOutput": True}, injected=True),
                         {"suppressOutput": True})
        self.assertFalse((self.runtime / notice.MARKER).exists())

    def test_pending_install_uses_actual_injection_and_keeps_partial_ack(self):
        import runtime_lock
        self.pending_sync()
        installation = {"asar": "fixture", "entryHash": "a" * 64}
        notice.record_restart(self.runtime, {"state": "pending-install", "installation": installation})
        with runtime_lock.publish_install(self.runtime, installation):
            pass
        before = (self.runtime / notice.MARKER).read_bytes()
        self.assertIn("用户可见·安装提醒", notice.reminder_context(self.runtime, injected=False))
        self.assertEqual((self.runtime / notice.MARKER).read_bytes(), before)
        self.assertFalse(runtime_lock.ack_restart(self.runtime, {"_loadedAt":
            json.loads(before)["publishedAt"] + 1})["cleared"])
        remaining = (self.runtime / notice.MARKER).read_bytes()
        self.assertIn("用户可见·重启提醒", notice.reminder_context(self.runtime, injected=True))
        self.assertEqual((self.runtime / notice.MARKER).read_bytes(), remaining)
        hashes = json.loads(remaining)["hashes"]
        self.assertTrue(runtime_lock.ack_restart(self.runtime, dict(hashes,
            _loadedAt=json.loads(remaining)["publishedAt"] + 1))["cleared"])
        self.assertEqual(notice.reminder_context(self.runtime, injected=True), "")

    def test_publication_cas_does_not_recreate_or_certify_other_intents(self):
        import runtime_lock
        installation = {"asar": "fixture", "entryHash": "a" * 64}
        marker = self.runtime / notice.MARKER
        for action in ("delete", "replace", "wrong-target"):
            with self.subTest(action=action):
                notice.record_restart(self.runtime, {"state": "pending-install", "installation": installation})
                target = installation if action != "wrong-target" else dict(installation, entryHash="b" * 64)
                with runtime_lock.publish_install(self.runtime, target):
                    if action == "delete":
                        marker.unlink()
                    elif action == "replace":
                        marker.write_text(json.dumps({"state": "pending-install", "installation": target,
                                                      "createdAt": 1, "hashes": {}}))
                if action == "delete":
                    self.assertFalse(marker.exists())
                else:
                    self.assertNotIn("publishedAt", json.loads(marker.read_text()))
        notice.record_restart(self.runtime, {"state": "pending-install", "installation": installation})
        with runtime_lock.publish_install(self.runtime, installation):
            pass
        self.assertIn("publishedAt", json.loads(marker.read_text()))
        notice.record_restart(self.runtime, {"state": "pending-install", "installation": installation})
        self.assertNotIn("publishedAt", json.loads(marker.read_text()))

    def test_ack_waits_for_publication_lock_and_uses_process_start(self):
        import runtime_lock
        installation = {"asar": "fixture", "entryHash": "a" * 64}
        notice.record_restart(self.runtime, {"state": "pending-install", "installation": installation})
        marker = self.runtime / notice.MARKER
        lock = self.runtime / "plugin-restart.lock"
        inode = lock.stat().st_ino
        started = self.runtime / "ack-started"
        code = ("import json,sys; from pathlib import Path; "
                "sys.path.insert(0, {!r}); import runtime_lock; "
                "Path({!r}).write_text('1'); "
                "print(json.dumps(runtime_lock.ack_restart({!r}, {{'_loadedAt': 0}})))"
                ).format(str(PLUGIN), str(started), str(self.runtime))
        environment = dict(os.environ, HOME=str(self.runtime.parent), USERPROFILE=str(self.runtime.parent),
                           PYTHONDONTWRITEBYTECODE="1")
        process = None
        try:
            with runtime_lock.publish_install(self.runtime, installation):
                process = subprocess.Popen([sys.executable, "-c", code], env=environment,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                import time
                deadline = time.monotonic() + 3
                while not started.exists() and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue(started.exists())
                time.sleep(.1)
                self.assertIsNone(process.poll())
                self.assertNotIn("publishedAt", json.loads(marker.read_text()))
            output, errors = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0, errors)
            self.assertFalse(json.loads(output)["cleared"])
            published = json.loads(marker.read_text())["publishedAt"]
            self.assertFalse(runtime_lock.ack_restart(self.runtime, {"_loadedAt": published})["cleared"])
            self.assertTrue(runtime_lock.ack_restart(self.runtime, {"_loadedAt": published + 1})["cleared"])
            self.assertEqual(lock.stat().st_ino, inode)
        finally:
            if process is not None and process.poll() is None:
                process.kill()
                process.communicate(timeout=5)

    def test_install_command_gives_failure_and_restart_notices_priority(self):
        command = (PLUGIN / "commands" / "install-overlay.md").read_text(encoding="utf-8")
        self.assertLess(command.index("- 失败、待收尾"), command.index("- 输出插件重启提醒"))
        self.assertLess(command.index("- 输出插件重启提醒"), command.index("- 仅输出「已安装"))
        self.assertIn("优先于「已安装，注入行已指向当前目录」", command)
        self.assertIn("且没有待加载/待修复提醒", command)
        self.assertIn("不能仅凭退出码为 0", command)

    def test_user_facing_restart_copy_identifies_plugin_and_explains_exit(self):
        notice.record_restart(self.runtime)
        context = notice.reminder_context(self.runtime)
        self.assertIn("zcode-token-usage-statusbar", context)
        self.assertIn("用量状态条", context)
        self.assertIn("菜单", context)
        self.assertIn("退出", context)
        self.assertNotIn("待重启记录", context)

    def test_user_facing_install_copy_avoids_internal_injection_terms(self):
        self.assertIn("zcode-token-usage-statusbar", notice.INSTALL_MESSAGE)
        self.assertIn("窗口底部", notice.INSTALL_MESSAGE)
        self.assertIn("install-overlay", notice.INSTALL_MESSAGE)
        self.assertNotIn("注入", notice.INSTALL_MESSAGE)
        self.assertNotIn("app.asar", notice.INSTALL_MESSAGE)

    def test_visible_notice_uses_bold_markdown_and_red_indicator(self):
        context = notice.visible_context("重启提醒", "", notice.MESSAGE)
        self.assertIn("> **🔴 zcode-token-usage-statusbar 插件提醒：", context)
        self.assertIn(notice.MESSAGE + "**\n", context)
        self.assertIn("整条提示加粗", context)
        self.assertNotIn("<span", context)

    def test_install_command_uses_the_same_bold_restart_copy(self):
        command = (PLUGIN / "commands" / "install-overlay.md").read_text(encoding="utf-8")
        self.assertIn("> **" + notice.MESSAGE + "**", command)

    def test_no_marker_means_no_reminder(self):
        self.assertEqual(notice.reminder_context(self.runtime), "")

    def test_restart_removes_reminder(self):
        notice.record_restart(self.runtime)
        self.assertNotEqual(notice.reminder_context(self.runtime), "")
        (self.runtime / notice.MARKER).unlink()
        self.assertEqual(notice.reminder_context(self.runtime), "")

    def test_atomic_failure_leaves_previous_marker_unchanged(self):
        notice.record_restart(self.runtime)
        original = (self.runtime / notice.MARKER).read_bytes()
        with mock.patch.object(notice.os, "replace", side_effect=OSError("locked")):
            with self.assertRaises(OSError):
                notice.record_restart(self.runtime)
        self.assertEqual((self.runtime / notice.MARKER).read_bytes(), original)
        self.assertEqual(list(self.runtime.glob(".restart-notice-*")), [])

    def test_sync_markers_merge_pending_hashes_and_legacy_notice_keeps_them(self):
        loader = hashlib.sha256(b"new loader").hexdigest()
        updater = hashlib.sha256(b"new updater").hexdigest()
        overlay = hashlib.sha256(b"new overlay").hexdigest()
        notice.record_restart(self.runtime, {"hashes": {"inject-main.cjs": loader}, "version": "1.1.0"})
        notice.record_restart(self.runtime, {"hashes": {"plugin-updater.cjs": updater}, "version": "1.2.0"})
        notice.record_restart(self.runtime, {"hashes": {"overlay.js": overlay}})
        notice.record_restart(self.runtime)
        marker = json.loads((self.runtime / notice.MARKER).read_text())
        self.assertEqual(marker["hashes"], {"inject-main.cjs": loader, "plugin-updater.cjs": updater,
                                           "overlay.js": overlay})
        self.assertEqual(marker["version"], "1.2.0")
        self.assertGreater(marker["createdAt"], 0)
        self.assertTrue((self.runtime / "plugin-restart.lock").is_file())

    def test_existing_notice_context_does_not_recreate_acknowledged_marker(self):
        notice.record_restart(self.runtime)
        original = (self.runtime / notice.MARKER).read_bytes()
        for _ in range(3):
            self.assertIn("用户可见·重启提醒", notice.reminder_context(self.runtime))
            self.assertEqual((self.runtime / notice.MARKER).read_bytes(), original)
        (self.runtime / notice.MARKER).unlink()
        self.assertEqual(notice.reminder_context(self.runtime), "")
        self.assertFalse((self.runtime / notice.MARKER).exists())

    def test_prompt_hook_preserves_rate_context_and_reminds_until_loader_restart(self):
        notice.record_restart(self.runtime)
        environment = dict(os.environ, HOME=str(self.runtime.parent), USERPROFILE=str(self.runtime.parent),
                           ZUSAGE_PLUGIN_RUNTIME=str(self.runtime), ZCODE_SESSION_ID="sess_notice_test")
        for pending in (True, False):
            if not pending:
                (self.runtime / notice.MARKER).unlink()
            script = ("import runpy, sys; sys.path.insert(0, {!r}); import restart_notice; "
                      "restart_notice.installation_status = lambda runtime: True; runpy.run_path({!r}, run_name='__main__')"
                      ).format(str(PLUGIN), str(PLUGIN / "hooks" / "prompt-submit.py"))
            result = subprocess.run([sys.executable, "-c", script],
                                    input="{}", capture_output=True, text=True, env=environment,
                                    cwd=str(self.runtime.parent), timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            output = json.loads(result.stdout)
            self.assertEqual(set(output), {"hookSpecificOutput"})
            context = output["hookSpecificOutput"]["additionalContext"]
            self.assertEqual("用户可见·重启提醒" in context, pending)
            self.assertIn("【内部背景·勿展示】", context)
            self.assertNotIn("本轮统计指令", context)


if __name__ == "__main__":
    unittest.main()
