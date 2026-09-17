import { access } from "node:fs/promises";
import { notifierBinForSource, resolvePaths } from "../paths.ts";
import type { Notifier, NotifyOptions } from "./types.ts";

let hasWarnedAboutMissingNotifier = false;

export const macosNotifier: Notifier = {
	name: "macos",
	async isAvailable() {
		return process.platform === "darwin";
	},
	async notify(opts) {
		await notify(opts);
	},
};

async function notify(opts: NotifyOptions): Promise<void> {
	const paths = resolvePaths();
	const bin = notifierBinForSource(paths, opts.source);

	try {
		await access(bin);
	} catch {
		warnAboutMissingNotifier(bin);
		return;
	}

	const argv = [bin, "--title", opts.title, "--message", opts.message];

	if (opts.subtitle !== undefined && opts.subtitle.trim() !== "") {
		argv.push("--subtitle", opts.subtitle);
	}

	if (opts.appIconPath !== undefined && opts.appIconPath !== "") {
		argv.push("--icon", opts.appIconPath);
	}

	if (opts.senderBundleId !== undefined && opts.senderBundleId !== "") {
		argv.push("--host", opts.senderBundleId);
	}

	const origin = opts.tmuxOrigin;
	if (origin !== undefined) {
		argv.push("--pane", origin.paneId);
		pushArg(argv, "--tmux-socket", origin.socketPath);
		pushArg(argv, "--tmux-client", origin.clientTty);
		pushArg(argv, "--tmux-session", origin.sessionName);
		pushArg(argv, "--tmux-window", origin.windowId);
		pushArg(argv, "--tmux-window-index", origin.windowIndex);
		pushArg(argv, "--tmux-window-name", origin.windowName);
		pushArg(argv, "--tmux-pane-index", origin.paneIndex);
		pushArg(argv, "--origin-key", origin.originKey);
		if (opts.tmuxZoomOnClick === true) {
			argv.push("--zoom-on-click");
		}
	}

	if (opts.sound !== undefined) {
		argv.push("--sound", opts.sound);
	}

	if (opts.urgency === "sticky") {
		argv.push("--sticky");
	} else {
		argv.push("--transient-seconds", "5");
	}

	try {
		const debug = process.env.JAYNALERTS_DEBUG !== undefined;
		const proc = Bun.spawn(argv, {
			stdio: ["ignore", "ignore", debug ? "inherit" : "ignore"],
		});
		proc.unref();
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			warnAboutMissingNotifier(bin);
			return;
		}
		throw error;
	}
}

function pushArg(
	argv: string[],
	flag: string,
	value: string | undefined,
): void {
	if (value !== undefined && value !== "") {
		argv.push(flag, value);
	}
}

function warnAboutMissingNotifier(bin: string): void {
	if (hasWarnedAboutMissingNotifier) {
		return;
	}

	console.warn(
		`jaynalerts: notifier bundle not found at ${bin}; run \`jaynalerts init\` to build it`,
	);
	hasWarnedAboutMissingNotifier = true;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
