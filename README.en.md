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

Confirm the plugin is installed and enabled, then make sure `/install-overlay` succeeds — if it doesn't run for you, type it in the chat yourself. **Installing the bar modifies ZCode's `app.asar` program file**, so proceed only if you trust the project. Finally, **quit ZCode completely and reopen it** (closing the window doesn't count), then check for the bar at the bottom. The `#plugin-releases` at the end selects the officially released stable channel; don't drop it from the URL.

Can't reach GitHub from your network (mainland China)? Send ZCode this instead (the trailing `.git` is required; this route needs local [Git](https://git-scm.com/downloads)):

```text
Install or update the ZCode plugin https://gitcode.com/tanranran/zcode-token-usage-statusbar.git#plugin-releases-gitcode, then run /install-overlay when it's done
```

[Quick start](#quick-start) · [FAQ](#faq) · [Screenshots](docs/features.md)

---

## What it looks like once it's installed

A thin bar appears along the bottom of the chat window, roughly like this:

```text
⚡ 86 t/s │ 62.5k 90% 7 Σ18.4s ⏱1.4s │ 1.45M 86% 23 187 │ 123M 88% 42 sess 890 │ 142 🔴2 │ 3.42M │ 236k 🟢 │ ⚙
   Speed        This turn             Session total       Project total        Tools     Today    Sub-agents   Settings
```

The example above shows the default style. In the desktop app, choose **Default**, **Pill** or **Compact** under ⚙ → General → Status bar style. The pill is centered below its composer, sized to its content and constrained in narrow windows. Compact hides the floating bar and moves the speed readout and cell summaries into the composer toolbar. On the Web, choose Default/Compact under ⚙ → General. [Style and switching details →](docs/user-guide.md#状态条样式) (Chinese)

Here's what each part tells you:

| The bit | In plain English |
|---|---|
| ⚡ **86 t/s** | Generation speed in tokens per second. Colour bands range from red (slow) to violet (very fast), with a blue-violet gradient + ✦ at ≥2000 t/s (Ultra). While generating, the displayed speed is an estimate; once a turn completes it switches to the session's weighted-average speed (prefixed with "avg"; the latest-turn reading moves into the tooltip), using the same colour bands |
| **62.5k 90% 7 Σ18.4s ⏱1.4s** | This turn: 62.5k tokens spent, 90% cache hit rate, 7 model requests, their total duration was 18.4s, and you waited 1.4s for the first token |
| **1.45M 86% 23 187** | The whole conversation so far: 1.45M tokens, 86% hit rate, 23 turns, 187 requests |
| **123M 88% 42 sess 890** | This project (same directory) across all of its sessions ever: 123M tokens, 42 sessions, 890 requests; subagent usage counts too (hover for details) |
| **142 🔴2** | Tools were called 142 times, 2 of them errored (small red marker) |
| **3.42M** | Every conversation today added up: 3.42M tokens |
| **236k 🟢** | The sub-tasks the model sent out on its own (subagents) used 236k tokens; 🟢 means one is still running |
| **⚙** | Click for: which items to show, interface language, token unit display, update checks |

Context usage doesn't take a slot on the bar — look at the **context button** in the composer toolbar (a ring icon plus a percentage). It changes colour as it fills up; if a request gets rejected for running over, it tells you what to do. Clicking it opens a panel that includes a **one-click compact** button. Prefer the native look? Turn off **Context button enhancement** under **⚙ → General**.

**Hover any of them and you get the finer breakdown.** For the real thing, see the [feature screenshots](docs/features.md).

## Where to look for the thing you want

| What you're wondering | Where to find it |
|---|---|
| How fast is the model going? | The **t/s** on the far left — an estimate while generating when the renderer bridge is available, otherwise the latest valid stored speed |
| How long did I wait after hitting enter? | The ⏱ number in **This turn** (that's the TTFT / time to first token) |
| How many tokens did this turn / this conversation / today use? | The **This turn**, **Session total** and **Today** items |
| How much has this project used across all of its sessions? | The **Project total** item (subagents incl., grouped by project directory) |
| Is this conversation going to run out of room? | The **context button** — it changes colour as it fills up, with one-click compact inside |
| How much did the cache save me? How much did the "thinking" cost? | Hover **This turn** for input, output, cache-read and thinking detail |
| What did the model's sub-tasks cost? How fast are they running? | The **Sub-agents** item — while running it shows "Subagents running ×N · est X t/s" right on the bar |
| How much plan quota / balance is left? | The **quota chip** left of the context button |
| Did a tool call fail? | The **Tools** item — errors light up red |
| Looking through history | Type `/usage` in the chat, run `python zusage.py` in a terminal, or call the `token_usage` MCP tool |

> Everything on the bar is **token usage**, not a bill. The quota chip shows account-level plan pools / balance, not per-model quota.

## Feature overview

- **Desktop status bar** — follows **the session in the window you're looking at**; every item can be switched off on its own in ⚙.
- **Per-answer rate line** — a short stats line after a reply (speed, first-token latency, output, duration), when the renderer bridge and required data are available. It differs from the bar: tool calls can split a turn into requests, and the line combines valid completed segments into a duration-weighted average; it stays hidden until the data lands. The line's labels are currently in Chinese.
- **Git status chip** — `⎇ branch ↑↓ +N -N` in the composer toolbar keeps repo state visible at a glance; when the directory itself isn't a repository, it automatically adds up the repositories in its subdirectories (`▣ 24 repos · 6 changed`). Read-only local git, no network.
- **Plan quota chip** — left of the context button: plan-window used percentages and reset times, or account balance. Beyond the built-in BigModel / Z.ai plans, the ⚙ quota panel lets you select a provider template and enter a key, including for a custom relay; SCNet can be estimated without credentials using the official conversion table. Keys entered in the panel are saved locally in the runtime directory's `quota-secrets.json` (created with 0600 permissions where supported), not just kept in memory. Requests send credentials only to the adapter's allowed official domains or the configured custom relay's own domain. Support levels are in the [quota support matrix](docs/quota-support-audit.md) (Chinese); team plans are not supported yet.
- **Reset-card badge** — a `reset · N` tag left of the quota chip (counts from multiple accounts joined with `+`), shown when the account holds available quota reset cards. It shows a countdown when time is running short and escalates in color as expiry nears (>3h green / 3h–30min yellow / <30min red with a pulse); hover for per-card (5-hour/weekly) counts and expiry times. On by default; toggle or adjust the countdown threshold in the ⚙ quota panel. Requires the ZCode sign-in; API-key-only users and team plans have no reset cards.
- **One-click context compaction** — the compact button in the panel the context button opens sends `/compact` to the current session without touching your draft. Compaction usually takes 2–4 minutes with no progress feedback; sending a new message interrupts it, so let it finish.
- **Auto-compact threshold injection (optional, off by default)** — the engine's built-in auto-compact trigger is fixed (around 83% of a 200K window). With the ⚙ switch on, the plugin patches the client engine (allow-listed per engine build) to make the trigger configurable: percent of window, absolute tokens, a buffer value, or disabling auto-compact entirely. Threshold values apply from the next decision round, and the context-button panel shows the effective compaction line; turning the switch off restores the engine bytes. Only the desktop client's built-in engine is affected (the terminal CLI is not); if a new client build isn't supported yet, ⚙ says so and waits for a plugin update.
- **Query entry points** — three ways to explore local usage:

  - In ZCode chat, enter `/usage` for a report or `/usage today` for today.
  - In a terminal, run `python zusage.py days 7` from the repository directory for the last seven days.
  - Ask the assistant to call the `token_usage` MCP tool, for example with scope `today`. MCP is optional; you don't need it to use the bar or `/usage`.

  The `current` query selects the most recently active database session, which may not be the session in the focused window.

- **SSH / WSL remote sessions** — when ZCode runs on an SSH server or inside WSL, the bar's data can follow: remotes are discovered automatically, each server keeps its own stats, and failed queries keep retrying on their own. The remote machine needs the query script installed by hand. See the [remote sessions guide](docs/user-guide.md#远程会话) (Chinese).

## Quick start

### What you need first

- The **ZCode desktop app** (Windows / macOS are the primary targets; on Linux some paths need admin rights — verify on your distro).
- **Python 3.8+** — the standard library is enough, no third-party packages.
- No Node.js or npm needed — the bar runs inside ZCode's bundled Node runtime.

### How to install

The recommended route is the **plugin**: in ZCode, open **Settings → Plugins → Add marketplace** and paste the market URL:

```text
https://github.com/ByteRax/zcode-token-usage-statusbar#plugin-releases
```

Then install **ZCode Token Usage Statusbar** from that market and keep it enabled. On machines where direct GitHub access times out, swap the URL for the GitCode channel (the trailing `.git` is required):

```text
https://gitcode.com/tanranran/zcode-token-usage-statusbar.git#plugin-releases-gitcode
```

You can also send the natural-language "three steps" line from the top of this README to the AI and let it add the market and install the plugin for you (it uses terminal commands; the result is identical). Other routes: to hack on the code, point **Settings → Plugins → Add marketplace → Choose directory** at the repository root; to skip the plugin entirely, `git clone` and run `python install.py`; self-hosted ZCode servers have a separate [Web edition](web/README.md). Pick **one** route and stick with it — see the [installation guide](docs/user-guide.md#插件安装) (Chinese) for step-by-step details.

### After installing, don't skip these three steps

1. **The plugin is installed and enabled** — you can see it in the plugin list.
2. **The bar is installed into the client** — starting or resuming a session can trigger automatic installation; if it fails or is disabled, run `/install-overlay` by hand and confirm it succeeds. This step **modifies ZCode's program files (`app.asar`)** — make sure you trust the project first. Permissions or client changes can prevent installation.
3. **Quit ZCode completely and reopen it**, then check that the bar appears — closing the window doesn't count, and neither does reopening the session.

**Updating later?** For the plugin, click "Check for updates" in ⚙ (auto-update is on by default); for the installer route, `git pull` in the clone and re-run `python install.py`. [Update & upgrade details →](docs/user-guide.md#更新与客户端升级) (Chinese)

### I only want queries — leave my client alone

Run `/uninstall-overlay` to remove the bar and write the opt-out marker (auto-install is always on and no longer has a config switch; only the opt-out marker blocks re-injection). `/usage` and the MCP tool remain available. The per-answer rate line depends on the renderer bridge and is not guaranteed without the overlay. Confirm removal, then fully quit and reopen ZCode.

## Where these numbers come from

Usage reports read ZCode's local SQLite database **read-only** — they are not self-reported by the model or a billing estimate. Stored request statistics update as completed requests reach the database, not character by character. When the renderer bridge is available, generation speed is estimated from text changes while the model is writing and switches to the session's weighted average once the turn completes (the measured per-turn value moves into the tooltip); without the bridge, speed falls back to the latest valid completed database request. Quota and balance come from a separate provider-query or estimate path, not from those token totals. Exact formulas and commonly confused pairs (bar speed vs rate line, context share vs session total) are in the [data semantics guide](docs/user-guide.md#数据如何计算) (Chinese).

## Things worth knowing

- **This is not an official ZCode feature.** It's a community plugin; the bar works by modifying ZCode's program files (`app.asar`), and uninstall removes only what it added.
- **The local database is read-only.** Usage data is never uploaded. Plugin updates do download code over the network (auto-update can be disabled in ⚙).
- **Credential boundaries**: SSH passwords and private-key passphrases stored in ZCode are not decrypted or reused by the plugin. Quota credentials entered in ⚙ are saved locally in `quota-secrets.json`; requests are restricted to the relevant provider's allowed official domains or the configured custom relay's domain. Quota sources can be disabled in ⚙.
- **Token usage is not a bill**: the quota chip can show plan usage or an account balance, depending on the source; it does not provide a cash spending bill or billing details.

## FAQ

**I installed the plugin — where's the bar?**

Walk through the [three steps above](#after-installing-dont-skip-these-three-steps): plugin in the list → start or resume a session to trigger the automatic install (or `/install-overlay` by hand) → **quit ZCode completely and reopen**. A restart alone can't save a bar that was never installed.

**The bar disappeared after a ZCode update. Why?**

A ZCode update overwrites those modified program files. Keep the plugin enabled, start or resume a session to trigger the automatic repair, then **fully quit and reopen once more** after it succeeds — even if the update already restarted the app. [Detailed steps →](docs/user-guide.md#zcode-升级后状态条消失) (Chinese)

**Why don't the numbers move continuously?**

Stored usage refreshes when a completed request lands in the database, not per character. With the renderer bridge, speed can show a text-based estimate during generation; without it, speed waits for a valid completed database sample. A brand-new session that hasn't sent a request yet shows 0 — that's normal.

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
