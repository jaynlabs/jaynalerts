import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runDoctor } from "../src/cli/doctor.ts";
import { notifierStamp, notifierStampFile } from "../src/core/native.ts";
import {
	notifierAppForSource,
	notifierBinForSource,
	resolvePaths,
} from "../src/core/paths.ts";

const originalHome = process.env.JAYNALERTS_HOME;
const originalTermProgram = process.env.TERM_PROGRAM;
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
	// The Ghostty bundle is only built where Ghostty is installed, so pin it on
	// rather than let the suite depend on the machine running it.
	process.env.TERM_PROGRAM = "ghostty";
	lines = [];
	console.log = (message?: unknown) => {
		lines.push(String(message));
	};
});

afterEach(async () => {
	console.log = originalLog;
	if (originalTermProgram === undefined) {
		delete process.env.TERM_PROGRAM;
	} else {
		process.env.TERM_PROGRAM = originalTermProgram;
	}
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
	expect(output).toContain("set the alert style to Persistent for Codex");
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
	expect(lines.join("\n")).toContain("allow notifications for Ghostty");
});

test("doctor points at init when a bundle was never built", async () => {
	await writeFakeNotifier(undefined, PERSISTENT);

	await runDoctor();

	const output = lines.join("\n");
	expect(output).toContain("Codex: bundle missing — run `jaynalerts init`");
	expect(output).not.toContain("All notifier bundles");
});

// The failure this whole stamping mechanism exists for: an upgraded package
// leaves the old compiled bundle in place, and it hangs on --sticky instead of
// reporting anything wrong.
test("doctor names a bundle left behind by an older install", async () => {
	for (const source of VARIANTS) {
		await writeFakeNotifier(source, PERSISTENT);
	}
	await writeFakeNotifier("codex", PERSISTENT, {
		stamp: "0.0.1+staleaaaaaaaa",
	});

	await runDoctor();

	const output = lines.join("\n");
	expect(output).toContain(
		"Codex: bundle built by an older jaynalerts — run `jaynalerts init`",
	);
	expect(output).toContain("Rebuild Codex — run `jaynalerts init`");
	expect(output).not.toContain("All notifier bundles");
});

test("doctor lists the Focus allowlist step even when everything is healthy", async () => {
	await writeFakeNotifier(undefined, PERSISTENT);

	await runDoctor();

	const output = lines.join("\n");
	expect(output).toContain("System Settings → Focus");
	expect(output).toContain("Allowed Notifications");
	expect(output).toContain("grant-terminal-notifications");
});

async function writeFakeNotifier(
	source: string | undefined,
	settings: Settings | null,
	options: { stamp?: string } = {},
): Promise<void> {
	const paths = resolvePaths();
	const bin = notifierBinForSource(paths, source);
	await mkdir(dirname(bin), { recursive: true });
	await writeFile(
		bin,
		settings === null
			? "#!/bin/bash\nexit 1\n"
			: `#!/bin/bash\ncat <<'JSON'\n${JSON.stringify(settings)}\nJSON\n`,
	);
	await chmod(bin, 0o755);

	const stampFile = notifierStampFile(notifierAppForSource(paths, source));
	await mkdir(dirname(stampFile), { recursive: true });
	await writeFile(stampFile, `${options.stamp ?? (await notifierStamp())}\n`);
}
