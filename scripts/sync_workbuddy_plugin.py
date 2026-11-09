# -*- coding: utf-8 -*-
"""把仓库根的共享运行时文件同步进 plugins/workbuddy-token-usage/（WorkBuddy 插件构建）。

WorkBuddy 插件从自己的插件缓存目录运行，不能引用仓库路径，所以必须带一份副本；
副本是生成物，只改根源码，然后：

  python scripts/sync_workbuddy_plugin.py          # 同步
  python scripts/sync_workbuddy_plugin.py --check  # 只校验（CI/提交前）

与 sync_plugin.py 分开，是因为 ZCode 插件包需要整条发布/解包链登记，
WorkBuddy 构建只要这几个运行文件，互不牵连。
"""
import filecmp
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "plugins" / "workbuddy-token-usage"

# 运行时依赖：usage_mcp → zusage → usage_stats（统计/速率公共库）
#             +（workbuddy 宿主）wb_usage →（可选）token_pricing；
# wb-overlay.cjs 是 CDP 浮层注入器。
# usage_stats.py 必须随 zusage.py 一起带：zusage 虽有 ImportError 兜底，但缺文件会走
# 降级分支（少定义 _shared_row_gen_ms 等），而 WorkBuddy 插件从自己的缓存目录运行，
# 读不到仓库根的模块。
FILES = ["usage_mcp.py", "zusage.py", "usage_stats.py", "wb_usage.py",
         "token_pricing.py", "wb-overlay.cjs"]


def main(check_only=False):
    missing = [f for f in FILES if not (ROOT / f).is_file()]
    if missing:
        print("根文件缺失:", ", ".join(missing))
        return 1
    DEST.mkdir(parents=True, exist_ok=True)
    drift = []
    for name in FILES:
        src, dst = ROOT / name, DEST / name
        if dst.is_file() and filecmp.cmp(src, dst, shallow=False):
            continue
        drift.append(name)
        if not check_only:
            shutil.copy2(src, dst)
            print(f"已同步 {name}")
    if check_only:
        if drift:
            print("WorkBuddy 插件副本过期:", ", ".join(drift),
                  "（运行 python scripts/sync_workbuddy_plugin.py 更新）")
            return 1
        print("WorkBuddy 插件副本与根文件一致。")
    return 0


if __name__ == "__main__":
    sys.exit(main("--check" in sys.argv[1:]))
