import { basename } from "node:path";
import { createContext, notifyUser, resolveIcon } from "../core/index.ts";

type HookEvent = "on-agent-settled" | "on-ui-prompt";

type HookOptions = {
	event: HookEvent;
	cwd: string | null;
	message: string | null;
};

export async function runPiHook(argv: string[]): Promise<void> {
	const options = parseArgs(argv);

	try {
		const ctx = await createContext();
		const iconPath = await resolveIcon(ctx.config, "pi");
		await notifyUser(ctx, {
			title: titleWithCwd(options.cwd),
			message:
				options.event === "on-agent-settled"
					? "Done"
					: (options.message ?? "Action required"),
			iconPath,
			source: "pi",
		});
	} catch (error) {
		console.warn(`jaynalerts: Pi hook handler failed: ${errorMessage(error)}`);
	}
}

function parseArgs(argv: string[]): HookOptions {
	const [event, ...args] = argv;
	if (!isHookEvent(event)) {
		throw new Error(
			"usage: jaynalerts pi-hook <on-agent-settled | on-ui-prompt> [--cwd PATH] [--message TEXT]",
		);
	}

	let cwd: string | null = null;
	let message: string | null = null;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg !== "--cwd" && arg !== "--message") {
			throw new Error(`unknown Pi hook flag: ${arg}`);
		}

		const value = args[++i];
		if (value === undefined) {
			throw new Error(`${arg} requires a value`);
		}

		if (arg === "--cwd") {
			cwd = nonEmptyString(value);
		} else {
			message = nonEmptyString(value);
		}
	}

	return { event, cwd, message };
}

export function titleWithCwd(cwd: string | null): string {
	if (cwd !== null) {
		const name = basename(cwd);
		if (name !== "") {
			return `Pi · ${name}`;
		}
	}

	return "Pi";
}

function isHookEvent(value: string | undefined): value is HookEvent {
	return value === "on-agent-settled" || value === "on-ui-prompt";
}

function nonEmptyString(value: string): string | null {
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
