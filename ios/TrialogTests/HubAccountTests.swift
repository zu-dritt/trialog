import LocalAuthentication
import XCTest
@testable import Trialog

final class HubAccountTests: XCTestCase {
    func testTokenIsCleanedLikeTheHubsForm() {
        XCTAssertEqual(HubAccount.cleanToken("  abc123  "), "abc123")
        XCTAssertEqual(HubAccount.cleanToken("DAVID_TOKEN=abc123"), "abc123")
        XCTAssertEqual(HubAccount.cleanToken("DAVID_TOKEN=\"abc123\""), "abc123")
        XCTAssertEqual(HubAccount.cleanToken("'abc123'"), "abc123")
        XCTAssertEqual(HubAccount.cleanToken("lower=abc"), "lower=abc", "only an UPPER_CASE setting name is stripped")
    }

    func testHubAddressIsHttpsWithNoPath() {
        XCTAssertEqual(HubAccount.cleanHubURL("hub.example.com")?.absoluteString, "https://hub.example.com/")
        XCTAssertEqual(HubAccount.cleanHubURL("https://hub.example.com/roadmap?x=1#y")?.absoluteString, "https://hub.example.com/")
        XCTAssertNil(HubAccount.cleanHubURL("http://hub.example.com"), "plain http only for a hub on this Mac")
        XCTAssertEqual(HubAccount.cleanHubURL("http://localhost:3000")?.absoluteString, "http://localhost:3000/")
        XCTAssertNil(HubAccount.cleanHubURL("https://user:pw@hub.example.com"))
        XCTAssertNil(HubAccount.cleanHubURL("   "))
    }

    func testPastedAddressesAreForgiving() {
        // What copying brings along (playground #1140): invisible characters, line breaks, quotes, capitals.
        let want = "https://hub.example.com/"
        for pasted in ["\u{200B}https://hub.example.com", "https://hub.example.com\u{2060}", "https://hub.example.com\n", "  hub.example.com  ",
                       "`hub.example.com`", "«https://hub.example.com/»", "\"hub.example.com\"", "HTTPS://Hub.Example.COM/roadmap", "hub.example .com"] {
            XCTAssertEqual(HubAccount.cleanHubURL(pasted)?.absoluteString, want, String(reflecting: pasted))
        }
        XCTAssertNil(HubAccount.cleanHubURL("Collab-hub-git-playground"), "a bare word is no address (no dot)")
        XCTAssertEqual(HubAccount.cleanHubURL("localhost:3000")?.absoluteString, "https://localhost:3000/")
    }

    func testTheTokenGoesOnlyToTheHubsOwnOriginAndIsEscaped() {
        let account = HubAccount(hubURL: URL(string: "https://hub.example.com/")!, token: "a\"b'c</script>")
        let script = HubView.tokenScript(account)
        XCTAssertTrue(script.contains("if (location.origin !== \"https://hub.example.com\") return;"))
        XCTAssertTrue(script.contains("var saved = \"a\\\"b'c</script>\";"), script)
        XCTAssertTrue(script.contains("localStorage.setItem(key, saved);"), "the page gets the saved token")
        XCTAssertFalse(script.contains("\"a\"b"), "the token never ends the string early")
    }

    func testPushTokenIsHex() {
        XCTAssertEqual(Push.hex(Data([0x00, 0xab, 0xff])), "00abff")
    }

    func testDictatedWordsReachThePageEscaped() {
        let call = HubView.Coordinator.dictationCall(text: "it's \"done\" </script>", final: false, error: nil)
        XCTAssertEqual(call, "window.trialogDictation && window.trialogDictation.apply(null, [\"it's \\\"done\\\" </script>\",false,null]);")
        let failed = HubView.Coordinator.dictationCall(text: "", final: true, error: "The microphone is off")
        XCTAssertTrue(failed.hasSuffix("[\"\",true,\"The microphone is off\"]);"), failed)
    }

    func testFaceIDCancelledByIOSAsksAgainWithoutTheLockedMessage() {
        XCTAssertNil(Unlock.messageAfter(LAError(.systemCancel)), "iOS cancelled: ask again, no message")
        XCTAssertNil(Unlock.messageAfter(LAError(.appCancel)))
        XCTAssertNotNil(Unlock.messageAfter(LAError(.userCancel)), "you cancelled: the Unlock button shows")
        XCTAssertNotNil(Unlock.messageAfter(LAError(.authenticationFailed)))
        XCTAssertNotNil(Unlock.messageAfter(nil))
    }

    func testAFreshInstallClearsALeftoverAccountOnce() {
        let suite = "test.trialog.fresh-install.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suite) else {
            return XCTFail("could not make a UserDefaults suite")
        }
        defaults.removePersistentDomain(forName: suite)
        var cleared = 0
        AccountLaunch.prepareAccount(defaults: defaults, clear: { cleared += 1 })
        XCTAssertEqual(cleared, 1)
        XCTAssertTrue(defaults.bool(forKey: AccountLaunch.didLaunchBeforeKey))
        AccountLaunch.prepareAccount(defaults: defaults, clear: { cleared += 1 })
        XCTAssertEqual(cleared, 1, "a later launch leaves the account")
        defaults.removePersistentDomain(forName: suite)
    }

    func testAReinstallClearsALeftoverAccount() {
        let suite = "test.trialog.reinstall.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suite) else {
            return XCTFail("could not make a UserDefaults suite")
        }
        defaults.removePersistentDomain(forName: suite)
        var cleared = 0
        AccountLaunch.prepareAccount(defaults: defaults, clear: { cleared += 1 })
        XCTAssertEqual(cleared, 1)
        // Uninstall wipes UserDefaults but leaves the Keychain.
        defaults.removePersistentDomain(forName: suite)
        AccountLaunch.prepareAccount(defaults: defaults, clear: { cleared += 1 })
        XCTAssertEqual(cleared, 2, "a reinstall starts at Setup")
        XCTAssertTrue(defaults.bool(forKey: AccountLaunch.didLaunchBeforeKey))
        defaults.removePersistentDomain(forName: suite)
    }

    func testPushUnregisterIsDeleteWithTheToken() {
        let account = HubAccount(hubURL: URL(string: "https://hub.example.com/")!, token: "test-token-16chars")
        let request = Push.unregisterRequest(account: account, tokenHex: "00abff")
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.absoluteString, "https://hub.example.com/api/push/devices")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token-16chars")
        let body = try! JSONSerialization.jsonObject(with: request.httpBody!) as! [String: String]
        XCTAssertEqual(body, ["token": "00abff"])
    }

    func testPushRegisterIsPostWithTheTokenAndEnv() {
        let account = HubAccount(hubURL: URL(string: "https://hub.example.com/")!, token: "test-token-16chars")
        let request = Push.registerRequest(account: account, tokenHex: "00abff")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://hub.example.com/api/push/devices")
        let body = try! JSONSerialization.jsonObject(with: request.httpBody!) as! [String: String]
        XCTAssertEqual(body["token"], "00abff")
        XCTAssertEqual(body["platform"], "ios")
        XCTAssertTrue(body["env"] == "sandbox" || body["env"] == "production", body["env"] ?? "missing")
    }

    func testRememberedDeviceTokenIsWhatUnregisterWouldSend() {
        let suite = "test.trialog.apns.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suite) else {
            return XCTFail("could not make a UserDefaults suite")
        }
        defaults.removePersistentDomain(forName: suite)
        Push.rememberDeviceToken(Data([0x00, 0xab, 0xff]), defaults: defaults)
        XCTAssertEqual(defaults.string(forKey: Push.lastTokenKey), "00abff")
        defaults.removePersistentDomain(forName: suite)
    }
}
