import { expect, test } from "bun:test";
import JaynAlertsExtension, {
	type PiExtensionApi,
} from "../examples/pi-extension.ts";

type TestEvent =
	| { type: "agent_settled" }
	| {
			kind: "select" | "confirm" | "input" | "editor" | "custom";
			title?: string;
	  };

type TestHandler = (event: TestEvent, ctx: { cwd: string }) => Promise<void>;

test("Pi extension routes settled and prompt events to jaynalerts", async () => {
	const handlers = new Map<string, TestHandler>();
	const calls: Array<{
		command: string;
		args: string[];
		options: { timeout?: number; cwd?: string } | undefined;
	}> = [];
	const pi = {
		on(event: string, handler: TestHandler) {
			handlers.set(event, handler);
		},
		async exec(
			command: string,
			args: string[],
			options?: { timeout?: number; cwd?: string },
		) {
			calls.push({ command, args, options });
			return { code: 0, stderr: "" };
		},
	} as unknown as PiExtensionApi;

	JaynAlertsExtension(pi);
	await handlers.get("agent_settled")?.(
		{ type: "agent_settled" },
		{ cwd: "/work/project" },
	);
	await handlers.get("ui_prompt_start")?.(
		{ kind: "confirm", title: "  Run command?  " },
		{ cwd: "/work/project" },
	);

	expect(calls).toEqual([
		{
			command: "jaynalerts",
			args: ["pi-hook", "on-agent-settled", "--cwd", "/work/project"],
			options: { cwd: "/work/project", timeout: 10_000 },
		},
		{
			command: "jaynalerts",
			args: [
				"pi-hook",
				"on-ui-prompt",
				"--cwd",
				"/work/project",
				"--message",
				"Run command?",
			],
			options: { cwd: "/work/project", timeout: 10_000 },
		},
	]);
});

test("Pi extension describes untitled selection prompts as approvals", async () => {
	let args: string[] = [];
	let promptHandler: TestHandler | undefined;
	const pi = {
		on(event: string, handler: TestHandler) {
			if (event === "ui_prompt_start") promptHandler = handler;
		},
		async exec(_command: string, nextArgs: string[]) {
			args = nextArgs;
			return { code: 0, stderr: "" };
		},
	} as unknown as PiExtensionApi;

	JaynAlertsExtension(pi);
	await promptHandler?.({ kind: "select" }, { cwd: "/work/project" });

	expect(args).toContain("Approval required");
});
