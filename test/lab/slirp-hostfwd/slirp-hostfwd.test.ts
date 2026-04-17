/**
 * Lab: SLiRP hostfwd behavior — does it require a guest IP?
 *
 * FINDING: Yes. SLiRP hostfwd creates TCP connections to a specific guest IP
 * (default 10.0.2.15). Without that IP configured on the guest interface,
 * the host-side TCP connect succeeds (SLiRP accepts immediately) but the
 * HTTP request hangs — the guest never SYN-ACKs the forwarded connection.
 *
 * CONCLUSION: SLiRP MUST be on ether1 for zero-config provisioning. RouterOS
 * auto-creates a DHCP client only on ether1, and SLiRP's built-in DHCP server
 * assigns 10.0.2.15. Shared/bridged networks on ether2+ need manual DHCP client
 * configuration via REST after boot.
 *
 * Run: QUICKCHR_INTEGRATION=1 bun test test/lab/slirp-hostfwd/slirp-hostfwd.test.ts
 */

import { describe, test, expect } from "bun:test";
import { request as nodeRequest } from "node:http";

const SKIP = !process.env.QUICKCHR_INTEGRATION;

/** Quick HTTP GET using node:http (avoids Bun fetch pool) */
function httpGet(
	url: string,
	auth: string,
	timeoutMs: number,
): Promise<{ status: number; body: string; connected: boolean }> {
	return new Promise((resolve, reject) => {
		let done = false;
		const parsed = new URL(url);
		const req = nodeRequest(
			{
				hostname: parsed.hostname,
				port: parsed.port,
				path: parsed.pathname + parsed.search,
				method: "GET",
				headers: { Authorization: auth },
				agent: false,
			},
			(res) => {
				let body = "";
				res.on("data", (chunk: Buffer) => {
					body += chunk.toString();
				});
				res.on("end", () => {
					if (!done) {
						done = true;
						clearTimeout(timer);
						resolve({ status: res.statusCode ?? 0, body, connected: true });
					}
				});
				res.on("error", (err) => {
					if (!done) {
						done = true;
						clearTimeout(timer);
						reject(err);
					}
				});
			},
		);
		const timer = setTimeout(() => {
			if (!done) {
				done = true;
				req.destroy();
				resolve({ status: 0, body: "", connected: true });
			}
		}, timeoutMs);
		req.on("error", (err: Error & { code?: string }) => {
			if (!done) {
				done = true;
				clearTimeout(timer);
				if (err.code === "ECONNREFUSED") {
					resolve({ status: 0, body: "", connected: false });
				} else {
					reject(err);
				}
			}
		});
		req.end();
	});
}

describe.skipIf(SKIP)("SLiRP hostfwd behavior", () => {
	const auth = `Basic ${btoa("admin:")}`;
	let port = 9100;
	let machineName = "";

	// Find the first running machine to test against
	test("find running machine", async () => {
		const { QuickCHR } = await import("../../../src/lib/quickchr.ts");
		const machines = await QuickCHR.list();
		const running = machines.filter((m) => m.status === "running");
		expect(running.length).toBeGreaterThan(0);
		const m = running[0];
		if (!m) throw new Error("No running machine found");
		const ports = m.ports as Record<string, { host: number }>;
		port = ports.http?.host ?? 0;
		machineName = m.name;
		console.log(`Using machine: ${machineName} on port ${port}`);
	});

	test("baseline: SLiRP ether1 with DHCP responds to REST", async () => {
		// Verify ether1 has auto-DHCP from SLiRP
		const dhcpRes = await httpGet(
			`http://127.0.0.1:${port}/rest/ip/dhcp-client`,
			auth,
			5000,
		);
		expect(dhcpRes.status).toBe(200);
		const clients = JSON.parse(dhcpRes.body);
		expect(Array.isArray(clients)).toBe(true);

		const ether1Client = clients.find(
			(c: Record<string, string>) => c.interface === "ether1",
		);
		expect(ether1Client).toBeDefined();
		expect(ether1Client.status).toBe("bound");
		expect(ether1Client.address).toMatch(/^10\.0\.2\./);
		console.log(
			`  ether1 DHCP: ${ether1Client.address} from ${ether1Client["dhcp-server"]}`,
		);
	});

	test("SLiRP DHCP server is 10.0.2.2, assigns 10.0.2.15", async () => {
		const addrRes = await httpGet(
			`http://127.0.0.1:${port}/rest/ip/address`,
			auth,
			5000,
		);
		expect(addrRes.status).toBe(200);
		const addrs = JSON.parse(addrRes.body);
		const ether1Addr = addrs.find(
			(a: Record<string, string>) => a.interface === "ether1",
		);
		expect(ether1Addr).toBeDefined();
		// SLiRP default guest IP
		expect(ether1Addr.address).toBe("10.0.2.15/24");
		expect(ether1Addr.dynamic).toBe("true");
		console.log(`  ether1 IP: ${ether1Addr.address} (dynamic=${ether1Addr.dynamic})`);
	});

	test("SLiRP provides default route via 10.0.2.2", async () => {
		const routeRes = await httpGet(
			`http://127.0.0.1:${port}/rest/ip/route`,
			auth,
			5000,
		);
		expect(routeRes.status).toBe(200);
		const routes = JSON.parse(routeRes.body);
		const defaultRoute = routes.find(
			(r: Record<string, string>) =>
				r["dst-address"] === "0.0.0.0/0" && r.dhcp === "true",
		);
		expect(defaultRoute).toBeDefined();
		expect(defaultRoute.gateway).toBe("10.0.2.2");
		console.log(`  Default route: ${defaultRoute.gateway} (distance=${defaultRoute.distance})`);
	});

	/*
	 * The destructive test (remove DHCP client → hostfwd hangs) is documented
	 * in REPORT.md via manual curl experiments. We don't automate it here because:
	 * 1. It makes the machine unusable (no way to restore via REST)
	 * 2. It would require starting/stopping machines (slow, not a unit assertion)
	 * 3. The manual experiment is more informative (shows the half-open behavior)
	 */
});
