# -*- coding: utf-8 -*-
import contextlib
import ctypes
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import struct
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
# 兼容 `unittest discover -s tests` 与 `python -m unittest tests.test_xxx` 两种调用形态
sys.path.insert(0, str(Path(__file__).resolve().parent))
import symlink_support  # noqa: E402


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

    def upgrade_asar(self, entry=b"console.log('official v2');"):
        """写入"官方升级版"并强制 mtime 前移：升级模拟必须能被 _same_stamp 的 stat 级
        检测发现，而 TEMP 所在卷的写入路径时间戳可能被惰性批更新（实测某卷 50 次连写
        49 次 mtime 相同），同尺寸替换会逃过检测，测试随之偶发失败。真实升级相隔分钟级
        不受影响，这里用显式 utime 换确定性；余量取 2s 以覆盖最粗的 FAT32 mtime 粒度
        （NTFS 100ns / exFAT 10ms / FAT32 2s，更小的余量在粗粒度卷上会被取整回原值）。"""
        make_asar(self.asar, entry)
        st = self.asar.stat()
        os.utime(self.asar, ns=(st.st_atime_ns, st.st_mtime_ns + 2_000_000_000))

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
            self.upgrade_asar()
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
            self.upgrade_asar()
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
        self.upgrade_asar()
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
            self.upgrade_asar()
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

    def test_unknown_sidecar_is_not_taken_over(self):
        self.pi.TMP_META.write_text('{"user":"data"}')
        self.assertFalse(self.pi.install())
        self.assertFalse(self.pi.remove())
        self.assertEqual(self.pi.TMP_META.read_text(), '{"user":"data"}')

    @unittest.skipUnless(symlink_support.can_create_symlinks(),
                         "os.symlink requires SeCreateSymbolicLinkPrivilege on Windows")
    def test_symlink_tmp_is_not_taken_over(self):
        self.pi.TMP_META.unlink(missing_ok=True)
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
        # 关闭复用判定强制走 repack 路径（issue #120 后：内容一致的待收尾包会先被复用，
        # 到不了 repack；重打包失败场景只剩待收尾包与目标不一致时才会发生）。
        with mock.patch.object(self.pi, "repack", side_effect=partial), \
                mock.patch.object(self.pi, "_reusable_pending_install", return_value=False):
            self.assertFalse(self.pi.install())
        self.assertEqual((self.pi.TMP.read_bytes(), self.pi.TMP_META.read_bytes()), before)
        self.assertTrue(self.pi.install())

    def test_upgrade_during_repack_can_retry_against_new_source(self):
        repack = self.pi.repack
        def upgrade(src, modify, dst):
            repack(src, modify, dst)
            self.upgrade_asar()
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

    def test_consume_flag_arg_parses_both_forms_and_strips_them(self):
        self.assertEqual(self.pi._consume_flag_arg(["install", "--asar", "/x/app.asar", "--finalize"], "asar"),
                         ("/x/app.asar", ["install", "--finalize"]))
        self.assertEqual(self.pi._consume_flag_arg(["--asar=/x/app.asar", "check"], "asar"),
                         ("/x/app.asar", ["check"]))
        self.assertEqual(self.pi._consume_flag_arg(["install", "--finalize"], "asar"),
                         (None, ["install", "--finalize"]))
        self.assertEqual(self.pi._consume_flag_arg(["--asar"], "asar"), (None, ["--asar"]))   # 缺值：原样保留，不崩
        # 出现多次取最后一次，与常见 CLI 行为一致；--runtime 复用同一套解析逻辑。
        self.assertEqual(self.pi._consume_flag_arg(["--runtime", "/a", "--runtime", "/b"], "runtime"),
                         ("/b", []))
        # 紧随其后的 token 本身像另一个 flag：按缺值处理，原样保留，不误吞成这个 flag 的值。
        self.assertEqual(self.pi._consume_flag_arg(["--asar", "--finalize", "install"], "asar"),
                         (None, ["--asar", "--finalize", "install"]))

    def fresh_module(self):
        """未调用 set_target() 的全新实例：复现 issue #14——standalone 运行时模块级 ASAR
        仍是平台默认猜测路径，而非真实安装位置。"""
        spec = importlib.util.spec_from_file_location("fresh_patch_test", ROOT / "patch_install.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_standalone_without_asar_guesses_default_and_reports(self):
        # issue #14 场景：standalone 在猜错的默认路径上运行 check。曾以 FileNotFoundError
        # 裸崩（测试旧名 …and_crashes 锁的就是那个崩溃）；2026-10-24 起 check() 对坏目标
        # 输出可读提示并以 1 退出，不再抛裸 traceback。
        fresh = self.fresh_module()
        buf = io.StringIO()
        with mock.patch.object(fresh, "ASAR", self.root / "not-the-real-install" / "app.asar"), \
                contextlib.redirect_stdout(buf):
            rc = fresh.main(["check"])
        self.assertEqual(rc, 1)
        self.assertIn("读取 asar 失败", buf.getvalue())

    def test_standalone_asar_flag_fixes_default_path_guess(self):
        fresh = self.fresh_module()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), \
                mock.patch.object(fresh, "syntax_check", return_value=True):
            fresh.main(["check", "--asar", str(self.asar)])
        self.assertEqual(fresh.ASAR, self.asar.resolve())
        self.assertIn("asar:", buf.getvalue())

    def test_standalone_zcode_asar_env_fixes_default_path_guess(self):
        fresh = self.fresh_module()
        with mock.patch.dict(os.environ, {"ZCODE_ASAR": str(self.asar)}), \
                contextlib.redirect_stdout(io.StringIO()), \
                mock.patch.object(fresh, "syntax_check", return_value=True):
            fresh.main(["check"])
        self.assertEqual(fresh.ASAR, self.asar.resolve())

    def test_cli_asar_flag_takes_priority_over_env_var(self):
        fresh = self.fresh_module()
        other = self.root / "other.asar"
        make_asar(other)
        with mock.patch.dict(os.environ, {"ZCODE_ASAR": str(other)}), \
                contextlib.redirect_stdout(io.StringIO()), \
                mock.patch.object(fresh, "syntax_check", return_value=True):
            fresh.main(["check", "--asar", str(self.asar)])
        self.assertEqual(fresh.ASAR, self.asar.resolve())

    def test_install_while_running_failure_hint_includes_asar_path(self):
        # 回归：client_running 时原子替换因文件占用失败，提示里的 "手动执行" 命令必须
        # 带上当前真实目标，standalone 复制执行才不会落到默认猜测路径；还要带 --runtime，
        # 否则 install --finalize 会被 sidecar 来源授权校验拒绝（见下面两条端到端用例）。
        # issue #163：脚本本身也要指向运行目录副本——clone 被删后裸文件名无处可解析。
        buf = io.StringIO()
        with mock.patch.object(self.pi, "client_running", return_value=True), \
                mock.patch.object(self.pi, "_replace_pending", side_effect=PermissionError("locked")), \
                mock.patch.object(self.pi, "launch_monitor"), \
                contextlib.redirect_stdout(buf):
            self.assertFalse(self.pi.install())
        output = buf.getvalue()
        self.assertIn(f'--asar "{self.asar.resolve()}"', output)
        self.assertIn(f'--runtime "{self.pi.RUNTIME}"', output)
        tool = self.pi.RUNTIME / "patch_install.py"
        self.assertIn(f'python "{tool}"', output)
        self.assertIn("Keep it open", output)   # 夹具 _LANG="en"（setUp）

    def test_remove_failure_hint_includes_asar_path(self):
        self.pi.install()   # 先注入，_remove() 才会走到 _replace_pending
        buf = io.StringIO()
        with mock.patch.object(self.pi, "_replace_pending", side_effect=PermissionError("locked")), \
                contextlib.redirect_stdout(buf):
            self.assertFalse(self.pi.remove())
        output = buf.getvalue()
        self.assertIn(f'--asar "{self.asar.resolve()}"', output)
        self.assertNotIn("--runtime", output)   # remove 不走来源授权的 runtime 校验，不需要
        tool = self.pi.RUNTIME / "patch_install.py"   # issue #163：脚本同款指向运行目录副本
        self.assertIn(f'python "{tool}"', output)

    def test_check_pending_tmp_hint_includes_asar_path(self):
        self.prepare()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.pi.check()
        output = buf.getvalue()
        self.assertIn(f'--asar "{self.asar.resolve()}"', output)
        self.assertIn(f'--runtime "{self.pi.RUNTIME}"', output)

    def test_check_pending_remove_tmp_hint_suggests_remove_not_install(self):
        # 回归：待替换 TMP 若是 remove 操作，提示必须是 remove，不能照搬 install --finalize——
        # 那条命令会被 pending_tmp 的操作类型校验拒绝（"no longer authorized"）。
        self.pi.install()   # 先注入，remove 的 TMP 才有意义
        self.prepare(operation="remove")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.pi.check()
        output = buf.getvalue()
        self.assertIn(f'remove --asar "{self.asar.resolve()}"', output)
        self.assertNotIn("install --finalize", output)
        self.assertNotIn("--runtime", output)

    def test_runtime_flag_accepts_relative_path_without_crashing(self):
        # 回归（第三轮复审发现）：--runtime 改为不 resolve 以保字节一致（见上面两条用例）后，
        # LOADER.as_uri() 要求绝对路径，手动敲相对路径会直接崩溃；提示本身回显的永远是
        # 绝对路径不受影响，但命令行参数要对手动输入也宽容。os.path.abspath 补全成绝对路径、
        # 不跟随符号链接解析，两头都不破。--asar 一并指向 fixture，隔离本机真实 ZCode 安装。
        fresh = self.fresh_module()
        with contextlib.redirect_stdout(io.StringIO()):
            fresh.main(["check", "--asar", str(self.asar), "--runtime", "relative/sub/dir"])   # 不应抛出
        self.assertTrue(fresh.RUNTIME.is_absolute())
        self.assertTrue(str(fresh.RUNTIME).endswith(str(Path("relative/sub/dir"))))

    def test_standalone_finalize_without_runtime_flag_is_rejected_by_sidecar(self):
        # 回归（issue #14 复审发现的残留问题）：仅 --asar 不够，install --finalize 还要求
        # sidecar 记录的运行时目录与当前 RUNTIME 一致（pending_tmp 来源授权校验）；standalone
        # 默认 RUNTIME 是脚本自身所在目录，和生成 TMP 时的插件运行时数据目录是两回事。
        self.prepare()   # 用已 set_target/set_runtime 到 self.runtime 的 self.pi 生成待替换 TMP
        other_dir = self.root / "elsewhere"
        other_dir.mkdir()
        fresh = self.fresh_module()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), \
                mock.patch.object(fresh, "syntax_check", return_value=True), \
                mock.patch.object(fresh, "client_running", return_value=False):
            result = fresh.main(["install", "--finalize", "--asar", str(self.asar), "--runtime", str(other_dir)])
        self.assertFalse(result)
        self.assertIn("no longer authorized", buf.getvalue())
        self.assertTrue(self.pi.TMP.exists())   # 拒绝收尾；不误删/误替换

    def test_standalone_finalize_with_matching_runtime_flag_succeeds(self):
        # main() 不对 --runtime 做 resolve：和各提示原样回显的 RUNTIME 字节对齐，用户复制
        # 粘贴即可还原成同一个值，不会在符号链接路径上被 resolve 带偏（如 macOS
        # /var -> /private/var）；这里故意用未 resolve 的 self.runtime 验证这一点。
        self.prepare()
        fresh = self.fresh_module()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), \
                mock.patch.object(fresh, "syntax_check", return_value=True), \
                mock.patch.object(fresh, "client_running", return_value=False):
            result = fresh.main(["install", "--finalize", "--asar", str(self.asar),
                                "--runtime", str(self.runtime)])
        self.assertTrue(result, buf.getvalue())
        self.assertFalse(self.pi.TMP.exists())

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

    def test_valid_identical_pending_is_reused_without_repack_or_rewrite(self):
        # issue #120：客户端持续运行期间每次 SessionStart 自动安装都会走到这里——磁盘上
        # 已有同来源、同运行时、入口内容完全一致的待收尾包时必须复用（stat 级判定），
        # 不得再整包 repack/重写 TMP，也不得重复记录安装意图；替换尝试仍走原有校验链，
        # 运行中被拒后照常拉起监控等待退出收尾。
        self.prepare()
        tmp_bytes = self.pi.TMP.read_bytes()
        meta_bytes = self.pi.TMP_META.read_bytes()
        intent = mock.Mock()
        with mock.patch.object(self.pi, "repack", side_effect=AssertionError("must not repack")), \
                mock.patch.object(self.pi, "client_running", return_value=True), \
                mock.patch.object(self.pi, "launch_monitor") as monitor, \
                mock.patch.object(self.pi.os, "replace", side_effect=PermissionError("locked")):
            self.assertFalse(self.pi.install(before_publish=intent))
        self.assertEqual(self.pi.TMP.read_bytes(), tmp_bytes)
        self.assertEqual(self.pi.TMP_META.read_bytes(), meta_bytes)
        intent.assert_not_called()
        monitor.assert_called_once()

    def test_reused_pending_finalizes_normally_once_client_exits(self):
        self.prepare()
        with mock.patch.object(self.pi, "repack", side_effect=AssertionError("must not repack")), \
                mock.patch.object(self.pi, "launch_monitor"):
            self.assertTrue(self.pi.install())
        self.assertFalse(self.pi.TMP.exists())
        self.assertFalse(self.pi.TMP_META.exists())
        self.assertIn(b";import(", self.pi.entry_bytes_of(self.asar))

    def test_pending_with_divergent_content_is_rebuilt(self):
        # 入口内容与本次安装目标不一致的待收尾包不得复用：按原路径重建并覆盖发布。
        entry = self.pi.entry_bytes_of(self.asar)
        stripped = self.pi.ZUSAGE_LINE_RE.sub(b"", entry)
        self.pi.prepare_tmp({"/" + self.pi.ENTRY: stripped + b"/*divergent*/" + self.pi.INJECT_LINE.encode()})
        real_replace = self.pi.os.replace
        def locked_for_target(src, dst, *args, **kwargs):
            if Path(dst) == self.pi.ASAR:
                raise PermissionError("locked")
            return real_replace(src, dst, *args, **kwargs)
        with mock.patch.object(self.pi, "repack", wraps=self.pi.repack) as repack, \
                mock.patch.object(self.pi, "client_running", return_value=True), \
                mock.patch.object(self.pi, "launch_monitor"), \
                mock.patch.object(self.pi.os, "replace", side_effect=locked_for_target):
            self.assertFalse(self.pi.install())
        repack.assert_called_once()
        self.assertEqual(self.pi.entry_bytes_of(self.pi.TMP), stripped + self.pi.INJECT_LINE.encode())

    def test_pending_becomes_stale_after_official_upgrade_and_is_rebuilt(self):
        # 复用判定的安全底线：官方升级换了 asar（stamp 变化）后，旧待收尾包绝不能
        # 被复用去覆盖新版，必须按新来源重建。
        self.prepare()
        self.upgrade_asar()
        with mock.patch.object(self.pi, "repack", wraps=self.pi.repack) as repack, \
                mock.patch.object(self.pi, "launch_monitor"):
            self.assertTrue(self.pi.install())
        repack.assert_called_once()
        self.assertIn(b"official v2", self.pi.entry_bytes_of(self.asar))
        self.assertIn(b";import(", self.pi.entry_bytes_of(self.asar))

    @unittest.skipIf(sys.platform != "win32", "Windows 过滤驱动 ctime 怪癖回归")
    def test_windows_path_and_handle_stamps_agree_on_fresh_files(self):
        # 曾在 NTFS+杀软环境必现：刚写完的文件路径 stat 与句柄 fstat 的 ctime_ns 不一致，
        # source_fingerprint 直接抛 "file changed before hashing"，安装全流程不可用。
        for _ in range(3):
            make_asar(self.asar)
            self.assertEqual(self.pi.source_fingerprint(self.asar),
                             self.pi.source_fingerprint(self.asar))


class ProtectedTargetTests(unittest.TestCase):
    """issue #130：Windows 的 os.access 看不见 ACL（受保护目录恒报可写），可写性
    判定必须以真实写入探针兜底；否则 hook 会在受保护目录上拉起永远无法收尾的
    无提权 monitor，并给出「无需重试安装」的假承诺，待收尾包永久搁浅。"""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir()
        env = mock.patch.dict(os.environ, {"HOME": str(self.home), "USERPROFILE": str(self.home),
                                           "ZUSAGE_NO_MONITOR": "1", "ZUSAGE_MONITOR_QUIET": ""})
        env.start()
        self.addCleanup(env.stop)
        spec = importlib.util.spec_from_file_location("protected_patch_test", ROOT / "patch_install.py")
        self.pi = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.pi)
        self.pi._LANG = "en"
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        (self.runtime / "inject-main.cjs").write_text("// fixture", encoding="utf-8")

    def protected_target(self):
        """建受保护目录夹具：目录对普通用户只读（root 无效，各用例自行 skip）。"""
        directory = self.root / "Program Files" / "ZCode" / "resources"
        directory.mkdir(parents=True)
        asar = directory / "app.asar"
        make_asar(asar)
        os.chmod(directory, 0o555)
        self.addCleanup(os.chmod, directory, 0o755)
        return directory, asar

    def refuse_root(self):
        if os.name == "nt":
            # Windows 的 chmod 只设目录只读属性，并不阻止目录内创建文件——chmod
            # 夹具模拟不了受保护目录；Windows ACL 场景需实机验证（issue #130）。
            self.skipTest("POSIX chmod 夹具在 Windows 上模拟不了受保护目录")
        if os.name == "posix" and os.geteuid() == 0:
            self.skipTest("root 对只读目录仍可写，无法模拟权限拒绝")

    def test_target_writable_probes_real_write_when_access_lies(self):
        # 模拟 Windows os.access 谎报可写：判定必须落到真实写入探针，不依赖 access。
        self.refuse_root()
        directory, asar = self.protected_target()
        self.pi.set_target(asar)
        self.pi.set_runtime(self.runtime)
        with mock.patch.object(self.pi.os, "access", return_value=True):
            self.assertFalse(self.pi.target_writable())
        os.chmod(directory, 0o755)
        self.assertTrue(self.pi.target_writable())
        # 可写目录上探针不得留残余文件。
        self.assertEqual([p.name for p in directory.iterdir()], ["app.asar"])

    def test_target_writable_probe_denial_is_not_writable(self):
        # 全平台可跑（review 二轮）：写入探针本身被拒（Windows ACL 目录的实际
        # 检测形态，chmod 夹具在 Windows 上模拟不了）时必须判不可写；
        # 删掉探针分支的变异在本用例下同样红。
        asar = self.root / "probe-denied.asar"
        make_asar(asar)
        self.pi.set_target(asar)
        self.pi.set_runtime(self.runtime)
        with mock.patch.object(self.pi.tempfile, "mkstemp",
                               side_effect=PermissionError(5, "denied")):
            self.assertFalse(self.pi.target_writable())

    def test_install_on_access_lying_target_hints_instead_of_spawning_monitor(self):
        # issue #130 主链：受保护目录上已有（提权执行排定的）有效待收尾包时，复用
        # 判定命中、跳过重打包直抵 replace；os.access 谎报可写会让 replace 失败后
        # 拉起无提权 monitor——它永远无法收尾，还占着实例锁挡住提权重跑重建。
        # 锁文件按提权执行残留预建，否则 install() 在锁阶段就失败、走不到这条链。
        self.refuse_root()
        directory, asar = self.protected_target()
        self.pi.set_target(asar)
        self.pi.set_runtime(self.runtime)
        os.chmod(directory, 0o755)
        with contextlib.redirect_stdout(io.StringIO()):
            self.pi.prepare_tmp({"/" + self.pi.ENTRY:
                                 self.pi.entry_bytes_of(asar) + self.pi.INJECT_LINE.encode()})
            with self.pi._target_lock():
                pass
        os.chmod(directory, 0o555)
        with mock.patch.object(self.pi.os, "access", return_value=True), \
                mock.patch.object(self.pi, "client_running", return_value=True), \
                mock.patch.object(self.pi, "launch_monitor") as launch:
            with contextlib.redirect_stdout(io.StringIO()):
                ok = self.pi.install()
        self.assertFalse(ok)
        launch.assert_not_called()
        # 待收尾包必须原样保留：提权重跑复用它，秒级重建收尾监控。
        self.assertTrue(self.pi.TMP.exists())
        self.assertTrue(self.pi.TMP_META.exists())

    def test_access_check_still_blocks_readonly_asar_in_writable_dir(self):
        # os.access 快速判定必须保留（review 变异 M2）：目录可写但 asar 文件本身
        # 只读时（Windows 上 asar 被设只读属性即此场景），只靠写入探针会误报可写。
        if os.name == "posix" and os.geteuid() == 0:
            self.skipTest("root 对只读文件仍可写，无法模拟权限拒绝")
        asar = self.root / "readonly.asar"
        make_asar(asar)
        self.pi.set_target(asar)
        self.pi.set_runtime(self.runtime)
        os.chmod(asar, 0o444)
        self.addCleanup(os.chmod, asar, 0o644)
        self.assertFalse(self.pi.target_writable())

    def test_is_elevated_matches_identity(self):
        # IS_WIN 显式压成 False 钉 POSIX 分支：真实 Windows 上 geteuid 的 patch
        # 管不到 windll 路径，不压会在非提权 Windows 上必红（review 二轮）；
        # Windows 分支由隔壁用例全 mock 覆盖。
        with mock.patch.object(self.pi, "IS_WIN", False):
            if os.name == "posix":
                self.assertEqual(self.pi.is_elevated(), os.geteuid() == 0)
            else:
                # Windows 没有 geteuid：探测失败按无提权。
                self.assertFalse(self.pi.is_elevated())
            with mock.patch.object(self.pi.os, "geteuid", return_value=0, create=True):
                self.assertTrue(self.pi.is_elevated())
            with mock.patch.object(self.pi.os, "geteuid", side_effect=AttributeError, create=True):
                self.assertFalse(self.pi.is_elevated())

    def test_is_elevated_windows_branch_uses_shell_check(self):
        windll = mock.Mock()
        windll.shell32.IsUserAnAdmin.return_value = 1
        with mock.patch.object(self.pi, "IS_WIN", True), \
                mock.patch.object(ctypes, "windll", windll, create=True):
            self.assertTrue(self.pi.is_elevated())
            # False 方向必须同在补丁作用域内断言：出了 with IS_WIN 已还原，
            # 走的是 POSIX 分支，守护不到 Windows 分支（review 变异 M5）。
            windll.shell32.IsUserAnAdmin.return_value = 0
            self.assertFalse(self.pi.is_elevated())


class CliExitCodeTests(unittest.TestCase):
    """issue #163 review：`sys.exit(main())` 把 bool 直接当退出码——True→1（失败）、
    False→0（成功）正好颠倒。手动收尾命令（install --finalize）的脚本化判断全靠
    退出码，成功失败颠倒会让人误判收尾结果。（夹具全是未注入 asar：check 不触发
    syntax_check、finalize 失败路径到不了 node，无 Node 环境也能运行。）"""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir()
        env = mock.patch.dict(os.environ, {"HOME": str(self.home), "USERPROFILE": str(self.home),
                                           "ZUSAGE_NO_MONITOR": "1", "ZUSAGE_MONITOR_QUIET": ""})
        env.start()
        self.addCleanup(env.stop)

    def run_cli(self, *argv):
        return subprocess.run(
            [sys.executable, "-B", str(ROOT / "patch_install.py"), *argv],
            capture_output=True, env=dict(os.environ), timeout=60)

    def test_check_exit_code_distinguishes_success_and_failure(self):
        asar = self.root / "app.asar"
        make_asar(asar)
        ok = self.run_cli("check", "--asar", str(asar))
        self.assertEqual(ok.returncode, 0, ok.stderr.decode("utf-8", "replace"))
        bad = self.run_cli("check", "--asar", str(self.root / "missing.asar"))
        self.assertEqual(bad.returncode, 1, bad.stdout.decode("utf-8", "replace"))

    def test_finalize_exit_code_is_zero_only_on_success(self):
        # install --finalize 无 pending 时优雅失败（False）：退出码必须是 1 而不是 0。
        asar = self.root / "app.asar"
        make_asar(asar)
        denied = self.run_cli("install", "--finalize", "--asar", str(asar),
                              "--runtime", str(self.root / "runtime"))
        self.assertEqual(denied.returncode, 1, denied.stdout.decode("utf-8", "replace"))


@unittest.skipUnless(shutil.which("node"), "需要 Node 跑真实语法检查")
class SyntaxCheckTests(unittest.TestCase):
    def test_failure_diagnostic_survives_non_utf8_locale(self):
        # Node 恒写 UTF-8：语法错误回显的源码行/路径含非 ASCII 时，按区域编码解码会让 Windows
        # 读线程崩溃（stderr 变 None → AttributeError）或解成乱码；打印回显也不能因输出编码再崩。
        # 放进强制非 UTF-8 区域编码的解释器里跑，任何平台都能区分新旧实现；参数一律 ASCII 转义。
        # 输出编码能表示的字符原样显示，表示不了的才转义。
        source = ascii('const 名字 = "中文" +;\n')
        probe = ("import importlib.util, sys\n"
                 "from pathlib import Path\n"
                 "spec = importlib.util.spec_from_file_location('probe', sys.argv[1])\n"
                 "module = importlib.util.module_from_spec(spec)\n"
                 "spec.loader.exec_module(module)\n"
                 "module._LANG = 'en'\n"
                 "module.ZCODE_EXE = Path(sys.argv[2])\n"
                 f"module.entry_bytes_of = lambda path: {source}.encode('utf-8')\n"
                 "print('RESULT', module.syntax_check(None))\n")
        ascii_only = {"LC_ALL": "C", "PYTHONUTF8": "0", "PYTHONCOERCECLOCALE": "0", "PYTHONIOENCODING": "ascii"}
        for overrides, shown in ((ascii_only, r"\u540d"), ({"PYTHONIOENCODING": "utf-8"}, "名")):
            with self.subTest(env=overrides):
                out = subprocess.run([sys.executable, "-B", "-c", probe, str(ROOT / "patch_install.py"),
                                      shutil.which("node")], capture_output=True,
                                     env=dict(os.environ, **overrides), timeout=60)
                stdout = out.stdout.decode("utf-8", "replace")
                self.assertEqual(out.returncode, 0, out.stderr.decode("utf-8", "replace"))
                self.assertIn("RESULT False", stdout)
                self.assertIn(shown, stdout)   # 回显的源码行（“名”）没被解坏


if __name__ == "__main__":
    unittest.main()
