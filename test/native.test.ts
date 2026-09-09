import { afterEach, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import {
	activeNotifierVariants,
	buildNativeArtifacts,
	ensureNativeArtifacts,
	ghosttyIsInstalled,
	helperIsStale,
	helperStampFile,
	NOTIFIER_VARIANTS,
	notifierStamp,
	notifierStampFile,
	staleNotifierVariants,
} from "../src/core/native.ts";
import { notifierAppForSource, resolvePaths } from "../src/core/paths.ts";

// Building five notifier bundles plus the helper can exceed bun's default timeout.
const BUILD_TIMEOUT_MS = 120_000;
const hasSwiftc = Bun.which("swiftc") !== null;
const swiftTest = hasSwiftc ? test : test.skip;

const temporaryHomes: string[] = [];

afterEach(async () => {
	for (const home of temporaryHomes.splice(0)) {
		await rm(home, { force: true, recursive: true });
	}
});

async function temporaryPaths() {
	const home = await mkdtemp(join(tmpdir(), "jaynalerts-native-"));
	temporaryHomes.push(home);
	return resolvePaths({ JAYNALERTS_HOME: home });
}

test("the stamp carries the package version and a source hash", async () => {
	const stamp = await notifierStamp();

	expect(stamp.startsWith(`${pkg.version}+`)).toBe(true);
	expect(stamp).toBe(await notifierStamp());
});

test("every variant is stale before anything is built", async () => {
	const paths = await temporaryPaths();

	const stale = await staleNotifierVariants(paths, NOTIFIER_VARIANTS);

	expect(stale.map((variant) => variant.label)).toEqual([
		"JaynAlerts",
		"Claude Code",
		"Codex",
		"Pi",
		"Ghostty",
	]);
	expect(await helperIsStale(paths)).toBe(true);
});

swiftTest(
	"a freshly built bundle is stamped and reads as fresh",
	async () => {
		const paths = await temporaryPaths();

		const report = await buildNativeArtifacts(paths, {
			quiet: true,
			variants: NOTIFIER_VARIANTS,
		});

		expect(report.built).toBe(true);
		expect(report.problem).toBeNull();
		expect(await staleNotifierVariants(paths, NOTIFIER_VARIANTS)).toEqual([]);
		expect(await helperIsStale(paths)).toBe(false);

		const stamp = await readFile(
			notifierStampFile(notifierAppForSource(paths, "codex")),
			"utf8",
		);
		expect(stamp.trim()).toBe(await notifierStamp());
	},
	BUILD_TIMEOUT_MS,
);

// The failure that motivated stamping: upgrading the package leaves the old
// binary in place, and it hangs on --sticky rather than reporting anything.
swiftTest(
	"an upgraded install rebuilds itself on the next notification",
	async () => {
		const paths = await temporaryPaths();
		await buildNativeArtifacts(paths, {
			quiet: true,
			variants: NOTIFIER_VARIANTS,
		});

		const codexStamp = notifierStampFile(notifierAppForSource(paths, "codex"));
		await writeFile(codexStamp, "0.0.1+staleaaaaaaaa\n");
		await writeFile(helperStampFile(paths), "0.0.1+staleaaaaaaaa\n");

		expect(
			(await staleNotifierVariants(paths, NOTIFIER_VARIANTS)).map(
				(v) => v.label,
			),
		).toEqual(["Codex"]);

		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (message?: unknown) => {
			warnings.push(String(message));
		};
		try {
			await ensureNativeArtifacts(paths);
		} finally {
			console.warn = originalWarn;
		}

		expect(warnings.join("\n")).toContain("out of date");
		expect(await staleNotifierVariants(paths, NOTIFIER_VARIANTS)).toEqual([]);
		expect(await helperIsStale(paths)).toBe(false);
	},
	BUILD_TIMEOUT_MS,
);

swiftTest(
	"a missing binary is stale even when the stamp still matches",
	async () => {
		const paths = await temporaryPaths();
		await buildNativeArtifacts(paths, {
			quiet: true,
			variants: NOTIFIER_VARIANTS,
		});

		await rm(
			join(notifierAppForSource(paths, undefined), "Contents", "MacOS"),
			{
				recursive: true,
				force: true,
			},
		);

		expect(
			(await staleNotifierVariants(paths, NOTIFIER_VARIANTS)).map(
				(v) => v.label,
			),
		).toEqual(["JaynAlerts"]);
	},
	BUILD_TIMEOUT_MS,
);

test("another process holding the rebuild lock is left to finish", async () => {
	const paths = await temporaryPaths();
	const lockFile = join(paths.dataDir, "rebuild.lock");
	await Bun.write(lockFile, "1\n");

	await ensureNativeArtifacts(paths);

	// Nothing was built, and the lock we did not take is still there.
	expect(await staleNotifierVariants(paths, NOTIFIER_VARIANTS)).not.toEqual([]);
	expect((await stat(lockFile)).isFile()).toBe(true);
});

test("JAYNALERTS_NO_AUTO_REBUILD opts out of rebuilding entirely", async () => {
	const paths = await temporaryPaths();
	process.env.JAYNALERTS_NO_AUTO_REBUILD = "1";

	try {
		await ensureNativeArtifacts(paths);
	} finally {
		delete process.env.JAYNALERTS_NO_AUTO_REBUILD;
	}

	expect(await staleNotifierVariants(paths, NOTIFIER_VARIANTS)).not.toEqual([]);
});

// Nobody should get a "Ghostty" app in ~/Applications, a Ghostty row in System
// Settings → Notifications and a Ghostty line in the Focus checklist for a
// terminal they do not have. Ghostty is installed on plenty of dev machines, so
// these pass explicit app paths rather than depend on the one running the suite.
const NO_GHOSTTY = ["/nonexistent/Ghostty.app"] as const;

test("the Ghostty bundle is skipped on a machine without Ghostty", async () => {
	const variants = await activeNotifierVariants(
		{ TERM_PROGRAM: "xterm-256" },
		NO_GHOSTTY,
	);

	expect(
		await ghosttyIsInstalled({ TERM_PROGRAM: "xterm-256" }, NO_GHOSTTY),
	).toBe(false);
	expect(variants.map((v) => v.label)).toEqual([
		"JaynAlerts",
		"Claude Code",
		"Codex",
		"Pi",
	]);
});

test("an installed Ghostty opts the bundle back in", async () => {
	const home = await mkdtemp(join(tmpdir(), "jaynalerts-ghostty-"));
	temporaryHomes.push(home);
	const app = join(home, "Ghostty.app");
	await mkdir(app);

	const variants = await activeNotifierVariants({ TERM_PROGRAM: "xterm-256" }, [
		app,
	]);

	expect(variants.map((v) => v.label)).toEqual([
		"JaynAlerts",
		"Claude Code",
		"Codex",
		"Pi",
		"Ghostty",
	]);
});

test("running under Ghostty opts the bundle back in without an app path", async () => {
	const variants = await activeNotifierVariants(
		{ TERM_PROGRAM: "ghostty" },
		NO_GHOSTTY,
	);

	expect(variants.map((v) => v.label)).toEqual([
		"JaynAlerts",
		"Claude Code",
		"Codex",
		"Pi",
		"Ghostty",
	]);
});

test("a skipped variant is not reported as stale", async () => {
	const paths = await temporaryPaths();
	const variants = await activeNotifierVariants(
		{ TERM_PROGRAM: "xterm-256" },
		NO_GHOSTTY,
	);

	const stale = await staleNotifierVariants(paths, variants);

	// Nothing is built yet, so every *wanted* variant is stale — and Ghostty,
	// which this machine does not want, is not among them.
	expect(stale.map((v) => v.label)).toEqual([
		"JaynAlerts",
		"Claude Code",
		"Codex",
		"Pi",
	]);
});
