/**
 * Voice transcription with native ONNX Runtime (fast) and Python fallback.
 */
import { existsSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { exec, spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { transcribeNative, isNativeVoiceAvailable, getVoiceNativeStatus } from "./voice-native";

const HOME = homedir();

function findFirst(candidates: string[]): string | null {
	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	return null;
}

const PARAKEET_BIN = findFirst([
	join(HOME, ".bin", "parakeet-transcribe"),
	"/usr/local/bin/parakeet-transcribe",
]);
const PARAKEET_MODEL = findFirst([
	join(HOME, ".local", "share", "parakeet-tdt-0.6b-v3-int8"),
	"/usr/local/share/parakeet-tdt-0.6b-v3-int8",
]);
const FFMPEG_TIMEOUT = 15_000;
const TRANSCRIBE_TIMEOUT = 120_000;

function cleanup(...paths: string[]) {
	for (const p of paths) {
		try { unlinkSync(p); } catch {}
	}
}

function ffmpegConvert(inputPath: string, outputPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		exec(
			`ffmpeg -y -i ${JSON.stringify(inputPath)} -ar 16000 -ac 1 -c:a pcm_s16le ${JSON.stringify(outputPath)}`,
			{ timeout: FFMPEG_TIMEOUT },
			(err) => err ? reject(new Error(`ffmpeg failed: ${err.message}`)) : resolve(),
		);
	});
}

function parakeetTranscribePython(wavPath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn("python3", [PARAKEET_BIN!, wavPath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });

		const timer = setTimeout(() => { proc.kill(); reject(new Error("Transcription timed out")); }, TRANSCRIBE_TIMEOUT);

		proc.on("close", (code) => {
			clearTimeout(timer);
			const text = stdout.trim();
			if (code === 0 && text) {
				resolve(text);
			} else {
				reject(new Error(code === 0 ? "Empty transcription" : `Parakeet exited with code ${code}`));
			}
		});
		proc.on("error", (err) => { clearTimeout(timer); reject(err); });
	});
}

async function readWavPcm(wavPath: string): Promise<{ data: Buffer; sampleRate: number }> {
	// Simple WAV parser - assumes 16-bit PCM
	const buf = readFileSync(wavPath);
	
	// Check RIFF header
	if (buf.toString("ascii", 0, 4) !== "RIFF") {
		throw new Error("Invalid WAV file: no RIFF header");
	}
	
	// Check WAVE format
	if (buf.toString("ascii", 8, 12) !== "WAVE") {
		throw new Error("Invalid WAV file: not WAVE format");
	}
	
	// Find fmt chunk
	let offset = 12;
	while (offset < buf.length) {
		const chunkId = buf.toString("ascii", offset, offset + 4);
		const chunkSize = buf.readUInt32LE(offset + 4);
		
		if (chunkId === "fmt ") {
			const audioFormat = buf.readUInt16LE(offset + 8);
			const numChannels = buf.readUInt16LE(offset + 10);
			const sampleRate = buf.readUInt32LE(offset + 12);
			const bitsPerSample = buf.readUInt16LE(offset + 22);
			
			if (audioFormat !== 1) { // PCM
				throw new Error(`Unsupported WAV format: ${audioFormat} (expected PCM=1)`);
			}
			if (bitsPerSample !== 16) {
				throw new Error(`Unsupported bits per sample: ${bitsPerSample} (expected 16)`);
			}
			if (numChannels !== 1) {
				throw new Error(`Unsupported channels: ${numChannels} (expected 1)`);
			}
			
			// Find data chunk
			let dataOffset = offset + 8 + chunkSize;
			while (dataOffset < buf.length) {
				const dataChunkId = buf.toString("ascii", dataOffset, dataOffset + 4);
				const dataChunkSize = buf.readUInt32LE(dataOffset + 4);
				
				if (dataChunkId === "data") {
					const pcmData = buf.subarray(dataOffset + 8, dataOffset + 8 + dataChunkSize);
					return { data: pcmData, sampleRate };
				}
				dataOffset += 8 + dataChunkSize;
			}
			throw new Error("No data chunk found in WAV file");
		}
		
		offset += 8 + chunkSize;
	}
	
	throw new Error("No fmt chunk found in WAV file");
}

export async function transcribeAudio(audioBuffer: Buffer): Promise<{ ok: true; text: string }> {
	const id = randomUUID().slice(0, 8);
	const inputPath = join(tmpdir(), `pi-voice-${id}.webm`);
	const wavPath = join(tmpdir(), `pi-voice-${id}.wav`);

	try {
		writeFileSync(inputPath, audioBuffer);
		await ffmpegConvert(inputPath, wavPath);

		// Try native first (fast, models cached)
		if (isNativeVoiceAvailable()) {
			try {
				const { data, sampleRate } = await readWavPcm(wavPath);
				const text = await transcribeNative(data, sampleRate);
				return { ok: true, text };
			} catch (nativeErr) {
				console.warn("[voice] Native transcription failed, falling back to Python:", nativeErr);
				// Fall through to Python
			}
		}

		// Python fallback
		if (!PARAKEET_BIN || !PARAKEET_MODEL) {
			throw new Error("Parakeet not available on this server");
		}
		const text = await parakeetTranscribePython(wavPath);
		return { ok: true, text };
	} finally {
		cleanup(inputPath, wavPath);
	}
}

export function getVoiceStatus() {
	return {
		native: getVoiceNativeStatus(),
		python: {
			available: !!(PARAKEET_BIN && PARAKEET_MODEL),
			bin: PARAKEET_BIN,
			model: PARAKEET_MODEL,
		},
	};
}
