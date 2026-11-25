import Foundation
import CoreMediaIO
import CoreMedia
import CoreVideo
import CoreAudio

// The source always emits fresh host-time frames. Until a producer is connected,
// clients receive a neutral privacy slate; an old personal frame is never retained.
final class CameraStream: NSObject, CMIOExtensionStreamSource {
    var stream: CMIOExtensionStream!
    let formats: [CMIOExtensionStreamFormat]
    var timer: DispatchSourceTimer?
    let queue = DispatchQueue(label: "app.soundface.camera.frames")
    let descriptionRef: CMVideoFormatDescription
    var clients = 0
    let frames = FrameStore()
    private var privacyImage: CVPixelBuffer?
    override init() {
        var description: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreate(allocator: kCFAllocatorDefault, codecType: kCVPixelFormatType_32BGRA, width: 1280, height: 720, extensions: nil, formatDescriptionOut: &description)
        descriptionRef = description!
        let duration = CMTime(value: 1, timescale: 30)
        formats = [CMIOExtensionStreamFormat(formatDescription: description!, maxFrameDuration: duration, minFrameDuration: duration, validFrameDurations: nil)]
        super.init()
        stream = CMIOExtensionStream(localizedName: "SoundFace Video", streamID: UUID(uuidString: "A81B5845-5991-45AD-A634-02863AA976C6")!, direction: .source, clockType: .hostTime, source: self)
    }
    var availableProperties: Set<CMIOExtensionProperty> { [.streamActiveFormatIndex, .streamFrameDuration] }
    func streamProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionStreamProperties {
        let result = CMIOExtensionStreamProperties(dictionary: [:])
        result.activeFormatIndex = 0; result.frameDuration = CMTime(value: 1, timescale: 30)
        return result
    }
    func setStreamProperties(_ properties: CMIOExtensionStreamProperties) throws {
        if let index = properties.activeFormatIndex, index != 0 { throw NSError(domain: "SoundFace", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unsupported video format"]) }
    }
    func authorizedToStartStream(for client: CMIOExtensionClient) -> Bool { true }
    func startStream() throws {
        queue.sync {
            clients += 1
            guard timer == nil else { return }
            let clock = DispatchSource.makeTimerSource(queue: queue)
            clock.schedule(deadline: .now(), repeating: .nanoseconds(33_333_333), leeway: .milliseconds(2))
            clock.setEventHandler { [weak self] in self?.sendFrame() }
            timer = clock; clock.resume()
        }
    }
    func stopStream() throws {
        queue.sync { clients = max(0, clients - 1); if clients == 0 { timer?.cancel(); timer = nil } }
    }
    func privacyFrame() -> CVPixelBuffer? {
        if let privacyImage { return privacyImage }
        var image: CVPixelBuffer?
        let attrs = [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary
        guard CVPixelBufferCreate(kCFAllocatorDefault, 1280, 720, kCVPixelFormatType_32BGRA, attrs, &image) == kCVReturnSuccess, let image else { return nil }
        CVPixelBufferLockBaseAddress(image, [])
        if let base = CVPixelBufferGetBaseAddress(image) {
            let stride = CVPixelBufferGetBytesPerRow(image) / 4
            let pixels = base.assumingMemoryBound(to: UInt32.self)
            for y in 0..<720 {
                for x in 0..<1280 {
                    let inMark = x >= 608 && x < 672 && y >= 328 && y < 392
                    pixels[y * stride + x] = inMark ? 0xff5fd49a : 0xff17251f
                }
            }
        }
        CVPixelBufferUnlockBaseAddress(image, [])
        privacyImage = image; return image
    }
    func sendFrame() {
        let time = CMClockGetTime(CMClockGetHostTimeClock())
        let nanoseconds = UInt64(CMTimeConvertScale(time, timescale: 1_000_000_000, method: .default).value)
        guard let image = frames.image(at: nanoseconds) ?? privacyFrame() else { return }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 30), presentationTimeStamp: time, decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        if CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image, formatDescription: descriptionRef, sampleTiming: &timing, sampleBufferOut: &sample) == noErr, let sample {
            stream.send(sample, discontinuity: [], hostTimeInNanoseconds: nanoseconds)
        }
    }
}
final class CameraDevice: NSObject, CMIOExtensionDeviceSource {
    var device: CMIOExtensionDevice!
    let video = CameraStream()
    var sink: CameraSink!
    override init() {
        super.init()
        device = CMIOExtensionDevice(localizedName: "SoundFace Camera", deviceID: UUID(uuidString: "CE3DC523-C4DC-4BB4-AB56-C7282D2354BF")!, legacyDeviceID: "app.soundface.camera.device", source: self)
        sink = CameraSink(video: video)
        try! device.addStream(video.stream)
        try! device.addStream(sink.stream)
    }
    var availableProperties: Set<CMIOExtensionProperty> { [.deviceTransportType, .deviceModel] }
    func deviceProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionDeviceProperties {
        let result = CMIOExtensionDeviceProperties(dictionary: [:]); result.transportType = Int(kAudioDeviceTransportTypeVirtual); result.model = "SoundFace Development Camera"; return result
    }
    func setDeviceProperties(_ properties: CMIOExtensionDeviceProperties) throws {}
}
final class CameraProvider: NSObject, CMIOExtensionProviderSource {
    var provider: CMIOExtensionProvider!
    let camera = CameraDevice()
    override init() { super.init(); provider = CMIOExtensionProvider(source: self, clientQueue: nil); try! provider.addDevice(camera.device) }
    var availableProperties: Set<CMIOExtensionProperty> { [.providerManufacturer] }
    func providerProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionProviderProperties {
        let result = CMIOExtensionProviderProperties(dictionary: [:]); result.manufacturer = "SoundFace"; return result
    }
    func setProviderProperties(_ properties: CMIOExtensionProviderProperties) throws {}
    func connect(to client: CMIOExtensionClient) throws {}
    func disconnect(from client: CMIOExtensionClient) { camera.sink.disconnect(client) }
}
let source = CameraProvider()
CMIOExtensionProvider.startService(provider: source.provider)
CFRunLoopRun()
