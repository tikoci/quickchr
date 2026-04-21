import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

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
	});

	test("QuickCHR.add + first start materializes bootSize/extraDisks and guest sees extra drives", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const { getDiskInfo } = await import("../../src/lib/disk.ts");

		const arch = process.arch === "arm64" ? "arm64" : "x86";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			const added = await QuickCHR.add({
				channel: "stable",
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

			expect(existsSync(join(added.machineDir, "disk.img"))).toBe(true);
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
	}, 300_000);

	test.skipIf(process.arch === "arm64")("monitor savevm/loadvm restores guest state on qcow2 boot disk", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");

		const arch = process.arch === "arm64" ? "arm64" : "x86";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;
		const snapshotName = "snap1";

		try {
			instance = await QuickCHR.start({
				channel: "stable",
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
	}, 360_000);
});
