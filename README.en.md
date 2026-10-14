<div align="center">

# ZCode Token Usage Status Bar

**See token usage, model speed and remaining context at a glance.**

A real-time usage bar for your [ZCode](https://zcode.z.ai) conversation window.

English · [简体中文](README.md)

Windows / macOS · Python 3.8+ · [MIT](LICENSE)

![Status bar overview](docs/tour/shots/en/hero.png)

</div>

## What it does

- **Track usage**: see the current turn, session and today's totals without opening Settings.
- **Check speed**: see generation speed and the wait for the first token.
- **Watch context**: a color-coded indicator warns as the context window fills up.
- **Inspect details**: hover for cache and thinking tokens, click for subagent usage, and spot tool errors.
- **Make it yours**: use ⚙ to choose visible items, switch languages and manage plugin updates.
- **Query in chat**: use `/usage` for reports; the plugin also adds a rate line to eligible replies.

[Feature screenshots and details →](docs/features.md)

## Quick start

> ⚠️ **The floating bar does not appear immediately after its first installation. Quit ZCode completely and restart it to load the bar. Closing the window alone is not enough.**

**Using the desktop app?** Plugin installation is recommended; the one-command installer below is an alternative. Do not install both.
**Self-hosting the web UI?** Follow the [Web edition guide](web/README.md) instead.

### Install through ZCode plugins

The plugin provides **usage queries, reply rates and plugin updates**. Install [Python 3.8+](https://www.python.org/downloads/), then choose either method below.

#### Method 1: remote installation (no source download needed)

Enter these commands in **ZCode's chat input**, in order:

```text
/plugin marketplace add ByteRax/zcode-token-usage-statusbar#plugin-releases
/plugin install zcode-token-usage-statusbar@zusage-marketplace
```

Alternatively, open **Settings → Plugin → Add marketplace**, enter `https://github.com/ByteRax/zcode-token-usage-statusbar#plugin-releases`, then find and install **ZCode Token Usage Statusbar**. This channel installs verified stable Release assets, not development branch code.

#### Method 2: local-directory installation

Download or clone this repository, then:

1. Open **Settings → Plugin → Add marketplace** and click **Choose directory**.
2. Select the repository root containing `marketplace.json` (not the `plugins/` subdirectory) and add it.
3. Find **ZCode Token Usage Statusbar** and install it.

Or enter these commands in ZCode, replacing the path with your repository directory:

```text
/plugin marketplace add /absolute/path/to/zcode-token-usage-statusbar
/plugin install zcode-token-usage-statusbar@zusage-marketplace
```

<details>
<summary>Add marketplace screenshot</summary>

![Add marketplace: enter the GitHub URL for remote installation or choose a directory for local installation (Chinese UI)](docs/plugin-marketplace-add.png)

</details>

#### Add the floating bar

After either plugin installation method, leave the plugin enabled, start or reopen a session, and run:

```text
/install-overlay
```

After installation succeeds, **quit ZCode completely and reopen it**.

**Installing the plugin alone does not install the bar.** Automatic installation is off by default; restarting an uninjected client cannot install it. Skip this step if you only want queries and reply rates. The bar installer modifies client files; only run it if you trust this project.

To opt in to automatic installation/repair, merge `"plugin_auto_install_overlay": true` into `~/.zcode/zcode-token-usage-statusbar/config.json` without replacing other settings, or set `ZUSAGE_PLUGIN_AUTO_INSTALL=1`, then start or resume a session. A full restart is still required after installation succeeds. Each session start repeats the installation reminder until the bar is installed or you run `uninstall-overlay` to opt out.

**How do I update it later?**

- **Remote installation**: enter `/plugin marketplace update zusage-marketplace` in ZCode, then update this plugin in **Settings → Plugin → Installed**.
- **Local installation**: update your source first, then follow the same refresh and update steps. The local marketplace never runs `git pull` for you.
- Start or reopen a session afterward. If prompted about changed main-process files, quit ZCode completely and reopen it.

Use the `#plugin-releases` stable channel for remote installs; its catalog matches the asset URL, version and SHA256. Existing default-branch or local-directory registrations do not switch automatically; see the [migration guide](docs/user-guide.md#切换已有市场到正式渠道) (Chinese).
[More installation, updates and troubleshooting →](docs/user-guide.md#插件安装) (Chinese)

### One-command installer (without plugins)

Install [Python](https://www.python.org/downloads/) and [Git](https://git-scm.com/downloads), then run in a terminal:

```bash
git clone https://github.com/ByteRax/zcode-token-usage-statusbar.git
cd zcode-token-usage-statusbar
python install.py --lang en
```

On macOS, use `python3 install.py --lang en` if `python` is unavailable.

**After installation succeeds, quit ZCode completely and reopen it.** The bar appears at the bottom of a conversation window.

## Everyday use

- **Hover** an item for its detailed figures.
- **Click Sub-agents** for per-task usage.
- **Click ⚙** to hide items, switch language or check for plugin updates.
- **Run `/usage today`** for today's usage, or `/usage week` for the past week.

The plugin command's full name is `/zcode-token-usage-statusbar:usage`.

## Safety and caveats

- **Usage data is not uploaded**: local queries do not use the network. Configured remote sessions read the remote database over your chosen transport. Plugin updates download code over the network.
- **The bar modifies client files**: it is not a native ZCode feature. Removal strips only this project's injection, without reverting the client version.
- **ZCode upgrades may remove the bar**: rerun the installer. The plugin can optionally repair the injection, but a restart is still required.
- **Uninstalling the plugin may leave the bar behind**: follow the removal steps below.

## FAQ

**I installed the plugin. Where is the bar?**

The plugin does not install it automatically by default. Run `install-overlay`, wait for success, then quit and reopen ZCode.

**Why don't the numbers change continuously?**

They mainly refresh when a model request completes, not with each streamed token. A new session with no requests can show zeros.

**Why do some replies have no rate line?**

Pure Q&A and questions with no stored request data omit it rather than reuse the previous turn. Disable it with the per-answer rate toggle in ⚙.

**Does this show my bill or plan balance?**

It shows token usage, not billing. Use ZCode's official pages for pricing and plan limits.

[More troubleshooting, automatic updates and remote setup →](docs/user-guide.md) (Chinese)

## Uninstall

**One-command installation**: run this from the repository, then quit and reopen ZCode:

```bash
python install.py --remove
```

**Plugin installation**: follow this order so the bar is removed along with the plugin:

1. Turn off automatic updates in ⚙ and let any update already running finish.
2. Run `/uninstall-overlay` and confirm success.
3. Open **Settings → Plugin → Installed → ZCode Token Usage Statusbar → ⋯ → Uninstall**.
4. Quit ZCode completely, reopen it and confirm the bar is gone.

<details>
<summary>Uninstall screenshot (Chinese UI)</summary>

![Uninstall in the plugin card's three-dot menu](docs/plugin-uninstall.png)

</details>

To remove settings, caches and the marketplace too, follow the [full cleanup guide](docs/user-guide.md#彻底卸载) (Chinese).

## More documentation

Detailed desktop guides are currently in Chinese.

- [Feature screenshots](docs/features.md) · [Installation, configuration and troubleshooting](docs/user-guide.md)
- [Web edition](web/README.md) · [Architecture and data semantics](docs/design-notes.md)
- [Development and releases](docs/maintaining.md) · [Tests](tests/README.md)

[MIT License](LICENSE)
