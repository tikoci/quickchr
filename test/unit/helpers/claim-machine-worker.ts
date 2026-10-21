/**
 * One creator for `machine-lock-concurrency.test.ts`: claims a new machine's port
 * block and MACs the way `add()`/`start()` do, holds the claim as a create in flight
 * would, then releases it.
 *
 * A separate process on purpose: the allocation race is between processes as much as
 * within one, and only a real second process proves the claim is visible on disk.
 *
 * Usage: bun claim-machine-worker.ts <machine> <startAtEpochMs> <holdMs>
 * Prints `OK <machine> <portBase> <mac,...>` or `REFUSED <machine>: <message>`.
 */
import { claimNewMachine } from "../../../src/lib/quickchr.ts";

const [machine, startAt, holdMs] = process.argv.slice(2);
if (!machine || !startAt || !holdMs) {
	console.error("usage: claim-machine-worker.ts <machine> <startAtEpochMs> <holdMs>");
	process.exit(2);
}

// Spin rather than sleep, so every creator reaches the allocator in the same
// millisecond.
const at = Number(startAt);
while (Date.now() < at) { /* busy-wait to the shared instant */ }

try {
	const claim = await claimNewMachine(machine, "start", {});
	const macs = claim.networks.flatMap((n) => (n.mac ? [n.mac] : []));
	console.log(`OK ${machine} ${claim.portBase} ${macs.join(",")}`);
	await Bun.sleep(Number(holdMs));
	claim.lock.release();
} catch (e) {
	console.log(`REFUSED ${machine}: ${e instanceof Error ? e.message : String(e)}`);
}
