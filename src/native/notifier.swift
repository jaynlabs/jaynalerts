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
var tmuxSocket: String?
var tmuxPane: String?
var tmuxClient: String?
var tmuxSession: String?
var tmuxWindow: String?
var tmuxWindowIndex: String?
var tmuxWindowName: String?
var tmuxPaneIndex: String?
var originKey: String?
var zoomOnClick = false
var reportSettings = false
var reportOrigin = false
var routePayload: String?

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
	case "--tmux-socket":
		tmuxSocket = next(1)
		i += 2
	case "--pane":
		tmuxPane = next(1)
		i += 2
	case "--tmux-client":
		tmuxClient = next(1)
		i += 2
	case "--tmux-session":
		tmuxSession = next(1)
		i += 2
	case "--tmux-window":
		tmuxWindow = next(1)
		i += 2
	case "--tmux-window-index":
		tmuxWindowIndex = next(1)
		i += 2
	case "--tmux-window-name":
		tmuxWindowName = next(1)
		i += 2
	case "--tmux-pane-index":
		tmuxPaneIndex = next(1)
		i += 2
	case "--origin-key":
		originKey = next(1)
		i += 2
	case "--zoom-on-click":
		zoomOnClick = true
		i += 1
	case "--settings":
		reportSettings = true
		i += 1
	case "--print-origin":
		reportOrigin = true
		i += 1
	case "--route":
		routePayload = next(1)
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

// Resolved on demand: UNUserNotificationCenter.current() traps outside an app
// bundle, and the routing diagnostics below deliberately run without one.
var center: UNUserNotificationCenter { .current() }

struct NotificationOrigin {
	let hostBundle: String?
	let tmuxSocket: String?
	let tmuxPane: String?
	let tmuxClient: String?
	let tmuxSession: String?
	let tmuxWindow: String?
	let tmuxWindowIndex: String?
	let tmuxWindowName: String?
	let tmuxPaneIndex: String?
	let originKey: String?
	let zoomOnClick: Bool

	init(
		hostBundle: String? = nil,
		tmuxSocket: String? = nil,
		tmuxPane: String? = nil,
		tmuxClient: String? = nil,
		tmuxSession: String? = nil,
		tmuxWindow: String? = nil,
		tmuxWindowIndex: String? = nil,
		tmuxWindowName: String? = nil,
		tmuxPaneIndex: String? = nil,
		originKey: String? = nil,
		zoomOnClick: Bool = false
	) {
		self.hostBundle = hostBundle
		self.tmuxSocket = tmuxSocket
		self.tmuxPane = tmuxPane
		self.tmuxClient = tmuxClient
		self.tmuxSession = tmuxSession
		self.tmuxWindow = tmuxWindow
		self.tmuxWindowIndex = tmuxWindowIndex
		self.tmuxWindowName = tmuxWindowName
		self.tmuxPaneIndex = tmuxPaneIndex
		self.originKey = originKey
		self.zoomOnClick = zoomOnClick
	}

	init(userInfo: [AnyHashable: Any]) {
		hostBundle = userInfo["hostBundle"] as? String
		tmuxSocket = userInfo["tmuxSocket"] as? String
		tmuxPane = userInfo["tmuxPane"] as? String
		tmuxClient = userInfo["tmuxClient"] as? String
		tmuxSession = userInfo["tmuxSession"] as? String
		tmuxWindow = userInfo["tmuxWindow"] as? String
		tmuxWindowIndex = userInfo["tmuxWindowIndex"] as? String
		tmuxWindowName = userInfo["tmuxWindowName"] as? String
		tmuxPaneIndex = userInfo["tmuxPaneIndex"] as? String
		originKey = userInfo["originKey"] as? String
		zoomOnClick = (userInfo["zoomOnClick"] as? NSNumber)?.boolValue ?? false
	}

	func userInfo() -> [AnyHashable: Any] {
		var info: [AnyHashable: Any] = [
			"originVersion": 1,
			"zoomOnClick": zoomOnClick,
		]
		if let hostBundle { info["hostBundle"] = hostBundle }
		if let tmuxSocket { info["tmuxSocket"] = tmuxSocket }
		if let tmuxPane { info["tmuxPane"] = tmuxPane }
		if let tmuxClient { info["tmuxClient"] = tmuxClient }
		if let tmuxSession { info["tmuxSession"] = tmuxSession }
		if let tmuxWindow { info["tmuxWindow"] = tmuxWindow }
		if let tmuxWindowIndex { info["tmuxWindowIndex"] = tmuxWindowIndex }
		if let tmuxWindowName { info["tmuxWindowName"] = tmuxWindowName }
		if let tmuxPaneIndex { info["tmuxPaneIndex"] = tmuxPaneIndex }
		if let originKey { info["originKey"] = originKey }
		return info
	}
}

let argumentOrigin = NotificationOrigin(
	hostBundle: hostBundle,
	tmuxSocket: tmuxSocket,
	tmuxPane: tmuxPane,
	tmuxClient: tmuxClient,
	tmuxSession: tmuxSession,
	tmuxWindow: tmuxWindow,
	tmuxWindowIndex: tmuxWindowIndex,
	tmuxWindowName: tmuxWindowName,
	tmuxPaneIndex: tmuxPaneIndex,
	originKey: originKey,
	zoomOnClick: zoomOnClick
)

func dismissAndExit() {
	center.removeDeliveredNotifications(withIdentifiers: [identifier])
	exit(0)
}

func tmuxArguments(socket: String?, command: [String]) -> [String] {
	["tmux"] + (socket.map { ["-S", $0] } ?? []) + command
}

@discardableResult
func runTmux(_ command: [String], socket: String?) -> Bool {
	let task = Process()
	task.launchPath = "/usr/bin/env"
	task.arguments = tmuxArguments(socket: socket, command: command)
	task.standardOutput = FileHandle.nullDevice
	task.standardError = FileHandle.nullDevice
	do {
		try task.run()
		task.waitUntilExit()
		return task.terminationStatus == 0
	} catch {
		return false
	}
}

func readTmux(_ command: [String], socket: String?) -> String? {
	let task = Process()
	task.launchPath = "/usr/bin/env"
	task.arguments = tmuxArguments(socket: socket, command: command)
	let pipe = Pipe()
	task.standardOutput = pipe
	task.standardError = FileHandle.nullDevice
	do {
		try task.run()
		task.waitUntilExit()
	} catch {
		return nil
	}
	guard task.terminationStatus == 0 else { return nil }
	let data = pipe.fileHandleForReading.readDataToEndOfFile()
	let out = String(data: data, encoding: .utf8)?
		.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
	return out.isEmpty ? nil : out
}

func currentTmuxPane(origin: NotificationOrigin) -> String? {
	guard let client = origin.tmuxClient else { return nil }
	let separator = "\u{1F}"
	guard
		let clients = readTmux(
			[
				"list-clients", "-F",
				"#{client_tty}\(separator)#{pane_id}",
			],
			socket: origin.tmuxSocket
		)
	else { return nil }
	for line in clients.split(separator: "\n") {
		let fields = line.split(separator: Character(separator), maxSplits: 1)
		if fields.count == 2, String(fields[0]) == client {
			return String(fields[1])
		}
	}
	return nil
}

func ensurePaneZoomed(origin: NotificationOrigin) {
	guard origin.zoomOnClick, let pane = origin.tmuxPane else { return }
	guard
		let state = readTmux(
			[
				"display-message", "-p", "-t", pane,
				"#{window_zoomed_flag} #{window_panes}",
			],
			socket: origin.tmuxSocket
		)
	else { return }
	let fields = state.split(separator: " ")
	guard fields.count == 2 else { return }
	let isZoomed = fields[0] == "1"
	let paneCount = Int(fields[1]) ?? 1
	if !isZoomed && paneCount > 1 {
		runTmux(["resize-pane", "-Z", "-t", pane], socket: origin.tmuxSocket)
	}
}

func paneIsAlive(_ origin: NotificationOrigin) -> Bool {
	guard let pane = origin.tmuxPane else { return false }
	return readTmux(
		["display-message", "-p", "-t", pane, "#{pane_id}"],
		socket: origin.tmuxSocket
	) == pane
}

func routeToTmuxOrigin(_ origin: NotificationOrigin) {
	guard let pane = origin.tmuxPane else { return }
	// If the pane is gone, stop here instead of letting tmux resolve the stale
	// target to whatever session happens to be current.
	guard paneIsAlive(origin) else { return }
	var switched = false
	if let client = origin.tmuxClient {
		switched = runTmux(
			["switch-client", "-Z", "-c", client, "-t", pane],
			socket: origin.tmuxSocket
		)
	}
	if !switched {
		_ = runTmux(["select-window", "-t", pane], socket: origin.tmuxSocket)
		_ = runTmux(["select-pane", "-t", pane], socket: origin.tmuxSocket)
	}
	ensurePaneZoomed(origin: origin)
}

// Internal diagnostics: --print-origin dumps the payload a notification would
// carry, --route replays one exactly as clicking that notification does.
if reportOrigin {
	guard
		let data = try? JSONSerialization.data(
			withJSONObject: argumentOrigin.userInfo(), options: [.sortedKeys]
		),
		let output = String(data: data, encoding: .utf8)
	else { exit(4) }
	print(output)
	exit(0)
}

if let routePayload {
	guard let data = routePayload.data(using: .utf8),
		let userInfo = try? JSONSerialization.jsonObject(with: data)
			as? [AnyHashable: Any]
	else { exit(4) }
	routeToTmuxOrigin(NotificationOrigin(userInfo: userInfo))
	exit(0)
}

final class Watcher {
	let origin: NotificationOrigin
	var timer: DispatchSourceTimer?

	init(origin: NotificationOrigin) {
		self.origin = origin
	}

	func onActivation(_ bundleId: String?) {
		guard let bundleId, let host = origin.hostBundle else { return }
		if bundleId == host {
			handleHostFrontmost()
		} else {
			stopPolling()
		}
	}

	private func handleHostFrontmost() {
		guard let targetPane = origin.tmuxPane else {
			dismissAndExit()
			return
		}
		guard origin.tmuxClient != nil else { return }
		startPolling(targetPane: targetPane)
	}

	private func startPolling(targetPane: String) {
		if timer != nil { return }
		let timer = DispatchSource.makeTimerSource(queue: .main)
		timer.schedule(deadline: .now(), repeating: PANE_POLL_INTERVAL)
		timer.setEventHandler { [origin] in
			if currentTmuxPane(origin: origin) == targetPane {
				dismissAndExit()
			}
		}
		timer.resume()
		self.timer = timer
	}

	private func stopPolling() {
		timer?.cancel()
		timer = nil
	}
}

let watcher: Watcher? = sticky && hostBundle != nil
	? Watcher(origin: argumentOrigin)
	: nil

final class Delegate: NSObject, UNUserNotificationCenterDelegate {
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
		let origin = NotificationOrigin(
			userInfo: response.notification.request.content.userInfo
		)
		routeToTmuxOrigin(origin)
		if let bundle = origin.hostBundle,
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

let delegate = Delegate()
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

func authorizationDescription(_ rawValue: Int) -> String {
	switch rawValue {
	case 0: return "notDetermined"
	case 1: return "denied"
	case 2: return "authorized"
	case 3: return "provisional"
	case 4: return "ephemeral"
	default: return "unknown"
	}
}

func alertStyleDescription(_ style: UNAlertStyle) -> String {
	switch style {
	case .none: return "none"
	case .banner: return "temporary"
	case .alert: return "persistent"
	@unknown default: return "unknown"
	}
}

func notificationSettingDescription(_ setting: UNNotificationSetting) -> String {
	switch setting {
	case .notSupported: return "notSupported"
	case .disabled: return "disabled"
	case .enabled: return "enabled"
	@unknown default: return "unknown"
	}
}

@MainActor
func printNotificationSettings() async {
	let settings = await center.notificationSettings()
	let report: [String: Any] = [
		"authorization": authorizationDescription(
			settings.authorizationStatus.rawValue
		),
		"alertStyle": alertStyleDescription(settings.alertStyle),
		"alerts": notificationSettingDescription(settings.alertSetting),
		"requestedAlertStyle": Bundle.main.object(
			forInfoDictionaryKey: "NSUserNotificationAlertStyle"
		) as? String ?? "banner",
	]
	if let data = try? JSONSerialization.data(withJSONObject: report),
		let output = String(data: data, encoding: .utf8)
	{
		print(output)
		exit(0)
	}
	exit(4)
}

func debugLog(_ message: String) {
	guard ProcessInfo.processInfo.environment["JAYNALERTS_DEBUG"] != nil else {
		return
	}
	FileHandle.standardError.write(Data("jaynalerts-notifier: \(message)\n".utf8))
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
	if let subtitle, !subtitle.isEmpty {
		content.subtitle = subtitle
	}
	content.body = body
	if let name = soundName {
		content.sound =
			name == "default"
			? .default
			: UNNotificationSound(named: UNNotificationSoundName(name))
	}
	if let iconPath, !iconPath.isEmpty {
		let original = URL(fileURLWithPath: iconPath)
		let staged = stageIcon(at: original, identifier: identifier)
		if let staged,
			let attachment = try? UNNotificationAttachment(
				identifier: "icon", url: staged, options: nil
			)
		{
			content.attachments = [attachment]
		}
	}
	content.userInfo = argumentOrigin.userInfo()
	if let originKey, !originKey.isEmpty {
		content.threadIdentifier = originKey
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

	debugLog(
		"request=\(identifier) urgency=\(sticky ? "sticky" : "transient") "
			+ "origin=\(originKey ?? "none") pane=\(tmuxPane ?? "none") "
			+ "client=\(tmuxClient ?? "none")"
	)

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
	if reportSettings {
		await printNotificationSettings()
	} else {
		await postNotification()
	}
}

RunLoop.main.run()
