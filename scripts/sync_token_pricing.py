#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""内置模型价表同步（维护脚本，手动运行，无 CI 定时）。

从 models.dev api.json 增量同步官方渠道文本模型四价进 token_pricing.py 的
PRICING 生成段：新值覆盖同键、models.dev 未覆盖的既有条目原样保留（手工补充
不丢失）、新键追加；全程键序排序保证可 diff。高速变体（*-highspeed，通常只
在 coding-plan 通道且 cost 全 0——套餐内含无牌价）按同厂基础模型派生牌价。
人工纠错写进 OVERRIDES 后重跑本脚本。

用法：
    python3 scripts/sync_token_pricing.py                 # 在线拉 models.dev
    python3 scripts/sync_token_pricing.py --from api.json # 离线用已下载文件
"""
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import token_pricing as tp   # noqa: E402

# 人工纠错（键为 token_pricing 表内小写全限定名）：优先级最高，重跑不丢
OVERRIDES = {}

BEGIN_MARK = "# BEGIN PRICING DATA"
END_MARK = "# END PRICING DATA"
TARGET = ROOT / "token_pricing.py"


def fetch_models_dev():
    req = urllib.request.Request(
        tp.PRICING_URL, headers={"User-Agent": "zcode-token-usage-statusbar-pricing-sync/1"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        if resp.status != 200:
            raise SystemExit(f"models.dev http {resp.status}")
        return json.loads(resp.read().decode("utf-8", "replace"))


def derive_highspeed(table, models_dev):
    """*-highspeed 变体若 models.dev 任意通道存在（多为 coding-plan 全 0 条目）而
    官方基础渠道缺失，按同厂基础模型牌价派生；基础模型也没有则不造条目。"""
    hs_names = set()
    for pdata in (models_dev or {}).values():
        if not isinstance(pdata, dict):
            continue
        for mid in (pdata.get("models") or {}):
            m = str(mid).lower()
            if m.endswith("-highspeed"):
                hs_names.add(m)
    derived = {}
    for m in sorted(hs_names):
        base = m[: -len("-highspeed")]
        for prov in sorted(tp.OFFICIAL_PROVIDERS):
            if prov + "/" + m in table or prov + "/" + base not in table:
                continue
            rates = table[prov + "/" + base]
            if rates["input"] == 0 and rates["output"] == 0:
                continue   # 基础渠道也免费（如 flash 免费档），无需派生
            derived[prov + "/" + m] = dict(rates)
    return derived


def emit_segment(table):
    lines = ["PRICING = {"]
    for key in sorted(table):
        lines.append(" %s: %s," % (json.dumps(key, ensure_ascii=False),
                                   json.dumps(table[key], sort_keys=True)))
    lines.append("}")
    meta = {
        "count": len(table),
        "note": "models.dev 官方渠道增量同步；人工纠错走脚本 OVERRIDES；"
                "*-highspeed 按同厂基础模型派生牌价",
        "source": tp.PRICING_URL,
        "synced_at": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
    }
    lines.append("PRICING_META = " + json.dumps(meta, ensure_ascii=False, sort_keys=True))
    return lines


def rewrite_file(table):
    text = TARGET.read_text(encoding="utf-8")
    lines = text.splitlines()
    begin = end = None
    for i, ln in enumerate(lines):
        if BEGIN_MARK in ln:
            begin = i
        elif END_MARK in ln and begin is not None:
            end = i
            break
    if begin is None or end is None or end <= begin:
        raise SystemExit("token_pricing.py 缺少 PRICING DATA 生成段标记")
    out = lines[: begin + 1] + emit_segment(table) + lines[end:]
    TARGET.write_text("\n".join(out) + ("\n" if text.endswith("\n") else ""), encoding="utf-8")


def main():
    argv = sys.argv[1:]
    if argv and argv[0] == "--from":
        if len(argv) < 2:
            raise SystemExit("--from 需要文件参数")
        data = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
        src = argv[1]
    else:
        data = fetch_models_dev()
        src = tp.PRICING_URL

    fresh = tp.convert_models_dev(data)
    old = dict(tp.PRICING)
    table = dict(old)
    table.update(fresh)
    table.update(derive_highspeed(fresh, data))
    table.update(OVERRIDES)

    added = sorted(set(table) - set(old))
    changed = sorted(k for k in set(table) & set(old) if table[k] != old[k])
    rewrite_file(table)
    print(f"同步完成（来源 {src}）：共 {len(table)} 条，"
          f"新增 {len(added)}，更新 {len(changed)}，保留手工/既有 {len(table) - len(added) - len(changed)}")
    for k in added:
        print("  +", k, table[k])
    for k in changed:
        print("  ~", k, old[k], "->", table[k])
    if added or changed:
        print("请复查上方明细后提交。")

    # 生成段语法自检：子进程重导入并抽查
    import subprocess
    code = (
        "import sys; sys.path.insert(0, %r); import token_pricing as tp;"
        "assert len(tp.PRICING) == tp.PRICING_META['count'] > 0, tp.PRICING_META;"
        "assert tp.lookup('GLM-5.3-FlashX', 'account:bigmodel-individual-coding-plan')['input'] > 0;"
        "assert tp.lookup('GLM-5.3-Highspeed', 'account:zai-start-plan')['input'] > 0;"
        "assert tp.lookup('claude-opus-5-5')['output'] > 0;"
        "print('self-check ok', tp.PRICING_META['count'])" % str(ROOT))
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit("生成段自检失败：\n" + r.stderr)
    print(r.stdout.strip())


if __name__ == "__main__":
    main()
