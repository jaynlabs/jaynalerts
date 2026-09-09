import { constants, type Stats } from "node:fs";
import {
	copyFile,
	lstat,
	mkdir,
	realpath,
	symlink,
	unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildNativeArtifacts } from "../core/native.ts";
import { resolvePaths } from "../core/paths.ts";
import { checkSwiftToolchain, swiftToolchainMessage } from "../core/swift.ts";
import {
	collectNotifierStatuses,
	describeStatus,
	manualSteps,
} from "./doctor.ts";
import type { JsonObject } from "./integrations.ts";
import {
	CODEX_NOTIFY_COMMAND,
	claudeCodeHookSpecs,
	codexHome,
	codexHookSpecs,
	createBackupIfNeeded,
	defaultShellRc,
	errorMessage,
	expandUser,
	findCommandHookGroup,
	isJsonObject,
	isNodeError,
	readOptionalFile,
	readPiExtensionSource,
	resolveClaudeCodeSettingsFile,
	resolveOpencodePluginFile,
	resolvePiExtensionFile,
	resolveSymlink,
	SHELL_BLOCK_BEGIN,
	SHELL_BLOCK_END,
	spliceShellBlock,
	writeJsonAtomically,
	writeTextAtomically,
} from "./integrations.ts";

type InitOptions = {
	claudeCode: boolean;
	codex: boolean;
	opencode: boolean;
	pi: boolean;
	shell: boolean;
	shellRc: string | null;
};

const SHELL_BLOCK_BODY = `if [[ -n \${ZSH_VERSION-} ]] && command -v jaynalerts >/dev/null 2>&1; then
  zmodload zsh/datetime 2>/dev/null
  typeset -g __jaynalerts_start=0
  typeset -g __jaynalerts_cmd=""
  __jaynalerts_preexec() {
    __jaynalerts_start=$EPOCHREALTIME
    __jaynalerts_cmd=$1
  }
  __jaynalerts_precmd() {
    local ec=$?
    [[ -z $__jaynalerts_cmd ]] && return
    local dur_ms=$(( (EPOCHREALTIME - __jaynalerts_start) * 1000 ))
    jaynalerts notify-command --cmd "$__jaynalerts_cmd" --exit $ec --duration-ms \${dur_ms%.*} >/dev/null 2>&1 &!
    __jaynalerts_cmd=""
  }
  autoload -Uz add-zsh-hook
  add-zsh-hook preexec __jaynalerts_preexec
  add-zsh-hook precmd __jaynalerts_precmd
fi`;

function buildShellBlock(): string {
	return `${SHELL_BLOCK_BEGIN}\n${SHELL_BLOCK_BODY}\n${SHELL_BLOCK_END}\n`;
}

export async function runInit(argv: string[]): Promise<void> {
	const options = parseArgs(argv);

	// Compiling is not optional — every banner goes through the Swift notifier —
	// so find out before touching anyone's config files.
	await requireSwiftToolchain();

	if (options.claudeCode) {
		await installClaudeCodeHooks();
	}
	if (options.codex) {
		await installCodexNotify();
		await installCodexHooks();
	}

	if (options.opencode) {
		await installOpencodePlugin();
	}
	if (options.pi) {
		await installPiExtension();
	}

	const shellRc = options.shell
		? await installShellHook(options.shellRc ?? defaultShellRc())
		: null;

	await buildNativeArtifacts(resolvePaths());
	await reportRemainingSteps(options, shellRc);
}

async function requireSwiftToolchain(): Promise<void> {
	if (process.platform !== "darwin") return;

	const toolchain = await checkSwiftToolchain();
	if (toolchain.ok) return;

	throw new Error(swiftToolchainMessage(toolchain.problem));
}

// macOS keeps each permission grant, Persistent toggle and the Focus
// allowlist to itself. Init cannot set them, so it ends by saying exactly which
// ones are still outstanding instead of leaving them to be discovered.
async function reportRemainingSteps(
	options: InitOptions,
	shellRc: string | null,
): Promise<void> {
	if (process.platform !== "darwin") return;

	const statuses = await collectNotifierStatuses();

	console.log("");
	console.log("macOS notification settings:");
	for (const status of statuses) {
		console.log(`  ${status.variant.label}: ${describeStatus(status)}`);
	}

	console.log("");
	for (const line of manualSteps(statuses, {
		codex: options.codex,
		shellRc,
	})) {
		console.log(line);
	}
}

function parseArgs(argv: string[]): InitOptions {
	let claudeCode = false;
	let codex = false;
	let opencode = false;
	let pi = false;
	let shell = false;
	let shellRc: string | null = null;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];

		if (arg === "--claude-code") {
			claudeCode = true;
			continue;
		}

		if (arg === "--codex") {
			codex = true;
			continue;
		}

		if (arg === "--opencode") {
			opencode = true;
			continue;
		}

		if (arg === "--pi") {
			pi = true;
			continue;
		}

		if (arg === "--shell") {
			shell = true;
			continue;
		}

		if (arg === "--shell-rc") {
			const value = argv[++i];
			if (value === undefined) {
				throw new Error("--shell-rc requires a path");
			}
			shellRc = value;
			shell = true;
			continue;
		}

		if (arg?.startsWith("--shell-rc=")) {
			shellRc = arg.slice("--shell-rc=".length);
			shell = true;
			continue;
		}

		throw new Error(`unknown flag: ${arg}`);
	}

	if (!claudeCode && !codex && !opencode && !pi && !shell) {
		return {
			claudeCode: true,
			codex: true,
			opencode: true,
			pi: true,
			shell: false,
			shellRc: null,
		};
	}

	return { claudeCode, codex, opencode, pi, shell, shellRc };
}

async function installCodexNotify(): Promise<void> {
	const configFile = await resolveSymlink(join(codexHome(), "config.toml"));
	const existing = (await readOptionalFile(configFile)) ?? "";
	const next = withTuiNotificationsDisabled(withNotifyHook(existing));

	if (next === existing) {
		console.log(`Codex:       notify hook already up to date (${configFile})`);
		return;
	}

	const backupFile = `${configFile}.jaynalerts.bak`;
	const backupCreated = await createBackupIfNeeded(configFile, backupFile);
	await writeTextAtomically(configFile, next);
	console.log(`Codex:       notify hook installed (${configFile})`);
	if (backupCreated) console.log(`             backup: ${backupFile}`);
}

function withNotifyHook(config: string): string {
	const command = CODEX_NOTIFY_COMMAND;
	const firstTable = config.search(/^\s*\[/m);
	const topLevelEnd = firstTable === -1 ? config.length : firstTable;
	const topLevel = config.slice(0, topLevelEnd);
	const topLevelNotify = /^notify\s*=.*$/m;

	if (topLevelNotify.test(topLevel)) {
		return `${topLevel.replace(topLevelNotify, command)}${config.slice(topLevelEnd)}`;
	}

	const insertion = `${command}\n`;
	return firstTable === -1
		? `${config}${config.length > 0 && !config.endsWith("\n") ? "\n" : ""}${insertion}`
		: `${config.slice(0, firstTable)}${insertion}\n${config.slice(firstTable)}`;
}

// Codex renders its own turn-complete alert by writing an OSC 9 escape to the
// terminal, which the terminal emulator then posts as a desktop notification.
// Left on, every alert arrives twice: once from us, once from the terminal.
// Ours carries the Codex icon, focus-aware urgency and tmux click routing, so
// we win and Codex's built-in goes quiet.
function withTuiNotificationsDisabled(config: string): string {
	const setting = "notifications = false";
	const tuiHeader = /^[ \t]*\[tui\][ \t]*$/m;
	const header = tuiHeader.exec(config);

	if (header === null) {
		const separator =
			config.length === 0 ? "" : config.endsWith("\n") ? "\n" : "\n\n";
		return `${config}${separator}[tui]\n${setting}\n`;
	}

	const bodyStart = header.index + header[0].length;
	const rest = config.slice(bodyStart);
	// The [tui] table ends at the next table header, or at end of file.
	const nextTable = rest.search(/^[ \t]*\[/m);
	const bodyEnd = nextTable === -1 ? config.length : bodyStart + nextTable;
	const body = config.slice(bodyStart, bodyEnd);
	const existingSetting = /^[ \t]*notifications[ \t]*=.*$/m;

	const nextBody = existingSetting.test(body)
		? body.replace(existingSetting, setting)
		: `\n${setting}${body.startsWith("\n") ? "" : "\n"}${body}`;

	return `${config.slice(0, bodyStart)}${nextBody}${config.slice(bodyEnd)}`;
}

async function installCodexHooks(): Promise<void> {
	const hooksFile = await resolveSymlink(join(codexHome(), "hooks.json"));
	const existing = await readOptionalFile(hooksFile);
	const document = parseCodexHooksFile(hooksFile, existing);
	const changed = mergeCodexHooks(document);

	if (!changed) {
		console.log(`Codex:       hooks already up to date (${hooksFile})`);
		return;
	}

	const backupFile = `${hooksFile}.jaynalerts.bak`;
	const backupCreated = await createBackupIfNeeded(hooksFile, backupFile);
	await writeJsonAtomically(hooksFile, document);
	console.log(`Codex:       approval hook installed (${hooksFile})`);
	if (backupCreated) console.log(`             backup: ${backupFile}`);
	console.log(
		"             Codex asks you to trust new hooks the next time you start it",
	);
}

function parseCodexHooksFile(
	hooksFile: string,
	contents: string | null,
): JsonObject {
	if (contents === null || contents.trim() === "") {
		return {};
	}

	try {
		const parsed = JSON.parse(contents) as unknown;

		if (!isJsonObject(parsed)) {
			throw new Error("expected a JSON object");
		}

		return parsed;
	} catch (error) {
		throw new Error(
			`failed to parse Codex hooks at ${hooksFile}: ${errorMessage(error)}`,
		);
	}
}

function mergeCodexHooks(document: JsonObject): boolean {
	let changed = false;

	if (document.hooks === undefined) {
		document.hooks = {};
		changed = true;
	}

	if (!isJsonObject(document.hooks)) {
		throw new Error("Codex hooks.json hooks field must be a JSON object");
	}

	const hooks = document.hooks;

	for (const spec of codexHookSpecs) {
		if (hooks[spec.event] === undefined) {
			hooks[spec.event] = [];
			changed = true;
		}

		if (!Array.isArray(hooks[spec.event])) {
			throw new Error(
				`Codex hooks.json hooks.${spec.event} field must be an array`,
			);
		}

		const eventHooks = hooks[spec.event] as unknown[];
		const handler = {
			type: "command",
			command: spec.command,
			...(spec.async === undefined ? {} : { async: spec.async }),
		};

		const existingGroup = findCommandHookGroup(eventHooks, spec.command);
		if (existingGroup === undefined) {
			eventHooks.push({
				...(spec.matcher === undefined ? {} : { matcher: spec.matcher }),
				hooks: [handler],
			});
			changed = true;
			continue;
		}

		if (syncHookMatcher(existingGroup, spec.matcher)) {
			changed = true;
		}
		if (syncCodexHandler(existingGroup, spec.command, handler)) {
			changed = true;
		}
	}

	return changed;
}

function syncCodexHandler(
	group: JsonObject,
	command: string,
	handler: JsonObject,
): boolean {
	const handlers = group.hooks as unknown[];
	const index = handlers.findIndex(
		(candidate) =>
			isJsonObject(candidate) &&
			candidate.type === "command" &&
			candidate.command === command,
	);

	if (index === -1) {
		return false;
	}

	const current = handlers[index] as JsonObject;
	const merged = { ...current, ...handler };

	if (JSON.stringify(current) === JSON.stringify(merged)) {
		return false;
	}

	handlers[index] = merged;
	return true;
}

// The managed block is zsh: `&!` and `add-zsh-hook` are zsh syntax, and bash
// fails to *parse* a file containing `&!` — so writing this into a .bashrc does
// not merely no-op, it takes the whole rc file down and everything after the
// block silently stops running. `--shell-rc` invites exactly that, so refuse
// any rc that is not zsh rather than hand someone a broken shell.
function assertZshRc(rcPath: string): void {
	if (rcPath.toLowerCase().includes("zsh")) return;

	throw new Error(
		[
			`refusing to write the shell hook into ${rcPath}.`,
			"The hook is zsh-only — bash cannot even parse it, so this would break",
			"the whole rc file. Point --shell-rc at a zsh rc (~/.zshrc), or skip",
			"--shell and use the agent integrations only.",
		].join("\n"),
	);
}

async function installShellHook(rcPath: string): Promise<string> {
	assertZshRc(rcPath);

	const expandedRc = expandUser(rcPath);
	const resolvedRc = await resolveSymlink(expandedRc);
	const existing = await readOptionalFile(resolvedRc);
	const next = spliceShellBlock(existing ?? "", buildShellBlock());
	const displayPath =
		resolvedRc === expandedRc ? resolvedRc : `${expandedRc} → ${resolvedRc}`;

	if (existing === next) {
		console.log(`shell:       hook already up to date (${displayPath})`);
		return expandedRc;
	}

	if (existing !== null) {
		const backupFile = `${resolvedRc}.jaynalerts.bak`;
		await createBackupIfNeeded(resolvedRc, backupFile);
		console.log(`shell:       hook updated in ${displayPath}`);
		console.log(`             backup: ${backupFile}`);
	} else {
		console.log(`shell:       hook installed in ${displayPath}`);
	}

	await writeTextAtomically(resolvedRc, next);
	return expandedRc;
}

async function installClaudeCodeHooks(): Promise<void> {
	const settingsFile = resolveClaudeCodeSettingsFile();
	const resolvedSettingsFile = await resolveSymlink(settingsFile);
	const backupFile = `${resolvedSettingsFile}.jaynalerts.bak`;
	const settings = await readSettings(resolvedSettingsFile);
	const changed = mergeHooks(settings);
	let backupCreated = false;

	if (changed) {
		backupCreated = await createBackupIfNeeded(
			resolvedSettingsFile,
			backupFile,
		);
		await writeJsonAtomically(resolvedSettingsFile, settings);
	}

	console.log(
		`Claude Code: ${changed ? "hooks installed" : "hooks already up to date"} (${resolvedSettingsFile})`,
	);
	if (backupCreated) {
		console.log(`             backup: ${backupFile}`);
	}
}

async function readSettings(settingsFile: string): Promise<JsonObject> {
	const contents = await readOptionalFile(settingsFile);

	if (contents === null) {
		return {};
	}

	try {
		const parsed = JSON.parse(contents) as unknown;

		if (!isJsonObject(parsed)) {
			throw new Error("expected a JSON object");
		}

		return parsed;
	} catch (error) {
		throw new Error(
			`failed to parse Claude Code settings at ${settingsFile}: ${errorMessage(error)}`,
		);
	}
}

function mergeHooks(settings: JsonObject): boolean {
	let changed = false;

	if (settings.hooks === undefined) {
		settings.hooks = {};
		changed = true;
	}

	if (!isJsonObject(settings.hooks)) {
		throw new Error("Claude Code settings hooks field must be a JSON object");
	}

	const hooks = settings.hooks;

	for (const spec of claudeCodeHookSpecs) {
		if (hooks[spec.event] === undefined) {
			hooks[spec.event] = [];
			changed = true;
		}

		if (!Array.isArray(hooks[spec.event])) {
			throw new Error(
				`Claude Code settings hooks.${spec.event} field must be an array`,
			);
		}

		const eventHooks = hooks[spec.event] as unknown[];

		const existingHook = findCommandHookGroup(eventHooks, spec.command);
		if (existingHook !== undefined) {
			if (syncHookMatcher(existingHook, spec.matcher)) {
				changed = true;
			}
			continue;
		}

		eventHooks.push({
			...(spec.matcher === undefined ? {} : { matcher: spec.matcher }),
			hooks: [{ type: "command", command: spec.command }],
		});
		changed = true;
	}

	return changed;
}

function syncHookMatcher(
	group: JsonObject,
	matcher: string | undefined,
): boolean {
	if (matcher === undefined) {
		if (!("matcher" in group)) {
			return false;
		}

		delete group.matcher;
		return true;
	}

	if (group.matcher === matcher) {
		return false;
	}

	group.matcher = matcher;
	return true;
}

async function installPiExtension(): Promise<void> {
	const targetFile = resolvePiExtensionFile();
	const resolvedFile = await resolveSymlink(targetFile);
	const backupFile = `${resolvedFile}.bak`;
	const extensionContents = await readPiExtensionSource();
	const currentContents = await readOptionalFile(resolvedFile);

	if (currentContents === null) {
		await writeTextAtomically(resolvedFile, extensionContents);
		console.log(`Pi:          extension installed at ${resolvedFile}`);
		console.log("             restart Pi or run /reload");
		return;
	}

	if (currentContents === extensionContents) {
		console.log(`Pi:          extension already up to date (${resolvedFile})`);
		return;
	}

	const backedUp = await createExclusiveBackup(resolvedFile, backupFile);
	await writeTextAtomically(resolvedFile, extensionContents);
	console.log(`Pi:          extension updated at ${resolvedFile}`);
	if (backedUp) {
		console.log(`             backup: ${backupFile}`);
	}
	console.log("             restart Pi or run /reload");
}
async function installOpencodePlugin(): Promise<void> {
	const targetFile = resolveOpencodePluginFile();
	const resolvedFile = await resolveSymlink(targetFile);
	const backupFile = `${resolvedFile}.bak`;
	const pluginContents = await readOpencodePluginSource();
	const currentContents = await readOptionalFile(resolvedFile);

	if (currentContents === null) {
		await writeTextAtomically(resolvedFile, pluginContents);
		console.log(`opencode:    plugin installed at ${resolvedFile}`);
		await linkOpencodePackage();
		return;
	}

	if (currentContents === pluginContents) {
		console.log(`opencode:    plugin already up to date (${resolvedFile})`);
		await linkOpencodePackage();
		return;
	}

	const backedUp = await createExclusiveBackup(resolvedFile, backupFile);
	await writeTextAtomically(resolvedFile, pluginContents);
	console.log(`opencode:    plugin updated at ${resolvedFile}`);
	if (backedUp) {
		console.log(`             backup: ${backupFile}`);
	}
	await linkOpencodePackage();
}

async function readOpencodePluginSource(): Promise<string> {
	const pluginPath = join(
		import.meta.dir,
		"..",
		"..",
		"examples",
		"opencode-plugin.ts",
	);

	return Bun.file(pluginPath).text();
}

// The plugin does `import "jaynalerts"`, so opencode's config directory needs a
// node_modules entry pointing back at this install. `bun link jaynalerts` can
// only ever resolve for a cloned checkout that ran `bun link` first — an
// npm-installed copy is not in bun's link registry, so that call failed for
// every published-package user. Symlinking the package root is what `bun link`
// would have produced anyway, and it works for clone, bun link and npm alike.
async function linkOpencodePackage(): Promise<void> {
	const realPluginFile = await resolveSymlink(resolveOpencodePluginFile());
	const opencodeConfigDir = dirname(dirname(realPluginFile));
	const opencodePackageDir = join(opencodeConfigDir, "node_modules");
	const linkedPackage = join(opencodePackageDir, "jaynalerts");
	const packageRoot = join(import.meta.dir, "..", "..");

	const existing = await lstatOrNull(linkedPackage);

	// A real directory means jaynalerts is installed there as a dependency;
	// the import already resolves and it is not ours to replace.
	if (existing !== null && !existing.isSymbolicLink()) {
		console.log(
			`opencode:    ${linkedPackage} is a real package directory; left alone`,
		);
		return;
	}

	if (existing !== null && (await linkResolvesTo(linkedPackage, packageRoot))) {
		console.log(`opencode:    already linked to ${packageRoot}`);
		return;
	}

	try {
		await mkdir(opencodePackageDir, { recursive: true });
		if (existing !== null) {
			await unlink(linkedPackage);
		}
		await symlink(packageRoot, linkedPackage, "dir");
	} catch (error) {
		warnManualLink(linkedPackage, packageRoot, errorMessage(error));
		return;
	}

	console.log(`opencode:    linked jaynalerts into ${opencodePackageDir}/`);
}

async function lstatOrNull(path: string): Promise<Stats | null> {
	try {
		return await lstat(path);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return null;
		}

		throw error;
	}
}

async function linkResolvesTo(link: string, target: string): Promise<boolean> {
	try {
		return (await realpath(link)) === (await realpath(target));
	} catch {
		return false;
	}
}

function warnManualLink(
	linkedPackage: string,
	packageRoot: string,
	detail: string,
): void {
	console.warn(`opencode:    could not link jaynalerts into ${linkedPackage}`);
	console.warn(`             ${detail}`);
	console.warn(
		`             run manually: ln -s ${packageRoot} ${linkedPackage}`,
	);
}

async function createExclusiveBackup(
	sourceFile: string,
	backupFile: string,
): Promise<boolean> {
	try {
		await copyFile(sourceFile, backupFile, constants.COPYFILE_EXCL);
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === "EEXIST") {
			return false;
		}

		throw new Error(
			`failed to back up ${sourceFile} to ${backupFile}: ${errorMessage(error)}`,
			{ cause: error },
		);
	}
}
