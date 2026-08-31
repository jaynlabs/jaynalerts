import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { macosNotifier } from "../src/core/notify/macos.ts";

const originalSpawn = Bun.spawn;
const originalWarn = console.warn;
const originalHome = process.env.JAYNALERTS_HOME;

let notifierBin: string;

beforeEach(async () => {
	const home = await mkdtemp(join(tmpdir(), "jaynalerts-macos-"));
	process.env.JAYNALERTS_HOME = home;
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
