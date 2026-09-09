import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { notifierBinForSource, resolvePaths } from "../core/paths.ts";

type InitOptions = {
	claudeCode: boolean;
	codex: boolean;
	opencode: boolean;
	pi: boolean;
	shell: boolean;
	shellRc: string | null;
};

const SHELL_BLOCK_BEGIN = "# jaynalerts begin (managed — do not edit)";
const SHELL_BLOCK_END = "# jaynalerts end";

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

type JsonObject = Record<string, unknown>;

type HookEvent = "Stop" | "Notification";

type HookSpec = {
	event: HookEvent;
	matcher?: string;
	command: string;
};

type CodexHookSpec = {
	event: string;
	matcher?: string;
	command: string;
	async?: boolean;
};

const hookSpecs: HookSpec[] = [
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

export async function runInit(argv: string[]): Promise<void> {
	const options = parseArgs(argv);

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

	if (options.shell) {
		await installShellHook(options.shellRc ?? defaultShellRc());
	}

	if (options.claudeCode || options.codex || options.opencode || options.pi) {
		await buildFrontmostHelper();
		await buildNotifierBundle();
	}
}

async function buildNotifierBundle(): Promise<void> {
	if (process.platform !== "darwin") {
		return;
	}

	const paths = resolvePaths();
	const { notifierBin } = paths;
	const swiftSource = join(
		import.meta.dir,
		"..",
		"..",
		"src",
		"native",
		"notifier.swift",
	);
	const plistSource = join(
		import.meta.dir,
		"..",
		"..",
		"src",
		"native",
		"notifier.plist",
	);

	try {
		await stat(swiftSource);
		await stat(plistSource);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			console.warn(
				`notifier:    missing source files; skipped (${swiftSource})`,
			);
			return;
		}
		throw error;
	}

	const macOSDir = dirname(notifierBin);
	await mkdir(macOSDir, { recursive: true });

	let swiftcExit: number;
	let swiftcStderr: string;
	try {
		const proc = Bun.spawn(["swiftc", "-O", "-o", notifierBin, swiftSource], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		swiftcStderr = await new Response(proc.stderr).text();
		swiftcExit = await proc.exited;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			console.warn(
				"notifier:    swiftc not found; install Xcode Command Line Tools to enable the notifier",
			);
			return;
		}
		throw error;
	}

	if (swiftcExit !== 0) {
		console.warn(
			`notifier:    failed to compile (exit ${swiftcExit}); banners will not work`,
		);
		if (swiftcStderr.trim().length > 0) {
			console.warn(`             ${swiftcStderr.trim()}`);
		}
		return;
	}

	const assetsRoot = join(import.meta.dir, "..", "..", "assets");
	const plistTemplate = await readFile(plistSource, "utf8");
	const variants = [
		{ source: undefined, label: "JaynAlerts", icon: "notifier" },
		{ source: "claude-code", label: "Claude Code", icon: "claude-code" },
		{ source: "codex", label: "Codex", icon: "codex" },
		{ source: "pi", label: "Pi", icon: "pi" },
		{ source: "ghostty", label: "Ghostty", icon: "ghostty" },
	] as const;

	for (const variant of variants) {
		const bin = notifierBinForSource(paths, variant.source);
		const app = resolve(bin, "..", "..", "..");
		await mkdir(dirname(bin), { recursive: true });
		if (bin !== notifierBin) await copyFile(notifierBin, bin);
		const suffix = variant.source?.replaceAll("-", ".") ?? "notifier";
		const plist = plistTemplate
			.replace("dev.jaynalerts.notifier", `dev.jaynalerts.${suffix}`)
			.replaceAll(
				"<string>JaynAlerts</string>",
				`<string>${variant.label}</string>`,
			);
		await writeFile(join(app, "Contents", "Info.plist"), plist);
		const resourcesDir = join(app, "Contents", "Resources");
		await mkdir(resourcesDir, { recursive: true });
		const targetIcns = join(resourcesDir, "AppIcon.icns");
		const icnsSource = join(assetsRoot, `${variant.icon}.icns`);
		const pngSource = join(assetsRoot, `${variant.icon}.png`);
		if (await fileExists(icnsSource)) {
			await copyFile(icnsSource, targetIcns);
		} else if (
			(await fileExists(pngSource)) &&
			!(await convertPngToIcns(pngSource, targetIcns))
		) {
			console.warn(`notifier:    could not convert ${pngSource} to .icns`);
		}
		await signNotifierBundle(app);
		console.log(`notifier:    ${variant.label} bundle built at ${app}`);
	}
}

async function signNotifierBundle(app: string): Promise<void> {
	const proc = Bun.spawn(["codesign", "--sign", "-", "--force", app], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const [exitCode, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`codesign failed for ${app}: ${stderr.trim()}`);
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

async function convertPngToIcns(
	pngPath: string,
	icnsPath: string,
): Promise<boolean> {
	const tempRoot = await mkdtemp(join(tmpdir(), "jaynalerts-icon-"));
	const iconset = join(tempRoot, "AppIcon.iconset");
	try {
		await mkdir(iconset, { recursive: true });
		for (const size of [16, 32, 128, 256, 512]) {
			for (const scale of [1, 2]) {
				const pixels = size * scale;
				const suffix = scale === 2 ? "@2x" : "";
				const output = join(iconset, `icon_${size}x${size}${suffix}.png`);
				const proc = Bun.spawn(
					[
						"sips",
						"-z",
						String(pixels),
						String(pixels),
						pngPath,
						"--out",
						output,
					],
					{ stdio: ["ignore", "ignore", "ignore"] },
				);
				if ((await proc.exited) !== 0) return false;
			}
		}
		const proc = Bun.spawn(
			["iconutil", "--convert", "icns", "--output", icnsPath, iconset],
			{ stdio: ["ignore", "ignore", "ignore"] },
		);
		return (await proc.exited) === 0;
	} catch {
		return false;
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
}

async function buildFrontmostHelper(): Promise<void> {
	if (process.platform !== "darwin") {
		return;
	}

	const target = resolvePaths().bundleIdBin;
	const source = join(
		import.meta.dir,
		"..",
		"..",
		"src",
		"native",
		"bundle-id.swift",
	);

	try {
		await stat(source);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			console.warn(`focus:       missing Swift source at ${source}; skipped`);
			return;
		}
		throw error;
	}

	await mkdir(dirname(target), { recursive: true });

	let exitCode: number;
	let stderr: string;
	try {
		const proc = Bun.spawn(["swiftc", "-O", "-o", target, source], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stderrPromise = new Response(proc.stderr).text();
		exitCode = await proc.exited;
		stderr = await stderrPromise;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			console.warn(
				"focus:       swiftc not found; falling back to osascript (install Xcode Command Line Tools to enable the fast helper)",
			);
			return;
		}
		throw error;
	}

	if (exitCode !== 0) {
		console.warn(
			`focus:       failed to compile frontmost helper (exit ${exitCode}); falling back to osascript`,
		);
		if (stderr.trim().length > 0) {
			console.warn(`             ${stderr.trim()}`);
		}
		return;
	}

	console.log(`focus:       compiled helper at ${target}`);
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
	const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
	const configFile = await resolveSymlink(join(codexHome, "config.toml"));
	const existing = (await readOptionalFile(configFile)) ?? "";
	const command = 'notify = ["jaynalerts", "codex-hook"]';
	const firstTable = existing.search(/^\s*\[/m);
	const topLevelEnd = firstTable === -1 ? existing.length : firstTable;
	const topLevel = existing.slice(0, topLevelEnd);
	const topLevelNotify = /^notify\s*=.*$/m;
	let next: string;

	if (topLevelNotify.test(topLevel)) {
		next = `${topLevel.replace(topLevelNotify, command)}${existing.slice(topLevelEnd)}`;
	} else {
		const insertion = `${command}\n`;
		next =
			firstTable === -1
				? `${existing}${existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""}${insertion}`
				: `${existing.slice(0, firstTable)}${insertion}\n${existing.slice(firstTable)}`;
	}

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

// Codex's legacy `notify` command only ever fires `agent-turn-complete`.
// Approval prompts arrive through the hooks system instead, which reads
// $CODEX_HOME/hooks.json using the same shape as Claude Code's settings.
const codexHookSpecs: CodexHookSpec[] = [
	{
		event: "PermissionRequest",
		matcher: "*",
		command: "jaynalerts codex-hook on-permission-request",
		async: true,
	},
];

async function installCodexHooks(): Promise<void> {
	const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
	const hooksFile = await resolveSymlink(join(codexHome, "hooks.json"));
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

function defaultShellRc(): string {
	return join(homedir(), ".zshrc");
}

async function installShellHook(rcPath: string): Promise<void> {
	const expandedRc = expandUser(rcPath);
	const resolvedRc = await resolveSymlink(expandedRc);
	const existing = await readOptionalFile(resolvedRc);
	const desiredBlock = buildShellBlock();
	const next = mergeShellBlock(existing ?? "", desiredBlock);
	const displayPath =
		resolvedRc === expandedRc ? resolvedRc : `${expandedRc} → ${resolvedRc}`;

	if (existing === next) {
		console.log(`shell:       hook already up to date (${displayPath})`);
		return;
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
	console.log(`             open a new shell or run: source ${expandedRc}`);
}

function expandUser(path: string): string {
	if (path === "~") {
		return homedir();
	}

	if (path.startsWith("~/")) {
		return join(homedir(), path.slice(2));
	}

	return path;
}

function mergeShellBlock(existing: string, block: string): string {
	const beginIdx = existing.indexOf(SHELL_BLOCK_BEGIN);

	if (beginIdx === -1) {
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

	return `${before}${block}${after}`;
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

function resolveClaudeCodeSettingsFile(): string {
	return join(homedir(), ".claude", "settings.json");
}

async function readSettings(settingsFile: string): Promise<JsonObject> {
	let contents: string;

	try {
		contents = await readFile(settingsFile, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return {};
		}

		throw error;
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

async function createBackupIfNeeded(
	settingsFile: string,
	backupFile: string,
): Promise<boolean> {
	try {
		await copyFile(settingsFile, backupFile, 1);
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

	for (const spec of hookSpecs) {
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

function findCommandHookGroup(
	eventHooks: unknown[],
	command: string,
): JsonObject | undefined {
	return eventHooks.find((group): group is JsonObject => {
		if (!isJsonObject(group) || !Array.isArray(group.hooks)) {
			return false;
		}

		return group.hooks.some(
			(handler) =>
				isJsonObject(handler) &&
				handler.type === "command" &&
				handler.command === command,
		);
	});
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

async function writeJsonAtomically(
	settingsFile: string,
	settings: JsonObject,
): Promise<void> {
	await mkdir(dirname(settingsFile), { recursive: true });

	const temporaryFile = `${settingsFile}.tmp.${process.pid}.${randomUUID()}`;

	try {
		await writeFile(temporaryFile, `${JSON.stringify(settings, null, 2)}\n`);
		await rename(temporaryFile, settingsFile);
	} catch (error) {
		await Bun.file(temporaryFile)
			.delete()
			.catch(() => {});
		throw error;
	}
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

function resolvePiExtensionFile(): string {
	const piAgentDir =
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(piAgentDir, "extensions", "jaynalerts.ts");
}

async function readPiExtensionSource(): Promise<string> {
	const extensionPath = join(
		import.meta.dir,
		"..",
		"..",
		"examples",
		"pi-extension.ts",
	);

	return Bun.file(extensionPath).text();
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

function resolveOpencodePluginFile(): string {
	return join(homedir(), ".config", "opencode", "plugins", "jaynalerts.ts");
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

async function linkOpencodePackage(): Promise<void> {
	const realPluginFile = await resolveSymlink(resolveOpencodePluginFile());
	const opencodeConfigDir = dirname(dirname(realPluginFile));
	const opencodePackageDir = join(opencodeConfigDir, "node_modules");
	const linkedPackage = join(opencodePackageDir, "jaynalerts");

	try {
		const stats = await lstat(linkedPackage);

		if (stats.isSymbolicLink()) {
			try {
				await stat(linkedPackage);
				return;
			} catch (error) {
				if (!isNodeError(error) || error.code !== "ENOENT") {
					throw error;
				}
			}
		}
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") {
			throw error;
		}
	}

	try {
		const stats = await lstat(opencodeConfigDir);

		if (!stats.isDirectory()) {
			console.warn(
				`opencode:    could not auto-link jaynalerts into ${opencodeConfigDir}/`,
			);
			console.warn(
				`             run manually: cd ${opencodeConfigDir} && bun link jaynalerts`,
			);
			return;
		}
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			console.warn(
				`opencode:    could not auto-link jaynalerts into ${opencodeConfigDir}/`,
			);
			console.warn(
				`             run manually: cd ${opencodeConfigDir} && bun link jaynalerts`,
			);
			return;
		}

		throw error;
	}

	const proc = Bun.spawn(["bun", "link", "jaynalerts"], {
		cwd: opencodeConfigDir,
		stdio: ["ignore", "pipe", "pipe"],
	});

	const stdoutPromise = new Response(proc.stdout).text();
	const stderrPromise = new Response(proc.stderr).text();
	let exitCode: number;
	let stderr: string;

	try {
		[exitCode, , stderr] = await Promise.all([
			proc.exited,
			stdoutPromise,
			stderrPromise,
		]);
	} catch (error) {
		stderr = await stderrPromise.catch(() => "");
		console.warn(
			`opencode:    could not auto-link jaynalerts into ${opencodeConfigDir}/`,
		);
		if (isNodeError(error) && error.code === "ENOENT") {
			console.warn(
				`             run manually: cd ${opencodeConfigDir} && bun link jaynalerts`,
			);
			return;
		}

		if (stderr.trim().length > 0) {
			console.warn(`             ${stderr.trim()}`);
		} else {
			console.warn(`             ${errorMessage(error)}`);
		}
		console.warn(
			`             run manually: cd ${opencodeConfigDir} && bun link jaynalerts`,
		);
		return;
	}

	if (exitCode !== 0) {
		console.warn(
			`opencode:    could not auto-link jaynalerts into ${opencodeConfigDir}/`,
		);
		if (exitCode === 127 || /not found/i.test(stderr)) {
			console.warn(
				`             run manually: cd ${opencodeConfigDir} && bun link jaynalerts`,
			);
			return;
		}

		if (stderr.trim().length > 0) {
			console.warn(`             ${stderr.trim()}`);
		}
		console.warn(
			`             run manually: cd ${opencodeConfigDir} && bun link jaynalerts`,
		);
		return;
	}

	console.log(`opencode:    linked jaynalerts into ${opencodePackageDir}/`);
}

async function readOptionalFile(file: string): Promise<string | null> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return null;
		}

		throw error;
	}
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

async function writeTextAtomically(
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

async function resolveSymlink(file: string): Promise<string> {
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

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
