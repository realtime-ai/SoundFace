import CoreVideo

@main struct FrameStoreTests {
    static func image(_ width: Int = 1280, _ height: Int = 720, _ format: OSType = kCVPixelFormatType_32BGRA) -> CVPixelBuffer {
        var result: CVPixelBuffer?
        precondition(CVPixelBufferCreate(kCFAllocatorDefault, width, height, format, nil, &result) == kCVReturnSuccess)
        return result!
    }
    static func main() {
        let store = FrameStore(), first = image(), second = image()
        precondition(store.image(at: 0) == nil)
        precondition(store.accept(first, at: 10))
        precondition(store.image(at: 10) === first)
        precondition(store.accept(second, at: 20))
        precondition(store.image(at: 21) === second)
        precondition(store.image(at: 250_000_020) === second)
        precondition(store.image(at: 250_000_021) == nil)
        precondition(store.image(at: 21) == nil, "expired frame must stay cleared")
        store.accept(first, at: 40); store.clear(); precondition(store.image(at: 41) == nil)
        store.accept(first, at: 40); precondition(store.image(at: 39) == nil)
        store.accept(first, at: 0); precondition(!store.accept(image(640, 480), at: 1)); precondition(store.image(at: 2) == nil)
        precondition(!store.accept(image(1280, 720, kCVPixelFormatType_32ARGB), at: 3))
        print("PASS camera latest-frame replacement, 250 ms expiry, stop, backward clock and malformed-frame rejection")
    }
}
