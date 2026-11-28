import UIKit
import UserNotifications

/// Push notifications: asks once, gets the phone's push address (device token) from Apple, and gives
/// it to the hub (POST /api/push/devices), which then sends a push when a message is for you or
/// something waits on you. Until the hub has that endpoint, the app just tries again next start.
enum Push {
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

    static func register(_ deviceToken: Data, with account: HubAccount) {
        var request = URLRequest(url: account.hubURL.appendingPathComponent("api/push/devices"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(account.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "token": hex(deviceToken), "platform": "ios", "env": environment,
            "bundle_id": Bundle.main.bundleIdentifier ?? "",
        ])
        URLSession.shared.dataTask(with: request).resume()
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
