import { assertSufficientQuickchrStorage } from "../src/lib/storage.ts";

try {
	assertSufficientQuickchrStorage("run quickchr tests");
} catch (error) {
	if (error && typeof error === "object" && "code" in error && "message" in error) {
		const err = error as { code: string; message: string };
		if (err.code === "INSUFFICIENT_DISK_SPACE") {
			console.error(`\nquickchr test preflight failed\n${err.message}\n`);
			process.exit(1);
		}
	}
	throw error;
}
