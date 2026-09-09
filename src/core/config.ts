import { readFile } from "node:fs/promises";
import type { TomlTableWithoutBigInt, TomlValueWithoutBigInt } from "smol-toml";
import { parse } from "smol-toml";
import type { Paths } from "./paths.ts";

export type Config = {
	notifications: {
		transientSound: string | null;
		stickySound: string;
		tmuxZoomOnClick: boolean;
		iconClaudeCode: string | null;
		iconCodex: string | null;
		iconOpencode: string | null;
		iconPi: string | null;
	};
	shell: {
		thresholdMs: number;
		ignore: string[];
	};
};

export const DEFAULT_CONFIG: Config = {
	notifications: {
		transientSound: null,
		stickySound: "default",
		tmuxZoomOnClick: true,
		iconClaudeCode: null,
		iconCodex: null,
		iconOpencode: null,
		iconPi: null,
	},
	shell: {
		thresholdMs: 15_000,
		ignore: [
			"vim",
			"nvim",
			"vi",
			"emacs",
			"nano",
			"less",
			"more",
			"man",
			"ssh",
			"tmux",
			"screen",
			"htop",
			"top",
			"btop",
			"fzf",
			"watch",
			"tail",
			"claude",
			"opencode",
			"pi",
		],
	},
};

export async function loadConfig(paths: Paths): Promise<Config> {
	let contents: string;

	try {
		contents = await readFile(paths.configFile, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return DEFAULT_CONFIG;
		}

		throw error;
	}

	let userConfig: TomlTableWithoutBigInt;

	try {
		userConfig = parse(contents, { integersAsBigInt: false });
	} catch (error) {
		throw new Error(
			`Failed to parse ${paths.configFile}: ${errorMessage(error)}`,
			{ cause: error },
		);
	}

	return mergeConfig(userConfig);
}

function mergeConfig(userConfig: TomlTableWithoutBigInt): Config {
	return {
		notifications: mergeNotificationsConfig(userConfig.notifications),
		shell: mergeShellConfig(userConfig.shell),
	};
}

function mergeShellConfig(
	value: TomlValueWithoutBigInt | undefined,
): Config["shell"] {
	if (value === undefined) {
		return {
			thresholdMs: DEFAULT_CONFIG.shell.thresholdMs,
			ignore: [...DEFAULT_CONFIG.shell.ignore],
		};
	}

	const table = requireTable("shell", value);

	return {
		thresholdMs: positiveIntegerOrDefault(
			"shell.thresholdMs",
			table.thresholdMs,
			DEFAULT_CONFIG.shell.thresholdMs,
		),
		ignore: stringArrayOrDefault(
			"shell.ignore",
			table.ignore,
			DEFAULT_CONFIG.shell.ignore,
		),
	};
}

function positiveIntegerOrDefault(
	path: string,
	value: TomlValueWithoutBigInt | undefined,
	fallback: number,
): number {
	if (value === undefined) {
		return fallback;
	}

	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`${path} must be a positive integer`);
	}

	return value;
}

function mergeNotificationsConfig(
	value: TomlValueWithoutBigInt | undefined,
): Config["notifications"] {
	if (value === undefined) {
		return { ...DEFAULT_CONFIG.notifications };
	}

	const table = requireTable("notifications", value);

	return {
		transientSound: nullableStringOrDefault(
			"notifications.transientSound",
			table.transientSound,
			DEFAULT_CONFIG.notifications.transientSound,
		),
		stickySound: stringOrDefault(
			"notifications.stickySound",
			table.stickySound,
			DEFAULT_CONFIG.notifications.stickySound,
		),
		tmuxZoomOnClick: booleanOrDefault(
			"notifications.tmuxZoomOnClick",
			table.tmuxZoomOnClick,
			DEFAULT_CONFIG.notifications.tmuxZoomOnClick,
		),
		iconClaudeCode: nullableStringOrDefault(
			"notifications.iconClaudeCode",
			table.iconClaudeCode,
			DEFAULT_CONFIG.notifications.iconClaudeCode,
		),
		iconCodex: nullableStringOrDefault(
			"notifications.iconCodex",
			table.iconCodex,
			DEFAULT_CONFIG.notifications.iconCodex,
		),
		iconOpencode: nullableStringOrDefault(
			"notifications.iconOpencode",
			table.iconOpencode,
			DEFAULT_CONFIG.notifications.iconOpencode,
		),
		iconPi: nullableStringOrDefault(
			"notifications.iconPi",
			table.iconPi,
			DEFAULT_CONFIG.notifications.iconPi,
		),
	};
}

function requireTable(
	path: string,
	value: TomlValueWithoutBigInt,
): TomlTableWithoutBigInt {
	if (!isPlainTable(value)) {
		throw new Error(`${path} must be a table`);
	}

	return value;
}

function stringArrayOrDefault(
	path: string,
	value: TomlValueWithoutBigInt | undefined,
	fallback: string[],
): string[] {
	if (value === undefined) {
		return [...fallback];
	}

	if (
		!Array.isArray(value) ||
		!value.every((item) => typeof item === "string")
	) {
		throw new Error(`${path} must be a string array`);
	}

	return value;
}

function nullableStringOrDefault(
	path: string,
	value: TomlValueWithoutBigInt | undefined,
	fallback: string | null,
): string | null {
	if (value === undefined) {
		return fallback;
	}

	if (typeof value !== "string") {
		throw new Error(
			`${path} must be a string (omit the key to restore the default)`,
		);
	}

	return value;
}

function stringOrDefault(
	path: string,
	value: TomlValueWithoutBigInt | undefined,
	fallback: string,
): string {
	if (value === undefined) {
		return fallback;
	}

	if (typeof value !== "string") {
		throw new Error(`${path} must be a string`);
	}

	return value;
}

function booleanOrDefault(
	path: string,
	value: TomlValueWithoutBigInt | undefined,
	fallback: boolean,
): boolean {
	if (value === undefined) {
		return fallback;
	}

	if (typeof value !== "boolean") {
		throw new Error(`${path} must be a boolean`);
	}

	return value;
}

function isPlainTable(
	value: TomlValueWithoutBigInt,
): value is TomlTableWithoutBigInt {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
