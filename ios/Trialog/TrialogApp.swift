import SwiftUI

/// Trialog on the iPhone (phase 1, playground #1036/#1037): the hub in an app, with Face ID in
/// front, the token in the Keychain, and push for what waits on you.
@main
struct TrialogApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var unlock = Unlock()
    @State private var account = AccountStore.load()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            Group {
                if let account {
                    if unlock.unlocked {
                        HubView(account: account)
                            .ignoresSafeArea(edges: .bottom)
                            .background(Color(red: 0.06, green: 0.07, blue: 0.08))
                            .onAppear { Push.start() }
                    } else {
                        LockedView(unlock: unlock).onAppear { unlock.ask() }
                    }
                } else {
                    SetupView { new in account = new }
                }
            }
            .preferredColorScheme(.dark)
            .onChange(of: phase) { _, now in
                if now == .background { unlock.background() }
                if now == .active, account != nil { unlock.foreground() }
            }
        }
    }
}
