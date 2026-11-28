import UIKit
import UserNotifications

/// Push notifications: asks once, gets the phone's push address (device token) from Apple, and gives
/// it to the hub (POST /api/push/devices), which then sends a push when a message is for you or
/// something waits on you. Until the hub has that endpoint, the app just tries again next start.
enum Push {
    /// Where the last APNs device token (hex) is kept, so Switch hub can unregister it. Not a secret
    /// like the hub token; UserDefaults is enough, and it survives a restart of the app.
    static let lastTokenKey = "apnsDeviceTokenHex"

    /// APNs environment, as the hub stores it: `sandbox` for builds from Xcode, `production` for TestFlight and the App Store.
    static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    static func start() {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    /// The device token as the hex text APNs expects.
    static func hex(_ token: Data) -> String { token.map { String(format: "%02x", $0) }.joined() }

    static func rememberDeviceToken(_ deviceToken: Data, defaults: UserDefaults = .standard) {
        defaults.set(hex(deviceToken), forKey: lastTokenKey)
    }

    static func register(_ deviceToken: Data, with account: HubAccount, defaults: UserDefaults = .standard) {
        rememberDeviceToken(deviceToken, defaults: defaults)
        let request = registerRequest(account: account, tokenHex: hex(deviceToken))
        URLSession.shared.dataTask(with: request).resume()
    }

    static func registerRequest(account: HubAccount, tokenHex: String) -> URLRequest {
        var request = URLRequest(url: account.hubURL.appendingPathComponent("api/push/devices"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(account.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "token": tokenHex, "platform": "ios", "env": environment,
            "bundle_id": Bundle.main.bundleIdentifier ?? "",
        ])
        return request
    }

    /// Best-effort: ask the current hub to drop this phone so it stops getting that hub's pushes.
    /// Does nothing if we have never received a device token (no network call).
    static func unregister(from account: HubAccount, defaults: UserDefaults = .standard) {
        guard let tokenHex = defaults.string(forKey: lastTokenKey), !tokenHex.isEmpty else { return }
        URLSession.shared.dataTask(with: unregisterRequest(account: account, tokenHex: tokenHex)).resume()
    }

    static func unregisterRequest(account: HubAccount, tokenHex: String) -> URLRequest {
        var request = URLRequest(url: account.hubURL.appendingPathComponent("api/push/devices"))
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(account.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["token": tokenHex])
        return request
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        if let account = AccountStore.load() { Push.register(deviceToken, with: account) }
    }

    /// While the app is open, a push still shows and chimes: the hub page may be in another room.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }
}
