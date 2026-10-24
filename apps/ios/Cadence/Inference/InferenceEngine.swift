import CoreGraphics

struct PhraseContext {
    let target: String?
    let transcript: String
    let memories: [String]
    let locale: String
    let count: Int
}

/// Gemma's jobs, run on the phone (OnDevice/) or on the 3090 (Remote/); prompts live in Resources/Prompts.
protocol InferenceEngine {
    func interpretScene(_ crop: CGImage, detectedLabel: String, locale: String) async throws -> String
    func generatePhrases(_ context: PhraseContext) async throws -> [String]
    func summarizeMemory(transcript: String, locale: String) async throws -> String
}
