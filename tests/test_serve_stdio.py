# -*- coding: utf-8 -*-
"""zusage.py serve 的入站编码契约：真子进程读一行非 ASCII 的请求。

serve 是主桥拉起的常驻查询进程，请求行由主进程按 JSON.stringify 写入（非 ASCII 原样
上线）。它原本只给 stdout 做了 reconfigure，stdin 按进程默认编码解码；主桥与
mobile-relay.cjs spawn 它时不注入 PYTHONIOENCODING / PYTHONUTF8（WorkBuddy 的
wb-overlay.cjs 注入了），中文 Windows 的管道 stdin 默认是区域代码页（GBK）——远端分栏的
workspaceIdentity 含非 ASCII 时被解成乱码，_remote_fetch 查不到已配置的目标，分栏恒
remote_missing。

进程内的 serve 用例用 StringIO 顶替 stdin，咬不到这一层。这里起真子进程，并用
LEGACY_STDIN 把管道钉成 GBK：UTF-8 环境的机器同样只靠真跑咬不到。默认的区域代码页
解码带 surrogateescape（畸形字节不抛错），`:strict` 是额外钉上的，让畸形请求在未修代码上
必崩、咬合不依赖机器。

脚本拷到临时目录跑：serve 启动即按 TTL 拉新价表，临时目录里的 config.json 关掉
联网，回归不出网；HOME 也指向临时目录，读不到真实配置与用量库。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
# zusage 的同目录依赖（缺 usage_stats 走降级分支，缺 token_pricing 整特性降级）
RUNTIME = ("zusage.py", "usage_stats.py", "token_pricing.py")
NO_WINDOW = 0x08000000 if os.name == "nt" else 0
LEGACY_STDIN = {"PYTHONIOENCODING": "gbk:strict"}
IDENTITY = "remote:ssh:u@h:/home/用户/项目"


def isolated_env(home):
    """剥掉宿主、插件与 Python 自己的环境变量，HOME 指向临时目录，禁写字节码。"""
    env = {name: value for name, value in os.environ.items()
           if not name.startswith(("ZCODE_", "ZUSAGE_", "PYTHON"))
           and name.upper() not in ("HOME", "USERPROFILE")}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["HOME"] = env["USERPROFILE"] = str(home)
    return env


def request_bytes(identity):
    return (json.dumps({"sids": ["session_serve_1"],
                        "scopes": [{"sid": "session_serve_1", "workspaceIdentity": identity}]},
                       ensure_ascii=False) + "\n").encode("utf-8")


class ServeStdinTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="zusage-serve-stdio-"))
        self.addCleanup(shutil.rmtree, str(self.root), True)
        for name in RUNTIME:
            shutil.copy2(REPO / name, self.root / name)
        (self.root / "config.json").write_text('{"pricing": {"fetch": false}}', encoding="utf-8")
        self.home = self.root / "home"
        self.home.mkdir()

    def serve(self, env, raw):
        proc = subprocess.Popen(
            [sys.executable, "-B", str(self.root / "zusage.py"), "serve"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=env, cwd=str(self.root), creationflags=NO_WINDOW)
        try:
            out, err = proc.communicate(raw, timeout=60)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            raise
        self.assertEqual(proc.returncode, 0, err[-400:])
        self.assertEqual(out.count(b"\n"), 1, "一个请求一行快照")
        return json.loads(out.decode("utf-8"))

    @staticmethod
    def scoped_row(payload):
        return next(row for row in payload["recent"] if row.get("workspace_identity"))

    def test_non_ascii_workspace_identity_survives_legacy_stdio_encoding(self):
        env = isolated_env(self.home)
        env.update(LEGACY_STDIN)
        row = self.scoped_row(self.serve(env, request_bytes(IDENTITY)))
        self.assertEqual(row["workspace_identity"], IDENTITY)
        # 本用例没有配置任何远端目标：命中的是「目标未配置」这个作用域存根，不是「已配置但
        # 查询失败」——后者同样置 remote_missing，只看它没有区分力。
        self.assertEqual(row["remote_target"], "")
        self.assertEqual(row["remote_error"], "remote target not configured")
        self.assertTrue(row["remote_missing"])

    def test_malformed_utf8_request_is_replaced_not_fatal(self):
        """畸形字节按 U+FFFD 替换后照常回一帧快照，读循环不被击穿（errors="replace"）。"""
        env = isolated_env(self.home)
        env.update(LEGACY_STDIN)
        raw = request_bytes("remote:ssh:u@h:/home/__BAD__/x").replace(b"__BAD__", b"\xff\xfe")
        row = self.scoped_row(self.serve(env, raw))
        self.assertEqual(row["workspace_identity"], "remote:ssh:u@h:/home/\ufffd\ufffd/x")

    def test_identity_round_trips_under_utf8_mode(self):
        """对照组：解释器处于 UTF-8 模式时入站本来就正确，出站链路本身没有问题。"""
        env = isolated_env(self.home)
        env["PYTHONUTF8"] = "1"
        row = self.scoped_row(self.serve(env, request_bytes(IDENTITY)))
        self.assertEqual(row["workspace_identity"], IDENTITY)


if __name__ == "__main__":
    unittest.main()
