export type Source = "claude-code" | "codex" | "ghostty" | "opencode";

export type NotifyUrgency = "transient" | "sticky";

export type NotifyOptions = {
	source?: Source;
	title: string;
	message: string;
	subtitle?: string;
	appIconPath?: string;
	senderBundleId?: string;
	tmuxPane?: string;
	sound?: string;
	urgency: NotifyUrgency;
};
