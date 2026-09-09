# Notification icons

Source-specific notifier icons live here:

- `claude-code.png` (or `.icns`) — used for Claude Code notifications
- `codex.png` (or `.icns`) — used for Codex notifications
- `ghostty.png` (or `.icns`) — used for shell notifications sent from Ghostty
- `opencode.png` (or `.icns`) — used for opencode notifications
- `pi.png` (or `.icns`) — used for Pi notifications

`pi.svg` is the editable vector source for `pi.png`.

If a file is missing, notifications fall back to no icon (the
banner still shows title + message).

To override per-user without committing to the repo, set in
`~/.config/jaynalerts/config.toml`:

```toml
[notifications]
iconClaudeCode = "/absolute/path/to/your/claude-code-icon.png"
iconCodex      = "/absolute/path/to/your/codex-icon.png"
iconOpencode   = "/absolute/path/to/your/opencode-icon.png"
iconPi         = "/absolute/path/to/your/pi-icon.png"
```
