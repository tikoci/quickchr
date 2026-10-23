import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { imageTarget } from "./image-target.ts";
import { bootTestTimeout } from "./timeouts.ts";

const SKIP = !process.env.QUICKCHR_INTEGRATION;

async function cleanupMachine(name: string): Promise<void> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	const existing = QuickCHR.get(name);
	if (!existing) return;
	try { await existing.stop(); } catch { /* ignore */ }
	try { await existing.remove(); } catch { /* ignore */ }
}

async function waitForIdentity(
	instance: Awaited<ReturnType<typeof import("../../src/lib/quickchr.ts").QuickCHR.start>>,
	expected: string,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const identity = await instance.exec(":put [/system identity get name]");
			if (identity.output.trim() === expected) return;
		} catch {
			// During loadvm, RouterOS can briefly drop network connectivity.
		}
		await Bun.sleep(1000);
	}
	throw new Error(`Timed out waiting for identity "${expected}"`);
}

async function readIdentity(
	instance: Awaited<ReturnType<typeof import("../../src/lib/quickchr.ts").QuickCHR.start>>,
	timeoutMs: number,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const identity = (await instance.exec(":put [/system identity get name]")).output.trim();
			if (identity) return identity;
		} catch {
			// /rest/execute can lag briefly behind basic HTTP readiness.
		}
		await Bun.sleep(1000);
	}
	throw new Error("Timed out reading identity");
}

function parseExecJsonArray(output: string): Array<Record<string, unknown>> {
	const parsed = JSON.parse(output) as unknown;
	if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
	if (
		typeof parsed === "object" &&
		parsed !== null &&
		"ret" in parsed &&
		typeof (parsed as { ret?: unknown }).ret === "string"
	) {
		const nested = JSON.parse((parsed as { ret: string }).ret) as unknown;
		if (Array.isArray(nested)) return nested as Array<Record<string, unknown>>;
	}
	return [];
}

async function waitForDiskList(
	instance: Awaited<ReturnType<typeof import("../../src/lib/quickchr.ts").QuickCHR.start>>,
	timeoutMs: number,
): Promise<Array<Record<string, unknown>>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const disksJson = await instance.exec(":put [:serialize to=json [/disk/print as-value]]");
			const disks = parseExecJsonArray(disksJson.output);
			if (disks.length > 0) return disks;
		} catch {
			// /rest/execute can lag briefly behind basic HTTP readiness.
		}
		await Bun.sleep(1000);
	}
	return [];
}

async function setIdentityWithRetry(
	instance: Awaited<ReturnType<typeof import("../../src/lib/quickchr.ts").QuickCHR.start>>,
	value: string,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await instance.exec(`/system identity set name=${value}`);
			await waitForIdentity(instance, value, 8_000);
			return;
		} catch {
			// Retry until /rest/execute is fully ready and the write sticks.
		}
		await Bun.sleep(1000);
	}
	throw new Error(`Timed out setting identity to "${value}"`);
}

describe.skipIf(SKIP)("disk support", () => {
	beforeAll(async () => {
		await cleanupMachine("integration-disk-add-start");
		await cleanupMachine("integration-snapshot-savevm");
		await cleanupMachine("integration-disk-qcow2-restart");
	});

	test("QuickCHR.add + first start materializes bootSize/extraDisks and guest sees extra drives", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const { getDiskInfo } = await import("../../src/lib/disk.ts");

		const arch = process.arch === "arm64" ? "arm64" : "x86";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			const added = await QuickCHR.add({
				...imageTarget(),
				arch,
				name: "integration-disk-add-start",
				bootSize: "192M",
				extraDisks: ["64M", "96M"],
				networks: ["user"],
			});

			expect(added.status).toBe("stopped");
			expect(added.bootDiskFormat).toBe("qcow2");
			expect(added.bootSize).toBe("192M");
			expect(added.extraDisks).toEqual(["64M", "96M"]);

			const bootQcow2Path = join(added.machineDir, "boot.qcow2");
			const extra1Path = join(added.machineDir, "disk1.qcow2");
			const extra2Path = join(added.machineDir, "disk2.qcow2");

			// qcow2 is converted straight from the cache: no machine-local raw copy (#199).
			expect(existsSync(join(added.machineDir, "disk.img"))).toBe(false);
			expect(existsSync(bootQcow2Path)).toBe(true);
			expect(existsSync(extra1Path)).toBe(true);
			expect(existsSync(extra2Path)).toBe(true);

			const bootInfo = await getDiskInfo(bootQcow2Path);
			const extra1Info = await getDiskInfo(extra1Path);
			const extra2Info = await getDiskInfo(extra2Path);

			expect(bootInfo.format).toBe("qcow2");
			expect(extra1Info.format).toBe("qcow2");
			expect(extra2Info.format).toBe("qcow2");
			expect(bootInfo.virtualSize).toBeGreaterThanOrEqual(192 * 1024 * 1024);
			expect(extra1Info.virtualSize).toBeGreaterThanOrEqual(64 * 1024 * 1024);
			expect(extra2Info.virtualSize).toBeGreaterThanOrEqual(96 * 1024 * 1024);

			instance = await QuickCHR.start({ name: "integration-disk-add-start", background: true });
			const booted = await instance.waitForBoot(120_000);
			expect(booted).toBe(true);

			const disks = await waitForDiskList(instance, 30_000);
			expect(disks.length).toBeGreaterThanOrEqual(2);
		} finally {
			if (instance) {
				try { await instance.stop(); } catch { /* ignore */ }
			}
			await cleanupMachine("integration-disk-add-start");
		}
	}, bootTestTimeout());

	// #200: a qcow2 machine boots from boot.qcow2 alone. Restart used to demand the
	// machine-local disk.img, which #199 stopped creating.
	test("a qcow2 machine with no disk.img restarts with its guest state, and clean() resets it", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const { getDiskInfo } = await import("../../src/lib/disk.ts");

		const arch = process.arch === "arm64" ? "arm64" : "x86";
		const name = "integration-disk-qcow2-restart";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			instance = await QuickCHR.start({ ...imageTarget(), arch, name, bootDiskFormat: "qcow2", networks: ["user"] });
			const machineDir = instance.state.machineDir;
			expect(existsSync(join(machineDir, "disk.img"))).toBe(false);

			const marker = `qcow2-${Date.now().toString(36)}`;
			await setIdentityWithRetry(instance, marker, 30_000);
			// A guest shutdown flushes the marker; stop() is a power cut.
			await instance.shutdown();
			instance = undefined;
			// Inspected once QEMU has let go: it holds a write lock on the image while running.
			const boot = await getDiskInfo(join(machineDir, "boot.qcow2"));
			expect(boot.format).toBe("qcow2");
			expect(boot.backingFilename).toBeUndefined();

			instance = await QuickCHR.start({ name });
			expect(existsSync(join(machineDir, "disk.img"))).toBe(false);
			await waitForIdentity(instance, marker, 30_000);

			// clean() rebuilds boot.qcow2 from the cache: the marker is gone, still no raw copy.
			// (The factory identity itself varies by version — "CHR" on 7.24.5.)
			await instance.clean();
			instance = await QuickCHR.start({ name });
			expect(existsSync(join(machineDir, "disk.img"))).toBe(false);
			expect(await readIdentity(instance, 30_000)).not.toBe(marker);
		} finally {
			if (instance) {
				try { await instance.stop(); } catch { /* ignore */ }
			}
			await cleanupMachine(name);
		}
	}, bootTestTimeout({ boots: 3 }));

	// Runs on ALL arches — arm64 savevm was broken until the qcow2 EFI-vars
	// pflash fix (#31, test/lab/arm64-rollback/REPORT.md); this test is the
	// end-to-end regression guard for it.
	test("monitor savevm/loadvm restores guest state on qcow2 boot disk", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");

		const arch = process.arch === "arm64" ? "arm64" : "x86";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;
		const snapshotName = "snap1";

		try {
			instance = await QuickCHR.start({
				...imageTarget(),
				arch,
				background: true,
				name: "integration-snapshot-savevm",
				bootSize: "192M",
				secureLogin: false,
				networks: ["user"],
			});

			const booted = await instance.waitForBoot(120_000);
			expect(booted).toBe(true);

			await setIdentityWithRetry(instance, "snapbefore", 30_000);

			await instance.monitor(`savevm ${snapshotName}`);

			await setIdentityWithRetry(instance, "snapafter", 30_000);

			await instance.monitor(`loadvm ${snapshotName}`);
			const rebootedAfterLoad = await instance.waitForBoot(120_000);
			expect(rebootedAfterLoad).toBe(true);
			await waitForIdentity(instance, "snapbefore", 60_000);
		} finally {
			if (instance) {
				try { await instance.monitor(`delvm ${snapshotName}`); } catch { /* ignore */ }
				try { await instance.stop(); } catch { /* ignore */ }
			}
			await cleanupMachine("integration-snapshot-savevm");
		}
	}, bootTestTimeout());
});
