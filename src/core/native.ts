// Everything jaynalerts compiles on the user's machine: the notifier .app
// bundles and the frontmost-window helper.
//
// Upgrading the package does not rebuild those artifacts, and a stale notifier
// fails silently — the old binary simply never returns from `--sticky`. So each
// artifact carries a build stamp (package version + a hash of the Swift source
// it was compiled from) and every entry point cheap-compares that stamp before
// it notifies, rebuilding in place when it no longer matches.

import { createHash } from "node:crypto";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import type { Paths } from "./paths.ts";
import {
	notifierAppForSource,
	notifierBinForSource,
	resolvePaths,
} from "./paths.ts";
import type { SwiftToolchainProblem } from "./swift.ts";
import { checkSwiftToolchain, swiftToolchainMessage } from "./swift.ts";

export type NotifierVariant = {
	source: string | undefined;
	label: string;
	icon: string;
};

export const NOTIFIER_VARIANTS: readonly NotifierVariant[] = [
	{ source: undefined, label: "JaynAlerts", icon: "notifier" },
	{ source: "claude-code", label: "Claude Code", icon: "claude-code" },
	{ source: "codex", label: "Codex", icon: "codex" },
	{ source: "pi", label: "Pi", icon: "pi" },
	{ source: "ghostty", label: "Ghostty", icon: "ghostty" },
] as const;

// The Ghostty variant exists so shell notifications sent from Ghostty carry
// its icon. Building it unconditionally dropped a "Ghostty" app into
// ~/Applications and a "Ghostty" row into System Settings → Notifications for
// people who have never run Ghostty — and the init checklist then asked them to
// grant it permissions and allowlist it under Focus. Build it only where it can
// actually be used.
function ghosttyAppPaths(): string[] {
	return [
		"/Applications/Ghostty.app",
		join(homedir(), "Applications", "Ghostty.app"),
	];
}

// `appPaths` is a seam: whether Ghostty sits in /Applications is a property of
// the machine running the suite, and both branches have to be testable anyway.
export async function ghosttyIsInstalled(
	env: NodeJS.ProcessEnv = process.env,
	appPaths: readonly string[] = ghosttyAppPaths(),
): Promise<boolean> {
	if (env.TERM_PROGRAM === "ghostty") return true;

	for (const app of appPaths) {
		try {
			if (await fileExists(app)) return true;
		} catch {
			// unreadable is not installed
		}
	}

	return false;
}

/** The variants this machine should actually have bundles for. */
export async function activeNotifierVariants(
	env: NodeJS.ProcessEnv = process.env,
	appPaths: readonly string[] = ghosttyAppPaths(),
): Promise<NotifierVariant[]> {
	const ghostty = await ghosttyIsInstalled(env, appPaths);

	return NOTIFIER_VARIANTS.filter(
		(variant) => variant.source !== "ghostty" || ghostty,
	);
}

export type BuildReport = {
	built: boolean;
	notes: string[];
	problem: SwiftToolchainProblem | null;
};

const STAMP_FILE = "build-stamp";
const REBUILD_LOCK_STALE_MS = 5 * 60 * 1000;

let notifierStampPromise: Promise<string> | null = null;
let helperStampPromise: Promise<string> | null = null;

export function nativeDir(): string {
	return join(import.meta.dir, "..", "native");
}

export function assetsRoot(): string {
	return join(import.meta.dir, "..", "..", "assets");
}

// Icons are hashed too, so editing an asset rebuilds the bundles that embed
// it; missing icons are skipped instead of failing the whole stamp.
const NOTIFIER_ICON_ASSETS = [
	"notifier.png",
	"claude-code.png",
	"codex.png",
	"opencode.png",
	"pi.png",
	"ghostty.icns",
];

export async function notifierStamp(): Promise<string> {
	notifierStampPromise ??= computeStamp([
		join(nativeDir(), "notifier.swift"),
		join(nativeDir(), "notifier.plist"),
		...(await existingIconAssets()),
	]);
	return notifierStampPromise;
}

async function existingIconAssets(): Promise<string[]> {
	const paths = NOTIFIER_ICON_ASSETS.map((name) => join(assetsRoot(), name));
	const checks = await Promise.all(paths.map((path) => fileExists(path)));
	return paths.filter((_, index) => checks[index]);
}

export async function helperStamp(): Promise<string> {
	helperStampPromise ??= computeStamp([join(nativeDir(), "bundle-id.swift")]);
	return helperStampPromise;
}

export function notifierStampFile(app: string): string {
	return join(app, "Contents", "Resources", STAMP_FILE);
}

export function helperStampFile(paths: Paths): string {
	return `${paths.bundleIdBin}.${STAMP_FILE}`;
}

export async function readStamp(file: string): Promise<string | null> {
	try {
		return (await readFile(file, "utf8")).trim();
	} catch {
		return null;
	}
}

// Cheap: five small reads plus one hash of the Swift sources, all cached for
// the rest of the process. Safe to call on every hook invocation.
export async function staleNotifierVariants(
	paths: Paths,
	variants?: readonly NotifierVariant[],
): Promise<NotifierVariant[]> {
	const expected = await notifierStamp();
	const wanted = variants ?? (await activeNotifierVariants());
	const stale: NotifierVariant[] = [];

	for (const variant of wanted) {
		if (!(await variantIsFresh(paths, variant, expected))) {
			stale.push(variant);
		}
	}

	return stale;
}

export async function helperIsStale(paths: Paths): Promise<boolean> {
	if (!(await fileExists(paths.bundleIdBin))) return true;
	return (await readStamp(helperStampFile(paths))) !== (await helperStamp());
}

/**
 * Rebuild anything whose stamp no longer matches this install. Never throws:
 * notifications must still go out on a machine that cannot compile.
 */
export async function ensureNativeArtifacts(
	paths: Paths = resolvePaths(),
): Promise<void> {
	if (process.platform !== "darwin") return;
	if (process.env.JAYNALERTS_NO_AUTO_REBUILD !== undefined) return;

	try {
		const stale = await staleNotifierVariants(paths);
		const helperStale = await helperIsStale(paths);

		if (stale.length === 0 && !helperStale) return;

		// A missing bundle is a fresh install (init has not run yet); a mismatched
		// one is the dangerous case, because the binary that is there will hang.
		const release = await acquireRebuildLock(paths);
		if (release === null) return;

		try {
			console.warn(
				`jaynalerts: notifier is out of date (jaynalerts ${pkg.version}); rebuilding…`,
			);
			const report = await buildNativeArtifacts(paths, { quiet: true });
			if (report.problem !== null) {
				console.warn(
					`jaynalerts: ${swiftToolchainMessage(report.problem).split("\n")[0]}`,
				);
			}
		} finally {
			await release();
		}
	} catch (error) {
		console.warn(
			`jaynalerts: could not refresh the notifier: ${errorMessage(error)}`,
		);
	}
}

export async function buildNativeArtifacts(
	paths: Paths,
	options: { quiet?: boolean; variants?: readonly NotifierVariant[] } = {},
): Promise<BuildReport> {
	const notes: string[] = [];
	const log = (line: string): void => {
		notes.push(line);
		if (options.quiet !== true) console.log(line);
	};

	if (process.platform !== "darwin") {
		return { built: false, notes, problem: null };
	}

	const toolchain = await checkSwiftToolchain();

	if (!toolchain.ok) {
		return { built: false, notes, problem: toolchain.problem };
	}

	await buildFrontmostHelper(paths, toolchain.swiftc, log);
	await buildNotifierBundles(
		paths,
		toolchain.swiftc,
		options.variants ?? (await activeNotifierVariants()),
		log,
	);

	return { built: true, notes, problem: null };
}

async function buildNotifierBundles(
	paths: Paths,
	swiftc: string,
	variants: readonly NotifierVariant[],
	log: (line: string) => void,
): Promise<void> {
	const swiftSource = join(nativeDir(), "notifier.swift");
	const plistSource = join(nativeDir(), "notifier.plist");

	if (!(await fileExists(swiftSource)) || !(await fileExists(plistSource))) {
		log(`notifier:    missing source files; skipped (${swiftSource})`);
		return;
	}

	const stamp = await notifierStamp();
	const staging = await mkdtemp(join(tmpdir(), "jaynalerts-notifier-"));

	try {
		const compiled = join(staging, "JaynAlertsNotifier");
		await compileSwift(swiftc, swiftSource, compiled);

		const plistTemplate = await readFile(plistSource, "utf8");

		for (const variant of variants) {
			const app = notifierAppForSource(paths, variant.source);
			const bin = notifierBinForSource(paths, variant.source);
			const stampFile = notifierStampFile(app);

			// Drop the old stamp first: a build that dies halfway leaves the bundle
			// looking stale, so the next run retries instead of trusting it.
			await rm(stampFile, { force: true });
			await mkdir(dirname(bin), { recursive: true });
			await replaceFileAtomically(compiled, bin);

			const suffix = variant.source?.replaceAll("-", ".") ?? "notifier";
			const plist = plistTemplate
				.replace("dev.jaynalerts.notifier", `dev.jaynalerts.${suffix}`)
				.replaceAll(
					"<string>JaynAlerts</string>",
					`<string>${variant.label}</string>`,
				)
				.replace(
					"<key>CFBundleShortVersionString</key>\n\t<string>1.0</string>",
					`<key>CFBundleShortVersionString</key>\n\t<string>${pkg.version}</string>`,
				);
			await writeFile(join(app, "Contents", "Info.plist"), plist);

			const resourcesDir = join(app, "Contents", "Resources");
			await mkdir(resourcesDir, { recursive: true });
			await installIcon(variant, resourcesDir, log);

			// Written before codesign so the signature seals it; removed again if
			// signing fails, so a broken bundle never looks up to date.
			await writeFile(stampFile, `${stamp}\n`);
			try {
				await signNotifierBundle(app);
			} catch (error) {
				await rm(stampFile, { force: true });
				throw error;
			}

			log(`notifier:    ${variant.label} bundle built at ${app}`);
		}
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

async function installIcon(
	variant: NotifierVariant,
	resourcesDir: string,
	log: (line: string) => void,
): Promise<void> {
	const targetIcns = join(resourcesDir, "AppIcon.icns");
	const icnsSource = join(assetsRoot(), `${variant.icon}.icns`);
	const pngSource = join(assetsRoot(), `${variant.icon}.png`);

	if (await fileExists(icnsSource)) {
		await copyFile(icnsSource, targetIcns);
		return;
	}

	if (
		(await fileExists(pngSource)) &&
		!(await convertPngToIcns(pngSource, targetIcns))
	) {
		log(`notifier:    could not convert ${pngSource} to .icns`);
	}
}

async function buildFrontmostHelper(
	paths: Paths,
	swiftc: string,
	log: (line: string) => void,
): Promise<void> {
	const source = join(nativeDir(), "bundle-id.swift");

	if (!(await fileExists(source))) {
		log(`focus:       missing Swift source at ${source}; skipped`);
		return;
	}

	const target = paths.bundleIdBin;
	const stampFile = helperStampFile(paths);

	await rm(stampFile, { force: true });
	await mkdir(dirname(target), { recursive: true });

	const staging = await mkdtemp(join(tmpdir(), "jaynalerts-helper-"));
	try {
		const compiled = join(staging, "bundle-id");
		await compileSwift(swiftc, source, compiled);
		await replaceFileAtomically(compiled, target);
		await writeFile(stampFile, `${await helperStamp()}\n`);
		log(`focus:       compiled helper at ${target}`);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

async function compileSwift(
	swiftc: string,
	source: string,
	output: string,
): Promise<void> {
	const proc = Bun.spawn([swiftc, "-O", "-o", output, source], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const [exitCode, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stderr).text(),
	]);

	if (exitCode !== 0) {
		const detail = stderr.trim();
		throw new Error(
			`swiftc failed to compile ${source} (exit ${exitCode})${detail === "" ? "" : `\n${detail}`}`,
		);
	}
}

// Rename over the live path so a notification firing mid-rebuild execs either
// the old binary or the new one, never a half-copied file.
async function replaceFileAtomically(
	source: string,
	target: string,
): Promise<void> {
	const temporary = `${target}.tmp.${process.pid}`;
	try {
		await copyFile(source, temporary);
		await rename(temporary, target);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
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

async function variantIsFresh(
	paths: Paths,
	variant: NotifierVariant,
	expected: string,
): Promise<boolean> {
	const app = notifierAppForSource(paths, variant.source);
	if (!(await fileExists(notifierBinForSource(paths, variant.source)))) {
		return false;
	}
	return (await readStamp(notifierStampFile(app))) === expected;
}

// Several agents can fire hooks at once. Only one of them needs to rebuild;
// the others carry on with what is already installed.
async function acquireRebuildLock(
	paths: Paths,
): Promise<(() => Promise<void>) | null> {
	const lockFile = join(paths.dataDir, "rebuild.lock");
	await mkdir(dirname(lockFile), { recursive: true });

	const release = async (): Promise<void> => {
		await rm(lockFile, { force: true });
	};

	try {
		await writeFile(lockFile, `${process.pid}\n`, { flag: "wx" });
		return release;
	} catch (error) {
		if (!isNodeError(error) || error.code !== "EEXIST") throw error;
	}

	const age = await fileAgeMs(lockFile);
	if (age === null || age < REBUILD_LOCK_STALE_MS) {
		return null;
	}

	// A previous rebuild was killed; take the lock over rather than never
	// rebuilding again.
	await rm(lockFile, { force: true });
	try {
		await writeFile(lockFile, `${process.pid}\n`, { flag: "wx" });
		return release;
	} catch {
		return null;
	}
}

async function fileAgeMs(file: string): Promise<number | null> {
	try {
		return Date.now() - (await stat(file)).mtimeMs;
	} catch {
		return null;
	}
}

async function computeStamp(sources: string[]): Promise<string> {
	const hash = createHash("sha256");
	hash.update(pkg.version);

	for (const source of sources) {
		hash.update("\0");
		hash.update(await readFile(source));
	}

	return `${pkg.version}+${hash.digest("hex").slice(0, 16)}`;
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

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return false;
		throw error;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
