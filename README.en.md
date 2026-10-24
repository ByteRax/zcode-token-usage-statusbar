<div align="center">

# ZCode Token Speed Status Bar

**Adds a small status bar to the bottom of your ZCode chat window: how fast the model is going, how many tokens you've spent, how much context is left — all at a glance.**

A third-party plugin for the [ZCode](https://zcode.z.ai) desktop app (not an official ZCode feature) — listed in the marketplace as **ZCode Token Usage Statusbar**. It also ships a command-line tool and an MCP tool, so you can dig through usage history whenever you want.

A ZCode plugin that keeps generation speed (tok/s), time to first token (TTFT), token usage and context window utilization visible in your conversation. Includes usage reports, subagent details and MCP queries.

English · [简体中文](README.md)

Windows / macOS · Python 3.8+ · [MIT](LICENSE)

![ZCode Token Speed Status Bar promo](docs/promo/promo.en.png)

</div>

**Install it in three steps:**

Send this to ZCode:

```text
Install or update the ZCode plugin https://github.com/ByteRax/zcode-token-usage-statusbar#plugin-releases, then run /install-overlay when it's done
```

It installs the plugin, then runs `/install-overlay` to put the bar in place — if it doesn't run it for you, type it in the chat yourself. Then **quit ZCode completely and reopen it** (closing the window doesn't count); the little bar shows up at the bottom. Full details in [Quick start](#quick-start).

> The `#plugin-releases` at the end is the stable channel: it installs a SHA256-verified Release package and auto-updates from ⚙ — the same channel as the two commands in Method A below. Don't drop it from the URL.

Can't reach GitHub from your network (mainland China)? The URL above probably won't load either. Send ZCode this instead (the trailing `.git` is required; this route needs local [Git](https://git-scm.com/downloads)):

```text
Install or update the ZCode plugin https://gitcode.com/tanranran/zcode-token-usage-statusbar.git#plugin-releases-gitcode, then run /install-overlay when it's done
```

Both the plugin channel and the code have a synced mirror on GitCode: [gitcode.com/tanranran/zcode-token-usage-statusbar](https://gitcode.com/tanranran/zcode-token-usage-statusbar). The plugin marketplace can be registered straight from the GitCode channel — see the four install methods below.

[Quick start](#quick-start) · [Where these numbers come from](#where-these-numbers-come-from) · [FAQ](#faq) · [Screenshots](docs/features.md)

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
| ⚡ **86 t/s** | How fast the model is writing. Once a turn finishes it's colour-coded: ≥70 green, 40–70 yellow, <40 red |
| **62.5k 90% 7 Σ18.4s ⏱1.4s** | This turn: 62.5k tokens spent, 90% cache hit rate, 7 model requests, the most recent one took 18.4s, and you waited 1.4s for the first token |
| **1.45M 86% 23 187** | The whole conversation so far: 1.45M tokens, 86% hit rate, 23 turns, 187 requests |
| **142 🔴2** | Tools were called 142 times, 2 of them errored (small red marker) |
| **3.42M** | Every conversation today added up: 3.42M tokens |
| **236k 🟢** | The sub-tasks the model sent out on its own (subagents) used 236k tokens; 🟢 means one is still running |
| **⚙** | Click for: which items to show, interface language, token unit display, update checks |

Context usage doesn't take a slot on the bar — look at the **context button** in the composer toolbar (a ring icon plus a percentage). On a normal window it turns yellow at 70% and red at 85%; on a million-token window it turns yellow at 60%. If a request does get rejected for running over, advice pops up.

**Hover any of them and you get the finer breakdown.** For the real thing, see the [feature screenshots](docs/features.md).

## Where to look for the thing you want

| What you're wondering | Where to find it |
|---|---|
| How fast is the model right now? | The **t/s** on the far left — the colour tells you at a glance |
| How long did I wait after hitting enter? | The ⏱ number in **This turn** (that's the TTFT / time to first token) |
| How many tokens did this turn / this conversation / today use? | The **This turn**, **Session total** and **Today** items |
| Is this conversation going to run out of room? | The **context button** in the composer toolbar (ring + percentage) — it changes colour as it fills up, pops up advice if a request gets rejected, and has a **one-click compact** button inside |
| How much did the cache save me? How much was thinking? | Hover **This turn** for input, output, cache-read and thinking token detail plus the hit rate |
| What did the model's sub-tasks cost? How fast are they running? | The **Sub-agents** item — click for cumulative cost; while running it shows "Subagents running ×N · est X t/s" right on the bar |
| How much plan quota / balance is left? | The **quota chip** left of the context button (shown by default, turn it off in ⚙) — per-window used percentages and reset times |
| Did a tool call fail? | The **Tools** item — errors light up red, hover for per-tool timing and errors |
| Looking through history | Type `/usage` in the chat, run `python zusage.py today` in a terminal, or call the `token_usage` MCP tool |

> Everything on the bar is **token usage**, not a bill and not "how much money you have left". For plan pools or account balance use the **quota chip** described below — that's account-level data, not per-model.

## A few words worth knowing

Get these seven and the rest reads easily:

| Word | In plain English |
|---|---|
| **token** | The model's unit of "word". Both billing and speed are measured in them. An English word is usually 1–2 tokens; a Chinese character is usually close to 1 token (it depends on the tokenizer, so treat it as a rough guide) |
| **tok/s** | Tokens per second — how many tokens the model writes per second. Bigger is faster |
| **TTFT / first-token latency** | Time to first token. How long you waited after pressing enter before the first character appeared |
| **context window** | The context window — the limit on how much the model can "see" at once: your prompt, its answer, and the conversation so far. When it fills up, compact the chat or start a new one |
| **cache** | Content that repeats doesn't have to be recomputed. More cache hits means faster and cheaper |
| **thinking tokens** | The part where the model "thinks" before answering. It counts as output |
| **subagent** | A "clone" the model sends out to handle a separate sub-task, with its own token cost |

## Core features

### The desktop status bar

It sits at the bottom of the chat window and follows **the session in the window you're looking at**. Every item can be switched off on its own (see ⚙) — if it feels crowded, hide what you don't care about.

While subagents are running, the **Sub-agents** item shows a live reading: with several in parallel it displays a combined "Subagents running ×3 · est 74 t/s", and hovering breaks it down per subagent. Once they finish it switches to the weighted average over completed segments. The running figure is estimated from the characters emitted so far (same estimation as the main speed while generating), not a stored value.

### The per-answer rate line

The plugin also appends a short stats line to the end of replies: generation speed, time to first token, output tokens, generation time.

It is **not the same number as the bar**: the bar shows the **most recent request segment**, while the rate line shows the **weighted average of every request already stored for this turn**. It stays hidden when your current question hasn't been written to the database yet, so it never passes off the previous turn's numbers as this one's.

### Git status

A Git chip also sits to the right of the Computer Use button in the composer toolbar: `⎇ branch ↑ahead ↓behind (+insertions -deletions ?untracked)` — clean worktrees show just the branch name. Hover for details (upstream, staged/unstaged/conflicts, last update), click to refresh; it also auto-refreshes every 10 seconds and after each reply. Toggle it in ⚙.

When the directory itself is not a git repository (and no parent directory is one either), the chip looks at standalone repositories in the **immediate subdirectories** instead (a `.git` directory and a worktree link file both count; one level deep only): none found keeps the chip hidden; exactly one shows that repository in the full single-repo form (the tooltip's directory row is the real repository path); two or more switch to an aggregate form `▣ 24 repos · 6 changed` — the repo count and the changed-repo count separated by a middle dot; confirmed conflicts append `· !2 conflicted`; some repositories failing to query appends `· 2 failed` (the changed count is then prefixed "known", failed repos keep their last good snapshot marked stale); a stale overall result shows `· last 6 changed · stale`; when everything is clean only the repo count is shown. The hover panel has three parts: an overview (changed repo count, non-zero conflicts/operations/failures, a confirmed-coverage line like "confirmed 22/24 repos"), the full per-repo list (ordered conflicts → failed/stale → mid-operation → changed → upstream drift → clean, scrolling when taller than the screen), and meta info (work directory, update time, one line of units).

The two forms count differently, so don't compare them side by side: the single-repo `+N -N` are **lines**, while the multi-repo `mod`/`new` figures are **file-level entry counts** (one `git status` per repository, no line counts) — `mod` sums each repository's changed file entries (a partially staged file counts once) and `new` sums untracked entries (git folds a whole untracked directory into 1). Past 32 sub-repositories only the first 32 in name order are counted (the tooltip notes how many were left out), and a repository whose query fails just gets a ⚠ row without affecting the others or the totals.

It reads your local `git` directly (read-only, no network, never touches the index lock) and is a separate data chain from the token stats: local repositories only — it stays hidden for SSH remote sessions and non-git directories; the ⚙ toggle governs both forms.

### Plan quota and balance

A **quota chip** sits left of the context button (shown by default, turn it off in ⚙), showing per-window used percentages and reset times of your plan pool, or your account balance. It covers more than BigModel / Z.ai:

- **Multiple sources**: besides the built-in coding plans, a set of vendor plan/balance endpoints and sub2api-protocol relay stations are supported; the ⚙ quota panel lets you **pick a preset and paste just the Key**, with an independent toggle and refresh per source
- **API-key connections count too**: when the host connects to BigModel / Z.ai with an API key, the quota still shows
- **SCNet ledger estimate**: without any credentials it estimates spend from the official credit rates × your actual usage
- The chip follows the model/provider of the current session; hovering lists every enabled source, and subscription validity dates are shown

Per-vendor support and verification status lives in the [quota support audit matrix](docs/quota-support-audit.md) — some adapters are not yet verified against real accounts, and a source whose response shape changed fails silently rather than showing wrong numbers. Team plans are not supported yet.

The credential boundary: quota queries are on by default — the main process reads sign-in credentials (in memory only) and sends them only to each vendor's official domain (or the relay base URL you configured); turn off **Plan quota** in ⚙ to stop. When no usable credentials are found, the chip shows a neutral "Quota unset" hint.

### One-click context compaction

Inside the context button's native popover there's a **Compact context** pill button: it opens a confirmation dialog and then sends `/compact` to that session, leaving whatever is in your input box untouched. With split panes it goes to the pane the button lives in.

Compaction usually takes 2–4 minutes with no progress feedback — the summary isn't streamed, so it looks stuck while it's actually working. Sending a new message or stopping the session during compaction **interrupts** it; if you want it done, let it finish.

### Queries: chat, terminal, MCP

Three ways in, one local database:

```text
/usage                    # ask inside the chat
/usage today              # today's usage
/usage week               # the past week
```

```bash
python zusage.py today    # ask in a terminal
python zusage.py days 7
python zusage.py models 7
```

```text
token_usage(scope)        # MCP tool (stdio)
```

The MCP tool also supports `days:N`, `sessions:N`, `models:days`, `session:<session id prefix>` and `workspace:<directory keyword>`. The plugin command's full name is `/zcode-token-usage-statusbar:usage`.

### SSH / WSL remote sessions

If your ZCode runs on a server you reach over SSH, or inside a WSL distro, the bar can follow it there:

- Daily totals and errors are **counted per server** — one unreachable host doesn't affect the others
- Failed or not-yet-found sessions keep retrying with backoff, and queries continue after you resume a session, switch workspaces or reconnect SSH
- SSH, WSL and Docker remote workspaces the client has connected to are **discovered automatically** and turned into non-interactive query transports (WSL/Docker need no credentials)
- The remote script has to be **copied over by you** (into the distro for WSL, which also needs python3) — the plugin will not decrypt and reuse the passwords, private keys or passphrases ZCode has stored

Remote support covers **the bar's own data fetching** only. MCP, `/usage` and the per-answer rate line do **not** fetch data across machines. See the [remote session guide](docs/user-guide.md#远程会话) (Chinese).

## Quick start

### What you need first

- **The ZCode desktop client** (Electron). Windows and macOS are the primary targets; on Linux some system paths need administrator rights, and how it looks on each distro is worth checking for yourself.
- **Python 3.8+** (the standard library's `sqlite3` is enough). No third-party Python packages.
- **No Node.js or npm needed** — the bar's code runs on the Node runtime that already ships inside ZCode.

### Four ways to install — pick the one you need

| Method | Who it's for | How |
|---|---|---|
| **A. The plugin (recommended)** | Almost everyone | Two `/plugin` commands in ZCode, then updates from the ⚙ panel |
| **B. Local source directory** | People who want to change the code | Clone the repo and point "Add marketplace → Choose directory" at the repo root |
| **C. One-command installer** | People who'd rather not install a plugin | `git clone` + `python install.py` in a terminal |
| **D. Self-hosted Web** | People running their own ZCode server | [Deploy it separately](web/README.md) |

> The first three all write into the same runtime directory — **pick one, don't stack them**. The fourth is a self-hosted Web deployment, which is a completely different thing from the desktop bar.

> **Can't reach GitHub (mainland China networks)?** The repo has a synced mirror on GitCode: [`tanranran/zcode-token-usage-statusbar`](https://gitcode.com/tanranran/zcode-token-usage-statusbar). For **A. The plugin**, register the marketplace from the GitCode channel instead (command below; requires local [Git](https://git-scm.com/downloads)). For **B/C**, clone from GitCode. Whichever address you register or clone from is where update checks and downloads happen — GitHub never gets touched.

#### A. The plugin (recommended)

The plain-language sentence at the top is just a shortcut for these two steps. To do it by hand, enter these in **ZCode's chat input**, in order:

```text
/plugin marketplace add ByteRax/zcode-token-usage-statusbar#plugin-releases
/plugin install zcode-token-usage-statusbar@zusage-marketplace
```

If GitHub is unreachable from your network, swap the first line for the GitCode channel (the trailing `.git` is required; this route needs [Git](https://git-scm.com/downloads) installed):

```text
/plugin marketplace add https://gitcode.com/tanranran/zcode-token-usage-statusbar.git#plugin-releases-gitcode
/plugin install zcode-token-usage-statusbar@zusage-marketplace
```

> **After the two commands, confirm the plugin actually installed.** The first command clones the repo from the registered address; if the network can't reach it, that step fails — **possibly without leaving a single trace**, and the error may not be loud — which is easy to mistake for a success. Check **Settings → Plugin → Installed**: **ZCode Token Usage Statusbar** must appear there before anything else can happen. If it doesn't, the marketplace registration likely failed; on networks where a direct connection to GitHub times out, re-run with the GitCode channel above. Step-by-step checklist: [install verification](docs/user-guide.md#安装结果自查) (Chinese).

Whichever address you register is where ⚙ **Check for updates / Update now** and automatic updates fetch from: both channels serve the same checksum-verified stable Release packages, never a development branch.

You can also use the UI: **Settings → Plugin → Add marketplace**, enter either channel address above, then find and install **ZCode Token Usage Statusbar**.

> **Version note (verified 2026-10-23):** The `#plugin-releases` channel still provides [v1.5.2](https://github.com/ByteRax/zcode-token-usage-statusbar/releases/tag/v1.5.2). This README describes the main development line — **multi-source quota, sub-agent speed, one-click compact, multi-repo Git aggregation and the ⚙ section nav are not in the stable release yet** and arrive with the next Release. If you're still on the older `v1.4.1`, update as described further down first — that version defaults automatic installation to *off*, so you'd have to run `/install-overlay` by hand.

#### B. Local source directory

Download or clone this repository, then:

1. **Settings → Plugin → Add marketplace**, click **Choose directory**.
2. Pick the **repository root containing `marketplace.json`** (not the `plugins/` subdirectory) and add it.
3. Find **ZCode Token Usage Statusbar** and install it.

Or type this in ZCode:

```text
/plugin marketplace add /absolute/path/to/zcode-token-usage-statusbar
/plugin install zcode-token-usage-statusbar@zusage-marketplace
```

<details>
<summary>See the add-marketplace screenshot</summary>

![Add marketplace: enter the GitHub URL for remote installation or choose a directory for local installation (Chinese UI)](docs/plugin-marketplace-add.png)

</details>

#### C. One-command installer (no plugin)

Install [Python](https://www.python.org/downloads/) and [Git](https://git-scm.com/downloads), then in a terminal:

```bash
git clone https://github.com/ByteRax/zcode-token-usage-statusbar.git
cd zcode-token-usage-statusbar
python install.py --lang en
```

On macOS, use `python3 install.py --lang en` if `python` isn't available.

The installer finds ZCode for you, copies the runtime files, installs the bar, and registers a standalone MCP server plus `/usage`. Common options: `--lang en` for English output, `--no-mcp` to install only the bar without the query tools, `--remove` to uninstall, `--dry-run` to see what it would do.

### After installing, don't skip these three steps

They're three separate things, and missing any one of them makes it look like "I installed it and nothing happened":

1. **The plugin is installed and enabled** — it shows up on the plugin page. So far ZCode has only loaded the plugin's query, rate-line and update features.
2. **The status bar was injected** — the plugin installs or repairs the bar when you start or resume a session, and this step **modifies the client's `app.asar` file**. If the automatic install fails, `/install-overlay` is the manual fallback.
3. **It actually loaded after a restart** — you must **quit ZCode completely and reopen it** for the bar to appear. **Closing the window doesn't count, and reopening a session doesn't either.**

> The bar modifies client files, so it's on you to decide whether you trust this project. Removal strips only what it injected; it does not roll your ZCode back.

**How do I update it later?**

- **Plugin (stable channel)**: type `/plugin marketplace update zusage-marketplace` in ZCode, then update the plugin under **Settings → Plugin → Installed**. Or just use ⚙ → **Check for updates / Update now** — automatic updates are on by default. If you registered the GitCode channel, this whole flow — version check through download and install — runs on GitCode, and the ⚙ source line names the channel in use.
- **Local directory / source branch**: ⚙ → **Check for updates / Update now** works here too. These sources have no stable Release to verify, so the update is handed to the ZCode plugin manager, which installs straight from the marketplace catalog (effectively `marketplace update` + plugin update for you, without the release-package SHA256 check); the ⚙ source line reads "repository source" or "local directory marketplace". For verified release packages, [switch the marketplace to the stable channel](docs/user-guide.md#切换已有市场到正式渠道) (Chinese).
- **One-command installer**: the ⚙ **Check for updates** only works for plugin installs. Updating is two steps — `git pull` inside the clone (it pulls from wherever you cloned from, so GitCode mirror users pull from GitCode), then rerun `python install.py`.
- Start or reopen a session afterwards. If prompted about changed main-process files, quit ZCode completely and reopen it.

[More installation, updates and troubleshooting →](docs/user-guide.md#插件安装) (Chinese)

### I only want queries — leave my client alone

Add just this one field to `~/.zcode/zcode-token-usage-statusbar/config.json` (keep your existing settings):

```json
{
  "plugin_auto_install_overlay": false
}
```

Or run `/uninstall-overlay` to take the bar back out and leave behind a marker that stops it being reinstalled. Either way you still get `/usage`, the MCP tool and the per-answer rate line — the plugin just won't touch your client files.

If the config file or that field is missing, the default is **on**; an explicit `false` you've already set is always respected. `ZUSAGE_PLUGIN_AUTO_INSTALL=1` / `0` takes precedence over the config, but it can't override the "don't reinstall" marker.

## Everyday use

- **Hover** an item for the finer numbers.
- **Click Sub-agents** to see what each sub-task cost.
- **Click ⚙** for everything: the section nav on the left (display items / reply statistics / plugin updates / quota sources), hiding items, switching language, switching token counts to 万/亿 (on by default in the Chinese UI), checking for updates.
- **Type `/usage today`** for today's usage, `/usage week` for the past week.

## Where these numbers come from

The data is read from ZCode's local SQLite database. It isn't the model reporting on itself, and it isn't an estimated bill. Except for the generation speed, everything refreshes when a request is written to the database.

<details>
<summary>Open to see how each number is computed</summary>

| Item | How it's computed |
|---|---|
| Generation speed (tok/s) | After a turn finishes: output tokens (thinking included) ÷ model generation time |
| Generation time | Normal requests: end time − first-token arrival. Requests with thinking: end time − request start |
| Time to first token (TTFT) | First-token arrival − request sent |
| Usage totals | Total = input + output. Input already includes cache reads, so cache isn't added twice |
| Cache hit rate | Cache reads ÷ input tokens |
| Context usage | Input tokens of the most recent successful request ÷ context window size |
| Git status | Local `git status` + `git diff`; never enters the database, no network |
| Sub-agent speed | Weighted average over completed segments; the running figure is a character-delta estimate until it finishes |
| Turn count | Counted over de-duplicated `turn_id` values |

**Where it's easy to get confused:**

- **The bar's speed ≠ the per-answer rate line.** The bar shows the most recent request segment; the rate line shows the **weighted** speed of the requests already stored for this turn, and the time spent waiting on tools between segments isn't counted as generation time.
- **Generation speed ≠ end-to-end throughput.** End-to-end time also covers waiting for the first token, thinking, and network round-trips. What's measured here is the part the model actually spent writing.
- **Requests with thinking look slower, and that's correct.** Thinking tokens stream out before the first token, so those requests (including the Claude family) measure generation time from when the request was sent. Claude doesn't report thinking tokens separately, but its thinking still happens before the first token, so it's measured the same way. That's not a bug.
- **Context usage ≠ session total.** Usage share comes from the most recent request's input, so it can drop after the conversation is compacted; the session total accumulates across the whole conversation.
- **Thinking tokens are already inside the output** and aren't added twice; whether they're reported at all depends on the provider.
- **The CLI and MCP `current`** means "the session that was active most recently" — it isn't guaranteed to be the window on your screen. The bar follows each window's own session.

**Why might the numbers differ from another plugin?** Ordinary requests use the "first token → request complete" window; requests reporting thinking tokens, and Claude requests, use "request start → request complete". The per-answer rate line is yet another measure: total output ÷ total generation time over the valid segments already stored for this question, excluding the time spent waiting on tools between segments and the final prose that hasn't been stored yet. End-to-end throughput is a different window again, so the two shouldn't be compared directly.

Also, the bar **searches backwards** for the most recent valid speed sample, which isn't necessarily the newest request. Per-question statistics check that the data belongs to the current question, but rapid successive questions still have an identification boundary.

**While the model is still writing, that speed is an estimate.** During generation the t/s is **estimated** from the characters emitted so far divided by a chars-per-token ratio (that ratio is taken from this session's most recent completed turn and calibrates itself). When the turn finishes, it switches to that turn's real tok/s. When the client's internal session state isn't available, it falls back to the most recent segment's value from the database.

</details>

The boundaries around missing data, invalid samples and historical turns (no statistics are ever fabricated) are documented under [Data semantics](docs/user-guide.md#数据如何计算) (Chinese).

## Things worth knowing

- **This is not an official ZCode feature.** It's a community plugin with no connection to the ZCode team, and it works by injecting into the client's `app.asar`.
- **The local database is read-only.** Usage data is never uploaded.
- **Plugin updates do use the network** — they download code from the source you've configured. Automatic updates are on by default; turn them off in ⚙.
- **SSH/WSL remote queries also use the network** — they run a read-only query script on the remote host through the transport you configured. Prerequisites and limits are in [SSH / WSL remote sessions](#ssh--wsl-remote-sessions).
- **Credential usage.** Passwords, encrypted private keys and passphrases stored by ZCode are never decrypted by the plugin; set up an SSH key / agent yourself. Quota queries are on by default: credentials are read in memory to query plan/balance endpoints (never written to disk, logs or diagnostics); turn off **Plan quota** in ⚙ to stop that. Destinations: bigmodel.cn / api.z.ai for coding plans, zcode.z.ai for the Start Plan free tier; custom-provider balance lookups use that provider's own key and go only to its official domain (api.deepseek.com, openrouter.ai, api.siliconflow.cn, api.minimaxi.com, api.kimi.com, api.commandcode.ai, api.cline.bot, api.anthropic.com, platform.xiaomimimo.com, open.volcengineapi.com, opencode.ai, …) or the relay base URL you configured — never anywhere else.
- **Token usage is not billing.** Token usage only, by default; the **Plan quota** chip shows used percentages from the official plan endpoint — no cash balance or billing details.

## FAQ

**Is this a ZCode plugin, or a general-purpose LLM token monitor?**

It's ZCode-specific. It reads ZCode's own session and usage data, for ZCode users. The CLI and MCP server are **query entry points** — they don't mean it can measure other AI coding clients.

**Can I install the desktop bar in a browser or on an SSH server?**

No. The desktop bar only installs into the ZCode client on your own machine. A self-hosted Web setup is [deployed separately](web/README.md); an SSH remote only needs the matching query script and Python, not the desktop bar. Remote auto-routing also needs non-interactive authentication, and it doesn't cover MCP, `/usage` or the per-answer rate line.

**I installed the plugin. Where's the bar?**

First check **Settings → Plugin → Installed** — if it's nowhere to be found, `/plugin install` never succeeded. The most common shape: the marketplace registration timed out cloning GitHub and failed without a trace (typical where a direct connection to GitHub is blocked; no visible error doesn't mean success). Redo it with the GitCode channel from [A. The plugin](#a-the-plugin-recommended).

If the plugin is listed: leave it enabled and **start a new session or resume one** — that triggers the automatic install/repair. Once it succeeds, quit ZCode completely and reopen it. If the automatic install fails, run `/install-overlay` by hand and check permissions, config and the "don't reinstall" marker. **A restart alone can't repair a bar that was never successfully installed.**

**The bar vanished after I updated ZCode. Why?**

A ZCode update may overwrite the client files the plugin injected into. The first launch after the update gives the plugin a chance to restore its injection; **once that succeeds, you still have to quit ZCode completely and restart it once more** for the restored injection to load. This is required even if the update already restarted ZCode for you.

1. Leave the plugin enabled and start or resume a session to trigger the automatic repair.
2. If automatic installation is off, or the repair failed, type `/install-overlay` in the chat input and follow the output.
3. Once it succeeds, **quit ZCode completely and reopen it**.

If you used the one-command installer rather than the plugin, rerun `python install.py --lang en` from the repository directory (`python3 install.py --lang en` on macOS) and quit completely and restart after success.

**Why don't the numbers keep moving?**

Most of them refresh when a request is written to the database, not with every streamed token. A brand-new session that hasn't sent anything yet showing zeros is normal. (The one exception is the t/s while the model is writing — that's the live estimate described under [Where these numbers come from](#where-these-numbers-come-from).)

**Why do some replies have no rate line?**

Pure Q&A, or questions whose data hasn't been stored yet, get no line — rather than reusing the previous turn's numbers. You can turn it off with the per-answer rate toggle in ⚙. After a full restart, historical turns restored by ZCode sometimes lack valid output statistics, and those turns don't get a number made up for them; statistics written into the message body are unaffected.

**Can it show me my bill or remaining quota?**

Not your cash bill — there's no billing data here. Plan quota and balance, yes — the chip is on by default. It defaults to the BigModel / Z.ai plan pool, and the quota panel lets you add other vendors or relay stations (pick a preset, paste the Key). The chip shows per-window used percentages and reset times (hover for details); support status per vendor is in the [audit matrix](docs/quota-support-audit.md). Team plans are not supported yet.

[More troubleshooting, automatic updates and remote setup →](docs/user-guide.md) (Chinese)

## Uninstall

**One-command installation**: run this from the repository, then quit and reopen ZCode:

```bash
python install.py --remove
```

**Plugin installation**: follow this order so the bar doesn't get left behind:

1. Turn off automatic updates in ⚙ and let any update already running finish.
2. Run `/uninstall-overlay` and confirm success.
3. **Settings → Plugin → Installed → ZCode Token Usage Statusbar → ⋯ → Uninstall**.
4. Quit ZCode completely, reopen it and confirm the bar is gone.

<details>
<summary>See the uninstall screenshot</summary>

![Uninstall in the plugin card's three-dot menu](docs/plugin-uninstall.png)

</details>

Want to clear out settings, caches and the marketplace too? See the [full cleanup guide](docs/user-guide.md#彻底卸载) (Chinese).

## More documentation

Detailed desktop guides are currently in Chinese.

- [Feature screenshots](docs/features.md) (Chinese) · [Installation, configuration and troubleshooting](docs/user-guide.md) (Chinese) · [Quota support matrix](docs/quota-support-audit.md)
- [Web edition (self-hosted)](web/README.md) · [Architecture and data semantics](docs/design-notes.md) (Chinese)
- [Development and releases](docs/maintaining.md) (Chinese) · [Tests](tests/README.md) (Chinese)

[MIT License](LICENSE)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=ByteRax/zcode-token-usage-statusbar&type=Date)](https://www.star-history.com/#ByteRax/zcode-token-usage-statusbar&Date)
