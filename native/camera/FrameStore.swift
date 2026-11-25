import CoreVideo

// Access only on the camera's serial frame queue. Capacity is exactly one frame.
// A missing, malformed, stopped, or stale producer must never freeze a personal frame.
final class FrameStore {
    static let maximumAge: UInt64 = 250_000_000
    private var latest: CVPixelBuffer?
    private var receivedAt: UInt64 = 0
    @discardableResult
    func accept(_ image: CVPixelBuffer, at time: UInt64) -> Bool {
        guard CVPixelBufferGetWidth(image) == 1280, CVPixelBufferGetHeight(image) == 720,
              CVPixelBufferGetPixelFormatType(image) == kCVPixelFormatType_32BGRA else {
            clear(); return false
        }
        latest = image; receivedAt = time; return true
    }
    func image(at time: UInt64) -> CVPixelBuffer? {
        guard latest != nil, time >= receivedAt, time - receivedAt <= Self.maximumAge else { clear(); return nil }
        return latest
    }
    func clear() { latest = nil; receivedAt = 0 }
}
