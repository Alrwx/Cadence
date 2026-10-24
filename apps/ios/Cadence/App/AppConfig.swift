import Foundation

/// Mirrors Resources/Config.json, the single home for runtime defaults.
struct AppConfig: Decodable {
    struct Selection: Decodable {
        let tiltThresholdDegrees: Double
        let neutralDeadZoneDegrees: Double
        let tiltDwellMs: Int
        /// Fraction of the frame's shorter side.
        let reticleRadiusFraction: Double
        let targetDwellMs: Int
    }

    struct Camera: Decodable {
        /// Meta stream preset: "low" (360x640), "medium" or "high".
        let resolution: String
        let fps: Int
    }

    struct Context: Decodable {
        let transcriptWindowSeconds: Int
        let memoriesInPrompt: Int
        let phraseCount: Int
    }

    struct Inference: Decodable {
        enum Backend: String, Decodable {
            case onDevice, remote
        }

        let backend: Backend
        let remoteBaseURL: URL
        let model: String
    }

    struct Supabase: Decodable {
        let url: URL
        let anonKey: String
    }

    let locale: String
    let selection: Selection
    let camera: Camera
    let context: Context
    let inference: Inference
    let serverBaseURL: URL
    let supabase: Supabase

    static func load(from bundle: Bundle = .main) throws -> AppConfig {
        guard let url = bundle.url(forResource: "Config", withExtension: "json") else {
            throw CocoaError(.fileNoSuchFile)
        }
        return try JSONDecoder().decode(AppConfig.self, from: Data(contentsOf: url))
    }
}
