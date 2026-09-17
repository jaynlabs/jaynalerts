import type { Config } from "../core/config.ts";
import { createContext, notifyUser } from "../core/index.ts";

export type CommandEvent = {
	cmd: string;
	exit: number;
	durationMs: number;
};

export type CommandDecision =
	| { notify: false; reason: "below-threshold" | "ignored" | "empty-cmd" }
	| { notify: true; title: string; message: string };

export function decideCommandNotification(
	event: CommandEvent,
	shell: Config["shell"],
): CommandDecision {
	const trimmedCmd = event.cmd.trim();

	if (trimmedCmd === "") {
		return { notify: false, reason: "empty-cmd" };
	}

	if (event.durationMs < shell.thresholdMs) {
		return { notify: false, reason: "below-threshold" };
	}

	const programName = basename(firstNonEnvToken(trimmedCmd));

	if (shell.ignore.includes(programName)) {
		return { notify: false, reason: "ignored" };
	}

	const duration = formatDuration(event.durationMs);
	const message =
		event.exit === 0
			? `${trimmedCmd} — ${duration}`
			: `${trimmedCmd} — failed in ${duration} (exit ${event.exit})`;

	return { notify: true, title: "shell", message };
}

export async function runNotifyCommand(argv: string[]): Promise<void> {
	const event = parseArgs(argv);
	const ctx = await createContext();
	const decision = decideCommandNotification(event, ctx.config.shell);

	if (!decision.notify) {
		return;
	}

	await notifyUser(ctx, {
		title: decision.title,
		message: decision.message,
		...(process.env.TERM_PROGRAM === "ghostty"
			? { source: "ghostty" as const }
			: {}),
	});
}

function parseArgs(argv: string[]): CommandEvent {
	let cmd: string | undefined;
	let exit: number | undefined;
	let durationMs: number | undefined;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];

		if (arg === "--cmd") {
			cmd = requireValue(argv, ++i, "--cmd");
			continue;
		}

		if (arg === "--exit") {
			exit = parseInteger("--exit", requireValue(argv, ++i, "--exit"));
			continue;
		}

		if (arg === "--duration-ms") {
			durationMs = parseInteger(
				"--duration-ms",
				requireValue(argv, ++i, "--duration-ms"),
			);

			if (durationMs < 0) {
				throw new Error("--duration-ms must be non-negative");
			}

			continue;
		}

		throw new Error(`unknown flag: ${arg}`);
	}

	if (cmd === undefined) {
		throw new Error("missing required --cmd");
	}

	if (exit === undefined) {
		throw new Error("missing required --exit");
	}

	if (durationMs === undefined) {
		throw new Error("missing required --duration-ms");
	}

	return { cmd, exit, durationMs };
}

function requireValue(argv: string[], index: number, flag: string): string {
	const value = argv[index];

	if (value === undefined) {
		throw new Error(`${flag} requires a value`);
	}

	return value;
}

function parseInteger(flag: string, raw: string): number {
	const parsed = Number.parseInt(raw, 10);

	if (!Number.isFinite(parsed) || raw.trim() === "") {
		throw new Error(`${flag} must be an integer (got "${raw}")`);
	}

	return parsed;
}

function firstNonEnvToken(cmd: string): string {
	const tokens = cmd.split(/\s+/);

	for (const token of tokens) {
		if (token === "") {
			continue;
		}

		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
			continue;
		}

		return token;
	}

	return "";
}

function basename(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? path : path.slice(idx + 1);
}

function formatDuration(ms: number): string {
	if (ms < 1_000) {
		return `${Math.round(ms)}ms`;
	}

	const seconds = Math.round(ms / 1_000);

	if (seconds < 60) {
		return `${seconds}s`;
	}

	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;

	if (minutes < 60) {
		return remainingSeconds === 0
			? `${minutes}m`
			: `${minutes}m ${remainingSeconds}s`;
	}

	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes === 0
		? `${hours}h`
		: `${hours}h ${remainingMinutes}m`;
}
