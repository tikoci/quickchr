#!/usr/bin/env bun
/**
 * rollback — snapshot a CHR, make a risky change, roll it back
 *
 * The classic "try it, undo it" flow: take a qcow2 snapshot of the running VM,
 * change the config, then restore the snapshot and prove the change is gone.
 * Snapshots need a qcow2 boot disk (the quickchr default) — raw disks can't.
 *
 * Run:  bun run examples/rollback/rollback.ts
 * Time: ~30–50 s.
 */
import { QuickCHR } from "../../src/index.ts";
import { check, exampleMachineName, runExample } from "../lib.ts";

if (import.meta.main) {
	await runExample(async (track) => {
		const chr = track(
			await QuickCHR.start({
				name: exampleMachineName("rollback"),
				channel: "stable",
				secureLogin: false,
				mem: 256,
				bootDiskFormat: "qcow2", // the default — stated here because snapshots require it
			}),
		);

		// Establish a known baseline, then snapshot the running VM.
		await chr.exec("/system/identity/set name=before-snapshot");
		const snap = await chr.snapshot.save("baseline");
		console.log(`  saved snapshot "${snap.name}" (id ${snap.id})`);

		// Make a "risky" change: rename + add a firewall entry.
		await chr.exec("/system/identity/set name=after-change");
		await chr.exec("/ip/firewall/address-list/add list=temp address=10.1.1.1");
		const changed = (await chr.rest("/system/identity")) as { name?: string };
		check(changed.name === "after-change", "identity should reflect the change before rollback");

		// Roll back to the snapshot; restored state is instant (RAM snapshot).
		await chr.snapshot.load("baseline");
		check(await chr.waitForBoot(60_000), "CHR should be REST-ready after rollback");

		const reverted = (await chr.rest("/system/identity")) as { name?: string };
		check(reverted.name === "before-snapshot", `identity should revert, got "${reverted.name}"`);

		const al = (await chr.rest("/ip/firewall/address-list")) as unknown[];
		check(Array.isArray(al) && al.length === 0, "the address-list change should be gone after rollback");

		const snaps = await chr.snapshot.list();
		console.log(`  rolled back; identity="${reverted.name}", ${snaps.length} snapshot(s) on disk`);
	});
}
