import { basename } from "node:path";
import { createContext, notifyUser, resolveIcon } from "../core/index.ts";

type HookEvent = "on-permission-request";

type CodexNotification = {
	type?: unknown;
	cwd?: unknown;
	"last-assistant-message"?: unknown;
};

export async function runCodexHook(argv: string[]): Promise<void> {
	const [first, ...extraArgs] = argv;
	if (first === undefined) return;

	if (isHookEvent(first)) {
		if (extraArgs.length > 0) {
			throw new Error("usage: jaynalerts codex-hook on-permission-request");
		}

		try {
			await handlePermissionRequest();
		} catch (error) {
			console.warn(`jaynalerts: hook handler failed: ${errorMessage(error)}`);
		}
		return;
	}

	await handleLegacyNotify(first);
}

// Codex's `notify` config runs the command with the payload as argv[0]. It only
// ever fires `agent-turn-complete`; approvals come through the hooks system.
async function handleLegacyNotify(raw: string): Promise<void> {
	let payload: CodexNotification;
	try {
		payload = JSON.parse(raw) as CodexNotification;
	} catch {
		console.warn("jaynalerts: invalid Codex notification payload");
		return;
	}

	if (payload.type !== "agent-turn-complete") return;
	const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
	const message =
		typeof payload["last-assistant-message"] === "string" &&
		payload["last-assistant-message"].trim() !== ""
			? payload["last-assistant-message"]
			: "Turn complete";

	await notify(titleWithCwd(cwd), message);
}

// Codex hooks (~/.codex/hooks.json) deliver their payload as JSON on stdin,
// the same shape Claude Code uses.
async function handlePermissionRequest(): Promise<void> {
	const payload = await readPayload();
	if (payload === null) return;

	const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
	await notify(titleWithCwd(cwd), permissionMessage(payload));
}

function permissionMessage(payload: Record<string, unknown>): string {
	const command = toolCommand(payload.tool_input);
	if (command !== null) {
		return `Approve: ${command}`;
	}

	const toolName = payload.tool_name;
	if (typeof toolName === "string" && toolName.trim() !== "") {
		return `Approve ${toolName.trim()}`;
	}

	return "Approval needed";
}

function toolCommand(toolInput: unknown): string | null {
	if (!isRecord(toolInput)) return null;

	const command = toolInput.command;
	const text = Array.isArray(command)
		? command.filter((part) => typeof part === "string").join(" ")
		: typeof command === "string"
			? command
			: "";

	return text.trim() === "" ? null : collapseWhitespace(text.trim());
}

function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ");
}

async function notify(title: string, message: string): Promise<void> {
	const ctx = await createContext();
	const iconPath = await resolveIcon(ctx.config, "codex");
	await notifyUser(ctx, { title, message, iconPath, source: "codex" });
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

function titleWithCwd(cwd: string | undefined): string {
	if (cwd !== undefined && cwd.trim() !== "") {
		const name = basename(cwd);
		if (name !== "") {
			return `Codex · ${name}`;
		}
	}
	return "Codex";
}

function isHookEvent(value: string): value is HookEvent {
	return value === "on-permission-request";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
