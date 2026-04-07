/**
 * Native Parakeet transcription using ONNX Runtime Node.js bindings.
 * Runs directly in Bun - no Python process needed.
 * Models are loaded once and cached for subsequent transcriptions.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import * as ort from "onnxruntime-node";

const HOME = homedir();

// Model paths
const MODEL_DIR =
	existsSync(join(HOME, ".local/share/parakeet-tdt-0.6b-v3-int8"))
		? join(HOME, ".local/share/parakeet-tdt-0.6b-v3-int8")
		: "/usr/local/share/parakeet-tdt-0.6b-v3-int8";

// Constants
const LEADING_SILENCE_MS = 250;
const MAX_TOKENS_PER_STEP = 10;

interface ModelCache {
	pp?: ort.InferenceSession;
	enc?: ort.InferenceSession;
	dj?: ort.InferenceSession;
	tokens?: Map<number, string>;
	V?: number;
	BL?: number;
	loaded?: boolean;
	loading?: boolean;
	error?: string;
}

const cache: ModelCache = {};

function getModelPaths() {
	return {
		pp: join(MODEL_DIR, "nemo128.onnx"),
		enc: join(MODEL_DIR, "encoder-model.int8.onnx"),
		dj: join(MODEL_DIR, "decoder_joint-model.int8.onnx"),
		vocab: join(MODEL_DIR, "vocab.txt"),
	};
}

export function isNativeVoiceAvailable(): boolean {
	const paths = getModelPaths();
	return existsSync(paths.pp) && existsSync(paths.enc) && existsSync(paths.dj) && existsSync(paths.vocab);
}

export async function loadModels(): Promise<void> {
	if (cache.loaded) return;
	if (cache.loading) {
		// Wait for existing load
		while (cache.loading) {
			await new Promise((r) => setTimeout(r, 50));
		}
		if (cache.error) throw new Error(cache.error);
		return;
	}

	cache.loading = true;
	console.log("[voice-native] Loading Parakeet models...");

	try {
		const paths = getModelPaths();

		// Check all files exist
		for (const [name, path] of Object.entries(paths)) {
			if (!existsSync(path)) {
				throw new Error(`Model file not found: ${path}`);
			}
		}

		// Load ONNX sessions (these are heavyweight - cache them!)
		// Use CPU provider - works everywhere
		const sessionOptions: ort.InferenceSession.SessionOptions = {
			executionProviders: ["cpu"],
			graphOptimizationLevel: "all",
		};

		cache.pp = await ort.InferenceSession.create(paths.pp, sessionOptions);
		cache.enc = await ort.InferenceSession.create(paths.enc, sessionOptions);
		cache.dj = await ort.InferenceSession.create(paths.dj, sessionOptions);

		// Load vocabulary
		const vocabText = readFileSync(paths.vocab, "utf-8");
		cache.tokens = new Map();
		for (const [i, line] of vocabText.split("\n").entries()) {
			const token = line.trim().split(/\s+/)[0];
			if (token) cache.tokens.set(i, token);
		}
		cache.V = cache.tokens.size;
		cache.BL = cache.V - 1;
		cache.loaded = true;

		console.log("[voice-native] Models loaded successfully");
	} catch (err) {
		cache.error = err instanceof Error ? err.message : String(err);
		console.error("[voice-native] Failed to load models:", cache.error);
		throw err;
	} finally {
		cache.loading = false;
	}
}

function preprocessAudio(pcmData: Buffer, sampleRate: number): Float32Array {
	// Convert int16 PCM to float32 [-1, 1]
	const samples = new Float32Array(pcmData.length / 2);
	const view = new DataView(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength);
	for (let i = 0; i < samples.length; i++) {
		samples[i] = view.getInt16(i * 2, true) / 32768.0;
	}

	// Add leading silence
	const silenceSamples = Math.floor((sampleRate * LEADING_SILENCE_MS) / 1000);
	const withSilence = new Float32Array(silenceSamples + samples.length);
	withSilence.fill(0, 0, silenceSamples);
	withSilence.set(samples, silenceSamples);

	return withSilence;
}

export async function transcribeNative(pcmData: Buffer, sampleRate: number): Promise<string> {
	if (!cache.loaded) {
		await loadModels();
	}

	if (!cache.pp || !cache.enc || !cache.dj || !cache.tokens || cache.V === undefined || cache.BL === undefined) {
		throw new Error("Models not loaded");
	}

	// Preprocess
	const samples = preprocessAudio(pcmData, sampleRate);

	// Run preprocessing ONNX model
	const ppInputs = {
		waveforms: new ort.Tensor("float32", samples, [1, samples.length]),
		waveforms_lens: new ort.Tensor("int64", BigInt(samples.length), [1]),
	};
	const ppResults = await cache.pp.run(ppInputs);
	const feat = ppResults.output0 as ort.Tensor;
	const fl = ppResults.output1 as ort.Tensor;

	// Run encoder
	const encInputs = {
		audio_signal: feat,
		length: fl,
	};
	const encResults = await cache.enc.run(encInputs);
	const eoRaw = encResults.output0 as ort.Tensor;

	// Transpose: [batch, hidden, time] -> [batch, time, hidden]
	const [B, H, T] = eoRaw.dims as [number, number, number];
	const eoData = new Float32Array(B * T * H);
	const eoRawData = eoRaw.data as Float32Array;
	for (let b = 0; b < B; b++) {
		for (let t = 0; t < T; t++) {
			for (let h = 0; h < H; h++) {
				eoData[b * T * H + t * H + h] = eoRawData[b * H * T + h * T + t];
			}
		}
	}

	// Decode token by token
	const prevTokens: number[] = [];
	const resultTokens: number[] = [];
	const ds = new Float32Array(2 * 1 * 640).fill(0);
	const di = new Float32Array(2 * 1 * 640).fill(0);

	for (let tIdx = 0; tIdx < T; tIdx++) {
		// Extract encoder output for this timestep
		const encInData = new Float32Array(H);
		for (let h = 0; h < H; h++) {
			encInData[h] = eoData[tIdx * H + h];
		}

		let emitted = 0;
		while (emitted < MAX_TOKENS_PER_STEP) {
			const lastTok = prevTokens.length > 0 ? prevTokens[prevTokens.length - 1] : cache.BL;

			const djInputs = {
				encoder_outputs: new ort.Tensor("float32", encInData, [1, H, 1]),
				targets: new ort.Tensor("int32", new Int32Array([lastTok]), [1, 1]),
				target_length: new ort.Tensor("int32", new Int32Array([1]), [1]),
				input_states_1: new ort.Tensor("float32", ds, [2, 1, 640]),
				input_states_2: new ort.Tensor("float32", di, [2, 1, 640]),
			};

			const djResults = await cache.dj.run(djInputs);
			const logits = (djResults.output0 as ort.Tensor).data as Float32Array;

			// Find argmax
			let best = 0;
			let bestScore = logits[0];
			for (let i = 1; i < cache.V; i++) {
				if (logits[i] > bestScore) {
					bestScore = logits[i];
					best = i;
				}
			}

			if (best === cache.BL) break;

			prevTokens.push(best);
			resultTokens.push(best);

			// Update states
			const newDs = (djResults.output2 as ort.Tensor).data as Float32Array;
			const newDi = (djResults.output3 as ort.Tensor).data as Float32Array;
			ds.set(newDs);
			di.set(newDi);

			emitted++;
		}
	}

	// Decode tokens to text
	let text = "";
	for (const tok of resultTokens) {
		const t = cache.tokens.get(tok);
		if (t) text += t;
	}

	// Post-process: replace ▁ with space and trim
	text = text.replace(/▁/g, " ").trim();

	return text;
}

export function getVoiceNativeStatus(): { available: boolean; loaded: boolean; loading: boolean; error?: string } {
	return {
		available: isNativeVoiceAvailable(),
		loaded: cache.loaded ?? false,
		loading: cache.loading ?? false,
		error: cache.error,
	};
}
