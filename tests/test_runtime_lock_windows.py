# -*- coding: utf-8 -*-
"""runtime_lock 在 Windows 上的两处竞争面（msvcrt 字节锁、无 FILE_SHARE_DELETE 的读者）。

1. file_lock 先给空锁文件补 1 个字节再锁首字节。两个进程同时首次创建同一锁文件时，
   后到者在先到者写入之前看到大小 0，随后的补写撞上对方刚锁定的首字节（EACCES）。
   这只是「锁被占」的另一种形态，必须走 busy（FileLockBusy，调用方按锁竞争退避），
   不能以 PermissionError 穿出、被当成权限问题报成 skipped-error。
2. 标记文件的替换与删除遇到并发读者会被拒绝（Python 的 open 不带 FILE_SHARE_DELETE）。
   读者都是短开，短暂重试即可成功；静默放弃会丢掉重启待办，回滚失败还会留下一条
   永不销账的 pending-install 意图；销账末尾的删除被拒则会留下一个已销账的标记。带
   preserve 的写入遇上只读目标时，只读的临时文件要先补回写权限才删得掉。

读者句柄用 CreateFileW 以 FILE_SHARE_READ 持有；共享模式按句柄生效，同进程的另一
句柄同样受拒，所以不必起子进程。「读者何时松手」由替身 sleep 决定，不依赖真实时序。

另有一条不限于 Windows 的入站用例也放在这里（同属 runtime_lock 的 stdio 面）：
3. 命令行入口的入站 JSON（--record-restart 的载荷带 installation.asar，安装路径可含
   非 ASCII）按 UTF-8 解码。主进程与更新器按 JSON.stringify 写 stdin、spawn 时不注入
   编码变量，中文 Windows 的管道默认按区域代码页解码，路径被解成乱码。
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
    """命令行入口的入站 JSON 按 UTF-8 解码（跨平台：用 PYTHONIOENCODING=gbk:strict 钉出中文
    Windows 的管道）。未钉 UTF-8 时 UTF-8 的「软件」被按 GBK 读成乱码，标记里记下的安装路径
    不再是真实路径。"""

    def test_record_restart_keeps_non_ascii_installation_path_under_legacy_stdio(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = Path(tmp)
            asar = str(runtime / "软件" / "ZCode" / "resources" / "app.asar")
            payload = json.dumps({"state": "pending-install",
                                  "installation": {"asar": asar, "entryHash": "abc"}},
                                 ensure_ascii=False)
            env = {name: os.environ[name] for name in ("SystemRoot", "COMSPEC", "PATHEXT")
                   if name in os.environ}
            env.update(PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="gbk:strict")
            process = subprocess.run(
                [sys.executable, "-B", str(ROOT / "runtime_lock.py"), "--record-restart", str(runtime)],
                input=payload.encode("utf-8"), capture_output=True, env=env, cwd=str(runtime), timeout=30)
            self.assertEqual(process.returncode, 0, process.stderr)
            marker = runtime_lock._read_marker(runtime / ".plugin-restart-required")
            self.assertEqual(marker["installation"]["asar"], asar)


if __name__ == "__main__":
    unittest.main()
