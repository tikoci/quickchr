/**
 * #257: disk and NIC names survive layout changes.
 *
 * RouterOS names a disk by its PCI address (`pcieN`, a new index for every address
 * it hasn't seen before). quickchr used `-drive if=virtio` on x86, which QEMU places
 * after every `-device`, so adding a NIC moved the data disk and renamed it. Disks
 * now sit at fixed slots (`diskDeviceArgs()`); this boots a machine with an extra
 * disk, then adds a NIC, adds a disk and removes the NIC, rebooting each time, and
 * checks that `/disk` and `/interface/ethernet` keep their names.
 *
 * There is no API for changing an existing machine's NICs or disks, so the test
 * edits machine.json between boots, the way a user hand-editing state would.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { imageTarget } from "./image-target.ts";
import { bootTestTimeout } from "./timeouts.ts";

const SKIP = !process.env.QUICKCHR_INTEGRATION;
const NAME = "integration-disk-pci-slots";

type Instance = Awaited<ReturnType<typeof import("../../src/lib/quickchr.ts").QuickCHR.start>>;
type Row = Record<string, string>;

async function cleanup(): Promise<void> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	const existing = QuickCHR.get(NAME);
	if (!existing) return;
	try { await existing.stop(); } catch { /* ignore */ }
	try { await existing.remove(); } catch { /* ignore */ }
}

/** Disks RouterOS can see now (an entry left behind by a moved disk has no size), and ethers. */
async function layout(instance: Instance, expectDisks: number): Promise<{ disks: string[]; ethers: string[] }> {
	const deadline = Date.now() + 60_000;
	let last = "";
	while (Date.now() < deadline) {
		try {
			const disks = (await instance.rest("/disk")) as Row[];
			const present = disks.filter((d) => d.size).map((d) => d.slot as string).sort();
			const ethers = ((await instance.rest("/interface/ethernet")) as Row[])
				.map((e) => `${e["default-name"]}=${(e["mac-address"] ?? "").toLowerCase()}`)
				.sort();
			last = JSON.stringify({ present, ethers });
			if (present.length === expectDisks) return { disks: present, ethers };
		} catch {
			// REST can lag basic readiness by a few seconds after boot.
		}
		await Bun.sleep(1000);
	}
	throw new Error(`/disk never showed ${expectDisks} disk(s); last read ${last}`);
}

async function editState(mutate: (state: import("../../src/lib/types.ts").MachineState) => void): Promise<void> {
	const { loadMachine, saveMachine } = await import("../../src/lib/state.ts");
	const state = loadMachine(NAME);
	if (!state) throw new Error(`${NAME}: machine.json missing`);
	mutate(state);
	saveMachine(state);
}

describe.skipIf(SKIP)("disk PCI slots (#257)", () => {
	test("adding/removing a NIC keeps disk names; adding a disk keeps ether names and MACs", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const { createQcow2Disk } = await import("../../src/lib/disk.ts");
		const arch = process.arch === "arm64" ? "arm64" : "x86";
		await cleanup();
		let instance: Instance | undefined;
		try {
			// 1. One extra disk, one NIC.
			instance = await QuickCHR.start({ ...imageTarget(), arch, name: NAME, extraDisks: ["64M"], networks: ["user"] });
			const base = await layout(instance, 1);
			expect(base.ethers).toHaveLength(1);
			await instance.shutdown();

			// 2. Add a NIC: the disk keeps its name.
			await editState((s) => {
				s.networks.push({ specifier: { type: "socket-listen", port: 47257 }, id: "net1", mac: "02:51:00:25:70:01" });
			});
			instance = await QuickCHR.start({ name: NAME });
			const withNic = await layout(instance, 1);
			expect(withNic.disks).toEqual(base.disks);
			expect(withNic.ethers).toHaveLength(2);
			expect(withNic.ethers).toContain(base.ethers[0] as string);
			await instance.shutdown();

			// 3. Add a disk: ethers keep their names and MACs, the first disk its name.
			const machineDir = instance.state.machineDir;
			await createQcow2Disk(join(machineDir, "disk2.qcow2"), "64M");
			await editState((s) => {
				s.extraDisks = [...(s.extraDisks ?? []), "64M"];
			});
			instance = await QuickCHR.start({ name: NAME });
			const withDisk = await layout(instance, 2);
			expect(withDisk.ethers).toEqual(withNic.ethers);
			expect(withDisk.disks).toContain(base.disks[0] as string);
			await instance.shutdown();

			// 4. Remove the NIC again: both disks keep their names.
			await editState((s) => {
				s.networks = s.networks.filter((n) => n.id !== "net1");
			});
			instance = await QuickCHR.start({ name: NAME });
			const back = await layout(instance, 2);
			expect(back.disks).toEqual(withDisk.disks);
			expect(back.ethers).toEqual(base.ethers);
		} finally {
			if (instance) {
				try { await instance.stop(); } catch { /* ignore */ }
			}
			await cleanup();
		}
	}, bootTestTimeout() * 4);
});
