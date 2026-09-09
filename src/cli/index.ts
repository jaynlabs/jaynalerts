#!/usr/bin/env bun

import pkg from "../../package.json" with { type: "json" };

const helpText = `jaynalerts — notify when your AI coding agent or long-running command needs you

Usage:
  jaynalerts <command> [options]

Commands:
  init [--claude-code] [--codex] [--opencode] [--pi] [--shell] [--shell-rc PATH]
                              Install coding-agent integrations / shell hook
                              --shell-rc PATH overrides the default ~/.zshrc target
  uninstall [--claude-code] [--codex] [--opencode] [--pi] [--shell] [--bundles]
            [--config] [--dry-run]
                              Remove the notifier bundles and revert every
                              config edit init made. With no flags, removes
                              everything except your config.toml
  grant-terminal-notifications
                              Trigger this terminal's macOS notification permission prompt
                              (run once per terminal app you use)
  test                        Fire one transient + one sticky notification
  doctor                      Inspect each notifier's macOS notification settings
  claude-code-hook <event>    Internal: invoked by Claude Code hooks
  codex-hook <json|on-permission-request>
                              Internal: invoked by Codex notify and hooks
  pi-hook <on-agent-settled|on-ui-prompt>
                              Internal: invoked by the Pi extension
  notify-command --cmd C --exit N --duration-ms N
                              Internal: invoked by the shell hook on each command

Options:
  --help, -h                  Show this help
  --version, -v               Show version

Set JAYNALERTS_DEBUG=1 for verbose error output.`;

async function main(): Promise<void> {
	const [command] = process.argv.slice(2);

	if (command === undefined || command === "--help" || command === "-h") {
		console.log(helpText);
		return;
	}

	if (command === "--version" || command === "-v") {
		console.log(pkg.version);
		return;
	}

	if (command === "test") {
		const { runTest } = await import("./test.ts");
		await runTest();
		return;
	}

	if (command === "doctor") {
		const { runDoctor } = await import("./doctor.ts");
		await runDoctor();
		return;
	}

	if (command === "init") {
		const { runInit } = await import("./init.ts");
		await runInit(process.argv.slice(3));
		return;
	}

	if (command === "uninstall") {
		const { runUninstall } = await import("./uninstall.ts");
		await runUninstall(process.argv.slice(3));
		return;
	}

	if (command === "claude-code-hook") {
		const { runClaudeCodeHook } = await import("./claude-code-hook.ts");
		await runClaudeCodeHook(process.argv.slice(3));
		return;
	}

	if (command === "codex-hook") {
		const { runCodexHook } = await import("./codex-hook.ts");
		await runCodexHook(process.argv.slice(3));
		return;
	}

	if (command === "pi-hook") {
		const { runPiHook } = await import("./pi-hook.ts");
		await runPiHook(process.argv.slice(3));
		return;
	}

	if (command === "grant-terminal-notifications") {
		const { runGrantTerminalNotifications } = await import(
			"./grant-terminal-notifications.ts"
		);
		await runGrantTerminalNotifications();
		return;
	}

	if (command === "notify-command") {
		const { runNotifyCommand } = await import("./notify-command.ts");
		await runNotifyCommand(process.argv.slice(3));
		return;
	}

	console.error(`unknown command: ${command}`);
	console.error(helpText);
	process.exit(2);
}

try {
	await main();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`error: ${message}`);

	if (process.env.JAYNALERTS_DEBUG) {
		console.error(error);
	}

	process.exit(1);
}
