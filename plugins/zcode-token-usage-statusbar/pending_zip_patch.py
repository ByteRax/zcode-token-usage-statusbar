# -*- coding: utf-8 -*-
"""ZCode 桌面更新包预注入工具（macOS pending zip，方案 B）。

背景：ZCode 桌面（macOS）用 electron-updater + Squirrel.Mac 整包更新——更新 zip 下载到
~/Library/Caches/<updaterCacheDirName>/pending/，sha512 只在下载完成时校验一次，之后
DownloadedUpdateHelper.getValidCachedUpdateFile 只比对 update-info.json 与官方 manifest
（元数据级），zip 内容在安装前不再复验；用户点击「重启以更新」后 Squirrel 直接解包该
zip 整体替换 /Applications/ZCode.app。本工具在 Squirrel 取走前把 zip 内 app.asar 条目
补上注入行（版本指纹表内时由 ensure_deployed 顺带打渲染桥），让「更新重启」后插件
一次生效，省掉 SessionStart 重注入后的第二次重启。

安全性：
- 只改 zip；update-info.json 绝不改动——它是宿主缓存有效性的判定依据，改了会造成
  15 分钟一轮的反复全量重下（缓存 sha512 与 manifest 比对不过即清目录重下）。
- 幂等：zip 内 asar 已带注入行即跳过；成功后把 zip 的 sha256 记入运行目录
  pending-zip-patch.json，触发方据此免解压跳过。
- 失败原子：改动先写同目录临时文件，提交前复核 update-info.json 与 zip 的 stat 锚点
  （宿主清缓存重下会改写二者），不一致即放弃；任何失败保留原 zip，SessionStart
  重注入链兜底。
- 身份校验：目标 asar 必须是 @zcode/desktop（与 ensure_deployed 同判据）；zip 内
  asar 条目唯一匹配 */Contents/Resources/app.asar。
- Windows 不适用：更新走 NSIS 安装器且安装包本身有 Authenticode 验签。

用法（inject-main.cjs 自动调用；手动等价）：
  python pending_zip_patch.py --zip <pending zip> --asar <当前安装 app.asar> --runtime <运行目录>
"""
import argparse
import hashlib
import json
import os
import shutil
import stat
import struct
import sys
import tempfile
import time
import zipfile
from pathlib import Path

HERE = Path(__file__).parent.resolve()
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import patch_install  # noqa: E402
import renderer_bridge  # noqa: E402
from runtime_lock import file_lock  # noqa: E402

# zip 内客户端 asar 条目的唯一形态（实机 3.17.2 取证：ZCode.app/Contents/Resources/app.asar，
# deflate，非 zip64；条目数 3616）
ASAR_ENTRY_SUFFIX = "Contents/Resources/app.asar"
UPDATE_INFO_NAME = "update-info.json"
STATE_NAME = "pending-zip-patch.json"
STATE_VERSION = 1
STATE_LIMIT = 8
COPY_BLOCK = 4 * 1024 * 1024


def _log(message):
    print(patch_install.L(f"[pending-zip] {message}", f"[pending-zip] {message}"))


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(COPY_BLOCK), b""):
            digest.update(block)
    return digest.hexdigest()


def load_state(runtime):
    try:
        state = json.loads((runtime / STATE_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"version": STATE_VERSION, "files": {}}
    if not isinstance(state, dict) or not isinstance(state.get("files"), dict):
        return {"version": STATE_VERSION, "files": {}}
    # 记录值损坏按未记录处理：宁重解压一次也不把坏记录当命中
    state["files"] = {name: value for name, value in state["files"].items()
                      if isinstance(value, dict) and isinstance(value.get("sha256"), str)}
    return state


def save_state(runtime, state):
    files = state.get("files") if isinstance(state.get("files"), dict) else {}
    if len(files) > STATE_LIMIT:   # LRU 淘汰：只留最近处理的包，防状态文件随版本累积膨胀
        recent = sorted(files.items(), key=lambda kv: kv[1].get("patchedAt", 0), reverse=True)
        state["files"] = dict(recent[:STATE_LIMIT])
    state["version"] = STATE_VERSION
    fd, name = tempfile.mkstemp(prefix=STATE_NAME + ".", dir=runtime)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(state, stream, separators=(",", ":"))
        os.replace(name, runtime / STATE_NAME)
    finally:
        Path(name).unlink(missing_ok=True)


def find_asar_entry(archive):
    """zip 内唯一的客户端 asar 条目；不唯一或缺失即拒绝（fail-closed）。"""
    matches = [info for info in archive.infolist()
               if not info.is_dir() and
               info.filename.replace("\\", "/").endswith("/" + ASAR_ENTRY_SUFFIX)]
    if len(matches) != 1:
        raise ValueError(f"expected exactly one {ASAR_ENTRY_SUFFIX} entry, found {len(matches)}")
    return matches[0]


def extract_entry(archive, info, destination):
    with archive.open(info) as source, open(destination, "wb") as out:
        shutil.copyfileobj(source, out, COPY_BLOCK)


def patch_asar_bytes(stage_asar, runtime):
    """注入行 + 渲染桥。返回 (新 asar 路径, 客户端版本, 结果说明)；已是目标状态时
    新路径为 None。桥是增强：ensure_deployed 的任何 skipped-* 都不阻塞注入行。"""
    patch_install.set_runtime(runtime)
    header_package = None
    with open(stage_asar, "rb") as f:
        header, base = patch_install.read_header(f)
        nodes = dict(patch_install.iter_files(header))
        raw = nodes.get("/package.json")
        if raw is None:
            raise ValueError("asar has no package.json")
        f.seek(base + int(raw["offset"]))
        header_package = json.loads(f.read(raw["size"]))
    if (header_package.get("name"), header_package.get("type")) != ("@zcode/desktop", "module"):
        raise ValueError(f"not a ZCode desktop asar: name={header_package.get('name')!r}")
    version = header_package.get("version")

    entry = patch_install.entry_bytes_of(stage_asar)
    new_entry = patch_install.ZUSAGE_LINE_RE.sub(b"", entry) + patch_install.INJECT_LINE.encode()
    if new_entry == entry:
        return None, version, "already patched"
    patched = stage_asar.with_name(stage_asar.name + ".patched")
    patch_install.repack(stage_asar, {"/" + patch_install.ENTRY: new_entry}, patched)
    bridge = renderer_bridge.ensure_deployed(patched)
    _log(f"renderer bridge on staged asar: {bridge.get('status')} ({bridge.get('version')}) {bridge.get('detail', '')[:160]}")
    return patched, version, "injection line added"


def rewrite_zip(source_zip, source_info, patched_asar, destination):
    """流式重写：其它条目逐块拷贝（保留 ZipInfo 的日期/权限/压缩方式），asar 条目换
    成打补丁后的内容；条目数必须一致（防呆：丢条目的包绝不能提交给 Squirrel）。"""
    with zipfile.ZipFile(source_zip) as src, \
            zipfile.ZipFile(destination, "w", allowZip64=True) as out:
        for info in src.infolist():
            if info.filename == source_info.filename:   # ZipInfo 是重新遍历的新对象，只能按名比对
                target = zipfile.ZipInfo(info.filename, date_time=info.date_time)
                target.compress_type = info.compress_type
                target.external_attr = info.external_attr
                target.create_system = info.create_system
                target.internal_attr = info.internal_attr
                target.comment = info.comment
                with open(patched_asar, "rb") as data, out.open(target, "w") as sink:
                    shutil.copyfileobj(data, sink, COPY_BLOCK)
            elif info.is_dir():
                target = zipfile.ZipInfo(info.filename, date_time=info.date_time)
                target.compress_type = info.compress_type
                target.external_attr = info.external_attr
                target.create_system = info.create_system
                target.internal_attr = info.internal_attr
                target.comment = info.comment
                out.writestr(target, b"")
            else:
                with src.open(info) as data, out.open(_cloned(info), "w") as sink:
                    shutil.copyfileobj(data, sink, COPY_BLOCK)
    with zipfile.ZipFile(destination) as check, zipfile.ZipFile(source_zip) as original:
        if len(check.infolist()) != len(original.infolist()):
            raise ValueError("rewritten zip entry count mismatch")


def _cloned(info):
    """zipfile.writestr(info, b"") 已在 rewrite_zip 占位后重新 open 写会重复条目；
    这里改为在 open(w) 前克隆 ZipInfo（不落占位条目），调用方据此一次写完。"""
    target = zipfile.ZipInfo(info.filename, date_time=info.date_time)
    target.compress_type = info.compress_type
    target.external_attr = info.external_attr
    target.create_system = info.create_system
    target.internal_attr = info.internal_attr
    target.comment = info.comment
    return target


STALE_WORKDIR_SECONDS = 3600


def _sweep_stale_workdirs(directory):
    """清掉超龄的 .zusage-pendingzip-* 残留：正常路径由 finally 清理，硬杀/登出
    （数百 MB 工作目录）没有机会执行，按 mtime 超龄兜底；刚创建的不动。"""
    now = time.time()
    for stale in Path(directory).glob(".zusage-pendingzip-*"):
        try:
            if now - stale.stat().st_mtime > STALE_WORKDIR_SECONDS:
                shutil.rmtree(stale, ignore_errors=True)
        except OSError:
            pass


def stat_anchor(path):
    st = path.stat()
    return {"size": st.st_size, "mtime_ns": st.st_mtime_ns, "ino": st.st_ino}


def anchors_unchanged(before, snapshot):
    return snapshot == before


def patch_zip(zip_path, resources_asar=None, runtime=None):
    """主流程。返回 0=已打补丁/已打过（成功），1=拒绝或失败（原 zip 保留）。"""
    zip_path = Path(zip_path)
    runtime = Path(runtime) if runtime else HERE
    if resources_asar:
        # 只为语法检查推导 ZCode 可执行文件（ELECTRON_RUN_AS_NODE --check）；不写该 asar。
        patch_install.set_target(Path(resources_asar))
    patch_install.set_runtime(runtime)
    update_info = zip_path.parent / UPDATE_INFO_NAME
    if not zip_path.is_file() or not update_info.is_file():
        _log("zip or update-info.json missing; skip")
        return 1
    try:
        info_json = json.loads(update_info.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        _log(f"update-info.json unreadable; skip: {e}")
        return 1
    if info_json.get("fileName") not in (None, zip_path.name):
        _log(f"update-info.json points at {info_json.get('fileName')!r}; skip stale cache")
        return 1
    _sweep_stale_workdirs(zip_path.parent)
    anchor_info = stat_anchor(update_info)
    anchor_zip = stat_anchor(zip_path)
    digest = sha256_of(zip_path)
    with file_lock(runtime / (STATE_NAME + ".lock")):
        state = load_state(runtime)
        record = state["files"].get(zip_path.name)
        if (isinstance(record, dict) and record.get("sha256") == digest
                and record.get("runtime") == str(Path(runtime).absolute())):
            _log(f"{zip_path.name} already patched (state hit); skip")
            return 0
    workdir = Path(tempfile.mkdtemp(prefix=".zusage-pendingzip-", dir=zip_path.parent))
    try:
        stage = workdir / "staged.asar"
        with zipfile.ZipFile(zip_path) as archive:
            entry_info = find_asar_entry(archive)
            extract_entry(archive, entry_info, stage)
        patched, version, note = patch_asar_bytes(stage, runtime)
        if patched is None:
            _log(f"{zip_path.name}: {note}; recording state")
            with file_lock(runtime / (STATE_NAME + ".lock")):
                state = load_state(runtime)
                state["files"][zip_path.name] = {
                    "sha256": digest, "patchedAt": int(time.time()),
                    "asarVersion": version or "", "runtime": str(Path(runtime).absolute())}
                save_state(runtime, state)
            return 0
        if patch_install.self_check(patched, expect=True):
            patch_install.syntax_check(patched)
        else:
            raise ValueError("post-patch self check failed")
        candidate = zip_path.parent / (".zusage-zip-" + zip_path.name + ".tmp")
        try:
            rewrite_zip(zip_path, entry_info, patched, candidate)
            if not anchors_unchanged(anchor_info, stat_anchor(update_info)) or \
                    not anchors_unchanged(anchor_zip, stat_anchor(zip_path)):
                _log("pending cache changed during rewrite (host redownload?); abort")
                return 1
            os.chmod(candidate, stat.S_IMODE(zip_path.stat().st_mode))
            os.replace(candidate, zip_path)
        finally:
            candidate.unlink(missing_ok=True)
        with file_lock(runtime / (STATE_NAME + ".lock")):
            state = load_state(runtime)
            state["files"][zip_path.name] = {
                "sha256": sha256_of(zip_path), "patchedAt": int(time.time()),
                "asarVersion": version or "", "runtime": str(Path(runtime).absolute())}
            save_state(runtime, state)
        _log(f"{zip_path.name}: patched (asar {version}); takes effect on the update restart")
        return 0
    except (OSError, ValueError, KeyError, AttributeError, AssertionError,
            struct.error, zipfile.BadZipFile, RuntimeError) as e:
        # AssertionError/struct.error：合法 zip 内 asar 结构损坏（read_header）；任何
        # 失败都保留原 zip，由会话启动自动修复链兜底
        _log(f"patch failed, original zip kept: {type(e).__name__}: {e}")
        return 1
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Patch ZCode pending update zip with the zusage injection line")
    parser.add_argument("--zip", required=True)
    parser.add_argument("--asar", default=None, help="currently installed app.asar (for syntax-check exe lookup)")
    parser.add_argument("--runtime", default=None, help="plugin runtime dir (defaults to script dir)")
    args = parser.parse_args(argv)
    if sys.platform != "darwin":
        # NSIS 安装包带 Authenticode 验签，Windows 无可改写的更新包；本工具不该被调用。
        _log(f"unsupported platform {sys.platform}; skip")
        return 0
    zip_path = Path(os.path.abspath(os.path.expandvars(os.path.expanduser(args.zip))))
    runtime_arg = args.runtime or os.environ.get("ZUSAGE_RUNTIME")
    # 与 patch_install 的 --runtime 同纪律：不 resolve（macOS /var 符号链接会破坏
    # INJECT_LINE 字面一致性），abspath 只补绝对化。
    runtime = Path(os.path.abspath(os.path.expandvars(os.path.expanduser(runtime_arg)))) if runtime_arg else HERE
    try:
        return patch_zip(zip_path, args.asar, runtime)
    except Exception as e:   # 兜底：任何未预期异常都不裸 traceback，保留原 zip 退 1
        _log(f"unexpected failure, original zip kept: {type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
