# -*- coding: utf-8 -*-
"""scripts/check_all.py 的行为测试：输出解析、通配展开、退出码汇总，全部用替身，不起真实测试进程。

契约见 specs/dev-loop-speed.md：任一步失败即非零退出；--list 不起子进程。
"""
import contextlib
import io
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from helpers.py_test_support import load_module

ROOT = Path(__file__).resolve().parents[1]
check_all = load_module("check_all_under_test", ROOT / "scripts" / "check_all.py")

TAP = """TAP version 13
    ok 1 - first
    ok 2 - skipped one # SKIP
ok 1 - /r/tests/a.test.cjs
    ok 1 - passes
    not ok 2 - second fails
        ---
        duration_ms: 1
        ...
not ok 2 - /r/tests/b.test.cjs
    not ok 1 - crashed case
not ok 3 - /r/tests/c.test.cjs
not ok 4 - /r/tests/d.test.cjs
# tests 8
# suites 0
# pass 3
# fail 4
# skipped 1
# duration_ms 12
"""
UNITTEST = """..F.E
======================================================================
ERROR: test_err (tests.test_x.C.test_err)
----------------------------------------------------------------------
Traceback (most recent call last):
RuntimeError: boom

======================================================================
FAIL: test_bad (tests.test_x.C.test_bad)
----------------------------------------------------------------------
Traceback (most recent call last):
AssertionError

----------------------------------------------------------------------
Ran 10 tests in 0.010s

FAILED (failures=1, errors=1, skipped=2)
"""


def _proc(code, out="", err=""):
    return types.SimpleNamespace(returncode=code, stdout=out, stderr=err)


class _FakeProc:
    def __init__(self, code):
        self.code = code

    def wait(self):
        return self.code


def _fake_popen(outputs):
    """outputs: {"node-test": (退出码, 文本), "python-test": (退出码, 文本)}；记录被启动的套件。"""
    started = []

    def popen(cmd, cwd, stdout, stderr):
        key = "node-test" if "--test" in cmd else "python-test"
        code, text = outputs[key]
        stdout.write(text)
        stdout.flush()
        started.append(key)
        return _FakeProc(code)
    return popen, started


class CheckAllParseTests(unittest.TestCase):
    def test_tap_counts_and_inner_failure_names(self):
        # Node 自己报 fail 4（两个子用例、一个没有子用例的文件、一个父套件）；这里只数 3 个最具体的失败
        self.assertEqual(check_all.parse_tap(TAP),
                         (8, 3, 1, ["second fails", "crashed case", "/r/tests/d.test.cjs"]))

    def test_tap_falls_back_to_file_level_names(self):
        text = "not ok 1 - /r/tests/x.test.cjs\n# tests 1\n# fail 1\n"
        self.assertEqual(check_all.parse_tap(text), (1, 1, 0, ["/r/tests/x.test.cjs"]))

    def test_tap_deep_nesting_keeps_the_most_specific_name(self):
        # 真实 TAP 里子测试的结果行排在父套件之前
        text = ("        not ok 1 - the real case\n"
                "        1..1\n"
                "    not ok 1 - inner suite\n"
                "    1..1\n"
                "not ok 1 - /r/tests/y.test.cjs\n"
                "# tests 3\n# fail 3\n")
        self.assertEqual(check_all.parse_tap(text)[1:], (1, 0, ["the real case"]))

    def test_unittest_counts_and_failure_names(self):
        total, bad, skipped, names = check_all.parse_unittest(UNITTEST)
        self.assertEqual((total, bad, skipped), (10, 2, 2))
        self.assertEqual(names, ["ERROR: test_err (tests.test_x.C.test_err)", "FAIL: test_bad (tests.test_x.C.test_bad)"])

    def test_unittest_ok_with_skipped(self):
        text = "...\n----\nRan 3 tests in 0.001s\n\nOK (skipped=1)\n"
        self.assertEqual(check_all.parse_unittest(text), (3, 0, 1, []))

    def test_unittest_summary_found_even_when_a_child_process_trails_output(self):
        # 2026-11-26 实测：有用例的子进程在汇总行之后又写了 5000 多个字符，只看末尾会把跳过数读成 0
        text = "...\nRan 1531 tests in 68.2s\n\nOK (skipped=14)\n\n" + ("残留输出\n" * 900) + "完成。\n"
        self.assertEqual(check_all.parse_unittest(text), (1531, 0, 14, []))

    def test_unittest_crash_before_running_is_a_failure(self):
        text = "E\n=====\nERROR: setUpModule (tests.test_y)\n----\nRan 0 tests in 0.000s\n\nFAILED (errors=1)\n"
        self.assertEqual(check_all.parse_unittest(text), (0, 1, 0, ["ERROR: setUpModule (tests.test_y)"]))

    def test_node_test_files_are_sorted_and_script_expands_the_glob(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "tests").mkdir()
            for name in ("b.test.cjs", "a.test.cjs", "helper.cjs", "notes.txt"):
                (root / "tests" / name).write_text("// x\n", encoding="utf-8")
            self.assertEqual([Path(p).name for p in check_all.node_test_files(root)], ["a.test.cjs", "b.test.cjs"])
            with self.assertRaises(FileNotFoundError):
                check_all.node_test_files(root / "nope")

    def test_test_commands_carry_the_tap_reporter_and_the_current_interpreter(self):
        node, py = check_all.test_commands("node")
        self.assertIn("--test-reporter=tap", node[2])
        self.assertTrue(all(arg.endswith(".test.cjs") for arg in node[2][4:]), "通配在脚本里展开成具体文件")
        self.assertGreater(len(node[2]) - 4, 100, "应收集到仓库里的全部 Node 测试文件")
        self.assertEqual(py[2][:5], [check_all.sys.executable, "-B", "-m", "unittest", "discover"])


class CheckAllMainTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        patcher = mock.patch.object(check_all.tempfile, "mkdtemp", return_value=self._tmp.name)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _run(self, argv, quick_outputs=(), test_outputs=None):
        """quick_outputs：快检查各命令的 (退出码, 输出)，按调用顺序取；缺省全过。"""
        out = io.StringIO()
        queue = list(quick_outputs)
        calls = []

        def run(cmd, cwd, capture_output, encoding, errors):
            calls.append(cmd)
            code, text = queue.pop(0) if queue else (0, "")
            return _proc(code, text, "")

        popen, started = _fake_popen(test_outputs or {})
        with contextlib.redirect_stdout(out):
            code = check_all.main(list(argv), run=run, popen=popen)
        return code, out.getvalue(), calls, started

    def test_list_prints_commands_and_starts_nothing(self):
        def forbidden(*_args, **_kwargs):
            raise AssertionError("--list 不应起任何子进程")
        code, out, _, _ = self._run(["--list"])
        self.assertEqual(code, 0)
        lines = out.splitlines()
        self.assertEqual(sum(1 for line in lines if line.startswith("node --check ")), len(check_all.SYNTAX_TARGETS))
        self.assertEqual(sum(1 for line in lines if "--check" in line and "node" not in line), 4)
        self.assertEqual(sum(1 for line in lines if "--test-reporter=tap" in line), 1)
        self.assertEqual(sum(1 for line in lines if "unittest discover" in line), 1)

    def test_quick_failure_stops_and_exits_non_zero(self):
        code, out, calls, started = self._run(["--quick"], quick_outputs=[(0, ""), (1, "SyntaxError: boom\n")])
        self.assertEqual(code, 1)
        self.assertIn("[失败] node --check inject-main.cjs", out)
        self.assertIn("SyntaxError: boom", out)
        self.assertEqual(len(calls), 2, "第一条失败之后不再跑后面的快检查")
        self.assertEqual(started, [])

    def test_quick_pass_exits_zero_without_tests(self):
        code, out, _, started = self._run(["--quick"])
        self.assertEqual(code, 0)
        self.assertIn("[通过] 语法检查 6 项，构建与副本一致性 4 项", out)
        self.assertIn("全部通过", out)
        self.assertEqual(started, [])

    def test_green_suites_exit_zero_and_report_counts(self):
        outputs = {"node-test": (0, TAP.replace("not ok", "ok").replace("# fail 4", "# fail 0")),
                   "python-test": (0, "Ran 3 tests in 0.001s\n\nOK (skipped=1)\n")}
        code, out, _, started = self._run([], test_outputs=outputs)
        self.assertEqual(code, 0)
        self.assertEqual(started, ["node-test", "python-test"])
        self.assertIn("[通过] node --test：共 8，失败 0，跳过 1，退出码 0", out)
        self.assertIn("[通过] python -m unittest：共 3，失败 0，跳过 1，退出码 0", out)
        self.assertIn("全部通过", out)

    def test_failing_tests_exit_non_zero_and_name_the_cases(self):
        outputs = {"node-test": (1, TAP), "python-test": (1, UNITTEST)}
        code, out, _, _ = self._run([], test_outputs=outputs)
        self.assertEqual(code, 1)
        self.assertIn("[失败] node --test：共 8，失败 3，跳过 1，退出码 1", out)
        self.assertIn("    - second fails", out)
        self.assertIn("    - /r/tests/d.test.cjs", out)
        self.assertIn("[失败] python -m unittest：共 10，失败 2，跳过 2，退出码 1", out)
        self.assertIn("    - FAIL: test_bad (tests.test_x.C.test_bad)", out)
        self.assertIn("有失败", out)

    def test_non_zero_exit_without_parsed_failures_is_still_a_failure(self):
        outputs = {"node-test": (1, "some crash text\n"), "python-test": (0, "Ran 3 tests in 0.001s\n\nOK\n")}
        code, out, _, _ = self._run([], test_outputs=outputs)
        self.assertEqual(code, 1)
        self.assertIn("没有解析到失败用例", out)
        self.assertIn("some crash text", out)

    def test_failure_names_are_capped(self):
        names = "".join(f"    not ok {i} - case {i}\n" for i in range(check_all.MAX_FAILURE_NAMES + 5))
        text = names + "# tests 25\n# fail 25\n"
        code, out, _, _ = self._run([], test_outputs={"node-test": (1, text), "python-test": (0, "OK\n")})
        self.assertEqual(code, 1)
        self.assertEqual(out.count("    - case "), check_all.MAX_FAILURE_NAMES)
        self.assertIn(f"…另有 5 个", out)


if __name__ == "__main__":
    unittest.main()
