#!/usr/bin/env bun
/**
 * arm64 rollback repro (issue #31) — examples/rollback flow pinned to an arm64
 * guest, with state probes around savevm/loadvm to localize where restored
 * state diverges. Run on any host (arm64 boots under TCG on x86 — slow, real):
 *
 *   bun test/lab/arm64-rollback/repro.ts
 */
import { QuickCHR } from "../../../src/index.ts";

const name = "lab-arm64-rollback";

// Clean any stale machine from a prior attempt.
try {
	const stale = await QuickCHR.get(name);
	if (stale) await stale.remove();
} catch { /* none */ }

const chr = await QuickCHR.start({
	name,
	channel: "stable",
	arch: "arm64",
	secureLogin: false,
	mem: 256,
	bootDiskFormat: "qcow2",
	background: true,
});

try {
	console.log("booted:", (await chr.rest("/system/resource") as { version?: string }).version);

	await chr.exec("/system/identity/set name=before-snapshot");
	const before = (await chr.rest("/system/identity")) as { name?: string };
	console.log("identity before savevm:", before.name);

	const snap = await chr.snapshot.save("baseline");
	console.log(`savevm ok: "${snap.name}" (id ${snap.id})`);

	await chr.exec("/system/identity/set name=after-change");
	await chr.exec("/ip/firewall/address-list/add list=temp address=10.1.1.1");
	const changed = (await chr.rest("/system/identity")) as { name?: string };
	console.log("identity after change:", changed.name);

	console.log("loadvm baseline…");
	await chr.snapshot.load("baseline");
	const rebooted = await chr.waitForBoot(120_000);
	console.log("REST-ready after loadvm:", rebooted);

	const reverted = (await chr.rest("/system/identity")) as { name?: string };
	const al = (await chr.rest("/ip/firewall/address-list")) as unknown[];
	console.log("identity after loadvm:", reverted.name, "| address-list length:", Array.isArray(al) ? al.length : al);

	if (reverted.name === "before-snapshot" && Array.isArray(al) && al.length === 0) {
		console.log("RESULT: PASS — rollback restored pre-snapshot state");
	} else {
		console.log("RESULT: FAIL — post-loadvm state is not the snapshot state");
		console.log("  expected identity 'before-snapshot', got:", JSON.stringify(reverted));
	}
} finally {
	try { await chr.remove(); } catch { /* best effort */ }
}
