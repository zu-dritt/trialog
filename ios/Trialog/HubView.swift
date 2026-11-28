import SwiftUI
import WebKit

/// The hub itself, in a web view: everything the browser page does comes along. The app adds what a
/// page can't: the token from the Keychain (handed to the page before it loads), Face ID in front of
/// it, and push. Links to other sites open in Safari.
struct HubView: UIViewRepresentable {
    let account: HubAccount

    /// The key the hub page keeps its token under (app/page.tsx, TOKEN_KEY).
    static let tokenKey = "collabHubToken"

    func makeCoordinator() -> Coordinator { Coordinator(account: account) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        // The hub's chime may play without a tap first.
        config.mediaTypesRequiringUserActionForPlayback = []
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(source: Self.tokenScript(account), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.add(context.coordinator, name: "trialog")
        config.userContentController = controller

        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
        view.isOpaque = false
        view.backgroundColor = UIColor(red: 0.06, green: 0.07, blue: 0.08, alpha: 1)
        view.scrollView.contentInsetAdjustmentBehavior = .automatic
        #if DEBUG
        view.isInspectable = true
        #endif
        view.load(URLRequest(url: account.hubURL))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    /// Before the hub's own scripts run: put the token where the page looks for it, on the hub's own
    /// origin only. When you give the page another token (its own form, after «Switch token» or a
    /// refused one), the app keeps that one in the Keychain instead. The page dropping its token
    /// changes nothing in the Keychain: the next start hands the saved one over again.
    static func tokenScript(_ account: HubAccount) -> String {
        let origin = account.hubURL.absoluteString.hasSuffix("/") ? String(account.hubURL.absoluteString.dropLast()) : account.hubURL.absoluteString
        let json = { (s: String) -> String in
            let data = try? JSONSerialization.data(withJSONObject: [s], options: [.withoutEscapingSlashes])
            let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
            return String(text.dropFirst().dropLast())
        }
        return """
        (function () {
          if (location.origin !== \(json(origin))) return;
          var key = \(json(tokenKey));
          var saved = \(json(account.token));
          try { localStorage.setItem(key, saved); } catch (e) {}
          var set = Storage.prototype.setItem;
          Storage.prototype.setItem = function (k, v) {
            set.apply(this, arguments);
            if (this === localStorage && k === key && typeof v === 'string' && v && v !== saved) {
              saved = v;
              window.webkit.messageHandlers.trialog.postMessage({ type: 'token', token: v });
            }
          };
        })();
        """
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let account: HubAccount
        private lazy var dictation = Dictation()
        init(account: HubAccount) { self.account = account }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            // Only the hub's own page may talk to the app.
            guard message.frameInfo.isMainFrame, sameOrigin(message.frameInfo.securityOrigin),
                  let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            if type == "token", let token = body["token"] as? String {
                let cleaned = HubAccount.cleanToken(token)
                if !cleaned.isEmpty { AccountStore.save(HubAccount(hubURL: account.hubURL, token: cleaned)) }
            }
            if type == "dictate", let action = body["action"] as? String {
                if action == "stop" { return dictation.stop() }
                guard action == "start" else { return }
                // The team's names as hints for the recogniser (playground #1455), at most 30 short words.
                let words = (body["words"] as? [Any] ?? []).compactMap { $0 as? String }.filter { !$0.isEmpty && $0.count <= 40 }.prefix(30)
                dictation.start(hints: Array(words)) { [weak view = message.webView] text, final, error in
                    view?.evaluateJavaScript(Self.dictationCall(text: text, final: final, error: error))
                }
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.cancel) }
            // The hub's own pages (and the roadmap) stay in the app; everything else opens in Safari.
            if url.host == account.hubURL.host && url.scheme == account.hubURL.scheme {
                return decisionHandler(.allow)
            }
            if action.navigationType == .linkActivated || action.targetFrame == nil {
                UIApplication.shared.open(url)
                return decisionHandler(.cancel)
            }
            decisionHandler(url.scheme == "about" ? .allow : .cancel)
        }

        /// The page's callback (app/dictation.ts, window.trialogDictation) with the words so far.
        nonisolated static func dictationCall(text: String, final: Bool, error: String?) -> String {
            let args: [Any] = [text, final, error ?? NSNull()]
            let data = (try? JSONSerialization.data(withJSONObject: args, options: [.withoutEscapingSlashes])) ?? Data("[\"\",true,null]".utf8)
            let list = String(data: data, encoding: .utf8) ?? "[\"\",true,null]"
            return "window.trialogDictation && window.trialogDictation.apply(null, \(list));"
        }

        private func sameOrigin(_ origin: WKSecurityOrigin) -> Bool {
            origin.protocol == account.hubURL.scheme && origin.host == account.hubURL.host
        }
    }
}
