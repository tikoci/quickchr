/**
 * One joiner for `socket-registry-concurrency.test.ts`.
 *
 * A separate process on purpose: the registry's in-memory cache makes the
 * read-modify-write look atomic within one process, so the defect this guards is only
 * reachable across processes.
 *
 * Usage: bun join-socket-worker.ts <socket> <machine> <startAtEpochMs>
 * Prints `OK <machine>` or `REFUSED <machine>: <message>`.
 */
import { joinNamedSocket, _resetSocketCache } from "../../../src/lib/socket-registry.ts";

const [socket, machine, startAt] = process.argv.slice(2);
if (!socket || !machine || !startAt) {
	console.error("usage: join-socket-worker.ts <socket> <machine> <startAtEpochMs>");
	process.exit(2);
}

_resetSocketCache();
// Spin rather than sleep, so every joiner enters the critical section in the same
// millisecond. A sleep leaves them milliseconds apart and the race never opens.
const at = Number(startAt);
while (Date.now() < at) { /* busy-wait to the shared instant */ }

try {
	joinNamedSocket(socket, machine, { autoCreated: true });
	console.log(`OK ${machine}`);
} catch (e) {
	console.log(`REFUSED ${machine}: ${e instanceof Error ? e.message : String(e)}`);
}
