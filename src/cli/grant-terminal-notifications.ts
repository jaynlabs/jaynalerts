export async function runGrantTerminalNotifications(): Promise<void> {
	const message = "jaynalerts: register this terminal for notifications";
	const ESC = String.fromCharCode(0x1b);
	const BEL = String.fromCharCode(0x07);

	const inner = `${ESC}]9;${message}${BEL}`;
	const inTmux = process.env.TMUX !== undefined;
	const sequence = inTmux ? `${ESC}Ptmux;${ESC}${inner}${ESC}\\` : inner;

	process.stdout.write(sequence);

	const hint = inTmux
		? [
				"",
				"Sent OSC 9 wrapped in tmux DCS passthrough.",
				"If nothing happened, ensure tmux has `set -g allow-passthrough on`",
				"in your tmux.conf (default off in tmux 3.3+).",
			]
		: ["", "Sent OSC 9 to this terminal."];

	console.log(
		[
			...hint,
			"If macOS prompted you to allow notifications, click Allow.",
			"",
			"Verify in System Settings → Notifications: your terminal app should now appear",
			"with notification permission. Repeat from each terminal you use.",
		].join("\n"),
	);
}
