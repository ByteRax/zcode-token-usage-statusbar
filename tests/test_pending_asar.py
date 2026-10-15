# -*- coding: utf-8 -*-
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import stat
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


def make_asar(path, entry=b"console.log('official v1');"):
    header = {"files": {"out": {"files": {"main": {"files": {
        "index.js": {"size": len(entry), "offset": "0"}
    }}}}}}
    raw = json.dumps(header, separators=(",", ":")).encode()
    c = (len(raw) + 7) // 4 * 4
    path.write_bytes(struct.pack("<4I", 4, c + 4, c, len(raw)) + raw +
                     b"\0" * (c - len(raw) - 4) + entry)


class PendingAsarTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.home = self.root / "home"
        self.home.mkdir()
        env = mock.patch.dict(os.environ, {"HOME": str(self.home), "USERPROFILE": str(self.home),
                                           "ZUSAGE_NO_MONITOR": "1", "ZUSAGE_MONITOR_QUIET": ""})
        env.start()
        self.addCleanup(env.stop)
        spec = importlib.util.spec_from_file_location("pending_patch_test", ROOT / "patch_install.py")
        self.pi = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.pi)
        self.asar = self.root / "app.asar"
        make_asar(self.asar)
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        (self.runtime / "inject-main.cjs").write_text("// fixture", encoding="utf-8")
        self.pi.set_target(self.asar)
        self.pi.set_runtime(self.runtime)
        self.pi._LANG = "en"
        output = contextlib.redirect_stdout(io.StringIO())
        output.__enter__()
        self.addCleanup(output.__exit__, None, None, None)
        process = mock.patch.object(self.pi, "client_running", return_value=False)
        process.start()
        self.addCleanup(process.stop)
        syntax = mock.patch.object(self.pi, "syntax_check", return_value=True)
        syntax.start()
        self.addCleanup(syntax.stop)

    def prepare(self, operation="install"):
        entry = self.pi.entry_bytes_of(self.asar)
        new = self.pi.ZUSAGE_LINE_RE.sub(b"", entry)
        if operation == "install":
            new += self.pi.INJECT_LINE.encode()
        return self.pi.prepare_tmp({"/" + self.pi.ENTRY: new}, operation)

    def test_generation_records_source_before_repack_and_atomic_sidecar(self):
        source = self.asar.read_bytes()
        observations = []
        repack = self.pi.repack
        def observe(src, modify, dst):
            self.assertFalse(self.pi.TMP_META.exists())
            observations.append(self.asar.stat().st_mtime_ns)
            return repack(src, modify, dst)
        with mock.patch.object(self.pi, "repack", side_effect=observe), \
                mock.patch.object(self.pi.os, "replace", wraps=self.pi.os.replace) as replace:
            self.prepare()
        meta = json.loads(self.pi.TMP_META.read_text())
        self.assertEqual(meta["source"]["sha256"], hashlib.sha256(source).hexdigest())
        self.assertEqual(meta["source"]["mtime_ns"], observations[0])
        self.assertEqual(meta["tmp"]["sha256"], hashlib.sha256(self.pi.TMP.read_bytes()).hexdigest())
        self.assertEqual(meta["asar"], str(self.asar.resolve()))
        self.assertEqual(meta["operation"], "install")
        self.assertEqual(meta["version"], 1)
        self.assertEqual(self.pi.TMP_META.name, "app.asar.zusage.tmp.json")
        self.assertEqual(Path(replace.call_args.args[1]), self.pi.TMP_META)
        self.assertNotEqual(Path(replace.call_args.args[0]), self.pi.TMP_META)

    def test_upgrade_during_repack_never_replaces_source(self):
        repack = self.pi.repack
        def upgrade(src, modify, dst):
            result = repack(src, modify, dst)
            make_asar(self.asar, b"console.log('official v2');")
            return result
        with mock.patch.object(self.pi, "repack", side_effect=upgrade), \
                mock.patch.object(self.pi.os, "replace") as replace:
            self.assertFalse(self.pi.install())
        replace.assert_not_called()
        self.assertIn(b"official v2", self.pi.entry_bytes_of(self.asar))
        self.assertFalse(self.pi.TMP_META.exists())

    def test_upgrade_between_entry_read_and_repack_is_rejected(self):
        read = self.pi.entry_bytes_of
        def upgrade(path):
            entry = read(path)
            make_asar(self.asar, b"console.log('official v2');")
            return entry
        with mock.patch.object(self.pi, "entry_bytes_of", side_effect=upgrade), \
                mock.patch.object(self.pi, "repack") as repack:
            self.assertFalse(self.pi.install())
        repack.assert_not_called()

    def test_finalize_consumes_existing_tmp_without_repacking(self):
        self.prepare()
        with mock.patch.object(self.pi, "repack", side_effect=AssertionError("must not repack")):
            self.assertTrue(self.pi.install(finalize=True))
        self.assertTrue(self.pi.self_check(self.asar))
        self.assertFalse(self.pi.TMP.exists())
        self.assertFalse(self.pi.TMP_META.exists())

    def test_finalize_rejects_upgrade_and_keeps_diagnostic_files(self):
        self.prepare()
        make_asar(self.asar, b"console.log('official v2');")
        with mock.patch.object(self.pi, "repack") as repack:
            self.assertFalse(self.pi.install(finalize=True))
        repack.assert_not_called()
        self.assertIn(b"official v2", self.pi.entry_bytes_of(self.asar))
        self.assertTrue(self.pi.TMP.exists())
        self.assertTrue(self.pi.TMP_META.exists())

    def test_finalize_requires_client_exit_even_when_os_allows_rename(self):
        self.prepare()
        with mock.patch.object(self.pi, "client_running", return_value=True), \
                mock.patch.object(self.pi.os, "replace") as replace:
            self.assertFalse(self.pi.install(finalize=True))
        replace.assert_not_called()

    def test_finalize_rejects_tampered_tmp_and_same_mtime_source(self):
        for target in (self.pi.TMP, self.asar):
            with self.subTest(target=target):
                # Fresh isolated pair for each attempt.
                self.pi.TMP.unlink(missing_ok=True)
                self.pi.TMP_META.unlink(missing_ok=True)
                make_asar(self.asar)
                self.prepare()
                stamp = target.stat()
                raw = bytearray(target.read_bytes())
                raw[-1] ^= 1
                target.write_bytes(raw)
                os.utime(target, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
                with mock.patch.object(self.pi.os, "replace") as replace:
                    self.assertFalse(self.pi.install(finalize=True))
                replace.assert_not_called()

    def test_hash_check_rejects_changed_content_even_with_forged_stat_metadata(self):
        self.prepare()
        raw = bytearray(self.pi.TMP.read_bytes())
        raw[-1] ^= 1
        self.pi.TMP.write_bytes(raw)
        meta = json.loads(self.pi.TMP_META.read_text())
        meta["tmp"].update(self.pi.file_stamp(self.pi.TMP))
        self.pi.TMP_META.write_text(json.dumps(meta))
        with self.assertRaises(self.pi.PendingTmpError):
            self.pi.finalize_tmp()
        self.assertTrue(self.pi.TMP.exists())

    def test_self_check_and_last_source_stat_are_required_before_replace(self):
        self.prepare()
        check = self.pi.self_check
        def upgrade(path, expect=True):
            result = check(path, expect=expect)
            make_asar(self.asar, b"console.log('official v2');")
            return result
        with mock.patch.object(self.pi, "self_check", side_effect=upgrade), \
                mock.patch.object(self.pi.os, "replace") as replace:
            with self.assertRaises(self.pi.PendingTmpError):
                self.pi.finalize_tmp()
        replace.assert_not_called()

    def test_target_change_does_not_consume_another_installation_tmp(self):
        self.prepare()
        other = self.root / "other"
        other.mkdir()
        other_asar = other / "app.asar"
        make_asar(other_asar)
        (other / self.pi.TMP.name).write_bytes(self.pi.TMP.read_bytes())
        (other / self.pi.TMP_META.name).write_bytes(self.pi.TMP_META.read_bytes())
        self.pi.set_target(other_asar)
        with mock.patch.object(self.pi.os, "replace") as replace:
            self.assertFalse(self.pi.install(finalize=True))
        replace.assert_not_called()
        self.assertNotIn(b"inject-main.cjs", self.pi.entry_bytes_of(other_asar))

    def test_remove_cancels_pending_install_even_if_target_is_not_injected(self):
        self.prepare()
        old_tmp = self.pi.TMP.read_bytes()
        self.assertTrue(self.pi.remove())
        meta = json.loads(self.pi.TMP_META.read_text())
        self.assertEqual(meta["operation"], "cancelled")
        self.assertEqual(self.pi.TMP.read_bytes(), old_tmp)
        with self.assertRaises(self.pi.PendingTmpError):
            self.pi.finalize_tmp()
        self.assertNotIn(b"inject-main.cjs", self.pi.entry_bytes_of(self.asar))

    def test_remove_on_injected_target_replaces_only_with_remove_package(self):
        make_asar(self.asar, b"official;" + self.pi.INJECT_LINE.encode())
        self.prepare()
        with mock.patch.object(self.pi.os, "replace", side_effect=PermissionError("locked")):
            self.assertFalse(self.pi.remove())
        # The cancellation sidecar may itself be locked. Retrying remove is safe.
        self.assertTrue(self.pi.remove())
        self.assertNotIn(b"inject-main.cjs", self.pi.entry_bytes_of(self.asar))
        self.assertFalse(self.pi.TMP.exists())

    def test_unknown_tmp_is_neither_installed_deleted_nor_overwritten(self):
        self.pi.TMP.write_bytes(b"user data")
        self.assertFalse(self.pi.install())
        self.assertFalse(self.pi.install(finalize=True))
        self.assertTrue(self.pi.remove())
        self.assertEqual(self.pi.TMP.read_bytes(), b"user data")
        self.assertFalse(self.pi.TMP_META.exists())

    def test_remove_pending_can_be_finalized_but_install_finalize_rejects_it(self):
        make_asar(self.asar, b"official;" + self.pi.INJECT_LINE.encode())
        replace = self.pi.os.replace
        def locked(src, dst):
            if Path(src) == self.pi.TMP:
                raise PermissionError("locked")
            return replace(src, dst)
        with mock.patch.object(self.pi.os, "replace", side_effect=locked):
            self.assertFalse(self.pi.remove())
        self.assertEqual(json.loads(self.pi.TMP_META.read_text())["operation"], "remove")
        self.assertFalse(self.pi.install(finalize=True))
        self.assertTrue(self.pi.finalize_tmp(operation=None))
        self.assertFalse(self.pi.ZUSAGE_LINE_RE.search(self.pi.entry_bytes_of(self.asar)))

    def test_remove_self_check_rejects_injection_from_another_runtime(self):
        other = (self.root / "other-runtime" / "inject-main.cjs").as_uri()
        old_injection = self.pi.INJECT_LINE_TMPL.format(url=other).encode()
        make_asar(self.asar, b"official;" + old_injection)
        source = self.pi.source_fingerprint(self.asar)
        self.pi.TMP.write_bytes(self.asar.read_bytes())
        with self.assertRaises(self.pi.PendingTmpError):
            self.pi.write_tmp_metadata(source, operation="remove")
        with self.assertRaises(self.pi.PendingTmpError):
            self.pi.finalize_tmp(operation=None)
        self.assertTrue(self.pi.TMP.exists())

    def test_unknown_sidecar_and_symlink_tmp_are_not_taken_over(self):
        self.pi.TMP_META.write_text('{"user":"data"}')
        self.assertFalse(self.pi.install())
        self.assertFalse(self.pi.remove())
        self.assertEqual(self.pi.TMP_META.read_text(), '{"user":"data"}')
        self.pi.TMP_META.unlink()
        user_file = self.root / "user-data"
        user_file.write_bytes(b"user content")
        self.pi.TMP.symlink_to(user_file)
        self.assertFalse(self.pi.install())
        self.assertEqual(user_file.read_bytes(), b"user content")
        self.assertTrue(self.pi.TMP.is_symlink())

    @unittest.skipIf(os.name == "nt", "POSIX permissions")
    def test_stage_install_and_remove_preserve_asar_mode_and_owner(self):
        self.asar.chmod(0o644)
        before = self.asar.stat()
        self.assertTrue(self.pi.install())
        for after in (self.asar.stat(),):
            self.assertEqual(stat.S_IMODE(after.st_mode), 0o644)
            self.assertEqual((after.st_uid, after.st_gid), (before.st_uid, before.st_gid))
        self.assertTrue(self.pi.remove())
        after = self.asar.stat()
        self.assertEqual(stat.S_IMODE(after.st_mode), 0o644)
        self.assertEqual((after.st_uid, after.st_gid), (before.st_uid, before.st_gid))

    def test_failed_install_syntax_cannot_be_manually_finalized(self):
        original = self.asar.read_bytes()
        with mock.patch.object(self.pi, "syntax_check", return_value=False):
            self.assertFalse(self.pi.install())
        self.assertFalse(self.pi.install(finalize=True))
        self.assertEqual(self.asar.read_bytes(), original)
        self.assertFalse(self.pi.TMP.exists())
        self.assertFalse(self.pi.TMP_META.exists())
        self.assertTrue(self.pi.install())

    def test_failed_remove_syntax_cannot_be_finalized(self):
        make_asar(self.asar, b"official;" + self.pi.INJECT_LINE.encode())
        original = self.asar.read_bytes()
        with mock.patch.object(self.pi, "syntax_check", return_value=False):
            self.assertFalse(self.pi.remove())
        with self.assertRaises(self.pi.PendingTmpError):
            self.pi.finalize_tmp(operation=None)
        self.assertEqual(self.asar.read_bytes(), original)
        self.assertTrue(self.pi.remove())

    def test_partial_repack_failure_can_retry_without_orphan_tmp(self):
        def partial(src, modify, dst):
            self.assertNotEqual(dst, self.pi.TMP)
            Path(dst).write_bytes(b"partial package")
            raise OSError("disk full")
        with mock.patch.object(self.pi, "repack", side_effect=partial):
            self.assertFalse(self.pi.install())
        self.assertFalse(self.pi.TMP.exists())
        self.assertFalse(self.pi.TMP_META.exists())
        self.assertEqual(list(self.root.glob(self.pi.TMP.name + ".*.stage")), [])
        self.assertTrue(self.pi.install())

    def test_partial_repack_preserves_previous_owned_pending_pair(self):
        self.prepare()
        before = (self.pi.TMP.read_bytes(), self.pi.TMP_META.read_bytes())
        def partial(src, modify, dst):
            Path(dst).write_bytes(b"half-written")
            raise OSError("disk full")
        with mock.patch.object(self.pi, "repack", side_effect=partial):
            self.assertFalse(self.pi.install())
        self.assertEqual((self.pi.TMP.read_bytes(), self.pi.TMP_META.read_bytes()), before)
        self.assertTrue(self.pi.install())

    def test_upgrade_during_repack_can_retry_against_new_source(self):
        repack = self.pi.repack
        def upgrade(src, modify, dst):
            repack(src, modify, dst)
            make_asar(self.asar, b"console.log('official v2');")
        with mock.patch.object(self.pi, "repack", side_effect=upgrade):
            self.assertFalse(self.pi.install())
        self.assertFalse(self.pi.TMP.exists())
        self.assertFalse(self.pi.TMP_META.exists())
        self.assertTrue(self.pi.install())
        self.assertIn(b"official v2", self.pi.entry_bytes_of(self.asar))

    def test_sidecar_write_failure_can_retry_before_and_after_tmp_publication(self):
        atomic = self.pi._atomic_tmp_metadata
        for failure in (1, 2):
            with self.subTest(failure=failure):
                make_asar(self.asar)
                calls = []
                def fail(meta):
                    calls.append(meta)
                    if len(calls) == failure:
                        raise OSError("sidecar write failed")
                    return atomic(meta)
                with mock.patch.object(self.pi, "_atomic_tmp_metadata", side_effect=fail):
                    self.assertFalse(self.pi.install())
                self.assertFalse(self.pi.install(finalize=True))
                self.assertNotIn(b"inject-main.cjs", self.pi.entry_bytes_of(self.asar))
                self.assertTrue(self.pi.install())

    def test_unknown_tmp_is_preserved_after_repack_failure(self):
        self.pi.TMP.write_bytes(b"unknown historical TMP")
        with mock.patch.object(self.pi, "repack", side_effect=OSError("disk full")) as repack:
            self.assertFalse(self.pi.install())
        repack.assert_not_called()
        self.assertEqual(self.pi.TMP.read_bytes(), b"unknown historical TMP")

    def test_cli_dispatches_finalize_flag(self):
        with mock.patch.object(self.pi, "install", return_value=True) as install:
            self.pi.main(["install", "--finalize"])
        install.assert_called_once_with(finalize=True)

    def test_stamp_fields_platform_contract(self):
        # Windows 的 ctime 是创建时间（无防篡改价值），且杀软过滤驱动下路径 lstat 与
        # 句柄 fstat 恒不一致，必须剔除；POSIX 的 ctime 是 inode 变更时间，保留。
        fields = self.pi._STAMP_FIELDS
        if sys.platform == "win32":
            self.assertNotIn("ctime_ns", fields)
        else:
            self.assertIn("ctime_ns", fields)
        meta = self.prepare()
        for fingerprint in (meta["source"], meta["tmp"]):
            self.assertEqual({key for key in fingerprint if key != "sha256"}, set(fields))

    def legacy_sidecar(self, **changes):
        """改写成升级前的 sidecar：旧版全平台都记录 ctime_ns（Windows 现已不比对）。"""
        meta = json.loads(self.pi.TMP_META.read_text(encoding="utf-8"))
        for field in ("source", "tmp"):
            meta[field]["ctime_ns"] = 1
        meta.update(changes)
        self.pi.TMP_META.write_text(json.dumps(meta), encoding="utf-8")

    def without_ctime(self):
        """按 Windows 字段集运行：Windows 上即实际值，POSIX 上模拟升级后的 Windows。"""
        fields = tuple(key for key in self.pi._STAMP_FIELDS if key != "ctime_ns")
        return mock.patch.object(self.pi, "_STAMP_FIELDS", fields)

    def test_legacy_sidecar_with_ctime_is_finalized_after_upgrade(self):
        # 回归：Windows 剔除 ctime_ns 后，旧 sidecar 多出的字段曾让 hash 复核恒报
        # "pending source/TMP hash mismatch"，收尾被取消。
        self.prepare()
        self.legacy_sidecar()
        with self.without_ctime():
            self.pi.pending_tmp("install", verify_hash=True)
            self.assertTrue(self.pi.install(finalize=True))
        self.assertTrue(self.pi.self_check(self.asar))
        self.assertFalse(self.pi.TMP.exists())

    def test_legacy_sidecar_still_rejects_hash_mismatch(self):
        # 只忽略旧版多出的字段：sha256 与当前字段仍逐一比对。
        meta = self.prepare()
        self.legacy_sidecar(tmp=dict(meta["tmp"], ctime_ns=1, sha256="0" * 64))
        with self.without_ctime(), \
                self.assertRaisesRegex(self.pi.PendingTmpError, "hash mismatch"):
            self.pi.pending_tmp("install", verify_hash=True)
        self.assertTrue(self.pi.TMP.exists())

    def test_reinstall_reclaims_legacy_pending_pair_and_publication_journal(self):
        # 回归：旧 sidecar 曾让重装报 "pending TMP no longer belongs to its sidecar"；
        # 中断发布留下的旧版 journal（previous_tmp 带 ctime_ns）同理。
        for journal in (False, True):
            with self.subTest(journal=journal):
                self.pi.TMP.unlink(missing_ok=True)
                self.pi.TMP_META.unlink(missing_ok=True)
                make_asar(self.asar)
                meta = self.prepare()
                if journal:
                    self.legacy_sidecar(operation="cancelled", publishing=True,
                                        tmp=dict(meta["tmp"], sha256="0" * 64),
                                        previous_tmp=dict(meta["tmp"], ctime_ns=1))
                else:
                    self.legacy_sidecar()
                with self.without_ctime():
                    fresh = self.prepare()
                self.assertNotIn("ctime_ns", fresh["tmp"])

    def test_same_fingerprint_treats_missing_fields_as_mismatch(self):
        current = {"size": 1, "sha256": "a"}
        self.assertTrue(self.pi._same_fingerprint(current, dict(current, ctime_ns=5)))
        self.assertFalse(self.pi._same_fingerprint(current, {"sha256": "a"}))
        self.assertFalse(self.pi._same_fingerprint(current, None))

    @unittest.skipIf(sys.platform != "win32", "Windows 过滤驱动 ctime 怪癖回归")
    def test_windows_path_and_handle_stamps_agree_on_fresh_files(self):
        # 曾在 NTFS+杀软环境必现：刚写完的文件路径 stat 与句柄 fstat 的 ctime_ns 不一致，
        # source_fingerprint 直接抛 "file changed before hashing"，安装全流程不可用。
        for _ in range(3):
            make_asar(self.asar)
            self.assertEqual(self.pi.source_fingerprint(self.asar),
                             self.pi.source_fingerprint(self.asar))


if __name__ == "__main__":
    unittest.main()
