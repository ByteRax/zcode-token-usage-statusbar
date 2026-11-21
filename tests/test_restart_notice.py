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
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("restart_notice_test", PLUGIN / "restart_notice.py")
notice = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notice)


def root_runtime_lock():
    """仓库根 runtime_lock（不是插件目录的未同步副本）：热销账契约在根源码验证。"""
    module_spec = importlib.util.spec_from_file_location(
        "restart_notice_root_runtime_lock", ROOT / "runtime_lock.py")
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    return module


def notice_context(runtime=None, **kwargs):
    """reminder() 的 context 文案；无提醒时空串。"""
    got = notice.reminder(runtime, **kwargs)
    return got["context"] if got else ""


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
            context = notice_context(self.runtime)
        self.assertIn("用户可见·安装提醒", context)
        self.assertIn("/install-overlay", context)
        self.assertIn("/uninstall-overlay", context)
        self.assertNotIn("请完全退出 ZCode", context)
        self.assertEqual((self.runtime / notice.MARKER).read_bytes(), original)

    def test_installed_complete_sync_requires_restart(self):
        self.pending_sync()
        context = notice_context(self.runtime)
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
                context = notice_context(self.runtime)
                self.assertIn("同步尚未完成", context)
                self.assertIn("install-overlay", context)
                self.assertNotIn("请完全退出 ZCode", context)

    def test_optout_suppresses_leftover_marker_without_probing_client(self):
        notice.record_restart(self.runtime)
        (self.runtime / ".plugin-overlay-optout").write_text("1")
        with mock.patch.object(notice, "installation_status", side_effect=AssertionError("client probed")):
            self.assertEqual(notice_context(self.runtime), "")
        self.assertTrue((self.runtime / notice.MARKER).exists())

    def test_unknown_client_does_not_request_restart(self):
        notice.record_restart(self.runtime)
        with mock.patch.object(notice, "installation_status", return_value=None):
            self.assertEqual(notice_context(self.runtime), "")

    def test_reminder_only_reads_prepublication_intent(self):
        notice.record_restart(self.runtime, {"state": "pending-install", "publishedAt": 1})
        marker = self.runtime / notice.MARKER
        before = (marker.read_bytes(), marker.stat().st_mtime_ns)
        got = notice.reminder(self.runtime)
        self.assertIn("第一行", got["context"])
        self.assertIn("所有窗口", got["context"])
        self.assertIn("重开会话无效", got["context"])
        self.assertGreater(json.loads(marker.read_text())["createdAt"], 0)
        self.assertEqual((marker.read_bytes(), marker.stat().st_mtime_ns), before)
        self.assertIn("> **" + got["message"] + "**", got["context"])

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
                    got = notice.reminder(self.runtime, injected=True)
                    self.assertIn("install-overlay", got["message"])
                    self.assertNotIn("请完全退出 ZCode", got["message"])
                    self.assertIn("> **" + got["message"] + "**", got["context"])
                    self.assertEqual(before, {p.name: (p.read_bytes(), p.stat().st_mtime_ns)
                                              for p in self.runtime.iterdir()})

    def test_reminder_does_not_rebuild_acknowledged_marker(self):
        import runtime_lock
        notice.record_restart(self.runtime, {"state": "pending-install", "installation": {"asar": "fixture", "entryHash": "a" * 64}})
        with runtime_lock.publish_install(self.runtime, {"asar": "fixture", "entryHash": "a" * 64}):
            pass
        marker = json.loads((self.runtime / notice.MARKER).read_text())
        self.assertTrue(runtime_lock.ack_restart(self.runtime, {"_loadedAt": marker["publishedAt"] + 1})["cleared"])
        self.assertIsNone(notice.reminder(self.runtime, injected=True))
        self.assertFalse((self.runtime / notice.MARKER).exists())

    def test_installed_state_without_hashes_is_acknowledged_on_next_start(self):
        import runtime_lock
        notice.record_restart(self.runtime, {"state": "installed"})
        marker = self.runtime / notice.MARKER
        data = json.loads(marker.read_text(encoding="utf-8"))
        self.assertEqual(data["state"], "installed")
        self.assertEqual(data.get("hashes"), {})
        self.assertNotIn("installation", data)
        got = notice.reminder(self.runtime, injected=True)
        self.assertIn("用户可见·重启提醒", got["context"])
        self.assertIn("请完全退出 ZCode", got["message"])
        # mobile 补丁走无 hashes / 无 installation 的 installed 标记：下一次启动
        # 的 loader ack 必须能直接销账，不能像 pending-install 那样永久保留。
        self.assertTrue(runtime_lock.ack_restart(
            self.runtime, {"_loadedAt": data["createdAt"] * 1000 + 1000})["cleared"])
        self.assertFalse(marker.exists())
        self.assertIsNone(notice.reminder(self.runtime, injected=True))

    def test_installed_merge_preserves_existing_hashes(self):
        digest = hashlib.sha256(b"overlay").hexdigest()
        notice.record_restart(self.runtime, {"state": "pending-sync", "hashes": {"overlay.js": digest}})
        notice.record_restart(self.runtime, {"state": "installed"})
        data = json.loads((self.runtime / notice.MARKER).read_text(encoding="utf-8"))
        self.assertEqual(data["state"], "installed")
        self.assertEqual(data["hashes"], {"overlay.js": digest})

    def test_asar_patch_marker_rejects_hot_ack_but_clears_on_real_restart(self):
        lock = root_runtime_lock()
        digest = hashlib.sha256(b"new overlay").hexdigest()
        notice.record_restart(self.runtime, {"state": "pending-sync", "hashes": {"overlay.js": digest}})
        (self.runtime / "overlay.js").write_bytes(b"new overlay")
        (self.runtime / "plugin-runtime.json").write_text(
            json.dumps({"hashes": {"overlay.js": digest}}), encoding="utf-8")
        notice.record_restart(self.runtime, {"state": "installed", "asarPatch": True})
        marker = self.runtime / notice.MARKER
        data = json.loads(marker.read_text(encoding="utf-8"))
        self.assertIs(data["asarPatch"], True)
        self.assertEqual(data["state"], "installed")
        self.assertEqual(data["hashes"], {"overlay.js": digest})
        created_ms = data["createdAt"] * 1000
        hot = lock.ack_restart(self.runtime, {
            "_loadedAt": created_ms - 1,
            "_hotLoadedAt": {"overlay.js": created_ms + 1000},
            "overlay.js": digest})
        self.assertFalse(hot["cleared"])
        self.assertTrue(marker.exists())
        # 下一次真正启动：createdAt 早于 loadedAt，按正常 hash 流程销账
        started = lock.ack_restart(self.runtime, {"_loadedAt": created_ms + 1000,
                                                  "overlay.js": digest})
        self.assertTrue(started["cleared"])
        self.assertFalse(marker.exists())
        # 对照：同样的 hot 证据、但没有 asarPatch 的 marker 仍可热销账
        notice.record_restart(self.runtime, {"state": "pending-sync", "hashes": {"overlay.js": digest}})
        data = json.loads(marker.read_text(encoding="utf-8"))
        created_ms = data["createdAt"] * 1000
        hot = lock.ack_restart(self.runtime, {
            "_loadedAt": created_ms - 1,
            "_hotLoadedAt": {"overlay.js": created_ms + 1000},
            "overlay.js": digest})
        self.assertTrue(hot["cleared"])
        self.assertFalse(marker.exists())

    def test_pending_install_uses_actual_injection_and_keeps_partial_ack(self):
        import runtime_lock
        self.pending_sync()
        installation = {"asar": "fixture", "entryHash": "a" * 64}
        notice.record_restart(self.runtime, {"state": "pending-install", "installation": installation})
        with runtime_lock.publish_install(self.runtime, installation):
            pass
        before = (self.runtime / notice.MARKER).read_bytes()
        self.assertIn("用户可见·安装提醒", notice_context(self.runtime, injected=False))
        self.assertEqual((self.runtime / notice.MARKER).read_bytes(), before)
        self.assertFalse(runtime_lock.ack_restart(self.runtime, {"_loadedAt":
            json.loads(before)["publishedAt"] + 1})["cleared"])
        remaining = (self.runtime / notice.MARKER).read_bytes()
        self.assertIn("用户可见·重启提醒", notice_context(self.runtime, injected=True))
        self.assertEqual((self.runtime / notice.MARKER).read_bytes(), remaining)
        hashes = json.loads(remaining)["hashes"]
        self.assertTrue(runtime_lock.ack_restart(self.runtime, dict(hashes,
            _loadedAt=json.loads(remaining)["publishedAt"] + 1))["cleared"])
        self.assertEqual(notice_context(self.runtime, injected=True), "")

    def test_third_party_overwrite_supersedes_stale_digest_and_clears_marker(self):
        """3.19.1 实机 ⚙ 红点永亮：同步写入缓存版字节并记 hashes 后，开发部署（preserved
        保护，行为正确）把运行文件覆盖为更新字节——digest 与盘上现状永久分叉，旧逻辑
        remaining 恒非空导致 marker 孤儿化。以盘上现状为准：digest 不在盘上即视为已被
        超越，从待办剔除；全部剔除后 marker 清除，红点不再常亮。"""
        runtime_lock = root_runtime_lock()
        self.pending_sync()
        created_ms = json.loads((self.runtime / notice.MARKER).read_text(encoding="utf-8"))["createdAt"] * 1000
        (self.runtime / "inject-main.cjs").write_bytes(b"newer deploy supersedes recorded digest")
        ack = runtime_lock.ack_restart(self.runtime, {"_loadedAt": created_ms + 1})
        self.assertTrue(ack["cleared"])
        self.assertFalse((self.runtime / notice.MARKER).exists())

    def test_disk_backed_digest_survives_when_loaded_snapshot_is_stale(self):
        """对照侧：目标字节仍在盘上（等重启加载）、只是启动快照未持有——marker 必须保留，
        不得因 loaded 未匹配被新逻辑误剔。"""
        runtime_lock = root_runtime_lock()
        self.pending_sync()
        created_ms = json.loads((self.runtime / notice.MARKER).read_text(encoding="utf-8"))["createdAt"] * 1000
        ack = runtime_lock.ack_restart(self.runtime, {"_loadedAt": created_ms + 1})
        self.assertFalse(ack["cleared"])
        self.assertTrue((self.runtime / notice.MARKER).exists())
        self.assertEqual(json.loads((self.runtime / notice.MARKER).read_text(encoding="utf-8"))["hashes"],
                         {"inject-main.cjs": hashlib.sha256(b"new loader").hexdigest()})

    def test_missing_file_supersedes_recorded_digest_and_clears_marker(self):
        """覆盖的极端形态：记录后运行文件被删除（读侧 FileNotFoundError）同样永加载
        不到，按已被超越剔除，marker 照常清除。"""
        runtime_lock = root_runtime_lock()
        self.pending_sync()
        created_ms = json.loads((self.runtime / notice.MARKER).read_text(encoding="utf-8"))["createdAt"] * 1000
        (self.runtime / "inject-main.cjs").unlink()
        ack = runtime_lock.ack_restart(self.runtime, {"_loadedAt": created_ms + 1})
        self.assertTrue(ack["cleared"])
        self.assertFalse((self.runtime / notice.MARKER).exists())

    def test_directory_at_target_path_supersedes_recorded_digest(self):
        """目录占位在目标路径（损坏 marker/异常部署形态）：目录永不匹配 digest，按已被
        超越剔除。Windows 读目录抛 PermissionError 而非 IsADirectoryError，靠 is_dir
        归一，两平台断言一致。"""
        runtime_lock = root_runtime_lock()
        self.pending_sync()
        created_ms = json.loads((self.runtime / notice.MARKER).read_text(encoding="utf-8"))["createdAt"] * 1000
        (self.runtime / "inject-main.cjs").unlink()
        (self.runtime / "inject-main.cjs").mkdir()
        ack = runtime_lock.ack_restart(self.runtime, {"_loadedAt": created_ms + 1})
        self.assertTrue(ack["cleared"])
        self.assertFalse((self.runtime / notice.MARKER).exists())

    def test_transient_read_failure_conservatively_keeps_pending_digest(self):
        """瞬态读失败（杀软/备份短暂持锁的 PermissionError）无法判定盘上现状：保守
        保留待办、下次 ack 再核，不得当「已被超越」误剔让红点提前熄灭。"""
        runtime_lock = root_runtime_lock()
        self.pending_sync()
        created_ms = json.loads((self.runtime / notice.MARKER).read_text(encoding="utf-8"))["createdAt"] * 1000
        real_read_bytes = Path.read_bytes

        def flaky_read_bytes(path_self):
            if path_self.name == "inject-main.cjs":
                raise PermissionError(13, "transient scanner lock")
            return real_read_bytes(path_self)

        with mock.patch.object(Path, "read_bytes", flaky_read_bytes):
            ack = runtime_lock.ack_restart(self.runtime, {"_loadedAt": created_ms + 1})
        self.assertFalse(ack["cleared"])
        self.assertEqual(json.loads((self.runtime / notice.MARKER).read_text(encoding="utf-8"))["hashes"],
                         {"inject-main.cjs": hashlib.sha256(b"new loader").hexdigest()})

    def test_malformed_marker_key_is_dropped_and_good_entry_kept(self):
        """损坏 marker 的路径形键（分隔符/../NUL）不进盘检拼路径读盘，直接从待办剔除；
        同单内合法条目不受影响照常保留。分隔符逃逸键在运行目录外真实放置 digest 匹配
        字节：形状校验缺席时该键会被读到并匹配保留（逃逸成立），本测试即转红——
        钉住整个形状校验而非仅 NUL 分支。"""
        runtime_lock = root_runtime_lock()
        self.pending_sync()
        outside = self.runtime.parent / "escaped"
        outside.write_bytes(b"escaped payload bytes")
        escape_digest = hashlib.sha256(b"escaped payload bytes").hexdigest()
        marker = self.runtime / notice.MARKER
        data = json.loads(marker.read_text(encoding="utf-8"))
        data["hashes"]["..\\escaped"] = escape_digest    # Windows 分隔符逃逸
        data["hashes"]["../escaped"] = escape_digest     # POSIX 分隔符 / Windows altsep
        data["hashes"]["a\x00nul"] = "c" * 64
        marker.write_text(json.dumps(data), encoding="utf-8")
        created_ms = data["createdAt"] * 1000
        ack = runtime_lock.ack_restart(self.runtime, {"_loadedAt": created_ms + 1})
        self.assertFalse(ack["cleared"])
        self.assertEqual(json.loads(marker.read_text(encoding="utf-8"))["hashes"],
                         {"inject-main.cjs": hashlib.sha256(b"new loader").hexdigest()})

    def test_partially_superseded_marker_keeps_only_disk_backed_entries(self):
        """多条目一剔一留：被超越条目剔除、盘上仍有效条目保留，marker 部分销账而非
        整单清除。"""
        runtime_lock = root_runtime_lock()
        self.pending_sync()
        (self.runtime / "quota-client.cjs").write_bytes(b"still pending on disk")
        kept_digest = hashlib.sha256(b"still pending on disk").hexdigest()
        marker = self.runtime / notice.MARKER
        data = json.loads(marker.read_text(encoding="utf-8"))
        data["hashes"]["quota-client.cjs"] = kept_digest
        marker.write_text(json.dumps(data), encoding="utf-8")
        created_ms = data["createdAt"] * 1000
        (self.runtime / "inject-main.cjs").write_bytes(b"newer deploy supersedes recorded digest")
        ack = runtime_lock.ack_restart(self.runtime, {"_loadedAt": created_ms + 1})
        self.assertFalse(ack["cleared"])
        self.assertEqual(json.loads(marker.read_text(encoding="utf-8"))["hashes"],
                         {"quota-client.cjs": kept_digest})

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
        context = notice_context(self.runtime)
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
        self.assertEqual(notice_context(self.runtime), "")

    def test_restart_removes_reminder(self):
        notice.record_restart(self.runtime)
        self.assertNotEqual(notice_context(self.runtime), "")
        (self.runtime / notice.MARKER).unlink()
        self.assertEqual(notice_context(self.runtime), "")

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
            self.assertIn("用户可见·重启提醒", notice_context(self.runtime))
            self.assertEqual((self.runtime / notice.MARKER).read_bytes(), original)
        (self.runtime / notice.MARKER).unlink()
        self.assertEqual(notice_context(self.runtime), "")
        self.assertFalse((self.runtime / notice.MARKER).exists())

    def test_prompt_hook_no_longer_injects_notice_channel(self):
        # 重启/安装提醒只走 SessionStart 会话级通道（issue #108）：prompt-submit 即使
        # marker 尚未 ack 也不再每轮注入，answer_rate_line 开关两分支都必须不含提醒。
        notice.record_restart(self.runtime)
        environment = dict(os.environ, HOME=str(self.runtime.parent), USERPROFILE=str(self.runtime.parent),
                           ZUSAGE_PLUGIN_RUNTIME=str(self.runtime), ZCODE_SESSION_ID="sess_notice_test")
        for pending, rate_line in ((True, True), (False, True), (True, False), (False, False)):
            if pending:
                notice.record_restart(self.runtime)
            else:
                (self.runtime / notice.MARKER).unlink(missing_ok=True)
            (self.runtime / "config.json").write_text(
                '{}' if rate_line else '{"answer_rate_line": false}', encoding="utf-8")
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
            self.assertNotIn("用户可见·", context)
            self.assertNotIn("插件提醒", context)
            self.assertNotIn("本轮统计指令", context)
            if rate_line:
                self.assertIn("【内部背景·勿展示】", context)
            else:
                self.assertEqual(context, "")

    def test_notice_switch_no_longer_gates_reminder_copy(self):
        # v172：会话内文字提醒已取消，restart_notice 开关改为控制状态条红点（overlay
        # 消费主进程推送的 restartNotice 布尔）；reminder() 供 /install-overlay 命令行
        # 反馈与故障 _nudge 共用文案，不再读开关——显式 false 也照常给出。
        self.pending_sync()
        (self.runtime / "config.json").write_text('{"restart_notice": false}', encoding="utf-8")
        self.assertIn("请完全退出 ZCode", notice_context(self.runtime))


if __name__ == "__main__":
    unittest.main()
