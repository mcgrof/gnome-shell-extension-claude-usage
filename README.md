<p align="center">
  <img src="icons/claude-symbolic.svg" width="80" alt="Claude Usage">
</p>

<h1 align="center">Claude Usage</h1>

<p align="center">
  <strong>Monitor your Claude AI usage limits right from the GNOME top bar</strong>
</p>

<p align="center">
  <a href="https://extensions.gnome.org/"><img src="https://img.shields.io/badge/GNOME-45--49-blue?logo=gnome&logoColor=white" alt="GNOME 45-49"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
</p>

<p align="center">
  <img src="screenshot.png" width="320" alt="Screenshot">
</p>

---

> **Fork note (multi-provider):** this branch extends the original Claude-only
> extension to also show **OpenAI Codex** usage, so the top bar measures both
> assistants at once from a single codebase. Each provider is an independent,
> toggleable segment.

## Features

- **Two providers at once** — Claude (Anthropic) and Codex (OpenAI/ChatGPT) side by side
- **Short + long windows** — per-provider short-term and rolling-window utilization
- **Reset countdown** — time remaining until the nearest quota resets
- **Color-coded labels** — white (normal) / yellow (>60%) / orange (>80%) / red (>90%)
- **Dropdown details** — exact windows, reset time, plan type, quick links
- **Zero-cost Codex reads** — no OpenAI quota spent (see how it works below)
- **Auto-detect credentials** — reads the Claude OAuth token from Claude Code automatically
- **Configurable** — refresh interval, panel position, per-provider toggles, manual token override

## How each provider gets its numbers

| | Claude | Codex |
|---|---|---|
| **Source** | `GET api.anthropic.com/api/oauth/usage` (live pull) | newest `~/.codex/sessions/**/rollout-*.jsonl` → last `payload.rate_limits` |
| **Auth** | Claude Code OAuth token (`~/.claude/.credentials.json`) or manual | none needed |
| **Freshness** | live | as fresh as your last Codex turn (staleness shown when > 5 min old) |
| **Quota cost** | none | none |

Anthropic offers a dedicated usage endpoint; OpenAI does not, so the Codex
segment reads the rate-limit snapshot that Codex itself records into each
session rollout. Parsing runs in a short-lived `python3` subprocess so the
GNOME Shell main loop is never blocked.

## Installation

### From source

```bash
git clone https://github.com/stfnRO/gnome-shell-extension-claude-usage.git
cd gnome-shell-extension-claude-usage
bash install.sh
```

Then restart GNOME Shell (log out/in on Wayland, or `Alt+F2` → `r` on X11) and enable:

```bash
gnome-extensions enable claude-usage@tasta.space
```

## Authentication

### Automatic (recommended)

If you have [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and logged in, the extension reads your token from `~/.claude/.credentials.json` automatically. No setup needed.

### Manual

1. Open [claude.ai](https://claude.ai) and log in
2. DevTools (`F12`) → Application → Cookies → `claude.ai`
3. Copy the `sessionKey` cookie value (starts with `sk-ant-`)
4. Paste it in extension preferences → "Manual token"

```bash
gnome-extensions prefs claude-usage@tasta.space
```

## How it works

The extension polls the Anthropic OAuth usage API at a configurable interval (default: 3 minutes):

| Metric | Description |
| --- | --- |
| `five_hour` | Short-term rate limit (resets every 5 hours) |
| `seven_day` | Weekly rolling rate limit |
| `seven_day_sonnet` | Separate Sonnet model limit (shown if available) |

## Development

| Task | Command |
| --- | --- |
| Enable | `gnome-extensions enable claude-usage@tasta.space` |
| Disable | `gnome-extensions disable claude-usage@tasta.space` |
| Preferences | `gnome-extensions prefs claude-usage@tasta.space` |
| View logs | `journalctl /usr/bin/gnome-shell -f \| grep "Claude Usage"` |
| Compile schemas | `glib-compile-schemas --strict schemas/` |

## Disclaimer

Not affiliated with or endorsed by Anthropic. Usage data is obtained from the Anthropic API. No warranty expressed or implied.

## License

[MIT](LICENSE)
