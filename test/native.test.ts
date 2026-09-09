import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import {
	buildNativeArtifacts,
	ensureNativeArtifacts,
	helperIsStale,
	helperStampFile,
	notifierStamp,
	notifierStampFile,
	staleNotifierVariants,
} from "../src/core/native.ts";
import { notifierAppForSource, resolvePaths } from "../src/core/paths.ts";

// Building four bundles means four swiftc invocations behind one compile.
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

	const stale = await staleNotifierVariants(paths);

	expect(stale.map((variant) => variant.label)).toEqual([
		"JaynAlerts",
		"Claude Code",
		"Codex",
		"Ghostty",
	]);
	expect(await helperIsStale(paths)).toBe(true);
});

swiftTest(
	"a freshly built bundle is stamped and reads as fresh",
	async () => {
		const paths = await temporaryPaths();

		const report = await buildNativeArtifacts(paths, { quiet: true });

		expect(report.built).toBe(true);
		expect(report.problem).toBeNull();
		expect(await staleNotifierVariants(paths)).toEqual([]);
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
		await buildNativeArtifacts(paths, { quiet: true });

		const codexStamp = notifierStampFile(notifierAppForSource(paths, "codex"));
		await writeFile(codexStamp, "0.0.1+staleaaaaaaaa\n");
		await writeFile(helperStampFile(paths), "0.0.1+staleaaaaaaaa\n");

		expect((await staleNotifierVariants(paths)).map((v) => v.label)).toEqual([
			"Codex",
		]);

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
		expect(await staleNotifierVariants(paths)).toEqual([]);
		expect(await helperIsStale(paths)).toBe(false);
	},
	BUILD_TIMEOUT_MS,
);

swiftTest(
	"a missing binary is stale even when the stamp still matches",
	async () => {
		const paths = await temporaryPaths();
		await buildNativeArtifacts(paths, { quiet: true });

		await rm(
			join(notifierAppForSource(paths, undefined), "Contents", "MacOS"),
			{
				recursive: true,
				force: true,
			},
		);

		expect((await staleNotifierVariants(paths)).map((v) => v.label)).toEqual([
			"JaynAlerts",
		]);
	},
	BUILD_TIMEOUT_MS,
);

test("another process holding the rebuild lock is left to finish", async () => {
	const paths = await temporaryPaths();
	const lockFile = join(paths.dataDir, "rebuild.lock");
	await Bun.write(lockFile, "1\n");

	await ensureNativeArtifacts(paths);

	// Nothing was built, and the lock we did not take is still there.
	expect(await staleNotifierVariants(paths)).not.toEqual([]);
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

	expect(await staleNotifierVariants(paths)).not.toEqual([]);
});
