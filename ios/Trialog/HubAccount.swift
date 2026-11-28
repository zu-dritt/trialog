import Foundation
import Security

/// The hub this phone talks to, and the participant's token for it. Both live in the Keychain,
/// on this device only, readable only while the phone is unlocked. Nothing is stored anywhere else.
struct HubAccount: Equatable {
    var hubURL: URL
    var token: String

    /// What was pasted as a token: trimmed, without a «NAME_TOKEN=» in front (tokens are often copied
    /// from a settings line) and without quotes around it. The same rule as the hub's own sign-in form.
    static func cleanToken(_ pasted: String) -> String {
        var t = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
        if let eq = t.firstIndex(of: "="), t[..<eq].range(of: "^[A-Z][A-Z0-9_]*$", options: .regularExpression) != nil {
            t = String(t[t.index(after: eq)...]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if t.count >= 2, let first = t.first, first == t.last, first == "\"" || first == "'" {
            t = String(t.dropFirst().dropLast()).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return t
    }

    /// The hub's address as typed: https only (http only for a hub on this Mac, for the Simulator),
    /// no path, query or login in it. «hub.example.com» becomes «https://hub.example.com/».
    static func cleanHubURL(_ typed: String) -> URL? {
        // Pasted text often brings things along (playground #1140): invisible characters (zero-width
        // spaces, word joiners), spaces or line breaks anywhere, and quotes, backticks or «…» around
        // the address when it was copied from a message. All of that goes.
        let kept = typed.unicodeScalars.filter {
            $0.properties.generalCategory != .format && !CharacterSet.whitespacesAndNewlines.contains($0)
        }
        var t = String(String.UnicodeScalarView(kept)).trimmingCharacters(in: CharacterSet(charactersIn: "\"'`<>«»‹›“”‘’"))
        if !t.contains("://") { t = "https://" + t }
        guard var parts = URLComponents(string: t), let rawHost = parts.host, !rawHost.isEmpty,
              parts.user == nil, parts.password == nil else { return nil }
        // Lowercased, so it matches the page's own origin exactly (the token goes only there).
        let host = rawHost.lowercased()
        let scheme = parts.scheme?.lowercased()
        let local = host == "localhost" || host == "127.0.0.1"
        guard scheme == "https" || (scheme == "http" && local) else { return nil }
        // A hub on the internet has a dot in its name («hub.example.com»), not just a word.
        guard local || host.contains(".") else { return nil }
        parts.scheme = scheme
        parts.host = host
        parts.path = "/"
        parts.query = nil
        parts.fragment = nil
        return parts.url
    }
}

/// Keychain storage for the one account. Generic passwords, this device only.
enum AccountStore {
    private static let service = "dev.trialog.hub"
    private static let urlKey = "hub-url"
    private static let tokenKey = "token"

    static func load() -> HubAccount? {
        guard let raw = read(urlKey), let url = URL(string: raw), let token = read(tokenKey), !token.isEmpty else { return nil }
        return HubAccount(hubURL: url, token: token)
    }

    /// False when the Keychain refused (the account is then not kept, and the setup screen says so).
    @discardableResult
    static func save(_ account: HubAccount) -> Bool {
        write(urlKey, account.hubURL.absoluteString) && write(tokenKey, account.token)
    }

    static func clear() {
        delete(urlKey)
        delete(tokenKey)
    }

    private static func base(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
    }

    private static func read(_ key: String) -> String? {
        var query = base(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func write(_ key: String, _ value: String) -> Bool {
        delete(key)
        var item = base(key)
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    private static func delete(_ key: String) {
        SecItemDelete(base(key) as CFDictionary)
    }
}
