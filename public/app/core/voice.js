import { enqueueVoiceJob, listVoiceJobs, removeVoiceJob, updateVoiceJob } from "./voice_queue.js";
import { createWebSpeechTranscriber, isWebSpeechSupported } from "./web-speech.js";

export function createVoiceRecorder({ api, onTranscription, onNotice, onStateChange, onJobQueued, useWebSpeech = false }) {
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
	let pendingJobMeta = null;

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
			const result = await transcribeQueuedJobInternal(job, options);
			return result;
		} catch (error) {
			// Clean up failed job
			if (job.id) await removeVoiceJob(job.id);
			if (!options.silent) onNotice?.(error instanceof Error ? error.message : String(error), "error");
			return false;
		} finally {
			transcribing = false;
			onStateChange?.();
		}
	}

	async function resumePending(options = {}) {
		if (recording || transcribing) return false;
		const jobs = await listVoiceJobs();
		if (jobs.length === 0) return false;

		transcribing = true;
		onStateChange?.();
		try {
			if (!options.silent) onNotice?.("Riprendo la trascrizione del messaggio vocale…", "info");

			// Process in parallel but preserve ordering for delivery
			// Each job transcribes in parallel, but we deliver results in original order
			const results = await Promise.all(
				jobs.map(async (job, index) => {
					try {
						const result = await transcribeQueuedJobInternal(job, { silent: true });
						return { index, job, result, error: null };
					} catch (error) {
						// Clean up failed job immediately
						if (job.id) await removeVoiceJob(job.id);
						return { index, job, result: null, error };
					}
				})
			);

			// Deliver in original order to preserve transcript sequence
			for (const { index, job, result, error } of results.sort((a, b) => a.index - b.index)) {
				if (error && !options.silent) {
					onNotice?.(error instanceof Error ? error.message : String(error), "error");
				}
				// Result already delivered by transcribeQueuedJobInternal on success
			}

			return true;
		} catch (error) {
			if (!options.silent) onNotice?.(error instanceof Error ? error.message : String(error), "error");
			return false;
		} finally {
			transcribing = false;
			onStateChange?.();
		}
	}
	
	// Internal version that doesn't set global transcribing state (allows parallel)
	async function transcribeQueuedJobInternal(job, options = {}) {
		const deliverTranscript = async (text, sourceJob) => {
			if (typeof text !== "string" || !text.trim()) {
				if (!options.silent) onNotice?.("Transcription returned empty.", "error");
				return false;
			}
			const handled = await onTranscription?.(text, sourceJob || job);
			if (handled === false) return false;
			if (job.id) await removeVoiceJob(job.id);
			return true;
		};

		if (typeof job.transcript === "string" && job.transcript.trim()) {
			return await deliverTranscript(job.transcript, job);
		}

		const formData = new FormData();
		const fileName = job.mimeType === "audio/mp4" ? "voice.mp4" : "voice.webm";
		formData.append("audio", job.blob, fileName);
		const result = await api.postFormData("/api/voice/transcribe", formData);
		if (result.ok && result.text) {
			const nextJob = job.id
				? (await updateVoiceJob(job.id, { transcript: result.text, transcriptAt: Date.now() })) || { ...job, transcript: result.text }
				: { ...job, transcript: result.text, transcriptAt: Date.now() };
			return await deliverTranscript(result.text, nextJob);
		}
		if (!options.silent) onNotice?.("Transcription returned empty.", "error");
		return false;
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

	async function start(options = {}) {
		if (recording) return { started: true };
		if (!isSupported()) {
			onNotice?.("Voice recording not supported in this browser.", "error");
			return { started: false };
		}

		try {
			pendingJobMeta = options && typeof options.jobMeta === "object" && options.jobMeta
				? { ...options.jobMeta }
				: null;
			const { stream, promptedForPermission } = await getMicrophoneStream();
			const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
				? "audio/webm;codecs=opus"
				: MediaRecorder.isTypeSupported("audio/webm")
					? "audio/webm"
					: MediaRecorder.isTypeSupported("audio/mp4")
						? "audio/mp4"
						: "";

			if (!mimeType) {
				pendingJobMeta = null;
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
					pendingJobMeta = null;
					onNotice?.("No audio captured.", "error");
					return;
				}

				const blob = new Blob(chunks, { type: mimeType });
				chunks = [];

				if (blob.size < 1000) {
					pendingJobMeta = null;
					onNotice?.("Recording too short.", "error");
					return;
				}

				try {
					const metadata = pendingJobMeta && typeof pendingJobMeta === "object" ? pendingJobMeta : {};
					pendingJobMeta = null;
					const createdAt = Date.now();
					const jobId = await enqueueVoiceJob(blob, mimeType, metadata);
					const job = {
						id: jobId,
						blob,
						mimeType,
						createdAt,
						...metadata,
					};
					if (jobId) await onJobQueued?.(job);
					if (jobId) await resumePending({ silent: true });
					else await transcribeQueuedJob(job, { silent: true });
				} catch (error) {
					pendingJobMeta = null;
					onNotice?.(error instanceof Error ? error.message : String(error), "error");
				}
			};

			mediaRecorder.onerror = async () => {
				pendingJobMeta = null;
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
				onNotice?.("Microphone authorized.", "info");
			}
			return { started: true };
		} catch (error) {
			pendingJobMeta = null;
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
