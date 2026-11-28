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

    func testTheTokenGoesOnlyToTheHubsOwnOriginAndIsEscaped() {
        let account = HubAccount(hubURL: URL(string: "https://hub.example.com/")!, token: "a\"b'c</script>")
        let script = HubView.tokenScript(account)
        XCTAssertTrue(script.contains("if (location.origin !== \"https://hub.example.com\") return;"))
        XCTAssertTrue(script.contains("localStorage.setItem(key, \"a\\\"b'c</script>\");"), script)
        XCTAssertFalse(script.contains("\"a\"b"), "the token never ends the string early")
    }

    func testPushTokenIsHex() {
        XCTAssertEqual(Push.hex(Data([0x00, 0xab, 0xff])), "00abff")
    }
}
