import Foundation
import CoreMediaIO
import CoreMedia

final class CameraSink: NSObject, CMIOExtensionStreamSource {
    var stream: CMIOExtensionStream!
    private let video: CameraStream
    private var client: CMIOExtensionClient?
    private var timer: DispatchSourceTimer?
    private var consuming = false
    private var generation: UInt64 = 0
    init(video: CameraStream) {
        self.video = video
        super.init()
        stream = CMIOExtensionStream(localizedName: "SoundFace Frame Input", streamID: UUID(uuidString: "DEBB4E40-0965-4E8D-BDE6-DA998EE59864")!, direction: .sink, clockType: .hostTime, source: self)
    }
    var formats: [CMIOExtensionStreamFormat] { video.formats }
    var availableProperties: Set<CMIOExtensionProperty> { [.streamActiveFormatIndex, .streamFrameDuration, .streamSinkBufferQueueSize, .streamSinkBuffersRequiredForStartup, .streamSinkEndOfData] }
    func streamProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionStreamProperties {
        let result = CMIOExtensionStreamProperties(dictionary: [:])
        result.activeFormatIndex = 0; result.frameDuration = CMTime(value: 1, timescale: 30)
        result.sinkBufferQueueSize = 2; result.sinkBuffersRequiredForStartup = 1
        result.sinkEndOfData = 0
        return result
    }
    func setStreamProperties(_ properties: CMIOExtensionStreamProperties) throws {
        if let index = properties.activeFormatIndex, index != 0 { throw NSError(domain: "SoundFace", code: 1, userInfo: [NSLocalizedDescriptionKey: "Only BGRA 1280×720 is supported"]) }
        if properties.sinkEndOfData == 1 { video.queue.sync { stopOnQueue() } }
    }
    func authorizedToStartStream(for candidate: CMIOExtensionClient) -> Bool {
        video.queue.sync {
            if let client, client.clientID != candidate.clientID { return false }
            client = candidate; return true
        }
    }
    func startStream() throws {
        try video.queue.sync {
            guard client != nil else { throw NSError(domain: "SoundFace", code: 2, userInfo: [NSLocalizedDescriptionKey: "No authorized producer"]) }
            guard timer == nil else { return }
            generation &+= 1; consuming = false; video.frames.clear()
            let clock = DispatchSource.makeTimerSource(queue: video.queue)
            clock.schedule(deadline: .now(), repeating: .milliseconds(15), leeway: .milliseconds(1))
            clock.setEventHandler { [weak self] in self?.consume() }
            timer = clock; clock.resume()
        }
    }
    private func consume() {
        guard timer != nil, !consuming, let client else { return }
        consuming = true; let token = generation
        stream.consumeSampleBuffer(from: client) { [weak self] sample, sequence, _, more, error in
            guard let self else { return }
            self.video.queue.async {
                guard self.generation == token, self.timer != nil else { return }
                self.consuming = false
                let time = CMClockGetTime(CMClockGetHostTimeClock())
                let nanos = UInt64(CMTimeConvertScale(time, timescale: 1_000_000_000, method: .default).value)
                if error != nil { self.video.frames.clear() }
                if let sample {
                    let pts = CMSampleBufferGetPresentationTimeStamp(sample)
                    let validTime = pts.isNumeric && pts.seconds >= 0 && pts.seconds <= time.seconds && time.seconds - pts.seconds <= 0.25
                    if validTime, let image = CMSampleBufferGetImageBuffer(sample) { self.video.frames.accept(image, at: UInt64(CMTimeConvertScale(pts, timescale: 1_000_000_000, method: .default).value)) }
                    else { self.video.frames.clear() }
                    self.stream.notifyScheduledOutputChanged(CMIOExtensionScheduledOutput(sequenceNumber: sequence, hostTimeInNanoseconds: nanos))
                }
                if more && error == nil { self.consume() }
            }
        }
    }
    private func stopOnQueue() {
        generation &+= 1; timer?.cancel(); timer = nil; client = nil; consuming = false; video.frames.clear()
    }
    func stopStream() throws { video.queue.sync { stopOnQueue() } }
    func disconnect(_ disconnected: CMIOExtensionClient) {
        video.queue.sync { if client?.clientID == disconnected.clientID { stopOnQueue() } }
    }
}
