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
}
