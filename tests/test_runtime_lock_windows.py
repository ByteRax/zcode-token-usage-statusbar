# -*- coding: utf-8 -*-
"""runtime_lock 在 Windows 上的两处竞争面（msvcrt 字节锁、无 FILE_SHARE_DELETE 的读者）。

1. file_lock 先给空锁文件补 1 个字节再锁首字节。两个进程同时首次创建同一锁文件时，
   后到者在先到者写入之前看到大小 0，随后的补写撞上对方刚锁定的首字节（EACCES）。
   这只是「锁被占」的另一种形态，必须走 busy（FileLockBusy，调用方按锁竞争退避），
   不能以 PermissionError 穿出、被当成权限问题报成 skipped-error。
2. 标记文件的替换与删除遇到并发读者会被拒绝（Python 的 open 不带 FILE_SHARE_DELETE）。
   读者都是短开，短暂重试即可成功；静默放弃会丢掉重启待办，回滚失败还会留下一条
   永不销账的 pending-install 意图。

读者句柄用 CreateFileW 以 FILE_SHARE_READ 持有；共享模式按句柄生效，同进程的另一
句柄同样受拒，所以不必起子进程。「读者何时松手」由替身 sleep 决定，不依赖真实时序。
"""
import contextlib
import ctypes
import os
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
        self.assertGreater(len(waits), 1, "读者短开时应当重试，而不是第一次被拒就放弃")
        self.assertLess(len(waits), 100, "重试必须有界")
        self.assertEqual(self.marker.read_bytes(), before)
        self.assertEqual(self.leftovers(), [])


if __name__ == "__main__":
    unittest.main()
