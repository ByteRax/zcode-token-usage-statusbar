# -*- coding: utf-8 -*-
"""usage_mcp.py 的 stdio 启动契约：真子进程走一遍 initialize / tools/list。

插件 .mcp.json 由宿主预置的 zcode-python 直接拉起 usage_mcp.py，中间不再有启动器
（issue #486 / PR #487）。守「帧尾 LF、stdout 不含 CR」的端到端用例原先住在已删除的
tests/mcp-launch.test.cjs 里；那条契约属于 usage_mcp.py 自身，这里不经启动器继续守。

Windows 文本模式默认把 \\n 翻成 \\r\\n，宿主按行分帧，帧尾必须保持 LF。POSIX 的文本模式
不翻译，只靠真跑永远咬不到：TEXT_MODE 给子进程换上一个开着 \\n→\\r\\n 翻译的文本
stdout（与 Windows 文本模式同一个后果），再由脚本自己的 reconfigure(newline="\\n")
收尾——把那一行改坏，任何平台都会红。

HOME 指向临时目录：启动时的待收尾包自愈与浮层拉起读不到真实配置。只发 initialize 与
tools/list，不碰用量库。
"""
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PLUGIN = REPO / "plugins" / "zcode-token-usage-statusbar"
SERVER = "zusage"
NO_WINDOW = 0x08000000 if os.name == "nt" else 0
TEXT_MODE = """\
import runpy, sys
sys.stdout = open(sys.stdout.fileno(), "w", encoding="utf-8", newline="\\r\\n", closefd=False)
runpy.run_path(sys.argv[1], run_name="__main__")
"""
# 只有 ZCode 3.19.0 起且预置工具已下载完成的宿主，才给它拉起的子进程注入这个入口。
HOST_PYTHON = shutil.which("zcode-python")


def child_env(home):
    """剥掉宿主、插件与 Python 自己的环境变量（ZCODE_ASAR 会让启动自愈真去动宿主），
    HOME 指向临时目录，禁写字节码：不在仓库或插件目录留下 __pycache__。"""
    env = {name: value for name, value in os.environ.items()
           if not name.startswith(("ZCODE_", "ZUSAGE_", "PYTHON"))
           and name.upper() not in ("HOME", "USERPROFILE")}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["HOME"] = env["USERPROFILE"] = str(home)
    return env


class Session:
    """一行一个 JSON 对象的 stdio 会话：后台线程收 stdout，按 id 取响应。"""

    def __init__(self, argv, home):
        self.proc = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=child_env(home), cwd=str(home), creationflags=NO_WINDOW)
        self.raw = bytearray()
        self.errors = []
        self.lines = queue.Queue()
        self.readers = [
            threading.Thread(target=self._read_stdout, daemon=True),
            threading.Thread(target=self._read, args=(self.proc.stderr, self.errors.append),
                             daemon=True),
        ]
        for reader in self.readers:
            reader.start()

    def stop(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        self.drain()
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            stream.close()

    @staticmethod
    def _read(stream, sink):
        for line in iter(stream.readline, b""):
            sink(line)

    def _read_stdout(self):
        for line in iter(self.proc.stdout.readline, b""):
            self.raw.extend(line)
            self.lines.put(line)
        self.lines.put(None)   # EOF：server 已退出

    def send(self, **frame):
        self.proc.stdin.write((json.dumps(frame) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def response(self, req_id, timeout=20):
        """等到指定 id 的响应；stdout 上路过的每一行都必须是 JSON 对象。"""
        deadline = time.monotonic() + timeout
        try:
            while True:
                line = self.lines.get(timeout=max(deadline - time.monotonic(), 0.01))
                if line is None:
                    raise AssertionError(
                        "server 在答复 id=%r 前退出；stderr=%r"
                        % (req_id, b"".join(self.errors)[-400:]))
                frame = json.loads(line)
                if frame.get("id") == req_id:
                    return frame
        except queue.Empty:
            raise AssertionError(
                "等待 id=%r 超时；stdout=%r" % (req_id, bytes(self.raw)[-400:]))

    def drain(self):
        """server 退出后管道写端随之关闭，读取线程自然到 EOF。"""
        for reader in self.readers:
            reader.join(timeout=10)

    def close(self):
        """关 stdin，等 server 退出与两路输出读尽，返回退出码。"""
        try:
            self.proc.stdin.close()
        except OSError:
            pass   # server 已死；退出码由下面的 wait 判定
        try:
            code = self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            raise AssertionError("关掉 stdin 后 server 没有退出；stderr=%r"
                                 % b"".join(self.errors)[-400:])
        self.drain()
        return code


class UsageMcpStdioTests(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="usage-mcp-stdio-"))
        self.addCleanup(shutil.rmtree, str(self.home), True)

    def check(self, argv):
        session = Session(argv, self.home)
        self.addCleanup(session.stop)
        session.send(jsonrpc="2.0", id=1, method="initialize", params={
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "stdio-test", "version": "0"}})
        hello = session.response(1)
        session.send(jsonrpc="2.0", method="notifications/initialized")   # 通知不回响应
        session.send(jsonrpc="2.0", id=2, method="tools/list", params={})
        tools = [tool["name"] for tool in session.response(2)["result"]["tools"]]
        code = session.close()
        raw = bytes(session.raw)
        self.assertEqual(hello["result"]["protocolVersion"], "2024-11-05")
        self.assertEqual(hello["result"]["serverInfo"]["name"], "zcode-token-usage")
        self.assertEqual(tools, ["token_usage"])
        self.assertEqual(code, 0)
        self.assertEqual(raw.count(b"\n"), 2, "stdout 只应有两帧响应")
        self.assertTrue(raw.endswith(b"\n"), "最后一帧必须以 LF 收尾")
        self.assertNotIn(b"\r", raw, "stdout 不允许出现 CR 字节（Windows 换行翻译回归）")

    def test_script_boots_under_current_interpreter(self):
        self.check([sys.executable, "-B", str(REPO / "usage_mcp.py")])

    def test_frames_stay_lf_when_stdout_translates_newlines(self):
        self.check([sys.executable, "-B", "-c", TEXT_MODE, str(REPO / "usage_mcp.py")])

    @unittest.skipUnless(
        HOST_PYTHON, "PATH 上解析不到 zcode-python："
        "只有 ZCode 3.19.0 起且预置工具已下载完成的宿主才注入该入口")
    def test_declared_command_boots_via_host_python(self):
        """按插件 .mcp.json 的原命令串真拉起；环境依赖用例，不是守卫——守卫是上面
        两条加 tests/test_plugin_contract.py 的契约断言。"""
        server = json.loads(
            (PLUGIN / ".mcp.json").read_text(encoding="utf-8"))["mcpServers"][SERVER]
        argv = [server["command"]] + [arg.replace("${ZCODE_PLUGIN_ROOT}", str(PLUGIN))
                                      for arg in server["args"]]
        self.check(argv)


if __name__ == "__main__":
    unittest.main()
