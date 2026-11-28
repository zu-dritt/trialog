import AVFoundation
import Speech

/// «Speak» in the hub's message box (playground #1178): Apple's speech recognition, on the phone itself
/// where the phone supports it, so nothing is paid for and the words stay on the device. It hands back
/// everything heard so far as you speak; the page puts it into the box, and you read it before Send.
@MainActor
final class Dictation {
    /// The words so far, whether this is the last update, and a problem in words when it couldn't listen.
    typealias Update = (_ text: String, _ final: Bool, _ error: String?) -> Void

    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var update: Update?
    private var heard = ""

    var isListening: Bool { task != nil }

    func start(_ update: @escaping Update) {
        stop()
        self.update = update
        heard = ""
        SFSpeechRecognizer.requestAuthorization { status in
            Task { @MainActor in
                guard status == .authorized else {
                    return self.fail("Speech recognition is off for Trialog. Settings → Trialog → Speech Recognition.")
                }
                AVAudioApplication.requestRecordPermission { granted in
                    Task { @MainActor in
                        guard granted else { return self.fail("The microphone is off for Trialog. Settings → Trialog → Microphone.") }
                        self.listen()
                    }
                }
            }
        }
    }

    func stop() {
        guard task != nil || engine.isRunning else { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        // The last words arrive as the final result, then `finish` tidies up.
    }

    private func listen() {
        // The phone's language first; English when the phone's can't be recognised.
        guard let recognizer = SFSpeechRecognizer() ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")), recognizer.isAvailable else {
            return fail("Speech recognition isn't available right now.")
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            return fail("The microphone couldn't start.")
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        self.request = request

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else { return fail("No microphone found.") }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }

        task = recognizer.recognitionTask(with: request) { result, error in
            Task { @MainActor in
                if let result {
                    self.heard = result.bestTranscription.formattedString
                    self.update?(self.heard, result.isFinal, nil)
                    if result.isFinal { self.finish() }
                } else if error != nil {
                    // Stopped before anything was said, or the recogniser gave up: keep what was heard.
                    self.update?(self.heard, true, nil)
                    self.finish()
                }
            }
        }

        engine.prepare()
        do { try engine.start() } catch {
            input.removeTap(onBus: 0)
            return fail("The microphone couldn't start.")
        }
        // A minute at most: the recogniser stops on its own after about that anyway.
        let current = task
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(60))
            if self.task === current { self.stop() }
        }
    }

    private func fail(_ message: String) {
        update?(heard, true, message)
        finish()
    }

    private func finish() {
        if engine.isRunning {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        task?.cancel()
        task = nil
        request = nil
        update = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
