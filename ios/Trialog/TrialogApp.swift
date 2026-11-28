import SwiftUI

/// Trialog on the iPhone (phase 1, playground #1036/#1037): the hub in an app, with Face ID in
/// front, the token in the Keychain, and push for what waits on you.
@main
struct TrialogApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var unlock = Unlock()
    @State private var account: HubAccount? = {
        AccountLaunch.prepareAccount()
        return AccountStore.load()
    }()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            Group {
                if let account {
                    if unlock.unlocked {
                        HubScreen(account: account, onSwitchHub: { switchHub(from: account) })
                    } else {
                        LockedView(unlock: unlock).onAppear { unlock.ask() }
                    }
                } else {
                    SetupView { new in self.account = new }
                }
            }
            .preferredColorScheme(.dark)
            .onChange(of: phase) { _, now in
                if now == .background { unlock.background() }
                if now == .active, account != nil { unlock.foreground() }
            }
        }
    }

    /// Forget this hub and its token, and show Setup again (empty fields). Best-effort: ask the
    /// old hub to stop sending pushes to this phone.
    private func switchHub(from account: HubAccount) {
        Push.unregister(from: account)
        AccountStore.clear()
        self.account = nil
    }
}

/// The hub page, with a small native menu that does not live in the web UI. «Switch hub…» asks
/// first, then returns to Setup.
struct HubScreen: View {
    let account: HubAccount
    var onSwitchHub: () -> Void
    @State private var confirmSwitch = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            HubView(account: account)
                .ignoresSafeArea(edges: .bottom)
                .background(Color(red: 0.06, green: 0.07, blue: 0.08))
                .onAppear { Push.start() }
            Menu {
                Button("Switch hub…", systemImage: "arrow.left.arrow.right") {
                    confirmSwitch = true
                }
            } label: {
                Image(systemName: "ellipsis.circle.fill")
                    .font(.system(size: 22))
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white.opacity(0.95), Color.black.opacity(0.4))
                    .padding(12)
            }
            .accessibilityIdentifier("hub-menu")
            .accessibilityLabel("Hub menu")
        }
        .confirmationDialog("Switch hub?", isPresented: $confirmSwitch, titleVisibility: .visible) {
            Button("Switch hub", role: .destructive, action: onSwitchHub)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This phone will forget this hub and its token. You'll enter a new address and token.")
        }
    }
}
