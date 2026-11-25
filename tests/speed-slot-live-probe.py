#!/usr/bin/env python3
"""速度格实机量宽探针（specs/speed-chip-stable-slot.md）。

在装了本插件的 ZCode 桌面端所在机器上运行，量出速度格在真实布局里各档的实际宽度：
    python3 tests/speed-slot-live-probe.py                  # 默认模式：逐档量全部状态面，连 127.0.0.1:9229
    python3 tests/speed-slot-live-probe.py --port 9229
    python3 tests/speed-slot-live-probe.py --watch 60       # 持续观察 60 秒：ZCode 窗口可见、对话进行中时用

默认模式做法：经宿主的 CDP 调试口（inject-main.cjs 启动时强制补开 9229）把 tests/speed-slot-live-probe.js
送进渲染进程执行，对当前页面的第一条状态条逐档、逐状态面量矩形后原样还原。只读、不改任何文件，
量取过程在同一个同步表达式里完成，不会画到屏幕上。
判据：同一档位里全部状态面的速度格宽度只有一个值、等于固定宽 6.6em × 格字号（极窄档 2.75em；v459）、
数值不越界（亚像素）；任何界面字号都核对（纯 em 随字号等比缩放）。精简样式的速率 chip v469 起按内容定宽（档位 em 只是上限），只查越界。
唯一例外是 >1h 长计时（已知名单 KNOWN_CLIP_FACES）：固定宽里放不下时数值尾被裁，裁到 KNOWN_CLIP_PX 以内只提示不算异常。

持续观察（--watch）做法：把 tests/speed-slot-live-watch.js 送进渲染进程，按固定间隔读真实速度格的宽度、
位置与格面，布局签名取自与速度格自身宽度无关的量。判据：同一条状态条、同一布局（签名前 7 段，不分面类别）下
速度格宽度只有一个值（v459：跨格面宽度不同即异常）、数值不越界；另报告格面切换序列、各态停留时长下界、同可用宽度下的档位来回次数（过密只提示）。
退出码：0 通过（有可量样本、格面发生过变化、无异常）；1 有异常；2 连不上调试口、页面里没有状态条或观察中断；
3 观察期间没有可量样本或格面从未变化（窗口隐藏、会话空闲时会出现），不算通过。
只用标准库（Python 3.8+），不需要 Node。高 DPI 校准：先调整系统或应用缩放，再运行一次。
"""
import argparse
import base64
import json
import os
import socket
import struct
import sys
import urllib.request

# v459 速度格全部格面固定宽 6.6em（随格字号缩放，与 CSS width:6.6em 同源）；极窄档固定 2.75em。
# 精简 chip v469 起按内容定宽（12.4/9.7/6.6em 只是上限），slot_px 返回 None 只查越界。
ICON_EM = 2.75
SLOT_EM = 6.6
# >1h 长计时在固定宽里放不下时数值尾被裁（specs/speed-chip-stable-slot.md 已知名单）：只提示、不算异常，但裁切不得超过上限
KNOWN_CLIP_FACES = {"思考 1:05:00", "思考 1天3时", "思考 23:59:59", "en Think"}
KNOWN_CLIP_PX = 12   # 实测最大约 11px（11px 界面字号 + Verdana）；14px 系统字体 ≤2px


def slot_px(fs, tier):
    """固定格宽（px）；精简档返回 None（不核对宽度，只查越界）。"""
    if tier.startswith("精简"):
        return None
    if tier.split(" ")[-1] == "极窄":
        return ICON_EM * fs
    return SLOT_EM * fs


def ws_connect(url):
    """最小 WebSocket 客户端握手（RFC 6455，仅本文所需子集）。返回 (socket, 已读入的剩余字节)。"""
    if not url.startswith("ws://"):
        raise OSError("unexpected websocket url: " + url[:60])
    hostport, _, path = url[5:].partition("/")
    host, _, port = hostport.partition(":")
    sock = socket.create_connection((host, int(port or 80)), timeout=15)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    request = ("GET /" + path + " HTTP/1.1\r\nHost: " + hostport + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n")
    sock.sendall(request.encode("ascii"))
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            raise OSError("websocket handshake closed early")
        buf += chunk
    head, _, rest = buf.partition(b"\r\n\r\n")
    status = head.split(b"\r\n", 1)[0]
    if b" 101 " not in status:
        raise OSError("websocket handshake failed: " + status.decode("latin-1")[:120])
    return sock, rest


def ws_send(sock, text):
    data = text.encode("utf-8")
    n = len(data)
    head = bytes([0x81])   # FIN + 文本帧
    if n < 126:
        head += bytes([0x80 | n])
    elif n < 65536:
        head += bytes([0x80 | 126]) + struct.pack(">H", n)
    else:
        head += bytes([0x80 | 127]) + struct.pack(">Q", n)
    mask = os.urandom(4)   # 客户端帧必须掩码
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    sock.sendall(head + mask + masked)


def ws_recv(sock, buf):
    """读一条完整消息（处理分片，忽略 ping）。返回 (opcode, payload, 剩余字节)。"""
    def need(count):
        nonlocal buf
        while len(buf) < count:
            chunk = sock.recv(65536)
            if not chunk:
                raise OSError("websocket closed")
            buf += chunk
        out, buf = buf[:count], buf[count:]
        return out

    payload = b""
    while True:
        b1, b2 = need(2)
        fin, opcode = b1 & 0x80, b1 & 0x0F
        n = b2 & 0x7F
        if n == 126:
            n = struct.unpack(">H", need(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", need(8))[0]
        mask = need(4) if b2 & 0x80 else None   # 规范不允许服务端掩码，稳妥起见仍处理
        data = need(n)
        if mask:
            data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        if opcode != 0x9:   # 0x9 ping：不回 pong，等下一条
            payload += data
        if fin:
            return opcode, payload, buf


def evaluate(host, port, expression, timeout=15):
    """在宿主页面里求值一个表达式（等它返回的 Promise）。timeout 秒：持续观察时要覆盖整个观察期。"""
    listing = json.loads(urllib.request.urlopen("http://%s:%d/json/list" % (host, port), timeout=10).read().decode("utf-8"))
    pages = [t for t in listing if t.get("type") == "page"]
    target = next((t for t in pages if "app.asar" in (t.get("url") or "")), pages[0] if pages else None)
    if not target or not target.get("webSocketDebuggerUrl"):
        raise OSError("CDP 调试口上没有页面目标（ZCode 桌面端没在运行？）")
    sock, buf = ws_connect(target["webSocketDebuggerUrl"])
    sock.settimeout(timeout)
    try:
        ws_send(sock, json.dumps({"id": 1, "method": "Runtime.evaluate",
                                  "params": {"expression": expression, "returnByValue": True, "awaitPromise": True}}))
        while True:
            opcode, payload, buf = ws_recv(sock, buf)
            if opcode != 0x1:
                continue
            message = json.loads(payload.decode("utf-8"))
            if message.get("id") == 1:
                break
    finally:
        sock.close()
    result = message.get("result") or {}
    if result.get("exceptionDetails"):
        raise OSError("页面内表达式抛错：" + json.dumps(result["exceptionDetails"].get("exception", {}).get("description", result["exceptionDetails"]))[:300])
    return (result.get("result") or {}).get("value")


def report(out):
    meta = out.get("meta", {})
    print("界面字号基准 %s | 设备像素比 %s | 平台 %s | 语言 %s | 页面隐藏 %s" % (
        meta.get("uiFont"), meta.get("dpr"), meta.get("platform"), meta.get("lang"), meta.get("hidden")))
    print("字体：%s" % meta.get("font"))
    base = str(meta.get("uiFont") or "")
    problems = []
    checked_slots = 0
    print("%-18s %-6s %-10s %-14s %-12s %s" % ("档位 @界面字号", "格字号", "宽度范围", "固定宽(px)", "数值余量", "越界面"))
    for name, row in out.get("tiers", {}).items():
        tier = name.partition(" ")[2]   # 键 = "<界面字号> <主题 档位>"
        fs = float(str(row["fs"]).replace("px", "") or 0)
        slot = slot_px(fs, tier)   # 固定格宽（None=精简档不核对）；极窄档 = 2.75em
        widths = sorted(set(row["speedW"]) | set(row.get("plainW") or row["speedW"]))
        lead = "右 %.2fpx" % row["minSlack"]   # 内容成组靠左（v448），余量只在右侧
        overflow = list(row["overflow"])
        if overflow:
            px = row.get("overflowPx") or {}
            # 已知名单里的长计时面：裁切在上限内只提示（列在「越界面」一栏并标出裁了多少），超限或名单外的面才算异常
            known = [k for k in overflow if k in KNOWN_CLIP_FACES and -KNOWN_CLIP_PX <= float(px.get(k, -99)) < 0]
            bad = [k for k in overflow if k not in known]
            overflow = ["%s（已知裁尾 %.2fpx）" % (k, float(px[k])) if k in known else k for k in overflow]
            if bad:
                problems.append("%s：数值越界 %s" % (name, "、".join("%s（%.2fpx）" % (k, float(px[k])) if k in px else k for k in bad)))
        # v459 全部格面固定宽：任何界面字号都核对（纯 em 随字号等比缩放）；极窄档恒等于 2.75em
        if slot is not None and widths:
            checked_slots += 1
            icon_only = slot == ICON_EM * fs
            bad = [w for w in widths if abs(w - slot) > (1.5 if icon_only else 0.5)]
            if bad:
                problems.append("%s：极窄档应恒为 %.1fpx（2.75em×%s），实测 %s" % (name, slot, row["fs"], "、".join("%.1f" % w for w in bad)) if icon_only else
                                "%s：宽度 %s 应恒为 %.1fpx（6.6em×%s）——全部状态面必须同宽" % (name, "、".join("%.1f" % w for w in bad), slot, row["fs"]))
        span = ("%.1f~%.1f" % (min(widths), max(widths))) if widths else "?"
        target = ("%.1f" % slot) if slot is not None else "?"
        print("%-18s %-6s %-10s %-14s %-12s %s" % (
            name, row["fs"], span, target, lead, "、".join(overflow) or "无"))
    return problems, base, checked_slots


def tier_name(tokens, min_flag):
    """布局签名里的档位类 → 档位名（与 CSS 的四档一一对应）。"""
    if min_flag:
        name = "极窄"
    elif "zu-narrow" in tokens or "zu-speed-tight" in tokens:
        name = "紧张"
    elif "zu-tight" in tokens or "zu-speed-mid" in tokens:
        name = "中等"
    else:
        name = "宽裕"
    return ("药丸 " if "zu-pill" in tokens else "默认 ") + name


def summarize(out):
    """持续观察样本 → (报告行, 异常, 退出码)。异常只有两类硬判据：同一条状态条、同一布局签名下速度格宽度不唯一；
    数值越界。停留时长与档位来回只报告。退出码 1 有异常；3 没有可量样本或格面从未变化（不算通过）；0 通过。"""
    meta, sigs, samples = out.get("meta", {}), out.get("sigs", []), out.get("samples", [])
    every = meta.get("every") or 100
    lines, problems = [], []
    ok = [s for s in samples if "none" not in s]
    skipped = {}
    for s in samples:
        if "none" in s:
            skipped[s["none"]] = skipped.get(s["none"], 0) + 1
    hidden = sum(1 for s in samples if s.get("hid"))
    lines.append("观察 %.0fs（每 %dms 一拍）：采样 %d 拍，可量 %d 拍%s%s" % (
        meta.get("seconds") or 0, every, len(samples), len(ok),
        "，不可量 " + "、".join("%s %d" % kv for kv in sorted(skipped.items())) if skipped else "",
        "，其中窗口隐藏时采得 %d 拍（宿主节流页面定时器，样本变稀）" % hidden if hidden else ""))

    def sig_parts(sid):
        p = (sigs[sid] if isinstance(sid, int) and 0 <= sid < len(sigs) else "").split("|")
        return (p + [""] * 8)[:8]   # 档位类 | 最窄标记 | 格字号 | 条父宽 | 窗口内宽 | 界面字号 | 像素比 | 面类别（plain/tag）

    def tier_of(sid):
        a = sig_parts(sid)
        return tier_name(a[0].split(), a[1] == "1")

    groups, runs, flips, last = {}, {}, {}, {}
    for s in ok:
        # v459：布局 = 签名前 7 段；面类别（第 8 段 plain/tag）只用于报告——全部格面同宽，跨面类别宽度不同就是异常
        g = groups.setdefault((s["b"], "|".join(sig_parts(s["s"])[:7])), {"n": 0, "w": [], "faces": [], "l": [], "ov": 0, "sid": s["s"], "cls": set()})
        g["cls"].add(sig_parts(s["s"])[7])
        g["n"] += 1
        for key, val in (("w", s["w"]), ("l", s["l"]), ("faces", s["f"])):
            if val not in g[key]:
                g[key].append(val)
        g["ov"] += s.get("ov") or 0
        seq = runs.setdefault(s["b"], [])                 # 每条状态条的格面段落：[格面, 首拍, 末拍, 拍数]
        if seq and seq[-1][0] == s["f"]:
            seq[-1][2] = s["t"]
            seq[-1][3] += 1
        else:
            seq.append([s["f"], s["t"], s["t"], 1])
        prev = last.get(s["b"])
        if prev and prev["s"] != s["s"]:
            a, c = sig_parts(prev["s"]), sig_parts(s["s"])
            if a[:7] == c[:7]:
                last[s["b"]] = s   # 只是面类别换了（完成态与带状态词的面占位不同，一轮对话里本就会切几次），不算档位切换
                continue
            flips.setdefault(s["b"], []).append((s["t"], a[3] == c[3] and a[4] == c[4]))
        last[s["b"]] = s

    for (b, _layout), g in sorted(groups.items()):
        a = sig_parts(g["sid"])
        lines.append("  条#%d %s%s｜格字号 %s｜条父宽 %s｜窗口内宽 %s｜界面字号 %s｜像素比 %s：%d 拍，速度格宽 %s，格面 %d 种，水平位置 %d 种，越界 %d 拍" % (
            b, tier_of(g["sid"]), "｜完成态（无状态词）" if g["cls"] == {"plain"} else "", a[2], a[3], a[4], a[5], a[6], g["n"], " / ".join("%.2f" % w for w in g["w"]),
            len(g["faces"]), len(g["l"]), g["ov"]))
        # v459 全部格面固定宽：同一布局下宽度只能有一个值（跨格面的宽度不同就是抖动）
        if len(set(g["w"])) > 1:
            problems.append("条#%d %s 下同一布局宽度不恒定：%s" % (b, tier_of(g["sid"]), "、".join("%.2f" % w for w in sorted(set(g["w"])))))
        if g["ov"]:
            problems.append("条#%d %s 下数值越界 %d 拍" % (b, tier_of(g["sid"]), g["ov"]))

    changes = sum(max(len(r) - 1, 0) for r in runs.values())
    for b, seq in sorted(runs.items()):
        if len(seq) > 1:
            lines.append("  条#%d 格面序列（停留时长是下界）：%s" % (b, " → ".join(
                "%s（%s）" % (x[0], "一拍" if x[3] == 1 else "≥%.1fs" % ((x[2] - x[1]) / 1000.0)) for x in seq[:40]) +
                ("…" if len(seq) > 40 else "")))
    single = [x for seq in runs.values() for x in seq[1:] if x[3] == 1]   # 首段的起点在观察之前，不算
    if single:
        lines.append("  只采到一拍的格面 %d 段（停留短于两拍间隔，长短无法判断；工具执行很快时属正常）：%s" % (
            len(single), "、".join(dict.fromkeys(x[0] for x in single))))
    for b, fl in sorted(flips.items()):
        same = [t for t, same_width in fl if same_width]
        lines.append("  条#%d 档位切换 %d 次（可用宽度未变的 %d 次）" % (b, len(fl), len(same)))
        busiest = max((sum(1 for u in same[i:] if u - t <= 5000) for i, t in enumerate(same)), default=0)
        if busiest >= 4:
            lines.append("  ⚠ 条#%d 同一可用宽度下 5 秒内档位切换 %d 次，疑似折叠振荡，需人工判断" % (b, busiest))

    if not ok:
        lines.append("结论：观察期间没有可量样本（状态条不可见或速度格不在），什么都没验证——让 ZCode 窗口保持可见、对话进行中再跑一次。")
        if meta.get("tsb"):
            lines.append("  页面里有精简样式的速率 chip（.zu-tsb）：持续观察只看状态条里的速度格；精简样式请用默认模式量它的三档静态宽度。")
        return lines, problems, 3
    if not changes:
        lines.append("结论：可量样本里格面从未变化，动态切换没有被观察到（会话空闲，或窗口隐藏时宿主节流页面定时器）——在对话进行中再跑一次。")
        return lines, problems, 3
    lines.append("汇总：%s（可量 %d 拍、格面切换 %d 次、异常 %d）" % ("有异常" if problems else "通过", len(ok), changes, len(problems)))
    return lines, problems, 1 if problems else 0


def main(argv):
    parser = argparse.ArgumentParser(description="速度格实机量宽探针（只读，经 CDP 9229）")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9229)
    parser.add_argument("--watch", type=int, default=0, help="持续观察 N 秒（ZCode 窗口可见、对话进行中时用）")
    parser.add_argument("--every", type=int, default=100, help="--watch 的采样间隔（毫秒）")
    args = parser.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")   # Windows 旧控制台编不出个别字符时用 ? 代替，不中断
    here = os.path.dirname(os.path.abspath(__file__))
    if args.watch:
        with open(os.path.join(here, "speed-slot-live-watch.js"), "r", encoding="utf-8") as fh:
            expression = "(%s)(%s)" % (fh.read(), json.dumps({"seconds": args.watch, "every": args.every}))
        try:
            out = evaluate(args.host, args.port, expression, timeout=args.watch + 30)
        except (OSError, ValueError) as exc:
            print("连不上或观察中断：%s" % exc)
            return 2
        if not isinstance(out, dict) or "samples" not in out:
            print("无法观察：%s" % (out if not isinstance(out, dict) else out.get("error", out)))
            return 2
        lines, problems, code = summarize(out)
        print("界面字号基准 %s | 设备像素比 %s | 平台 %s | 窗口内宽 %s | 观察结束时窗口隐藏 %s" % (
            out.get("meta", {}).get("uiFont"), out.get("meta", {}).get("dpr"), out.get("meta", {}).get("platform"),
            out.get("meta", {}).get("width"), out.get("meta", {}).get("hiddenAtEnd")))
        for line in lines:
            print(line)
        for line in problems:
            print("  ✗ " + line)
        return code
    with open(os.path.join(here, "speed-slot-live-probe.js"), "r", encoding="utf-8") as fh:
        expression = fh.read()
    try:
        out = evaluate(args.host, args.port, expression)
    except (OSError, ValueError) as exc:
        print("连不上或无法执行：%s" % exc)
        return 2
    if not isinstance(out, dict) or out.get("error"):
        print("无法量取：%s" % (out.get("error") if isinstance(out, dict) else out))
        return 2
    problems, base, checked = report(out)
    print("汇总：%d 组，异常 %d 组（%d 个档位已核对固定宽 6.6em / 极窄 2.75em，精简档只查越界）" % (len(out.get("tiers", {})), len(problems), checked))
    for line in problems:
        print("  ✗ " + line)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
