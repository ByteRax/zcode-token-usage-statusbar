# -*- coding: utf-8 -*-
"""安装链命令行的管道输出编码契约（Windows 默认代码页）。

`plugins/zcode-token-usage-statusbar/overlay_install.py`（check / doctor / install / sync）与
`patch_install.py`（check / install / remove）都往 stdout 打中文。Windows 上 stdout 接管道时默认按
区域代码页编码：cp1252 的机器上一句中文 print 就 UnicodeEncodeError 中断（`/install-overlay`、
doctor、check 全断），cp936 的机器上运行目录含 GBK 外字符（emoji 等）时路径回显同样崩；
plugin-updater 读 `overlay_install.py sync` 的 JSON 也是按 UTF-8 解码。两个脚本入口在 `__main__`
把 stdout / stderr 钉成 UTF-8（与 usage_mcp.py、hooks 同款防护）。

真子进程 + `PYTHONIOENCODING=cp1252`：任何平台都把管道钉成 cp1252，未修代码必崩，不靠 Windows
默认代码页才咬得到。修好后输出必须能按 UTF-8 严格解码、是中文原文（不是 `\\uXXXX` 转义），退出码
与子命令语义一致。HOME、运行目录、asar 全部指向临时目录；子进程环境只保留启动必需项——宿主设了
`ZCODE_ASAR` 会指向真客户端，不透传。输出按字节读取再解码，父进程自己的区域代码页不参与。
"""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PLUGIN = REPO / "plugins" / "zcode-token-usage-statusbar"
NO_WINDOW = 0x08000000 if os.name == "nt" else 0
# 进程启动与临时目录定位要用的变量；其余（ZCODE_*、PYTHONUTF8、PYTHONIOENCODING 等）一律不透传
KEEP_ENV = ("PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP")

if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from tests.helpers.py_test_support import make_asar  # noqa: E402


def is_zcode_package():
    return {"name": "@zcode/desktop", "version": "0.0.0", "type": "module"}


class CliStdioUtf8Tests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="cli stdio ")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.home = self.root / "home"
        self.runtime = self.root / "runtime"
        self.asar = self.root / "client" / "resources" / "app.asar"
        self.home.mkdir()
        self.runtime.mkdir()
        make_asar(self.asar, entry=b"console.log('official v1');\n", package=is_zcode_package())

    def run_cli(self, script, *args, io_encoding="cp1252", runtime=None):
        env = {key: os.environ[key] for key in KEEP_ENV if key in os.environ}
        env.update({"HOME": str(self.home), "USERPROFILE": str(self.home),
                    "ZUSAGE_PLUGIN_RUNTIME": str(runtime or self.runtime), "ZUSAGE_PLUGIN_ASAR": str(self.asar),
                    "PYTHONIOENCODING": io_encoding, "PYTHONDONTWRITEBYTECODE": "1"})
        proc = subprocess.run([sys.executable, "-B", str(script), *args], cwd=str(self.home), env=env,
                              stdin=subprocess.DEVNULL, capture_output=True, timeout=60,
                              creationflags=NO_WINDOW)
        # 严格解码：子进程若仍按区域代码页写，中文会在这里变成解码错误
        return (proc.returncode, proc.stdout.decode("utf-8"), proc.stderr.decode("utf-8"))

    def test_overlay_check_prints_chinese_verbatim_on_cp1252_pipe(self):
        code, out, err = self.run_cli(PLUGIN / "overlay_install.py", "check")
        self.assertEqual(code, 0, err)
        self.assertIn("injected: 否", out)
        self.assertIn("未注入", out)
        self.assertNotIn("Traceback", err)
        self.assertNotIn("\\u", out, "中文被转义成 \\uXXXX 说明输出流没钉 UTF-8")

    def test_overlay_doctor_prints_chinese_verbatim_on_cp1252_pipe(self):
        code, out, err = self.run_cli(PLUGIN / "overlay_install.py", "doctor")
        self.assertEqual(code, 0, err)
        self.assertTrue(out.strip(), "体检报告应写到 stdout")
        self.assertNotIn("Traceback", err)
        self.assertNotIn("\\u", out)

    def test_patch_install_check_prints_chinese_verbatim_on_cp1252_pipe(self):
        code, out, err = self.run_cli(REPO / "patch_install.py", "check",
                                      "--asar", str(self.asar), "--runtime", str(self.runtime))
        self.assertEqual(code, 0, err)
        self.assertIn("未注入", out)
        self.assertNotIn("Traceback", err)
        self.assertNotIn("\\u", out)

    def test_runtime_path_outside_gbk_survives_gbk_pipe(self):
        # 中文 Windows 的默认代码页是 GBK：家目录或运行目录里有 GBK 外的字符（emoji 等）时，
        # check 回显路径的那一行会崩——比 cp1252 管道更贴近中文用户的真实环境
        runtime = self.root / "运行目录😀"
        runtime.mkdir()
        if "😀" not in str(runtime.resolve()):
            self.skipTest("文件系统不保留路径里的 emoji 字节")
        code, out, err = self.run_cli(PLUGIN / "overlay_install.py", "check", io_encoding="gbk", runtime=runtime)
        self.assertEqual(code, 0, err)
        self.assertIn("runtime:", out)
        self.assertIn("运行目录😀", out)


if __name__ == "__main__":
    unittest.main()
