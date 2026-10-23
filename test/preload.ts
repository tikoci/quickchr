import { admitStorage } from "../src/lib/storage.ts";
import { getDataDir } from "../src/lib/state.ts";

try {
	// Unit tests write only small fixtures, so they need just the reserve. The
	// integration suite boots machines one or two at a time against a warm cache, and
	// may fill cold image and package caches for its targets; 2 GiB covers that working
	// set. Never reclaim: the suite must not evict the developer's own cache.
	const integration = Boolean(process.env.QUICKCHR_INTEGRATION);
	admitStorage(
		"run quickchr tests",
		integration ? { parts: [{ label: "integration suite working set", bytes: 2 * 1024 ** 3, path: getDataDir() }], } : undefined,
		{ reclaim: false },
	).release();
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
