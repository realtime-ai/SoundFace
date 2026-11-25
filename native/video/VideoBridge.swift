import Foundation
import AVFoundation
import CoreMediaIO
import CoreImage

func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object) {
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
}
enum VideoError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}
func address(_ selector: Int, scope: Int = kCMIOObjectPropertyScopeGlobal) -> CMIOObjectPropertyAddress {
    CMIOObjectPropertyAddress(mSelector: UInt32(selector), mScope: UInt32(scope), mElement: UInt32(kCMIOObjectPropertyElementMain))
}
func ids(_ object: CMIOObjectID, _ selector: Int, scope: Int = kCMIOObjectPropertyScopeGlobal) -> [CMIOObjectID] {
    var property = address(selector, scope: scope); var size: UInt32 = 0
    guard CMIOObjectGetPropertyDataSize(object, &property, 0, nil, &size) == noErr, size > 0 else { return [] }
    var result = [CMIOObjectID](repeating: 0, count: Int(size) / MemoryLayout<CMIOObjectID>.size); var used: UInt32 = 0
    guard CMIOObjectGetPropertyData(object, &property, 0, nil, size, &used, &result) == noErr else { return [] }
    return Array(result.prefix(Int(used) / MemoryLayout<CMIOObjectID>.size))
}
func string(_ object: CMIOObjectID, _ selector: Int) -> String {
    var property = address(selector); var value: Unmanaged<CFString>?; var used: UInt32 = 0
    guard CMIOObjectGetPropertyData(object, &property, 0, nil, UInt32(MemoryLayout<Unmanaged<CFString>?>.size), &used, &value) == noErr else { return "" }
    return value?.takeRetainedValue() as String? ?? ""
}
func direction(_ stream: CMIOStreamID) -> UInt32? {
    var property = address(kCMIOStreamPropertyDirection); var value: UInt32 = 9; var used: UInt32 = 0
    guard CMIOObjectGetPropertyData(stream, &property, 0, nil, 4, &used, &value) == noErr else { return nil }
    return value
}
func sink() -> (CMIODeviceID, CMIOStreamID)? {
    // Expose CMIO extension devices to legacy device enumeration, without opening capture.
    var property = address(kCMIOHardwarePropertyAllowScreenCaptureDevices); var allowed: UInt32 = 1
    _ = CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &property, 0, nil, 4, &allowed)
    for device in ids(CMIOObjectID(kCMIOObjectSystemObject), kCMIOHardwarePropertyDevices) {
        let uid = string(device, kCMIODevicePropertyDeviceUID)
        guard ["app.soundface.camera.device", "CE3DC523-C4DC-4BB4-AB56-C7282D2354BF"].contains(uid) else { continue }
        for stream in ids(device, kCMIODevicePropertyStreams, scope: kCMIODevicePropertyScopeOutput) {
            // CoreMediaIO legacy direction 0 means output-to-device; extension .sink has a different enum.
            if string(stream, kCMIOObjectPropertyName) == "SoundFace Frame Input", direction(stream) == 0 { return (device, stream) }
        }
    }
    return nil
}
func cameras() -> [AVCaptureDevice] {
    AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera, .externalUnknown], mediaType: .video, position: .unspecified).devices.filter { $0.localizedName != "SoundFace Camera" && $0.uniqueID != "app.soundface.camera.device" }
}
func list() -> [String: Any] {
    ["inputs": cameras().map { ["uid": $0.uniqueID, "name": $0.localizedName] }, "installed": sink() != nil]
}
final class VideoRouter: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let queue = DispatchQueue(label: "app.soundface.video.capture")
    private var session: AVCaptureSession?
    private var captureOutput: AVCaptureVideoDataOutput?
    private var generation: UInt64 = 0
    private var generatedSession: String?
    private var probe = false
    private var outputQueue: CMSimpleQueue?
    private var deviceID: CMIODeviceID = 0, streamID: CMIOStreamID = 0
    private var observers: [NSObjectProtocol] = []
    private var pool: CVPixelBufferPool?
    private var descriptionRef: CMVideoFormatDescription?
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var submitted: UInt64 = 0, dropped: UInt64 = 0, converted: UInt64 = 0
    private var lastReport: Double = 0, nextEnqueue: Double = 0
    func stop() {
        generation &+= 1
        observers.forEach { NotificationCenter.default.removeObserver($0) }; observers.removeAll()
        session?.stopRunning(); session = nil; captureOutput = nil; generatedSession = nil; probe = false
        if streamID != 0 {
            var endProperty = address(kCMIOStreamPropertyEndOfData); var ended: UInt32 = 1
            _ = CMIOObjectSetPropertyData(streamID, &endProperty, 0, nil, 4, &ended)
            _ = CMIODeviceStopStream(deviceID, streamID)
        }
        // A stopped stream no longer consumes. Release retained samples left in its bounded queue.
        if let outputQueue { while let item = CMSimpleQueueDequeue(outputQueue) { Unmanaged<CMSampleBuffer>.fromOpaque(item).release() } }
        outputQueue = nil; pool = nil; descriptionRef = nil; deviceID = 0; streamID = 0
    }
    func start(uid: String, liveID: String = "") throws {
        stop()
        if uid == "vidu-probe" {
            guard !liveID.isEmpty else { throw VideoError.message("缺少数字人会话标识") }
            try prepareFrames(); generatedSession = liveID; probe = true; return
        }
        guard let (device, stream) = sink() else { throw VideoError.message("SoundFace Camera 尚未激活，当前无法输出到虚拟摄像头。") }
        let generated = uid == "vidu" || uid == "test-pattern"
        guard !generated || !liveID.isEmpty else { throw VideoError.message("缺少数字人会话标识") }
        let inputDevice = generated ? nil : cameras().first(where: { $0.uniqueID == uid })
        guard generated || inputDevice != nil else { throw VideoError.message("摄像头已断开，请重新选择。") }
        guard generated || AVCaptureDevice.authorizationStatus(for: .video) == .authorized else { throw VideoError.message("请先允许 SoundFace 使用摄像头。") }
        var copiedQueue: Unmanaged<CMSimpleQueue>?
        let queueStatus = CMIOStreamCopyBufferQueue(stream, { _, _, _ in }, nil, &copiedQueue)
        guard queueStatus == noErr, let copiedQueue else { throw VideoError.message("无法打开摄像头输入队列 (\(queueStatus))") }
        outputQueue = copiedQueue.takeRetainedValue(); deviceID = device; streamID = stream
        do {
            var endProperty = address(kCMIOStreamPropertyEndOfData); var ended: UInt32 = 0
            _ = CMIOObjectSetPropertyData(stream, &endProperty, 0, nil, 4, &ended)
            let startStatus = CMIODeviceStartStream(device, stream)
            guard startStatus == noErr else { throw VideoError.message("虚拟摄像头拒绝接收画面 (\(startStatus))") }
            try prepareFrames()
            if generated { generatedSession = liveID; return }
            guard let inputDevice else { throw VideoError.message("摄像头输入不可用") }
            let capture = AVCaptureSession(); capture.beginConfiguration()
            if capture.canSetSessionPreset(.hd1280x720) { capture.sessionPreset = .hd1280x720 }
            let input = try AVCaptureDeviceInput(device: inputDevice)
            guard capture.canAddInput(input) else { throw VideoError.message("摄像头输入不可用") }
            capture.addInput(input)
            let output = AVCaptureVideoDataOutput()
            output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            output.alwaysDiscardsLateVideoFrames = true; output.setSampleBufferDelegate(self, queue: queue)
            guard capture.canAddOutput(output) else { throw VideoError.message("无法创建摄像头输出") }
            capture.addOutput(output); capture.commitConfiguration(); session = capture; captureOutput = output
            let token = generation
            for name in [AVCaptureSession.runtimeErrorNotification, AVCaptureSession.wasInterruptedNotification] {
                observers.append(NotificationCenter.default.addObserver(forName: name, object: capture, queue: nil) { [weak self] _ in
                    self?.queue.async { [weak self] in guard let self, self.generation == token else { return }; self.stop(); emit(["event": "stopped", "reason": "摄像头采集中断，已停止虚拟输出。请检查设备后重新开启。"] ) }
                })
            }
            capture.startRunning()
            guard capture.isRunning else { throw VideoError.message("摄像头未开始采集") }
        } catch { stop(); throw error }
    }
    private func prepareFrames() throws {
        let attrs: [String: Any] = [kCVPixelBufferWidthKey as String: 1280, kCVPixelBufferHeightKey as String: 720, kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        guard CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &pool) == kCVReturnSuccess else { throw VideoError.message("无法建立视频帧池") }
        guard CMVideoFormatDescriptionCreate(allocator: kCFAllocatorDefault, codecType: kCVPixelFormatType_32BGRA, width: 1280, height: 720, extensions: nil, formatDescriptionOut: &descriptionRef) == noErr else { throw VideoError.message("无法建立视频格式") }
        submitted = 0; dropped = 0; converted = 0; lastReport = 0; nextEnqueue = 0
    }
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard output === captureOutput, session?.isRunning == true,
              let image = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        enqueue(CIImage(cvPixelBuffer: image))
    }
    func generatedFrame(_ command: [String: Any]) throws {
        guard let generatedSession, command["liveID"] as? String == generatedSession else { throw VideoError.message("数字人输出已停止或会话已切换") }
        let now = Date().timeIntervalSince1970 * 1000
        let receivedTime = CMClockGetTime(CMClockGetHostTimeClock())
        if let capturedAt = command["capturedAt"] as? Double, capturedAt.isFinite, now - capturedAt > 250 { dropped += 1; report(at: CMClockGetTime(CMClockGetHostTimeClock()).seconds); return }
        guard let encoded = command["jpeg"] as? String, encoded.utf8.count <= 700_000,
              let data = Data(base64Encoded: encoded), let capturedAt = command["capturedAt"] as? Double,
              let image = decodeGeneratedFrame(data, capturedAt: capturedAt, now: now) else {
            throw VideoError.message("生成帧已过期或格式不受支持")
        }
        // Preserve local frame age across the wall-clock / host-clock boundary.
        // Re-stamping an old frame as "now" would extend the privacy deadline.
        let capturedTime = CMTimeSubtract(receivedTime, CMTime(seconds: max(0, now - capturedAt) / 1000, preferredTimescale: 1_000_000_000))
        enqueue(image, capturedTime: capturedTime)
    }
    private func enqueue(_ source: CIImage, capturedTime: CMTime? = nil) {
        guard let pool, let descriptionRef, probe || outputQueue != nil else { return }
        let time = CMClockGetTime(CMClockGetHostTimeClock()); let now = time.seconds
        if now + 0.001 < nextEnqueue { return }
        // Never block capture or grow a backlog when the receiving extension stalls.
        if let outputQueue, CMSimpleQueueGetCount(outputQueue) >= min(2, CMSimpleQueueGetCapacity(outputQueue)) { dropped += 1; report(at: now); return }
        var target: CVPixelBuffer?
        let limits = [kCVPixelBufferPoolAllocationThresholdKey: 4] as CFDictionary
        guard CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(kCFAllocatorDefault, pool, limits, &target) == kCVReturnSuccess, let target else { dropped += 1; report(at: now); return }
        let scale = max(1280 / source.extent.width, 720 / source.extent.height)
        let scaled = source.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let centered = scaled.transformed(by: CGAffineTransform(translationX: (1280 - scaled.extent.width) / 2 - scaled.extent.minX, y: (720 - scaled.extent.height) / 2 - scaled.extent.minY))
        context.render(centered, to: target, bounds: CGRect(x: 0, y: 0, width: 1280, height: 720), colorSpace: CGColorSpaceCreateDeviceRGB())
        let presentationTime = capturedTime ?? time
        if CMClockGetTime(CMClockGetHostTimeClock()).seconds - presentationTime.seconds > 0.25 { dropped += 1; report(at: now); return }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 30), presentationTimeStamp: presentationTime, decodeTimeStamp: .invalid)
        var frame: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: target, formatDescription: descriptionRef, sampleTiming: &timing, sampleBufferOut: &frame) == noErr, let frame else { return }
        converted += 1
        // Exercise the same decode, pixel pool, render and sample-buffer path
        // without pretending that a non-activated extension received anything.
        if probe { nextEnqueue = max(nextEnqueue + 1.0 / 30, now); report(at: now); return }
        guard let outputQueue else { return }
        let retained = Unmanaged.passRetained(frame)
        if CMSimpleQueueEnqueue(outputQueue, element: retained.toOpaque()) != noErr { retained.release(); dropped += 1 }
        else { submitted += 1; nextEnqueue = max(nextEnqueue + 1.0 / 30, now) }
        report(at: now)
    }
    private func report(at time: Double) {
        if time - lastReport >= 1 { emit(["event": "frames", "submitted": submitted, "dropped": dropped, "converted": converted]); lastReport = time }
    }
    func reportFinal() { emit(["event": "frames", "submitted": submitted, "dropped": dropped, "converted": converted]) }
}
@main
enum VideoBridgeMain {
static func main() {
let router = VideoRouter()
if CommandLine.arguments.contains("--list") { emit(list()); exit(0) }
DispatchQueue.global().async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        router.queue.async {
            let id = command["id"] ?? NSNull()
            do {
                switch command["action"] as? String {
                case "list": emit(list().merging(["id": id, "ok": true]) { _, new in new })
                case "start": try router.start(uid: command["uid"] as? String ?? "", liveID: command["liveID"] as? String ?? ""); emit(["id": id, "ok": true, "running": true])
                case "frame": try router.generatedFrame(command); emit(["id": id, "ok": true])
                case "stop": router.reportFinal(); router.stop(); emit(["id": id, "ok": true, "running": false])
                default: throw VideoError.message("未知视频命令")
                }
            } catch { emit(["id": id, "ok": false, "error": error.localizedDescription]) }
        }
    }
    router.queue.async { router.stop(); exit(0) }
}
RunLoop.main.run()
}
}
