import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { QuickCHR } from "../../src/lib/quickchr.ts";
import { loadMachine, saveMachine } from "../../src/lib/state.ts";
import { firstBootProvisioning, withStoredIdentity } from "../../src/lib/provisioning-window.ts";
import type { ChrInstance, MachineState } from "../../src/lib/types.ts";

/**
 * The identity intent a provisioning run honored is kept, as intent (#265).
 *
 * `add lab --license-level p1`, then `start lab --no-identity`: that start skips the
 * rename. `clean()` reopens the window and keeps intent, so the next plain `start`
 * replays the license — and must replay the opt-out with it, not rename the guest.
 */

const TEST_DIR = join(import.meta.dir, ".tmp-identity-intent");
const NAME = "identity-intent";
const VERSION = "7.22.1";
const origEnv = { dataDir: process.env.QUICKCHR_DATA_DIR, home: process.env.HOME };
let server: Server | null = null;

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
	process.env.HOME = join(TEST_DIR, "home");
});

afterEach(() => {
	server?.close();
	server = null;
	rmSync(TEST_DIR, { recursive: true, force: true });
	if (origEnv.dataDir !== undefined) process.env.QUICKCHR_DATA_DIR = origEnv.dataDir;
	else delete process.env.QUICKCHR_DATA_DIR;
	if (origEnv.home !== undefined) process.env.HOME = origEnv.home;
	else delete process.env.HOME;
});

/** A guest whose license renewal succeeds; the identity endpoint is never expected. */
async function licenseGuest(): Promise<{ port: number; identityCalls: string[] }> {
	const identityCalls: string[] = [];
	let level = "free";
	const s = createServer((req, res) => {
		const url = req.url ?? "/";
		res.writeHead(200, { "Content-Type": "application/json" });
		if (url.includes("/rest/system/identity")) {
			identityCalls.push(`${req.method} ${url}`);
			res.end("[]");
			return;
		}
		if (url.includes("/rest/system/license/renew")) {
			level = "p1";
			res.end(JSON.stringify([{ ".section": "0", status: "connecting" }, { ".section": "1", status: "done" }]));
			return;
		}
		res.end(JSON.stringify({ level, "system-id": "TEST" }));
	});
	server = s;
	await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
	const address = s.address();
	return { port: typeof address === "object" && address ? address.port : 0, identityCalls };
}

/** What `add lab --license-level p1` writes: window open, no identity intent. */
function seedAdded(httpPort: number): MachineState {
	const machineDir = join(TEST_DIR, "machines", NAME);
	mkdirSync(machineDir, { recursive: true });
	writeFileSync(join(machineDir, "disk.img"), "guest-disk");
	const cacheDir = join(TEST_DIR, "cache");
	mkdirSync(cacheDir, { recursive: true });
	writeFileSync(join(cacheDir, `chr-${VERSION}.img`), "fresh-factory-image");
	const state: MachineState = {
		name: NAME,
		version: VERSION,
		arch: "x86",
		cpu: 1,
		mem: 512,
		networks: [{ specifier: "user", id: "net0" }],
		ports: { http: { name: "http", host: httpPort, guest: 80, proto: "tcp" } },
		packages: [],
		license: "p1",
		portBase: httpPort,
		excludePorts: [],
		extraPorts: [],
		createdAt: new Date().toISOString(),
		status: "stopped",
		machineDir,
	};
	saveMachine(state);
	return state;
}

describe("identity intent survives clean() (#265)", () => {
	test("start --no-identity on a first boot is recorded, and clean() replays it", async () => {
		const guest = await licenseGuest();
		const added = seedAdded(guest.port);
		// The first `start lab --no-identity`: the merge start() runs, then provisioning.
		const pending = firstBootProvisioning(added, { identity: false });
		expect(pending?.identity).toBe(false);
		await QuickCHR._provisionInstance(
			{} as ChrInstance,
			added,
			{ ...pending, license: { account: "user@example.com", password: "pw", level: "p1" } },
			{} as never,
		);
		expect(guest.identityCalls).toEqual([]);
		expect(loadMachine(NAME)?.identity).toBe(false);

		const instance = QuickCHR.get(NAME);
		await (instance as NonNullable<typeof instance>).clean();

		const cleaned = loadMachine(NAME) as MachineState;
		expect(cleaned.identity).toBe(false);
		// A plain `start` after clean(): the license replays, and so does the opt-out.
		const replay = firstBootProvisioning(cleaned, {});
		expect(replay?.license).toBe("p1");
		expect(replay?.identity).toBe(false);
		// An explicit `identity: true` overrides the stored opt-out; omission inherits it.
		expect(firstBootProvisioning(cleaned, { identity: true })?.identity).toBe(true);
	}, 30_000);
});

describe("an omitted identity is resolved under the machine lock (#265)", () => {
	// start() hands _launchExisting() only what the caller said; the stored intent is
	// read from the state re-read under the lock, so an opt-out another run stored
	// between start()'s snapshot and the lock is honored, not overwritten.
	test("omitted takes the state's current intent", () => {
		const relocked = { identity: false } as MachineState;
		const request: { license?: string; identity?: boolean } = { license: "p1" };
		const resolved = withStoredIdentity(request, relocked);
		expect(resolved.identity).toBe(false);
		expect(resolved.license).toBe("p1");
		expect(withStoredIdentity({ identity: undefined }, {} as MachineState).identity).toBeUndefined();
	});

	test("an explicit value is kept as passed", () => {
		expect(withStoredIdentity({ identity: true }, { identity: false } as MachineState).identity).toBe(true);
		expect(withStoredIdentity({ identity: false }, {} as MachineState).identity).toBe(false);
	});
});
