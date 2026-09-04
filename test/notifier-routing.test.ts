import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// These tests drive the compiled Swift notifier through its click-routing
// diagnostics (`--print-origin`, `--route`) against a stub tmux on PATH, so
// they cover the code a real notification click runs.
const BUILD_TIMEOUT_MS = 60_000;
const hasSwiftc = Bun.which("swiftc") !== null;
const swiftTest = hasSwiftc ? test : test.skip;

const GHOSTTY = "com.mitchellh.ghostty";
const temporaryDirs: string[] = [];

let notifierBin: string;
let stubDir: string;

type StubEnv = {
	JN_TMUX_LOG: string;
	JN_DEAD_PANES?: string;
	JN_ZOOM_STATE?: string;
	JN_FAIL_SWITCH?: string;
};

beforeAll(async () => {
	if (!hasSwiftc) return;

	const dir = await mkdtemp(join(tmpdir(), "jaynalerts-routing-"));
	temporaryDirs.push(dir);
	notifierBin = join(dir, "JaynAlertsNotifier");
	stubDir = join(dir, "bin");

	const build = Bun.spawn(
		["swiftc", "-o", notifierBin, "src/native/notifier.swift"],
		{ stderr: "pipe", stdout: "ignore" },
	);
	const [exitCode, stderr] = await Promise.all([
		build.exited,
		new Response(build.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`swiftc failed: ${stderr}`);
	}

	await Bun.write(join(stubDir, "tmux"), STUB_TMUX);
	await chmod(join(stubDir, "tmux"), 0o755);
}, BUILD_TIMEOUT_MS);

swiftTest("a notification carries its whole origin", async () => {
	const origin = await printOrigin();

	expect(origin).toEqual({
		originVersion: 1,
		hostBundle: GHOSTTY,
		tmuxSocket: "/tmp/tmux-501/default",
		tmuxPane: "%42",
		tmuxClient: "/dev/ttys002",
		tmuxSession: "agent",
		tmuxWindow: "@8",
		tmuxWindowIndex: "4",
		tmuxWindowName: "codex",
		tmuxPaneIndex: "1",
		originKey: "tmux:/tmp/tmux-501/default:%42",
		zoomOnClick: true,
	});
});

swiftTest(
	"clicking switches the captured client to the exact pane",
	async () => {
		const commands = await route(await printOrigin());

		expect(commands).toEqual([
			"-S /tmp/tmux-501/default display-message -p -t %42 #{pane_id}",
			"-S /tmp/tmux-501/default switch-client -Z -c /dev/ttys002 -t %42",
			"-S /tmp/tmux-501/default display-message -p -t %42 #{window_zoomed_flag} #{window_panes}",
			"-S /tmp/tmux-501/default resize-pane -Z -t %42",
		]);
	},
);

swiftTest("concurrent notifications each route to their own pane", async () => {
	const first = await route(
		await printOrigin({ pane: "%42", client: "/dev/ttys002" }),
	);
	const second = await route(
		await printOrigin({ pane: "%7", client: "/dev/ttys009" }),
	);

	expect(first).toContain(
		"-S /tmp/tmux-501/default switch-client -Z -c /dev/ttys002 -t %42",
	);
	expect(first.join("\n")).not.toContain("%7");
	expect(second).toContain(
		"-S /tmp/tmux-501/default switch-client -Z -c /dev/ttys009 -t %7",
	);
	expect(second.join("\n")).not.toContain("%42");
});

swiftTest("a dead pane routes nowhere at all", async () => {
	const commands = await route(await printOrigin(), { JN_DEAD_PANES: "%42" });

	expect(commands).toEqual([
		"-S /tmp/tmux-501/default display-message -p -t %42 #{pane_id}",
	]);
});

swiftTest(
	"a detached client falls back to the pane's own session",
	async () => {
		const commands = await route(await printOrigin(), { JN_FAIL_SWITCH: "1" });

		expect(commands).toContain("-S /tmp/tmux-501/default select-window -t %42");
		expect(commands).toContain("-S /tmp/tmux-501/default select-pane -t %42");
	},
);

swiftTest("zoom-on-click leaves an already zoomed window alone", async () => {
	const commands = await route(await printOrigin(), { JN_ZOOM_STATE: "1 2" });

	expect(commands.join("\n")).not.toContain("resize-pane");
});

swiftTest("zoom-on-click leaves an unsplit window alone", async () => {
	const commands = await route(await printOrigin(), { JN_ZOOM_STATE: "0 1" });

	expect(commands.join("\n")).not.toContain("resize-pane");
});

swiftTest("routing without zoom-on-click never resizes", async () => {
	const commands = await route(await printOrigin({ zoomOnClick: false }));

	expect(commands.join("\n")).not.toContain("resize-pane");
	expect(commands).toContain(
		"-S /tmp/tmux-501/default switch-client -Z -c /dev/ttys002 -t %42",
	);
});

async function printOrigin(
	opts: { pane?: string; client?: string; zoomOnClick?: boolean } = {},
): Promise<Record<string, unknown>> {
	const argv = [
		notifierBin,
		"--print-origin",
		"--host",
		GHOSTTY,
		"--pane",
		opts.pane ?? "%42",
		"--tmux-socket",
		"/tmp/tmux-501/default",
		"--tmux-client",
		opts.client ?? "/dev/ttys002",
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
		`tmux:/tmp/tmux-501/default:${opts.pane ?? "%42"}`,
		...(opts.zoomOnClick === false ? [] : ["--zoom-on-click"]),
	];

	const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
	const [exitCode, stdout] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
	]);
	expect(exitCode).toBe(0);
	return JSON.parse(stdout) as Record<string, unknown>;
}

async function route(
	origin: Record<string, unknown>,
	stub: Omit<StubEnv, "JN_TMUX_LOG"> = {},
): Promise<string[]> {
	await rm(logPath(), { force: true });
	await writeFile(logPath(), "");

	const proc = Bun.spawn([notifierBin, "--route", JSON.stringify(origin)], {
		stdout: "ignore",
		stderr: "ignore",
		env: {
			...process.env,
			PATH: `${stubDir}:${process.env.PATH ?? ""}`,
			JN_ZOOM_STATE: "0 2",
			...stub,
			JN_TMUX_LOG: logPath(),
		},
	});
	expect(await proc.exited).toBe(0);

	const log = await readFile(logPath(), "utf8");
	return log.split("\n").filter((line) => line !== "");
}

function logPath(): string {
	return join(stubDir, "tmux.log");
}

afterAll(async () => {
	for (const dir of temporaryDirs.splice(0)) {
		await rm(dir, { force: true, recursive: true });
	}
});

const STUB_TMUX = `#!/bin/bash
# Stub tmux: records every invocation and answers the queries the notifier makes.
echo "$*" >> "$JN_TMUX_LOG"
args=("$@")
if [ "\${args[0]}" = "-S" ]; then args=("\${args[@]:2}"); fi

case "\${args[0]}" in
display-message)
	pane="\${args[3]}"
	case "\${args[@]: -1}" in
	'#{pane_id}')
		for dead in $JN_DEAD_PANES; do
			[ "$dead" = "$pane" ] && exit 1
		done
		echo "$pane"
		;;
	*) echo "$JN_ZOOM_STATE" ;;
	esac
	;;
switch-client)
	[ "$JN_FAIL_SWITCH" = "1" ] && exit 1
	;;
esac
exit 0
`;
