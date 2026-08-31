import AppKit
import Foundation
import UserNotifications

let WATCHDOG_SECONDS: TimeInterval = 4 * 3600
let PANE_POLL_INTERVAL: TimeInterval = 1.0

var title = ""
var subtitle: String?
var body = ""
var iconPath: String?
var soundName: String?
var sticky = false
var transientSeconds: Double = 5
var hostBundle: String?
var tmuxPane: String?

var i = 1
let args = CommandLine.arguments
while i < args.count {
	let a = args[i]
	let next = { (offset: Int) -> String? in
		i + offset < args.count ? args[i + offset] : nil
	}
	switch a {
	case "--title":
		title = next(1) ?? ""
		i += 2
	case "--subtitle":
		subtitle = next(1)
		i += 2
	case "--message":
		body = next(1) ?? ""
		i += 2
	case "--icon":
		iconPath = next(1)
		i += 2
	case "--sound":
		soundName = next(1)
		i += 2
	case "--host":
		hostBundle = next(1)
		i += 2
	case "--pane":
		tmuxPane = next(1)
		i += 2
	case "--sticky":
		sticky = true
		i += 1
	case "--transient-seconds":
		if let v = next(1), let d = Double(v) {
			transientSeconds = d
		}
		i += 2
	default:
		i += 1
	}
}

let identifier = UUID().uuidString
let center = UNUserNotificationCenter.current()

func dismissAndExit() {
	center.removeDeliveredNotifications(withIdentifiers: [identifier])
	exit(0)
}

func runTmux(_ args: [String]) {
	let task = Process()
	task.launchPath = "/usr/bin/env"
	task.arguments = ["tmux"] + args
	task.standardOutput = FileHandle.nullDevice
	task.standardError = FileHandle.nullDevice
	try? task.run()
	task.waitUntilExit()
}

func tmuxWindowId(forPane pane: String) -> String? {
	let task = Process()
	task.launchPath = "/usr/bin/env"
	task.arguments = ["tmux", "display", "-p", "-t", pane, "#{window_id}"]
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

final class Watcher {
	let host: String
	let pane: String?
	var timer: DispatchSourceTimer?

	init(host: String, pane: String?) {
		self.host = host
		self.pane = pane
	}

	func onActivation(_ bundleId: String?) {
		guard let bundleId = bundleId else { return }
		if bundleId == host {
			handleHostFrontmost()
		} else {
			stopPolling()
		}
	}

	private func handleHostFrontmost() {
		guard let targetPane = pane else {
			dismissAndExit()
			return
		}
		startPolling(targetPane: targetPane)
	}

	private func startPolling(targetPane: String) {
		if timer != nil { return }
		let t = DispatchSource.makeTimerSource(queue: .main)
		t.schedule(deadline: .now(), repeating: PANE_POLL_INTERVAL)
		t.setEventHandler {
			if let now = currentTmuxPane(), now == targetPane {
				dismissAndExit()
			}
		}
		t.resume()
		timer = t
	}

	private func stopPolling() {
		timer?.cancel()
		timer = nil
	}
}

let watcher: Watcher? = sticky ? hostBundle.map { Watcher(host: $0, pane: tmuxPane) } : nil

final class Delegate: NSObject, UNUserNotificationCenterDelegate {
	let hostBundle: String?
	let tmuxPane: String?

	init(hostBundle: String?, tmuxPane: String?) {
		self.hostBundle = hostBundle
		self.tmuxPane = tmuxPane
	}

	func userNotificationCenter(
		_ center: UNUserNotificationCenter,
		willPresent notification: UNNotification
	) async -> UNNotificationPresentationOptions {
		[.banner, .sound, .list]
	}

	func userNotificationCenter(
		_ center: UNUserNotificationCenter,
		didReceive response: UNNotificationResponse
	) async {
		if let pane = tmuxPane {
			let windowId = tmuxWindowId(forPane: pane)
			if let windowId = windowId {
				runTmux(["select-window", "-t", windowId])
			}
			runTmux(["select-pane", "-t", pane])
		}
		if let bundle = hostBundle,
			let url = NSWorkspace.shared.urlForApplication(
				withBundleIdentifier: bundle
			)
		{
			let config = NSWorkspace.OpenConfiguration()
			config.activates = true
			_ = try? await NSWorkspace.shared.openApplication(
				at: url, configuration: config
			)
		}
		exit(0)
	}
}

let delegate = Delegate(hostBundle: hostBundle, tmuxPane: tmuxPane)
center.delegate = delegate

if watcher != nil {
	NSWorkspace.shared.notificationCenter.addObserver(
		forName: NSWorkspace.didActivateApplicationNotification,
		object: nil,
		queue: .main
	) { note in
		let app = note.userInfo?[NSWorkspace.applicationUserInfoKey]
			as? NSRunningApplication
		watcher?.onActivation(app?.bundleIdentifier)
	}
}

@MainActor
func postNotification() async {
	do {
		let granted = try await center.requestAuthorization(options: [
			.alert, .sound,
		])
		if !granted {
			FileHandle.standardError.write(Data(
				"jaynalerts-notifier: authorization denied\n".utf8
			))
			exit(2)
		}
	} catch {
		FileHandle.standardError.write(Data(
			"jaynalerts-notifier: \(error)\n".utf8
		))
		exit(2)
	}

	let content = UNMutableNotificationContent()
	content.title = title
	if let subtitle = subtitle, !subtitle.isEmpty {
		content.subtitle = subtitle
	}
	content.body = body
	if let name = soundName {
		content.sound =
			name == "default"
			? .default
			: UNNotificationSound(named: UNNotificationSoundName(name))
	}
	if let iconPath = iconPath, !iconPath.isEmpty {
		let original = URL(fileURLWithPath: iconPath)
		let staged = stageIcon(at: original, identifier: identifier)
		if let staged = staged,
			let attachment = try? UNNotificationAttachment(
				identifier: "icon", url: staged, options: nil
			)
		{
			content.attachments = [attachment]
		}
	}
	if let host = hostBundle {
		content.userInfo = ["hostBundle": host]
	}

	let request = UNNotificationRequest(
		identifier: identifier, content: content, trigger: nil
	)

	do {
		try await center.add(request)
	} catch {
		FileHandle.standardError.write(Data(
			"jaynalerts-notifier: post failed: \(error)\n".utf8
		))
		exit(3)
	}

	if !sticky {
		DispatchQueue.main.asyncAfter(deadline: .now() + transientSeconds) {
			dismissAndExit()
		}
	}

	DispatchQueue.main.asyncAfter(deadline: .now() + WATCHDOG_SECONDS) {
		exit(0)
	}
}

func stageIcon(at source: URL, identifier: String) -> URL? {
	let tmp = FileManager.default.temporaryDirectory
		.appendingPathComponent(
			"jaynalerts-icon-\(identifier)"
		)
		.appendingPathExtension(source.pathExtension)
	do {
		try? FileManager.default.removeItem(at: tmp)
		try FileManager.default.copyItem(at: source, to: tmp)
		return tmp
	} catch {
		return nil
	}
}

Task { @MainActor in
	await postNotification()
}

RunLoop.main.run()
