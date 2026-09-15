import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isTitleGenerationTurn,
	permissionRequestNeedsUserAction,
} from "../src/cli/codex-hook.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { force: true, recursive: true });
	}
});

test("suppresses permission alerts handled by auto-review", async () => {
	const transcriptPath = await writeTranscript([
		turnContext("turn-auto", "auto_review"),
	]);

	expect(
		await permissionRequestNeedsUserAction(
			hookPayload(transcriptPath, "turn-auto"),
		),
	).toBe(false);
});

test("suppresses permission alerts handled by a guardian subagent", async () => {
	const transcriptPath = await writeTranscript([
		turnContext("turn-guardian", "guardian_subagent"),
	]);

	expect(
		await permissionRequestNeedsUserAction(
			hookPayload(transcriptPath, "turn-guardian"),
		),
	).toBe(false);
});

test("keeps permission alerts routed to the user", async () => {
	const transcriptPath = await writeTranscript([
		turnContext("older-turn", "auto_review"),
		JSON.stringify({ type: "response_item", payload: { text: "x" } }),
		turnContext("turn-user", "user"),
	]);

	expect(
		await permissionRequestNeedsUserAction(
			hookPayload(transcriptPath, "turn-user"),
		),
	).toBe(true);
});

test("finds turn context across chunks and skips oversized records", async () => {
	const transcriptPath = await writeTranscript([
		turnContext("turn-auto", "auto_review"),
		JSON.stringify({
			type: "response_item",
			payload: { text: "x".repeat(1024 * 1024 + 1) },
		}),
	]);

	expect(
		await permissionRequestNeedsUserAction(
			hookPayload(transcriptPath, "turn-auto"),
		),
	).toBe(false);
});

test("fails open when approval routing cannot be verified", async () => {
	const directory = await mkdtemp(join(tmpdir(), "jaynalerts-codex-hook-"));
	temporaryDirectories.push(directory);
	const missingPath = join(directory, "missing.jsonl");

	expect(
		await permissionRequestNeedsUserAction(
			hookPayload(missingPath, "turn-missing"),
		),
	).toBe(true);
	expect(await permissionRequestNeedsUserAction({})).toBe(true);
});

test("ignores the background thread-title turn", () => {
	expect(
		isTitleGenerationTurn({
			type: "agent-turn-complete",
			"input-messages": [
				"Generate a concise, single-line task title of at most 36 characters and under five words where possible. Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.\n\nUser prompt:\nsay hi",
			],
			"last-assistant-message": '{"title":"Say hi"}',
		}),
	).toBe(true);
});

function hookPayload(
	transcriptPath: string,
	turnId: string,
): Record<string, unknown> {
	return {
		transcript_path: transcriptPath,
		turn_id: turnId,
	};
}

function turnContext(turnId: string, approvalsReviewer: string): string {
	return JSON.stringify({
		type: "turn_context",
		payload: {
			turn_id: turnId,
			approvals_reviewer: approvalsReviewer,
		},
	});
}

async function writeTranscript(lines: string[]): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "jaynalerts-codex-hook-"));
	temporaryDirectories.push(directory);
	const transcriptPath = join(directory, "rollout.jsonl");
	await writeFile(transcriptPath, `${lines.join("\n")}\n`);
	return transcriptPath;
}
