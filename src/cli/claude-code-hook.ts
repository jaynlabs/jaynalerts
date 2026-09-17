import { basename } from "node:path";
import { createContext, notifyUser, resolveIcon } from "../core/index.ts";

type HookEvent = "on-stop" | "on-notification";

export async function runClaudeCodeHook(argv: string[]): Promise<void> {
	const [event, ...extraArgs] = argv;

	if (!isHookEvent(event) || extraArgs.length > 0) {
		throw new Error(
			"usage: jaynalerts claude-code-hook <on-stop | on-notification>",
		);
	}

	try {
		const payload = await readPayload();

		if (payload === null) {
			return;
		}

		if (event === "on-stop") {
			await handleOnStop(payload);
			return;
		}

		if (event === "on-notification") {
			await handleOnNotification(payload);
			return;
		}

		event satisfies never;
	} catch (error) {
		console.warn(`jaynalerts: hook handler failed: ${errorMessage(error)}`);
	}
}

async function readPayload(): Promise<Record<string, unknown> | null> {
	const raw = await Bun.stdin.text();

	if (raw.trim() === "") {
		console.warn("jaynalerts: empty hook payload");
		return null;
	}

	let payload: unknown;

	try {
		payload = JSON.parse(raw);
	} catch {
		console.warn("jaynalerts: invalid JSON hook payload");
		return null;
	}

	if (!isRecord(payload)) {
		console.warn("jaynalerts: hook payload must be an object");
		return null;
	}

	return payload;
}

async function handleOnStop(payload: Record<string, unknown>): Promise<void> {
	const ctx = await createContext();
	const iconPath = await resolveIcon(ctx.config, "claude-code");
	await notifyUser(ctx, {
		title: titleWithCwd(payload),
		message: "Done",
		iconPath,
		source: "claude-code",
	});
}

async function handleOnNotification(
	payload: Record<string, unknown>,
): Promise<void> {
	const rawMessage = payload.message;
	const message =
		typeof rawMessage === "string" && rawMessage.trim() !== ""
			? rawMessage.trim()
			: "Question";

	const ctx = await createContext();
	const iconPath = await resolveIcon(ctx.config, "claude-code");
	await notifyUser(ctx, {
		title: titleWithCwd(payload),
		message,
		iconPath,
		source: "claude-code",
	});
}

function titleWithCwd(payload: Record<string, unknown>): string {
	const cwd = payload.cwd;
	if (typeof cwd === "string" && cwd.trim() !== "") {
		const name = basename(cwd);
		if (name !== "") {
			return `Claude Code · ${name}`;
		}
	}
	return "Claude Code";
}

function isHookEvent(value: string | undefined): value is HookEvent {
	return value === "on-stop" || value === "on-notification";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
