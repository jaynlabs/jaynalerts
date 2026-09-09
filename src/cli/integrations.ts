// Everything `init` writes and `uninstall` has to take back: the file
// locations, the exact commands jaynalerts owns, and the small atomic-write
// helpers both sides share. Keeping them in one place is what stops uninstall
// from drifting away from install and leaving dead rows behind.

import { randomUUID } from "node:crypto";
import {
	copyFile,
	mkdir,
	readFile,
	readlink,
	realpath,
	rename,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type JsonObject = Record<string, unknown>;

export type HookSpec = {
	event: string;
	matcher?: string;
	command: string;
	async?: boolean;
};

export const SHELL_BLOCK_BEGIN = "# jaynalerts begin (managed — do not edit)";
export const SHELL_BLOCK_END = "# jaynalerts end";

export const CODEX_NOTIFY_COMMAND = 'notify = ["jaynalerts", "codex-hook"]';
export const PI_EXTENSION_MARKER = "jaynalerts Pi integration — managed";

export const claudeCodeHookSpecs: HookSpec[] = [
	{
		event: "Stop",
		command: "jaynalerts claude-code-hook on-stop",
	},
	{
		event: "Notification",
		matcher: "permission_prompt",
		command: "jaynalerts claude-code-hook on-notification",
	},
];

// Codex's legacy `notify` command only ever fires `agent-turn-complete`.
// Approval prompts arrive through the hooks system instead, which reads
// $CODEX_HOME/hooks.json using the same shape as Claude Code's settings.
export const codexHookSpecs: HookSpec[] = [
	{
		event: "PermissionRequest",
		matcher: "*",
		command: "jaynalerts codex-hook on-permission-request",
		async: true,
	},
];

export function codexHome(): string {
	return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function resolveClaudeCodeSettingsFile(): string {
	return join(homedir(), ".claude", "settings.json");
}

export function resolveOpencodePluginFile(): string {
	return join(homedir(), ".config", "opencode", "plugins", "jaynalerts.ts");
}

export function resolvePiExtensionFile(): string {
	const piAgentDir =
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(piAgentDir, "extensions", "jaynalerts.ts");
}

export async function readPiExtensionSource(): Promise<string> {
	return Bun.file(
		join(import.meta.dir, "..", "..", "examples", "pi-extension.ts"),
	).text();
}

export function defaultShellRc(): string {
	return join(homedir(), ".zshrc");
}

export function expandUser(path: string): string {
	if (path === "~") {
		return homedir();
	}

	if (path.startsWith("~/")) {
		return join(homedir(), path.slice(2));
	}

	return path;
}

/**
 * Replace the managed shell block with `block`, or drop it when `block` is
 * null. Install and uninstall both go through here so they can never disagree
 * about where the block starts and ends.
 */
export function spliceShellBlock(
	existing: string,
	block: string | null,
): string {
	const beginIdx = existing.indexOf(SHELL_BLOCK_BEGIN);

	if (beginIdx === -1) {
		if (block === null) return existing;
		const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
		const leadingNewline = existing === "" ? "" : "\n";
		return `${existing}${separator}${leadingNewline}${block}`;
	}

	const endMarkerIdx = existing.indexOf(SHELL_BLOCK_END, beginIdx);

	if (endMarkerIdx === -1) {
		throw new Error(
			`found jaynalerts begin marker in ${SHELL_BLOCK_BEGIN} block but no matching end marker — fix the file manually`,
		);
	}

	const endIdx = endMarkerIdx + SHELL_BLOCK_END.length;
	const trailingNewline = existing[endIdx] === "\n" ? 1 : 0;
	const before = existing.slice(0, beginIdx);
	const after = existing.slice(endIdx + trailingNewline);

	if (block === null) {
		// The block was written with a blank line in front of it; take that back
		// too so repeated install/uninstall cycles do not grow the file.
		return `${before.endsWith("\n\n") ? before.slice(0, -1) : before}${after}`;
	}

	return `${before}${block}${after}`;
}

export function findCommandHookGroup(
	eventHooks: unknown[],
	command: string,
): JsonObject | undefined {
	return eventHooks.find((group): group is JsonObject =>
		hookGroupOwnsCommand(group, command),
	);
}

export function hookGroupOwnsCommand(
	group: unknown,
	command: string,
): group is JsonObject {
	if (!isJsonObject(group) || !Array.isArray(group.hooks)) {
		return false;
	}

	return group.hooks.some(
		(handler) =>
			isJsonObject(handler) &&
			handler.type === "command" &&
			handler.command === command,
	);
}

export async function readOptionalFile(file: string): Promise<string | null> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return null;
		}

		throw error;
	}
}

export async function createBackupIfNeeded(
	sourceFile: string,
	backupFile: string,
): Promise<boolean> {
	try {
		await copyFile(sourceFile, backupFile, 1);
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return false;
		}

		if (isNodeError(error) && error.code === "EEXIST") {
			return false;
		}

		throw error;
	}
}

export async function writeTextAtomically(
	file: string,
	contents: string,
): Promise<void> {
	await mkdir(dirname(file), { recursive: true });

	const temporaryFile = `${file}.tmp.${process.pid}.${randomUUID()}`;

	try {
		await writeFile(temporaryFile, contents);
		await rename(temporaryFile, file);
	} catch (error) {
		await Bun.file(temporaryFile)
			.delete()
			.catch(() => {});
		throw error;
	}
}

export async function writeJsonAtomically(
	file: string,
	document: JsonObject,
): Promise<void> {
	await writeTextAtomically(file, `${JSON.stringify(document, null, 2)}\n`);
}

export async function resolveSymlink(file: string): Promise<string> {
	try {
		return await realpath(file);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			try {
				const target = await readlink(file);
				return isAbsolute(target) ? target : resolve(dirname(file), target);
			} catch (readlinkError) {
				if (isNodeError(readlinkError) && readlinkError.code === "ENOENT") {
					return file;
				}

				throw readlinkError;
			}
		}

		throw error;
	}
}

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
