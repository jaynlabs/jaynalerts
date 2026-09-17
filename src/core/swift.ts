// jaynalerts compiles its notifier from Swift on the user's machine at init
// time. Shipping a prebuilt binary would mean Developer ID signing plus
// notarization; local ad-hoc compilation stays the pragmatic choice, but it
// has a hard prerequisite — the Xcode Command Line Tools — and it must say so
// loudly instead of leaving a half-installed setup behind.

export type SwiftToolchain =
	| { ok: true; swiftc: string }
	| { ok: false; problem: SwiftToolchainProblem };

export type SwiftToolchainProblem = {
	summary: string;
	fix: string;
};

let cached: Promise<SwiftToolchain> | null = null;

export async function checkSwiftToolchain(): Promise<SwiftToolchain> {
	cached ??= probeSwiftToolchain();
	return cached;
}

export function swiftToolchainMessage(problem: SwiftToolchainProblem): string {
	return [
		`${problem.summary}`,
		"jaynalerts compiles its notifier from Swift on this machine, so swiftc is required.",
		`Fix: ${problem.fix}`,
		"Then re-run `jaynalerts init`.",
	].join("\n");
}

async function probeSwiftToolchain(): Promise<SwiftToolchain> {
	const developerDir = await activeDeveloperDir();

	if (developerDir === null) {
		return {
			ok: false,
			problem: {
				summary: "Xcode Command Line Tools are not installed.",
				fix: "xcode-select --install",
			},
		};
	}

	const swiftc = Bun.which("swiftc");

	if (swiftc === null) {
		return {
			ok: false,
			problem: {
				summary: `swiftc was not found on PATH (developer dir: ${developerDir}).`,
				fix: "xcode-select --install, or point xcode-select at a toolchain that ships swiftc",
			},
		};
	}

	// A stub /usr/bin/swiftc exists even without a usable toolchain; it fails at
	// invoke time with "invalid active developer path". Compiling nothing is the
	// cheapest way to find out before we commit to a real build.
	const failure = await swiftcSmokeTestFailure(swiftc);

	if (failure !== null) {
		return {
			ok: false,
			problem: {
				summary: `swiftc is present but not usable: ${failure}`,
				fix: "sudo xcode-select --reset, or xcode-select --install",
			},
		};
	}

	return { ok: true, swiftc };
}

async function activeDeveloperDir(): Promise<string | null> {
	try {
		const proc = Bun.spawn(["xcode-select", "-p"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		const [exitCode, stdout] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
		]);
		const path = stdout.trim();
		return exitCode === 0 && path !== "" ? path : null;
	} catch {
		return null;
	}
}

async function swiftcSmokeTestFailure(swiftc: string): Promise<string | null> {
	try {
		const proc = Bun.spawn([swiftc, "--version"], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		const [exitCode, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stderr).text(),
		]);

		if (exitCode === 0) {
			return null;
		}

		const detail = stderr.trim().split("\n")[0] ?? `exit ${exitCode}`;
		return detail;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
