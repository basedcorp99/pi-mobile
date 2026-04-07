// Web Speech API transcription provider - fast but less accurate than Parakeet
// Good for quick drafts, multi-language support varies by browser

export function createWebSpeechTranscriber({ onResult, onError, onEnd }) {
	const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
	
	if (!SpeechRecognition) {
		return {
			isSupported: () => false,
			start: () => { throw new Error("Web Speech API not supported"); },
			stop: () => {},
		};
	}

	let recognition = null;
	let finalTranscript = "";
	let isActive = false;

	function createRecognition() {
		const rec = new SpeechRecognition();
		rec.continuous = true;
		rec.interimResults = true;
		rec.lang = "auto"; // Let browser detect language (best effort)
		
		rec.onstart = () => {
			isActive = true;
			finalTranscript = "";
		};
		
		rec.onresult = (event) => {
			let interim = "";
			for (let i = event.resultIndex; i < event.results.length; i++) {
				const transcript = event.results[i][0].transcript;
				if (event.results[i].isFinal) {
					finalTranscript += transcript;
				} else {
					interim += transcript;
				}
			}
			// Send combined final + interim for live feedback
			onResult?.(finalTranscript + interim, false);
		};
		
		rec.onerror = (event) => {
			// Don't error on no-speech (user just didn't speak yet)
			if (event.error === "no-speech") return;
			// Aborted is expected when we call stop()
			if (event.error === "aborted") return;
			onError?.(event.error);
		};
		
		rec.onend = () => {
			isActive = false;
			onEnd?.(finalTranscript);
		};
		
		return rec;
	}

	return {
		isSupported: () => true,
		
		start() {
			if (isActive) return;
			recognition = createRecognition();
			recognition.start();
		},
		
		stop() {
			if (!recognition || !isActive) return;
			try {
				recognition.stop();
			} catch {
				// Ignore errors on stop
			}
		},
		
		isActive: () => isActive,
	};
}

export function isWebSpeechSupported() {
	return "SpeechRecognition" in window || "webkitSpeechRecognition" in window;
}
