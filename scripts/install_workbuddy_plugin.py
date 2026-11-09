# -*- coding: utf-8 -*-
"""把 plugins/workbuddy-token-usage 装进本机 WorkBuddy（目录市场 + 插件缓存的本地登记）。

背景：WorkBuddy 自带的 `codebuddy plugin marketplace add` 在桌面客户端运行时抢不到
固定端口（EADDRINUSE 127.0.0.1:63352），无法用它安装；本脚本按客户端自己的登记结构
写入状态（与目录市场装的插件同构），可反复执行，先备份再改。

  python scripts/install_workbuddy_plugin.py            # 安装/更新
  python scripts/install_workbuddy_plugin.py --check    # 只检查当前登记状态
  python scripts/install_workbuddy_plugin.py --uninstall

写的是三份状态文件（都在 ~/.workbuddy 下，WorkBuddy 读这些）：
  plugins/known_marketplaces.json   市场登记（type=directory + 来源路径 + 安装位置）
  plugins/installed_plugins.json    插件安装记录（键 = 插件@市场）
  settings.json                     enabledPlugins 开关
另外把插件内容复制到 plugins/marketplaces/<market> 与 plugins/cache/<market>/<plugin>/<ver>。

注意：WorkBuddy 正在运行时退出可能回写 settings.json，若重启后插件不见了，重跑本脚本即可。
"""
import json
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "plugins" / "workbuddy-token-usage"
PLUGIN = "workbuddy-token-usage"
MARKET = "workbuddy-token-usage"
KEY = f"{PLUGIN}@{MARKET}"


def home():
    import os
    return Path(os.environ.get("WORKBUDDY_HOME") or (Path.home() / ".workbuddy"))


def load(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def save(path, data):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def version():
    manifest = load(SRC / ".codebuddy-plugin" / "plugin.json") or {}
    return str(manifest.get("version") or "1.0.0")


def backup(base, files):
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dst = base / "plugins" / f"_backup-{stamp}-workbuddy-token-usage"
    dst.mkdir(parents=True, exist_ok=True)
    for f in files:
        if f.is_file():
            shutil.copy2(f, dst / f.name)
    return dst


def copy_tree(dst):
    """覆盖复制（不先删目录）：宿主环境对递归删除有 safe-delete 守卫，
    逐文件 copy2 已足够——版本目录按版本号隔离，市场目录留旧文件无害。"""
    dst.mkdir(parents=True, exist_ok=True)
    for item in SRC.rglob("*"):
        target = dst / item.relative_to(SRC)
        if item.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)


def install():
    base = home()
    plugins = base / "plugins"
    if not (plugins / "installed_plugins.json").is_file():
        print(f"未找到 WorkBuddy 插件目录：{plugins}（确认客户端装过并启动过一次）")
        return 1
    km_path = plugins / "known_marketplaces.json"
    ip_path = plugins / "installed_plugins.json"
    st_path = base / "settings.json"
    km, ip, st = load(km_path), load(ip_path), load(st_path)
    if not isinstance(km, dict) or not isinstance(ip, dict):
        print("插件登记文件不是对象，拒绝改写（不做默默重建）")
        return 1
    if not isinstance(st, dict):
        print("settings.json 不是对象，拒绝改写")
        return 1

    ver = version()
    market_dir = plugins / "marketplaces" / MARKET
    cache_dir = plugins / "cache" / MARKET / PLUGIN / ver
    bdir = backup(base, [km_path, ip_path, st_path])
    print(f"[备份] {bdir}")

    copy_tree(market_dir)
    copy_tree(cache_dir)
    print(f"[市场] {market_dir}")
    print(f"[缓存] {cache_dir}")

    now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    manifest = load(SRC / ".codebuddy-plugin" / "plugin.json") or {}
    market = load(SRC / "marketplace.json") or {}
    km[MARKET] = {
        "manifestName": MARKET,
        "type": "directory",
        "source": {"source": "directory", "path": str(SRC)},
        "installLocation": str(market_dir),
        "description": market.get("description") or manifest.get("description") or "",
        "lastUpdated": now,
        "autoUpdate": False,
        "isBuiltIn": False,
    }
    save(km_path, km)
    print(f"[登记] 市场 {MARKET} → {SRC}")

    records = ip.setdefault("plugins", {})
    old = records.get(KEY) or []
    installed_at = old[0].get("installedAt") if old and isinstance(old[0], dict) else now
    records[KEY] = [{
        "scope": "user",
        "installPath": str(cache_dir),
        "version": ver,
        "installedAt": installed_at,
        "lastUpdated": now,
    }]
    save(ip_path, ip)
    print(f"[登记] 插件 {KEY} v{ver}")

    enabled = st.setdefault("enabledPlugins", {})
    enabled[KEY] = True
    save(st_path, st)
    print(f"[启用] settings.json enabledPlugins[{KEY}] = true")
    print("\n完成。完全退出并重开 WorkBuddy 后生效（新会话里 /usage 与 token_usage 工具可用）。")
    return 0


def uninstall():
    base = home()
    plugins = base / "plugins"
    km_path = plugins / "known_marketplaces.json"
    ip_path = plugins / "installed_plugins.json"
    st_path = base / "settings.json"
    km, ip, st = load(km_path) or {}, load(ip_path) or {}, load(st_path) or {}
    backup(base, [km_path, ip_path, st_path])
    removed = []
    if isinstance(km, dict) and km.pop(MARKET, None) is not None:
        save(km_path, km)
        removed.append("市场登记")
    if isinstance(ip, dict) and ip.get("plugins", {}).pop(KEY, None) is not None:
        save(ip_path, ip)
        removed.append("安装记录")
    if isinstance(st, dict) and st.get("enabledPlugins", {}).pop(KEY, None) is not None:
        save(st_path, st)
        removed.append("启用开关")
    for d in (plugins / "marketplaces" / MARKET, plugins / "cache" / MARKET):
        if d.exists():
            try:
                shutil.rmtree(d)
                removed.append(str(d))
            except OSError as exc:   # 目录被占用/守卫拦截：状态已清，残留文件不影响功能
                print(f"（目录未能删除，可手动清理：{d}：{exc}）")
    print("已移除：" + ("、".join(removed) if removed else "（本来就没有登记）"))
    print("完全退出并重开 WorkBuddy 后生效。")
    return 0


def check():
    base = home()
    plugins = base / "plugins"
    km = load(plugins / "known_marketplaces.json") or {}
    ip = load(plugins / "installed_plugins.json") or {}
    st = load(base / "settings.json") or {}
    ok = True
    print("市场登记:", "有" if MARKET in km else "无")
    ok &= MARKET in km
    rec = (ip.get("plugins") or {}).get(KEY)
    print("安装记录:", json.dumps(rec, ensure_ascii=False) if rec else "无")
    ok &= bool(rec)
    enabled = (st.get("enabledPlugins") or {}).get(KEY)
    print("启用开关:", enabled)
    ok &= bool(enabled)
    if rec and rec[0].get("installPath"):
        target = Path(rec[0]["installPath"])
        print("缓存存在:", target.is_dir())
        ok &= target.is_dir()
        if target.is_dir():
            for name in ("usage_mcp.py", "zusage.py", "token_pricing.py",
                         ".codebuddy-plugin/plugin.json", "commands/usage.md"):
                present = (target / name).is_file()
                print(f"  {name:<34}{'有' if present else '缺'}")
                ok &= present
    print("\n结论:", "已安装" if ok else "未就绪（运行安装命令）")
    return 0 if ok else 1


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--uninstall" in args:
        sys.exit(uninstall())
    if "--check" in args:
        sys.exit(check())
    sys.exit(install())
