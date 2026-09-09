# jaynalerts

A macOS-only CLI that notifies you when your AI coding agent (Codex, Claude Code, opencode, Pi) or any long-running shell command needs your attention — but only when your terminal isn't focused.

## Overview

jaynalerts wires up:

- **Claude Code** `Stop` and `Notification` hooks
- **Codex** human-reviewed `PermissionRequest` hook + `agent-turn-complete`
  notifications
- **opencode** plugin events
- **Pi** settled-agent and blocking UI-prompt events
- An optional **zsh** `preexec`/`precmd` hook for arbitrary long-running commands

Notifications are delivered through a tiny bundled Swift app (`JaynAlertsNotifier.app`) so banners carry a real icon and survive Terminal/iTerm/Ghostty permission quirks. When your terminal is the frontmost window (and, under tmux, the active pane is the one running the agent), notifications are downgraded to **transient** and otherwise are **sticky** so you don't miss them.

## Status

Early. macOS only. Requires `bun` and Xcode Command Line Tools (for `swiftc`).

## Install

```sh
git clone https://github.com/jaynlabs/jaynalerts.git
cd jaynalerts
make setup        # installs prereqs, runs `bun link`, then `jaynalerts init`
```

`make setup` will:

1. Ensure Xcode CLT, Homebrew, and `bun` are present.
2. `bun install` and `bun link` (exposes the `jaynalerts` binary globally).
3. Run `jaynalerts init --claude-code --opencode --pi --shell-rc ~/.zshrc`.

Override the shell rc target with `make setup SHELL_RC=/path/to/rc`.

To uninstall the global link: `make uninstall`.

## Quickstart

```sh
jaynalerts init                  # all coding-agent integrations (no shell hook)
jaynalerts init --shell          # also install the zsh hook into ~/.zshrc
jaynalerts test                  # fire one transient + one sticky banner
jaynalerts doctor                # inspect each notifier's macOS alert settings
jaynalerts grant-terminal-notifications
                                 # run once per terminal app (Terminal, iTerm, Ghostty…)
                                 # to trigger macOS' notification-permission prompt
```

If banners don't appear, open **System Settings → Notifications → JaynAlerts** and make sure alerts are enabled.

## Commands

| Command | Purpose |
| --- | --- |
| `init [--claude-code] [--codex] [--opencode] [--pi] [--shell] [--shell-rc PATH]` | Install hooks/extensions/plugins/shell wrapper. With no flags, installs all four agent integrations. |
| `grant-terminal-notifications` | Prompt the current terminal app for macOS notification permission. |
| `test` | Send one transient and one sticky notification. |
| `doctor` | Report authorization and Temporary/Persistent style for every notifier bundle. |
| `claude-code-hook <on-stop\|on-notification>` | Internal — invoked by Claude Code. |
| `codex-hook <json\|on-permission-request>` | Internal — invoked by Codex. |
| `pi-hook <on-agent-settled\|on-ui-prompt>` | Internal — invoked by the Pi extension. |
| `notify-command --cmd C --exit N --duration-ms N` | Internal — invoked by the zsh hook. |

Flags: `--help/-h`, `--version/-v`. Set `JAYNALERTS_DEBUG=1` for verbose errors.

## Configuration

Configuration lives at `~/.config/jaynalerts/config.toml` (respects `XDG_CONFIG_HOME`). All keys are optional; missing keys fall back to defaults. See `examples/config.toml`.

```toml
[notifications]
# stickySound:    sound for sticky banners (default: "default")
# transientSound: sound for transient banners (default: none — omit the key)
stickySound = "default"
tmuxZoomOnClick = true            # zoom the originating pane when its banner is clicked
# icon*: absolute paths overriding the bundled assets/*.png
# iconClaudeCode = "/absolute/path/to/icon.png"
# iconCodex      = "/absolute/path/to/icon.png"
# iconOpencode   = "/absolute/path/to/icon.png"
# iconPi         = "/absolute/path/to/icon.png"

[shell]
thresholdMs = 15000              # only notify for commands longer than this
ignore = ["vim", "nvim", "ssh", "tmux", "claude", "opencode", "pi", ...]
```

Override the install root with `JAYNALERTS_HOME` (otherwise XDG paths are used; the notifier bundle is built into `~/Applications/JaynAlertsNotifier.app`).

## How focus detection works

jaynalerts decides between transient and sticky banners using a small Swift helper (`bundle-id`) that resolves:

1. The bundle ID of the terminal hosting the current shell (via the process tree, falling back to the tmux client PID).
2. The frontmost app's bundle ID.
3. Under tmux, the originating socket, session, window, pane, and attached client.

If host == frontmost and the only attached tmux client is showing the originating pane, the terminal is considered focused → **transient**. Otherwise → **sticky**. Ambiguous multi-client cases deliberately stay sticky because macOS exposes the frontmost app, not its exact terminal window.

## Notifications on macOS

Banners are sent through `JaynAlertsNotifier.app`, built and code-signed (ad-hoc) on `init`. `init` builds one bundle per source — Claude Code, Codex, Pi, Ghostty, and a default — each with its own icon and app name, so a banner shows which agent is asking. Bundles are rebuilt automatically when the Swift source or icons change.

- Icons live in `assets/` as `notifier.png`, `claude-code.png`, `codex.png`, `ghostty.icns`, `opencode.png`, and `pi.png` (`.png` and `.icns` are both accepted).
- Per-user icon overrides via the `iconClaudeCode` / `iconCodex` / `iconOpencode` / `iconPi` config keys.
- Run `jaynalerts grant-terminal-notifications` once per terminal emulator you use, so macOS associates the permission with that terminal.
- Sticky notifications require **Persistent** alerts. New bundles request that default; run `jaynalerts doctor` to see the effective setting and change any **Temporary** entry in System Settings → Notifications.
- A tmux notification carries its own origin, so concurrent sessions each route to their own pane. Clicking one switches the captured client to the exact pane and, by default, zooms that pane. Set `tmuxZoomOnClick = false` to keep the normal split layout.
- If the originating pane is gone by the time you click, the notification only brings the terminal forward — it never redirects a client to some other session.

## Claude Code setup

`jaynalerts init --claude-code` patches `~/.claude/settings.json` to add two hooks:

```json
{
  "hooks": {
    "Stop":         [{"hooks": [{"type": "command", "command": "jaynalerts claude-code-hook on-stop"}]}],
    "Notification": [{"hooks": [{"type": "command", "command": "jaynalerts claude-code-hook on-notification"}]}]
  }
}
```

Existing hooks are preserved; a `.jaynalerts.bak` backup is created on first change. The title shown in the banner includes the project folder name (`Claude Code · my-repo`).

## Codex setup

`jaynalerts init --codex` wires up two separate Codex mechanisms, because neither one covers both cases on its own:

- **`notify` (turn complete)** — sets the user-level `notify` command in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`) to `jaynalerts codex-hook`. Codex only ever fires this with `agent-turn-complete`, so it cannot tell you about approvals.
- **`PermissionRequest` hook (approvals)** — writes `~/.codex/hooks.json` with an `async` command hook that runs `jaynalerts codex-hook on-permission-request` whenever Codex requests approval for a command. JaynAlerts checks the matching turn's approval reviewer and skips the banner when Codex auto-review handles the decision; requests routed to you still notify. The payload arrives as JSON on stdin, and the hook only notifies—it never writes a decision to stdout—so Codex still prompts you as usual.

Existing configuration is preserved in both files and a `.jaynalerts.bak` backup is created before the first change.

> Codex will not run a newly added hook until you trust it. The next time you start Codex you will see **“Hooks need review”** — pick **Trust all and continue** (or open `/hooks`). Until then approval notifications stay silent.

## opencode setup

`jaynalerts init --opencode` writes `~/.config/opencode/plugins/jaynalerts.ts` (copied from `examples/opencode-plugin.ts`) and runs `bun link jaynalerts` inside `~/.config/opencode` so the plugin can `import "jaynalerts"`. An existing plugin file is backed up to `jaynalerts.ts.bak` before being overwritten.

## Pi setup

`jaynalerts init --pi` writes a global extension to `~/.pi/agent/extensions/jaynalerts.ts` (or `$PI_CODING_AGENT_DIR/extensions/jaynalerts.ts`). It listens for:

- `agent_settled`, which fires only after Pi has no automatic retry, compaction retry, or queued continuation left, and sends a **Done** alert.
- `ui_prompt_start`, which sends an **Action required** alert when another extension opens a blocking select, confirmation, input, editor, or custom prompt.

The prompt event requires Pi 0.84.4 or newer. Existing extension files are preserved in `jaynalerts.ts.bak` before the first update. Restart Pi or run `/reload` after installing.

## Shell hook (zsh)

`jaynalerts init --shell [--shell-rc PATH]` inserts a managed block into your `.zshrc`:

```sh
# jaynalerts begin (managed — do not edit)
… preexec/precmd hooks that call `jaynalerts notify-command` …
# jaynalerts end
```

Re-running `init` updates the block in place. A `.jaynalerts.bak` is created on first modification. Open a new shell or `source ~/.zshrc` for it to take effect.

## Development

```sh
make check        # lint + typecheck + test
make test         # bun test
make lint         # biome check
make format       # biome format --write
make typecheck    # tsc --noEmit
```

Layout:

- `src/cli/` — CLI entrypoint and subcommands
- `src/core/` — config, paths, focus detection, notify dispatcher
- `src/native/` — Swift sources for the notifier bundle and `bundle-id` helper
- `examples/` — sample configuration plus the opencode and Pi integration sources
- `test/` — `bun test` suites

## Credits

Originally written by [Maxence Rossignol](https://github.com/maxmaxou2) as `stay-alert`.

## License

MIT — see [LICENSE](./LICENSE).
