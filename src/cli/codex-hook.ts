import { open } from "node:fs/promises";
import { basename } from "node:path";
import { createContext, notifyUser, resolveIcon } from "../core/index.ts";

type HookEvent = "on-permission-request";

type CodexNotification = {
	type?: unknown;
	cwd?: unknown;
	"input-messages"?: unknown;
	"last-assistant-message"?: unknown;
};

const AUTOMATIC_APPROVAL_REVIEWERS = new Set([
	"auto_review",
	"guardian_subagent",
]);
const JSONL_READ_CHUNK_BYTES = 64 * 1024;
const MAX_JSONL_RECORD_BYTES = 1024 * 1024;
const TURN_CONTEXT_MARKER = Buffer.from('"type":"turn_context"');
const TITLE_PROMPT_PREFIX = "Generate a concise, single-line task title";

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
	if (isTitleGenerationTurn(payload)) return;
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
// Codex generates a thread title in a background turn right after the first
// message. That turn also fires `agent-turn-complete`, with the title prompt as
// input and `{"title":"..."}` as the assistant message.
export function isTitleGenerationTurn(payload: CodexNotification): boolean {
	const input = payload["input-messages"];
	if (Array.isArray(input)) {
		const prompt = input.find(
			(item) => typeof item === "string" && item.trim() !== "",
		);
		if (typeof prompt === "string" && prompt.startsWith(TITLE_PROMPT_PREFIX)) {
			return true;
		}
	}

	const message = payload["last-assistant-message"];
	if (typeof message === "string") {
		try {
			const parsed: unknown = JSON.parse(message);
			if (
				isRecord(parsed) &&
				Object.keys(parsed).length === 1 &&
				nonEmptyString(parsed.title) !== null
			) {
				return true;
			}
		} catch {
			// Plain assistant text, not a title payload.
		}
	}

	return false;
}

async function handlePermissionRequest(): Promise<void> {
	const payload = await readPayload();
	if (payload === null) return;
	if (!(await permissionRequestNeedsUserAction(payload))) return;

	const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
	await notify(titleWithCwd(cwd), permissionMessage(payload));
}

export async function permissionRequestNeedsUserAction(
	payload: Record<string, unknown>,
): Promise<boolean> {
	const transcriptPath = nonEmptyString(payload.transcript_path);
	const turnId = nonEmptyString(payload.turn_id);
	if (transcriptPath === null || turnId === null) return true;

	try {
		// PermissionRequest fires before auto-review decides, and its payload does
		// not identify the reviewer. The matching turn context does.
		const reviewer = await approvalsReviewerForTurn(transcriptPath, turnId);
		return reviewer === null || !AUTOMATIC_APPROVAL_REVIEWERS.has(reviewer);
	} catch (error) {
		if (process.env.JAYNALERTS_DEBUG) {
			console.warn(
				`jaynalerts: could not inspect Codex approval routing: ${errorMessage(error)}`,
			);
		}
		return true;
	}
}

async function approvalsReviewerForTurn(
	transcriptPath: string,
	turnId: string,
): Promise<string | null> {
	const file = await open(transcriptPath, "r");

	try {
		const { size } = await file.stat();
		let position = size;
		let partialLine = Buffer.alloc(0);
		let discardingOversizedLine = false;

		// Rollouts can be large, so scan complete JSONL records from the end and
		// avoid loading the whole transcript for every permission request.
		while (position > 0) {
			const start = Math.max(0, position - JSONL_READ_CHUNK_BYTES);
			const chunk = Buffer.alloc(position - start);
			const { bytesRead } = await file.read(chunk, 0, chunk.length, start);
			const bytes = chunk.subarray(0, bytesRead);
			let segmentEnd = bytes.length;

			for (let index = bytes.length - 1; index >= 0; index -= 1) {
				if (bytes[index] !== 0x0a) continue;

				const segment = bytes.subarray(index + 1, segmentEnd);
				if (!discardingOversizedLine) {
					const line = Buffer.concat([segment, partialLine]);
					const reviewer = reviewerFromTurnContextLine(line, turnId);
					if (reviewer.matched) return reviewer.value;
				}

				partialLine = Buffer.alloc(0);
				discardingOversizedLine = false;
				segmentEnd = index;
			}

			const segment = bytes.subarray(0, segmentEnd);
			if (!discardingOversizedLine) {
				if (segment.length + partialLine.length > MAX_JSONL_RECORD_BYTES) {
					partialLine = Buffer.alloc(0);
					discardingOversizedLine = true;
				} else {
					partialLine = Buffer.concat([segment, partialLine]);
				}
			}

			position = start;
		}

		if (!discardingOversizedLine && partialLine.length > 0) {
			const reviewer = reviewerFromTurnContextLine(partialLine, turnId);
			if (reviewer.matched) return reviewer.value;
		}

		return null;
	} finally {
		await file.close();
	}
}

type ReviewerMatch =
	| { matched: false }
	| { matched: true; value: string | null };

function reviewerFromTurnContextLine(
	line: Buffer,
	turnId: string,
): ReviewerMatch {
	if (!line.includes(TURN_CONTEXT_MARKER)) return { matched: false };

	let record: unknown;
	try {
		record = JSON.parse(line.toString("utf8"));
	} catch {
		return { matched: false };
	}

	if (!isRecord(record) || record.type !== "turn_context") {
		return { matched: false };
	}

	const turnContext = record.payload;
	if (!isRecord(turnContext) || turnContext.turn_id !== turnId) {
		return { matched: false };
	}

	return {
		matched: true,
		value: nonEmptyString(turnContext.approvals_reviewer),
	};
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

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
