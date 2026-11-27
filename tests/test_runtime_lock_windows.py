# -*- coding: utf-8 -*-
"""runtime_lock 在 Windows 上的两处竞争面（msvcrt 字节锁、被打开的目标文件）。

1. file_lock 先给空锁文件补 1 个字节再锁首字节。两个进程同时首次创建同一锁文件时，
   后到者在先到者写入之前看到大小 0，随后的补写撞上对方刚锁定的首字节（EACCES）。
   这只是「锁被占」的另一种形态，必须走 busy（FileLockBusy，调用方按锁竞争退避），
   不能以 PermissionError 穿出、被当成权限问题报成 skipped-error。
2. 标记与增强配置文件的替换、标记的删除遇到并发读者会被拒绝——Windows 上目标只要被
   任何句柄打开（读者、杀软，也包括主进程自己的 fs 句柄）替换都被拒，实测不论共享模式。
   读者都是短开，短暂重试即可成功；静默放弃会丢掉重启待办或这次保存，回滚失败还会留下
   一条永不销账的 pending-install 意图；销账末尾的删除被拒则会留下一个已销账的标记。带
   preserve 的写入遇上只读目标时，只读的临时文件要先补回写权限才删得掉。

读者句柄用 CreateFileW 以 FILE_SHARE_READ 持有；共享模式按句柄生效，同进程的另一
句柄同样受拒，所以不必起子进程。「读者何时松手」由替身 sleep 决定，不依赖真实时序。

另有不限于 Windows 的入站用例也放在这里（同属 runtime_lock 的 stdio 面）：
3. 命令行入口的入站 JSON 按 UTF-8 严格解码。主进程与更新器按 JSON.stringify 写 stdin、
   spawn 时不注入编码变量，中文 Windows 的管道默认按区域代码页解码。
"""
import contextlib
import ctypes
import errno
import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from ctypes import wintypes
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.helpers.py_test_support import load_module  # noqa: E402

runtime_lock = load_module("runtime_lock_windows", ROOT / "runtime_lock.py")

WINDOWS_ONLY = "msvcrt / sharing violation: Windows only"
GENERIC_READ = 0x80000000
FILE_SHARE_READ = 0x1
OPEN_EXISTING = 3
INVALID_HANDLE = ctypes.c_void_p(-1).value

if os.name == "nt":
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel32.CreateFileW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    _kernel32.CreateFileW.restype = wintypes.HANDLE
    _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    _kernel32.CloseHandle.restype = wintypes.BOOL
else:   # 非 Windows 只做导入与跳过，不触碰 WinDLL
    _kernel32 = None


class ReaderHandle:
    """以读者的共享模式（不带 FILE_SHARE_DELETE）持有一个已存在文件的句柄。"""

    def __init__(self, path):
        handle = _kernel32.CreateFileW(str(path), GENERIC_READ, FILE_SHARE_READ, None,
                                       OPEN_EXISTING, 0, None)
        if not handle or handle == INVALID_HANDLE:
            raise ctypes.WinError(ctypes.get_last_error())
        self.handle = handle

    def release(self):
        if self.handle:
            _kernel32.CloseHandle(self.handle)
            self.handle = None

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self.release()


@contextlib.contextmanager
def sleep_hook(on_sleep):
    """替身 sleep：记下每次重试的等待时长，不做真实等待。"""
    waits = []

    def fake_sleep(seconds):
        waits.append(seconds)
        on_sleep(len(waits))

    with mock.patch.object(runtime_lock.time, "sleep", side_effect=fake_sleep):
        yield waits


class FileLockEmptyFileTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", WINDOWS_ONLY)
    def test_refused_padding_byte_on_contended_empty_lock_file_is_busy(self):
        """先到者已锁首字节而补位字节尚未落盘（文件仍为空）时，后到者的补写被拒——
        必须报 FileLockBusy，而不是 PermissionError。"""
        import msvcrt
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "contended.lock"
            fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
            try:
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                with self.assertRaises(runtime_lock.FileLockBusy):
                    with runtime_lock.file_lock(path, timeout=0.0):
                        self.fail("锁被占时不得进入临界区")
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            finally:
                os.close(fd)
            with runtime_lock.file_lock(path, timeout=0.0):
                pass   # 对方松手后照常可取


class MarkerReaderTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.marker = self.dir / ".plugin-restart-required"

    def leftovers(self):
        return sorted(p.name for p in self.dir.iterdir() if p != self.marker)

    @unittest.skipUnless(os.name == "nt", WINDOWS_ONLY)
    def test_write_marker_waits_out_a_concurrent_reader(self):
        runtime_lock._write_marker(self.marker, {"state": "pending-install"})
        reader = ReaderHandle(self.marker)
        self.addCleanup(reader.release)
        with sleep_hook(lambda attempt: reader.release()) as waits:   # 首次重试的间隙读者松手
            runtime_lock._write_marker(self.marker, {"state": "acked"})
        self.assertEqual(len(waits), 1)
        self.assertEqual(runtime_lock._read_marker(self.marker), {"state": "acked"})
        self.assertEqual(self.leftovers(), [])

    @unittest.skipUnless(os.name == "nt", WINDOWS_ONLY)
    def test_restore_marker_bytes_waits_out_a_concurrent_reader(self):
        runtime_lock._write_marker(self.marker, {"state": "pending-install"})
        previous = self.marker.read_bytes()
        runtime_lock._write_marker(self.marker, {"state": "acked"})
        reader = ReaderHandle(self.marker)
        self.addCleanup(reader.release)
        with sleep_hook(lambda attempt: reader.release()) as waits:
            runtime_lock._restore_marker_bytes(self.marker, previous)
        self.assertEqual(len(waits), 1)
        self.assertEqual(self.marker.read_bytes(), previous)
        self.assertEqual(self.leftovers(), [])

    @unittest.skipUnless(os.name == "nt", WINDOWS_ONLY)
    def test_restore_marker_unlink_waits_out_a_concurrent_reader(self):
        runtime_lock._write_marker(self.marker, {"state": "pending-install"})
        reader = ReaderHandle(self.marker)
        self.addCleanup(reader.release)
        with sleep_hook(lambda attempt: reader.release()) as waits:
            runtime_lock._restore_marker_bytes(self.marker, None)
        self.assertEqual(len(waits), 1)
        self.assertFalse(self.marker.exists())
        self.assertEqual(self.leftovers(), [])

    @unittest.skipUnless(os.name == "nt", WINDOWS_ONLY)
    def test_permanently_refused_marker_write_still_raises_and_keeps_the_old_marker(self):
        """读者一直不松手：重试有界，最终仍以原异常上抛，旧标记原样保留。"""
        runtime_lock._write_marker(self.marker, {"state": "pending-install"})
        before = self.marker.read_bytes()
        with ReaderHandle(self.marker), sleep_hook(lambda attempt: None) as waits:
            with self.assertRaises(PermissionError):
                runtime_lock._write_marker(self.marker, {"state": "acked"})
        # 钉字面值而不是引用常量：重试预算（_REPLACE_ATTEMPTS × 10ms）是为「读者短开」留的窗口，
        # 调小它必须在这里变红。
        self.assertEqual(len(waits), 19,
                         "永久性拒绝等满 19 次（约 190ms）才上抛：读者短开时重试，而不是第一次被拒就放弃")
        self.assertEqual(self.marker.read_bytes(), before)
        self.assertEqual(self.leftovers(), [])

    def test_unlink_retrying_treats_a_vanished_file_as_done(self):
        """中途被别人删掉不算失败（与 missing_ok=True 等价）。"""
        runtime_lock._unlink_retrying(self.dir / "absent.json")

    def test_replace_retry_only_covers_permission_refusals(self):
        """其它 OSError（如 I/O 错误）不是「读者短开」：第一次就上抛，不白等。"""
        with mock.patch.object(runtime_lock.os, "replace", side_effect=OSError(errno.EIO, "i/o error")), \
                mock.patch.object(runtime_lock.time, "sleep") as sleep:
            with self.assertRaises(OSError) as ctx:
                runtime_lock._replace_retrying("source", "target")
        self.assertEqual(ctx.exception.errno, errno.EIO)
        sleep.assert_not_called()

    def temp_leftovers(self):
        return [name for name in self.leftovers() if name.endswith(".tmp")]

    @unittest.skipUnless(os.name == "nt", WINDOWS_ONLY)
    def test_ack_restart_waits_out_a_concurrent_reader_before_removing_the_marker(self):
        """销账末尾删除标记时读者正开着它：短暂重试后删掉，不留一个已销账的标记在盘上
        （plugin-restart.lock 是永久锁文件，不计入残留）。"""
        payload = b"// fixture overlay\n"
        (self.dir / "overlay.js").write_bytes(payload)
        digest = hashlib.sha256(payload).hexdigest()
        runtime_lock._write_marker(self.marker, {"hashes": {"overlay.js": digest}})
        reader = ReaderHandle(self.marker)
        self.addCleanup(reader.release)
        with sleep_hook(lambda attempt: reader.release()) as waits:
            result = runtime_lock.ack_restart(self.dir, {"overlay.js": digest})
        self.assertEqual(result, {"ok": True, "cleared": True})
        self.assertEqual(len(waits), 1)
        self.assertFalse(self.marker.exists())
        self.assertEqual(self.temp_leftovers(), [])

    @unittest.skipUnless(os.name == "nt", WINDOWS_ONLY)
    def test_enhance_provider_update_waits_out_a_concurrent_reader(self):
        """增强配置的原子替换同标记写入：读者正开着 enhance-provider.json 时先重试，不丢这次保存。"""
        config = self.dir / "enhance-provider.json"
        config.write_text('{"version": 1, "revision": 0, "mode": "default"}', encoding="utf-8")
        reader = ReaderHandle(config)
        self.addCleanup(reader.release)
        with sleep_hook(lambda attempt: reader.release()) as waits:
            updated = runtime_lock.update_enhance_provider(self.dir, 0, {"mode": "default"})
        self.assertEqual(updated["revision"], 1)
        self.assertEqual(len(waits), 1)
        self.assertEqual(json.loads(config.read_text(encoding="utf-8"))["revision"], 1)
        self.assertEqual(self.temp_leftovers(), [])

    @unittest.skipUnless(os.name == "nt", WINDOWS_ONLY)
    def test_failed_write_for_a_read_only_target_leaves_no_temp_file(self):
        """带 preserve 的写入把临时文件 chmod 成目标的权限位；目标只读时替换被拒后临时文件
        也只读，清理要先补回写权限，否则每次失败都留一个 .tmp。"""
        self.marker.write_bytes(b'{"old": true}\n')
        os.chmod(self.marker, stat.S_IREAD)
        self.addCleanup(os.chmod, self.marker, stat.S_IWRITE | stat.S_IREAD)
        preserve = self.marker.stat()
        with mock.patch.object(runtime_lock.os, "replace", side_effect=PermissionError(5, "denied")), \
                mock.patch.object(runtime_lock.time, "sleep"):
            with self.assertRaises(PermissionError):
                runtime_lock._write_marker(self.marker, {"new": True}, preserve)
        self.assertEqual(self.marker.read_bytes(), b'{"old": true}\n')
        self.assertEqual(self.temp_leftovers(), [])


class FileLockPaddingTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", WINDOWS_ONLY)
    def test_padding_write_refused_for_a_non_lock_reason_propagates(self):
        """补位字节只把「锁被占」的 EACCES/EAGAIN/EDEADLK 当 busy；其它错误（如磁盘满）原样上抛。"""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pad.lock"
            with mock.patch.object(runtime_lock.os, "write", side_effect=OSError(errno.ENOSPC, "no space")), \
                    mock.patch.object(runtime_lock.time, "sleep") as sleep:
                with self.assertRaises(OSError) as ctx:
                    with runtime_lock.file_lock(path, timeout=5.0):
                        self.fail("不得进入临界区")
            self.assertEqual(ctx.exception.errno, errno.ENOSPC)
            sleep.assert_not_called()


class RuntimeLockStdinTests(unittest.TestCase):
    """命令行入口的入站 JSON 按 UTF-8 严格解码（跨平台：用 PYTHONIOENCODING=gbk 钉出中文 Windows
    的管道，strict 与 surrogateescape 两种错误处理各跑一遍）。经 stdin 的调用方里只有
    --update-enhance-provider 的载荷可能含非 ASCII（模型名、密钥、地址这些自由落盘的字符串）：
    未钉 UTF-8 时或被读成乱码、或留下孤立代理项让保存失败，这次保存都丢失。一次性命令行没有
    读循环要保护：畸形字节直接以非零退出失败，不把替换字符写进配置。"""

    # 默认代码页下管道 stdin 是 gbk/surrogateescape；strict 是另一种错误处理。修复在位时入口的
    # reconfigure(encoding="utf-8") 会把 errors 归为 strict，两种 subTest 走同一条路径；未修时
    # 两者的表现不同（strict 下解码失败，surrogateescape 下留下孤立代理项让写入失败）。
    LEGACY_ERRORS = ("strict", "surrogateescape")

    @staticmethod
    def legacy_env(errors):
        """继承当前环境再覆盖编码相关变量（与兄弟 stdio 用例同款）：只留两三个变量的最小环境在
        依赖 LD_LIBRARY_PATH 之类变量才启动得了的 Python 构建上会拉不起子进程。"""
        env = {name: value for name, value in os.environ.items()
               if not name.startswith(("ZCODE_", "ZUSAGE_", "PYTHON"))
               and name.upper() not in ("HOME", "USERPROFILE")}
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env["PYTHONIOENCODING"] = "gbk:" + errors
        return env

    @staticmethod
    def seeded(runtime):
        config = runtime / "enhance-provider.json"
        config.write_text('{"version": 1, "revision": 0, "mode": "default"}', encoding="utf-8")
        if os.name != "nt":
            # POSIX 上 update_enhance_provider 要求文件是属主 0600；默认 umask 建出来的是 0644，
            # 不收紧的话非 ASCII 用例在 macOS/Linux 的常见 umask 下恒红（与 test_config_transactions
            # 同款夹具；畸形入站那条在解码阶段就失败，走不到权限检查）
            os.chmod(config, 0o600)
        return config

    def save(self, runtime, payload, errors):
        return subprocess.run(
            [sys.executable, "-B", str(ROOT / "runtime_lock.py"), "--update-enhance-provider", str(runtime)],
            input=payload, capture_output=True, env=self.legacy_env(errors), cwd=str(runtime), timeout=30)

    def test_update_enhance_provider_keeps_non_ascii_fields_under_legacy_stdio(self):
        for errors in self.LEGACY_ERRORS:
            with self.subTest(errors=errors), tempfile.TemporaryDirectory() as tmp:
                runtime = Path(tmp)
                config = self.seeded(runtime)
                model = "软件 模型"
                payload = json.dumps({"revision": 0, "changes": {"mode": "custom", "model": model}},
                                     ensure_ascii=False)
                process = self.save(runtime, payload.encode("utf-8"), errors)
                self.assertEqual(process.returncode, 0, process.stderr)
                self.assertEqual(json.loads(config.read_text(encoding="utf-8"))["model"], model)

    def test_malformed_stdin_json_fails_closed_without_writing(self):
        """字符串里的非法字节不许被替换后照常解析：那会把带 U+FFFD 的值写进配置。"""
        for errors in self.LEGACY_ERRORS:
            with self.subTest(errors=errors), tempfile.TemporaryDirectory() as tmp:
                runtime = Path(tmp)
                config = self.seeded(runtime)
                before = config.read_bytes()
                process = self.save(runtime, b'{"revision": 0, "changes": {"mode": "custom", "model": "\xff"}}',
                                    errors)
                self.assertNotEqual(process.returncode, 0)
                self.assertEqual(config.read_bytes(), before)


class PatchInstallPublishRetryTests(unittest.TestCase):
    """待替换包的 sidecar 发布同样走有界重试：Windows 上刚写完的文件常被杀毒 / 搜索索引的瞬时句柄
    占住，裸 os.replace 被拒一次就让整轮安装报「待替换包生成失败」。读者何时松手由替身决定。"""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="pending publish ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.pi = load_module("patch_install_publish_retry", ROOT / "patch_install.py")
        self.meta = self.root / "app.asar.zusage.tmp.json"
        patched = mock.patch.object(self.pi, "TMP_META", self.meta)
        patched.start()
        self.addCleanup(patched.stop)

    def _flaky(self, failures):
        real_replace, left = os.replace, {"n": failures}

        def replace(source, target):
            if left["n"]:
                left["n"] -= 1
                raise PermissionError(errno.EACCES, "另一个程序正在使用此文件", str(target), 32)
            return real_replace(source, target)
        return replace

    def _publish(self, failures):
        with mock.patch.object(self.pi.os, "replace", self._flaky(failures)), \
                mock.patch.object(runtime_lock.time, "sleep", lambda seconds: None):
            self.pi._atomic_tmp_metadata({"operation": "install"})

    def test_sidecar_publish_survives_transiently_open_targets(self):
        self._publish(3)
        self.assertEqual(json.loads(self.meta.read_text(encoding="utf-8")), {"operation": "install"})
        self.assertEqual([p.name for p in self.root.iterdir()], [self.meta.name], "临时文件不残留")

    def test_permanently_locked_target_still_raises_and_cleans_up(self):
        with self.assertRaises(PermissionError):
            self._publish(10 ** 6)
        self.assertEqual([p.name for p in self.root.iterdir()], [], "临时文件要清掉，目标没写成")

    def test_older_lock_module_without_the_helper_falls_back_to_a_plain_replace(self):
        # 运行目录里可能是热修保护下留下的旧版 runtime_lock：没有重试函数时退回裸 os.replace，
        # 不能让 patch_install 整个导入失败（待替换收尾、自检、卸载全断）
        helper = self.pi.runtime_lock._replace_retrying
        del self.pi.runtime_lock._replace_retrying
        self.addCleanup(setattr, self.pi.runtime_lock, "_replace_retrying", helper)
        self._publish(0)
        self.assertEqual(json.loads(self.meta.read_text(encoding="utf-8")), {"operation": "install"})


if __name__ == "__main__":
    unittest.main()
