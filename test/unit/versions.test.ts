import { describe, test, expect, afterEach } from "bun:test";
import {
	isValidVersion,
	chrDownloadUrl,
	packagesDownloadUrl,
	chrImageBasename,
	generateMachineName,
	resolveVersion,
	resolveAllVersions,
	compareRouterOsVersion,
	isProvisioningSupportedVersion,
	assertProvisioningSupportedVersion,
	parseVersionParts,
} from "../../src/lib/versions.ts";

describe("isValidVersion", () => {
	test("accepts standard versions", () => {
		expect(isValidVersion("7.22.1")).toBe(true);
		expect(isValidVersion("7.22")).toBe(true);
		expect(isValidVersion("8.0.1")).toBe(true);
	});

	test("accepts beta/rc versions", () => {
		expect(isValidVersion("7.23beta1")).toBe(true);
		expect(isValidVersion("7.23rc2")).toBe(true);
	});

	test("rejects invalid versions", () => {
		expect(isValidVersion("")).toBe(false);
		expect(isValidVersion("abc")).toBe(false);
		expect(isValidVersion("7")).toBe(false);
		expect(isValidVersion("7.22.1.2")).toBe(false);
		expect(isValidVersion("v7.22.1")).toBe(false);
	});
});

describe("chrDownloadUrl", () => {
	test("generates x86 URL", () => {
		expect(chrDownloadUrl("7.22.1", "x86")).toBe(
			"https://download.mikrotik.com/routeros/7.22.1/chr-7.22.1.img.zip",
		);
	});

	test("generates arm64 URL", () => {
		expect(chrDownloadUrl("7.22.1", "arm64")).toBe(
			"https://download.mikrotik.com/routeros/7.22.1/chr-7.22.1-arm64.img.zip",
		);
	});

	test("defaults to x86", () => {
		expect(chrDownloadUrl("7.22.1")).toBe(
			"https://download.mikrotik.com/routeros/7.22.1/chr-7.22.1.img.zip",
		);
	});
});

describe("packagesDownloadUrl", () => {
	test("generates x86 packages URL", () => {
		expect(packagesDownloadUrl("7.22.1", "x86")).toBe(
			"https://download.mikrotik.com/routeros/7.22.1/all_packages-x86-7.22.1.zip",
		);
	});

	test("generates arm64 packages URL", () => {
		expect(packagesDownloadUrl("7.22.1", "arm64")).toBe(
			"https://download.mikrotik.com/routeros/7.22.1/all_packages-arm64-7.22.1.zip",
		);
	});
});

describe("chrImageBasename", () => {
	test("x86 has no suffix", () => {
		expect(chrImageBasename("7.22.1", "x86")).toBe("chr-7.22.1");
	});

	test("arm64 has suffix", () => {
		expect(chrImageBasename("7.22.1", "arm64")).toBe("chr-7.22.1-arm64");
	});
});

describe("generateMachineName", () => {
	test("generates first instance name", () => {
		expect(generateMachineName("7.22.1", "arm64", [])).toBe("7.22.1-arm64-1");
	});

	test("increments when existing names present", () => {
		expect(
			generateMachineName("7.22.1", "arm64", ["7.22.1-arm64-1"]),
		).toBe("7.22.1-arm64-2");
	});

	test("fills gaps", () => {
		expect(
			generateMachineName("7.22.1", "x86", ["7.22.1-x86-1", "7.22.1-x86-2", "7.22.1-x86-3"]),
		).toBe("7.22.1-x86-4");
	});
});

describe("RouterOS semantic version helpers", () => {
	test("parseVersionParts handles patchless and suffix variants", () => {
		expect(parseVersionParts("7.20")).toEqual([7, 20, 0]);
		expect(parseVersionParts("7.20.8")).toEqual([7, 20, 8]);
		expect(parseVersionParts("7.20rc1")).toEqual([7, 20, 0]);
		expect(parseVersionParts("7.20.8beta2")).toEqual([7, 20, 8]);
	});

	test("compareRouterOsVersion orders versions semantically", () => {
		expect(compareRouterOsVersion("7.20.7", "7.20.8")).toBeLessThan(0);
		expect(compareRouterOsVersion("7.20.8", "7.20.8")).toBe(0);
		expect(compareRouterOsVersion("7.21", "7.20.8")).toBeGreaterThan(0);
		expect(compareRouterOsVersion("7.20.8rc1", "7.20.8beta1")).toBe(0);
	});

	test("isProvisioningSupportedVersion enforces 7.20.8 floor", () => {
		expect(isProvisioningSupportedVersion("7.20.7")).toBe(false);
		expect(isProvisioningSupportedVersion("7.20.8")).toBe(true);
		expect(isProvisioningSupportedVersion("7.22.1")).toBe(true);
	});

	test("assertProvisioningSupportedVersion throws dedicated error below floor", () => {
		try {
			assertProvisioningSupportedVersion("7.10.0", "provision this machine");
			expect.unreachable("expected provisioning version gate to throw");
		} catch (e) {
			expect((e as { code?: string }).code).toBe("PROVISIONING_VERSION_UNSUPPORTED");
			expect((e as { message?: string }).message).toContain("boot-only");
			expect((e as { installHint?: string }).installHint).toContain("--channel long-term");
		}
	});
});

// --- Mock-fetch helpers ---

function makeMockFetch(fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) {
	return Object.assign(fn, { preconnect: (_url: string | URL) => {} }) as typeof fetch;
}

describe("resolveVersion", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("throws DOWNLOAD_FAILED on HTTP error response", async () => {
		globalThis.fetch = makeMockFetch(() =>
			Promise.resolve(new Response("Service Unavailable", { status: 503 })),
		);
		await expect(resolveVersion("stable")).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
	});

	test("throws INVALID_VERSION when body is not a version string", async () => {
		globalThis.fetch = makeMockFetch(() =>
			Promise.resolve(new Response("not-a-version-at-all 12345")),
		);
		await expect(resolveVersion("stable")).rejects.toMatchObject({ code: "INVALID_VERSION" });
	});

	test("returns version string from valid response", async () => {
		globalThis.fetch = makeMockFetch(() =>
			Promise.resolve(new Response("7.22.1 1774276515")),
		);
		const version = await resolveVersion("stable");
		expect(version).toBe("7.22.1");
	});
});

describe("resolveAllVersions", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("returns versions keyed by channel from mocked server", async () => {
		const channelMap: Record<string, string> = {
			"NEWESTa7.stable": "7.22.1",
			"NEWESTa7.long-term": "7.20.3",
			"NEWESTa7.testing": "7.23beta5",
			"NEWESTa7.development": "7.24rc1",
		};

		globalThis.fetch = makeMockFetch((url) => {
			const urlStr = String(url);
			for (const [key, version] of Object.entries(channelMap)) {
				if (urlStr.includes(key)) {
					return Promise.resolve(new Response(`${version} 1774276515`));
				}
			}
			return Promise.resolve(new Response("", { status: 404 }));
		});

		const result = await resolveAllVersions();
		expect(result.stable).toBe("7.22.1");
		expect(result["long-term"]).toBe("7.20.3");
		expect(result.testing).toBe("7.23beta5");
		expect(result.development).toBe("7.24rc1");
	});
});
