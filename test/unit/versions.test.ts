import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { promises as dns } from "node:dns";
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
	channelMaturity,
	classifyChannels,
	selectActiveChannels,
	resolveActiveChannels,
	resolveChannelStatuses,
} from "../../src/lib/versions.ts";
import { CHANNELS } from "../../src/lib/types.ts";
import type { Channel } from "../../src/lib/types.ts";

// Keep these tests fully network-free by forcing fetchResilient off its
// DNS-to-IPv4-direct path: fetchResilient first calls dns.Resolver.resolve4(),
// so we mock resolve4 to fail with ESERVFAIL. That failure is the trigger for
// fetchResilient to use its fallback path (regular fetch on the original URL),
// which is what our mocked globalThis.fetch is intended to exercise here.
// IPv4-direct behavior itself is covered separately in net.test.ts.
beforeEach(() => {
	spyOn(dns.Resolver.prototype, "resolve4").mockRejectedValue(
		Object.assign(new Error("test: DNS disabled"), { code: "ESERVFAIL" }),
	);
});
afterEach(() => {
	mock.restore();
});

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
	});

	test("compareRouterOsVersion orders pre-release suffixes: beta < rc < release < patch", () => {
		// Issue #3 acceptance: betaN < rcN < final release.
		expect(compareRouterOsVersion("7.24beta2", "7.24rc1")).toBeLessThan(0);
		expect(compareRouterOsVersion("7.24rc1", "7.24")).toBeLessThan(0);
		expect(compareRouterOsVersion("7.24beta1", "7.24beta2")).toBeLessThan(0);
		expect(compareRouterOsVersion("7.24rc1", "7.24rc2")).toBeLessThan(0);
		// A patch release is newer than the bare X.Y release.
		expect(compareRouterOsVersion("7.24", "7.24.1")).toBeLessThan(0);
		// Equal suffixes compare equal; rc is newer than beta at the same X.Y.
		expect(compareRouterOsVersion("7.24rc1", "7.24rc1")).toBe(0);
		expect(compareRouterOsVersion("7.20.8rc1", "7.20.8beta1")).toBeGreaterThan(0);
		// X.Y wins over suffix differences when major/minor differ.
		expect(compareRouterOsVersion("7.25beta1", "7.24")).toBeGreaterThan(0);
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

describe("channel recency classification", () => {
	// long-term sits behind stable (released, always active); testing is a stale rc
	// behind stable (pre-release, excluded); development leapfrogged stable (included).
	const versions: Record<Channel, string> = {
		stable: "7.23.1",
		"long-term": "7.21.4",
		testing: "7.22.5",
		development: "7.24beta2",
	};

	test("CHANNELS is frozen so consumers can't mutate library behavior", () => {
		expect(Object.isFrozen(CHANNELS)).toBe(true);
		expect(() => (CHANNELS as Channel[]).push("stable")).toThrow();
	});

	test("channelMaturity partitions released vs pre-release", () => {
		expect(channelMaturity("stable")).toBe("released");
		expect(channelMaturity("long-term")).toBe("released");
		expect(channelMaturity("testing")).toBe("prerelease");
		expect(channelMaturity("development")).toBe("prerelease");
	});

	test("classifyChannels measures aheadOfStable against stable", () => {
		const byChannel = Object.fromEntries(
			classifyChannels(versions).map((s) => [s.channel, s]),
		);
		expect(byChannel.stable).toMatchObject({ maturity: "released", aheadOfStable: true });
		expect(byChannel["long-term"]).toMatchObject({ maturity: "released", aheadOfStable: false });
		expect(byChannel.testing).toMatchObject({ maturity: "prerelease", aheadOfStable: false });
		expect(byChannel.development).toMatchObject({ maturity: "prerelease", aheadOfStable: true });
	});

	test("selectActiveChannels keeps released channels + pre-release at/ahead of stable", () => {
		// long-term included despite being behind stable; testing excluded; development included.
		expect(selectActiveChannels(versions)).toEqual(["stable", "long-term", "development"]);
	});

	test("selectActiveChannels treats a pre-release equal to stable as active", () => {
		const tied: Record<Channel, string> = { ...versions, testing: "7.23.1" };
		expect(selectActiveChannels(tied)).toContain("testing");
	});

	test("selectActiveChannels honors a non-stable reference channel", () => {
		// Against long-term (7.21.4), the stale testing (7.22.5) is now ahead → included.
		expect(selectActiveChannels(versions, { aheadOf: "long-term" })).toEqual([
			"stable",
			"long-term",
			"testing",
			"development",
		]);
	});
});

// --- Mock-fetch helpers ---

// In this codebase/runtime, `fetch` is typed with an extra `preconnect` method.
// Our tests only need regular fetch behavior, so we provide a no-op `preconnect`
// to keep the mock structurally compatible with `typeof fetch`.
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

	test("throws INVALID_VERSION when body is empty", async () => {
		globalThis.fetch = makeMockFetch(() => Promise.resolve(new Response("")));
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
		// Keys are MikroTik "newest-version" URL filename fragments. Production requests
		// resolveVersion/resolveAllVersions hit endpoints containing `NEWESTa7.<channel>`,
		// and this mock matches by `url.includes(key)`, so keys intentionally include the
		// full fragment rather than only channel names.
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

describe("resolveActiveChannels / resolveChannelStatuses (networked wrappers)", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	// testing behind stable (stale rc, excluded); development ahead (included).
	function mockChannels(map: Record<Channel, string>) {
		globalThis.fetch = makeMockFetch((url) => {
			const urlStr = String(url);
			for (const ch of Object.keys(map) as Channel[]) {
				if (urlStr.includes(`NEWESTa7.${ch}`)) {
					return Promise.resolve(new Response(`${map[ch]} 1774276515`));
				}
			}
			return Promise.resolve(new Response("", { status: 404 }));
		});
	}

	test("resolveActiveChannels excludes a stale testing and includes a leapfrogged development", async () => {
		mockChannels({
			stable: "7.23.1",
			"long-term": "7.21.4",
			testing: "7.22.5",
			development: "7.24beta2",
		});
		expect(await resolveActiveChannels()).toEqual(["stable", "long-term", "development"]);
	});

	test("resolveChannelStatuses reports maturity + aheadOfStable from live versions", async () => {
		mockChannels({
			stable: "7.23.1",
			"long-term": "7.21.4",
			testing: "7.22.5",
			development: "7.24beta2",
		});
		const byChannel = Object.fromEntries(
			(await resolveChannelStatuses()).map((s) => [s.channel, s]),
		);
		expect(byChannel.development).toMatchObject({
			version: "7.24beta2",
			maturity: "prerelease",
			aheadOfStable: true,
		});
		expect(byChannel.testing?.aheadOfStable).toBe(false);
	});
});
