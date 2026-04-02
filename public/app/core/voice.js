import { enqueueVoiceJob, listVoiceJobs, removeVoiceJob } from "./voice_queue.js";

export function createVoiceRecorder({ api, onTranscription, onNotice, onStateChange }) {
	const MIC_STREAM_KEEPALIVE_MS = 10 * 60 * 1000;

	let mediaRecorder = null;
	let micStream = null;
	let micReleaseTimer = null;
	let chunks = [];
	let recording = false;
	let transcribing = false;
	let recordingStartTime = 0;
	let wakeLockSentinel = null;
	let micPermissionPrimed = false;

	function isSupported() {
		return Boolean(navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined");
	}

	function isRecording() { return recording; }
	function isTranscribing() { return transcribing; }

	function getDuration() {
		if (!recording) return 0;
		return Math.round((Date.now() - recordingStartTime) / 1000);
	}

	function clearMicReleaseTimer() {
		if (!micReleaseTimer) return;
		clearTimeout(micReleaseTimer);
		micReleaseTimer = null;
	}

	function hasLiveMicStream(stream = micStream) {
		return Boolean(stream && stream.getAudioTracks().some((track) => track.readyState === "live"));
	}

	function releaseMicStream() {
		clearMicReleaseTimer();
		if (!micStream) return;
		const stream = micStream;
		micStream = null;
		stream.getTracks().forEach((track) => {
			try {
				track.stop();
			} catch {
				// ignore
			}
		});
		onStateChange?.();
	}

	function scheduleMicRelease(delay = MIC_STREAM_KEEPALIVE_MS) {
		clearMicReleaseTimer();
		if (recording || !hasLiveMicStream()) return;
		micReleaseTimer = setTimeout(() => {
			micReleaseTimer = null;
			releaseMicStream();
		}, delay);
	}

	async function getMicrophoneStream() {
		if (hasLiveMicStream()) {
			clearMicReleaseTimer();
			micPermissionPrimed = true;
			return { stream: micStream, promptedForPermission: false, reused: true };
		}

		const permissionBefore = micPermissionPrimed ? "granted" : await getMicrophonePermissionState();
		const requestedAt = Date.now();
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		const promptedForPermission = permissionBefore === "prompt"
			|| (!micPermissionPrimed && Date.now() - requestedAt > 500);
		micPermissionPrimed = true;
		micStream = stream;
		clearMicReleaseTimer();
		return { stream, promptedForPermission, reused: false };
	}

	async function acquireWakeLock() {
		if (!recording) return;
		if (!navigator.wakeLock?.request) return;
		if (wakeLockSentinel) return;
		try {
			wakeLockSentinel = await navigator.wakeLock.request("screen");
			wakeLockSentinel.addEventListener("release", () => {
				wakeLockSentinel = null;
			});
		} catch {
			wakeLockSentinel = null;
		}
	}

	async function releaseWakeLock() {
		if (!wakeLockSentinel) return;
		try {
			await wakeLockSentinel.release();
		} catch {
			// ignore
		} finally {
			wakeLockSentinel = null;
		}
	}

	async function transcribeQueuedJob(job, options = {}) {
		if (!job || transcribing) return false;
		transcribing = true;
		onStateChange?.();
		try {
			const formData = new FormData();
			const fileName = job.mimeType === "audio/mp4" ? "voice.mp4" : "voice.webm";
			formData.append("audio", job.blob, fileName);
			const result = await api.postFormData("/api/voice/transcribe", formData);
			if (result.ok && result.text) {
				onTranscription(result.text);
				await removeVoiceJob(job.id);
				return true;
			}
			if (!options.silent) onNotice?.("Transcription returned empty.", "error");
			return false;
		} catch (error) {
			if (!options.silent) onNotice?.(error instanceof Error ? error.message : String(error), "error");
			return false;
		} finally {
			transcribing = false;
			onStateChange?.();
		}
	}

	async function resumePending(options = {}) {
		if (recording || transcribing) return false;
		try {
			const jobs = await listVoiceJobs();
			if (jobs.length === 0) return false;
			if (!options.silent) onNotice?.("Riprendo la trascrizione del messaggio vocale…", "info");
			for (const job of jobs) {
				await transcribeQueuedJob(job, { silent: options.silent });
			}
			return true;
		} catch (error) {
			if (!options.silent) onNotice?.(error instanceof Error ? error.message : String(error), "error");
			return false;
		}
	}

	async function getMicrophonePermissionState() {
		if (!navigator.permissions?.query) return null;
		try {
			const status = await navigator.permissions.query({ name: "microphone" });
			return typeof status?.state === "string" ? status.state : null;
		} catch {
			return null;
		}
	}

	async function start() {
		if (recording) return { started: true };
		if (!isSupported()) {
			onNotice?.("Voice recording not supported in this browser.", "error");
			return { started: false };
		}

		try {
			const { stream, promptedForPermission } = await getMicrophoneStream();
			const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
				? "audio/webm;codecs=opus"
				: MediaRecorder.isTypeSupported("audio/webm")
					? "audio/webm"
					: MediaRecorder.isTypeSupported("audio/mp4")
						? "audio/mp4"
						: "";

			if (!mimeType) {
				scheduleMicRelease();
				onNotice?.("No supported audio format found.", "error");
				return { started: false };
			}

			chunks = [];
			clearMicReleaseTimer();
			mediaRecorder = new MediaRecorder(stream, { mimeType });
			mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
			mediaRecorder.onstop = async () => {
				mediaRecorder = null;
				recording = false;
				await releaseWakeLock();
				scheduleMicRelease();
				onStateChange?.();

				if (chunks.length === 0) {
					onNotice?.("No audio captured.", "error");
					return;
				}

				const blob = new Blob(chunks, { type: mimeType });
				chunks = [];

				if (blob.size < 1000) {
					onNotice?.("Recording too short.", "error");
					return;
				}

				try {
					await enqueueVoiceJob(blob, mimeType);
					await resumePending({ silent: true });
				} catch (error) {
					onNotice?.(error instanceof Error ? error.message : String(error), "error");
				}
			};

			mediaRecorder.onerror = async () => {
				recording = false;
				mediaRecorder = null;
				await releaseWakeLock();
				scheduleMicRelease();
				onStateChange?.();
			};

			mediaRecorder.start();
			recording = true;
			recordingStartTime = Date.now();
			await acquireWakeLock();
			onStateChange?.();
			if (promptedForPermission) {
				onNotice?.("Microphone authorized — keeping the permission warm for the next few minutes.", "info");
			}
			return { started: true };
		} catch (error) {
			recording = false;
			mediaRecorder = null;
			await releaseWakeLock();
			scheduleMicRelease();
			onNotice?.(error instanceof Error ? error.message : String(error), "error");
			return { started: false };
		}
	}

	function stop() {
		if (!recording || !mediaRecorder) return;
		if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
	}

	function toggle() {
		if (recording) stop();
		else void start();
	}

	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") {
			if (!recording) releaseMicStream();
			return;
		}
		if (document.visibilityState === "visible" && recording && !wakeLockSentinel) {
			void acquireWakeLock();
		}
	});
	window.addEventListener("pagehide", () => {
		if (!recording) releaseMicStream();
	});

	return { isSupported, isRecording, isTranscribing, getDuration, start, stop, toggle, resumePending };
}
