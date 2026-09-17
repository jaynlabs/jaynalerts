# JaynAlerts

macOS notifications for coding agents and long-running shell commands.

JaynAlerts supports Claude Code, Codex, OpenCode, Pi, and an optional zsh
hook. Notifications stay persistent when the originating terminal or tmux pane
is not focused and become transient while you are already looking at it.

## Requirements

- macOS
- [Bun](https://bun.sh)
- Xcode Command Line Tools (`xcode-select --install`)

## Install

```sh
npm install -g jaynalerts # or: bun add -g jaynalerts
jaynalerts init           # all agent integrations
jaynalerts init --shell   # also install the zsh hook
```

From source:

```sh
git clone https://github.com/jaynlabs/jaynalerts.git
cd jaynalerts
make setup
```

`init` preserves existing configuration, builds the local notification apps,
and prints any remaining macOS permission steps.

## Commands

```text
jaynalerts init [integration flags]       Install integrations
jaynalerts uninstall [integration flags]  Remove integrations
jaynalerts doctor                         Check notification settings
jaynalerts test                           Send test notifications
jaynalerts grant-terminal-notifications   Request terminal permission
```

Integration flags are `--claude-code`, `--codex`, `--opencode`, `--pi`, and
`--shell`. With no flags, `init` installs every agent integration and
`uninstall` removes everything except the user configuration. Use
`uninstall --dry-run` to preview changes.

Run `jaynalerts --help` for the complete CLI reference.

## Configuration

Configuration is read from `~/.config/jaynalerts/config.toml`, or from
`$XDG_CONFIG_HOME/jaynalerts/config.toml` when set.

```toml
[notifications]
stickySound = "default"
tmuxZoomOnClick = true

[shell]
thresholdMs = 15000
ignore = ["vim", "ssh", "tmux", "claude", "opencode", "pi"]
```

See [`examples/config.toml`](./examples/config.toml) for the available values.
Set `JAYNALERTS_DEBUG=1` for verbose errors.

## Development

```sh
bun install
make check
```

Notification helpers are compiled locally from the Swift sources in
`src/native`; no prebuilt executable is distributed.

## Credits

Originally created by [Maxence Rossignol](https://github.com/maxmaxou2) as
`stay-alert`.

## License

[MIT](./LICENSE) © Jayn Labs
