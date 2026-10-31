# -*- coding: utf-8 -*-
"""ZCode token 用量 MCP server（stdio, 零依赖；注册名 zcode-token-usage-statusbar）。

提供工具 token_usage(scope)：current(默认)/today/days:N/sessions[:N]/models[:days]/session:<id前缀>/workspace:<目录关键词>。
协议仅实现 initialize / tools/list / tools/call；调试信息只走 stderr。

启动时附带一项安装链补救（issue #163）：待替换 asar 包（客户端运行中安装遗留）的
唯一收尾者是安装监控进程，被提前关闭后独立安装链没有 SessionStart hook 重建它，
pending 会永久搁浅、状态条永不出现。MCP 进程由宿主随会话启动拉起，是独立链唯一
的会话级入口——检测到有效待收尾包且无存活监控时，静默重新拉起（无窗口，等客户端
退出后自动完成替换）。任何失败都不影响查询服务。
"""
import contextlib
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import zusage  # noqa: E402

PROTOCOL_VERSION = "2024-11-05"

L = zusage.L   # 输出语言与 CLI 同源（config.json 的 "lang"）


def revive_finalize_monitor():
    """待收尾包监控的尽力复活：config 所在目录即运行目录（独立链=数据目录，
    插件链 config 不在插件目录、回退标准数据目录，--dev=仓库目录），与待收尾包
    sidecar 记录的运行时目录一致，收尾来源授权才能通过。诊断走 stderr，绝不碰
    stdout（stdio 协议通道）。"""
    try:
        cfg_path = Path(__file__).parent / "config.json"
        if not cfg_path.is_file():
            cfg_path = Path.home() / ".zcode" / "zcode-token-usage-statusbar" / "config.json"
        asar = json.loads(cfg_path.read_text(encoding="utf-8")).get("asar_path")
        if not isinstance(asar, str) or not asar:
            return   # 无安装目标记录（未完成过安装）：无事可做
        import patch_install as pi   # 与本脚本同目录（运行清单/插件目录都携带）
        pi.set_target(asar)
        pi.set_runtime(cfg_path.parent)
        # cancelled 的 journal（卸载撤销/发布中断遗留）不是待收尾包：拉起只会得到
        # 一个被来源授权立即拒绝退出的监控进程，等下次 install 清理即可。
        if pi.pending_operation() not in ("install", "remove"):
            return
        with pi.monitor_instance_lock() as acquired:
            if not acquired:
                return   # 已有监控在收尾：不叠加进程（与 launch_monitor 内部去重同款前置）
        # 试锁成功即释放，锁的长期持有者是监控进程自己；探测与拉起间的极小竞态由
        # launch_monitor 的去重兜底（后到的监控抢锁失败会自行退出）。
        os.environ["ZUSAGE_MONITOR_QUIET"] = "1"   # 无窗口静默收尾；不弹窗打断查询
        with contextlib.redirect_stdout(sys.stderr):   # launch_monitor 的失败提示只许走 stderr
            pi.launch_monitor(time.time())
    except Exception as e:  # noqa: BLE001
        print(f"[zusage] monitor revive skipped: {e}", file=sys.stderr)


def tool_token_usage(scope: str = "current") -> str:
    con = zusage.connect()
    try:
        if scope in ("current", "now"):
            return zusage.render_current(con)
        if scope == "today":
            return zusage.render_today(con)
        if scope.startswith("days:"):
            return zusage.render_days(con, int(scope.split(":", 1)[1]))
        if scope == "week":
            return zusage.render_days(con, 7)
        if scope.startswith("sessions"):
            n = int(scope.split(":", 1)[1]) if ":" in scope else 10
            return zusage.render_sessions(con, n)
        if scope.startswith("models"):
            d = int(scope.split(":", 1)[1]) if ":" in scope else 7
            return zusage.render_models(con, d)
        if scope.startswith("session:"):
            return zusage.render_session_detail(con, scope.split(":", 1)[1].strip())
        if scope.startswith("workspace:"):
            return zusage.render_workspace(con, scope.split(":", 1)[1].strip())
        return L(f"未知 scope: {scope!r}。可用: current | today | week | days:N | sessions[:N] | models[:days] | session:<id前缀> | workspace:<目录关键词>",
                 f"Unknown scope: {scope!r}. Available: current | today | week | days:N | sessions[:N] | models[:days] | session:<id prefix> | workspace:<dir keyword>")
    finally:
        con.close()


TOOLS = [
    {
        "name": "token_usage",
        "description": (
            L("查询 ZCode 的 token 用量（数据来自本地 db.sqlite，只读）。"
              "scope 可选: current(当前会话+今日,默认), today, week, days:N(近N天每日), "
              "sessions:N(最近N个会话), models:days(按模型), session:<id前缀>(指定会话,含按模型与子代理明细), "
              "workspace:<目录关键词>(按工作区聚合主会话+子代理,含按会话与按模型明细)。",
              "Query ZCode token usage (from the local db.sqlite, read-only). "
              "scope: current(current session+today, default), today, week, days:N(last N days per day), "
              "sessions:N(last N sessions), models:days(by model), session:<id prefix>(specific session, with per-model and subagent details), "
              "workspace:<dir keyword>(aggregate a workspace's main sessions+subagents, with per-session and per-model details).")
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "scope": {
                    "type": "string",
                    "description": L("查询范围，默认 current", "Query scope, default current"),
                }
            },
        },
    }
]


_NOTIFY = object()   # 「无 id 成员」（JSON-RPC 通知）哨兵：与显式 "id": null（仍是请求，须回 id null）区分


def reply(req_id, result):
    if req_id is _NOTIFY:
        return   # 通知不回响应
    print(json.dumps({"jsonrpc": "2.0", "id": req_id, "result": result}), flush=True)


def reply_error(req_id, code, message):
    # 无效帧（-32700/-32600）按规范回 id=null；合法请求的错误本就带 id。
    # 通知（合法帧无 id 成员）的分支错误由调用方先判哨兵再调，不走到这里。
    if req_id is _NOTIFY and code not in (-32700, -32600):
        return
    print(json.dumps({"jsonrpc": "2.0", "id": req_id,
                      "error": {"code": code, "message": message}}), flush=True)


def main():
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            reply_error(None, -32700, "parse error")
            continue
        # 一帧坏消息（batch 数组、params 非对象等）不能带崩整个 server 进程；
        # 本 server 不实现 batch，按规范回 -32600（协议只实现 initialize/ping/tools-*/call）。
        if not isinstance(msg, dict):
            reply_error(None, -32600, "invalid request: batch is not supported")
            continue
        method = msg.get("method", "")
        req_id = msg["id"] if "id" in msg else _NOTIFY   # 显式 id:null 是请求（回 id null），非通知
        params = msg.get("params")
        if not isinstance(params, dict):
            params = {}
        if method == "initialize":
            # 只声明支持的协议版本：请求了未知版本时按规范回自身版本，不做假能力承诺
            requested = params.get("protocolVersion")
            reply(
                req_id,
                {
                    "protocolVersion": requested if requested == PROTOCOL_VERSION else PROTOCOL_VERSION,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "zcode-token-usage", "version": "1.0.0"},
                },
            )
        elif method == "ping":
            reply(req_id, {})
        elif method == "tools/list":
            reply(req_id, {"tools": TOOLS})
        elif method == "tools/call":
            name = params.get("name")
            if name != "token_usage":
                # 忽略 name 曾让任意工具名都执行 token_usage；未知/缺失工具名按规范报错
                if req_id is not _NOTIFY:
                    reply_error(req_id, -32602, f"unknown tool: {name!r}")
                continue
            args = params.get("arguments") or {}
            if not isinstance(args, dict):
                if req_id is not _NOTIFY:
                    reply_error(req_id, -32602, "arguments must be an object")
                continue
            try:
                text = tool_token_usage(**args)
                reply(req_id, {"content": [{"type": "text", "text": text}], "isError": False})
            except Exception as e:  # noqa: BLE001
                hint = ""
                if isinstance(e, sqlite3.OperationalError):
                    # 库结构漂移（ZCode 升级改列/表）给出可行动提示，与 zusage.py CLI 同款
                    hint = L("\n多半是 ZCode 升级改了用量库结构（表/列变更）。请更新本插件后再查询；"
                             "已落库的历史数据不受影响。",
                             "\nMost likely ZCode changed the usage DB schema in an update. "
                             "Update this plugin before querying; stored history is unaffected.")
                reply(
                    req_id,
                    {
                        "content": [{"type": "text",
                                     "text": L(f"查询失败: {e}", f"Query failed: {e}") + hint}],
                        "isError": True,
                    },
                )
        else:
            if req_id is not _NOTIFY:
                reply_error(req_id, -32601, f"unknown method {method}")


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    revive_finalize_monitor()
    main()
