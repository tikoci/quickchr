/**
 * One creator for `socket-registry-concurrency.test.ts`.
 *
 * A separate process on purpose: automatic port allocation reads the whole registry,
 * and the collision it guards only exists between processes.
 *
 * Usage: bun create-socket-worker.ts <name> <startAtEpochMs>
 */
import { createNamedSocket, _resetSocketCache } from "../../../src/lib/socket-registry.ts";

const [name, startAt] = process.argv.slice(2);
if (!name || !startAt) {
	console.error("usage: create-socket-worker.ts <name> <startAtEpochMs>");
	process.exit(2);
}

_resetSocketCache();
const at = Number(startAt);
while (Date.now() < at) { /* busy-wait to the shared instant */ }

try {
	const entry = createNamedSocket(name, { mode: "mcast" });
	console.log(`OK ${name} ${entry.port}`);
} catch (e) {
	console.log(`REFUSED ${name}: ${e instanceof Error ? e.message : String(e)}`);
}
