import type { Config } from "./config.ts";
import { loadConfig } from "./config.ts";
import { resolveNotificationContext, tmuxOriginSubtitle } from "./focus.ts";
import { ensureNativeArtifacts } from "./native.ts";
import { notify } from "./notify/index.ts";
import type { Paths } from "./paths.ts";
import { resolvePaths } from "./paths.ts";
import type { NotifyUrgency, Source } from "./types.ts";

export type { IconSource } from "./assets.ts";
export { resolveIcon } from "./assets.ts";

export type { Config } from "./config.ts";
export { DEFAULT_CONFIG, loadConfig } from "./config.ts";
export type { NotifierVariant } from "./native.ts";
export {
	buildNativeArtifacts,
	ensureNativeArtifacts,
	NOTIFIER_VARIANTS,
} from "./native.ts";
export type { Notifier } from "./notify/types.ts";
export type { Paths } from "./paths.ts";
export { resolvePaths } from "./paths.ts";
export type {
	NotifyOptions,
	NotifyUrgency,
	Source,
	TmuxNotificationOrigin,
} from "./types.ts";

export type Context = {
	paths: Paths;
	config: Config;
};

export async function createContext(
	env: NodeJS.ProcessEnv = process.env,
): Promise<Context> {
	const paths = resolvePaths(env);

	// Every notification path comes through here, which makes it the one place
	// worth paying for a freshness check: upgrading the package leaves the
	// compiled bundles behind, and a stale notifier fails silently.
	await ensureNativeArtifacts(paths);

	const config = await loadConfig(paths);

	return { paths, config };
}

export async function notifyUser(
	ctx: Context,
	opts: {
		title: string;
		message: string;
		iconPath?: string | null;
		source?: Source;
	},
): Promise<void> {
	const focus = await resolveNotificationContext();
	const urgency: NotifyUrgency = focus.focused ? "transient" : "sticky";
	const sound =
		urgency === "transient"
			? (ctx.config.notifications.transientSound ?? undefined)
			: ctx.config.notifications.stickySound;

	const tmuxOrigin = focus.tmuxOrigin;

	await notify({
		...(opts.source ? { source: opts.source } : {}),
		title: opts.title,
		message: opts.message,
		...(tmuxOrigin ? { subtitle: tmuxOriginSubtitle(tmuxOrigin) } : {}),
		sound,
		urgency,
		...(opts.iconPath ? { appIconPath: opts.iconPath } : {}),
		...(focus.hostBundleId ? { senderBundleId: focus.hostBundleId } : {}),
		...(tmuxOrigin
			? {
					tmuxOrigin,
					tmuxZoomOnClick: ctx.config.notifications.tmuxZoomOnClick,
				}
			: {}),
	});
}
