import Foundation
import AVFoundation
import CoreAudio
import AudioToolbox

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}
func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}
func deviceString(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String {
    var p = address(selector); var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &p, 0, nil, &size, &value) == noErr, let value else { return "" }
    return value.takeRetainedValue() as String
}
func translate(_ value: String) -> AudioDeviceID {
    let string = value as CFString
    var uid = Unmanaged.passUnretained(string); var p = address(kAudioHardwarePropertyTranslateUIDToDevice)
    var id: AudioDeviceID = 0; var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    withExtendedLifetime(string) {
        _ = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &p, UInt32(MemoryLayout<Unmanaged<CFString>>.size), &uid, &size, &id)
    }
    return id
}
func devices() -> [[String: Any]] {
    var p = address(kAudioHardwarePropertyDevices); var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &p, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &p, 0, nil, &size, &ids) == noErr else { return [] }
    return ids.compactMap { id in
        var streams = address(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput); var bytes: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &bytes) == noErr, bytes > 0 else { return nil }
        return ["id": id, "uid": deviceString(id, kAudioDevicePropertyDeviceUID), "name": deviceString(id, kAudioObjectPropertyName)]
    }
}
enum RouteError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let s) = self { return s }; return nil }
}
func check(_ code: OSStatus, _ message: String) throws {
    if code != noErr { throw RouteError.message("\(message) (OSStatus \(code))") }
}
final class Router {
    var route: OpaquePointer?; var timer: Timer?
    var lastCaptured: UInt64 = 0, lastOutput: UInt64 = 0
    var lastCaptureTime = Date(), lastOutputTime = Date()
    func stop() {
        timer?.invalidate(); timer = nil
        if let route { sf_route_stop(route) }; route = nil
    }
    func deviceReady(_ id: AudioDeviceID, rate: Double) -> Bool {
        var alive: UInt32 = 0; var size = UInt32(MemoryLayout<UInt32>.size)
        var aliveAddress = address(kAudioDevicePropertyDeviceIsAlive)
        guard AudioObjectGetPropertyData(id, &aliveAddress, 0, nil, &size, &alive) == noErr, alive != 0 else { return false }
        var currentRate = 0.0; size = UInt32(MemoryLayout<Double>.size)
        var rateAddress = address(kAudioDevicePropertyNominalSampleRate)
        return AudioObjectGetPropertyData(id, &rateAddress, 0, nil, &size, &currentRate) == noErr && currentRate == rate
    }
    func start(uid: String) throws {
        stop()
        guard !uid.hasPrefix("SoundFace"), !uid.isEmpty else { throw RouteError.message("这里要选真实的麦克风，不能选 SoundFace Microphone。") }
        let inputID = translate(uid), outputID = translate("SoundFace_2_UID")
        guard inputID != 0 else { throw RouteError.message("麦克风断开了，请重新选择。") }
        guard outputID != 0 else { throw RouteError.message("还没安装虚拟麦克风。请先安装，装完按提示重启电脑。") }
        var error = [CChar](repeating: 0, count: 512)
        guard let next = sf_route_start(inputID, outputID, &error, error.count) else { throw RouteError.message(String(cString: error)) }
        route = next
        lastCaptured = 0; lastOutput = 0; lastCaptureTime = Date(); lastOutputTime = Date()
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self, let route = self.route else { return }
            let stats = sf_route_stats(route); let now = Date()
            if stats.capturedFrames != self.lastCaptured { self.lastCaptureTime = now; self.lastCaptured = stats.capturedFrames }
            if stats.outputFrames != self.lastOutput { self.lastOutputTime = now; self.lastOutput = stats.outputFrames }
            guard stats.error == 0, self.deviceReady(inputID, rate: stats.inputSampleRate), self.deviceReady(outputID, rate: stats.sampleRate),
                  now.timeIntervalSince(self.lastCaptureTime) < 2, now.timeIntervalSince(self.lastOutputTime) < 2 else {
                self.stop(); emit(["event": "stopped", "reason": "麦克风有变化，虚拟麦克风已关闭，请重新选择麦克风。"]); return
            }
            emit(["event": "levels", "inputPeak": stats.inputPeak, "outputPeak": stats.outputPeak, "capturedFrames": stats.capturedFrames, "outputFrames": stats.outputFrames, "sampleRate": stats.sampleRate, "inputSampleRate": stats.inputSampleRate])
        }
    }
    func mute(_ value: Bool) { if let route { sf_route_mute(route, value) } }
}
let router = Router()
if CommandLine.arguments.contains("--list") {
    emit(["inputs": devices(), "installed": translate("SoundFace_UID") != 0, "internalOutput": translate("SoundFace_2_UID") != 0]); exit(0)
}
DispatchQueue.global().async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        DispatchQueue.main.async {
            let id = command["id"] ?? NSNull()
            do {
                switch command["action"] as? String {
                case "list": emit(["id": id, "ok": true, "inputs": devices(), "installed": translate("SoundFace_UID") != 0, "internalOutput": translate("SoundFace_2_UID") != 0])
                case "start": try router.start(uid: command["uid"] as? String ?? ""); emit(["id": id, "ok": true, "running": true])
                case "mute": router.mute(command["muted"] as? Bool ?? true); emit(["id": id, "ok": true])
                case "stop": router.stop(); emit(["id": id, "ok": true, "running": false])
                default: throw RouteError.message("未知命令")
                }
            } catch { emit(["id": id, "ok": false, "error": error.localizedDescription]) }
        }
    }
    DispatchQueue.main.async { router.stop(); exit(0) }
}
RunLoop.main.run()
