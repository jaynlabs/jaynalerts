export type Source = "claude-code" | "codex" | "ghostty" | "opencode" | "pi";

export type NotifyUrgency = "transient" | "sticky";

export type TmuxNotificationOrigin = {
	socketPath?: string;
	paneId: string;
	sessionName?: string;
	windowId?: string;
	windowIndex?: string;
	windowName?: string;
	paneIndex?: string;
	clientTty?: string;
	originKey: string;
};

export type NotifyOptions = {
	source?: Source;
	title: string;
	message: string;
	subtitle?: string;
	appIconPath?: string;
	senderBundleId?: string;
	tmuxOrigin?: TmuxNotificationOrigin;
	tmuxZoomOnClick?: boolean;
	sound?: string;
	urgency: NotifyUrgency;
};
