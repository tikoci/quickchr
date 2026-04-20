/**
 * ZIP extraction using fflate — no external unzip binary required.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { unzipSync } from "fflate";
import { QuickCHRError } from "./types.ts";

/**
 * Extract all files from a ZIP archive to a destination directory.
 * Creates the destination and any intermediate directories as needed.
 * Throws QuickCHRError("PROCESS_FAILED") on read or extraction failure.
 */
export function extractZip(zipPath: string, destDir: string): void {
	let data: Uint8Array;
	try {
		data = new Uint8Array(readFileSync(zipPath));
	} catch (e) {
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`Cannot read ZIP ${zipPath}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	let files: ReturnType<typeof unzipSync>;
	try {
		files = unzipSync(data);
	} catch (e) {
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`ZIP extraction failed: ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	mkdirSync(destDir, { recursive: true });

	for (const [name, fileData] of Object.entries(files)) {
		if (name.endsWith("/")) continue; // skip directory entries
		const destPath = join(destDir, name);
		mkdirSync(dirname(destPath), { recursive: true });
		writeFileSync(destPath, fileData);
	}
}
