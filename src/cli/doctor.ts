import { access } from "node:fs/promises";
import type { NotifierVariant } from "../core/native.ts";
import {
	activeNotifierVariants,
	notifierStamp,
	notifierStampFile,
	readStamp,
} from "../core/native.ts";
import type { Paths } from "../core/paths.ts";
import {
	notifierAppForSource,
	notifierBinForSource,
	resolvePaths,
} from "../core/paths.ts";

type NotificationSettings = {
	authorization: string;
	alertStyle: string;
	alerts: string;
	requestedAlertStyle: string;
};

export type NotifierStatus = {
	variant: NotifierVariant;
	state: "missing" | "stale" | "unreadable" | "reported";
	settings: NotificationSettings | null;
};

export async function runDoctor(): Promise<void> {
	if (process.platform !== "darwin") {
		console.log("Notification diagnostics are only available on macOS.");
		return;
	}

	const statuses = await collectNotifierStatuses();
	console.log("macOS notification settings:");

	for (const status of statuses) {
		console.log(`  ${status.variant.label}: ${describeStatus(status)}`);
	}

	if (statuses.every(isHealthy)) {
		console.log("\nAll notifier bundles are authorized and persistent.");
		return;
	}

	console.log("");
	for (const line of manualSteps(statuses)) {
		console.log(line);
	}
}

export async function collectNotifierStatuses(
	paths: Paths = resolvePaths(),
	variants?: readonly NotifierVariant[],
): Promise<NotifierStatus[]> {
	const expectedStamp = await notifierStamp();
	const wanted = variants ?? (await activeNotifierVariants());
	const statuses: NotifierStatus[] = [];

	for (const variant of wanted) {
		const bin = notifierBinForSource(paths, variant.source);

		try {
			await access(bin);
		} catch {
			statuses.push({ variant, state: "missing", settings: null });
			continue;
		}

		const app = notifierAppForSource(paths, variant.source);
		if ((await readStamp(notifierStampFile(app))) !== expectedStamp) {
			statuses.push({ variant, state: "stale", settings: null });
			continue;
		}

		const settings = await readSettings(bin);
		statuses.push({
			variant,
			state: settings === null ? "unreadable" : "reported",
			settings,
		});
	}

	return statuses;
}

export function describeStatus(status: NotifierStatus): string {
	switch (status.state) {
		case "missing":
			return "bundle missing — run `jaynalerts init`";
		case "stale":
			return "bundle built by an older jaynalerts — run `jaynalerts init`";
		case "unreadable":
			return "unable to read settings";
		case "reported":
			return `${status.settings?.authorization}, ${status.settings?.alertStyle} alerts`;
	}
}

/**
 * The permission grants, Persistent toggles and Focus allowlist entries macOS
 * will not let an installer set. Handed to the user as a checklist rather than
 * left to be discovered one missing banner at a time.
 */
export function manualSteps(
	statuses: NotifierStatus[],
	context: { codex?: boolean; shellRc?: string | null } = {},
): string[] {
	const lines: string[] = ["Remaining steps — macOS only lets you do these:"];
	let step = 1;
	const add = (head: string, ...rest: string[]): void => {
		lines.push(`  ${step}. ${head}`, ...rest.map((line) => `     ${line}`));
		step += 1;
	};

	const needsBuild = statuses.filter(
		(status) => status.state === "missing" || status.state === "stale",
	);
	if (needsBuild.length > 0) {
		add(
			`Rebuild ${labels(needsBuild)} — run \`jaynalerts init\`.`,
			"Everything below depends on the bundles existing first.",
		);
	}

	add(
		"Register each terminal app you use (Terminal, iTerm, Ghostty…):",
		"jaynalerts grant-terminal-notifications",
		"Run it once from inside each one, and click Allow.",
	);

	const unauthorized = statuses.filter(
		(status) =>
			status.state === "reported" &&
			(status.settings?.authorization !== "authorized" ||
				status.settings.alerts !== "enabled"),
	);
	if (unauthorized.length > 0) {
		add(
			`System Settings → Notifications → allow notifications for ${labels(unauthorized)}.`,
			"A bundle that has never fired a banner shows as notDetermined; it",
			"prompts the first time it notifies.",
		);
	}

	const temporary = statuses.filter(
		(status) =>
			status.state === "reported" &&
			status.settings?.alertStyle !== "persistent",
	);
	if (temporary.length > 0) {
		add(
			`In that same panel, set the alert style to Persistent for ${labels(temporary)}.`,
			"Temporary banners auto-dismiss, so sticky alerts get missed.",
		);
	}

	add(
		"System Settings → Focus → your Focus → Allowed Notifications:",
		`add ${labels(statuses)},`,
		"or Focus silences exactly the alerts you turned Focus on for.",
	);

	if (context.codex === true) {
		add(
			'Start Codex and pick "Trust all and continue" when it says hooks need',
			"review — until then approval alerts stay silent.",
		);
	}

	if (context.shellRc != null) {
		add(
			"Open a new shell, or reload the one you are in:",
			`source ${context.shellRc}`,
		);
	}

	lines.push("", "Run `jaynalerts doctor` to check these off.");
	return lines;
}

function isHealthy(status: NotifierStatus): boolean {
	return (
		status.state === "reported" &&
		status.settings?.authorization === "authorized" &&
		status.settings.alerts === "enabled" &&
		status.settings.alertStyle === "persistent"
	);
}

function labels(statuses: NotifierStatus[]): string {
	const names = statuses.map((status) => status.variant.label);

	if (names.length <= 1) return names.join("");
	const last = names[names.length - 1];
	return `${names.slice(0, -1).join(", ")} and ${last}`;
}

async function readSettings(bin: string): Promise<NotificationSettings | null> {
	const abortController = new AbortController();
	const timeout = setTimeout(() => abortController.abort(), 2_000);
	try {
		const proc = Bun.spawn([bin, "--settings"], {
			stdout: "pipe",
			stderr: "pipe",
			signal: abortController.signal,
		});
		const [exitCode, stdout] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
		]);
		if (exitCode !== 0) return null;
		return JSON.parse(stdout) as NotificationSettings;
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}
