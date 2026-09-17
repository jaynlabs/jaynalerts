import { expect, test } from "bun:test";
import { decideCommandNotification } from "../src/cli/notify-command.ts";
import { DEFAULT_CONFIG } from "../src/core/config.ts";

const shell = DEFAULT_CONFIG.shell;

test("skips empty commands", () => {
	const decision = decideCommandNotification(
		{ cmd: "   ", exit: 0, durationMs: 600_000 },
		shell,
	);
	expect(decision).toEqual({ notify: false, reason: "empty-cmd" });
});

test("skips commands below threshold", () => {
	const decision = decideCommandNotification(
		{ cmd: "make build", exit: 0, durationMs: shell.thresholdMs - 1 },
		shell,
	);
	expect(decision).toEqual({ notify: false, reason: "below-threshold" });
});

test("skips ignored programs (basename match)", () => {
	const decision = decideCommandNotification(
		{ cmd: "/usr/bin/vim foo.txt", exit: 0, durationMs: 5 * 60_000 },
		shell,
	);
	expect(decision).toEqual({ notify: false, reason: "ignored" });
});

test("skips ignored programs through env-assignment prefix", () => {
	const decision = decideCommandNotification(
		{ cmd: "EDITOR=nano LANG=C nano notes.md", exit: 0, durationMs: 60_000 },
		shell,
	);
	expect(decision).toEqual({ notify: false, reason: "ignored" });
});

test("notifies long successful command", () => {
	const decision = decideCommandNotification(
		{ cmd: "make build", exit: 0, durationMs: 20_000 },
		shell,
	);
	expect(decision).toEqual({
		notify: true,
		title: "shell",
		message: "make build — 20s",
	});
});

test("notifies long failing command with exit code", () => {
	const decision = decideCommandNotification(
		{ cmd: "cargo test", exit: 2, durationMs: 90_000 },
		shell,
	);
	expect(decision).toEqual({
		notify: true,
		title: "shell",
		message: "cargo test — failed in 1m 30s (exit 2)",
	});
});

test("custom ignore list overrides defaults", () => {
	const decision = decideCommandNotification(
		{ cmd: "make build", exit: 0, durationMs: 20_000 },
		{ thresholdMs: shell.thresholdMs, ignore: ["make"] },
	);
	expect(decision).toEqual({ notify: false, reason: "ignored" });
});
