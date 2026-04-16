/**
 * Unit tests for license types, credential utilities, and package lists.
 */

import { describe, test, expect, afterEach, afterAll } from "bun:test";
import { createServer, type Server } from "node:http";
import { LICENSE_LEVELS, KNOWN_PACKAGES_X86, KNOWN_PACKAGES_ARM64, knownPackagesForArch } from "../../src/lib/types.ts";
import { credentialStorageLabel } from "../../src/lib/credentials.ts";
import { renewLicense, getLicenseInfo } from "../../src/lib/license.ts";

describe("LicenseLevel constants", () => {
	test("LICENSE_LEVELS contains all valid levels", () => {
		expect(LICENSE_LEVELS).toEqual(["p1", "p10", "unlimited"]);
	});
});

describe("KNOWN_PACKAGES_X86 (7.22.1 baseline)", () => {
	test("contains the correct 7.22.1 x86 package set", () => {
		const expected = [
			"calea",
			"container",
			"dude",
			"gps",
			"iot",
			"openflow",
			"rose-storage",
			"tr069-client",
			"ups",
			"user-manager",
			"wireless",
		];
		// Every string in the static known list must be present
		for (const pkg of expected) expect(([...KNOWN_PACKAGES_X86] as string[])).toContain(pkg);
		expect([...KNOWN_PACKAGES_X86]).toHaveLength(expected.length);
	});

	test("does NOT include zerotier (x86 7.22.1 zip has no zerotier)", () => {
		expect(KNOWN_PACKAGES_X86).not.toContain("zerotier");
	});

	test("does NOT include wifi-qcom (x86 has no wireless hardware packages)", () => {
		expect(KNOWN_PACKAGES_X86).not.toContain("wifi-qcom");
	});
});

describe("KNOWN_PACKAGES_ARM64 (7.22.1 baseline)", () => {
	test("contains the correct 7.22.1 arm64 package set", () => {
		const expected = [
			"calea",
			"container",
			"dude",
			"extra-nic",
			"gps",
			"iot",
			"iot-bt-extra",
			"openflow",
			"rose-storage",
			"switch-marvell",
			"tr069-client",
			"ups",
			"user-manager",
			"wifi-qcom",
			"wifi-qcom-be",
			"wireless",
			"zerotier",
		];
		// Every string in the static known list must be present
		for (const pkg of expected) expect(([...KNOWN_PACKAGES_ARM64] as string[])).toContain(pkg);
		expect([...KNOWN_PACKAGES_ARM64]).toHaveLength(expected.length);
	});

	test("includes zerotier (present in arm64 zip)", () => {
		expect(KNOWN_PACKAGES_ARM64).toContain("zerotier");
	});

	test("uses wifi-qcom-be NOT wifi-qcom-ac (7.22.1 changed the name)", () => {
		expect(KNOWN_PACKAGES_ARM64).toContain("wifi-qcom-be");
		expect(KNOWN_PACKAGES_ARM64).not.toContain("wifi-qcom-ac");
	});
});

describe("knownPackagesForArch", () => {
	test("x86 returns x86 list", () => {
		expect(knownPackagesForArch("x86")).toBe(KNOWN_PACKAGES_X86);
	});

	test("arm64 returns arm64 list", () => {
		expect(knownPackagesForArch("arm64")).toBe(KNOWN_PACKAGES_ARM64);
	});
});

describe("credentialStorageLabel", () => {
	test("returns a non-empty string for current platform", () => {
		const label = credentialStorageLabel();
		expect(typeof label).toBe("string");
		expect(label.length).toBeGreaterThan(0);
	});
});

// --- Error path tests via mock HTTP server ---
// These test the network failure and HTTP error branches which are never
// reached in normal integration tests (cached image is always used).
// Uses a real node:http server since the library uses node:http via rest.ts.

function startMockServer(handler: (req: { method: string; url: string }, res: { writeHead: (s: number, h?: Record<string, string>) => void; end: (b?: string) => void }) => void): Promise<{ port: number; server: Server }> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			handler({ method: req.method ?? "GET", url: req.url ?? "/" }, {
				writeHead: (s, h) => res.writeHead(s, h),
				end: (b) => res.end(b),
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			resolve({ port, server });
		});
	});
}

describe("renewLicense — error paths", () => {
	let server: Server | null = null;
	afterEach(() => { if (server) { server.close(); server = null; } });

	test("throws PROCESS_FAILED on network error", async () => {
		// Mock: readiness check passes (returns valid license data),
		// but renew POST endpoint causes a connection error (server stops before POST)
		let requestCount = 0;
		const { port, server: s } = await startMockServer((req, res) => {
			requestCount++;
			if (req.url?.includes("/rest/system/license") && !req.url?.includes("/renew")) {
				// License readiness check — return valid data
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ "system-id": "TEST" }));
			} else {
				// Renew POST — destroy connection to simulate network error
				res.writeHead(500, { "Content-Type": "text/plain" });
				res.end("Internal Server Error");
			}
		});
		server = s;

		const err = await renewLicense(port, { account: "a@example.com", password: "pass", level: "p1" }).catch((e) => e);
		expect(err.code).toBe("PROCESS_FAILED");
	});

	test("throws PROCESS_FAILED on HTTP error response", async () => {
		// Mock: license readiness check returns valid data, renew POST returns 401
		const { port, server: s } = await startMockServer((req, res) => {
			if (req.url?.includes("/rest/system/license") && !req.url?.includes("/renew")) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ "system-id": "TEST" }));
			} else {
				res.writeHead(401, { "Content-Type": "text/plain" });
				res.end("Bad credentials");
			}
		});
		server = s;

		const err = await renewLicense(port, { account: "a@example.com", password: "wrong" }).catch((e) => e);
		expect(err.code).toBe("PROCESS_FAILED");
		expect(err.message).toMatch(/401/);
	});

	test("throws immediately on license server error (e.g. too many trials)", async () => {
		// Confirmed via curl: RouterOS returns HTTP 200 with error in status field.
		// [{".section":"0","status":"connecting"},{".section":"1","status":"ERROR: Licensing Error: too many trial licences"}]
		// This must NOT poll for 90s — it must throw immediately with the actual error.
		const { port, server: s } = await startMockServer((req, res) => {
			if (req.url?.includes("/rest/system/license") && !req.url?.includes("/renew")) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ "system-id": "TEST" }));
			} else {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify([
					{ ".section": "0", status: "connecting" },
					{ ".section": "1", status: "ERROR: Licensing Error: too many trial licences" },
				]));
			}
		});
		server = s;

		const start = Date.now();
		const err = await renewLicense(port, { account: "a@example.com", password: "pass", level: "p1" }).catch((e) => e);
		const elapsed = Date.now() - start;
		expect(err.code).toBe("PROCESS_FAILED");
		expect(err.message).toContain("too many trial licences");
		// Must fail fast (< 5s), NOT poll for 90s
		expect(elapsed).toBeLessThan(5000);
	});

	test("throws immediately on unauthorized license error", async () => {
		// Confirmed via curl: bad MikroTik.com credentials return ERROR: Unauthorized
		const { port, server: s } = await startMockServer((req, res) => {
			if (req.url?.includes("/rest/system/license") && !req.url?.includes("/renew")) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ "system-id": "TEST" }));
			} else {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify([
					{ ".section": "0", status: "connecting" },
					{ ".section": "1", status: "ERROR: Unauthorized" },
				]));
			}
		});
		server = s;

		const start = Date.now();
		const err = await renewLicense(port, { account: "bad@example.com", password: "wrong", level: "p1" }).catch((e) => e);
		const elapsed = Date.now() - start;
		expect(err.code).toBe("PROCESS_FAILED");
		expect(err.message).toContain("Unauthorized");
		expect(elapsed).toBeLessThan(5000);
	});
});

describe("getLicenseInfo — error paths", () => {
	let server: Server | null = null;
	afterEach(() => { if (server) { server.close(); server = null; } });

	test("throws PROCESS_FAILED on network error", async () => {
		// Use a port that nothing listens on
		const s = await startMockServer(() => {});
		const port = s.port;
		s.server.close();
		server = null;

		const err = await getLicenseInfo(port, "admin", "", undefined, 0).catch((e) => e);
		expect(err.code).toBe("PROCESS_FAILED");
	});

	test("throws PROCESS_FAILED on HTTP error response", async () => {
		const { port, server: s } = await startMockServer((_req, res) => {
			res.writeHead(403, { "Content-Type": "text/plain" });
			res.end("Forbidden");
		});
		server = s;

		const err = await getLicenseInfo(port, "admin", "", undefined, 0).catch((e) => e);
		expect(err.code).toBe("PROCESS_FAILED");
		expect(err.message).toMatch(/403/);
	});

	test("normalises missing level field to 'free'", async () => {
		const { port, server: s } = await startMockServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ "system-id": "ABCD1234" }));
		});
		server = s;

		const info = await getLicenseInfo(port);
		expect(info.level).toBe("free");
		expect(info["system-id"]).toBe("ABCD1234");
	});

	test("preserves level when already present in response", async () => {
		const { port, server: s } = await startMockServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ level: "p1", deadline: "2026-12-31" }));
		});
		server = s;

		const info = await getLicenseInfo(port);
		expect(info.level).toBe("p1");
	});
});
