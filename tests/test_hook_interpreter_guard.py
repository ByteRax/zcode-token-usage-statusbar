# -*- coding: utf-8 -*-
"""hook 解释器版本门回归（issue #454，规格 specs/hook-interpreter-guard.md）。

hooks.json 的 python3 → python → py -3 回退链只认退出码：PATH 里的低版本 python 一旦跑通
脚本并以 0 退出，后面的候选永远轮不到。入口用例在子进程里伪装解释器版本（不依赖本机装了
哪个 Python），链路用例拿 hooks.json 的原命令串配临时假解释器复现报告机形态。
HOME、运行时全部指向临时夹具，hook 主体依赖全部换成桩，不碰真机。
"""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest

PLUGIN = Path(__file__).resolve().parents[1] / "plugins" / "zcode-token-usage-statusbar"
EVENT = {"session-start.py": "SessionStart", "prompt-submit.py": "UserPromptSubmit"}
PAYLOAD = '{"hook_event_name": "SessionStart", "source": "startup"}'
GUARD_EXIT = 9   # 非 0（链在此终止）非 2（宿主语义=阻断）
HINT = "Python 3.7 is too old"
OLD = ("3.7.0", "fail")       # 报告机形态：低版本，且 3.8+ API 缺失
MINIMUM = ("3.8.0", "ok")     # 下限本身：必须放行

# 解释器桩：argv = [被测脚本, 伪装的版本号, run_hook 是否模拟 3.8+ API 缺失]。
# "fail" 复现报告机的真实失败（3.7 没有 Path.unlink(missing_ok=)）——未被版本门拦下时，
# 入口兜底会把它吞成「自检失败（已忽略）」并以 0 退出，回退链就此终止。
INTERPRETER_STUB = """\
import runpy
import sys
import types

sys.version_info = tuple(int(part) for part in sys.argv[2].split(".")) + ("final", 0)


def stub(name, **attrs):
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules[name] = module
    return module


stub("zusage", AGENT_ZCODE="zcode", detect_agent=lambda: "zcode")
stub("token_rate", write_session_state=lambda *args: None, query_latest=lambda *args: None,
     format_line=lambda *args: None)


def run_hook():
    if sys.argv[3] == "fail":
        raise TypeError("unlink() got an unexpected keyword argument 'missing_ok'")
    return {"suppressOutput": True}


stub("overlay_install", run_hook=run_hook, _atomic_write=lambda *args: None)
runpy.run_path(sys.argv[1], run_name="__main__")
"""

# Python 二进制按真实路径调用：PATH 里不留任何真解释器，pyenv shim 之类也不依赖。
PYTHON = os.path.realpath(sys.executable)


class IsolatedHookTestCase(unittest.TestCase):
    """临时 HOME/运行时与解释器桩；环境变量不继承宿主（ZCODE_ASAR 等会真拉起宿主）。"""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / "home"
        self.runtime = self.root / "runtime"
        self.home.mkdir()
        self.runtime.mkdir()
        self.interpreter_stub = self.root / "interpreter_stub.py"
        self.interpreter_stub.write_text(INTERPRETER_STUB, encoding="utf-8")

    def environment(self, **extra):
        environment = {"HOME": str(self.home), "USERPROFILE": str(self.home),
                       "ZUSAGE_PLUGIN_RUNTIME": str(self.runtime),
                       "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1"}
        for name in ("SystemRoot", "TEMP", "TMP"):
            if name in os.environ:
                environment[name] = os.environ[name]
        environment.update(extra)
        return environment

    def run_hook(self, script, version, mode):
        return subprocess.run(
            [PYTHON, "-B", str(self.interpreter_stub), str(PLUGIN / "hooks" / script), version, mode],
            input=PAYLOAD, capture_output=True, text=True, env=self.environment(),
            cwd=str(self.home), timeout=30)


class EntryGuardTests(IsolatedHookTestCase):
    def test_old_interpreter_exits_with_guard_code_before_any_output(self):
        for script in EVENT:
            with self.subTest(script=script):
                process = self.run_hook(script, *OLD)
                self.assertEqual(process.returncode, GUARD_EXIT, process.stdout + process.stderr)
                self.assertEqual(process.stdout, "")
                self.assertIn(HINT, process.stderr)
                self.assertIn("3.8", process.stderr)
                self.assertEqual(list(self.runtime.iterdir()), [])

    def test_minimum_supported_version_is_not_rejected(self):
        # 下限本身必须放行：阈值被收紧成 (3, 9) 时，3.8 用户会无声丢掉两条 hook。
        for script in EVENT:
            with self.subTest(script=script):
                process = self.run_hook(script, *MINIMUM)
                self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
                self.assertNotIn("too old", process.stderr)
                self.assertTrue(process.stdout.strip(), "hook 主体没有运行")


@unittest.skipIf(os.name == "nt", "假解释器是 sh 脚本；Windows 由 cmd.exe 执行同一 || 命令串，"
                                "退出码语义由上面的跨平台入口用例守住")
class FallbackChainTests(IsolatedHookTestCase):
    def setUp(self):
        super().setUp()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.seen = self.root / "seen"
        # python3 缺失（报告机形态）；python = 旧解释器。
        self.write_old_interpreter("python")
        # py -3 = 达标候选：只记录「被调用」与收到的 stdin（主体行为由既有回归覆盖）。
        # PATH 里只有假解释器，外部命令一律写绝对路径。
        self.write_executable("py", ["#!/bin/sh", "shift", "/bin/cat > " + shlex.quote(str(self.seen))])

    def write_executable(self, name, lines):
        path = self.bin / name
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        path.chmod(0o755)

    def write_old_interpreter(self, name, prelude=()):
        """名为 name 的命令 = 旧解释器桩；prelude 是吃掉自身参数所需的 shell 语句。"""
        self.write_executable(name, ["#!/bin/sh", *prelude, "exec {} -B {} \"$@\" {}".format(
            shlex.quote(PYTHON), shlex.quote(str(self.interpreter_stub)), " ".join(OLD))])

    def run_chain(self, script):
        hooks = json.loads((PLUGIN / "hooks" / "hooks.json").read_text(encoding="utf-8"))["hooks"]
        command = hooks[EVENT[script]][0]["hooks"][0]["command"]
        return subprocess.run(
            ["/bin/sh", "-c", command], input=PAYLOAD, capture_output=True, text=True,
            env=self.environment(PATH=str(self.bin), ZCODE_PLUGIN_ROOT=str(PLUGIN)),
            cwd=str(self.home), timeout=30)

    def test_old_python_yields_to_next_candidate_and_keeps_stdin(self):
        for script in EVENT:
            with self.subTest(script=script):
                process = self.run_chain(script)
                self.assertTrue(self.seen.is_file(),
                                "旧解释器没有让位，py -3 未被调用\n" + process.stdout + process.stderr)
                self.assertEqual(process.returncode, 0, process.stderr)
                # 旧候选在读 stdin 之前退出：达标候选拿到的 hook 入参必须原样。
                self.assertEqual(self.seen.read_text(encoding="utf-8"), PAYLOAD)
                self.assertNotIn("自检失败", process.stdout)
                self.assertIn(HINT, process.stderr)

    def test_chain_tail_keeps_guard_exit_code_when_no_candidate_qualifies(self):
        # 本机只有旧 Python：py -3 存在但同样不达标。
        self.write_old_interpreter("py", ["shift"])
        for script in EVENT:
            with self.subTest(script=script):
                process = self.run_chain(script)
                # 链尾必须仍是守卫的退出码：宿主据此按单 hook 失败 fail-open 并带出提示。
                self.assertEqual(process.returncode, GUARD_EXIT, process.stdout + process.stderr)
                self.assertEqual(process.stdout, "")
                self.assertIn(HINT, process.stderr)


if __name__ == "__main__":
    unittest.main()
