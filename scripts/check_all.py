#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一键检查：语法检查、构建与副本一致性、Node 与 Python 两套测试，一条命令跑完并汇总。

对应 AGENTS.md §6 的基础命令。先跑语法检查，再跑构建与副本一致性（都快，失败即停），
然后两套测试并行跑。它只汇总结果，不替人判断新增失败与既有环境红灯（见 .zcode/rules/tests.md §3）。
契约见 specs/dev-loop-speed.md。

用法：
  python3 -B scripts/check_all.py                     # 全部
  python3 -B scripts/check_all.py --quick             # 只跑语法检查与一致性检查
  python3 -B scripts/check_all.py --list              # 只列出要跑的命令
  python3 -B scripts/check_all.py --node <可执行文件>  # Windows 开发机用宿主自带的 Node
"""
import argparse
import glob
import locale
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SYNTAX_TARGETS = ("overlay.js", "inject-main.cjs", "quota-client.cjs", "model-puller.cjs",
                  "zusage-mobile.user.js", "zusage-mobile.debug.user.js")
MAX_FAILURE_NAMES = 20
_NO_WINDOW = 0x08000000 if os.name == "nt" else 0   # CREATE_NO_WINDOW：父进程没有控制台时子进程不闪黑框
_TAP_COUNT = re.compile(r"^# (tests|pass|fail|skipped) (\d+)", re.M)
_TAP_RESULT = re.compile(r"^( *)(not )?ok \d+ - (.*)$", re.M)
_UT_RAN = re.compile(r"^Ran (\d+) tests? in", re.M)
_UT_BAD = re.compile(r"^(FAIL|ERROR): (\S+) \((\S+)\)", re.M)
_UT_END = re.compile(r"^(OK|FAILED)( \(.*\))?\s*$", re.M)
_UT_SKIPPED = re.compile(r"skipped=(\d+)")


def child_env():
    """子进程环境。--node 指向宿主的 Electron（ZCode.exe）时必须带 ELECTRON_RUN_AS_NODE=1：缺了它
    Electron 以客户端身份启动，--check 落空；对正式 Node 与 Python 子进程无影响。"""
    return dict(os.environ, ELECTRON_RUN_AS_NODE="1")


def decode_output(data):
    """子进程输出按字节读再解码：Node 与 UTF-8 模式下的 Python 写 UTF-8，中文 Windows 默认代码页下的
    Python 写 GBK。先按 UTF-8 严格解，解不开再按区域代码页解（残缺字节替换）——不改子进程的编码，
    默认代码页下的问题照旧会在测试里暴露，这里只是把它们读对。"""
    if isinstance(data, str):
        return data
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode(locale.getpreferredencoding(False) or "utf-8", errors="replace")


def syntax_commands(node):
    return [("语法", "node --check " + name, [node, "--check", name], name)
            for name in SYNTAX_TARGETS if (ROOT / name).is_file()]


def consistency_commands():
    py = sys.executable
    return [("一致性", "build_overlay.py --check", [py, "-B", "scripts/build_overlay.py", "--check"], "build_overlay"),
            ("一致性", "build_quota.py --check", [py, "-B", "scripts/build_quota.py", "--check"], "build_quota"),
            ("一致性", "build_puller.py --check", [py, "-B", "scripts/build_puller.py", "--check"], "build_puller"),
            ("一致性", "sync_plugin.py --check", [py, "-B", "sync_plugin.py", "--check"], "sync_plugin")]


def node_test_files(root=ROOT):
    # glob.escape：仓库路径里的 [ 会被当成字符类
    files = sorted(glob.glob(os.path.join(glob.escape(str(root)), "tests", "*.test.cjs")))
    if not files:
        raise FileNotFoundError(f"{root / 'tests'} 下没有 *.test.cjs")
    return files


def test_commands(node):
    # 测试文件通配由脚本展开，不依赖 shell（Windows PowerShell 不展开通配）
    return [("测试", "node --test", [node, "--test", "--test-reporter=tap", *node_test_files()], "node-test"),
            ("测试", "python -m unittest",
             [sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"], "python-test")]


def parse_tap(text):
    """返回 (总数, 失败数, 跳过数, 失败用例名)。
    Node 把失败的子测试和它的父套件各算一条；这里只数最具体的失败用例。TAP 里子测试的结果行排在
    父套件的结果行之前：有缩进的 not ok 先记着，随后父级的 not ok 不再重复计；父级自己失败
    （下面没有更具体的失败）才用父级的名字。"""
    counts = {key: int(value) for key, value in _TAP_COUNT.findall(text)}
    names, pending = [], {}
    for indent, failed, name in _TAP_RESULT.findall(text):
        if not failed:
            continue
        depth = len(indent)
        if depth == 0:
            names.extend([item for level in sorted(pending) for item in pending[level]] or [name.strip()])
            pending = {}
        elif not any(level > depth for level in pending):
            pending.setdefault(depth, []).append(name.strip())
    names.extend(item for level in sorted(pending) for item in pending[level])
    return counts.get("tests", 0), len(names), counts.get("skipped", 0), names


def parse_unittest(text):
    """返回 (总数, 失败数, 跳过数, 失败用例名)。同一个用例又 FAIL 又 ERROR 各算一条，按出现顺序去重。"""
    ran = _UT_RAN.search(text)
    seen, names = set(), []
    for kind, name, cls in _UT_BAD.findall(text):
        if (kind, name, cls) not in seen:
            seen.add((kind, name, cls))
            names.append(f"{kind}: {name} ({cls})")
    # 汇总行后面可能还跟着某个用例子进程的残留输出，所以要找最后一条汇总行，不能只看末尾
    ends = _UT_END.findall(text)
    skipped = _UT_SKIPPED.search(ends[-1][1] or "") if ends else None
    return (int(ran.group(1)) if ran else 0), len(names), (int(skipped.group(1)) if skipped else 0), names


def _run_quick(steps, run):
    """逐条跑快检查；返回第一条失败的 (名字, 输出)，全过返回 None。子进程起不来（PATH 里没有 node）
    也算那一条失败：带指引，不给一段 traceback。"""
    for _, name, cmd, _ in steps:
        try:
            proc = run(cmd, cwd=str(ROOT), capture_output=True, env=child_env(), creationflags=_NO_WINDOW)
        except OSError as exc:
            return name, (f"子进程没能启动：{exc}\n"
                          "找不到 node 时用 --node 指定可执行文件（Windows 开发机指向宿主自带的 ZCode.exe）")
        if proc.returncode != 0:
            return name, decode_output(proc.stdout or b"") + decode_output(proc.stderr or b"")
    return None


def _run_tests(steps, popen, log_dir):
    """两套测试并行跑，输出落日志文件。返回 [(名字, 退出码, 日志路径, 用时秒)]，顺序与 steps 相同。"""
    began = time.time()
    running = []
    for _, name, cmd, log_stem in steps:
        log = Path(log_dir) / (log_stem + ".log")
        handle = open(log, "w", encoding="utf-8", errors="replace")
        running.append((name, popen(cmd, cwd=str(ROOT), stdout=handle, stderr=subprocess.STDOUT,
                                    env=child_env(), creationflags=_NO_WINDOW), handle, log))
    results = []
    for name, proc, handle, log in running:
        code = proc.wait()
        handle.close()
        results.append((name, code, log, time.time() - began))
    return results


def _minutes(seconds):
    whole = int(seconds)
    return f"{whole // 60} 分 {whole % 60} 秒" if whole >= 60 else f"{whole} 秒"


def main(argv=None, run=subprocess.run, popen=subprocess.Popen):
    parser = argparse.ArgumentParser(description="一键跑完 AGENTS.md §6 的基础检查")
    parser.add_argument("--quick", action="store_true", help="只跑语法检查与一致性检查")
    parser.add_argument("--list", action="store_true", help="只列出要跑的命令")
    parser.add_argument("--node", default="node", help="Node 可执行文件，默认 node")
    args = parser.parse_args(argv)
    try:
        syntax = syntax_commands(args.node)
        quick = syntax + consistency_commands()
        tests = [] if args.quick else test_commands(args.node)
    except FileNotFoundError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    if args.list:
        for step in quick + tests:
            print(" ".join(step[2]))
        return 0

    began = time.time()
    failed = _run_quick(quick, run)
    if failed is not None:
        name, output = failed
        print(f"[失败] {name}（后面的检查没有跑）")
        print(output.rstrip()[-2000:])
        return 1
    print(f"[通过] 语法检查 {len(syntax)} 项，构建与副本一致性 {len(quick) - len(syntax)} 项")

    log_dir = tempfile.mkdtemp(prefix="zusage-check-")
    if not tests:
        print(f"全部通过，用时 {_minutes(time.time() - began)}")
        return 0
    print(f"两套测试并行运行中，日志目录：{log_dir}")
    clean = True
    for name, code, log, seconds in _run_tests(tests, popen, log_dir):
        text = decode_output(log.read_bytes())
        total, bad, skipped, names = parse_tap(text) if log.name == "node-test.log" else parse_unittest(text)
        clean = clean and code == 0 and bad == 0
        print(f"[{'通过' if code == 0 and bad == 0 else '失败'}] {name}：共 {total}，失败 {bad}，跳过 {skipped}，"
              f"退出码 {code}，用时 {_minutes(seconds)}")
        for item in names[:MAX_FAILURE_NAMES]:
            print(f"    - {item}")
        if len(names) > MAX_FAILURE_NAMES:
            print(f"    …另有 {len(names) - MAX_FAILURE_NAMES} 个，见 {log}")
        if bad == 0 and code != 0:
            print("    测试进程以非零退出，但没有解析到失败用例。末尾输出：")
            print("    " + "\n    ".join(text.rstrip().splitlines()[-15:]))
    print(f"{'全部通过' if clean else '有失败'}，总用时 {_minutes(time.time() - began)}")
    return 0 if clean else 1


if __name__ == "__main__":
    # Windows 上 stdout 接管道时按区域代码页编码：汇总里的中文（失败明细、路径）在 cp1252 管道上一句就
    # UnicodeEncodeError。保留调用方的编码，只把编不了的字符转义
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="backslashreplace")
    sys.exit(main())
