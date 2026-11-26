#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""选择性开发部署：把工作树里有改动的热文件安全地放进运行目录，并取热重载证据。

把 .zcode/rules/install-release.md §2 的「热修纪律」固化成一条命令：逐文件甄别（运行目录里的字节必须
等于某个基线版本，否则视为领先或被热修、不动）、备份、同目录临时文件过语法检查、写前写后比对、
原子替换并让 mtime 前进；随后经本机调试端口比对部署前后的浮层代际，并看常驻 zusage 进程是否更替。
没有强制覆盖。契约见 specs/dev-loop-speed.md。

用法：
  python3 -B scripts/deploy_hot.py --dry-run                        # 只甄别并打印计划，不写任何文件
  python3 -B scripts/deploy_hot.py --reason issue-483               # 部署全部有差异的热文件
  python3 -B scripts/deploy_hot.py --reason issue-483 --files overlay.js zusage.py
"""
import argparse
import ast
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from runtime_lock import bounded_mkstemp   # 运行目录内的临时文件统一走受限创建（install-release.md §2）

HOT_FILES = ("overlay.js", "turn-stats.js", "zusage.py", "token_rate.py", "usage_stats.py", "token_pricing.py",
             "quota-client.cjs", "model-puller.cjs", "plugin-updater.cjs", "plugin-release.cjs",
             "plugin-storage.cjs", "engine-patch.cjs", "sysmon-client.cjs", "mobile-relay.cjs")
COLD_FILES = ("inject-main.cjs",)
RENDERER_FILES = ("overlay.js", "turn-stats.js")
PYTHON_DAEMON = "zusage.py"
DEFAULT_RUNTIME = "~/.zcode/zcode-token-usage-statusbar"
POLL_S = 5
REASON_RE = re.compile(r"[A-Za-z0-9._-]{1,40}")


def read_bytes(path):
    path = Path(path)
    return path.read_bytes() if path.is_file() else None


def classify(work, run, baselines):
    """work/run 是文件字节或 None（不存在）。返回 same / deploy / protected。"""
    if work is not None and work == run:
        return "same"
    if run is None or any(run == base for base in baselines if base is not None):
        return "deploy"
    return "protected"


def make_plan(names, work_dir, run_dir, baseline_of):
    steps = []
    for name in names:
        if name in COLD_FILES:
            steps.append({"name": name, "action": "cold"})
            continue
        work = read_bytes(Path(work_dir) / name)
        run = read_bytes(Path(run_dir) / name)
        action = "missing" if work is None else classify(work, run, baseline_of(name))
        steps.append({"name": name, "action": action, "work": work, "run": run})
    return steps


_DESCRIBE = {
    "same": "相同    {name}",
    "deploy": "待部署  {name}",
    "protected": "受保护  {name}：运行目录里的字节不等于 HEAD、fork/main 或 merge-base 的版本，视为领先或被热修，不动",
    "cold": "冷文件  {name}：完全重启才生效，走可信同步，不在本脚本范围",
    "missing": "工作树里没有 {name}，跳过",
}


def describe(step):
    return _DESCRIBE[step["action"]].format(name=step["name"])


def syntax_check(path, name, node="node"):
    """返回 (是否通过, 说明)。.js/.cjs 过 node --check，.py 过 ast.parse，其它扩展名不检查。"""
    if name.endswith((".js", ".cjs")):
        try:
            proc = subprocess.run([node, "--check", str(path)], capture_output=True, encoding="utf-8",
                                  errors="replace", timeout=60)
        except (OSError, subprocess.TimeoutExpired) as exc:
            return False, f"node --check 没跑成：{exc}"
        return proc.returncode == 0, (proc.stderr or "").strip()[-400:]
    if name.endswith(".py"):
        try:
            ast.parse(Path(path).read_bytes(), filename=name)
        except (SyntaxError, ValueError) as exc:
            return False, str(exc)
    return True, ""


def install_file(step, run_dir, reason, stamp, check=syntax_check):
    """把 step 里的新字节原子放进 run_dir。返回 (状态, 说明)，状态是 ok / syntax / race / verify；
    不是 ok 时运行文件保持原样。"""
    name = step["name"]
    target = Path(run_dir) / name
    expected = step["run"]
    old_stat = target.stat() if expected is not None else None
    backup = None
    if expected is not None:
        backup = target.with_name(f".pre-{reason}-{stamp}-{name}")
        shutil.copy2(target, backup)
    fd, tmp_name = bounded_mkstemp(prefix=f".{name}.", dir=str(run_dir), suffix="".join(Path(name).suffixes))
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(step["work"])
        ok, detail = check(tmp, name)
        if not ok:
            return "syntax", detail
        # 写前比对：宿主更新或别的会话可能在甄别之后改写了运行目录，不一致就停下
        if read_bytes(target) != expected:
            return "race", "运行文件在甄别之后被别处改写，已停下，没有覆盖"
        if old_stat is not None:
            os.chmod(tmp, stat.S_IMODE(old_stat.st_mode))
        os.replace(tmp, target)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
    if read_bytes(target) != step["work"]:
        return "verify", "写后回读与要部署的字节不一致"
    # 热重载按 mtime 轮询；时钟粒度粗时新 mtime 可能等于旧的，确保它前进
    if old_stat is not None and target.stat().st_mtime <= old_stat.st_mtime:
        bump = max(time.time(), old_stat.st_mtime + 1)
        os.utime(target, (bump, bump))
    return "ok", f"备份 {backup.name}" if backup else "运行目录里原本没有这个文件，新建"


def renderer_state(node="node", port=9229):
    """返回 (是否取到, 数据)。取到时是各页面的列表，否则是一句失败说明。"""
    try:
        proc = subprocess.run([node, str(ROOT / "scripts" / "hot_evidence.cjs"), str(port)],
                              capture_output=True, encoding="utf-8", errors="replace", timeout=40)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"取证脚本没跑成：{exc}"
    if proc.returncode != 0:
        return False, (proc.stderr or "").strip() or f"取证脚本退出码 {proc.returncode}"
    try:
        return True, json.loads(proc.stdout)
    except ValueError:
        return False, "取证脚本的输出不是 JSON"


def generation_advanced(before, after):
    """同一页面（按 url）的 __zusageGen 递增，或原本没有浮层的页面出现了浮层。"""
    old = {row.get("url"): row.get("gen") for row in before if isinstance(row, dict)}
    for row in after:
        if not isinstance(row, dict):
            continue
        gen, was = row.get("gen"), old.get(row.get("url"))
        if isinstance(gen, int) and (not isinstance(was, int) or gen > was):
            return True
    return False


def resident_pids():
    """常驻 `zusage.py serve` 进程的 pid 集合；非 POSIX 或没有 pgrep 时返回 None。"""
    if os.name != "posix":
        return None
    try:
        proc = subprocess.run(["pgrep", "-f", f"{PYTHON_DAEMON} serve"], capture_output=True, encoding="utf-8",
                              errors="replace", timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return {int(item) for item in proc.stdout.split()} if proc.returncode == 0 else set()


def _wait_for(probe, seconds):
    deadline = time.time() + seconds
    while True:
        value = probe()
        if value or time.time() >= deadline:
            return value
        time.sleep(POLL_S)


def git_baselines(name, repo=ROOT):
    """HEAD、远端 main 与两者 merge-base 里同一文件的字节；取不到的略过。"""
    def git(*args):
        return subprocess.run(["git", "-C", str(repo), *args], capture_output=True).stdout
    remote = None
    for ref in ("refs/remotes/fork/main", "refs/remotes/origin/main"):
        sha = git("rev-parse", "--verify", "-q", ref).decode(errors="replace").strip()
        if sha:
            remote = sha
            break
    revs = ["HEAD"] + ([remote] if remote else [])
    if remote:
        base = git("merge-base", remote, "HEAD").decode(errors="replace").strip()
        if base:
            revs.append(base)
    versions = []
    for rev in revs:
        proc = subprocess.run(["git", "-C", str(repo), "show", f"{rev}:{name}"], capture_output=True)
        versions.append(proc.stdout if proc.returncode == 0 else None)
    return versions


def main(argv=None, run_dir=None, baseline_of=None, check=syntax_check, evidence=renderer_state,
         pids=resident_pids):
    parser = argparse.ArgumentParser(description="把工作树里有改动的热文件安全地部署到运行目录并取热重载证据")
    parser.add_argument("--reason", help="写进备份名的原因，如 issue-483；部署时必填")
    parser.add_argument("--files", nargs="*", help=f"只处理这些文件；默认全部热文件：{' '.join(HOT_FILES)}")
    parser.add_argument("--runtime", default=DEFAULT_RUNTIME, help="运行目录")
    parser.add_argument("--dry-run", action="store_true", help="只甄别并打印计划，不写任何文件")
    parser.add_argument("--wait", type=int, default=90, help="等热重载证据的秒数，默认 90，0 表示不等")
    parser.add_argument("--node", default="node", help="Node 可执行文件，默认 node")
    parser.add_argument("--port", type=int, default=9229, help="本机调试端口，默认 9229")
    args = parser.parse_args(argv)
    if not args.dry_run and not args.reason:
        parser.error("部署必须带 --reason <原因>（写进备份名）；只看计划用 --dry-run")
    if args.reason and not REASON_RE.fullmatch(args.reason):
        parser.error("--reason 只能含字母、数字、. _ -，最长 40 个字符")
    if args.wait < 0:
        parser.error("--wait 不能是负数")
    names = args.files or list(HOT_FILES)
    unknown = [name for name in names if name not in HOT_FILES and name not in COLD_FILES]
    if unknown:
        parser.error(f"不是可部署的热文件：{' '.join(unknown)}")
    target_dir = Path(run_dir or args.runtime).expanduser()
    if not target_dir.is_dir():
        print(f"运行目录不存在：{target_dir}", file=sys.stderr)
        return 2
    # 运行目录路径不做 resolve（macOS /var ↔ /private/var 之类符号链接会改写字面），只取绝对路径
    target_dir = Path(os.path.abspath(os.fspath(target_dir)))

    plan = make_plan(names, ROOT, target_dir, baseline_of or git_baselines)
    for step in plan:
        print(describe(step))
    todo = [step for step in plan if step["action"] == "deploy"]
    # 工作树里没有的文件只是跳过（旧检出可能缺某个模块），不算受阻
    blocked = [step for step in plan if step["action"] in ("protected", "cold")]
    if args.dry_run or not todo:
        return 1 if blocked else 0

    stamp = time.strftime("%Y%m%d-%H%M%S")
    verify_renderer = any(step["name"] in RENDERER_FILES for step in todo)
    verify_daemon = any(step["name"] == PYTHON_DAEMON for step in todo)
    before_ok, before = evidence(args.node, args.port) if verify_renderer else (False, None)
    pids_before = pids() if verify_daemon else None

    failed = []
    for step in todo:
        state, detail = install_file(step, target_dir, args.reason, stamp, check)
        print(f"{'已部署' if state == 'ok' else '失败  '}  {step['name']}：{detail}" + ("（运行文件未动）" if state != "ok" else ""))
        if state != "ok":
            failed.append(step["name"])

    pending = "状态是「已部署、待重注入验证」"
    if verify_renderer:
        if not before_ok:
            print(f"渲染端热重载：无法取证（{before}），{pending}")
        else:
            def advanced():
                ok, after = evidence(args.node, args.port)
                return ok and generation_advanced(before, after)
            if _wait_for(advanced, args.wait) if args.wait else advanced():
                print("渲染端热重载：已验证（同一页面的 __zusageGen 递增）")
            else:
                print(f"渲染端热重载：没有取到代际递增的证据（窗口被遮挡时轮询会被节流），{pending}")
    if verify_daemon:
        if pids_before is None:
            print(f"常驻 zusage 进程：本平台无法查看进程，{pending}")
        elif _wait_for(lambda: pids() not in (None, pids_before), args.wait) if args.wait else pids() not in (None, pids_before):
            print("常驻 zusage 进程：已更替")
        else:
            print(f"常驻 zusage 进程：没有看到更替，{pending}")
    others = [step["name"] for step in todo if step["name"] not in RENDERER_FILES and step["name"] != PYTHON_DAEMON]
    if others:
        print(f"主进程模块 {' '.join(others)}：已部署，由 loader 按 mtime 轮询热换，没有通用的取证手段，按模块行为验证")
    print("收尾：全部完成" if not failed and not blocked else f"收尾：有未完成项（失败 {len(failed)}，受阻 {len(blocked)}）")
    return 0 if not failed and not blocked else 1


if __name__ == "__main__":
    sys.exit(main())
