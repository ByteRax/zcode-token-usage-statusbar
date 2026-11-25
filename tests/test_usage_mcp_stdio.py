# -*- coding: utf-8 -*-
"""usage_mcp.py 的 stdio 启动契约：真子进程走一遍 initialize / tools/list。

插件 .mcp.json 由宿主预置的 zcode-python 直接拉起 usage_mcp.py，中间不再有启动器
（issue #486 / PR #487）。守「帧尾 LF、stdout 不含 CR」的端到端用例原先住在已删除的
tests/mcp-launch.test.cjs 里；那条契约属于 usage_mcp.py 自身，这里不经启动器继续守。

Windows 文本模式默认把 \\n 翻成 \\r\\n，宿主按行分帧，帧尾必须保持 LF。POSIX 的文本模式
不翻译，只靠真跑永远咬不到：TEXT_MODE 给子进程换上一个开着 \\n→\\r\\n 翻译的文本
stdout（与 Windows 文本模式同一个后果），再由脚本自己的 reconfigure(newline="\\n")
收尾——把那一行改坏，任何平台都会红。

入站是同一个后果的另一面：宿主按 UTF-8 写帧，而宿主只给工具 shell 与 hooks 的执行环境
注入 PYTHONUTF8，MCP 子进程拿不到这层注入，中文 Windows 的管道 stdin 默认按区域代码页
（GBK）解码——「项目」被读成「椤圭洰」，workspace:<中文关键词> 落到「未找到」分支，而
列出的现有工作区里就有那个目录。UTF-8 环境的机器同样只靠真跑咬不到：LEGACY_STDIN 给
子进程钉一个传统代码页，再由脚本自己的 reconfigure(encoding="utf-8") 收尾。

入口与依赖拷到临时运行目录（带自己的 config.json）再拉起：zusage 的 CONFIG_PATH 就是
脚本目录的 config.json，`--dev` 布局的检出根上若有一份带 hosts.zcode.db_path 的配置，
查库用例会读真实库、启动自愈会读到真实的 asar_path。HOME 也指向临时目录。用量库只碰
这里现建的临时库。
"""
import json
import os
import queue
import shutil
import sqlite3
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
# usage_mcp 的同目录依赖（zusage → usage_stats / token_pricing）；拷进临时运行目录再拉起
RUNTIME = ("usage_mcp.py", "zusage.py", "usage_stats.py", "token_pricing.py")
# 中文 Windows 上管道 stdin 按区域代码页（GBK）解码；这里再钉 `:strict`，让畸形字节在未修
# 代码上必崩、咬合不依赖机器。宿主只给工具 shell 与 hooks 注入 PYTHONUTF8，脚本不自己钉
# UTF-8 就按它解码入站帧。stdout/stderr 随后由脚本的 reconfigure 接管。
LEGACY_STDIN = {"PYTHONIOENCODING": "gbk:strict"}
# render_workspace 走到的最小表集（列集与 test_project_usage 的夹具同款）。
USAGE_SCHEMA = """
create table session (id text primary key, title text, parent_id text, project_id text,
  directory text, time_created integer, summary_additions integer, summary_deletions integer,
  summary_files integer);
create table model_usage (id text primary key, session_id text, turn_id text, query_source text,
  agent text, provider_id text, model_id text, status text, started_at integer, first_token_at integer,
  completed_at integer, duration_ms integer, time_to_first_token_ms integer, input_tokens integer,
  output_tokens integer, reasoning_tokens integer, cache_read_input_tokens integer,
  cache_creation_input_tokens integer, computed_total_tokens integer, tool_call_count integer,
  retry_count integer, context_exceeded integer);
create table turn_usage (session_id text, turn_id text, status text, model_request_count integer,
  model_retry_count integer, tool_call_count integer, tool_error_count integer, input_tokens integer,
  output_tokens integer, reasoning_tokens integer, cache_read_input_tokens integer,
  cache_creation_input_tokens integer, computed_total_tokens integer, duration_ms integer,
  time_to_first_token_ms integer);
create table tool_usage (session_id text, tool_name text, status text, duration_ms integer);
"""


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

    def __init__(self, argv, home, env=None):
        self.proc = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=child_env(home) if env is None else env, cwd=str(home), creationflags=NO_WINDOW)
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
        # 宿主侧是 JSON.stringify：非 ASCII 原样上线，不转义成 \uXXXX。
        self.proc.stdin.write((json.dumps(frame, ensure_ascii=False) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def send_raw(self, data):
        """按字节直写：畸形帧不经 json.dumps。"""
        self.proc.stdin.write(data)
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
        self.runtime = self.home / "runtime"
        self.runtime.mkdir()
        for name in RUNTIME:
            shutil.copy2(REPO / name, self.runtime / name)
        (self.runtime / "config.json").write_text('{"pricing": {"fetch": false}}', encoding="utf-8")
        self.server = self.runtime / "usage_mcp.py"

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

    def open_session(self, env=None):
        """完成 initialize 握手的真子进程会话；env 给 None 即 child_env(home)。"""
        session = Session([sys.executable, "-B", str(self.server)], self.home, env=env)
        self.addCleanup(session.stop)
        session.send(jsonrpc="2.0", id=1, method="initialize", params={
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "stdio-test", "version": "0"}})
        session.response(1)
        session.send(jsonrpc="2.0", method="notifications/initialized")
        return session

    def test_non_ascii_scope_survives_legacy_stdio_encoding(self):
        """入站帧按区域代码页解码时「项目」被读成「椤圭洰」，workspace:<中文关键词> 落到
        「未找到」分支——而它列出的现有工作区里就有那个目录。"""
        db = self.home / "db.sqlite"
        directory = str(self.home / "我的项目")
        con = sqlite3.connect(str(db))
        try:
            con.executescript(USAGE_SCHEMA)
            con.execute("insert into session (id, title, parent_id, project_id, directory, time_created)"
                        " values ('session_ws_1', 't', NULL, 'proj_ws', ?, 100)", (directory,))
            con.commit()
        finally:
            con.close()
        env = child_env(self.home)
        env.update(LEGACY_STDIN)
        env["ZCODE_SESSION_DB_PATH"] = str(db)
        session = self.open_session(env)
        session.send(jsonrpc="2.0", id=2, method="tools/call",
                     params={"name": "token_usage", "arguments": {"scope": "workspace:项目"}})
        result = session.response(2)["result"]
        self.assertEqual(session.close(), 0)
        self.assertFalse(result["isError"])
        text = result["content"][0]["text"]
        # 命中分支以标题行起头；未命中分支列出的是「现有工作区」，目录同样出现在正文里。
        self.assertRegex(text, r"\A■ (?:工作区|Workspace) ")
        self.assertIn(directory, text)

    def test_malformed_utf8_frame_is_replaced_not_fatal(self):
        """畸形字节替换成 U+FFFD 后按未知工具名回错；读循环不被击穿，后续请求照常答复。"""
        env = child_env(self.home)
        env.update(LEGACY_STDIN)
        session = self.open_session(env)
        session.send_raw(b'{"jsonrpc":"2.0","id":2,"method":"tools/call",'
                         b'"params":{"name":"\xff\xfe","arguments":{}}}\n')
        frame = session.response(2)
        self.assertEqual(frame["error"]["code"], -32602)
        self.assertIn("unknown tool", frame["error"]["message"])
        session.send(jsonrpc="2.0", id=3, method="ping", params={})
        self.assertEqual(session.response(3)["result"], {})
        self.assertEqual(session.close(), 0)

    def test_script_boots_under_current_interpreter(self):
        self.check([sys.executable, "-B", str(self.server)])

    def test_frames_stay_lf_when_stdout_translates_newlines(self):
        self.check([sys.executable, "-B", "-c", TEXT_MODE, str(self.server)])

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
