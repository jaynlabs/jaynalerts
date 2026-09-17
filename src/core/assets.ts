import { access } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";

export type IconSource = "claude-code" | "codex" | "opencode" | "pi";

export function assetsDir(): string {
	return join(import.meta.dir, "..", "..", "assets");
}

export async function resolveIcon(
	config: Config,
	source: IconSource,
): Promise<string | null> {
	const override = configOverride(config, source);
	if (override !== null) {
		return override;
	}

	const shortNames = iconShortNames(source);

	const candidates: string[] = [];
	for (const name of shortNames) {
		candidates.push(join(assetsDir(), `${name}.icns`));
		candidates.push(join(assetsDir(), `${name}.png`));
	}

	for (const candidate of candidates) {
		try {
			await access(candidate);
			return candidate;
		} catch {
			// keep looking
		}
	}

	return null;
}

function iconShortNames(source: IconSource): string[] {
	switch (source) {
		case "claude-code":
			return ["claude-code", "claude"];
		case "codex":
			return ["codex"];
		case "opencode":
			return ["opencode"];
		case "pi":
			return ["pi"];
	}
}

function configOverride(config: Config, source: IconSource): string | null {
	const value = iconOverride(config, source);

	if (value === null) {
		return null;
	}

	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function iconOverride(config: Config, source: IconSource): string | null {
	switch (source) {
		case "claude-code":
			return config.notifications.iconClaudeCode;
		case "codex":
			return config.notifications.iconCodex;
		case "opencode":
			return config.notifications.iconOpencode;
		case "pi":
			return config.notifications.iconPi;
	}
}
