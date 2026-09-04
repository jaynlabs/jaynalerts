import { access } from "node:fs/promises";
import { notifierBinForSource, resolvePaths } from "../core/paths.ts";

type NotificationSettings = {
	authorization: string;
	alertStyle: string;
	alerts: string;
	requestedAlertStyle: string;
};

const NOTIFIER_VARIANTS = [
	{ source: undefined, label: "JaynAlerts" },
	{ source: "claude-code", label: "Claude Code" },
	{ source: "codex", label: "Codex" },
	{ source: "ghostty", label: "Ghostty" },
] as const;

export async function runDoctor(): Promise<void> {
	if (process.platform !== "darwin") {
		console.log("Notification diagnostics are only available on macOS.");
		return;
	}

	const paths = resolvePaths();
	let needsAttention = false;
	console.log("macOS notification settings:");

	for (const variant of NOTIFIER_VARIANTS) {
		const bin = notifierBinForSource(paths, variant.source);
		try {
			await access(bin);
		} catch {
			console.log(
				`  ${variant.label}: bundle missing — run \`jaynalerts init\``,
			);
			needsAttention = true;
			continue;
		}

		const settings = await readSettings(bin);
		if (settings === null) {
			console.log(`  ${variant.label}: unable to read settings`);
			needsAttention = true;
			continue;
		}

		console.log(
			`  ${variant.label}: ${settings.authorization}, ${settings.alertStyle} alerts`,
		);
		if (
			settings.authorization !== "authorized" ||
			settings.alerts !== "enabled" ||
			settings.alertStyle !== "persistent"
		) {
			needsAttention = true;
		}
	}

	if (needsAttention) {
		console.log(
			"\nFor every notifier above, enable notifications and choose Persistent in System Settings → Notifications.",
		);
	} else {
		console.log("\nAll notifier bundles are authorized and persistent.");
	}
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
