// Derived from OpenWhispr's macos-fast-paste.swift.
// Copyright (c) 2024 OpenWhispr Team. MIT license; see LICENSE in this distribution.
import Cocoa

func report(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value),
       let json = String(data: data, encoding: .utf8) { print(json) }
}

let arguments = CommandLine.arguments
if arguments.count == 2 && arguments[1] == "--frontmost" {
    if let target = NSWorkspace.shared.frontmostApplication {
        report(["pid": target.processIdentifier, "bundleId": target.bundleIdentifier ?? ""])
        exit(0)
    }
    exit(1)
}

guard arguments.count == 4, arguments[1] == "--paste",
      let expectedPID = Int32(arguments[2]), expectedPID > 0 else { exit(1) }
guard AXIsProcessTrusted() else {
    report(["status": "permission-required"])
    exit(2)
}
guard let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: 0x09, keyDown: true),
      let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: 0x09, keyDown: false) else { exit(1) }
guard let target = NSWorkspace.shared.frontmostApplication,
      target.processIdentifier == expectedPID,
      (target.bundleIdentifier ?? "") == arguments[3] else {
    report(["status": "target-changed"])
    exit(3)
}
keyDown.flags = .maskCommand
keyUp.flags = .maskCommand
keyDown.post(tap: .cgSessionEventTap)
usleep(8000)
keyUp.post(tap: .cgSessionEventTap)
report(["status": "dispatched"])
