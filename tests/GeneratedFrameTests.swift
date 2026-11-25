import Foundation
import CoreImage
import CoreVideo

@main struct GeneratedFrameTests {
    static func main() throws {
        let context = CIContext(options: [.useSoftwareRenderer: true])
        let color = CGColorSpaceCreateDeviceRGB()
        let source = CIImage(color: CIColor(red: 1, green: 0, blue: 0)).cropped(to: CGRect(x: 0, y: 0, width: 1280, height: 720))
        let jpeg = context.jpegRepresentation(of: source, colorSpace: color, options: [:])!
        let decoded = decodeGeneratedFrame(jpeg, capturedAt: 1000, now: 1010)!
        precondition(decoded.extent.width == 1280 && decoded.extent.height == 720)
        precondition(decodeGeneratedFrame(jpeg, capturedAt: 1000, now: 1251) == nil)
        precondition(decodeGeneratedFrame(jpeg, capturedAt: 1100, now: 1000) == nil)
        precondition(decodeGeneratedFrame(jpeg, capturedAt: .nan, now: 1000) == nil)
        precondition(decodeGeneratedFrame(Data([255, 216, 255, 217]), capturedAt: 1000, now: 1000) == nil)
        let huge = CIImage(color: CIColor(red: 1, green: 0, blue: 0)).cropped(to: CGRect(x: 0, y: 0, width: 1281, height: 720))
        precondition(decodeGeneratedFrame(context.jpegRepresentation(of: huge, colorSpace: color, options: [:])!, capturedAt: 1000, now: 1000) == nil)
        if CommandLine.arguments.count > 1 { try jpeg.write(to: URL(fileURLWithPath: CommandLine.arguments[1])) }
        print("PASS generated JPEG decoding, dimensions, stale/future timestamps and malformed-input rejection")
    }
}
