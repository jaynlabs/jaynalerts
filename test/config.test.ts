import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.ts";
import { resolvePaths } from "../src/core/paths.ts";

test("tmux zoom on click defaults to enabled", () => {
	expect(DEFAULT_CONFIG.notifications.tmuxZoomOnClick).toBe(true);
	expect(DEFAULT_CONFIG.notifications.iconPi).toBeNull();
});

test("tmux zoom on click can be disabled", async () => {
	const home = await mkdtemp(join(tmpdir(), "jaynalerts-config-"));
	const paths = resolvePaths({ JAYNALERTS_HOME: home });
	await mkdir(paths.configDir, { recursive: true });
	await writeFile(
		paths.configFile,
		"[notifications]\ntmuxZoomOnClick = false\n",
	);

	const config = await loadConfig(paths);
	expect(config.notifications.tmuxZoomOnClick).toBe(false);
});
