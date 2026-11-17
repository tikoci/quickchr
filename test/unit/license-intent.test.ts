import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { licenseFromStartFlags, parseFlags } from "../../src/cli/index.ts";
import { licenseLevelOf, normalizeLicenseInput, normalizeLicenseLevel, renewLicense } from "../../src/lib/license.ts";
import { QuickCHR } from "../../src/lib/quickchr.ts";
import { loadMachine, saveMachine } from "../../src/lib/state.ts";
import type { MachineState } from "../../src/lib/types.ts";

/**
 * License levels, the first-boot license intent `add` records, and where `start`
 * looks for MikroTik.com credentials (#261).
 *
 * RouterOS's `/system/license/renew level=` takes `p1`, `p10` and `p-unlimited` —
 * grounded on CHR 7.20.8 and 7.25.1 via `/console/inspect` completion. quickchr
 * documented `unlimited`, which RouterOS answers with HTTP 400.
 */

describe("normalizeLicenseLevel", () => {
	test("RouterOS spellings pass through", () => {
		expect(normalizeLicenseLevel("p1")).toBe("p1");
		expect(normalizeLicenseLevel("p10")).toBe("p10");
		expect(normalizeLicenseLevel("p-unlimited")).toBe("p-unlimited");
	});

	test("the old 'unlimited' spelling becomes p-unlimited", () => {
		expect(normalizeLicenseLevel("unlimited")).toBe("p-unlimited");
	});

	test("anything else is refused before it reaches RouterOS", () => {
		for (const bad of ["", "free", "p100", "P1", "max"]) {
			expect(() => normalizeLicenseLevel(bad)).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
		}
		expect(() => normalizeLicenseLevel("p100")).toThrow(/p1, p10, p-unlimited/);
	});

	test("normalizeLicenseInput keeps credentials and normalizes only the level", () => {
		expect(normalizeLicenseInput("unlimited")).toBe("p-unlimited");
		expect(normalizeLicenseInput({ account: "a@example.com", password: "pw", level: "unlimited" }))
			.toEqual({ account: "a@example.com", password: "pw", level: "p-unlimited" });
		expect(normalizeLicenseInput({ account: "a@example.com", password: "pw" }))
			.toEqual({ account: "a@example.com", password: "pw" });
	});

	test("licenseLevelOf defaults to p1, the level renew applies when none is named", () => {
		expect(licenseLevelOf({})).toBe("p1");
		expect(licenseLevelOf({ account: "a@example.com", password: "pw" })).toBe("p1");
		expect(licenseLevelOf("p10")).toBe("p10");
		expect(licenseLevelOf({ level: "unlimited" })).toBe("p-unlimited");
	});
});

describe("renewLicense sends the RouterOS spelling", () => {
	let server: Server | null = null;
	afterEach(() => {
		server?.close();
		server = null;
	});

	test("level 'unlimited' goes out as p-unlimited and the read-back matches", async () => {
		const bodies: Record<string, string>[] = [];
		let level = "free";
		const port = await new Promise<number>((resolve) => {
			server = createServer((req, res) => {
				let raw = "";
				req.on("data", (chunk) => { raw += chunk; });
				req.on("end", () => {
					res.writeHead(200, { "Content-Type": "application/json" });
					if (req.url?.includes("/renew")) {
						const body = JSON.parse(raw) as Record<string, string>;
						bodies.push(body);
						// The real renew rejects anything outside its enum with HTTP 400.
						if (!["p1", "p10", "p-unlimited"].includes(body.level ?? "")) {
							res.writeHead(400);
							res.end(JSON.stringify({ detail: "input does not match any value of level", error: 400 }));
							return;
						}
						level = body.level as string;
						res.end(JSON.stringify([{ ".section": "0", status: "connecting" }, { ".section": "1", status: "done" }]));
						return;
					}
					res.end(JSON.stringify({ level, "system-id": "TEST" }));
				});
			});
			server.listen(0, "127.0.0.1", () => {
				const address = server?.address();
				resolve(typeof address === "object" && address ? address.port : 0);
			});
		});

		await renewLicense(port, { account: "a@example.com", password: "pw", level: "unlimited" });
		expect(bodies).toHaveLength(1);
		expect(bodies[0]?.level).toBe("p-unlimited");
		expect(level).toBe("p-unlimited");
	});
});

describe("licenseFromStartFlags — start passes only what was typed", () => {
	const parse = (...argv: string[]) => licenseFromStartFlags(parseFlags(argv).flags);

	test("no license flag, no license request", () => {
		expect(parse("lab")).toBeUndefined();
	});

	test("--license-level alone is a request; credentials are left to the library's chain", () => {
		// Before #261 this exited: the CLI required a flag or env var and never asked
		// the secret store that `set --license` reads.
		expect(parse("lab", "--license-level", "unlimited")).toEqual({ account: undefined, password: undefined, level: "unlimited" });
	});

	test("explicit credentials ride along", () => {
		expect(parse("--license-level", "p10", "--license-account", "a@example.com", "--license-password", "pw"))
			.toEqual({ account: "a@example.com", password: "pw", level: "p10" });
	});

	test("half a credential pair is refused", () => {
		expect(() => parse("--license-level", "p1", "--license-account", "a@example.com"))
			.toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
		expect(() => parse("--license-password", "pw")).toThrow(/go together/);
	});
});

describe("start() with a license request", () => {
	const TEST_DIR = join(import.meta.dir, ".tmp-license-intent");
	const saved = {
		QUICKCHR_DATA_DIR: process.env.QUICKCHR_DATA_DIR,
		HOME: process.env.HOME,
		MIKROTIK_WEB_ACCOUNT: process.env.MIKROTIK_WEB_ACCOUNT,
		MIKROTIK_WEB_PASSWORD: process.env.MIKROTIK_WEB_PASSWORD,
	};
	let secretsSpy: ReturnType<typeof spyOn> | null = null;

	beforeEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
		mkdirSync(TEST_DIR, { recursive: true });
		process.env.QUICKCHR_DATA_DIR = TEST_DIR;
		// The config-file fallback of the secret store lives under HOME.
		process.env.HOME = join(TEST_DIR, "home");
		delete process.env.MIKROTIK_WEB_ACCOUNT;
		delete process.env.MIKROTIK_WEB_PASSWORD;
		// Never consult the developer's real keychain.
		if (typeof Bun !== "undefined" && Bun.secrets) {
			secretsSpy = spyOn(Bun.secrets, "get").mockResolvedValue(null);
		}
	});

	afterEach(() => {
		secretsSpy?.mockRestore();
		secretsSpy = null;
		rmSync(TEST_DIR, { recursive: true, force: true });
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	function added(name: string, overrides: Partial<MachineState> = {}): MachineState {
		return {
			name,
			version: "7.24.5",
			arch: "x86",
			cpu: 1,
			mem: 512,
			networks: [{ specifier: "user", id: "net0" }],
			ports: {},
			packages: [],
			portBase: 9130,
			excludePorts: [],
			extraPorts: [],
			createdAt: "2026-01-01T00:00:00.000Z",
			status: "stopped",
			machineDir: join(TEST_DIR, "machines", name),
			...overrides,
		};
	}

	test("an add-recorded license with no credentials anywhere is refused before the boot", async () => {
		saveMachine(added("lic-recorded", { license: "p10" }));
		await expect(QuickCHR.start({ name: "lic-recorded" })).rejects.toMatchObject({
			code: "PROCESS_FAILED",
			message: expect.stringContaining("MIKROTIK_WEB_ACCOUNT"),
		});
		const after = loadMachine("lic-recorded");
		expect(after?.status).toBe("stopped");
		expect(after?.lastStartedAt).toBeUndefined();
		expect(after?.license).toBe("p10");
	});

	test("an unknown level is refused before anything else", async () => {
		await expect(QuickCHR.start({ name: "lic-bad", version: "7.24.5", license: "p100" as "p1", dryRun: true }))
			.rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
	});

	test("a new machine records the requested level as intent, in RouterOS spelling", async () => {
		const instance = await QuickCHR.start({ name: "lic-new", version: "7.24.5", license: "unlimited", dryRun: true });
		expect(instance.state.license).toBe("p-unlimited");
	});

	test("explicit credentials are never recorded — only the level", async () => {
		const instance = await QuickCHR.start({
			name: "lic-creds",
			version: "7.24.5",
			license: { account: "a@example.com", password: "secret", level: "p1" },
			dryRun: true,
		});
		expect(instance.state.license).toBe("p1");
		expect(JSON.stringify(instance.state)).not.toContain("secret");
	});
});
