import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { licenseFromStartFlags, parseFlags } from "../../src/cli/index.ts";
import { licenseLevelOf, normalizeLicenseInput, normalizeLicenseLevel, renewLicense } from "../../src/lib/license.ts";
import { assertProvisioningWindow } from "../../src/lib/provisioning-window.ts";
import { QuickCHR } from "../../src/lib/quickchr.ts";
import { acquireLock, acquireLockNow, allocationLockPath, machineLockPath } from "../../src/lib/lock.ts";
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

	describe("half a credential pair", () => {
		const saved = { account: process.env.MIKROTIK_WEB_ACCOUNT, password: process.env.MIKROTIK_WEB_PASSWORD };
		beforeEach(() => {
			delete process.env.MIKROTIK_WEB_ACCOUNT;
			delete process.env.MIKROTIK_WEB_PASSWORD;
		});
		afterEach(() => {
			if (saved.account === undefined) delete process.env.MIKROTIK_WEB_ACCOUNT;
			else process.env.MIKROTIK_WEB_ACCOUNT = saved.account;
			if (saved.password === undefined) delete process.env.MIKROTIK_WEB_PASSWORD;
			else process.env.MIKROTIK_WEB_PASSWORD = saved.password;
		});

		test("the other half comes from its own env var, as before #261", () => {
			process.env.MIKROTIK_WEB_PASSWORD = "env-pw";
			expect(parse("--license-level", "p10", "--license-account", "a@example.com"))
				.toEqual({ account: "a@example.com", password: "env-pw", level: "p10" });
			process.env.MIKROTIK_WEB_ACCOUNT = "env@example.com";
			expect(parse("--license-password", "pw"))
				.toEqual({ account: "env@example.com", password: "pw", level: undefined });
		});

		test("a half no env var completes is refused, naming what is missing", () => {
			expect(() => parse("--license-level", "p1", "--license-account", "a@example.com"))
				.toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
			expect(() => parse("--license-account", "a@example.com")).toThrow(/without --license-password.*MIKROTIK_WEB_PASSWORD/);
			expect(() => parse("--license-password", "pw")).toThrow(/without --license-account.*MIKROTIK_WEB_ACCOUNT/);
		});
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

	test("a post-boot license() records intent, fact and step, like setDeviceMode()", async () => {
		// `set --license --level p10` on a booted machine: clean() must replay p10, and a
		// later `start --license-level p10` is already applied, not refused.
		let level = "free";
		const server = createServer((req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			if (req.url?.includes("/renew")) {
				level = "p10";
				res.end(JSON.stringify([{ ".section": "0", status: "connecting" }, { ".section": "1", status: "done" }]));
				return;
			}
			res.end(JSON.stringify({ level, "system-id": "TEST" }));
		});
		const port = await new Promise<number>((resolve) => {
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				resolve(typeof address === "object" && address ? address.port : 0);
			});
		});
		try {
			saveMachine(added("lic-post-boot", {
				status: "running",
				lastStartedAt: "2026-01-01T00:00:00.000Z",
				ports: { http: { name: "http", host: port, guest: 80, proto: "tcp" } },
			}));
			const instance = QuickCHR.get("lic-post-boot");
			if (!instance) throw new Error("seeded machine did not load");
			await instance.license({ account: "a@example.com", password: "secret", level: "p10" });

			const after = loadMachine("lic-post-boot");
			expect(after?.license).toBe("p10");
			expect(after?.licenseLevel).toBe("p10");
			expect(after?.provisioning?.steps).toContain("license");
			expect(JSON.stringify(after)).not.toContain("secret");
			if (!after) throw new Error("machine vanished");
			expect(assertProvisioningWindow(after, { license: "p10" }).map((ask) => ask.step)).toEqual(["license"]);
		} finally {
			server.close();
		}
	}, 30_000);

	// #303 review: a receive change waiting on the allocator used to save its handle's
	// snapshot over a license recorded meanwhile. Both changes must survive.
	test("license() and a concurrent receive change both persist", async () => {
		const server = createServer((req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			if (req.url?.includes("/renew")) {
				res.end(JSON.stringify([{ ".section": "0", status: "done" }]));
				return;
			}
			res.end(JSON.stringify({ level: "p10", "system-id": "TEST" }));
		});
		const port = await new Promise<number>((resolve) => {
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				resolve(typeof address === "object" && address ? address.port : 0);
			});
		});
		const allocator = await acquireLock(allocationLockPath(), "allocate");
		let released = false;
		try {
			saveMachine(added("lic-race", {
				status: "running",
				lastStartedAt: "2026-01-01T00:00:00.000Z",
				ports: { http: { name: "http", host: port, guest: 80, proto: "tcp" } },
			}));
			const receiver = QuickCHR.get("lic-race");
			const licenser = QuickCHR.get("lic-race");
			if (!receiver || !licenser) throw new Error("seeded machine did not load");
			// Takes the machine lock, then waits for the allocator this test holds.
			const receive = receiver.addReceivePort("tzsp");
			await Bun.sleep(200);
			const license = licenser.license({ account: "a@example.com", password: "secret", level: "p10" });
			await Bun.sleep(300);
			allocator.release();
			released = true;
			await Promise.all([receive, license]);

			const after = loadMachine("lic-race");
			expect(after?.licenseLevel).toBe("p10");
			expect(after?.receivePorts).toEqual([{ name: "tzsp", port: 37008, proto: "udp" }]);
		} finally {
			if (!released) allocator.release();
			server.close();
		}
	}, 30_000);

	// #303 review: the renew ran before the lock, so a `clean` holding it could reset the
	// disk after the guest verified the level and the record would still claim it.
	test("license() does not reach the guest while another operation holds the machine lock", async () => {
		let renews = 0;
		const server = createServer((req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			if (req.url?.includes("/renew")) {
				renews++;
				res.end(JSON.stringify([{ ".section": "0", status: "done" }]));
				return;
			}
			res.end(JSON.stringify({ level: "p10", "system-id": "TEST" }));
		});
		const port = await new Promise<number>((resolve) => {
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				resolve(typeof address === "object" && address ? address.port : 0);
			});
		});
		const state = added("lic-locked", {
			status: "running",
			lastStartedAt: "2026-01-01T00:00:00.000Z",
			ports: { http: { name: "http", host: port, guest: 80, proto: "tcp" } },
		});
		saveMachine(state);
		const held = acquireLockNow(machineLockPath(state.machineDir), "clean");
		let released = false;
		try {
			const instance = QuickCHR.get("lic-locked");
			if (!instance) throw new Error("seeded machine did not load");
			const license = instance.license({ account: "a@example.com", password: "secret", level: "p10" });
			await Bun.sleep(400);
			expect(renews).toBe(0);
			held.release();
			released = true;
			await license;
			expect(renews).toBe(1);
			expect(loadMachine("lic-locked")?.licenseLevel).toBe("p10");
		} finally {
			if (!released) held.release();
			server.close();
		}
	}, 30_000);
});
