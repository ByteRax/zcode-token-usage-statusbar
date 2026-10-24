<div align="center">

# ZCode Token Speed Status Bar

**Adds a small status bar to the bottom of your ZCode chat window: how fast the model is going, how many tokens you've spent, how much context is left — all at a glance.**

A third-party plugin for the [ZCode](https://zcode.z.ai) desktop app (not an official ZCode feature) — listed in the marketplace as **ZCode Token Usage Statusbar**. It also ships a command-line tool and an MCP tool for digging through usage history — if you don't know what MCP is, you can safely ignore that part.

A ZCode plugin that keeps generation speed (tok/s), time to first token (TTFT), token usage and context window utilization visible in your conversation. Includes usage reports, subagent details and MCP queries.

English · [简体中文](README.md)

Windows / macOS · Python 3.8+ · [MIT](LICENSE)

![ZCode Token Speed Status Bar promo](docs/promo/promo.en.png)

</div>

**Install it in three steps:** send this to ZCode:

```text
Install or update the ZCode plugin https://github.com/ByteRax/zcode-token-usage-statusbar#plugin-releases, then run /install-overlay when it's done
```

It installs the plugin, then runs `/install-overlay` to put the bar in place — if it doesn't run it for you, type it in the chat yourself. Then **quit ZCode completely and reopen it** (closing the window doesn't count); the little bar shows up at the bottom. The `#plugin-releases` at the end pins the officially released stable build — it auto-updates from ⚙, so don't drop it from the URL.

Can't reach GitHub from your network (mainland China)? Send ZCode this instead (the trailing `.git` is required; this route needs local [Git](https://git-scm.com/downloads)):

```text
Install or update the ZCode plugin https://gitcode.com/tanranran/zcode-token-usage-statusbar.git#plugin-releases-gitcode, then run /install-overlay when it's done
```

[Quick start](#quick-start) · [FAQ](#faq) · [Screenshots](docs/features.md)

---

## What it looks like once it's installed

A thin bar appears along the bottom of the chat window, roughly like this:

```text
⚡ 86 t/s │ 62.5k 90% 7 Σ18.4s ⏱1.4s │ 1.45M 86% 23 187 │ 142 🔴2 │ 3.42M │ 236k 🟢 │ ⚙
   Speed        This turn             Session total       Tools     Today    Sub-agents   Settings
```

Here's what each part tells you:

| The bit | In plain English |
|---|---|
| ⚡ **86 t/s** | How fast the model is writing (tokens per second). Once a turn finishes it's colour-coded: ≥70 green, 40–70 yellow, <40 red |
| **62.5k 90% 7 Σ18.4s ⏱1.4s** | This turn: 62.5k tokens spent, 90% cache hit rate, 7 model requests, the most recent one took 18.4s, and you waited 1.4s for the first token |
| **1.45M 86% 23 187** | The whole conversation so far: 1.45M tokens, 86% hit rate, 23 turns, 187 requests |
| **142 🔴2** | Tools were called 142 times, 2 of them errored (small red marker) |
| **3.42M** | Every conversation today added up: 3.42M tokens |
| **236k 🟢** | The sub-tasks the model sent out on its own (subagents) used 236k tokens; 🟢 means one is still running |
| **⚙** | Click for: which items to show, interface language, token unit display, update checks |

Context usage doesn't take a slot on the bar — look at the **context button** in the composer toolbar (a ring icon plus a percentage). It changes colour as it fills up; if a request gets rejected for running over, it tells you what to do. Clicking it opens a panel that includes a **one-click compact** button.

**Hover any of them and you get the finer breakdown.** For the real thing, see the [feature screenshots](docs/features.md).

## Where to look for the thing you want

| What you're wondering | Where to find it |
|---|---|
| How fast is the model right now? | The **t/s** on the far left — the colour tells you at a glance |
| How long did I wait after hitting enter? | The ⏱ number in **This turn** (that's the TTFT / time to first token) |
| How many tokens did this turn / this conversation / today use? | The **This turn**, **Session total** and **Today** items |
| Is this conversation going to run out of room? | The **context button** — it changes colour as it fills up, with one-click compact inside |
| How much did the cache save me? How much did the "thinking" cost? | Hover **This turn** for input, output, cache-read and thinking detail |
| What did the model's sub-tasks cost? How fast are they running? | The **Sub-agents** item — while running it shows "Subagents running ×N · est X t/s" right on the bar |
| How much plan quota / balance is left? | The **quota chip** left of the context button |
| Did a tool call fail? | The **Tools** item — errors light up red |
| Looking through history | Type `/usage` in the chat, run `python zusage.py` in a terminal, or call the `token_usage` MCP tool |

> Everything on the bar is **token usage**, not a bill. The quota chip shows account-level plan pools / balance, not per-model quota.

## Feature overview

- **Desktop status bar** — follows **the session in the window you're looking at**; every item can be switched off on its own in ⚙.
- **Per-answer rate line** — a short stats line appended to each reply (speed, first-token latency, output, duration). It is not the same number as the bar: tool calls split a turn into several requests, and the rate line combines the completed ones into one overall average; it stays hidden until the data lands.
- **Git status chip** — `⎇ branch ↑↓ +N -N` in the composer toolbar keeps repo state visible at a glance; when the directory itself isn't a repository, it automatically adds up the repositories in its subdirectories (`▣ 24 repos · 6 changed`). Read-only local git, no network.
- **Plan quota chip** — left of the context button: per-window used percentages and reset times, or account balance. Beyond the built-in BigModel / Z.ai plans, the ⚙ quota panel lets you **pick a template and paste a key** to add other providers or a custom relay; SCNet works without credentials via the official conversion table. Credentials live in memory only and are sent to the provider's official domain only. Support levels are in the [quota support matrix](docs/quota-support-audit.md) (Chinese); team plans are not supported yet.
- **One-click context compaction** — the compact button in the panel the context button opens sends `/compact` to the current session without touching your draft. Compaction usually takes 2–4 minutes with no progress feedback; sending a new message interrupts it, so let it finish.
- **Query entry points** — same local data, three ways in:

```text
/usage today            # in the chat
python zusage.py week   # in a terminal
token_usage(scope)      # MCP tool
```

- **SSH / WSL remote sessions** — when ZCode runs on an SSH server or inside WSL, the bar's data can follow: remotes are discovered automatically, each server keeps its own stats, and failed queries keep retrying on their own. The remote machine needs the query script installed by hand. See the [remote sessions guide](docs/user-guide.md#远程会话) (Chinese).

## Quick start

### What you need first

- The **ZCode desktop app** (Windows / macOS are the primary targets; on Linux some paths need admin rights — verify on your distro).
- **Python 3.8+** — the standard library is enough, no third-party packages.
- No Node.js or npm needed — the bar runs inside ZCode's bundled Node runtime.

### How to install

The recommended route is the **plugin**. Run these in the ZCode chat, in order:

```text
/plugin marketplace add ByteRax/zcode-token-usage-statusbar#plugin-releases
/plugin install zcode-token-usage-statusbar@zusage-marketplace
```

> **Confirm the plugin actually installed**: check **Settings → Plugins → Installed** for **ZCode Token Usage Statusbar**. The first command clones a repository over the network and can fail without leaving a trace. On machines where direct GitHub access times out, swap the first line for the GitCode channel (the trailing `.git` is required):
>
> ```text
> /plugin marketplace add https://gitcode.com/tanranran/zcode-token-usage-statusbar.git#plugin-releases-gitcode
> ```

The natural-language line at the top runs exactly these commands. Other routes: to hack on the code, point **Settings → Plugins → Add marketplace → Choose directory** at the repository root; to skip the plugin entirely, `git clone` and run `python install.py`; self-hosted ZCode servers have a separate [Web edition](web/README.md). Pick **one** route and stick with it — see the [installation guide](docs/user-guide.md#插件安装) (Chinese) for step-by-step details.

### After installing, don't skip these three steps

1. **The plugin is installed and enabled** — you can see it in the plugin list.
2. **The bar is installed into the client** — starting or resuming a session auto-installs it; if that fails, run `/install-overlay` by hand. This step **modifies ZCode's program files (`app.asar`)** — make sure you trust the project first.
3. **Quit ZCode completely and reopen it** — closing the window doesn't count, and neither does reopening the session.

**Updating later?** For the plugin, click "Check for updates" in ⚙ (auto-update is on by default); for the installer route, `git pull` in the clone and re-run `python install.py`. [Update & upgrade details →](docs/user-guide.md#更新与客户端升级) (Chinese)

### I only want queries — leave my client alone

Add **just** this key to `~/.zcode/zcode-token-usage-statusbar/config.json` (don't overwrite existing settings):

```json
{
  "plugin_auto_install_overlay": false
}
```

`/usage`, the MCP tool and the rate line keep working; the plugin stops touching client files. If the bar was already installed, run `/uninstall-overlay` once to remove it.

## Where these numbers come from

Data is read **read-only** from ZCode's local SQLite database — not self-reported by the model, not a billing estimate. Everything except generation speed refreshes once per stored request, so it doesn't tick up character by character. While the model is still writing, the t/s shown is estimated from the characters emitted so far and switches to the real value once the turn completes. Exact formulas and the commonly-confused pairs (bar speed vs rate line, context share vs session total) are in the [data semantics guide](docs/user-guide.md#数据如何计算) (Chinese).

## Things worth knowing

- **This is not an official ZCode feature.** It's a community plugin; the bar works by modifying ZCode's program files (`app.asar`), and uninstall removes only what it added.
- **The local database is read-only.** Usage data is never uploaded. Plugin updates do download code over the network (auto-update can be disabled in ⚙).
- **Credential boundaries**: SSH passwords and private-key passphrases stored in ZCode are never decrypted or reused by the plugin; quota-query credentials live in memory only and go to the provider's official domain only, and the whole feature can be turned off in ⚙.
- **Token usage is not a bill**: the quota chip shows used percentages from plan APIs, not cash balances or billing details.

## FAQ

**I installed the plugin — where's the bar?**

Walk through the [three steps above](#after-installing-dont-skip-these-three-steps): plugin in the list → start or resume a session to trigger the automatic install (or `/install-overlay` by hand) → **quit ZCode completely and reopen**. A restart alone can't save a bar that was never installed.

**The bar disappeared after a ZCode update. Why?**

A ZCode update overwrites those modified program files. Keep the plugin enabled, start or resume a session to trigger the automatic repair, then **fully quit and reopen once more** after it succeeds — even if the update already restarted the app. [Detailed steps →](docs/user-guide.md#zcode-升级后状态条消失) (Chinese)

**Why don't the numbers move continuously?**

Data refreshes when a request completes and lands in the database, not per keystroke. A brand-new session that hasn't sent a request yet shows 0 — that's normal.

**Can it show how much money I spent?**

Cash bills, no — there's no billing data here. Plan quota and balance, yes — see the **quota chip** above.

[More troubleshooting →](docs/user-guide.md#排查) (Chinese)

## Uninstall

**Installer route**: run `python install.py --remove` in the repository directory, then fully quit and reopen ZCode.

**Plugin route**: ① turn off auto-update in ⚙ → ② run `/uninstall-overlay` and confirm it succeeded → ③ **Settings → Plugins → Installed → ZCode Token Usage Statusbar → ⋯ → Uninstall** → ④ fully quit and reopen ZCode and confirm the bar is gone. Don't just delete the plugin and leave the bar behind. To clear settings, caches and the marketplace too, see the [full cleanup guide](docs/user-guide.md#彻底卸载) (Chinese).

## More documentation

Detailed desktop guides are currently in Chinese.

- [Feature screenshots](docs/features.md) (Chinese) · [Installation, configuration and troubleshooting](docs/user-guide.md) (Chinese) · [Quota support matrix](docs/quota-support-audit.md) (Chinese)
- [Web edition (self-hosted)](web/README.md) · [Architecture and data semantics](docs/design-notes.md) (Chinese)
- [Development and releases](docs/maintaining.md) (Chinese) · [Tests](tests/README.md) (Chinese)

[MIT License](LICENSE)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=ByteRax/zcode-token-usage-statusbar&type=Date)](https://www.star-history.com/#ByteRax/zcode-token-usage-statusbar&Date)
