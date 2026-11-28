import LocalAuthentication
import SwiftUI

/// Face ID (or the phone's passcode) before the hub shows: on a cold start, and after the app has been
/// in the background for a while. The token itself stays in the Keychain either way.
@MainActor
final class Unlock: ObservableObject {
    /// How long the app may sit in the background before it asks again.
    static let relockAfter: TimeInterval = 5 * 60

    @Published private(set) var unlocked = false
    @Published private(set) var message: String?
    private var wentAway: Date?

    func ask() {
        guard !unlocked else { return }
        let context = LAContext()
        context.localizedCancelTitle = "Not now"
        var error: NSError?
        // Biometrics with the passcode as the fallback; a phone without either just opens.
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            unlocked = true
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Open your Trialog hub") { ok, failure in
            Task { @MainActor in
                self.unlocked = ok
                self.message = ok ? nil : (failure as? LAError).map { _ in "Locked. Tap to try again." } ?? "Locked."
            }
        }
    }

    func background() { wentAway = Date() }

    func foreground() {
        if let away = wentAway, Date().timeIntervalSince(away) >= Self.relockAfter { unlocked = false }
        wentAway = nil
        ask()
    }
}

struct LockedView: View {
    @ObservedObject var unlock: Unlock
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "lock.fill").font(.system(size: 44)).foregroundStyle(.secondary)
            Text("Trialog").font(.title.bold())
            if let message = unlock.message { Text(message).foregroundStyle(.secondary) }
            Button("Unlock") { unlock.ask() }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(red: 0.06, green: 0.07, blue: 0.08))
        .preferredColorScheme(.dark)
    }
}
