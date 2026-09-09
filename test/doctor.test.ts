import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runDoctor } from "../src/cli/doctor.ts";
import { notifierBinForSource, resolvePaths } from "../src/core/paths.ts";

const originalHome = process.env.JAYNALERTS_HOME;
const originalLog = console.log;
const temporaryHomes: string[] = [];

const VARIANTS = [undefined, "claude-code", "codex", "pi", "ghostty"] as const;

type Settings = {
	authorization: string;
	alertStyle: string;
	alerts: string;
	requestedAlertStyle: string;
};

const PERSISTENT: Settings = {
	authorization: "authorized",
	alertStyle: "persistent",
	alerts: "enabled",
	requestedAlertStyle: "alert",
};

let lines: string[];

beforeEach(async () => {
	const home = await mkdtemp(join(tmpdir(), "jaynalerts-doctor-"));
	temporaryHomes.push(home);
	process.env.JAYNALERTS_HOME = home;
	lines = [];
	console.log = (message?: unknown) => {
		lines.push(String(message));
	};
});

afterEach(async () => {
	console.log = originalLog;
	if (originalHome === undefined) {
		delete process.env.JAYNALERTS_HOME;
	} else {
		process.env.JAYNALERTS_HOME = originalHome;
	}
	for (const home of temporaryHomes.splice(0)) {
		await rm(home, { force: true, recursive: true });
	}
});

test("doctor reports every bundle as persistent when macOS agrees", async () => {
	for (const source of VARIANTS) {
		await writeFakeNotifier(source, PERSISTENT);
	}

	await runDoctor();

	const output = lines.join("\n");
	expect(output).toContain("JaynAlerts: authorized, persistent alerts");
	expect(output).toContain("Claude Code: authorized, persistent alerts");
	expect(output).toContain("Codex: authorized, persistent alerts");
	expect(output).toContain("Pi: authorized, persistent alerts");
	expect(output).toContain("Ghostty: authorized, persistent alerts");
	expect(output).toContain(
		"All notifier bundles are authorized and persistent",
	);
});

test("doctor flags a bundle macOS still treats as temporary", async () => {
	for (const source of VARIANTS) {
		await writeFakeNotifier(source, PERSISTENT);
	}
	await writeFakeNotifier("codex", { ...PERSISTENT, alertStyle: "temporary" });

	await runDoctor();

	const output = lines.join("\n");
	expect(output).toContain("Codex: authorized, temporary alerts");
	expect(output).toContain("choose Persistent in System Settings");
});

test("doctor flags a bundle whose notifications are denied", async () => {
	for (const source of VARIANTS) {
		await writeFakeNotifier(source, PERSISTENT);
	}
	await writeFakeNotifier("ghostty", {
		...PERSISTENT,
		authorization: "denied",
		alerts: "disabled",
	});

	await runDoctor();

	expect(lines.join("\n")).toContain("Ghostty: denied, persistent alerts");
	expect(lines.join("\n")).toContain("enable notifications");
});

test("doctor points at init when a bundle was never built", async () => {
	await writeFakeNotifier(undefined, PERSISTENT);

	await runDoctor();

	const output = lines.join("\n");
	expect(output).toContain("Codex: bundle missing — run `jaynalerts init`");
	expect(output).not.toContain("All notifier bundles");
});

test("doctor survives a notifier that cannot report its settings", async () => {
	for (const source of VARIANTS) {
		await writeFakeNotifier(source, PERSISTENT);
	}
	await writeFakeNotifier("codex", null);

	await runDoctor();

	expect(lines.join("\n")).toContain("Codex: unable to read settings");
});

async function writeFakeNotifier(
	source: string | undefined,
	settings: Settings | null,
): Promise<void> {
	const bin = notifierBinForSource(resolvePaths(), source);
	await mkdir(dirname(bin), { recursive: true });
	await writeFile(
		bin,
		settings === null
			? "#!/bin/bash\nexit 1\n"
			: `#!/bin/bash\ncat <<'JSON'\n${JSON.stringify(settings)}\nJSON\n`,
	);
	await chmod(bin, 0o755);
}
