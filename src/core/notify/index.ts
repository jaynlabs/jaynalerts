import type { NotifyOptions } from "../types.ts";
import { macosNotifier } from "./macos.ts";
import type { Notifier } from "./types.ts";

export const notifiers: Notifier[] = [macosNotifier];

export async function notify(opts: NotifyOptions): Promise<void> {
	for (const notifier of notifiers) {
		if (await notifier.isAvailable()) {
			await notifier.notify(opts);
			return;
		}
	}

	throw new Error("jaynalerts: no available notifier for this platform");
}
