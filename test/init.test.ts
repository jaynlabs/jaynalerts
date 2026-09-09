import { afterEach, expect, test } from "bun:test";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryHomes: string[] = [];

// Every test here spawns a real `init`, which compiles the Swift notifier
// bundle with swiftc. That does not fit in bun's 5s default timeout.
const INIT_TIMEOUT_MS = 60_000;

afterEach(async () => {
	for (const home of temporaryHomes.splice(0)) {
		await rm(home, { force: true, recursive: true });
	}
});

test(
	"Pi init writes the global extension and is idempotent",
	async () => {
		const home = await mkdtemp(join(tmpdir(), "jaynalerts-init-"));
		temporaryHomes.push(home);
		const piDir = join(home, ".pi", "agent");
		const target = join(piDir, "extensions", "jaynalerts.ts");

		await runPiInitInHome(home, piDir);

		const source = await readFile("examples/pi-extension.ts", "utf8");
		expect(await readFile(target, "utf8")).toBe(source);
		const piNotifierPlist = await readFile(
			join(
				home,
				"Applications",
				"JaynAlertsNotifierPi.app",
				"Contents",
				"Info.plist",
			),
			"utf8",
		);
		expect(piNotifierPlist).toContain("<string>Pi</string>");
		const firstStat = await stat(target);

		await runPiInitInHome(home, piDir);

		expect(await readFile(target, "utf8")).toBe(source);
		expect((await stat(target)).mtimeMs).toBe(firstStat.mtimeMs);
	},
	INIT_TIMEOUT_MS,
);

test(
	"opencode init writes the plugin, links the package, and is idempotent",
	async () => {
		const home = await mkdtemp(join(tmpdir(), "jaynalerts-init-"));
		temporaryHomes.push(home);

		await runInitInHome(home);

		const target = join(
			home,
			".config",
			"opencode",
			"plugins",
			"jaynalerts.ts",
		);
		const source = await readFile("examples/opencode-plugin.ts", "utf8");

		expect(await readFile(target, "utf8")).toBe(source);
		const notifierPlist = await readFile(
			join(
				home,
				"Applications",
				"JaynAlertsNotifier.app",
				"Contents",
				"Info.plist",
			),
			"utf8",
		);
		expect(notifierPlist).toContain("NSUserNotificationAlertStyle");
		expect(notifierPlist).toContain("<string>alert</string>");
		const firstStat = await stat(target);

		// The plugin does `import "jaynalerts"`, so opencode's config dir needs a
		// node_modules entry pointing back at this install. `bun link` could never
		// produce one for an npm-installed copy; the symlink works for both.
		const linkedPackage = join(
			home,
			".config",
			"opencode",
			"node_modules",
			"jaynalerts",
		);
		expect((await lstat(linkedPackage)).isSymbolicLink()).toBe(true);
		expect(await realpath(linkedPackage)).toBe(await realpath(process.cwd()));

		await runInitInHome(home);

		expect(await readFile(target, "utf8")).toBe(source);
		expect((await stat(target)).mtimeMs).toBe(firstStat.mtimeMs);
		expect((await lstat(linkedPackage)).isSymbolicLink()).toBe(true);
		expect(await realpath(linkedPackage)).toBe(await realpath(process.cwd()));
	},
	INIT_TIMEOUT_MS,
);

test(
	"shell init writes zshrc block and is idempotent",
	async () => {
		const home = await mkdtemp(join(tmpdir(), "jaynalerts-init-"));
		temporaryHomes.push(home);
		const zshrc = join(home, ".zshrc");

		await Bun.write(zshrc, "# user content\nexport FOO=1\n");

		await runShellInitInHome(home);
		const first = await readFile(zshrc, "utf8");
		expect(first).toContain("# user content");
		expect(first).toContain("jaynalerts begin");
		expect(first).toContain("jaynalerts notify-command");

		await runShellInitInHome(home);
		const second = await readFile(zshrc, "utf8");
		expect(second).toBe(first);
	},
	INIT_TIMEOUT_MS,
);

test(
	"shell init --shell-rc writes to custom path",
	async () => {
		const home = await mkdtemp(join(tmpdir(), "jaynalerts-init-"));
		temporaryHomes.push(home);
		const customRc = join(home, "custom.zsh");

		await writeFile(customRc, "# custom rc\n");

		await runShellInitInHome(home, ["--shell-rc", customRc]);

		const contents = await readFile(customRc, "utf8");
		expect(contents).toContain("# custom rc");
		expect(contents).toContain("jaynalerts begin");

		const defaultRc = join(home, ".zshrc");
		await expect(stat(defaultRc)).rejects.toThrow();
	},
	INIT_TIMEOUT_MS,
);

test(
	"shell init preserves symlink target",
	async () => {
		const home = await mkdtemp(join(tmpdir(), "jaynalerts-init-"));
		temporaryHomes.push(home);
		const realFile = join(home, "real.zshrc");
		const linkFile = join(home, ".zshrc");

		await writeFile(realFile, "# real rc\n");
		await symlink(realFile, linkFile);

		await runShellInitInHome(home, ["--shell-rc", linkFile]);

		expect((await lstat(linkFile)).isSymbolicLink()).toBe(true);
		expect(await readlink(linkFile)).toBe(realFile);

		const realContents = await readFile(realFile, "utf8");
		expect(realContents).toContain("# real rc");
		expect(realContents).toContain("jaynalerts begin");
	},
	INIT_TIMEOUT_MS,
);

// bash cannot parse `&!` at all, so writing the managed block into a .bashrc
// would not no-op — it would take the whole rc file down.
test(
	"shell init refuses a non-zsh rc instead of breaking it",
	async () => {
		const home = await mkdtemp(join(tmpdir(), "jaynalerts-init-"));
		temporaryHomes.push(home);
		const bashrc = join(home, ".bashrc");
		const original = "# user content\nexport FOO=1\n";

		await writeFile(bashrc, original);

		const { exitCode, stderr } = await runInitExpectingFailure(home, [
			"--shell",
			"--shell-rc",
			bashrc,
		]);

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("refusing to write the shell hook");
		expect(await readFile(bashrc, "utf8")).toBe(original);
	},
	INIT_TIMEOUT_MS,
);

test(
	"claude code init upgrades existing notification hook matcher",
	async () => {
		const home = await mkdtemp(join(tmpdir(), "jaynalerts-init-"));
		temporaryHomes.push(home);
		const settingsFile = join(home, ".claude", "settings.json");
		await mkdir(join(home, ".claude"));

		await writeFile(
			settingsFile,
			JSON.stringify(
				{
					hooks: {
						Notification: [
							{
								hooks: [
									{
										command: "jaynalerts claude-code-hook on-notification",
										type: "command",
									},
								],
							},
						],
					},
				},
				null,
				2,
			),
		);

		await runClaudeCodeInitInHome(home);

		const settings = JSON.parse(await readFile(settingsFile, "utf8"));
		const notificationGroup = settings.hooks.Notification[0];
		expect(notificationGroup.matcher).toBe("permission_prompt");
		expect(notificationGroup.hooks).toEqual([
			{
				command: "jaynalerts claude-code-hook on-notification",
				type: "command",
			},
		]);
	},
	INIT_TIMEOUT_MS,
);

test(
	"codex init installs notify without disturbing config and is idempotent",
	async () => {
		const home = await mkdtemp(join(tmpdir(), "jaynalerts-init-"));
		temporaryHomes.push(home);
		const codexDir = join(home, ".codex");
		const configFile = join(codexDir, "config.toml");
		await mkdir(codexDir);
		await writeFile(
			configFile,
			'model = "gpt-test"\n\n[tui]\nnotifications = true\n',
		);

		await runCodexInitInHome(home);
		const first = await readFile(configFile, "utf8");
		expect(first).toContain('notify = ["jaynalerts", "codex-hook"]');
		expect(first).toContain('model = "gpt-test"');
		expect(first).toContain("[tui]");
		// Codex's own OSC 9 alert would otherwise duplicate ours.
		expect(first).toContain("notifications = false");
		expect(first).not.toContain("notifications = true");

		await runCodexInitInHome(home);
		expect(await readFile(configFile, "utf8")).toBe(first);
	},
	INIT_TIMEOUT_MS,
);

test(
	"codex init adds a [tui] table when the config has none",
	async () => {
		const home = await mkdtemp(join(tmpdir(), "jaynalerts-init-"));
		temporaryHomes.push(home);
		const configFile = join(home, ".codex", "config.toml");
		await mkdir(join(home, ".codex"));
		await writeFile(configFile, 'model = "gpt-test"\n');

		await runCodexInitInHome(home);
		const first = await readFile(configFile, "utf8");
		expect(first).toContain("[tui]\nnotifications = false");

		await runCodexInitInHome(home);
		expect(await readFile(configFile, "utf8")).toBe(first);
	},
	INIT_TIMEOUT_MS,
);

test(
	"codex init disables tui notifications without disturbing sibling tables",
	async () => {
		const home = await mkdtemp(join(tmpdir(), "jaynalerts-init-"));
		temporaryHomes.push(home);
		const configFile = join(home, ".codex", "config.toml");
		await mkdir(join(home, ".codex"));
		await writeFile(
			configFile,
			'[tui]\ntheme = "dark"\nnotifications = true\n\n[history]\npersistence = "none"\n',
		);

		await runCodexInitInHome(home);
		const first = await readFile(configFile, "utf8");
		expect(first).toContain('theme = "dark"');
		expect(first).toContain("notifications = false");
		expect(first).toContain('[history]\npersistence = "none"');
		// The setting must stay inside [tui], not leak into [history].
		expect(first.indexOf("notifications = false")).toBeLessThan(
			first.indexOf("[history]"),
		);

		await runCodexInitInHome(home);
		expect(await readFile(configFile, "utf8")).toBe(first);
	},
	INIT_TIMEOUT_MS,
);

test(
	"codex init installs the approval hook and is idempotent",
	async () => {
		const home = await mkdtemp(join(tmpdir(), "jaynalerts-init-"));
		temporaryHomes.push(home);
		const codexDir = join(home, ".codex");
		const hooksFile = join(codexDir, "hooks.json");
		await mkdir(codexDir);
		await writeFile(
			hooksFile,
			`${JSON.stringify(
				{
					hooks: {
						SessionStart: [{ hooks: [{ type: "command", command: "mine" }] }],
					},
				},
				null,
				2,
			)}\n`,
		);

		await runCodexInitInHome(home);
		const first = JSON.parse(await readFile(hooksFile, "utf8"));
		expect(first.hooks.SessionStart).toEqual([
			{ hooks: [{ type: "command", command: "mine" }] },
		]);
		expect(first.hooks.PermissionRequest).toEqual([
			{
				matcher: "*",
				hooks: [
					{
						type: "command",
						command: "jaynalerts codex-hook on-permission-request",
						async: true,
					},
				],
			},
		]);

		await runCodexInitInHome(home);
		expect(JSON.parse(await readFile(hooksFile, "utf8"))).toEqual(first);
	},
	INIT_TIMEOUT_MS,
);

test(
	"codex init creates hooks.json when none exists",
	async () => {
		const home = await mkdtemp(join(tmpdir(), "jaynalerts-init-"));
		temporaryHomes.push(home);
		await mkdir(join(home, ".codex"));

		await runCodexInitInHome(home);
		const document = JSON.parse(
			await readFile(join(home, ".codex", "hooks.json"), "utf8"),
		);
		expect(document.hooks.PermissionRequest[0].hooks[0].command).toBe(
			"jaynalerts codex-hook on-permission-request",
		);
	},
	INIT_TIMEOUT_MS,
);

async function runShellInitInHome(
	home: string,
	extraArgs: string[] = ["--shell"],
): Promise<void> {
	const proc = Bun.spawn(
		[process.execPath, "run", "src/cli/index.ts", "init", ...extraArgs],
		{
			cwd: process.cwd(),
			env: { ...process.env, HOME: home },
			stderr: "pipe",
			stdout: "pipe",
		},
	);

	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);

	if (exitCode !== 0) {
		throw new Error(
			`shell init failed with exit ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
		);
	}
}

async function runInitInHome(home: string): Promise<void> {
	const proc = Bun.spawn(
		[process.execPath, "run", "src/cli/index.ts", "init", "--opencode"],
		{
			cwd: process.cwd(),
			env: { ...process.env, HOME: home },
			stderr: "pipe",
			stdout: "pipe",
		},
	);

	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);

	if (exitCode !== 0) {
		throw new Error(
			`init failed with exit ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
		);
	}
}

async function runClaudeCodeInitInHome(home: string): Promise<void> {
	const proc = Bun.spawn(
		[process.execPath, "run", "src/cli/index.ts", "init", "--claude-code"],
		{
			cwd: process.cwd(),
			env: { ...process.env, HOME: home },
			stderr: "pipe",
			stdout: "pipe",
		},
	);

	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);

	if (exitCode !== 0) {
		throw new Error(
			`claude code init failed with exit ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
		);
	}
}

async function runCodexInitInHome(home: string): Promise<void> {
	const proc = Bun.spawn(
		[process.execPath, "run", "src/cli/index.ts", "init", "--codex"],
		{
			cwd: process.cwd(),
			env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex") },
			stderr: "pipe",
			stdout: "pipe",
		},
	);
	const [exitCode, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`codex init failed: ${stderr}`);
}

async function runInitExpectingFailure(
	home: string,
	args: string[],
): Promise<{ exitCode: number; stderr: string }> {
	const proc = Bun.spawn(
		[process.execPath, "run", "src/cli/index.ts", "init", ...args],
		{
			cwd: process.cwd(),
			env: { ...process.env, HOME: home },
			stderr: "pipe",
			stdout: "pipe",
		},
	);
	const [exitCode, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stderr).text(),
	]);

	return { exitCode, stderr };
}

async function runPiInitInHome(home: string, piDir: string): Promise<void> {
	const proc = Bun.spawn(
		[process.execPath, "run", "src/cli/index.ts", "init", "--pi"],
		{
			cwd: process.cwd(),
			env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: piDir },
			stderr: "pipe",
			stdout: "pipe",
		},
	);
	const [exitCode, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`Pi init failed: ${stderr}`);
}
