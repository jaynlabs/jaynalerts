import { afterEach, expect, test } from "bun:test";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_EXTENSION_MARKER } from "../src/cli/integrations.ts";

// init compiles five notifier bundles, so a full install/uninstall round trip
// does not fit in bun's default timeout.
const CLI_TIMEOUT_MS = 120_000;

const temporaryHomes: string[] = [];

afterEach(async () => {
	for (const home of temporaryHomes.splice(0)) {
		await rm(home, { force: true, recursive: true });
	}
});

test(
	"uninstall reverts every edit init made",
	async () => {
		const home = await newHome();
		await mkdir(join(home, ".claude"), { recursive: true });
		await writeFile(
			join(home, ".claude", "settings.json"),
			`${JSON.stringify({ model: "opus" }, null, 2)}\n`,
		);
		await writeFile(join(home, ".zshrc"), "# user content\nexport FOO=1\n");
		await mkdir(join(home, ".codex"), { recursive: true });
		await writeFile(
			join(home, ".codex", "config.toml"),
			'model = "gpt-test"\n\n[tui]\ntheme = "dark"\n',
		);

		await runCli(home, [
			"init",
			"--claude-code",
			"--codex",
			"--opencode",
			"--pi",
			"--shell",
		]);
		await runCli(home, ["uninstall"]);

		const settings = JSON.parse(
			await readFile(join(home, ".claude", "settings.json"), "utf8"),
		);
		expect(settings.model).toBe("opus");
		expect(settings.hooks).toBeUndefined();

		const codexConfig = await readFile(
			join(home, ".codex", "config.toml"),
			"utf8",
		);
		expect(codexConfig).toContain('model = "gpt-test"');
		expect(codexConfig).toContain('theme = "dark"');
		expect(codexConfig).not.toContain("jaynalerts");
		expect(codexConfig).not.toContain("notifications = false");

		const hooks = JSON.parse(
			await readFile(join(home, ".codex", "hooks.json"), "utf8"),
		);
		expect(hooks.hooks).toBeUndefined();

		const zshrc = await readFile(join(home, ".zshrc"), "utf8");
		expect(zshrc).toBe("# user content\nexport FOO=1\n");

		await expect(
			stat(join(home, "Applications", "JaynAlertsNotifierCodex.app")),
		).rejects.toThrow();
		await expect(
			stat(join(home, ".config", "opencode", "plugins", "jaynalerts.ts")),
		).rejects.toThrow();
		await expect(
			stat(join(home, ".pi", "agent", "extensions", "jaynalerts.ts")),
		).rejects.toThrow();
	},
	CLI_TIMEOUT_MS,
);

test(
	"uninstall --dry-run reports without touching anything",
	async () => {
		const home = await newHome();
		await runCli(home, ["init", "--claude-code"]);

		const before = await readFile(
			join(home, ".claude", "settings.json"),
			"utf8",
		);
		const stdout = await runCli(home, ["uninstall", "--dry-run"]);

		expect(stdout).toContain("Dry run");
		expect(stdout).toContain("Claude Code: removed 2 hooks");
		expect(stdout).toContain("Re-run without --dry-run");
		expect(await readFile(join(home, ".claude", "settings.json"), "utf8")).toBe(
			before,
		);
		expect(
			(
				await stat(join(home, "Applications", "JaynAlertsNotifier.app"))
			).isDirectory(),
		).toBe(true);
	},
	CLI_TIMEOUT_MS,
);

test(
	"uninstall leaves hooks it does not own alone",
	async () => {
		const home = await newHome();
		await runCli(home, ["init", "--claude-code"]);

		const settingsFile = join(home, ".claude", "settings.json");
		const settings = JSON.parse(await readFile(settingsFile, "utf8"));
		settings.hooks.Stop.push({
			hooks: [{ type: "command", command: "say done" }],
		});
		await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);

		await runCli(home, ["uninstall", "--claude-code"]);

		const after = JSON.parse(await readFile(settingsFile, "utf8"));
		expect(after.hooks.Stop).toEqual([
			{ hooks: [{ type: "command", command: "say done" }] },
		]);
		expect(after.hooks.Notification).toBeUndefined();
	},
	CLI_TIMEOUT_MS,
);

test(
	"uninstall keeps the config file unless asked",
	async () => {
		const home = await newHome();
		const configFile = join(home, ".config", "jaynalerts", "config.toml");
		await mkdir(join(home, ".config", "jaynalerts"), { recursive: true });
		await writeFile(configFile, '[notifications]\nstickySound = "Ping"\n');

		await runCli(home, ["init", "--claude-code"]);
		await runCli(home, ["uninstall"]);
		expect((await stat(configFile)).isFile()).toBe(true);

		await runCli(home, ["uninstall", "--config"]);
		await expect(stat(configFile)).rejects.toThrow();
	},
	CLI_TIMEOUT_MS,
);

test(
	"uninstall says so when there is nothing installed",
	async () => {
		const home = await newHome();

		const stdout = await runCli(home, ["uninstall"]);

		expect(stdout).toContain("Nothing to remove");
	},
	CLI_TIMEOUT_MS,
);

test(
	"uninstall only removes a managed Pi extension",
	async () => {
		const home = await newHome();
		const extension = join(home, ".pi", "agent", "extensions", "jaynalerts.ts");
		await mkdir(join(extension, ".."), { recursive: true });
		await writeFile(extension, `// ${PI_EXTENSION_MARKER}\n`);

		const preview = await runCli(home, ["uninstall", "--pi", "--dry-run"]);
		expect(preview).toContain("removed extension");
		expect((await stat(extension)).isFile()).toBe(true);

		await runCli(home, ["uninstall", "--pi"]);
		await expect(stat(extension)).rejects.toThrow();

		await writeFile(extension, "// user-owned Pi extension\n");
		const stdout = await runCli(home, ["uninstall", "--pi"]);
		expect(stdout).toContain("left");
		expect(await readFile(extension, "utf8")).toBe(
			"// user-owned Pi extension\n",
		);
	},
	CLI_TIMEOUT_MS,
);

test(
	"uninstall removes the opencode link it made and leaves a real one alone",
	async () => {
		const home = await newHome();
		const linkedPackage = join(
			home,
			".config",
			"opencode",
			"node_modules",
			"jaynalerts",
		);

		await runCli(home, ["init", "--opencode"]);
		expect((await lstat(linkedPackage)).isSymbolicLink()).toBe(true);

		const preview = await runCli(home, [
			"uninstall",
			"--opencode",
			"--dry-run",
		]);
		expect(preview).toContain("removed link");
		expect((await lstat(linkedPackage)).isSymbolicLink()).toBe(true);

		const stdout = await runCli(home, ["uninstall", "--opencode"]);
		expect(stdout).toContain("removed link");
		await expect(lstat(linkedPackage)).rejects.toThrow();

		// A real directory is jaynalerts installed there as a dependency — not
		// the link we made, and not ours to delete.
		await mkdir(linkedPackage, { recursive: true });
		await runCli(home, ["init", "--opencode"]);

		const second = await runCli(home, ["uninstall", "--opencode"]);
		expect(second).toContain("real package directory; left alone");
		expect((await stat(linkedPackage)).isDirectory()).toBe(true);
	},
	CLI_TIMEOUT_MS,
);

async function newHome(): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "jaynalerts-uninstall-"));
	temporaryHomes.push(home);
	return home;
}

async function runCli(home: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(
		[process.execPath, "run", "src/cli/index.ts", ...args],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				HOME: home,
				CODEX_HOME: join(home, ".codex"),
				PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
			},
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
			`${args.join(" ")} failed with exit ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
		);
	}

	return stdout;
}
