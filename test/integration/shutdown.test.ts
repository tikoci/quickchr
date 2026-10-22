import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { parseNetworkSpecifier } from "../../src/lib/network.ts";
import { QuickCHR } from "../../src/lib/quickchr.ts";
import { getInstanceCredentials } from "../../src/lib/credentials.ts";
import { isMachineRunning, loadMachine, saveMachine } from "../../src/lib/state.ts";
import { createNamedSocket, getNamedSocket, removeNamedSocket } from "../../src/lib/socket-registry.ts";
import type { ChrInstance } from "../../src/lib/types.ts";
import { basicAuth, chrGet } from "./chr-rest.ts";
import { imageTarget } from "./image-target.ts";
import { bootTestTimeout, TEST_ACCEL, TEST_ARCH } from "./timeouts.ts";

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

describe.skipIf(!process.env.QUICKCHR_INTEGRATION)("guest shutdown (#143)", () => {
	test("guest exit preserves disk, credentials and restart config; releases network membership", async () => {
		const nonce = Date.now().toString(36);
		const name = `sd-${nonce}`;
		const socket = `sd-net-${nonce}`;
		let instance: ChrInstance | undefined;
		createNamedSocket(socket, { mode: "listen-connect" });
		try {
			instance = await QuickCHR.start({ ...imageTarget(), name, networks: ["user", parseNetworkSpecifier(`socket::${socket}`)], secureLogin: true });
			const marker = `shutdown-${nonce}`;
			await instance.exec(`/system/identity/set name=${marker}`, { via: "rest" });
			const credentials = JSON.stringify(getInstanceCredentials(name));
			expect(getInstanceCredentials(name)).not.toBeNull();
			const ports = JSON.stringify(instance.state.ports);
			const networks = JSON.stringify(instance.state.networks);
			const machineDir = instance.state.machineDir;
			const pid = instance.state.pid;
			if (!pid) throw new Error("running machine has no pid");
			expect(getNamedSocket(socket)?.members).toContain(name);
			const start = performance.now();
			const result = await instance.shutdown();
			console.log(JSON.stringify({ arch: TEST_ARCH, accel: TEST_ACCEL, version: instance.state.version, elapsedMs: performance.now() - start, ...result }));
			expect(result.outcome).toBe("guest-exited");
			expect(alive(pid)).toBe(false);
			expect(instance.state.status).toBe("stopped");
			expect(instance.state.pid).toBeUndefined();
			expect(loadMachine(name)?.pid).toBeUndefined();
			expect(loadMachine(name)?.status).toBe("stopped");
			expect(getNamedSocket(socket)?.members).not.toContain(name);
			expect(existsSync(machineDir)).toBe(true);
			expect(JSON.stringify(getInstanceCredentials(name)) === credentials).toBe(true);
			expect(JSON.stringify(instance.state.ports)).toBe(ports);
			expect(JSON.stringify(instance.state.networks)).toBe(networks);
			expect(await instance.shutdown()).toEqual({ outcome: "already-stopped" });

			instance = await QuickCHR.start({ name });
			const creds = getInstanceCredentials(name);
			if (!creds) throw new Error("credentials lost");
			const response = await chrGet(instance, "/rest/system/identity", basicAuth(creds.user, creds.password), { after: "shutdown then same-disk restart" });
			expect(response.status).toBe(200);
			expect(JSON.parse(response.body).name).toBe(marker);
			expect(isMachineRunning(instance.state)).toBe(true);
			expect(getNamedSocket(socket)?.members).toContain(name);
		} finally {
			await (instance ?? QuickCHR.get(name))?.remove();
			removeNamedSocket(socket);
		}
	}, bootTestTimeout({ boots: 2 }));

	test("failed REST authentication waits then explicitly reports hard-stop fallback", async () => {
		const name = `sd-f-${Date.now().toString(36)}`;
		let instance: ChrInstance | undefined;
		try {
			instance = await QuickCHR.start({ ...imageTarget(), name, secureLogin: false });
			const pid = instance.state.pid;
			if (!pid) throw new Error("running machine has no pid");
			// Persist deliberately invalid credentials; shutdown must refresh these
			// under its lock, not use a successful auth cached by the original handle.
			saveMachine({ ...instance.state, user: { name: "nonexistent-shutdown-user", password: "invalid" } });
			const start = performance.now();
			const result = await instance.shutdown({ timeoutMs: 1000 });
			const elapsedMs = performance.now() - start;
			console.log(JSON.stringify({ arch: TEST_ARCH, accel: TEST_ACCEL, version: instance.state.version, elapsedMs, ...result }));
			expect(result.outcome).toBe("forced");
			expect(result.requestError).toContain("401");
			expect(elapsedMs).toBeGreaterThanOrEqual(990);
			expect(alive(pid)).toBe(false);
			expect(instance.state.status).toBe("stopped");
			expect(instance.state.pid).toBeUndefined();
			expect(loadMachine(name)?.pid).toBeUndefined();
		} finally {
			await (instance ?? QuickCHR.get(name))?.remove();
		}
	}, bootTestTimeout({ boots: 1 }));
});
