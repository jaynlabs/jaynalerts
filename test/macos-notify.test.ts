import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { macosNotifier } from "../src/core/notify/macos.ts";

const originalSpawn = Bun.spawn;
const originalWarn = console.warn;
const originalHome = process.env.JAYNALERTS_HOME;
const originalDebug = process.env.JAYNALERTS_DEBUG;

let notifierBin: string;

beforeEach(async () => {
	const home = await mkdtemp(join(tmpdir(), "jaynalerts-macos-"));
	process.env.JAYNALERTS_HOME = home;
	delete process.env.JAYNALERTS_DEBUG;
	notifierBin = join(
		home,
		"Applications",
		"JaynAlertsNotifier.app",
		"Contents",
		"MacOS",
		"JaynAlertsNotifier",
	);
	await mkdir(dirname(notifierBin), { recursive: true });
	await writeFile(notifierBin, "");
});

afterEach(() => {
	Bun.spawn = originalSpawn;
	console.warn = originalWarn;
	if (originalHome === undefined) {
		delete process.env.JAYNALERTS_HOME;
	} else {
		process.env.JAYNALERTS_HOME = originalHome;
	}
	if (originalDebug === undefined) {
		delete process.env.JAYNALERTS_DEBUG;
	} else {
		process.env.JAYNALERTS_DEBUG = originalDebug;
	}
});

test("macOS notifier spawns the bundle binary for transient alerts", async () => {
	let argv: string[] | undefined;
	let didUnref = false;

	Bun.spawn = ((command: string[]) => {
		argv = command;
		return {
			unref() {
				didUnref = true;
			},
		};
	}) as typeof Bun.spawn;

	await macosNotifier.notify({
		message: "hello",
		sound: "Glass",
		title: "jaynalerts",
		urgency: "transient",
	});

	expect(argv).toEqual([
		notifierBin,
		"--title",
		"jaynalerts",
		"--message",
		"hello",
		"--sound",
		"Glass",
		"--transient-seconds",
		"5",
	]);
	expect(didUnref).toBe(true);
});

test("macOS notifier sends sticky alerts with --sticky and forwards host/icon", async () => {
	let argv: string[] | undefined;

	Bun.spawn = ((command: string[]) => {
		argv = command;
		return { unref() {} };
	}) as typeof Bun.spawn;

	await macosNotifier.notify({
		message: "world",
		title: "jaynalerts",
		urgency: "sticky",
		senderBundleId: "com.example.term",
		appIconPath: "/tmp/icon.png",
		subtitle: "ctx",
		tmuxOrigin: {
			socketPath: "/tmp/tmux-501/default",
			paneId: "%42",
			sessionName: "agent",
			windowId: "@8",
			windowIndex: "4",
			windowName: "codex",
			paneIndex: "1",
			clientTty: "/dev/ttys002",
			originKey: "tmux:/tmp/tmux-501/default:%42",
		},
		tmuxZoomOnClick: true,
	});

	expect(argv).toEqual([
		notifierBin,
		"--title",
		"jaynalerts",
		"--message",
		"world",
		"--subtitle",
		"ctx",
		"--icon",
		"/tmp/icon.png",
		"--host",
		"com.example.term",
		"--pane",
		"%42",
		"--tmux-socket",
		"/tmp/tmux-501/default",
		"--tmux-client",
		"/dev/ttys002",
		"--tmux-session",
		"agent",
		"--tmux-window",
		"@8",
		"--tmux-window-index",
		"4",
		"--tmux-window-name",
		"codex",
		"--tmux-pane-index",
		"1",
		"--origin-key",
		"tmux:/tmp/tmux-501/default:%42",
		"--zoom-on-click",
		"--sticky",
	]);
});

test("macOS notifier warns once when the bundle binary is missing", async () => {
	process.env.JAYNALERTS_HOME = await mkdtemp(
		join(tmpdir(), "jaynalerts-missing-"),
	);
	const warnings: string[] = [];
	console.warn = (message?: unknown) => {
		warnings.push(String(message));
	};

	const opts = {
		message: "hello",
		title: "jaynalerts",
		urgency: "sticky" as const,
	};

	await macosNotifier.notify(opts);
	await macosNotifier.notify(opts);

	expect(warnings.length).toBe(1);
	expect(warnings[0]).toContain("notifier bundle not found");
});
