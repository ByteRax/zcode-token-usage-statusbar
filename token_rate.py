#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""逐问 token 输出速率：从 ZCode 自身 usage 数据库（model_usage 表）计算真实生成速率。

用法：
  python3 token_rate.py                  最近一次请求 + 会话统计（人类可读）
  python3 token_rate.py --turn           最新一问（本次提问触发的轮次）即时速率
  python3 token_rate.py --turn --current
                                         同上，但本问尚无入库数据时输出为空（--current 守卫，
                                         无身份时仅严格时间过滤，不保证轮次归属）
  python3 token_rate.py --turn --turn-id turn_x --session sess_x
                                         固定宿主轮次身份，不依赖提问时间状态
  python3 token_rate.py --json           JSON 输出
  python3 token_rate.py --session sess_xxx 显式指定会话（优先于下面两个环境变量；钩子下达
                                         的统计指令带此参数，防止模型迟迟才跑该命令时，
                                         并行会话抢先提问把"最近提问会话"状态覆盖掉）
  ZCODE_SESSION_ID=xxx python3 ...       只统计指定会话
  ZCODE_USAGE_DB=/path/db.sqlite         指定数据库路径（默认按用户主目录解析）
  ZUSAGE_RATE_STATE_FILE=/path           指定钩子状态文件（测试接缝）

只读打开 WAL 数据库，不影响运行中的客户端。
速率口径（2026-10-14 据真库 raw_usage_json 与思考段时间分布裁决）：
  分子 = output_tokens（ZCode 的该列已包含思考 token，provider 原生 totalTokens
  = input + output 不另加 reasoning，不能再相加）；
  分母 = 纯生成时长——无思考段 completed_at − first_token_at，含思考段默认
  completed_at − started_at（思考 token 在 first_token_at 之前流出，窗口须前移）；
  「首块即落章」provider 例外（first_token_covers：ttft 不随推理量增长的供应商，
  思考在首字后随输出流出，首字窗口已含思考）改用 completed_at − first_token_at。
  按段累加，段间工具等待不计入。Claude 系列不单独上报思考 token（reasoning_tokens
  恒为 0）也按含思考段计时（2026-10-15 真库裁决，见 hides_reasoning）。
  会话均 = 全会话加权平均（Σ可评分段输出 ÷ Σ生成窗口，aggregate_requests 同款），
  与「近N次均」的算术平均互补：长段权重自然，不被碎片小段拉偏（2026-10-30 增加）。
"""
import json
import math
import os
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

from runtime_lock import file_lock
from usage_stats import (MIN_GEN_MS, MAX_GEN_MS, hides_reasoning, request_stats,
                         aggregate_requests)

DB_PATH = os.environ.get("ZCODE_USAGE_DB") or str(
    Path.home() / ".zcode" / "cli" / "db" / "db.sqlite")
# 钩子状态文件：记录"用户最后所处的会话"与最近提问时刻（--current 守卫依赖 promptTs）
STATE_FILE = os.environ.get("ZUSAGE_RATE_STATE_FILE") or str(
    Path.home() / ".zcode" / "zusage-rate.last-session.json")
STATE_TTL_MS = 7 * 24 * 3600 * 1000  # 过旧的状态文件视为失效
N = 5                 # 上轮行的统计窗口（均/峰）


def valid_state_ts(value, now=None):
    now = time.time() * 1000 if now is None else now
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and 0 <= now - value <= STATE_TTL_MS)


def read_state():
    try:
        st = json.loads(Path(STATE_FILE).read_text(encoding="utf-8"))
    except Exception:
        return None
    return st if isinstance(st, dict) and valid_state_ts(st.get("ts")) else None


def _replace_state_file(tmp, path):
    """os.replace 短暂重试：Windows 上读者/杀软正打开目标文件时（无 FILE_SHARE_DELETE）
    替换会被拒绝，静默放弃会丢掉提问时刻、让 --current 守卫整轮失效；读者都是微秒级
    短开，重试窗口远大于它。POSIX 的 rename 不受并发读者影响，重试零成本。"""
    for attempt in range(20):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 19:
                raise
            time.sleep(0.01)


def write_session_state(session_id, source):
    """持久文件锁内合并每会话提问时刻，再原子替换；会话启动不伪造提问。"""
    path = Path(STATE_FILE)
    tmp = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with file_lock(str(path) + ".lock"):
            now = int(time.time() * 1000)
            try:
                prev = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                prev = None
            prompts = prev.get("prompts") if isinstance(prev, dict) else None
            # 迁移仅含全局字段的旧状态，且不把 SessionStart 的 ts 当提问。
            if not isinstance(prompts, dict):
                prompts = {}
                if isinstance(prev, dict) and prev.get("sessionId") \
                        and valid_state_ts(prev.get("promptTs"), now):
                    prompts[prev["sessionId"]] = prev["promptTs"]
            prompts = {k: v for k, v in prompts.items() if valid_state_ts(v, now)}
            if source == "prompt-submit":
                prompts[session_id] = max(prompts.get(session_id, 0), now)
            data = {"sessionId": session_id, "ts": now, "source": source, "prompts": prompts}
            if session_id in prompts:
                data["promptTs"] = prompts[session_id]
            fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(data, stream)
            _replace_state_file(tmp, path)
    except Exception:
        pass
    finally:
        if tmp is not None:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass


def open_db():
    """只读连接；库不存在/损坏返回 None（连接 ro URI 失败不会新建空库）。"""
    try:
        con = sqlite3.connect(f"file:{Path(DB_PATH).as_posix()}?mode=ro", uri=True, timeout=3)
        con.row_factory = sqlite3.Row
        return con
    except sqlite3.OperationalError:
        return None


def fallback_session_id(db):
    """未显式指定会话时：状态文件里"用户最后所处的会话"（切会话即跟随）→ 全局最近完成的会话。"""
    st = read_state()
    if st and st.get("sessionId"):
        return st["sessionId"]
    if db is None:
        return None
    row = db.execute(
        "select session_id from model_usage where status='completed'"
        " order by completed_at desc limit 1").fetchone()
    return row[0] if row else None


def _has_provider_col(db):
    """旧库可能没有 provider_id 列（见 _provider_fallback 的同款降级）：缺列时不把
    该列选进 scope，request_stats 对缺列行按默认窗口容错，别让整条查询崩掉。"""
    if db is None:
        return False
    try:
        return any(r[1] == "provider_id" for r in db.execute("pragma table_info(model_usage)"))
    except sqlite3.OperationalError:
        return False


def scope_for(db, sid):
    """有 main_turn 数据时只统计 main_turn，否则回退为该会话全部请求。"""
    cols = ("model_id, output_tokens, reasoning_tokens, input_tokens,"
            " cache_read_input_tokens, started_at, first_token_at, completed_at,"
            " time_to_first_token_ms, status")
    if _has_provider_col(db):
        cols += ", provider_id"
    base = f"select {cols} from model_usage where status='completed' and query_source='main_turn'"
    tail = " and session_id = ?" if sid else ""
    args = [sid] if sid else []
    if db is not None:
        try:
            has_main = db.execute(base + tail + " limit 1", args).fetchone()
        except sqlite3.OperationalError:
            has_main = None
        if not has_main:
            base = base.replace(" and query_source='main_turn'", "")
    return base + tail, args


def first_token_covers(db):
    """「首块即落章」provider 集合（fork z1908144712 判据收编，与 zusage
    _provider_first_token_covers 同一规则）：对该 provider 的 (reasoning_tokens,
    time_to_first_token_ms) 做最小二乘斜率，<2.0 ms/token 说明首字时间不随推理量
    增长——思考在首字后随输出流出，首字窗口已含思考，按 started_at 计时会把输入
    预处理摊进生成耗时（速度偏低）。样本 <5/推理量无变化不判（走推理前置默认）。
    本脚本一次性进程，每次调用现算（聚合 ~17ms）。"""
    out = set()
    if db is None:
        return frozenset(out)
    try:
        rows = db.execute(
            """select provider_id, count(*) n,
                      sum(reasoning_tokens) sx, sum(time_to_first_token_ms) sy,
                      sum(reasoning_tokens * time_to_first_token_ms) sxy,
                      sum(reasoning_tokens * reasoning_tokens) sxx
               from model_usage
               where reasoning_tokens > 0 and time_to_first_token_ms is not null
                 and provider_id is not null
               group by provider_id""").fetchall()
    except sqlite3.OperationalError:
        return frozenset(out)   # 旧库缺列：判不出就全走既有口径
    for r in rows:
        n = r["n"] or 0
        sx = r["sx"] or 0
        denom = n * (r["sxx"] or 0) - sx * sx
        if n < 5 or denom <= 0:
            continue
        slope = (n * (r["sxy"] or 0) - sx * (r["sy"] or 0)) / denom
        if slope < 2.0:
            out.add(r["provider_id"])
    return frozenset(out)


def to_item(r, covers=frozenset()):
    item = request_stats(r, covers)
    item.update(inputTokens=r["input_tokens"] or 0,
                cacheRead=r["cache_read_input_tokens"] or 0)
    return item


def session_aggregate(db, scope_sql, args, rated, covers=frozenset()):
    """会话累计用独立 SUM（不受窗口限制）；均/峰由已评分窗口计算。
    sessionAvg = 全会话加权平均：把 scope 内全部行过一遍 request_stats 后交给
    aggregate_requests（Σ可评分输出 ÷ Σ生成窗口），长段权重自然；「近N次均」是
    算术平均，两者互补。全会话行数即会话请求量（几百行毫秒级），一次性进程可接受。"""
    if db is None:
        return None
    row = db.execute(
        f"select count(*), coalesce(sum(output_tokens),0), coalesce(sum(reasoning_tokens),0),"
        f" coalesce(sum(input_tokens),0), coalesce(sum(cache_read_input_tokens),0)"
        f" from ({scope_sql})", args).fetchone()
    whole = aggregate_requests(to_item(r, covers) for r in db.execute(scope_sql, args))
    return {
        "samples": len(rated),
        "requests": row[0],
        "avg": _round1(sum(i["tokPerSec"] for i in rated) / len(rated)) if rated else None,
        "max": max(i["tokPerSec"] for i in rated) if rated else None,
        "min": min(i["tokPerSec"] for i in rated) if rated else None,
        "sessionAvg": whole["tokPerSec"],
        "totalOutput": row[1],
        "totalReasoning": row[2],
        "totalInput": row[3],
        "totalCacheRead": row[4],
    }


def query_latest(session_id=None):
    """最近一次完成请求 + 会话统计（prompt-submit 注入的「上轮」行用）。"""
    db = open_db()
    try:
        sid = session_id or fallback_session_id(db)
        scope_sql, args = scope_for(db, sid)
        if db is None:
            items, rated, session = [], [], None
        else:
            covers = first_token_covers(db)
            rows = db.execute(scope_sql + " order by completed_at desc limit ?", args + [N]).fetchall()
            items = [to_item(r, covers) for r in rows]
            rated = [i for i in items if i["tokPerSec"] is not None]
            session = session_aggregate(db, scope_sql, args, rated, covers)
        latest = items[0] if items else None
        return {"sessionId": sid, "latest": latest, "session": session, "history": items[::-1]}
    finally:
        if db is not None:
            db.close()


# 一次用户消息的各段共享 turn_id。按整轮最早 started_at 排序，不能用完成时间：
# 上轮迟到的完成/工具后续段可能比本轮更晚，但轮次身份仍属上轮。
def latest_turn_id(db, sid, prompt_ts=None):
    if db is None:
        return None
    sql = ("select turn_id from model_usage where session_id=? and query_source='main_turn'"
           " and turn_id is not null and turn_id != '' group by turn_id")
    args = [sid]
    if prompt_ts is not None:
        # 时间仅是旧宿主的有限兼容过滤，不证明身份；不允许向前借用旧轮。
        sql += " having min(started_at) >= ?"
        args.append(prompt_ts)
    try:
        row = db.execute(sql + " order by min(started_at) desc, turn_id desc limit 1", args).fetchone()
    except sqlite3.OperationalError:
        return None
    return row[0] if row else None


def last_prompt_ts(session_id=None, state=None):
    """仅接受本会话的有效提问时刻；映射缺项不借别的会话/SessionStart 的时刻。"""
    st = read_state() if state is None else state
    if not st:
        return None
    sid = session_id or st.get("sessionId")
    prompts = st.get("prompts")
    if isinstance(prompts, dict):
        ts = prompts.get(sid)
    elif st.get("sessionId") == sid:
        ts = st.get("promptTs")
    else:
        ts = None
    return ts if valid_state_ts(ts) else None


def query_turn(session_id=None, current=False, turn_id=None):
    db = open_db()
    try:
        sid = session_id or fallback_session_id(db)
        if not sid:
            return {"sessionId": None, "turnId": None, "turn": None, "session": None}
        scope_sql, args = scope_for(db, sid)
        session = None
        if db is not None:
            covers = first_token_covers(db)
            win = db.execute(scope_sql + " order by completed_at desc limit ?", args + [N]).fetchall()
            rated = [i for i in (to_item(r, covers) for r in win) if i["tokPerSec"] is not None]
            session = session_aggregate(db, scope_sql, args, rated, covers)
        prompt_ts = last_prompt_ts(sid) if current else None
        if current and turn_id is None and prompt_ts is None:
            return {"sessionId": sid, "turnId": None, "turn": None,
                    "noCurrentTurnData": True, "currentTurnUnavailableReason": "missingPromptState", "session": session}
        identity_source = "explicitTurnId" if turn_id else ("promptTimeCompatibility" if current else "latestTurn")
        turn_id = turn_id or latest_turn_id(db, sid, prompt_ts)
        if not turn_id or db is None:
            result = {"sessionId": sid, "turnId": turn_id, "turn": None, "session": session}
            if current:
                has_identity = db is not None and latest_turn_id(db, sid) is not None
                result.update(noCurrentTurnData=True,
                              currentTurnUnavailableReason="noMatchingTurn" if has_identity else "missingTurnIdentity")
            return result
        try:
            rows = db.execute(scope_sql + " and turn_id = ? order by started_at asc, completed_at asc",
                              args + [turn_id]).fetchall()
        except sqlite3.OperationalError:
            rows = []
        if not rows:
            result = {"sessionId": sid, "turnId": turn_id, "turn": None, "session": session,
                      "turnIdentitySource": identity_source, "currentTurnIdentityVerified": False}
            if current:
                result.update(noCurrentTurnData=True, currentTurnUnavailableReason="noMatchingTurn")
            return result
        items = [to_item(r, covers) for r in rows]
        turn = aggregate_requests(items)
        turn.update(ttftMs=items[0]["ttftMs"], firstAt=items[0]["completedAt"],
                    lastAt=max(i["completedAt"] for i in items))
        return {"sessionId": sid, "turnId": turn_id, "turn": turn, "session": session,
                "turnIdentitySource": identity_source,
                "currentTurnIdentityVerified": identity_source == "explicitTurnId"}
    finally:
        if db is not None:
            db.close()


# 紧凑单位（注入行等需一眼扫读处）：千以下原始、千~万一位小数 k、万~百万取整 k、百万以上一位小数 M
def fmt_compact(n):
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 10_000:
        return f"{round(n / 1000)}k"
    if n >= 1000:
        return f"{n / 1000:.1f}k"
    return str(n)


def fmt_num(n):
    return f"{n:,}"


def fmt_kmb(n):
    # 在原始 token 数上做半数进位，避免浮点缩放及 Python 偶数舍入差异。
    if n >= 1_000_000_000:
        return f"{(n + 5_000_000) // 10_000_000 / 100:.2f}B"
    if n >= 1_000_000:
        return f"{(n + 5_000) // 10_000 / 100:.2f}M"
    if n >= 1000:
        return f"{(n + 50) // 100 / 10:.1f}K"
    return str(n)


# 万/亿单位（本问统计行缺省；渲染端「中文单位」开关关闭时经 --no-cn-units 退回千分位/k）：≥1 亿用亿、
# ≥1 万用万，至多两位小数去尾零、数字与单位不留空格（58.25万 / 142万 / 1亿），不足 1 万沿用千分位。与 overlay.js fmt() 同规则。
def fmt_cn(n):
    if n >= 100_000_000:
        return _cn_unit(n / 100_000_000) + "亿"
    if n >= 10_000:
        return _cn_unit(n / 10_000) + "万"
    return fmt_num(n)


def _cn_unit(x):
    return f"{x:.2f}".rstrip("0").rstrip(".")


def _hhmmss(ms):
    return time.strftime("%H:%M:%S", time.localtime(ms / 1000))


def _cn_fulltime(ms):
    """本问统计行的采样时刻：完整中文日期时间（2026 年 10 月 23 日 11 点 20 分 28 秒），数字不补零。"""
    t = time.localtime(ms / 1000)
    return (f"{t.tm_year} 年 {t.tm_mon} 月 {t.tm_mday} 日 "
            f"{t.tm_hour} 点 {t.tm_min} 分 {t.tm_sec} 秒")


def _sec(ms):
    return f"{ms / 1000:.1f}" if isinstance(ms, (int, float)) else "-"


def _round1(x):
    """一位小数；整数值去掉 .0（JS Math.round 的显示口径：400 而非 400.0）。"""
    r = round(x, 1)
    return int(r) if r == int(r) else r


# 本问统计行（回复收尾自测用）。调用方判定 turn 为空时（含 --current 守卫）不显示任何行。
# cn 缺省 True 与渲染端「中文单位」开关默认开启一致；只有开关关闭时 inject-main 才传 --no-cn-units。
def format_turn_line(r, cn=True, force_kmb=False):
    t = r.get("turn")
    if not t:
        return "暂无本轮请求记录"
    num = fmt_kmb if force_kmb else (fmt_cn if cn else fmt_num)
    big = fmt_kmb if force_kmb else (fmt_cn if cn else fmt_compact)
    parts = [
        f"⚡ {t['tokPerSec'] if t['tokPerSec'] is not None else '-'} token/s(本轮)",
        f"首字 {_sec(t['ttftMs'])}s",
        f"输出 {num(t['totalOutput'])}"
        f"{'(含 ' + num(t['totalReasoning']) + ' 思考)' if t['totalReasoning'] else ''}"
        f" token / 生成 {_sec(t['genMs']) if t['genMs'] > 0 else '-'}s",
    ]
    if t["requests"] > 1:
        parts.append(f"{t['requests']} 段 / 峰 {t['peak']} token/s" if t["peak"] is not None else f"{t['requests']} 段 / 峰 -")
    if r.get("session"):
        s = r["session"]
        if s.get("sessionAvg") is not None:
            parts.append(f"会话均 {s['sessionAvg']} token/s")
        parts.append(f"累计 {big(s['totalOutput'])} token")
    parts.append(f"⏱ {_cn_fulltime(t['lastAt'])}")
    return " · ".join(parts)


# 上轮行（prompt-submit 注入、CLI 默认输出用）
def format_line(r):
    l = r.get("latest")
    if not l:
        return "暂无已完成的模型请求"
    parts = [
        f"⚡ {l['tokPerSec'] if l['tokPerSec'] is not None else '-'} token/s(上轮)",
        f"首字 {_sec(l['ttftMs'])}s",
        f"输出 {fmt_num(l['outputTokens'])}"
        f"{'(含 ' + fmt_num(l['reasoningTokens']) + ' 思考)' if l['reasoningTokens'] else ''}"
        f" token / 生成 {_sec(l['genMs'])}s",
    ]
    s = r.get("session")
    if s:
        if s["samples"]:
            parts.append(f"近{s['samples']}次均 {s['avg']} / 峰 {s['max']} token/s")
        if s.get("sessionAvg") is not None:
            parts.append(f"会话均 {s['sessionAvg']} token/s")
        parts.append(f"累计 {fmt_compact(s['totalOutput'])} token")
    parts.append(f"⏱ {_hhmmss(l['completedAt'])}")
    return " · ".join(parts)


def _value_arg(argv, name):
    """解析 --session <id> / --session=<id>；返回 None 表示命令行未显式指定。"""
    for i, a in enumerate(argv):
        if a == name:
            return argv[i + 1] if i + 1 < len(argv) else None
        if a.startswith(name + "="):
            return a[len(name) + 1:]
    return None


def main(argv):
    json_out = "--json" in argv
    # 显式 --session 优先级最高：钩子下达统计指令时会带上本会话 id（见 prompt-submit.py），
    # 模型执行该命令的时刻可能远晚于钩子触发，其间若有并行会话提问，会改写状态文件里
    # "用户最后所处的会话"（fallback_session_id 的依据），env 变量在 Bash 工具里也不存在，
    # 没有 --session 时会错把别的会话的数据当成本问结果（2026-10-15 真机事故）。
    sid = (_value_arg(argv, "--session") or os.environ.get("ZCODE_SESSION_ID")
           or os.environ.get("CLAUDE_SESSION_ID") or None)
    if "--turn" in argv:
        r = query_turn(sid, current="--current" in argv, turn_id=_value_arg(argv, "--turn-id"))
        if json_out:
            print(json.dumps(r, ensure_ascii=False))
        elif r.get("turn"):
            print(format_turn_line(r, cn="--no-cn-units" not in argv, force_kmb="--force-kmb" in argv))
        # --current 且本问尚无数据：不输出任何行，调用方据此不显示统计（绝不回退到上一轮）
    else:
        r = query_latest(sid)
        if json_out:
            print(json.dumps(r, ensure_ascii=False))
        else:
            print(format_line(r))
            s = r.get("session")
            if s:
                print(f"会话累计:输出 {fmt_num(s['totalOutput'])}"
                      f"{'(含 ' + fmt_num(s['totalReasoning']) + ' 思考)' if s['totalReasoning'] else ''}"
                      f" token · 输入 {fmt_num(s['totalInput'])} token(其中缓存读 {fmt_num(s['totalCacheRead'])})"
                      f" · 请求 {s['requests']} 次"
                      f"{' · 平均 ' + str(s['sessionAvg']) + ' token/s' if s.get('sessionAvg') is not None else ''}")
    return 0


if __name__ == "__main__":
    # Windows 默认（无全局 PYTHONUTF8）下中文输出会按区域编码（GBK 等）写管道，
    # 逐问速率行经代理终端/对话流展示前按 UTF-8 解码——与 usage_mcp.py 同款防护。
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    sys.exit(main(sys.argv[1:]))
