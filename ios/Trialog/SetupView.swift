import SwiftUI

/// The first start: which hub, and your token for it. Both go into the Keychain (HubAccount).
/// The hub's address is typed here, not built in, so the app works with anyone's hub.
struct SetupView: View {
    var onDone: (HubAccount) -> Void
    @State private var hub = ""
    @State private var token = ""
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("hub.example.com", text: $hub)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("hub-field")
                } header: {
                    Text("Your hub")
                } footer: {
                    Text("The address you open Trialog at in the browser.")
                }
                Section {
                    // A plain field, not a SecureField: iOS offers «Save Password?» for any secure field,
                    // and the token already goes to the Keychain. It is pasted, rarely typed.
                    TextField("Paste your token", text: $token)
                        .font(.system(.body, design: .monospaced))
                        .privacySensitive()
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("token-field")
                } header: {
                    Text("Your token")
                } footer: {
                    Text("A whole settings line like DAVID_TOKEN=… works too. It stays on this phone, in the Keychain, and Face ID unlocks it.")
                }
                if let problem {
                    Section { Text(problem).foregroundStyle(.red) }
                }
                Section {
                    Button("Open my hub", action: save)
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("open-hub")
                }
            }
            .navigationTitle("Trialog")
        }
        .preferredColorScheme(.dark)
    }

    private func save() {
        guard let url = HubAccount.cleanHubURL(hub) else {
            problem = "That doesn't look like a hub address. Try «hub.example.com»."
            return
        }
        let cleaned = HubAccount.cleanToken(token)
        guard !cleaned.isEmpty else {
            problem = "Paste your token first."
            return
        }
        let account = HubAccount(hubURL: url, token: cleaned)
        guard AccountStore.save(account) else {
            problem = "This phone's Keychain didn't keep it. Try again; if it keeps failing, restart the phone."
            return
        }
        onDone(account)
    }
}
