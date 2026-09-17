import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export type Paths = {
	configDir: string;
	configFile: string;
	dataDir: string;
	bundleIdBin: string;
	notifierApp: string;
	notifierBin: string;
};

export function notifierAppForSource(paths: Paths, source?: string): string {
	if (source === undefined) return paths.notifierApp;
	const suffix = source
		.split("-")
		.map((part) => part[0]?.toUpperCase() + part.slice(1))
		.join("");
	return join(dirname(paths.notifierApp), `JaynAlertsNotifier${suffix}.app`);
}

export function notifierBinForSource(paths: Paths, source?: string): string {
	if (source === undefined) return paths.notifierBin;
	return join(
		notifierAppForSource(paths, source),
		"Contents",
		"MacOS",
		"JaynAlertsNotifier",
	);
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
	const jaynalertsHome = env.JAYNALERTS_HOME;
	const home = env.HOME;

	if (jaynalertsHome) {
		return buildPaths(
			join(jaynalertsHome, "config"),
			join(jaynalertsHome, "data"),
			join(jaynalertsHome, "Applications"),
		);
	}

	if (!home) {
		throw new Error("HOME must be set to resolve jaynalerts paths");
	}

	const configDir = join(
		env.XDG_CONFIG_HOME ?? join(home, ".config"),
		"jaynalerts",
	);
	const dataDir = join(
		env.XDG_DATA_HOME ?? join(home, ".local", "share"),
		"jaynalerts",
	);
	const appsDir = join(home, "Applications");

	return buildPaths(configDir, dataDir, appsDir);
}

export async function ensureDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
}

function buildPaths(
	configDir: string,
	dataDir: string,
	appsDir: string,
): Paths {
	const notifierApp = join(appsDir, "JaynAlertsNotifier.app");
	return {
		configDir,
		configFile: join(configDir, "config.toml"),
		dataDir,
		bundleIdBin: join(dataDir, "bin", "bundle-id"),
		notifierApp,
		notifierBin: join(notifierApp, "Contents", "MacOS", "JaynAlertsNotifier"),
	};
}
