# -*- coding: utf-8 -*-
"""scripts/deploy_hot.py 的行为测试：全部在临时目录里用替身完成，不碰真实运行目录、不起取证进程。

契约见 specs/dev-loop-speed.md「选择性部署」：相同跳过、领先拒写、写前比对不一致就停、
语法检查失败运行文件不动、冷文件拒收、没有 --reason 不部署。
"""
import contextlib
import io
import os
import shutil
import stat
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from helpers.py_test_support import load_module

ROOT = Path(__file__).resolve().parents[1]
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
        past = time.time() - 3600
        self.past = past
        os.utime(self.target, (past, past))

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
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o600, "保留原权限位")
        self.assertGreater(self.target.stat().st_mtime, self.past, "mtime 必须前进，热重载按它轮询")
        self.assertEqual(self._leftovers(), [".pre-issue-1-20261126-120000-overlay.js", "overlay.js"], "不留临时文件")

    def test_syntax_failure_leaves_the_runtime_file_untouched(self):
        state, detail = deploy_hot.install_file(self._step(), self.run, "issue-1", "20261126-120000",
                                                lambda path, name, node="node": (False, "SyntaxError: boom"))
        self.assertEqual((state, detail), ("syntax", "SyntaxError: boom"))
        self.assertEqual(self.target.read_bytes(), BASE)
        self.assertNotIn(".overlay.js.", " ".join(self._leftovers()), "失败的临时文件要清掉")

    def test_concurrent_rewrite_between_plan_and_write_stops_the_deploy(self):
        def racing_check(path, name, node="node"):
            _write(self.run, "overlay.js", FOREIGN)   # 甄别之后、写入之前，别处改写了运行文件
            return True, ""
        state, detail = deploy_hot.install_file(self._step(), self.run, "issue-1", "20261126-120000", racing_check)
        self.assertEqual(state, "race")
        self.assertEqual(self.target.read_bytes(), FOREIGN, "不覆盖别处刚写入的内容")
        self.assertFalse(any(name.startswith(".overlay.js.") for name in self._leftovers()))

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
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = deploy_hot.main(
                list(argv), run_dir=run_dir or self.run,
                baseline_of=lambda name: (baselines or {}).get(name, []),
                check=check,
                evidence=evidence or (lambda node, port: (False, "调试端口 9229 不可达")),
                pids=pids or (lambda: None))
        return code, out.getvalue()

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


if __name__ == "__main__":
    unittest.main()
