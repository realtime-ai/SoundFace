import Foundation
import CoreImage
import ImageIO

// Inspect dimensions before decoding, and reject old frames before they can be
// stamped with a fresh CMIO host time. At most one request is in flight in JS.
func decodeGeneratedFrame(_ data: Data, capturedAt: Double, now: Double) -> CIImage? {
    guard capturedAt.isFinite, now.isFinite, capturedAt <= now + 50, now - capturedAt <= 250,
          data.count >= 4, data.count <= 524_288, data[0] == 0xff, data[1] == 0xd8,
          let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? Int,
          let height = properties[kCGImagePropertyPixelHeight] as? Int,
          width > 0, height > 0, width <= 1280, height <= 720 else { return nil }
    return CIImage(data: data, options: [.applyOrientationProperty: true])
}
