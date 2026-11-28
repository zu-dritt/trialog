import LocalAuthentication
import SwiftUI

/// Face ID (or the phone's passcode) before the hub shows: on a cold start, and after the app has been
/// in the background for a while. The token itself stays in the Keychain either way.
///
/// The prompt opens by itself (playground #1192/#1194): no «Locked» screen to tap through first. The
/// retry button shows only when you cancelled or Face ID didn't match. When iOS itself cancelled the
/// prompt (the app wasn't active yet, or something else took the screen), it asks again as soon as the
/// app is active, without a message. The Face ID sheet makes the app inactive and active again; that
/// never starts a second prompt (it would cancel the first one: that was the «Locked. Tap to try again.»).
@MainActor
final class Unlock: ObservableObject {
    /// How long the app may sit in the background before it asks again.
    static let relockAfter: TimeInterval = 5 * 60

    @Published private(set) var unlocked = false
    @Published private(set) var message: String?
    private var wentAway: Date?
    /// A prompt is on the screen: don't start another one.
    private var asking = false
    /// iOS cancelled the last prompt: ask again on the next return to active.
    private var askWhenActive = false

    /// What a failed prompt leaves on the screen: nil when iOS cancelled it (it asks again by itself),
    /// otherwise the words above the Unlock button.
    nonisolated static func messageAfter(_ failure: Error?) -> String? {
        switch (failure as? LAError)?.code {
        case .systemCancel?, .appCancel?: return nil
        case .userCancel?, .userFallback?: return "Tap Unlock to open your hub."
        case .authenticationFailed?: return "That didn't match. Tap Unlock to try again."
        case .biometryLockout?: return "Face ID is locked. Tap Unlock to use your passcode."
        default: return "Tap Unlock to try again."
        }
    }

    func ask() {
        guard !unlocked, !asking else { return }
        let context = LAContext()
        context.localizedCancelTitle = "Not now"
        var error: NSError?
        // Biometrics with the passcode as the fallback; a phone without either just opens.
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            unlocked = true
            return
        }
        asking = true
        askWhenActive = false
        message = nil
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Open your Trialog hub") { ok, failure in
            Task { @MainActor in
                self.asking = false
                self.unlocked = ok
                if ok { self.message = nil; return }
                self.message = Self.messageAfter(failure)
                self.askWhenActive = self.message == nil
            }
        }
    }

    func background() { wentAway = Date() }

    /// The app is active again. Only a real return from the background (or a prompt iOS cancelled)
    /// asks; the inactive/active bounce around the Face ID sheet doesn't.
    func foreground() {
        if let away = wentAway {
            if Date().timeIntervalSince(away) >= Self.relockAfter { unlocked = false }
            wentAway = nil
            ask()
        } else if askWhenActive {
            ask()
        }
    }
}

struct LockedView: View {
    @ObservedObject var unlock: Unlock
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "lock.fill").font(.system(size: 44)).foregroundStyle(.secondary)
            Text("Trialog").font(.title.bold())
            // While Face ID asks, only the lock shows; the button appears once there is something to retry.
            if let message = unlock.message {
                Text(message).foregroundStyle(.secondary)
                Button("Unlock") { unlock.ask() }.buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(red: 0.06, green: 0.07, blue: 0.08))
        .preferredColorScheme(.dark)
    }
}
