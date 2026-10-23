import Foundation
import Darwin

// Stable application identity for macOS privacy authorization. The child performs
// only the dedicated QMD refresh job; it never accepts arbitrary commands.
let home = FileManager.default.homeDirectoryForCurrentUser
guard let script = ProcessInfo.processInfo.environment["SOURCE_SEARCH_REFRESH_SCRIPT"], script.hasPrefix("/"),
      let config = ProcessInfo.processInfo.environment["SOURCE_SEARCH_CONFIG_FILE"], config.hasPrefix("/") else {
    FileHandle.standardError.write(Data("Set absolute SOURCE_SEARCH_REFRESH_SCRIPT and SOURCE_SEARCH_CONFIG_FILE paths.\n".utf8))
    exit(2)
}
let child = Process()
child.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
child.arguments = [
    script,
    "--config", config,
    "--state-dir", home.appendingPathComponent(".cache/source-search/qmd-auto-refresh").path
]
child.terminationHandler = { process in exit(process.terminationStatus) }
var handlers: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let handler = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    handler.setEventHandler { if child.isRunning { child.terminate() } else { exit(0) } }
    handler.resume()
    handlers.append(handler)
}
do { try child.run() } catch {
    FileHandle.standardError.write(Data("QMD Auto Refresh could not start: \(error)\n".utf8))
    exit(1)
}
dispatchMain()
