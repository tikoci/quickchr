import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as qemu from "../../src/lib/qemu.ts";
import { QuickCHR } from "../../src/lib/quickchr.ts";
import { getInstanceCredentials } from "../../src/lib/credentials.ts";
import { currentHolder, machineLockPath } from "../../src/lib/lock.ts";
import { isProvisioningWindowOpen } from "../../src/lib/provisioning-window.ts";
import { parseNetworkSpecifier } from "../../src/lib/network.ts";
import { isMachineRunning, loadMachine } from "../../src/lib/state.ts";
import { createNamedSocket, getNamedSocket, removeNamedSocket } from "../../src/lib/socket-registry.ts";
import type { ChrInstance } from "../../src/lib/types.ts";
import { basicAuth, chrGet } from "./chr-rest.ts";
import { imageTarget } from "./image-target.ts";
import { bootTestTimeout } from "./timeouts.ts";

describe.skipIf(!process.env.QUICKCHR_INTEGRATION)("restart timeout (#189)", () => {
	test("configured guest survives timeout, then restarts with its identity and credentials", async () => {
		const envKeys = ["QUICKCHR_DATA_DIR", "HOME", "XDG_CONFIG_HOME", "QUICKCHR_PRESERVE_ON_FAILURE", "QUICKCHR_DEEP_BOOT_DIAGNOSTICS"] as const;
		const original = envKeys.map((key) => [key, process.env[key]] as const);
		const dir = mkdtempSync(join(tmpdir(), "qc189-"));
		process.env.QUICKCHR_DATA_DIR = dir;
		process.env.HOME = join(dir, "home");
		process.env.XDG_CONFIG_HOME = join(dir, "config");
		delete process.env.QUICKCHR_PRESERVE_ON_FAILURE;
		delete process.env.QUICKCHR_DEEP_BOOT_DIAGNOSTICS;
		const name = "restart-timeout";
		const socket = "restart-timeout-net";
		let instance: ChrInstance | undefined;
		const realWait = qemu.waitForBoot;
		let failedPid: number | undefined;
		let forceTimeout: ReturnType<typeof spyOn<typeof qemu, "waitForBoot">> | undefined;
		createNamedSocket(socket, { mode: "listen-connect" });
		try {
			instance = await QuickCHR.start({ ...imageTarget(), name, secureLogin: true, extraDisks: ["16M"], networks: ["user", parseNetworkSpecifier(`socket::${socket}`)] });
			const marker = `preserved-${Date.now().toString(36)}`;
			await instance.exec(`/system/identity/set name=${marker}`, { via: "rest" });
			// A guest shutdown flushes the marker before the deliberately failed restart.
			await instance.shutdown();
			const before = loadMachine(name);
			if (!before) throw new Error("configured machine missing");
			const credentials = getInstanceCredentials(name);
			expect(credentials).not.toBeNull();
			if (!credentials) throw new Error("configured credentials missing");
			// Exercise the real readiness timeout with a zero probe budget. Launch,
			// diagnostics and cleanup remain real; no dependency on guest boot speed.
			forceTimeout = spyOn(qemu, "waitForBoot").mockImplementation((port, _budget, auth, stats) => {
				failedPid = loadMachine(name)?.pid;
				return realWait(port, 0, auth, stats);
			});
			let message = "";
			try {
				await QuickCHR.start({ name, version: before.version });
				throw new Error("expected BOOT_TIMEOUT");
			} catch (err) {
				expect((err as { code: string }).code).toBe("BOOT_TIMEOUT");
				message = (err as Error).message;
			} finally {
				forceTimeout.mockRestore();
				forceTimeout = undefined;
			}
			expect(message).toContain("stopped and preserved");
			expect(message).not.toContain("quickchr clean");
			expect(message).not.toContain("QUICKCHR_PRESERVE_ON_FAILURE=1");
			const after = loadMachine(name);
			if (!after) throw new Error("timed-out machine missing");
			expect(after).toBeDefined();
			expect(after.status).toBe("stopped");
			expect(after.pid).toBeUndefined();
			expect(isMachineRunning(after)).toBe(false);
			expect(failedPid).toBeDefined();
			expect(isMachineRunning({ ...after, pid: failedPid, status: "running" })).toBe(false);
			expect(isProvisioningWindowOpen(after)).toBe(false);
			expect(after.provisioning).toEqual(before.provisioning);
			expect(after.ports).toEqual(before.ports);
			expect(after.networks).toEqual(before.networks);
			expect(after.extraDisks).toEqual(before.extraDisks);
			expect(getInstanceCredentials(name)).toEqual(credentials);
			expect(existsSync(join(after.machineDir, "disk.img"))).toBe(true);
			expect(existsSync(join(after.machineDir, "disk1.qcow2"))).toBe(true);
			expect(getNamedSocket(socket)?.members).not.toContain(name);
			expect(currentHolder(machineLockPath(after.machineDir))).toBeUndefined();
			const reports = readdirSync(join(dir, "failures")).filter((file) => file.startsWith(`boot-failure-${name}-`));
			expect(reports.length).toBe(1);
			expect(readFileSync(join(dir, "failures", reports[0] as string), "utf8")).toContain("_launchExisting");

			instance = await QuickCHR.start({ name, version: before.version });
			const response = await chrGet(instance, "/rest/system/identity", basicAuth(credentials.user, credentials.password), { after: "forced restart timeout, then preserved-disk restart" });
			expect(response.status).toBe(200);
			expect(JSON.parse(response.body).name).toBe(marker);
			console.log(JSON.stringify({ version: instance.state.version, arch: instance.state.arch, accel: instance.state.lastAccel, recoveredMarker: marker }));
		} finally {
			forceTimeout?.mockRestore();
			try {
				await (QuickCHR.get(name) ?? instance)?.remove();
				removeNamedSocket(socket);
			} finally {
				for (const [key, value] of original) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
				rmSync(dir, { recursive: true, force: true });
			}
		}
	}, bootTestTimeout({ boots: 3 }));
});
