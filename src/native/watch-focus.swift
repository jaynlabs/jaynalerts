import AppKit
import Foundation

let WATCHDOG_SECONDS: TimeInterval = 4 * 3600
let PANE_POLL_INTERVAL: TimeInterval = 1.0

var groupId: String?
var hostBundleId: String?
var tmuxPane: String?

var i = 1
let args = CommandLine.arguments
while i < args.count {
	let a = args[i]
	if a == "--group", i + 1 < args.count {
		groupId = args[i + 1]
		i += 2
		continue
	}
	if a == "--host", i + 1 < args.count {
		hostBundleId = args[i + 1]
		i += 2
		continue
	}
	if a == "--pane", i + 1 < args.count {
		tmuxPane = args[i + 1]
		i += 2
		continue
	}
	i += 1
}

guard let group = groupId, let host = hostBundleId else {
	FileHandle.standardError.write(Data(
		"usage: watch-focus --group <id> --host <bundle> [--pane <pane_id>]\n".utf8
	))
	exit(2)
}

func runAlerterRemove() {
	let task = Process()
	task.launchPath = "/usr/bin/env"
	task.arguments = ["alerter", "--remove", group]
	task.standardOutput = FileHandle.nullDevice
	task.standardError = FileHandle.nullDevice
	do {
		try task.run()
		task.waitUntilExit()
	} catch {
		// best-effort: if alerter is missing, exit anyway
	}
	exit(0)
}

func currentTmuxPane() -> String? {
	let task = Process()
	task.launchPath = "/usr/bin/env"
	task.arguments = ["tmux", "display", "-p", "#{pane_id}"]
	let pipe = Pipe()
	task.standardOutput = pipe
	task.standardError = FileHandle.nullDevice
	do {
		try task.run()
		task.waitUntilExit()
	} catch {
		return nil
	}
	let data = pipe.fileHandleForReading.readDataToEndOfFile()
	let out = String(data: data, encoding: .utf8)?
		.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
	return out.isEmpty ? nil : out
}

var paneTimer: DispatchSourceTimer?

func stopPolling() {
	paneTimer?.cancel()
	paneTimer = nil
}

func startPolling(targetPane: String) {
	if paneTimer != nil { return }
	let t = DispatchSource.makeTimerSource(queue: .main)
	t.schedule(deadline: .now(), repeating: PANE_POLL_INTERVAL)
	t.setEventHandler {
		if let now = currentTmuxPane(), now == targetPane {
			runAlerterRemove()
		}
	}
	t.resume()
	paneTimer = t
}

func handleHostFrontmost() {
	if let pane = tmuxPane {
		startPolling(targetPane: pane)
	} else {
		runAlerterRemove()
	}
}

func handleHostNotFrontmost() {
	stopPolling()
}

NSWorkspace.shared.notificationCenter.addObserver(
	forName: NSWorkspace.didActivateApplicationNotification,
	object: nil,
	queue: .main
) { note in
	guard
		let app = note.userInfo?[NSWorkspace.applicationUserInfoKey]
			as? NSRunningApplication
	else { return }
	if app.bundleIdentifier == host {
		handleHostFrontmost()
	} else {
		handleHostNotFrontmost()
	}
}

if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == host {
	handleHostFrontmost()
}

DispatchQueue.main.asyncAfter(deadline: .now() + WATCHDOG_SECONDS) {
	exit(0)
}

RunLoop.main.run()
