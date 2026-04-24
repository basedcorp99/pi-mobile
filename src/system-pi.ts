import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// pi-mobile intentionally loads Pi from the global npm install so the web UI
// stays aligned with the user's system `pi` CLI version.
let cachedNpmRoot: string | null | undefined;
let cachedPiModule: Promise<Record<string, any>> | null = null;

export function getGlobalNpmRoot(): string | null {
	if (cachedNpmRoot === undefined) {
		try {
			cachedNpmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf-8", timeout: 3000 }).trim();
		} catch {
			cachedNpmRoot = null;
		}
	}
	return cachedNpmRoot;
}

export function getSystemPiEntryPath(): string {
	const npmRoot = getGlobalNpmRoot();
	if (!npmRoot) {
		throw new Error(
			"Unable to resolve npm global root. pi-mobile requires a system pi install (npm install -g @mariozechner/pi-coding-agent).",
		);
	}

	const entryPath = join(npmRoot, "@mariozechner", "pi-coding-agent", "dist", "index.js");
	if (!existsSync(entryPath)) {
		throw new Error(
			`System pi module not found at ${entryPath}. Install or update it with: npm install -g @mariozechner/pi-coding-agent`,
		);
	}
	return entryPath;
}

export async function loadSystemPiModule(): Promise<Record<string, any>> {
	if (cachedPiModule !== null) return cachedPiModule;

	const entryPath = getSystemPiEntryPath();
	cachedPiModule = import(pathToFileURL(entryPath).href).catch((error: unknown) => {
		cachedPiModule = null;
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to load system pi from ${entryPath}: ${reason}`);
	});
	return cachedPiModule;
}
