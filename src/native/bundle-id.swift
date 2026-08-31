import AppKit
import Foundation

func bundleId(forPid pid: pid_t) -> String? {
	NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
}

func parentPid(_ pid: pid_t) -> pid_t? {
	var info = kinfo_proc()
	var size = MemoryLayout<kinfo_proc>.stride
	var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
	let result = mib.withUnsafeMutableBufferPointer { buf -> Int32 in
		sysctl(buf.baseAddress, u_int(buf.count), &info, &size, nil, 0)
	}
	if result != 0 || size == 0 {
		return nil
	}
	let ppid = info.kp_eproc.e_ppid
	return ppid > 0 ? ppid : nil
}

func hostBundleId(startingFrom pid: pid_t) -> String? {
	var current: pid_t? = pid
	while let p = current {
		if let id = bundleId(forPid: p) {
			return id
		}
		current = parentPid(p)
	}
	return nil
}

func appURL(for bundleID: String) -> URL? {
	NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID)
}

func appName(for bundleID: String) -> String? {
	guard let url = appURL(for: bundleID) else { return nil }
	if let bundle = Bundle(url: url) {
		let info = bundle.infoDictionary ?? [:]
		let localized = bundle.localizedInfoDictionary ?? [:]
		for key in ["CFBundleDisplayName", "CFBundleName"] {
			if let v = localized[key] as? String, !v.isEmpty { return v }
			if let v = info[key] as? String, !v.isEmpty { return v }
		}
	}
	return url.deletingPathExtension().lastPathComponent
}

func iconPath(for bundleID: String) -> String? {
	guard let url = appURL(for: bundleID) else { return nil }
	let fm = FileManager.default
	let resources = url.appendingPathComponent("Contents/Resources")

	if let bundle = Bundle(url: url),
		let raw = bundle.infoDictionary?["CFBundleIconFile"] as? String,
		!raw.isEmpty
	{
		let name = raw.hasSuffix(".icns") ? raw : raw + ".icns"
		let candidate = resources.appendingPathComponent(name)
		if fm.fileExists(atPath: candidate.path) {
			return candidate.path
		}
	}

	let fallback = resources.appendingPathComponent("AppIcon.icns")
	if fm.fileExists(atPath: fallback.path) {
		return fallback.path
	}
	return nil
}

let args = CommandLine.arguments

if args.count >= 2 && args[1] == "frontmost" {
	print(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "")
	exit(0)
}

if args.count >= 3 && args[1] == "host", let pid = pid_t(args[2]) {
	print(hostBundleId(startingFrom: pid) ?? "")
	exit(0)
}

if args.count >= 3 && args[1] == "info" {
	let id = args[2]
	print(appName(for: id) ?? "")
	print(iconPath(for: id) ?? "")
	exit(0)
}

FileHandle.standardError.write(Data(
	"usage: bundle-id frontmost | host <pid> | info <bundle-id>\n".utf8
))
exit(2)
