# -*- coding: utf-8 -*-
"""pending_zip_patch（macOS pending 更新包清理自愈）回归。

历史：本模块曾按「方案 B」在 Squirrel 取包前改写 pending zip 内 app.asar（issue #298
定案该设计结构性不可行——electron-updater 6.8.10 + autoInstallOnAppQuit=false 下，
Squirrel 经 MacUpdater 本地代理按下载完成时固化的官方 Content-Length 拉流，改写后的
zip 总大小必然偏离该长度，拉包被截断/失配即静默失败，restage 缓存命中反复复现）。
现行为反转为清理：只删除本插件曾改写且仍在 pending 的 zip（宿主按缓存失效重新下载
官方字节），绝不改写任何 zip，update-info.json 恒不读不写。

覆盖：sha256 对账删除、官方重下保留只清账本、无记录/他运行目录记录不动、
zip 缺失清账本、删除失败报 1、摘要中并发改写放弃（锚点复核）、旧版工作目录与
候选残留清扫、平台守卫、幂等。
全程临时目录，不触碰真实 pending 缓存。
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
import zipfile
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))


class PendingZipUndoTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        self.pending = self.root / "pending"
        self.pending.mkdir()
        self.zip_path = self.pending / "ZCode-3.18.0-mac-arm64.zip"
        spec = importlib.util.spec_from_file_location(
            "pending_zip_patch_test", ROOT / "pending_zip_patch.py")
        self.pzp = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.pzp)
        output = contextlib.redirect_stdout(io.StringIO())
        output.__enter__()
        self.addCleanup(output.__exit__, None, None, None)

    def build_zip(self, payload=b"official-zip-bytes"):
        with zipfile.ZipFile(self.zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("ZCode.app/Contents/Resources/app.asar", payload)
        return self.zip_path

    def write_update_info(self, file_name=None):
        (self.pending / "update-info.json").write_text(json.dumps(
            {"fileName": file_name if file_name is not None else self.zip_path.name,
             "sha512": "official-sha512", "isAdminRightsRequired": False}), encoding="utf-8")

    def record(self, name=None, sha256=None, runtime=None):
        """写一份旧版预注入留下的账本条目（字段与旧版 save_state 相同）。sha 默认值
        用独立 hashlib 计算，不用被测实现的 sha256_of——摘要函数自身损坏时夹具不能
        跟着错（否则对账测试对「坏摘要」自洽全绿）。"""
        state_path = self.runtime / "pending-zip-patch.json"
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            state = {"version": 1, "files": {}}
        if not isinstance(state.get("files"), dict):
            state["files"] = {}
        if sha256 is None:
            sha256 = (hashlib.sha256(self.zip_path.read_bytes()).hexdigest()
                      if self.zip_path.exists() else "0" * 64)
        state["files"][name if name is not None else self.zip_path.name] = {
            "sha256": sha256,
            "patchedAt": int(time.time()),
            "asarVersion": "3.18.0",
            "runtime": str(self.runtime.absolute()) if runtime is None else runtime,
        }
        state_path.write_text(json.dumps(state), encoding="utf-8")

    def read_records(self):
        try:
            state = json.loads((self.runtime / "pending-zip-patch.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return state.get("files") if isinstance(state.get("files"), dict) else {}

    def run_undo(self):
        return self.pzp.undo_zip(self.zip_path, self.runtime)

    def test_undo_removes_patched_zip_and_forgets_record(self):
        self.build_zip()
        self.write_update_info()
        self.record()
        self.assertEqual(self.run_undo(), 0)
        self.assertFalse(self.zip_path.exists(), "改写坏包必须删除：宿主按缓存失效重新下载官方字节")
        self.assertEqual(self.read_records(), {}, "删除后账本条目一并清掉")
        # update-info.json 恒不动：宿主重下与缓存有效性的判定依据
        self.assertEqual(json.loads((self.pending / "update-info.json").read_text())["sha512"],
                         "official-sha512")

    def test_undo_keeps_redownloaded_official_bytes(self):
        # 账本 sha 与当前字节不符：宿主已重下官方包，只清账本绝不动文件
        self.build_zip(b"official-redownloaded-bytes")
        self.record(sha256="0" * 64)
        self.write_update_info()
        self.assertEqual(self.run_undo(), 0)
        self.assertTrue(self.zip_path.exists())
        with zipfile.ZipFile(self.zip_path) as zf:
            self.assertEqual(zf.read("ZCode.app/Contents/Resources/app.asar"),
                             b"official-redownloaded-bytes")
        self.assertEqual(self.read_records(), {})
        # mismatch 分支同样不许碰 update-info.json（宿主缓存有效性判据恒不动）
        self.assertEqual(json.loads((self.pending / "update-info.json").read_text())["sha512"],
                         "official-sha512")

    def test_undo_without_record_leaves_zip_alone(self):
        self.build_zip()
        self.write_update_info()
        self.assertEqual(self.run_undo(), 0)
        self.assertTrue(self.zip_path.exists())
        self.assertEqual(self.read_records(), {})
        # 没有账本记录的 zip（含官方字节）永远不动，即使旁边躺着可读的 update-info.json
        self.assertTrue((self.pending / "update-info.json").exists())

    def test_undo_ignores_other_runtime_record(self):
        self.build_zip()
        self.record(runtime=str(self.root / "another-runtime"))
        self.assertEqual(self.run_undo(), 0)
        self.assertTrue(self.zip_path.exists())
        self.assertEqual(len(self.read_records()), 1, "他运行目录名下的记录不动")

    def test_undo_missing_zip_clears_record(self):
        self.record()
        self.assertEqual(self.run_undo(), 0)
        self.assertEqual(self.read_records(), {})

    def test_undo_clears_corrupt_record_entry(self):
        # sha256 缺失的坏条目会被 load_state 滤成「无记录」：zip 不动，但条目必须清掉，
        # 否则 Node 候选只看键名会对它 60s 空转 spawn
        self.build_zip()
        self.record(sha256=None)
        # record() 在 zip 存在时按内容算 sha，这里直接改写成缺字段条目
        state_path = self.runtime / "pending-zip-patch.json"
        state = json.loads(state_path.read_text(encoding="utf-8"))
        state["files"][self.zip_path.name].pop("sha256")
        state_path.write_text(json.dumps(state), encoding="utf-8")
        self.assertEqual(self.run_undo(), 0)
        self.assertTrue(self.zip_path.exists())
        self.assertEqual(self.read_records(), {}, "坏条目清账后 Node 候选不再空转")

    def test_undo_is_idempotent(self):
        self.build_zip()
        self.record()
        self.assertEqual(self.run_undo(), 0)
        self.assertEqual(self.run_undo(), 0)
        self.assertFalse(self.zip_path.exists())

    def test_undo_sweeps_legacy_workdir_and_candidate_tmp(self):
        # 旧版改写链的残留：硬杀没走 finally 的工作目录与同目录候选临时文件
        stale = self.pending / ".zusage-pendingzip-abc"
        stale.mkdir()
        stale.joinpath("staged.asar").write_bytes(b"x")
        old = time.time() - 7200
        os.utime(stale, (old, old))
        fresh = self.pending / ".zusage-pendingzip-fresh"
        fresh.mkdir()
        os.utime(fresh, (time.time(), time.time()))
        tmp = self.pending / (".zusage-zip-" + self.zip_path.name + ".tmp")
        tmp.write_bytes(b"partial")
        self.build_zip()
        self.record()
        self.assertEqual(self.run_undo(), 0)
        self.assertFalse(stale.exists(), "超龄工作目录清扫")
        self.assertTrue(fresh.exists(), "刚创建的工作目录不动")
        self.assertFalse(tmp.exists(), "旧版候选临时文件残留清扫")

    def test_undo_survives_corrupt_state_file(self):
        # 账本损坏按未记录处理：绝不动 zip
        self.build_zip()
        (self.runtime / "pending-zip-patch.json").write_text("not-json", encoding="utf-8")
        self.assertEqual(self.run_undo(), 0)
        self.assertTrue(self.zip_path.exists())

    def test_undo_unlink_failure_reports_one(self):
        # 删除失败必须报 1：Node 端按退出码计退避，谎报 0 会静默放弃重试（坏包永存）
        self.build_zip()
        self.record()
        self.skipIfWriteProtectedRoot()
        mode = self.pending.stat().st_mode
        self.pending.chmod(0o555)   # unlink 权限检查看父目录：目录只读即 EACCES
        self.addCleanup(self.pending.chmod, mode)   # 允许 TemporaryDirectory 清理
        self.assertEqual(self.run_undo(), 1)
        self.assertTrue(self.zip_path.exists(), "删除失败时坏包原地保留，等下一轮触发")
        self.assertEqual(len(self.read_records()), 1, "删除失败不清账本（下次重试仍要认领）")

    def skipIfWriteProtectedRoot(self):
        if os.name == "nt":
            self.skipTest("Windows 对只读位不敏感，无法注入 unlink 失败")
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            self.skipTest("root 不受只读位限制，无法注入 unlink 失败")

    def test_undo_aborts_when_file_changes_during_hashing(self):
        # 锚点复核：摘要算的是旧字节、文件被并发改写（宿主重下中）时本轮必须放弃，
        # 绝不能拿旧摘要的对账结论去删新落盘的文件
        self.build_zip()
        self.record()
        real_sha = self.pzp.sha256_of

        def sha_then_concurrent_rewrite(path):
            digest = real_sha(path)
            self.build_zip(b"host-redownloaded-mid-hash")   # 换内容=换 size/mtime_ns（截断写 inode 不变）
            return digest

        with mock.patch.object(self.pzp, "sha256_of", side_effect=sha_then_concurrent_rewrite):
            self.assertEqual(self.run_undo(), 1)
        self.assertTrue(self.zip_path.exists(), "并发改写后绝不删除新落盘的文件")
        self.assertEqual(len(self.read_records()), 1, "放弃时账本原地保留，下轮按新字节对账")

    def test_main_platform_guard(self):
        self.build_zip()
        self.record()
        original = self.zip_path.read_bytes()
        with mock.patch.object(self.pzp.sys, "platform", "win32"), \
                mock.patch.object(self.pzp, "undo_zip",
                                  side_effect=AssertionError("win32 must not touch pending")) as guard:
            self.assertEqual(self.pzp.main(["--zip", str(self.zip_path),
                                            "--runtime", str(self.runtime)]), 0)
        guard.assert_not_called()
        self.assertEqual(self.zip_path.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
