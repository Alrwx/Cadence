import MWDATCore
import SwiftUI

@main
struct CadenceApp: App {
    let config: AppConfig

    init() {
        do {
            config = try AppConfig.load()
            try Wearables.configure()
        } catch {
            fatalError("Startup failed: \(error)")
        }
    }

    var body: some Scene {
        WindowGroup {
            Text("Cadence")
                .onOpenURL(perform: handleMetaCallback)
        }
    }

    /// Meta AI reopens the app with this URL after registration and permission prompts.
    private func handleMetaCallback(_ url: URL) {
        guard URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.contains(where: { $0.name == "metaWearablesAction" }) == true
        else { return }
        Task {
            do {
                _ = try await Wearables.shared.handleUrl(url)
            } catch {
                print("Meta AI callback failed: \(error)")
            }
        }
    }
}
