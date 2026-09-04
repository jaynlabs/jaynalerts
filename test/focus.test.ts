import { expect, test } from "bun:test";

import {
	resolveTmuxOrigin,
	tmuxOriginSubtitle,
	tmuxSocketPath,
} from "../src/core/focus.ts";

const SEP = "\u001f";

test("captures the exact tmux client for a pane in another session", async () => {
	const pane = ["agent", "@8", "4", "codex", "1"].join(SEP);
	const clients = [
		["/dev/ttys001", "101", "work", "%2"].join(SEP),
		["/dev/ttys002", "202", "agent", "%42"].join(SEP),
	].join("\n");
	const result = await resolveTmuxOrigin(
		{
			TMUX: "/tmp/tmux-501/default,900,0",
			TMUX_PANE: "%42",
		},
		async (argv) => (argv.includes("list-clients") ? clients : pane),
	);

	expect(result).not.toBeNull();
	expect(result?.active).toBe(false);
	expect(result?.origin).toEqual({
		socketPath: "/tmp/tmux-501/default",
		paneId: "%42",
		sessionName: "agent",
		windowId: "@8",
		windowIndex: "4",
		windowName: "codex",
		paneIndex: "1",
		clientTty: "/dev/ttys002",
		clientPid: 202,
		originKey: "tmux:/tmp/tmux-501/default:%42",
	});
	expect(
		tmuxOriginSubtitle(result?.origin as NonNullable<typeof result>["origin"]),
	).toBe("tmux · agent:4.1 · codex");
});

test("a sole client showing the origin pane is focused", async () => {
	const pane = ["agent", "@8", "4", "codex", "1"].join(SEP);
	const clients = ["/dev/ttys002", "202", "agent", "%42"].join(SEP);
	const result = await resolveTmuxOrigin(
		{ TMUX: "/tmp/tmux,900,0", TMUX_PANE: "%42" },
		async (argv) => (argv.includes("list-clients") ? clients : pane),
	);

	expect(result?.active).toBe(true);
});

test("a different active pane remains routable but is not focused", async () => {
	const pane = ["agent", "@8", "4", "codex", "1"].join(SEP);
	const clients = ["/dev/ttys002", "202", "agent", "%99"].join(SEP);
	const result = await resolveTmuxOrigin(
		{ TMUX: "/tmp/tmux,900,0", TMUX_PANE: "%42" },
		async (argv) => (argv.includes("list-clients") ? clients : pane),
	);

	expect(result?.active).toBe(false);
	expect(result?.origin.clientTty).toBe("/dev/ttys002");
});

test("ambiguous clients are kept sticky and are not guessed", async () => {
	const pane = ["agent", "@8", "4", "codex", "1"].join(SEP);
	const clients = [
		["/dev/ttys002", "202", "agent", "%42"].join(SEP),
		["/dev/ttys003", "303", "agent", "%42"].join(SEP),
	].join("\n");
	const result = await resolveTmuxOrigin(
		{ TMUX: "/tmp/tmux,900,0", TMUX_PANE: "%42" },
		async (argv) => (argv.includes("list-clients") ? clients : pane),
	);

	expect(result?.active).toBe(false);
	expect(result?.origin.clientTty).toBeUndefined();
});

test("parses a tmux socket path containing commas", () => {
	expect(tmuxSocketPath("/tmp/tmux,custom/default,123,4")).toBe(
		"/tmp/tmux,custom/default",
	);
});
