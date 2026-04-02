import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { exec, spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const PARAKEET_BIN = "/usr/local/bin/parakeet-transcribe";
const PARAKEET_MODEL = "/usr/local/share/parakeet-tdt-0.6b-v3-int8";
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

function parakeetTranscribe(wavPath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn("python3", [PARAKEET_BIN, wavPath], {
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

export async function transcribeAudio(audioBuffer: Buffer): Promise<{ ok: true; text: string }> {
	if (!existsSync(PARAKEET_BIN) || !existsSync(PARAKEET_MODEL)) {
		throw new Error("Parakeet not available on this server");
	}

	const id = randomUUID().slice(0, 8);
	const inputPath = join(tmpdir(), `pi-voice-${id}.webm`);
	const wavPath = join(tmpdir(), `pi-voice-${id}.wav`);

	try {
		writeFileSync(inputPath, audioBuffer);
		await ffmpegConvert(inputPath, wavPath);
		const text = await parakeetTranscribe(wavPath);
		return { ok: true, text };
	} finally {
		cleanup(inputPath, wavPath);
	}
}
