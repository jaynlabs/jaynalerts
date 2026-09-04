import { access } from "node:fs/promises";
import { resolvePaths } from "./paths.ts";

const HELPER_TIMEOUT_MS = 250;
const TMUX_FIELD_SEPARATOR = "\u001f";
let helperPathCache: string | null | undefined;
let hostBundleCache: string | null | undefined;
const infoCache = new Map<string, BundleInfo>();

export type FocusResult = {
	focused: boolean;
	hostBundleId: string | null;
};

export type TmuxOrigin = {
	socketPath?: string;
	paneId: string;
	sessionName?: string;
	windowId?: string;
	windowIndex?: string;
	windowName?: string;
	paneIndex?: string;
	clientTty?: string;
	clientPid?: number;
	originKey: string;
};

export type NotificationContext = FocusResult & {
	tmuxOrigin: TmuxOrigin | null;
};

export type BundleInfo = {
	name: string | null;
	iconPath: string | null;
};

type TmuxClient = {
	tty: string;
	pid?: number;
	sessionName: string;
	paneId: string;
};

export type ResolvedTmuxOrigin = {
	origin: TmuxOrigin;
	active: boolean;
	hostClientPid?: number;
};

type CommandRunner = (
	argv: string[],
	timeoutMs: number,
) => Promise<string | null>;

export async function getBundleInfo(bundleId: string): Promise<BundleInfo> {
	const cached = infoCache.get(bundleId);
	if (cached !== undefined) {
		return cached;
	}

	const helper = await resolveHelper();
	if (helper === null) {
		const fallback: BundleInfo = { name: null, iconPath: null };
		infoCache.set(bundleId, fallback);
		return fallback;
	}

	const raw = await runRaw([helper, "info", bundleId], HELPER_TIMEOUT_MS);
	const [nameRaw = "", iconRaw = ""] = (raw ?? "").split("\n");
	const result: BundleInfo = {
		name: nameRaw.trim() === "" ? null : nameRaw.trim(),
		iconPath: iconRaw.trim() === "" ? null : iconRaw.trim(),
	};
	infoCache.set(bundleId, result);
	return result;
}

async function runRaw(
	argv: string[],
	timeoutMs: number,
): Promise<string | null> {
	const abortController = new AbortController();
	const timeout = setTimeout(() => abortController.abort(), timeoutMs);

	try {
		const proc = Bun.spawn(argv, {
			stdout: "pipe",
			stderr: "ignore",
			signal: abortController.signal,
		});
		const [stdout, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			proc.exited,
		]);
		if (exitCode !== 0) return null;
		return stdout;
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

export async function resolveNotificationContext(
	env: NodeJS.ProcessEnv = process.env,
): Promise<NotificationContext> {
	const [tmux, front] = await Promise.all([
		resolveTmuxOrigin(env),
		getFrontmostBundleId(),
	]);
	const host = await getHostBundleId(tmux?.hostClientPid);
	const hostIsFrontmost = host !== null && front !== null && host === front;
	const focused = hostIsFrontmost && (tmux === null || tmux.active);

	return {
		focused,
		hostBundleId: host,
		tmuxOrigin: tmux?.origin ?? null,
	};
}

export async function isTerminalFocused(): Promise<FocusResult> {
	const context = await resolveNotificationContext();
	return { focused: context.focused, hostBundleId: context.hostBundleId };
}

export async function resolveTmuxOrigin(
	env: NodeJS.ProcessEnv = process.env,
	runner: CommandRunner = runProcess,
): Promise<ResolvedTmuxOrigin | null> {
	const paneId = env.TMUX_PANE;
	if (paneId === undefined || paneId === "") {
		return null;
	}

	const socketPath = tmuxSocketPath(env.TMUX);
	const tmux = ["tmux", ...(socketPath ? ["-S", socketPath] : [])];
	const paneFormat = [
		"#{session_name}",
		"#{window_id}",
		"#{window_index}",
		"#{window_name}",
		"#{pane_index}",
	].join(TMUX_FIELD_SEPARATOR);
	const clientFormat = [
		"#{client_tty}",
		"#{client_pid}",
		"#{client_session}",
		"#{pane_id}",
	].join(TMUX_FIELD_SEPARATOR);

	const [paneRaw, clientsRaw] = await Promise.all([
		runner(
			[...tmux, "display-message", "-p", "-t", paneId, paneFormat],
			HELPER_TIMEOUT_MS,
		),
		runner([...tmux, "list-clients", "-F", clientFormat], HELPER_TIMEOUT_MS),
	]);

	const [sessionName, windowId, windowIndex, windowName, paneIndex] =
		paneRaw?.split(TMUX_FIELD_SEPARATOR) ?? [];
	const clients = parseTmuxClients(clientsRaw);
	const paneClients = clients.filter((client) => client.paneId === paneId);
	const sessionClients = sessionName
		? clients.filter((client) => client.sessionName === sessionName)
		: [];
	const client =
		paneClients.length === 1
			? paneClients[0]
			: sessionClients.length === 1
				? sessionClients[0]
				: undefined;
	const hostClientPid = client?.pid ?? sessionClients[0]?.pid;

	return {
		active: clients.length === 1 && paneClients.length === 1,
		hostClientPid,
		origin: {
			...(socketPath ? { socketPath } : {}),
			paneId,
			...(sessionName ? { sessionName } : {}),
			...(windowId ? { windowId } : {}),
			...(windowIndex ? { windowIndex } : {}),
			...(windowName ? { windowName } : {}),
			...(paneIndex ? { paneIndex } : {}),
			...(client?.tty ? { clientTty: client.tty } : {}),
			...(client?.pid ? { clientPid: client.pid } : {}),
			originKey: `tmux:${socketPath ?? "default"}:${paneId}`,
		},
	};
}

export function tmuxOriginSubtitle(origin: TmuxOrigin): string {
	let location = origin.sessionName ?? origin.paneId;
	if (origin.windowIndex !== undefined) {
		location += `:${origin.windowIndex}`;
	}
	if (origin.paneIndex !== undefined) {
		location += `.${origin.paneIndex}`;
	}
	if (origin.windowName !== undefined && origin.windowName !== "") {
		location += ` · ${origin.windowName}`;
	}
	return `tmux · ${location}`;
}

export function tmuxSocketPath(value: string | undefined): string | undefined {
	if (value === undefined || value === "") {
		return undefined;
	}
	const match = /^(.*),\d+,\d+$/.exec(value);
	return match?.[1] || undefined;
}

function parseTmuxClients(raw: string | null): TmuxClient[] {
	if (raw === null) {
		return [];
	}

	return raw
		.split("\n")
		.map((line) => {
			const [tty, pidRaw, sessionName, paneId] =
				line.split(TMUX_FIELD_SEPARATOR);
			if (!tty || !sessionName || !paneId) return null;
			const parsedPid = Number.parseInt(pidRaw ?? "", 10);
			return {
				tty,
				...(Number.isFinite(parsedPid) && parsedPid > 0
					? { pid: parsedPid }
					: {}),
				sessionName,
				paneId,
			};
		})
		.filter((client): client is TmuxClient => client !== null);
}

export async function getHostBundleId(
	tmuxClientPid?: number,
): Promise<string | null> {
	if (hostBundleCache !== undefined) {
		return hostBundleCache;
	}

	const helper = await resolveHelper();
	if (helper === null) {
		hostBundleCache = null;
		return null;
	}

	const direct = await runHelper([helper, "host", String(process.pid)]);
	if (direct !== null) {
		hostBundleCache = direct;
		return direct;
	}

	if (tmuxClientPid !== undefined) {
		const viaTmux = await runHelper([helper, "host", String(tmuxClientPid)]);
		if (viaTmux !== null) {
			hostBundleCache = viaTmux;
			return viaTmux;
		}
	}

	hostBundleCache = null;
	return null;
}

async function getFrontmostBundleId(): Promise<string | null> {
	const helper = await resolveHelper();
	if (helper === null) {
		return null;
	}
	return runHelper([helper, "frontmost"]);
}

async function resolveHelper(): Promise<string | null> {
	if (helperPathCache !== undefined) {
		return helperPathCache;
	}

	const bin = resolvePaths().bundleIdBin;

	try {
		await access(bin);
		helperPathCache = bin;
	} catch {
		helperPathCache = null;
	}

	return helperPathCache;
}

async function runHelper(argv: string[]): Promise<string | null> {
	return runProcess(argv, HELPER_TIMEOUT_MS);
}

async function runProcess(
	argv: string[],
	timeoutMs: number,
): Promise<string | null> {
	const raw = await runRaw(argv, timeoutMs);
	const value = raw?.trim() ?? "";
	return value === "" ? null : value;
}
