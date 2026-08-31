import { access } from "node:fs/promises";
import { resolvePaths } from "./paths.ts";

const HELPER_TIMEOUT_MS = 250;
let helperPathCache: string | null | undefined;
let hostBundleCache: string | null | undefined;
const infoCache = new Map<string, BundleInfo>();

export type FocusResult = {
	focused: boolean;
	hostBundleId: string | null;
};

export type BundleInfo = {
	name: string | null;
	iconPath: string | null;
};

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

export async function isTerminalFocused(): Promise<FocusResult> {
	const [host, front] = await Promise.all([
		getHostBundleId(),
		getFrontmostBundleId(),
	]);

	if (host === null || front === null || host !== front) {
		return { focused: false, hostBundleId: host };
	}

	const agentPane = process.env.TMUX_PANE;
	if (agentPane !== undefined && agentPane !== "") {
		const activePane = await currentTmuxPaneId();
		if (activePane !== null && activePane !== agentPane) {
			return { focused: false, hostBundleId: host };
		}
	}

	return { focused: true, hostBundleId: host };
}

async function currentTmuxPaneId(): Promise<string | null> {
	if (!process.env.TMUX) {
		return null;
	}
	return runProcess(["tmux", "display", "-p", "#{pane_id}"], HELPER_TIMEOUT_MS);
}

export async function getHostBundleId(): Promise<string | null> {
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

	const tmuxClientPid = await readTmuxClientPid();
	if (tmuxClientPid !== null) {
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

async function readTmuxClientPid(): Promise<number | null> {
	if (!process.env.TMUX) {
		return null;
	}

	const value = await runProcess(
		["tmux", "display", "-p", "#{client_pid}"],
		HELPER_TIMEOUT_MS,
	);

	if (value === null) {
		return null;
	}

	const pid = Number.parseInt(value, 10);
	return Number.isFinite(pid) && pid > 0 ? pid : null;
}

async function runHelper(argv: string[]): Promise<string | null> {
	return runProcess(argv, HELPER_TIMEOUT_MS);
}

async function runProcess(
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
		const value = stdout.trim();

		if (exitCode !== 0 || value === "") {
			return null;
		}

		return value;
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}
