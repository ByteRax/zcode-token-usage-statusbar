# -*- coding: utf-8 -*-
"""README 安装文案的实跑冒烟（macOS，联网）：在隔离的临时环境里按文案写明的命令装一遍并逐步计时。

宿主不提供单独的 zcode 命令，也不给代理任何「怎么装插件」的指引，README 的安装文案因此必须自包含。
本脚本把文案里的命令原样跑一遍：先证明隔离成立（真实 HOME 与仓库不可读，临时目录外不可写），
再执行「添加市场 → 安装插件 → 运行安装器」，最后核对插件登记与状态条注入。状态条注入打到临时
目录里的假归档上（经 ZCODE_ASAR 指给安装器），不触碰真实客户端。不调用模型、不读取任何凭据。

用法：python3 -B tests/install-prompt-smoke.py [github|gitcode]
"""
import json
import os
import shlex
import signal
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

EXECUTABLE = Path("/Applications/ZCode.app/Contents/MacOS/ZCode")
BUNDLE = Path("/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs")
SANDBOX = Path("/usr/bin/sandbox-exec")
REPOSITORY = Path(__file__).resolve().parents[1]
PLUGIN = "zcode-token-usage-statusbar"
PLUGIN_ID = PLUGIN + "@zusage-marketplace"
# 与 README 安装文案逐字一致（tests/test_install_prompt_contract.py 锁定）
CHANNELS = {
    "github": "https://github.com/ByteRax/zcode-token-usage-statusbar#plugin-releases",
    "gitcode": "https://gitcode.com/tanranran/zcode-token-usage-statusbar.git#plugin-releases-gitcode",
}
ADD_COMMAND = 'plugins marketplace add "%s" --json'
INSTALL_COMMAND = 'plugins install "%s" --scope user --json' % PLUGIN_ID
OVERLAY_COMMAND = 'python3 "%s/overlay_install.py" install'
TIMEOUT = 300


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def write_fake_asar(path):
    """微型合法 asar：包身份是 ZCode 桌面端，安装器会把它当成客户端。"""
    files = {"package.json": json.dumps({"name": "@zcode/desktop", "version": "0.0.0",
                                         "type": "module"}).encode(),
             "out/main/index.js": b"console.log('fake ZCode desktop entry');\n"}
    header, payload = {"files": {}}, bytearray()
    for name, data in files.items():
        parent = header
        parts = [part for part in name.split("/") if part]
        for part in parts[:-1]:
            parent = parent["files"].setdefault(part, {"files": {}})
        parent["files"][parts[-1]] = {"offset": str(len(payload)), "size": len(data)}
        payload.extend(data)
    raw = json.dumps(header, separators=(",", ":")).encode()
    aligned = (len(raw) + 7) // 4 * 4
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack("<4I", 4, aligned + 4, aligned, len(raw)) + raw +
                     b"\0" * (aligned - len(raw) - 4) + payload)


class FreshMachine:
    """临时目录里的「全新机器」：独立 HOME，只能写临时目录，真实 HOME、仓库与任何 asar 不可读。"""

    def __init__(self, parent):
        self.root = parent / "machine"
        self.home = self.root / "home"
        self.cwd = self.root / "cwd"
        for directory in (self.home, self.cwd, self.root / "tmp"):
            directory.mkdir(parents=True)
        self.asar = self.root / "client" / "resources" / "app.asar"
        write_fake_asar(self.asar)
        self.real_home = Path.home().resolve()
        require(self.inside(self.root), "临时目录不能位于真实 HOME 或仓库内")
        self.env = {
            "HOME": str(self.home), "USERPROFILE": str(self.home), "ELECTRON_RUN_AS_NODE": "1",
            "ZCODE_STORAGE_DIR": str(self.home / ".zcode"), "ZCODE_DATA_BASE_DIR": str(self.home),
            "ZCODE_SESSION_DB_PATH": str(self.home / ".zcode" / "cli" / "db" / "db.sqlite"),
            "ZCODE_LOG_DIR": str(self.home / ".zcode" / "cli" / "log"),
            "ZCODE_ASAR": str(self.asar), "TMPDIR": str(self.root / "tmp"),
            # 安装器用当前这个解释器跑（系统 python3 可能是没有命令行工具的存根）
            "PATH": "%s:/usr/bin:/bin:/usr/sbin:/sbin" % shlex.quote(os.path.dirname(sys.executable)),
            "LANG": "zh_CN.UTF-8", "PYTHONDONTWRITEBYTECODE": "1",
        }
        quote = json.dumps
        self.profile = "\n".join([
            "(version 1)",
            "(allow default)",
            "(deny file-write*)",
            '(allow file-write* (subpath %s) (literal "/dev/null"))' % quote(str(self.root)),
            "(deny file-read* (subpath %s) (subpath %s))" % (quote(str(self.real_home)), quote(str(REPOSITORY))),
            '(deny file-read* (regex #"\\.asar($|/)"))',
            "(allow file-read* (literal %s))" % quote(str(self.asar)),
        ])

    def inside(self, value):
        path = Path(value)
        try:
            path.resolve().relative_to(self.root)
            return True
        except (ValueError, OSError, RuntimeError):
            return False

    def run(self, argv, timeout=TIMEOUT):
        command = [str(SANDBOX), "-p", self.profile, *map(str, argv)]
        started = time.time()
        with subprocess.Popen(command, cwd=self.cwd, env=self.env, stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                              start_new_session=True) as process:
            try:
                stdout, stderr = process.communicate(timeout=timeout)
            except BaseException:
                # 超时/中断：先清理整组子进程，之后 TemporaryDirectory 才删除状态。
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
                raise
        return process.returncode, round(time.time() - started, 2), stdout, stderr

    def isolate(self):
        """先证明隔离成立，再执行任何会联网、写盘的命令。探针不接管道，免得退出码被末端命令顶掉。"""
        real = shlex.quote(str(self.real_home))
        probes = (
            ("write real home", "touch %s/.zusage-smoke-probe" % real, False),
            ("write client", "touch /Applications/ZCode.app/.zusage-smoke-probe", False),
            ("write client archive", "touch /Applications/ZCode.app/Contents/Resources/app.asar", False),
            ("read real home", "ls %s" % real, False),
            ("read repository", "ls %s" % shlex.quote(str(REPOSITORY)), False),
            ("write sandbox", "touch %s/ok" % shlex.quote(str(self.root / "tmp")), True),
        )
        for label, script, expected in probes:
            code, _, _, error = self.run(["/bin/sh", "-c", script], timeout=30)
            require((code == 0) is expected, "隔离不成立（%s）：exit=%s %s" % (label, code, error.strip()[:160]))

    def audit(self):
        """登记里的任何路径都必须落在临时目录里：沙箱外的位置根本写不进去，这里再核一遍。"""
        for name in ("installed_plugins.json", "known_marketplaces.json"):
            path = self.home / ".zcode" / "cli" / "plugins" / name
            if not path.exists():
                continue
            data = json.loads(path.read_text(encoding="utf-8"))
            for row in data.get("plugins", data.get("marketplaces", [])):
                for key in ("installPath", "cachePath", "path"):
                    if row.get(key):
                        require(self.inside(row[key]), "登记路径越过临时目录: " + str(row[key]))


def install_as_documented(machine, variant):
    """按 README 文案的三步执行，返回逐步耗时。命令经 shlex.split 原样变成参数，不经 shell 二次解释。"""
    steps = {}
    for label, command in (("marketplace add", ADD_COMMAND % CHANNELS[variant]), ("plugin install", INSTALL_COMMAND)):
        code, seconds, stdout, stderr = machine.run([EXECUTABLE, BUNDLE, *shlex.split(command)])
        steps[label] = seconds
        require(code == 0, "%s 失败（exit=%s）：%s%s" % (label, code, stdout.strip()[-300:], stderr.strip()[-300:]))
        if label == "plugin install":
            installed = json.loads(stdout)["installed"]
            require(len(installed) == 1 and installed[0].get("id") == PLUGIN_ID, "安装记录不是本插件: " + stdout[-300:])
            install_path = Path(installed[0]["installPath"])
    code, seconds, stdout, stderr = machine.run(shlex.split(OVERLAY_COMMAND % str(install_path)))
    steps["overlay install"] = seconds
    require(code == 0, "安装器失败（exit=%s）：%s%s" % (code, stdout.strip()[-400:], stderr.strip()[-400:]))
    require(b"inject-main.cjs" in machine.asar.read_bytes(), "状态条没有注入到假归档")
    require((machine.home / ".zcode" / PLUGIN).is_dir(), "运行目录没有创建")
    require("完全退出" in stdout, "安装器没有给出完全退出的重启提醒")
    return dict(steps, variant=variant, version=installed[0].get("version"))


def main(argv=None):
    require(sys.platform == "darwin" and SANDBOX.is_file() and EXECUTABLE.is_file() and BUNDLE.is_file(),
            "仅支持带系统 sandbox-exec 的 macOS 与默认位置安装的 /Applications/ZCode.app；不进行无沙箱回退")
    variant = (argv or ["github"])[0]
    require(variant in CHANNELS, "unknown variant: " + variant)
    with tempfile.TemporaryDirectory(prefix="zusage-install-smoke-") as temporary:
        machine = FreshMachine(Path(temporary).resolve())
        machine.isolate()
        result = install_as_documented(machine, variant)
        machine.audit()
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
