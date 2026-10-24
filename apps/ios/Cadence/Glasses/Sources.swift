import CoreVideo
import Foundation

/// Seconds since boot (ProcessInfo.systemUptime), the clock both the glasses SDK and ARKit stamp with.
typealias MonotonicSeconds = TimeInterval

struct CameraFrame {
    let pixelBuffer: CVPixelBuffer
    let timestamp: MonotonicSeconds
}

/// Head orientation relative to the pose captured when the session started.
struct HeadPose {
    let pitchDegrees: Double
    let rollDegrees: Double
    let timestamp: MonotonicSeconds
}

struct TranscriptSegment {
    let text: String
    let isFinal: Bool
    let timestamp: MonotonicSeconds
}

/// Each source has a glasses implementation (DAT/) and an iPhone one (PhoneStandIn/).
protocol CaptureSource {
    func start() async throws
    func stop() async
}

protocol FrameSource: CaptureSource {
    var frames: AsyncStream<CameraFrame> { get }
}

protocol MotionSource: CaptureSource {
    var poses: AsyncStream<HeadPose> { get }
}

protocol TranscriptSource: CaptureSource {
    var segments: AsyncStream<TranscriptSegment> { get }
}
