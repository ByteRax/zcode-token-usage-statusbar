# -*- coding: utf-8 -*-
"""统一 asar 事务的手机补丁安装、补装、卸载与监控收尾。"""
import contextlib
import hashlib
import io
import json
import os
import struct
import sys
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.helpers.py_test_support import load_module, make_asar  # noqa: E402

BODY = (b'function attach(){return Q.relayProtocol=Ce,Q.disposeBridge=()=>{}}'
        b'function Fg(h,y){let D=h.currentBridge;return!D||D.degraded?!1:'
        b'D.relayProtocol?.acceptPayload(y)??!1}'
        b'new X({onRawTransportPayload:s(ve=>Fg(ye,ve),"onRawTransportPayload")});')
STASH_ANCHOR = b"relayProtocol=Ce,Q.disposeBridge"
UPLINK_ANCHOR = b'onRawTransportPayload:s(ve=>Fg(ye,ve),"onRawTransportPayload")'
LEGACY = (b'onRawTransportPayload:s(ve=>(ve&&ve.zuUp?((globalThis.'
          b'__zusageRelayUplinkQueue=globalThis.__zusageRelayUplinkQueue||[]).push(ve),'
          b'true):0)||Fg(ye,ve),"onRawTransportPayload")')
OLD_V2 = (b'onRawTransportPayload:s(ve=>(ve&&ve.zuUp?((__zuBridge)=>'
          b'((globalThis.__zusageRelayUplinkQueue=globalThis.__zusageRelayUplinkQueue||[]).push('
          b'{frame:ve,b:__zuBridge,relay:__zuBridge?__zuBridge.relayProtocol:void 0}),true))'
          b'(ye.currentBridge):0)||Fg(ye,ve),"onRawTransportPayload")')
RESOURCE = "/out/main/after.bin"
RESOURCE_BYTES = b"\x00packed resource after the main entry\xff"


class MobileInstallTests(unittest.TestCase):
    def setUp(self):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        self.root = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="mobile install "))).resolve()
        self.target = self.root / "client" / "resources" / "app.asar"
        self.runtime = self.root / "runtime"
        home = self.root / "home"
        home.mkdir()
        self.runtime.mkdir()
        (self.runtime / "inject-main.cjs").write_bytes(b"// fixture loader\n")
        (self.runtime / "config.json").write_bytes(b'{"lang":"en"}')
        stack.enter_context(mock.patch.dict(os.environ, {
            "HOME": str(home), "USERPROFILE": str(home), "ZCODE_ASAR": "",
            "ZUSAGE_NO_MONITOR": "1", "ZUSAGE_MONITOR_QUIET": "", "ZUSAGE_MONITOR_NO_WMI": "1",
        }))
        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))

        self.lock_module = load_module("mobile_install_runtime_lock", ROOT / "runtime_lock.py")
        stack.enter_context(mock.patch.dict(sys.modules, {"runtime_lock": self.lock_module}))
        self.pi = load_module("mobile_install_pi", ROOT / "patch_install.py")
        self.pi.set_target(self.target)
        self.pi.set_runtime(self.runtime)
        self.client_running = stack.enter_context(mock.patch.object(self.pi, "client_running", return_value=False))
        self.monitor_launch = stack.enter_context(mock.patch.object(self.pi, "launch_monitor", return_value=True))
        stack.enter_context(mock.patch.dict(sys.modules, {"patch_install": self.pi}))
        plugin_root = ROOT / "plugins" / "zcode-token-usage-statusbar"
        self.installer = load_module("mobile_install_overlay", plugin_root / "overlay_install.py")
        self.notice = load_module("mobile_install_notice", plugin_root / "restart_notice.py")
        self.package = {"name": "@zcode/desktop", "type": "module", "version": "9.9.9"}
        self.write_archive()

    def write_archive(self, entry=BODY, *, package=None):
        return make_asar(self.target, files={
            self.pi.ASSET: entry,
            RESOURCE: RESOURCE_BYTES,
            "package.json": json.dumps(self.package if package is None else package).encode("utf-8"),
        })

    def assets(self, path):
        with path.open("rb") as stream:
            header, base = self.pi.read_header(stream)
            assets = {}
            for name, node in self.pi.iter_files(header):
                stream.seek(base + int(node["offset"]))
                assets[name] = stream.read(node["size"])
            return assets

    def legacy_body(self, hook):
        stash = self.pi.inject_for(STASH_ANCHOR)
        return BODY.replace(STASH_ANCHOR, b"relayProtocol=Ce," + stash + b"Q.disposeBridge", 1).replace(
            UPLINK_ANCHOR, hook, 1)

    def with_loader(self, body):
        return body + self.pi.INJECT_LINE.encode("utf-8")

    def installed_entry(self):
        return self.with_loader(self.pi.transform_mobile_entry(BODY, "apply"))

    def assert_installed(self, path):
        entry = self.pi.entry_bytes_of(path)
        self.assertEqual(entry, self.installed_entry())
        self.assertEqual(entry.count(self.pi.INJECT_LINE.encode("utf-8")), 1)
        self.assertIn(b"__zusageRelayStash", entry)
        self.assertIn(b"__zusageRelayUplinkQueue", entry)
        self.assertIn(b"globalThis.__zusageRelayUplinkGeneration=2", entry)

    def pending_pair(self):
        return self.pi.TMP.read_bytes(), self.pi.TMP_META.read_bytes()

    def assert_no_pending_or_stage(self):
        self.assertFalse(self.pi.TMP.exists())
        self.assertFalse(self.pi.TMP_META.exists())
        self.assertEqual(list(self.target.parent.glob(self.pi.TMP.name + ".*.stage")), [])
        self.assertEqual(list(self.target.parent.glob(".zusage-mobile-stage-*.stage")), [])

    def enable_mobile_relay(self):
        (self.runtime / "config.json").write_text(
            '{"mobile_relay":{"enabled":true}}', encoding="utf-8")

    @property
    def marker(self):
        return self.runtime / ".plugin-restart-required"

    def record_full_intent(self, installation):
        return self.notice.record_restart(self.runtime, {
            "state": "pending-install", "installation": installation})

    @contextlib.contextmanager
    def observe_archive_io(self, *, deny_target=False, lock_state=None):
        real_replace = os.replace
        target_replacements = []

        def replace(source, dest):
            source, dest = Path(source), Path(dest)
            if dest in (self.target, self.pi.TMP) and lock_state is not None:
                lock_state["replace_depths"].append(lock_state["value"])
                lock_state["replace_events"].append(
                    (source, dest, lock_state.get("active_id")))
            if dest == self.target:
                target_replacements.append((source, dest))
                if deny_target:
                    raise PermissionError("fixture archive is in use")
            return real_replace(source, dest)

        with mock.patch.object(self.pi.os, "replace", side_effect=replace), \
                mock.patch.object(self.pi, "repack", wraps=self.pi.repack) as repack:
            yield repack, target_replacements

    @contextlib.contextmanager
    def observe_target_lock(self):
        target_lock_path = self.target.with_name(self.target.name + ".zusage.lock")
        original_lock = self.pi.file_lock
        depth = {"value": 0, "events": [], "replace_depths": [],
                 "replace_events": [], "active_id": None, "next_id": 0, "held": False}

        @contextlib.contextmanager
        def lock(path, timeout=10.0):
            with original_lock(path, timeout=timeout):
                target_lock = Path(path) == target_lock_path
                if target_lock and depth["held"]:
                    raise AssertionError("target advisory lock is not reentrant")
                if target_lock:
                    depth["next_id"] += 1
                    depth["active_id"] = depth["next_id"]
                    depth["value"] += 1
                    depth["held"] = True
                try:
                    yield
                finally:
                    if target_lock:
                        depth["value"] -= 1
                        depth["active_id"] = None
                        depth["held"] = False

        real_repack = self.pi.repack
        real_source_fingerprint = self.pi.source_fingerprint
        real_checked_tmp = self.pi._checked_tmp_metadata
        stage_prefix = ".zusage-mobile-stage-"

        def repack(*args, **kwargs):
            depth["events"].append(("repack", depth["value"]))
            return real_repack(*args, **kwargs)

        def fingerprint(path):
            path = Path(path)
            if path == self.target or path == self.pi.TMP or path.name.startswith(stage_prefix):
                depth["events"].append(("sha", depth["value"], path.name))
            return real_source_fingerprint(path)

        def checked_tmp(path, *args, **kwargs):
            path = Path(path)
            depth["events"].append(("validate", depth["value"], path.name))
            if path.name.startswith(stage_prefix):
                depth["events"].append(("stage_validate", depth["value"], path.name))
            return real_checked_tmp(path, *args, **kwargs)

        with mock.patch.object(self.pi, "file_lock", side_effect=lock), \
                mock.patch.object(self.lock_module, "file_lock", side_effect=lock), \
                mock.patch.object(self.pi, "repack", side_effect=repack), \
                mock.patch.object(self.pi, "source_fingerprint", side_effect=fingerprint), \
                mock.patch.object(self.pi, "_checked_tmp_metadata", side_effect=checked_tmp):
            yield depth

    def test_session_start_upgrades_legacy_hooks_in_the_existing_archive(self):
        self.write_archive(self.with_loader(self.legacy_body(LEGACY)))
        updates = mock.Mock()
        with mock.patch.object(self.installer, "resolve_paths", return_value=(self.runtime, self.pi)),                 mock.patch.object(self.installer, "sync_runtime"),                 mock.patch.object(self.installer, "dedupe_legacy_mcp", return_value="absent"),                 mock.patch.object(self.installer, "ensure_renderer_bridge", return_value={"status": "present"}),                 mock.patch.dict(sys.modules, {"plugin_auto_update": updates}),                 contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.installer.run_hook(), {"suppressOutput": True})
        self.assert_installed(self.target)
        self.assert_no_pending_or_stage()

    def test_mobile_only_repack_preserves_current_loader_and_reports_status(self):
        self.write_archive(self.with_loader(BODY))
        before_assets = self.assets(self.target)

        with self.observe_target_lock() as lock, \
                self.observe_archive_io(lock_state=lock) as (repack, replacements):
            result = self.pi.install(mobile_only=True, record_mobile_intent=True)

        self.assertTrue(result)
        self.assertTrue(lock["events"])
        self.assertTrue(any(event[0] == "stage_validate" for event in lock["events"]), lock["events"])
        self.assertTrue(all(event[1] == 0 for event in lock["events"]
                            if event[0] in ("repack", "sha", "validate", "stage_validate")), lock["events"])
        self.assertEqual(lock["value"], 0)
        self.assertEqual(self.pi.mobile_status(), {"status": "patched"})
        repack.assert_called_once()
        self.assertEqual(len(replacements), 1)
        self.assertEqual(replacements[0][1], self.target)
        self.assertEqual(lock["replace_depths"], [1])
        expected = self.pi.transform_mobile_entry(self.with_loader(BODY), "apply")
        self.assertEqual(self.pi.entry_bytes_of(self.target), expected)
        self.assertEqual(expected.count(self.pi.INJECT_LINE.encode()), 1)
        marker = json.loads(self.marker.read_bytes())
        self.assertEqual(marker["installation"], {
            "asar": str(self.target.resolve()),
            "entryHash": hashlib.sha256(expected).hexdigest(),
        })
        self.assertIn("publishedAt", marker)
        before_assets[self.pi.ASSET] = expected
        self.assertEqual(self.assets(self.target), before_assets)
        self.assert_no_pending_or_stage()

    def test_mobile_only_defers_on_orphan_sidecar_without_mutating_it(self):
        self.write_archive(self.with_loader(BODY))
        orphan = b'{"untrusted":"orphan"}'
        self.pi.TMP_META.write_bytes(orphan)
        before_archive = self.target.read_bytes()
        self.assertFalse(self.pi.install(mobile_only=True, record_mobile_intent=True))
        self.assertEqual(self.pi.mobile_status()["status"], "deferred")
        self.assertEqual(self.pi.TMP_META.read_bytes(), orphan)
        self.assertEqual(self.target.read_bytes(), before_archive)
        self.assertFalse(self.marker.exists())

    def test_mobile_only_defers_on_symlink_sidecar_without_mutating_it(self):
        self.write_archive(self.with_loader(BODY))
        orphan = b'{"untrusted":"orphan"}'
        symlink_target = self.root / "external-sidecar"
        symlink_target.write_bytes(orphan)
        try:
            self.pi.TMP_META.symlink_to(symlink_target)
        except (OSError, NotImplementedError):
            self.skipTest("symlink creation unavailable in this environment")
        before_archive = self.target.read_bytes()
        self.assertFalse(self.pi.install(mobile_only=True, record_mobile_intent=True))
        self.assertTrue(self.pi.TMP_META.is_symlink())
        self.assertEqual(symlink_target.read_bytes(), orphan)
        self.assertEqual(self.target.read_bytes(), before_archive)
        self.assertFalse(self.marker.exists())

    def test_pending_operation_takes_precedence_over_target_lock_contention(self):
        self.write_archive(self.with_loader(BODY))
        self.pi.prepare_tmp({"/" + self.pi.ENTRY: self.installed_entry()})
        original_pending = self.pending_pair()
        with self.pi._target_lock(), mock.patch.object(self.installer.time, "sleep") as sleep:
            status = self.installer.ensure_mobile_relay_stash(self.pi, quiet_monitor=True)
        sleep.assert_not_called()
        self.assertEqual(status, {"status": "deferred", "detail": "existing pending operation"})
        self.assertEqual(self.pending_pair(), original_pending)
        self.assertFalse(self.marker.exists())

    def test_mobile_only_defers_behind_shared_pending_package_without_writes(self):
        self.write_archive(self.with_loader(self.legacy_body(LEGACY)))
        self.client_running.return_value = True

        with self.observe_archive_io(deny_target=True):
            result = self.pi.install()
        self.assertFalse(result)
        self.assertEqual(self.pi.pending_operation(), "install")
        before_archive = self.target.read_bytes()
        before_pending = self.pending_pair()
        before_stage = sorted(path.name for path in self.target.parent.glob("*.stage"))

        with self.observe_archive_io() as (repack, replacements):
            result = self.pi.install(mobile_only=True)

        self.assertFalse(result)
        self.assertEqual(self.pi.mobile_status()["status"], "deferred")
        repack.assert_not_called()
        self.assertEqual(replacements, [])
        self.assertEqual(self.target.read_bytes(), before_archive)
        self.assertEqual(self.pending_pair(), before_pending)
        self.assertEqual(sorted(path.name for path in self.target.parent.glob("*.stage")), before_stage)

    def test_mobile_only_rechecks_pending_after_lock_free_build_without_overwriting_it(self):
        self.write_archive(self.with_loader(BODY))
        before_archive = self.target.read_bytes()
        original_repack = self.pi.repack
        injected = []

        def race_repack(*args, **kwargs):
            result = original_repack(*args, **kwargs)
            if not injected and Path(args[2]).name.startswith(".zusage-mobile-stage-"):
                other_entry = self.with_loader(BODY + b"\n// concurrent installer\n")
                self.pi.prepare_tmp({"/" + self.pi.ENTRY: other_entry})
                injected.append(self.pending_pair())
            return result

        with mock.patch.object(self.pi, "repack", side_effect=race_repack):
            result = self.pi.install(mobile_only=True, record_mobile_intent=True)

        self.assertFalse(result)
        self.assertEqual(self.pi.mobile_status()["status"], "deferred")
        self.assertEqual(self.target.read_bytes(), before_archive)
        self.assertEqual(self.pi.pending_operation(), "install")
        self.assertTrue(self.pi.pending_tmp("install"))
        self.assertEqual(self.pending_pair(), injected[0])
        self.assertFalse(self.marker.exists())

    def test_mobile_only_rebuilds_when_source_changes_after_intent(self):
        self.write_archive(self.with_loader(BODY))
        original_repack = self.pi.repack
        calls = []
        intents = []
        write_marker = self.lock_module._write_marker

        def record_then_change(path, data):
            write_marker(path, data)
            if "publishedAt" not in data:
                intents.append(data["installation"])
                if len(intents) == 1:
                    self.write_archive(self.with_loader(BODY + b"\n// concurrent entry edit"))

        def observed_repack(*args, **kwargs):
            calls.append(self.marker.exists())
            return original_repack(*args, **kwargs)

        with mock.patch.object(self.pi, "repack", side_effect=observed_repack), \
                mock.patch.object(self.lock_module, "_write_marker", side_effect=record_then_change):
            result = self.pi.install(mobile_only=True, record_mobile_intent=True)

        self.assertTrue(result)
        self.assertEqual(calls, [False, False])
        self.assertEqual(len(intents), 2)
        self.assertEqual(self.pi.mobile_status()["status"], "patched")
        entry = self.pi.entry_bytes_of(self.target)
        self.assertIn(b"// concurrent entry edit", entry)
        self.assertIn(b"__zusageRelayStash", entry)
        self.assertFalse(self.pi.TMP.exists())
        self.assertFalse(self.pi.TMP_META.exists())
        self.assertEqual(json.loads((self.runtime / ".plugin-restart-required").read_text())[
            "installation"]["entryHash"], hashlib.sha256(entry).hexdigest())

    def test_mobile_present_fast_path_uses_no_advisory_lock_or_archive_hash(self):
        self.write_archive(self.installed_entry())
        with mock.patch.object(self.pi, "file_lock", side_effect=AssertionError("unexpected lock")), \
                mock.patch.object(self.pi, "_archive_snapshot", wraps=self.pi._archive_snapshot) as snapshot, \
                mock.patch.object(self.pi, "source_fingerprint", side_effect=AssertionError("unexpected archive hash")):
            result = self.pi.install(mobile_only=True)
        self.assertTrue(result)
        self.assertEqual(self.pi.mobile_status(), {"status": "present"})
        snapshot.assert_called_once_with(self.target)

    def test_mobile_only_rebuilds_once_when_source_changes_during_stage(self):
        self.write_archive(self.with_loader(BODY))
        original_repack = self.pi.repack
        calls = []

        def replace_source_after_first_build(*args, **kwargs):
            result = original_repack(*args, **kwargs)
            calls.append(1)
            if len(calls) == 1:
                self.write_archive(self.with_loader(BODY + b"\n// host update"))
            return result

        with mock.patch.object(self.pi, "repack", side_effect=replace_source_after_first_build), \
                self.observe_target_lock() as lock:
            result = self.pi.install(mobile_only=True)

        self.assertTrue(result)
        self.assertEqual(len(calls), 2)
        self.assertTrue(lock["events"])
        self.assertTrue(any(event[0] == "stage_validate" for event in lock["events"]), lock["events"])
        self.assertTrue(all(event[1] == 0 for event in lock["events"]
                            if event[0] in ("repack", "sha", "validate", "stage_validate")), lock["events"])
        self.assertEqual(lock["value"], 0)
        self.assertEqual(self.pi.mobile_status()["status"], "patched")
        self.assertIn(b"// host update", self.pi.entry_bytes_of(self.target))

    def test_mobile_stage_name_is_outside_legacy_and_ordinary_cleaner_globs(self):
        mobile_stage = self.root / ".zusage-mobile-stage-live.stage"
        mobile_stage.write_bytes(b"live mobile stage")
        os.utime(mobile_stage, (0, 0))
        self.pi._sweep_stale_stages(self.root)
        self.assertTrue(mobile_stage.exists(), "ordinary cleaner must not match mobile private stage")

        ordinary_stage = self.root / (self.pi.TMP.name + ".old.stage")
        ordinary_stage.write_bytes(b"ordinary stage")
        os.utime(ordinary_stage, (0, 0))
        self.pi._sweep_stale_stages(self.root, mobile_only=True)
        self.assertTrue(ordinary_stage.exists(), "mobile cleaner must not match ordinary stage")
        self.assertFalse(mobile_stage.exists(), "mobile cleaner removes only stale private mobile stages")

    def test_session_start_retries_after_mobile_build_lock_contention(self):
        self.write_archive(self.with_loader(BODY))
        self.enable_mobile_relay()
        lock_path = self.target.with_name(self.target.name + ".zusage.mobile-build.lock")
        calls = []
        original_install = self.pi.install

        def install(**kwargs):
            calls.append(1)
            return original_install(**kwargs)

        with self.pi.file_lock(lock_path), \
                mock.patch.object(self.pi, "install", side_effect=install), \
                mock.patch.object(self.installer.time, "sleep") as sleep:
            status = self.installer.ensure_mobile_relay_stash(self.pi, quiet_monitor=True)
        self.assertEqual(calls, [1, 1])
        sleep.assert_called_once_with(self.installer._MOBILE_LOCK_RETRY_DELAY_S)
        self.assertEqual(status, {"status": "deferred", "detail": "mobile build lock busy"})
        self.assertFalse((self.runtime / ".mobile-deferred-notice.json").exists())
        self.assert_no_pending_or_stage()

    def test_session_start_retries_after_restart_marker_lock_contention(self):
        self.write_archive(self.with_loader(BODY))
        self.enable_mobile_relay()
        lock_path = self.runtime / "plugin-restart.lock"
        calls = []
        original_install = self.pi.install

        def install(**kwargs):
            calls.append(1)
            return original_install(**kwargs)

        with self.lock_module.file_lock(lock_path), \
                mock.patch.object(self.pi, "install", side_effect=install), \
                mock.patch.object(self.installer.time, "sleep") as sleep:
            status = self.installer.ensure_mobile_relay_stash(self.pi, quiet_monitor=True)
        self.assertEqual(calls, [1, 1])
        sleep.assert_called_once_with(self.installer._MOBILE_LOCK_RETRY_DELAY_S)
        self.assertEqual(status, {"status": "deferred", "detail": "restart marker lock busy"})
        self.assert_no_pending_or_stage()
        self.assertFalse((self.runtime / ".plugin-restart-required").exists())

    def test_mobile_only_requires_a_loader_from_the_current_runtime(self):
        self.write_archive(BODY)
        before = self.target.read_bytes()

        with self.observe_archive_io() as (repack, replacements):
            result = self.pi.install(mobile_only=True)

        self.assertFalse(result)
        self.assertEqual(self.pi.mobile_status()["status"], "deferred")
        repack.assert_not_called()
        self.assertEqual(replacements, [])
        self.assertEqual(self.target.read_bytes(), before)
        self.assert_no_pending_or_stage()

    def test_mobile_replace_failure_publishes_same_stage_pending_without_published_at(self):
        self.write_archive(self.with_loader(BODY))
        real_replace = os.replace
        attempts = []

        def deny_asar_replace(source, destination):
            source, destination = Path(source), Path(destination)
            if destination in (self.target, self.pi.TMP):
                attempts.append((source, destination))
                lock["replace_depths"].append(lock["value"])
                lock["replace_events"].append((source, destination, lock.get("active_id")))
            if destination == self.target:
                raise PermissionError("fixture archive is in use")
            return real_replace(source, destination)

        with self.observe_target_lock() as lock, \
                mock.patch.object(self.pi.os, "replace", side_effect=deny_asar_replace), \
                mock.patch.object(self.pi, "repack", wraps=self.pi.repack) as repack:
            result = self.pi.install(mobile_only=True, record_mobile_intent=True)

        self.assertFalse(result)
        self.assertEqual(self.pi.mobile_status(), {"status": "pending"})
        self.assertEqual([dest for _src, dest in attempts], [self.target, self.pi.TMP])
        stage = attempts[0][0]
        self.assertEqual(attempts[1][0], stage)
        self.assertTrue(stage.name.startswith(".zusage-mobile-stage-"))
        self.assertFalse(stage.exists())
        repack.assert_called_once()
        self.assertEqual(self.pi.pending_operation(), "install")
        self.assertTrue(self.pi.pending_tmp("install", verify_hash=True))
        source_fp = self.pi.source_fingerprint(self.target)
        self.assertTrue(self.pi._same_fingerprint(source_fp, self.pi._load_tmp_metadata()["source"]))
        marker_before_finalize = json.loads(
            (self.runtime / ".plugin-restart-required").read_text(encoding="utf-8"))
        self.assertEqual(marker_before_finalize["installation"]["entryHash"],
                         hashlib.sha256(self.pi.entry_bytes_of(self.pi.TMP)).hexdigest())
        self.assertNotIn("publishedAt", marker_before_finalize)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(self.pi.finalize_tmp(operation="install", client_closed=lambda: True))
        self.assertEqual(self.pi.entry_bytes_of(self.target), self.installed_entry())
        marker_after_finalize = json.loads(
            (self.runtime / ".plugin-restart-required").read_text(encoding="utf-8"))
        self.assertEqual(marker_after_finalize["installation"]["entryHash"],
                         hashlib.sha256(self.pi.entry_bytes_of(self.target)).hexdigest())
        self.assertIn("publishedAt", marker_after_finalize)
        self.assertTrue(lock["events"])
        self.assertTrue(any(event[0] == "stage_validate" for event in lock["events"]), lock["events"])
        self.assertTrue(all(event[1] == 0 for event in lock["events"]
                            if event[0] in ("repack", "sha", "validate", "stage_validate")), lock["events"])
        self.assertEqual(lock["replace_depths"], [1, 1])
        self.assertEqual(len(lock["replace_events"]), 2)
        self.assertTrue(all(event[2] is not None for event in lock["replace_events"]))
        self.assertEqual(len({event[2] for event in lock["replace_events"]}), 1)
        self.assertIsNotNone(lock["replace_events"][0][2])
        self.assertEqual(lock["value"], 0)
        self.monitor_launch.assert_called_once()

    def test_mobile_restart_marker_is_not_written_when_stage_validation_fails(self):
        self.write_archive(self.with_loader(BODY))
        with mock.patch.object(self.pi, "_checked_tmp_metadata",
                               side_effect=self.pi.PendingTmpError("fixture stage validation failure")) as validate:
            self.assertFalse(self.pi.install(mobile_only=True, record_mobile_intent=True))
        validate.assert_called_once()
        self.assertFalse(self.marker.exists())
        self.assertEqual(self.pi.mobile_status()["status"], "skipped-error")
        self.assert_no_pending_or_stage()

    def test_marker_io_timeout_is_not_retried_as_lock_contention(self):
        self.write_archive(self.with_loader(BODY))
        before = self.target.read_bytes()
        with mock.patch.object(self.lock_module, "_write_marker",
                               side_effect=TimeoutError("marker write timed out")) as write_marker:
            status = self.installer.ensure_mobile_relay_stash(self.pi, quiet_monitor=True)
        self.assertEqual(status, {"status": "skipped-error", "detail": "marker write timed out"})
        self.assertEqual(write_marker.call_count, 1)
        self.assertEqual(self.target.read_bytes(), before)
        self.assertFalse((self.runtime / ".plugin-restart-required").exists())
        self.assert_no_pending_or_stage()

    def test_mobile_intent_is_rolled_back_if_replace_and_pending_publish_fail(self):
        self.write_archive(self.with_loader(BODY))
        previous = {"state": "installed", "asarPatch": True, "hashes": {"overlay.js": "old"}}
        (self.runtime / ".plugin-restart-required").write_bytes(json.dumps(previous).encode("utf-8"))
        before_marker = (self.runtime / ".plugin-restart-required").read_bytes()
        real_replace = os.replace
        attempts = []

        def deny_both_publications(source, destination):
            source, destination = Path(source), Path(destination)
            if destination in (self.target, self.pi.TMP):
                attempts.append((source, destination))
                raise PermissionError("fixture destination is occupied")
            return real_replace(source, destination)

        with mock.patch.object(self.pi.os, "replace", side_effect=deny_both_publications):
            result = self.pi.install(mobile_only=True, record_mobile_intent=True)

        self.assertFalse(result)
        self.assertEqual(self.pi.mobile_status()["status"], "skipped-error")
        self.assertEqual([dest for _source, dest in attempts], [self.target, self.pi.TMP])
        self.assertEqual((self.runtime / ".plugin-restart-required").read_bytes(), before_marker)
        self.assert_no_pending_or_stage()

    def test_failed_pending_sidecar_removes_new_intent_and_pending_pair(self):
        self.write_archive(self.with_loader(BODY))
        original_archive = self.target.read_bytes()
        write_sidecar = self.pi._atomic_tmp_metadata

        def refuse_final_sidecar(data):
            if data["operation"] == "install":
                self.assertTrue(self.pi.TMP.is_file())
                raise PermissionError("fixture sidecar write failed")
            return write_sidecar(data)

        with self.observe_archive_io(deny_target=True), \
                mock.patch.object(self.pi, "_atomic_tmp_metadata", side_effect=refuse_final_sidecar):
            self.assertFalse(self.pi.install(mobile_only=True, record_mobile_intent=True))
        self.assertEqual(self.pi.mobile_status()["status"], "skipped-error")
        self.assertEqual(self.target.read_bytes(), original_archive)
        self.assertFalse(self.marker.exists())
        self.assert_no_pending_or_stage()
        self.monitor_launch.assert_not_called()

    def test_interrupted_direct_swap_retains_its_intent(self):
        self.write_archive(self.with_loader(BODY))
        replace = os.replace

        def interrupt_after_swap(source, destination):
            replace(source, destination)
            if Path(destination) == self.target:
                raise KeyboardInterrupt

        with mock.patch.object(self.pi.os, "replace", side_effect=interrupt_after_swap), \
                self.assertRaises(KeyboardInterrupt):
            self.pi.install(mobile_only=True, record_mobile_intent=True)
        self.assert_installed(self.target)
        marker = json.loads(self.marker.read_bytes())
        self.assertEqual(marker["installation"]["entryHash"], hashlib.sha256(self.installed_entry()).hexdigest())
        self.assertNotIn("publishedAt", marker)
        self.assert_no_pending_or_stage()

    def test_interrupted_pending_publication_retains_its_intent(self):
        self.write_archive(self.with_loader(BODY))
        publish_pending = self.pi._publish_pending

        def interrupt_after_publish(*args, **kwargs):
            publish_pending(*args, **kwargs)
            raise KeyboardInterrupt

        with self.observe_archive_io(deny_target=True), \
                mock.patch.object(self.pi, "_publish_pending", side_effect=interrupt_after_publish), \
                self.assertRaises(KeyboardInterrupt):
            self.pi.install(mobile_only=True, record_mobile_intent=True)
        self.assertTrue(self.pi.pending_tmp("install", verify_hash=True))
        marker = json.loads(self.marker.read_bytes())
        self.assertEqual(marker["installation"]["entryHash"], hashlib.sha256(self.installed_entry()).hexdigest())
        self.assertNotIn("publishedAt", marker)
        self.assertTrue(self.pi.finalize_tmp(operation="install", client_closed=lambda: True))
        self.assertIn("publishedAt", json.loads(self.marker.read_bytes()))

    def test_failed_publication_confirmation_retains_intent_for_installed_archive(self):
        self.write_archive(self.with_loader(BODY))
        write_marker = self.lock_module._write_marker

        def refuse_confirmation(path, data):
            if "publishedAt" in data:
                raise PermissionError("fixture confirmation failed")
            return write_marker(path, data)

        with mock.patch.object(self.lock_module, "_write_marker", side_effect=refuse_confirmation):
            self.assertTrue(self.pi.install(mobile_only=True, record_mobile_intent=True))
        self.assert_installed(self.target)
        self.assertNotIn("publishedAt", json.loads(self.marker.read_bytes()))
        self.assert_no_pending_or_stage()

    def test_older_lock_module_keeps_ordinary_pending_finalize_available(self):
        self.write_archive(self.with_loader(BODY))
        from types import ModuleType
        old_lock = ModuleType("runtime_lock")
        for name in ("bounded_mkstemp", "file_lock", "publish_install", "real_home", "sudo_user"):
            setattr(old_lock, name, getattr(self.lock_module, name))
        with mock.patch.dict(sys.modules, {"runtime_lock": old_lock}):
            installer = load_module("mobile_install_mixed_pi", ROOT / "patch_install.py")
        installer.set_target(self.target)
        installer.set_runtime(self.runtime)
        self.assertFalse(installer.install(mobile_only=True, record_mobile_intent=True))
        self.assertEqual(installer.mobile_status(), {
            "status": "skipped-error", "detail": "mobile publication unavailable"})
        self.assert_no_pending_or_stage()
        expected = self.installed_entry()
        self.record_full_intent({"asar": str(self.target.resolve()),
                                 "entryHash": hashlib.sha256(expected).hexdigest()})
        installer.prepare_tmp({"/" + self.pi.ENTRY: expected})
        with mock.patch.object(installer, "client_running", return_value=False):
            self.assertTrue(installer.install(finalize=True))
        self.assert_installed(self.target)
        self.assertIn("publishedAt", json.loads(self.marker.read_bytes()))
        self.assert_no_pending_or_stage()

    def test_plugin_install_reports_a_verified_mobile_pending_package(self):
        self.write_archive(BODY)
        self.client_running.return_value = True
        real_replace = os.replace

        def deny_asar_replace(source, destination):
            if Path(destination) == self.target:
                raise PermissionError("fixture archive is in use")
            return real_replace(source, destination)

        with mock.patch.object(self.pi.os, "replace", side_effect=deny_asar_replace),                 mock.patch.object(self.installer, "resolve_paths", return_value=(self.runtime, self.pi)),                 mock.patch.object(self.installer, "sync_runtime"),                 mock.patch.object(self.installer, "chown_runtime_to_user"),                 mock.patch.dict(sys.modules, {"restart_notice": self.notice}),                 mock.patch.object(sys, "argv", ["overlay_install.py", "install"]),                 contextlib.redirect_stdout(io.StringIO()) as stdout, self.assertRaises(SystemExit) as exit_code:
            self.installer.main()
        self.assertEqual(exit_code.exception.code, 1)
        self.assertIn("手机中继补丁已排定", stdout.getvalue())
        self.assertEqual(self.pi.mobile_status()["status"], "pending")
        self.assertEqual(self.pi.pending_operation(), "install")
        self.assertTrue(self.pi.pending_tmp("install", verify_hash=True))
        self.assertEqual(self.pi.entry_bytes_of(self.pi.TMP), self.installed_entry())
        marker = json.loads((self.runtime / ".plugin-restart-required").read_text(encoding="utf-8"))
        self.assertNotIn("publishedAt", marker)

    def test_full_install_does_not_report_pending_after_hash_mismatch(self):
        self.write_archive(BODY)
        self.client_running.return_value = True
        meta = self.pi.prepare_tmp({"/" + self.pi.ENTRY: self.installed_entry()})
        meta["tmp"]["sha256"] = "0" * 64  # Cheap checks still see the expected entry and identity.
        self.pi._atomic_tmp_metadata(meta)
        pending_before = self.pending_pair()

        self.assertFalse(self.pi.install(before_publish=self.record_full_intent))
        self.assertEqual(self.pi.mobile_status()["status"], "skipped-error")
        self.assertEqual(self.pending_pair(), pending_before)
        with self.assertRaisesRegex(self.pi.PendingTmpError, "hash mismatch"):
            self.pi.pending_tmp("install", verify_hash=True)

    def test_full_install_does_not_report_pending_after_hash_read_error(self):
        self.write_archive(BODY)
        self.client_running.return_value = True
        self.pi.prepare_tmp({"/" + self.pi.ENTRY: self.installed_entry()})
        pending_before = self.pending_pair()
        fingerprint = self.pi.source_fingerprint

        def fail_hash_read(path):
            if Path(path) == self.pi.TMP:
                raise OSError("fixture pending hash read failed")
            return fingerprint(path)

        with mock.patch.object(self.pi, "source_fingerprint", side_effect=fail_hash_read) as read_hash:
            self.assertFalse(self.pi.install(before_publish=self.record_full_intent))
        read_hash.assert_any_call(self.pi.TMP)
        self.assertEqual(self.pi.mobile_status()["status"], "skipped-error")
        self.assertEqual(self.pending_pair(), pending_before)
        self.assertTrue(self.pi.pending_tmp("install", verify_hash=True))

    def test_install_preserves_unrelated_asar_links(self):
        with self.target.open("rb") as stream:
            header, base = self.pi.read_header(stream)
            stream.seek(base)
            payload = stream.read()
        header["files"]["out"]["files"]["main"]["files"]["alias.js"] = {"link": "index.js"}
        encoded = json.dumps(header, separators=(",", ":")).encode("utf-8")
        aligned = (len(encoded) + 7) // 4 * 4
        self.target.write_bytes(struct.pack("<4I", 4, aligned + 4, aligned, len(encoded))
                                + encoded + b"\0" * (aligned - len(encoded) - 4) + payload)

        self.assertTrue(self.pi.install())
        with self.target.open("rb") as stream:
            header, _base = self.pi.read_header(stream)
        self.assertEqual(header["files"]["out"]["files"]["main"]["files"]["alias.js"],
                         {"link": "index.js"})

    def test_standalone_install_writes_loader_and_both_hooks_in_one_archive_swap(self):
        standalone = load_module("mobile_standalone_install", ROOT / "install.py")
        argv = ["install.py", "--asar", str(self.target), "--no-mcp", "--lang", "en"]
        expected = self.assets(self.target)
        with mock.patch.object(standalone, "DATA_DIR", self.runtime),                 mock.patch.object(standalone, "copy_runtime"),                 self.observe_archive_io() as (repack, replacements):
            with mock.patch.object(sys, "argv", argv + ["--dry-run"]):
                self.assertEqual(standalone.main(), 0)
            repack.assert_not_called()
            self.assertEqual(replacements, [])
            self.assertEqual(self.assets(self.target), expected)
            with mock.patch.object(sys, "argv", argv):
                self.assertEqual(standalone.main(), 0)
        repack.assert_called_once()
        self.assertEqual(len(replacements), 1)
        self.assert_installed(self.target)
        expected[self.pi.ASSET] = self.installed_entry()
        self.assertEqual(self.assets(self.target), expected)
        self.assertFalse(self.marker.exists())
        self.assert_no_pending_or_stage()

    def test_existing_loader_upgrades_legacy_or_missing_mobile_hooks(self):
        for label, body in (
            ("v1", self.legacy_body(LEGACY)),
            ("old v2", self.legacy_body(OLD_V2)),
            ("missing hooks", BODY),
        ):
            with self.subTest(initial_state=label):
                self.write_archive(self.with_loader(body))
                with self.observe_archive_io() as (repack, replacements):
                    result = self.pi.install()
                self.assertTrue(result)
                self.assertEqual(self.pi.mobile_status(), {"status": "patched"})
                repack.assert_called_once()
                self.assertEqual(len(replacements), 1)
                self.assert_installed(self.target)
                self.assert_no_pending_or_stage()

    def test_reinstall_and_repeated_remove_skip_repack_and_replace(self):
        self.write_archive(self.installed_entry())
        before = self.target.read_bytes()
        with self.observe_archive_io() as (repack, replacements):
            result = self.pi.install()
        self.assertTrue(result)
        self.assertEqual(self.pi.mobile_status(), {"status": "present"})
        repack.assert_not_called()
        self.assertEqual(replacements, [])
        self.assertEqual(self.target.read_bytes(), before)
        self.monitor_launch.assert_not_called()

        result = self.pi.remove()
        self.assertTrue(result)
        before = self.target.read_bytes()
        with self.observe_archive_io() as (repack, replacements):
            result = self.pi.remove()
        self.assertTrue(result)
        repack.assert_not_called()
        self.assertEqual(replacements, [])
        self.assertEqual(self.target.read_bytes(), before)
        self.assert_no_pending_or_stage()

    def test_unknown_mobile_layout_allows_loader_install_and_preserves_original_entry(self):
        unknown = BODY.replace(b".acceptPayload(y)", b".acceptUnknown(y)")
        self.assertNotEqual(unknown, BODY)
        self.write_archive(unknown)
        expected = self.assets(self.target)
        with self.observe_archive_io() as (repack, replacements):
            result = self.pi.install()
        self.assertTrue(result)
        self.assertEqual(self.pi.mobile_status(), {"status": "skipped-unknown"})
        repack.assert_called_once()
        self.assertEqual(len(replacements), 1)
        expected[self.pi.ASSET] = self.with_loader(unknown)
        self.assertEqual(self.assets(self.target), expected)
        self.assertTrue(self.pi.remove())
        self.assertEqual(self.pi.entry_bytes_of(self.target), unknown)
        self.assert_no_pending_or_stage()

    def test_remove_refuses_unrecognized_existing_mobile_markers(self):
        installed = self.installed_entry()
        unknown = installed.replace(b"__zusageRelayUplinkGeneration=2", b"__zusageRelayUplinkGeneration=3")
        self.assertNotEqual(unknown, installed)
        self.write_archive(unknown)
        before = self.target.read_bytes()
        with self.observe_archive_io() as (repack, replacements):
            result = self.pi.remove()
        self.assertFalse(result)
        repack.assert_not_called()
        self.assertEqual(replacements, [])
        self.assertEqual(self.target.read_bytes(), before)
        self.assert_no_pending_or_stage()

    def test_remove_strips_loader_and_mobile_in_one_archive_swap(self):
        suffix = b"\n// unrelated trailing code\n"
        restored = self.assets(self.target)
        restored[self.pi.ASSET] = BODY + suffix
        for label, body in (("v1", self.legacy_body(LEGACY)), ("old v2", self.legacy_body(OLD_V2)),
                            ("marked v2", self.pi.transform_mobile_entry(BODY, "apply"))):
            with self.subTest(generation=label):
                self.write_archive(self.with_loader(body) + suffix)
                with self.observe_archive_io() as (repack, replacements):
                    result = self.pi.remove()
                self.assertTrue(result)
                repack.assert_called_once()
                self.assertEqual(len(replacements), 1)
                self.assertEqual(self.assets(self.target), restored)
                self.assert_no_pending_or_stage()

    def test_mobile_notice_gate_is_strict_and_silent_when_disabled(self):
        config = self.runtime / "config.json"
        cases = (None, b"{}", b'{"mobile_relay":{"enabled":false}}',
                 b'{"mobile_relay":{}}', b'{"mobile_relay":true}', b'{"mobile_relay":[]}',
                 b'{"mobile_relay":"on"}', b'{"mobile_relay":{"enabled":"true"}}',
                 b'{"mobile_relay":{"enabled":1}}', b"[1,2]", b"{not json",
                 b'{"mobile_relay":{"enabled":true},"bad":NaN}',
                 b'{"mobile_relay":{"enabled":true},"bad":Infinity}',
                 b'\xef\xbb\xbf{"mobile_relay":{"enabled":true}}')
        states = ({"status": "pending"},
                  {"status": "deferred", "detail": "bridge pending"})
        for raw in cases:
            with self.subTest(config=raw):
                if raw is None:
                    config.unlink(missing_ok=True)
                else:
                    config.write_bytes(raw)
                (self.runtime / ".mobile-deferred-notice.json").unlink(missing_ok=True)
                for result in states:
                    out = {"suppressOutput": True}
                    self.assertIs(self.installer._mobile_pending_notice(out, self.pi, result), out)
                    self.assertEqual(out, {"suppressOutput": True})
                self.assertFalse((self.runtime / ".mobile-deferred-notice.json").exists())

        # readCfg 同款 UTF-8 replacement：无关非法字节不吞有效配置。
        config.write_bytes(b'{"mobile_relay":{"enabled":true},"note":"\xff"}')
        out = {"suppressOutput": True}
        self.installer._mobile_pending_notice(out, self.pi, {"status": "pending"})
        self.assertIn("已排定", out["systemMessage"])

    def test_mobile_notice_enabled_routes_statuses_and_preserves_existing_output(self):
        self.enable_mobile_relay()
        deferred_file = self.runtime / ".mobile-deferred-notice.json"
        scheduled = {"suppressOutput": True}
        self.installer._mobile_pending_notice(scheduled, self.pi, {"status": "pending"})
        self.assertIn("已排定", scheduled["systemMessage"])
        self.assertNotIn("/install-overlay", scheduled["systemMessage"])
        self.assertFalse(deferred_file.exists())

        waiting = {"suppressOutput": True}
        self.installer._mobile_pending_notice(
            waiting, self.pi, {"status": "deferred", "detail": "bridge pending"})
        self.assertIn("自动补装", waiting["systemMessage"])
        self.assertNotIn("/install-overlay", waiting["systemMessage"])

        retry = {"suppressOutput": True}
        self.installer._mobile_pending_notice(
            retry, self.pi, {"status": "deferred", "detail": "lock busy"})
        self.assertIn("手机远控增强尚未就绪", retry["systemMessage"])
        self.assertIn("/install-overlay", retry["systemMessage"])
        self.assertTrue(deferred_file.exists())

        repeated = {"suppressOutput": True}
        self.installer._mobile_pending_notice(
            repeated, self.pi, {"status": "deferred", "detail": "mobile build lock busy"})
        self.assertEqual(repeated, {"suppressOutput": True})

        deferred_file.unlink(missing_ok=True)
        for mobile in ({"status": "patched"}, {"status": "skipped-error"},
                       {"status": "unknown"}, {}, None):
            out = {"suppressOutput": True}
            self.assertIs(self.installer._mobile_pending_notice(out, self.pi, mobile), out)
            self.assertEqual(out, {"suppressOutput": True})
            self.assertFalse(deferred_file.exists())

        for out in ({"systemMessage": "primary"},
                    {"hookSpecificOutput": {"additionalContext": "primary"}}):
            original = dict(out)
            self.assertIs(self.installer._mobile_pending_notice(
                out, self.pi, {"status": "pending"}), out)
            self.assertEqual(out, original)


if __name__ == "__main__":
    unittest.main()
