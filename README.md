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

Notification bundles are compiled locally rather than shipped prebuilt — a prebuilt binary would need Developer ID signing and notarization, so local compilation is the pragmatic choice. `init` checks for the toolchain up front and refuses to touch your config files without it, telling you exactly what to install.

## Install

### From npm

```sh
npm install -g jaynalerts        # or: bun add -g jaynalerts
jaynalerts init                  # add --shell for the zsh hook
```

The published package runs on [bun](https://bun.sh): the installed `jaynalerts` command is a small `sh` shim that execs `bun`, so bun has to be present even when you install with npm. The shim looks for it on `PATH` and in the usual locations (`$BUN_INSTALL/bin`, `~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin`) — it matters because agent hooks run with a minimal `PATH` — and prints how to install bun if it finds none. Xcode Command Line Tools are needed too, for `swiftc`.

### From source

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

To remove the integrations, bundles, and config edits: `jaynalerts uninstall`.
To drop only the global bun link: `make uninstall`.

## Quickstart

```sh
jaynalerts init                  # all coding-agent integrations (no shell hook)
jaynalerts init --shell          # also install the zsh hook into ~/.zshrc
jaynalerts test                  # fire one transient + one sticky banner
jaynalerts doctor                # inspect each notifier's macOS alert settings
jaynalerts grant-terminal-notifications
                                 # run once per terminal app (Terminal, iTerm, Ghostty…)
                                 # to trigger macOS' notification-permission prompt
jaynalerts uninstall --dry-run   # preview what a full removal would revert
```

`init` finishes by running the same checks as `doctor` and printing a numbered checklist of the steps only you can do — the permission grants, the Persistent alert-style toggles, and the Focus allowlist entries. Nothing about those is discoverable, so they are handed to you rather than left to be found.

If banners don't appear, open **System Settings → Notifications → JaynAlerts** and make sure alerts are enabled.

## Commands

| Command | Purpose |
| --- | --- |
| `init [--claude-code] [--codex] [--opencode] [--pi] [--shell] [--shell-rc PATH]` | Install hooks/extensions/plugins/shell wrapper. With no flags, installs all four agent integrations. |
| `uninstall [--claude-code] [--codex] [--opencode] [--pi] [--shell] [--shell-rc PATH] [--bundles] [--config] [--dry-run]` | Revert what `init` installed. With no target flags, removes everything except `config.toml`. |
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

tmux is optional: outside it, step 3 is skipped entirely and focus is just host vs. frontmost.

If host == frontmost and the only attached tmux client is showing the originating pane, the terminal is considered focused → **transient**. Otherwise → **sticky**. Ambiguous multi-client cases deliberately stay sticky because macOS exposes the frontmost app, not its exact terminal window.

## Notifications on macOS

Banners are sent through `JaynAlertsNotifier.app`, built and code-signed (ad-hoc) on `init`. `init` builds one bundle per source — Claude Code, Codex, Pi, and a default — each with its own icon and app name, so a banner shows which agent is asking. A Ghostty-branded bundle is built only where Ghostty is installed (or when you are running under it); on every other machine nothing Ghostty-related lands in `~/Applications`, in System Settings → Notifications, or in the Focus allowlist checklist.

Each bundle carries a build stamp (`Contents/Resources/build-stamp`) hashing the package version together with the Swift and plist sources. Every notification path compares that stamp before sending, and rebuilds the bundle if it no longer matches — so upgrading the package cannot leave a stale binary behind. This matters because the old failure mode was silent: a stale notifier simply hung on `--sticky`. `doctor` reports a stale bundle rather than rebuilding it; `init` rebuilds. Set `JAYNALERTS_NO_AUTO_REBUILD=1` to opt out of the automatic rebuild.

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

`jaynalerts init --opencode` writes `~/.config/opencode/plugins/jaynalerts.ts` (copied from `examples/opencode-plugin.ts`) and symlinks this install into `~/.config/opencode/node_modules/jaynalerts` so the plugin can `import "jaynalerts"`. A real `node_modules/jaynalerts` directory — jaynalerts installed there as a dependency — is left alone. An existing plugin file is backed up to `jaynalerts.ts.bak` before being overwritten.

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

The block is zsh-only — `&!` and `add-zsh-hook` are zsh syntax, and bash cannot even *parse* a file containing `&!`, so writing it into a `.bashrc` would take the whole rc file down rather than harmlessly do nothing. `--shell-rc` therefore refuses any rc path that isn't a zsh one. The agent integrations work in any shell; only this hook needs zsh.

## Uninstall

```sh
jaynalerts uninstall --dry-run   # print what would change, touch nothing
jaynalerts uninstall             # revert every integration and delete the bundles
jaynalerts uninstall --codex     # revert just one integration
jaynalerts uninstall --pi        # remove the Pi extension
jaynalerts uninstall --config    # also delete ~/.config/jaynalerts/config.toml
```

Uninstall only removes what jaynalerts owns: hook groups running our exact commands, the `notify` line and `[tui] notifications = false` we wrote, our managed `.zshrc` block, the opencode plugin if it is still ours together with the `node_modules/jaynalerts` symlink we made (a real package directory there is left alone), the managed Pi extension, and app bundles whose `Info.plist` carries a `dev.jaynalerts.` identifier. Foreign hooks, sibling TOML tables, and your own edits are left alone. `config.toml` is kept unless you pass `--config`, and the `.jaynalerts.bak` backups stay on disk.

One thing it cannot undo: macOS keeps a Notifications row and a Focus allowlist entry for every app bundle it has ever seen, including deleted ones. Uninstall prints where to clear those by hand.

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
- `src/core/native.ts` — bundle building, build stamping, and auto-rebuild
- `examples/` — sample configuration plus the opencode and Pi integration sources
- `test/` — `bun test` suites

## Credits

Originally written by [Maxence Rossignol](https://github.com/maxmaxou2) as `stay-alert`.

## License

MIT — see [LICENSE](./LICENSE).
