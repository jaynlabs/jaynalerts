import { createContext } from "../core/index.ts";
import { notify } from "../core/notify/index.ts";

export async function runTest(): Promise<void> {
	const ctx = await createContext();

	await notify({
		title: "jaynalerts",
		message: "Transient: this should banner and auto-dismiss.",
		urgency: "transient",
	});

	await new Promise((resolve) => setTimeout(resolve, 1500));

	await notify({
		title: "jaynalerts",
		message: "Sticky: this should persist + ding.",
		sound: ctx.config.notifications.stickySound,
		urgency: "sticky",
	});

	console.log(`Sent two notifications. If you didn't see them:
  1. Open System Settings → Notifications → JaynAlerts and confirm alerts are allowed.
  2. Run \`jaynalerts grant-terminal-notifications\` once for this terminal app.
  3. If the notifier bundle is missing, run \`jaynalerts init\` to rebuild it.`);
}
