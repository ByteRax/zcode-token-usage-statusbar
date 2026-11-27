# -*- coding: utf-8 -*-
"""scripts/deploy_hot.py 的行为测试：全部在临时目录里用替身完成，不碰真实运行目录、不起取证进程。

契约见 specs/dev-loop-speed.md「选择性部署」：相同跳过、领先拒写、写前比对不一致就停、
语法检查失败运行文件不动且不留备份、只读目标判受阻、替换被拒有界重试后如实报告、--node 接进语法
预检、冷文件拒收、没有 --reason 不部署。
"""
import contextlib
import io
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from tests.helpers.py_test_support import load_module  # noqa: E402

deploy_hot = load_module("deploy_hot_under_test", ROOT / "scripts" / "deploy_hot.py")

BASE = b"console.log('base');\n"
NEW = b"console.log('new');\n"
FOREIGN = b"console.log('written by someone else');\n"
PAGE = "/Applications/ZCode.app/Contents/index.html"


def _ok_check(path, name, node="node"):
    return True, ""


def _write(root, name, data):
    (root / name).write_bytes(data)
    return root / name


class DeployHotPlanTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.work, self.run = Path(self._tmp.name) / "work", Path(self._tmp.name) / "run"
        self.work.mkdir()
        self.run.mkdir()

    def _plan(self, names, baselines):
        return {step["name"]: step["action"]
                for step in deploy_hot.make_plan(names, self.work, self.run, lambda name: baselines.get(name, []))}

    def test_same_deploy_protected_cold_missing(self):
        _write(self.work, "overlay.js", NEW)
        _write(self.run, "overlay.js", BASE)
        _write(self.work, "turn-stats.js", b"a\n")
        _write(self.run, "turn-stats.js", b"a\n")
        _write(self.work, "zusage.py", b"x = 1\n")
        _write(self.run, "zusage.py", FOREIGN)
        actions = self._plan(["overlay.js", "turn-stats.js", "zusage.py", "inject-main.cjs", "sysmon-client.cjs"],
                             {"overlay.js": [BASE], "zusage.py": [b"old base\n"]})
        self.assertEqual(actions, {"overlay.js": "deploy", "turn-stats.js": "same", "zusage.py": "protected",
                                   "inject-main.cjs": "cold", "sysmon-client.cjs": "missing"})

    def test_file_missing_in_runtime_is_a_deploy(self):
        _write(self.work, "sysmon-client.cjs", NEW)
        self.assertEqual(self._plan(["sysmon-client.cjs"], {})["sysmon-client.cjs"], "deploy")

    def test_runtime_matching_any_baseline_is_deployable(self):
        _write(self.work, "zusage.py", NEW)
        _write(self.run, "zusage.py", BASE)
        baselines = {"zusage.py": [None, b"unrelated\n", BASE]}
        self.assertEqual(self._plan(["zusage.py"], baselines)["zusage.py"], "deploy")

    def test_describe_names_the_blocked_reason(self):
        text = deploy_hot.describe({"name": "zusage.py", "action": "protected"})
        self.assertIn("受保护", text)
        self.assertIn("zusage.py", text)
        self.assertIn("冷文件", deploy_hot.describe({"name": "inject-main.cjs", "action": "cold"}))


class DeployHotInstallTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.run = Path(self._tmp.name)
        self.target = _write(self.run, "overlay.js", BASE)
        # 目标 mtime 设在「未来」：os.replace 的天然 mtime（现在）必然不大于它，
        # 只有 install_file 的「mtime 未前进就 utime 强推」守卫能让断言为真——
        # 变异审查（M6）证明设在过去时该守卫删掉测试照样绿（replace 天然拿到当前时间）。
        self.old_mtime = time.time() + 3600
        os.utime(self.target, (self.old_mtime, self.old_mtime))

    def _step(self, work=NEW, run=BASE, name="overlay.js"):
        return {"name": name, "action": "deploy", "work": work, "run": run}

    def _leftovers(self):
        return sorted(p.name for p in self.run.iterdir())

    def test_ok_deploys_backs_up_keeps_mode_and_advances_mtime(self):
        self.target.chmod(0o600)
        state, detail = deploy_hot.install_file(self._step(), self.run, "issue-1", "20261126-120000", _ok_check)
        self.assertEqual(state, "ok")
        self.assertIn(".pre-issue-1-20261126-120000-overlay.js", detail)
        self.assertEqual(self.target.read_bytes(), NEW)
        self.assertEqual((self.run / ".pre-issue-1-20261126-120000-overlay.js").read_bytes(), BASE)
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o600, "保留原权限位")
        else:
            # Windows 没有 POSIX 权限位（可写文件的 st_mode 恒为 0o666）；这里守的是「没有把文件变成只读」
            self.assertTrue(os.access(self.target, os.W_OK), "部署后运行文件必须可写")
        self.assertGreater(self.target.stat().st_mtime, self.old_mtime,
                           "mtime 必须前进（旧值在未来，只有守卫的 utime 强推能做到），热重载按它轮询")
        self.assertEqual(self._leftovers(), [".pre-issue-1-20261126-120000-overlay.js", "overlay.js"], "不留临时文件")

    def test_syntax_failure_leaves_the_runtime_file_untouched_and_no_backup(self):
        state, detail = deploy_hot.install_file(self._step(), self.run, "issue-1", "20261126-120000",
                                                lambda path, name, node="node": (False, "SyntaxError: boom"))
        self.assertEqual((state, detail), ("syntax", "SyntaxError: boom"))
        self.assertEqual(self.target.read_bytes(), BASE)
        self.assertEqual(self._leftovers(), ["overlay.js"], "失败的部署既不留临时文件，也不留备份")

    def test_locked_target_is_reported_and_keeps_the_file(self):
        def denied(source, target):
            raise PermissionError(5, "拒绝访问", str(target))
        with mock.patch.object(deploy_hot, "_replace_retrying", denied):
            state, detail = deploy_hot.install_file(self._step(), self.run, "issue-1", "20261126-120000", _ok_check)
        self.assertEqual(state, "locked")
        self.assertIn("被占用", detail)
        self.assertEqual(self.target.read_bytes(), BASE)
        self.assertEqual(self._leftovers(), ["overlay.js"], "替换被拒时备份和临时文件都要清掉")

    def _install_readonly(self):
        """在只读目标上部署。root 对只读文件仍有写权限（os.access 恒真），所以把可写判定替身成「只有它不可写」，
        让这条断言在 root 的 CI 容器里也照跑，而不是整例跳过。"""
        with mock.patch.object(deploy_hot.os, "access", lambda p, mode, t=str(self.target): str(p) != t):
            return deploy_hot.install_file(self._step(), self.run, "issue-1", "20261126-120000", _ok_check)

    def test_readonly_runtime_file_is_blocked_and_left_alone(self):
        self.target.chmod(0o444)
        self.addCleanup(self.target.chmod, 0o644)   # 只读文件会让临时目录清不掉
        state, detail = self._install_readonly()
        self.assertEqual(state, "readonly")
        self.assertEqual(self.target.read_bytes(), BASE)
        self.assertEqual(self._leftovers(), ["overlay.js"])

    def test_concurrent_rewrite_between_plan_and_write_stops_the_deploy(self):
        def racing_check(path, name, node="node"):
            _write(self.run, "overlay.js", FOREIGN)   # 甄别之后、写入之前，别处改写了运行文件
            return True, ""
        state, detail = deploy_hot.install_file(self._step(), self.run, "issue-1", "20261126-120000", racing_check)
        self.assertEqual(state, "race")
        self.assertEqual(self.target.read_bytes(), FOREIGN, "不覆盖别处刚写入的内容")
        self.assertFalse(any(name.startswith(".overlay.js.") for name in self._leftovers()))

    def test_a_rewrite_during_the_backup_stops_the_deploy(self):
        # 备份刚写完、目标就被别处改写：留下的备份不是甄别过的基线，不能拿它去换
        real_copy = shutil.copy2

        def copy_then_race(src, dst, *args, **kwargs):
            real_copy(src, dst, *args, **kwargs)
            _write(self.run, "overlay.js", FOREIGN)
        with mock.patch.object(deploy_hot.shutil, "copy2", copy_then_race):
            state, detail = deploy_hot.install_file(self._step(), self.run, "issue-1", "20261126-120000", _ok_check)
        self.assertEqual(state, "race")
        self.assertEqual(self.target.read_bytes(), FOREIGN)
        self.assertEqual(self._leftovers(), ["overlay.js"], "备份与临时文件都不留")

    def test_new_file_is_created_without_a_backup(self):
        state, detail = deploy_hot.install_file(self._step(work=b"x = 1\n", run=None, name="zusage.py"),
                                                self.run, "issue-1", "20261126-120000", _ok_check)
        self.assertEqual(state, "ok")
        self.assertIn("新建", detail)
        self.assertEqual((self.run / "zusage.py").read_bytes(), b"x = 1\n")

    def test_cold_file_is_never_in_a_deploy_step(self):
        self.assertIn("inject-main.cjs", deploy_hot.COLD_FILES)
        self.assertNotIn("inject-main.cjs", deploy_hot.HOT_FILES)

    @unittest.skipUnless(shutil.which("node"), "需要 node")
    def test_real_syntax_check(self):
        good = _write(self.run, "ok.js", b"console.log(1)\n")
        bad = _write(self.run, "bad.js", b"console.log(\n")
        broken = _write(self.run, "broken.py", b"def (:\n")
        self.assertEqual(deploy_hot.syntax_check(good, "ok.js")[0], True)
        self.assertEqual(deploy_hot.syntax_check(bad, "ok.js")[0], False)
        self.assertEqual(deploy_hot.syntax_check(broken, "broken.py")[0], False)
        self.assertEqual(deploy_hot.syntax_check(broken, "notes.txt"), (True, ""), "未知扩展名不检查")

    def test_missing_node_is_a_failed_check_not_a_crash(self):
        state = deploy_hot.syntax_check(self.run / "overlay.js", "overlay.js", node=str(self.run / "no-such-node"))
        self.assertEqual(state[0], False)
        self.assertIn("node --check 没跑成", state[1])


class DeployHotResidentPidsTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt" and Path(deploy_hot._WINDOWS_POWERSHELL).is_file(), "需要 Windows PowerShell")
    def test_windows_finds_the_serve_command_line(self):
        # 没有 pgrep 的平台按命令行筛进程：一个命令行里带「zusage.py serve」的假常驻进程必须被找到
        dummy = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", "zusage.py", "serve"],
                                 stdin=subprocess.DEVNULL, creationflags=deploy_hot._NO_WINDOW)
        try:
            self.assertIn(dummy.pid, deploy_hot.resident_pids())
        finally:
            dummy.kill()
            dummy.wait(timeout=10)


class DeployHotMainTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.work, self.run = Path(self._tmp.name) / "work", Path(self._tmp.name) / "run"
        self.work.mkdir()
        self.run.mkdir()
        self.work_patch = mock.patch.object(deploy_hot, "ROOT", self.work)
        self.work_patch.start()
        self.addCleanup(self.work_patch.stop)

    def _main(self, argv, evidence=None, pids=None, check=_ok_check, baselines=None, run_dir=None):
        out, err = io.StringIO(), io.StringIO()
        injected = {}
        if check is not None:
            injected["check"] = check   # check=None：用脚本自己的语法预检（核对 --node 是否接到了它上面）
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = deploy_hot.main(
                list(argv), run_dir=run_dir or self.run,
                baseline_of=lambda name: (baselines or {}).get(name, []),
                evidence=evidence or (lambda node, port: (False, "调试端口 9229 不可达")),
                pids=pids or (lambda: None), **injected)
        return code, out.getvalue()

    def test_node_flag_reaches_the_syntax_check(self):
        # --node 必须接到默认的语法预检上。Windows 开发机没有 node 时落到默认值，每个 .js/.cjs 都以
        # 「node --check 没跑成」失败，只有 .py 部署得了（2026-11-28 实测的混合态）
        _write(self.work, "quota-client.cjs", NEW)
        _write(self.run, "quota-client.cjs", BASE)
        seen = []

        def fake_run(cmd, **kwargs):
            seen.append((list(cmd), kwargs.get("env", {}).get("ELECTRON_RUN_AS_NODE")))
            return types.SimpleNamespace(returncode=0, stdout="", stderr="")
        with mock.patch.object(deploy_hot.subprocess, "run", fake_run):
            code, out = self._main(["--reason", "issue-1", "--wait", "0", "--node", "D:/ZCode/ZCode.exe"],
                                   check=None, baselines={"quota-client.cjs": [BASE]})
        self.assertEqual(code, 0, out)
        self.assertEqual([cmd[:2] for cmd, _ in seen], [["D:/ZCode/ZCode.exe", "--check"]])
        self.assertEqual(seen[0][1], "1", "宿主的 Electron 充当 Node 时必须自带 ELECTRON_RUN_AS_NODE=1")
        self.assertEqual((self.run / "quota-client.cjs").read_bytes(), NEW)

    def test_failed_module_is_not_reported_as_deployed(self):
        _write(self.work, "quota-client.cjs", b"console.log(\n")
        _write(self.run, "quota-client.cjs", BASE)
        broken = lambda path, name, node="node": (False, "SyntaxError: boom")   # noqa: E731
        code, out = self._main(["--reason", "issue-1", "--wait", "0"], check=broken,
                               baselines={"quota-client.cjs": [BASE]})
        self.assertEqual(code, 1)
        self.assertIn("失败    quota-client.cjs", out)
        self.assertNotIn("主进程模块", out, "没部署成功的模块不能报「已部署」")
        self.assertEqual((self.run / "quota-client.cjs").read_bytes(), BASE)
        self.assertEqual([p.name for p in self.run.iterdir()], ["quota-client.cjs"], "失败的部署不留备份和临时文件")

    def test_readonly_file_counts_as_blocked(self):
        _write(self.work, "overlay.js", NEW)
        target = _write(self.run, "overlay.js", BASE)
        target.chmod(0o444)
        self.addCleanup(target.chmod, 0o644)   # 只读文件会让临时目录清不掉
        # root 对只读文件仍有写权限：把可写判定替身成「只有它不可写」，断言在 CI 容器里也照跑
        with mock.patch.object(deploy_hot.os, "access", lambda p, mode, t=target: str(p) != str(t)):
            code, out = self._main(["--reason", "issue-1", "--wait", "0"], baselines={"overlay.js": [BASE]})
        self.assertEqual(code, 1)
        self.assertIn("受阻    overlay.js", out)
        self.assertIn("失败 0，受阻 1", out)
        self.assertEqual(target.read_bytes(), BASE)

    def test_unexpected_oserror_on_one_file_is_reported_not_raised(self):
        # 单个文件上的意外异常不该中断整批；它可能发生在替换之后（回读、改 mtime），所以不声称「运行文件未动」
        _write(self.work, "quota-client.cjs", NEW)
        _write(self.run, "quota-client.cjs", BASE)
        with mock.patch.object(deploy_hot, "install_file", side_effect=OSError("disk full")):
            code, out = self._main(["--reason", "issue-1", "--wait", "0"], baselines={"quota-client.cjs": [BASE]})
        self.assertEqual(code, 1)
        self.assertIn("失败    quota-client.cjs：disk full", out)
        self.assertNotIn("运行文件未动", out)
        self.assertIn("收尾：有未完成项（失败 1，受阻 0）", out)

    def test_dry_run_prints_the_plan_and_writes_nothing(self):
        _write(self.work, "overlay.js", NEW)
        _write(self.run, "overlay.js", BASE)
        code, out = self._main(["--dry-run"], baselines={"overlay.js": [BASE]})
        self.assertEqual(code, 0)
        self.assertIn("待部署  overlay.js", out)
        self.assertEqual(sorted(p.name for p in self.run.iterdir()), ["overlay.js"])
        self.assertEqual((self.run / "overlay.js").read_bytes(), BASE)

    def test_real_deploy_requires_a_reason(self):
        with self.assertRaises(SystemExit) as raised:
            self._main([])
        self.assertEqual(raised.exception.code, 2)

    def test_reason_with_spaces_is_rejected(self):
        with self.assertRaises(SystemExit):
            self._main(["--reason", "issue 483"])

    def test_files_outside_the_hot_list_are_rejected(self):
        with self.assertRaises(SystemExit):
            self._main(["--dry-run", "--files", "config.json"])

    def test_missing_runtime_dir_exits_two(self):
        code, _ = self._main(["--dry-run"], run_dir=self.run / "nope")
        self.assertEqual(code, 2)

    def test_deploy_with_generation_advance_is_verified(self):
        _write(self.work, "overlay.js", NEW)
        _write(self.run, "overlay.js", BASE)
        answers = [(True, [{"url": PAGE, "gen": 3, "version": "v1"}]), (True, [{"url": PAGE, "gen": 4, "version": "v2"}])]
        code, out = self._main(["--reason", "issue-1", "--wait", "0"], evidence=lambda n, p: answers.pop(0),
                               baselines={"overlay.js": [BASE]})
        self.assertEqual(code, 0)
        self.assertIn("已部署  overlay.js", out)
        self.assertIn("渲染端热重载：已验证", out)
        self.assertEqual((self.run / "overlay.js").read_bytes(), NEW)
        self.assertEqual(len(list(self.run.glob(".pre-issue-1-*-overlay.js"))), 1)

    def test_unreachable_debug_port_keeps_the_pending_wording(self):
        _write(self.work, "overlay.js", NEW)
        _write(self.run, "overlay.js", BASE)
        code, out = self._main(["--reason", "issue-1", "--wait", "0"], baselines={"overlay.js": [BASE]})
        self.assertEqual(code, 0)
        self.assertIn("无法取证", out)
        self.assertIn("已部署、待重注入验证", out)
        self.assertNotIn("已验证", out)

    def test_no_generation_advance_is_reported_as_pending(self):
        _write(self.work, "overlay.js", NEW)
        _write(self.run, "overlay.js", BASE)
        same = lambda n, p: (True, [{"url": PAGE, "gen": 7, "version": "v1"}])   # noqa: E731
        code, out = self._main(["--reason", "issue-1", "--wait", "0"], evidence=same, baselines={"overlay.js": [BASE]})
        self.assertEqual(code, 0, "部署本身成功，取证未得不算部署失败")
        self.assertIn("没有取到代际递增的证据", out)
        self.assertIn("已部署、待重注入验证", out)

    def test_protected_file_is_left_alone_and_fails_the_run(self):
        _write(self.work, "overlay.js", NEW)
        _write(self.run, "overlay.js", BASE)
        _write(self.work, "zusage.py", b"x = 1\n")
        _write(self.run, "zusage.py", FOREIGN)
        code, out = self._main(["--reason", "issue-1", "--wait", "0"], baselines={"overlay.js": [BASE]})
        self.assertEqual(code, 1)
        self.assertIn("受保护  zusage.py", out)
        self.assertEqual((self.run / "zusage.py").read_bytes(), FOREIGN)
        self.assertEqual((self.run / "overlay.js").read_bytes(), NEW, "不受阻的文件照常部署")

    def test_daemon_replacement_is_detected(self):
        _write(self.work, "zusage.py", NEW)
        _write(self.run, "zusage.py", BASE)
        pids = [{111}, {222}]
        code, out = self._main(["--reason", "issue-1", "--wait", "0"], pids=lambda: pids.pop(0),
                               baselines={"zusage.py": [BASE]})
        self.assertEqual(code, 0)
        self.assertIn("常驻 zusage 进程：已更替", out)

    def test_main_process_modules_are_reported_as_behaviour_check(self):
        _write(self.work, "quota-client.cjs", NEW)
        _write(self.run, "quota-client.cjs", BASE)
        code, out = self._main(["--reason", "issue-1", "--wait", "0"], baselines={"quota-client.cjs": [BASE]})
        self.assertEqual(code, 0)
        self.assertIn("主进程模块 quota-client.cjs：已部署", out)


class DeployHotResidentPidsOutputTests(unittest.TestCase):
    """Windows 分支的输出解析：真查询放在下面的真机用例里，这里用替身覆盖异常形态。"""

    def _pids(self, run_result):
        answer = types.SimpleNamespace(returncode=0, stdout="1234\nProgress 5\n", stderr="")

        def fake_run(*_args, **_kwargs):
            if isinstance(run_result, BaseException):
                raise run_result
            return run_result or answer
        with mock.patch.object(deploy_hot.os, "name", "nt"), \
                mock.patch.object(deploy_hot, "_WINDOWS_POWERSHELL", __file__), \
                mock.patch.object(deploy_hot.subprocess, "run", fake_run):
            return deploy_hot.resident_pids()

    def test_only_numeric_tokens_become_pids(self):
        # PowerShell 夹带的进度行之类不能让取证抛异常（此前 int() 直接 ValueError 穿出 main）
        self.assertEqual(self._pids(None), {1234})

    def test_a_failed_query_is_unknown_not_empty(self):
        # 空集会被 main 当成「常驻进程已更替」：查询失败必须返回 None（无法判定）
        failed = types.SimpleNamespace(returncode=1, stdout="", stderr="boom")
        self.assertIsNone(self._pids(failed))
        self.assertIsNone(self._pids(OSError("PowerShell did not start")))


class DeployHotCliTests(unittest.TestCase):
    def test_cli_survives_a_non_utf8_pipe(self):
        # Windows 非 CJK 代码页的管道上，中文报错会让脚本以 traceback 收场：接管道时编不了的字符转义
        env = {key: os.environ[key] for key in ("PATH", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP") if key in os.environ}
        env.update(PYTHONIOENCODING="cp1252", PYTHONDONTWRITEBYTECODE="1")
        proc = subprocess.run([sys.executable, "-B", str(ROOT / "scripts" / "deploy_hot.py"), "--dry-run",
                               "--runtime", str(ROOT / "no-such-runtime-dir")], cwd=str(ROOT), env=env,
                              stdin=subprocess.DEVNULL, capture_output=True, timeout=60,
                              creationflags=deploy_hot._NO_WINDOW)
        err = proc.stderr.decode("utf-8", "replace")
        self.assertEqual(proc.returncode, 2, err)
        self.assertNotIn("Traceback", err)


if __name__ == "__main__":
    unittest.main()
