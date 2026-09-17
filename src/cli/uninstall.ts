// Undo everything `init` installed. Renaming this project's bundle IDs once
// left three dead `dev.stay*` rows in System Settings and every Focus
// allowlist, permanently, because nothing ever removed the bundles that
// created them. A published tool has to be able to take itself back out.

import type { Stats } from "node:fs";
import { lstat, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { helperStampFile, NOTIFIER_VARIANTS } from "../core/native.ts";
import { notifierAppForSource, resolvePaths } from "../core/paths.ts";
import type { JsonObject } from "./integrations.ts";
import {
	CODEX_NOTIFY_COMMAND,
	claudeCodeHookSpecs,
	codexHome,
	codexHookSpecs,
	defaultShellRc,
	errorMessage,
	expandUser,
	hookGroupOwnsCommand,
	isJsonObject,
	isNodeError,
	PI_EXTENSION_MARKER,
	readOptionalFile,
	resolveClaudeCodeSettingsFile,
	resolveOpencodePluginFile,
	resolvePiExtensionFile,
	resolveSymlink,
	spliceShellBlock,
	writeJsonAtomically,
	writeTextAtomically,
} from "./integrations.ts";

type UninstallOptions = {
	claudeCode: boolean;
	codex: boolean;
	opencode: boolean;
	pi: boolean;
	shell: boolean;
	shellRc: string | null;
	bundles: boolean;
	config: boolean;
	dryRun: boolean;
};

type Change = { label: string; detail: string };

export async function runUninstall(argv: string[]): Promise<void> {
	const options = parseArgs(argv);
	const changes: Change[] = [];

	if (options.dryRun) {
		console.log("Dry run — nothing will be modified.\n");
	}

	if (options.claudeCode) {
		await removeClaudeCodeHooks(options, changes);
	}
	if (options.codex) {
		await removeCodexNotify(options, changes);
		await removeCodexHooks(options, changes);
	}
	if (options.opencode) {
		await removeOpencodePlugin(options, changes);
	}
	if (options.pi) {
		await removePiExtension(options, changes);
	}
	if (options.shell) {
		await removeShellHook(options, changes);
	}
	if (options.bundles) {
		await removeNativeArtifacts(options, changes);
	}
	if (options.config) {
		await removeConfig(options, changes);
	}

	report(options, changes);
}

function report(options: UninstallOptions, changes: Change[]): void {
	if (changes.length === 0) {
		console.log("Nothing to remove — jaynalerts was not installed here.");
		return;
	}

	console.log("");
	if (options.dryRun) {
		console.log("Re-run without --dry-run to apply the changes above.");
		return;
	}

	console.log("jaynalerts removed.");

	// Name only the rows this machine actually had. The Ghostty bundle is built
	// where Ghostty is installed, so sending everyone else to look for a Ghostty
	// row they never had is worse than saying nothing.
	const removedBundles = changes
		.filter((change) => change.label.endsWith(" bundle"))
		.map((change) => change.label.slice(0, -" bundle".length));

	if (removedBundles.length > 0) {
		console.log(
			[
				"",
				"macOS keeps a Notifications row and a Focus allowlist entry for every",
				"app bundle it has ever seen, including ones that no longer exist. Remove",
				"the leftovers by hand if you want them gone:",
				`  System Settings → Notifications → ${removedBundles.join(" / ")}`,
				"  System Settings → Focus → your Focus → Allowed Notifications",
			].join("\n"),
		);
	}

	if (!options.config) {
		console.log(
			`\nYour config was left alone (${resolvePaths().configFile}); pass --config to delete it.`,
		);
	}

	console.log(
		"\n.jaynalerts.bak backups of every file we edited were left in place.",
	);
}

function parseArgs(argv: string[]): UninstallOptions {
	let claudeCode = false;
	let codex = false;
	let opencode = false;
	let pi = false;
	let shell = false;
	let shellRc: string | null = null;
	let bundles = false;
	let config = false;
	let dryRun = false;
	let selective = false;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];

		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}

		if (arg === "--config") {
			config = true;
			continue;
		}

		if (arg === "--claude-code") {
			claudeCode = true;
			selective = true;
			continue;
		}

		if (arg === "--codex") {
			codex = true;
			selective = true;
			continue;
		}

		if (arg === "--opencode") {
			opencode = true;
			selective = true;
			continue;
		}

		if (arg === "--pi") {
			pi = true;
			selective = true;
			continue;
		}

		if (arg === "--bundles") {
			bundles = true;
			selective = true;
			continue;
		}

		if (arg === "--shell") {
			shell = true;
			selective = true;
			continue;
		}

		if (arg === "--shell-rc") {
			const value = argv[++i];
			if (value === undefined) {
				throw new Error("--shell-rc requires a path");
			}
			shellRc = value;
			shell = true;
			selective = true;
			continue;
		}

		if (arg?.startsWith("--shell-rc=")) {
			shellRc = arg.slice("--shell-rc=".length);
			shell = true;
			selective = true;
			continue;
		}

		throw new Error(`unknown flag: ${arg}`);
	}

	// With no target flags, take everything back out — including the shell block,
	// which is a no-op when it was never installed.
	if (!selective) {
		return {
			claudeCode: true,
			codex: true,
			opencode: true,
			pi: true,
			shell: true,
			shellRc,
			bundles: true,
			config,
			dryRun,
		};
	}

	return {
		claudeCode,
		codex,
		opencode,
		pi,
		shell,
		shellRc,
		bundles,
		config,
		dryRun,
	};
}

async function removeClaudeCodeHooks(
	options: UninstallOptions,
	changes: Change[],
): Promise<void> {
	const file = await resolveSymlink(resolveClaudeCodeSettingsFile());
	const contents = await readOptionalFile(file);

	if (contents === null) {
		console.log(`Claude Code: nothing to remove (${file})`);
		return;
	}

	let settings: JsonObject;
	try {
		const parsed = JSON.parse(contents) as unknown;
		if (!isJsonObject(parsed)) throw new Error("expected a JSON object");
		settings = parsed;
	} catch (error) {
		throw new Error(
			`failed to parse Claude Code settings at ${file}: ${errorMessage(error)}`,
		);
	}

	const removed = pruneHooks(
		settings,
		claudeCodeHookSpecs.map((spec) => spec.command),
	);

	if (removed === 0) {
		console.log(`Claude Code: no jaynalerts hooks found (${file})`);
		return;
	}

	if (!options.dryRun) {
		await writeJsonAtomically(file, settings);
	}
	changes.push({ label: "Claude Code", detail: file });
	console.log(
		`Claude Code: removed ${removed} hook${removed === 1 ? "" : "s"} (${file})`,
	);
}

async function removeCodexHooks(
	options: UninstallOptions,
	changes: Change[],
): Promise<void> {
	const file = await resolveSymlink(join(codexHome(), "hooks.json"));
	const contents = await readOptionalFile(file);

	if (contents === null || contents.trim() === "") {
		console.log(`Codex:       nothing to remove (${file})`);
		return;
	}

	let document: JsonObject;
	try {
		const parsed = JSON.parse(contents) as unknown;
		if (!isJsonObject(parsed)) throw new Error("expected a JSON object");
		document = parsed;
	} catch (error) {
		throw new Error(
			`failed to parse Codex hooks at ${file}: ${errorMessage(error)}`,
		);
	}

	const removed = pruneHooks(
		document,
		codexHookSpecs.map((spec) => spec.command),
	);

	if (removed === 0) {
		console.log(`Codex:       no jaynalerts hooks found (${file})`);
		return;
	}

	if (!options.dryRun) {
		await writeJsonAtomically(file, document);
	}
	changes.push({ label: "Codex hooks", detail: file });
	console.log(
		`Codex:       removed ${removed} approval hook${removed === 1 ? "" : "s"} (${file})`,
	);
}

/**
 * Drop every hook group that runs one of our commands, then prune the empty
 * event arrays and the empty `hooks` table we may have created, so uninstall
 * leaves the file as close to untouched as it can.
 */
function pruneHooks(document: JsonObject, commands: string[]): number {
	if (!isJsonObject(document.hooks)) return 0;

	const hooks = document.hooks;
	let removed = 0;

	for (const [event, groups] of Object.entries(hooks)) {
		if (!Array.isArray(groups)) continue;

		const kept = groups.filter((group) => {
			const ours = commands.some((command) =>
				hookGroupOwnsCommand(group, command),
			);
			if (ours) removed += 1;
			return !ours;
		});

		if (kept.length === groups.length) continue;

		if (kept.length === 0) {
			delete hooks[event];
			continue;
		}

		hooks[event] = kept;
	}

	if (removed > 0 && Object.keys(hooks).length === 0) {
		delete document.hooks;
	}

	return removed;
}

async function removeCodexNotify(
	options: UninstallOptions,
	changes: Change[],
): Promise<void> {
	const file = await resolveSymlink(join(codexHome(), "config.toml"));
	const existing = await readOptionalFile(file);

	if (existing === null) {
		console.log(`Codex:       nothing to remove (${file})`);
		return;
	}

	const next = withoutTuiNotificationsSetting(withoutNotifyHook(existing));

	if (next === existing) {
		console.log(
			`Codex:       config.toml has no jaynalerts settings (${file})`,
		);
		return;
	}

	if (!options.dryRun) {
		await writeTextAtomically(file, next);
	}
	changes.push({ label: "Codex config", detail: file });
	console.log(`Codex:       reverted notify + [tui] settings (${file})`);
}

function withoutNotifyHook(config: string): string {
	// Only take back the exact line we wrote; a hand-edited notify command is
	// the user's, not ours.
	const ours = new RegExp(
		`^${escapeRegExp(CODEX_NOTIFY_COMMAND)}[ \\t]*\\r?\\n?`,
		"m",
	);
	return config.replace(ours, "");
}

// `init` sets `notifications = false` under [tui] to silence Codex's duplicate
// OSC 9 alert. Undo that, and drop the [tui] table if we were the ones who
// created it and it is now empty.
function withoutTuiNotificationsSetting(config: string): string {
	const header = /^[ \t]*\[tui\][ \t]*\r?\n/m.exec(config);
	if (header === null) return config;

	const bodyStart = header.index + header[0].length;
	const rest = config.slice(bodyStart);
	const nextTable = rest.search(/^[ \t]*\[/m);
	const bodyEnd = nextTable === -1 ? config.length : bodyStart + nextTable;
	const body = config.slice(bodyStart, bodyEnd);
	const ours = /^[ \t]*notifications[ \t]*=[ \t]*false[ \t]*\r?\n?/m;

	if (!ours.test(body)) return config;

	const nextBody = body.replace(ours, "");

	if (nextBody.trim() === "") {
		const before = config.slice(0, header.index);
		return `${before.endsWith("\n\n") ? before.slice(0, -1) : before}${config.slice(bodyEnd)}`;
	}

	return `${config.slice(0, bodyStart)}${nextBody}${config.slice(bodyEnd)}`;
}

async function removeOpencodePlugin(
	options: UninstallOptions,
	changes: Change[],
): Promise<void> {
	const pluginFile = await resolveSymlink(resolveOpencodePluginFile());
	const contents = await readOptionalFile(pluginFile);

	if (contents === null) {
		console.log(`opencode:    nothing to remove (${pluginFile})`);
		return;
	}

	if (!contents.includes("jaynalerts")) {
		console.log(
			`opencode:    left ${pluginFile} alone — it is not the jaynalerts plugin`,
		);
		return;
	}

	if (!options.dryRun) {
		await rm(pluginFile, { force: true });
	}
	changes.push({ label: "opencode plugin", detail: pluginFile });
	console.log(`opencode:    removed plugin (${pluginFile})`);

	const linkedPackage = join(
		dirname(dirname(pluginFile)),
		"node_modules",
		"jaynalerts",
	);

	// Only the symlink `init` made is ours. A real directory means jaynalerts is
	// installed there as a dependency, and `unlink` on it would fail anyway.
	let link: Stats;
	try {
		link = await lstat(linkedPackage);
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") {
			console.warn(
				`opencode:    could not inspect ${linkedPackage}: ${errorMessage(error)}`,
			);
		}
		return;
	}

	if (!link.isSymbolicLink()) {
		console.log(
			`opencode:    ${linkedPackage} is a real package directory; left alone`,
		);
		return;
	}

	try {
		if (!options.dryRun) {
			await unlink(linkedPackage);
		}
		changes.push({ label: "opencode package link", detail: linkedPackage });
		console.log(`opencode:    removed link (${linkedPackage})`);
	} catch (error) {
		console.warn(
			`opencode:    could not remove ${linkedPackage}: ${errorMessage(error)}`,
		);
	}
}

async function removePiExtension(
	options: UninstallOptions,
	changes: Change[],
): Promise<void> {
	const extensionFile = await resolveSymlink(resolvePiExtensionFile());
	const contents = await readOptionalFile(extensionFile);

	if (contents === null) {
		console.log(`Pi:          nothing to remove (${extensionFile})`);
		return;
	}

	if (!contents.includes(PI_EXTENSION_MARKER)) {
		console.log(
			`Pi:          left ${extensionFile} alone — it is not the jaynalerts extension`,
		);
		return;
	}

	if (!options.dryRun) {
		await rm(extensionFile, { force: true });
	}
	changes.push({ label: "Pi extension", detail: extensionFile });
	console.log(`Pi:          removed extension (${extensionFile})`);
}

async function removeShellHook(
	options: UninstallOptions,
	changes: Change[],
): Promise<void> {
	const expandedRc = expandUser(options.shellRc ?? defaultShellRc());
	const resolvedRc = await resolveSymlink(expandedRc);
	const existing = await readOptionalFile(resolvedRc);

	if (existing === null) {
		console.log(`shell:       nothing to remove (${resolvedRc})`);
		return;
	}

	const next = spliceShellBlock(existing, null);

	if (next === existing) {
		console.log(`shell:       no managed block found (${resolvedRc})`);
		return;
	}

	if (!options.dryRun) {
		await writeTextAtomically(resolvedRc, next);
	}
	changes.push({ label: "shell hook", detail: resolvedRc });
	console.log(`shell:       removed managed block (${resolvedRc})`);
	console.log("             open a new shell for it to take effect");
}

async function removeNativeArtifacts(
	options: UninstallOptions,
	changes: Change[],
): Promise<void> {
	const paths = resolvePaths();

	for (const variant of NOTIFIER_VARIANTS) {
		const app = notifierAppForSource(paths, variant.source);
		const contents = await readOptionalFile(
			join(app, "Contents", "Info.plist"),
		);

		if (contents === null) continue;

		if (!contents.includes("dev.jaynalerts.")) {
			console.warn(
				`notifier:    left ${app} alone — it is not a jaynalerts bundle`,
			);
			continue;
		}

		if (!options.dryRun) {
			await rm(app, { recursive: true, force: true });
		}
		changes.push({ label: `${variant.label} bundle`, detail: app });
		console.log(`notifier:    removed ${app}`);
	}

	if (await exists(paths.bundleIdBin)) {
		if (!options.dryRun) {
			await rm(paths.bundleIdBin, { force: true });
			await rm(helperStampFile(paths), { force: true });
		}
		changes.push({ label: "focus helper", detail: paths.bundleIdBin });
		console.log(`focus:       removed ${paths.bundleIdBin}`);
	}

	if (!options.dryRun) {
		await rm(join(paths.dataDir, "rebuild.lock"), { force: true });
	}
}

async function removeConfig(
	options: UninstallOptions,
	changes: Change[],
): Promise<void> {
	const paths = resolvePaths();

	if (!(await exists(paths.configFile))) {
		console.log(`config:      nothing to remove (${paths.configFile})`);
		return;
	}

	if (!options.dryRun) {
		await rm(paths.configFile, { force: true });
	}
	changes.push({ label: "config", detail: paths.configFile });
	console.log(`config:      removed ${paths.configFile}`);
}

async function exists(file: string): Promise<boolean> {
	return Bun.file(file).exists();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
