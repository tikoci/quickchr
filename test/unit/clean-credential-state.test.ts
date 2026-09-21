import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { QuickCHR } from "../../src/lib/quickchr.ts";
import { loadMachine, saveMachine } from "../../src/lib/state.ts";
import { getInstanceCredentials, saveInstanceCredentials, STORED_IN_SECRETS_PASSWORD } from "../../src/lib/credentials.ts";
import { resolveAuth, resolveCreds } from "../../src/lib/auth.ts";
import { assertProvisioningWindow, isProvisioningWindowOpen } from "../../src/lib/provisioning-window.ts";
import type { MachineState } from "../../src/lib/types.ts";

/**
 * Anchors what `clean()` leaves behind (#79 / B6 of #110).
 *
 * `clean()` replaces the disk with a fresh image, so every guest-side account is
 * gone. The credential facts in machine.json must therefore go with the disk, leaving
 * credential resolution on the documented factory fallback: `admin` with an empty
 * password.
 *
 * The provisioning gate goes with them (#176). It used to stay behind: `lastStartedAt`
 * survived the reset, so `start()` took the no-provisioning path and the erased account
 * was never recreated — a factory-fresh disk quickchr would not provision. `clean()` now
 * clears the gate too, so the retained provisioning *intent* is applied again on the
 * next start.
 */

const TEST_DIR = join(import.meta.dir, ".tmp-clean-credential-state");
const NAME = "clean-cred-state";
const VERSION = "7.22.1";

const origEnv = { dataDir: process.env.QUICKCHR_DATA_DIR, home: process.env.HOME };

function machineDir(): string {
	return join(TEST_DIR, "machines", NAME);
}

/** A stopped, fully provisioned machine: managed user, managed SSH key, admin
 *  disabled, credentials in the secret store, keypair on disk. */
function seedProvisionedMachine(): MachineState {
	const dir = machineDir();
	mkdirSync(join(dir, "ssh"), { recursive: true });
	writeFileSync(join(dir, "disk.img"), "stale-guest-disk");
	writeFileSync(join(dir, "ssh", "id_ed25519"), "PRIVATE KEY FOR AN ERASED ACCOUNT");
	writeFileSync(join(dir, "ssh", "id_ed25519.pub"), "ssh-ed25519 AAAA quickchr@clean-cred-state");

	const state: MachineState = {
		name: NAME,
		version: VERSION,
		arch: "x86",
		cpu: 1,
		mem: 512,
		networks: [{ specifier: "user", id: "net0" }],
		ports: {},
		packages: [],
		user: { name: "quickchr", password: STORED_IN_SECRETS_PASSWORD },
		disableAdmin: true,
		secureLogin: true,
		managedSshKey: {
			privateKeyPath: join(dir, "ssh", "id_ed25519"),
			algorithm: "ed25519",
			batchVerified: true,
			verifiedAt: new Date().toISOString(),
		},
		portBase: 9100,
		excludePorts: [],
		extraPorts: [],
		createdAt: new Date().toISOString(),
		lastStartedAt: new Date().toISOString(),
		status: "stopped",
		machineDir: dir,
	};
	saveMachine(state);
	saveInstanceCredentials(NAME, "quickchr", "GeneratedPass1");

	// The image clean() re-copies from — content differs from the seeded disk so
	// the copy is observable without QEMU.
	const cacheDir = join(TEST_DIR, "cache");
	mkdirSync(cacheDir, { recursive: true });
	writeFileSync(join(cacheDir, `chr-${VERSION}.img`), "fresh-factory-image");

	return state;
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
	// Instance credentials fall back to ~/.config/quickchr — keep the real store
	// out of it (secrets.ts resolves HOME at call time, so this is enough).
	process.env.HOME = join(TEST_DIR, "home");
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	if (origEnv.dataDir !== undefined) process.env.QUICKCHR_DATA_DIR = origEnv.dataDir;
	else delete process.env.QUICKCHR_DATA_DIR;
	if (origEnv.home !== undefined) process.env.HOME = origEnv.home;
	else delete process.env.HOME;
});

describe("clean() credential state (#79)", () => {
	test("drops the credential facts factory reset erased", async () => {
		seedProvisionedMachine();

		const instance = QuickCHR.get(NAME);
		expect(instance).not.toBeNull();
		await (instance as NonNullable<typeof instance>).clean();

		const after = loadMachine(NAME);
		expect(after).toBeDefined();
		expect(after?.user).toBeUndefined();
		expect(after?.managedSshKey).toBeUndefined();
		expect(after?.disableAdmin).toBeUndefined();
		expect(getInstanceCredentials(NAME)).toBeNull();
	});

	test("credential resolution falls back to factory admin", async () => {
		const seeded = seedProvisionedMachine();

		// Before: every REST call, exec, and SCP authenticates as the managed user.
		expect(resolveCreds(seeded).user).toBe("quickchr");

		const instance = QuickCHR.get(NAME);
		await (instance as NonNullable<typeof instance>).clean();

		const after = loadMachine(NAME) as MachineState;
		expect(resolveCreds(after)).toEqual({ user: "admin", password: "" });
		expect(resolveAuth(after)).toEqual({ header: `Basic ${btoa("admin:")}`, user: "admin" });
	});

	test("removes the managed keypair and re-copies the fresh image", async () => {
		seedProvisionedMachine();

		const instance = QuickCHR.get(NAME);
		await (instance as NonNullable<typeof instance>).clean();

		expect(existsSync(join(machineDir(), "ssh"))).toBe(false);
		expect(await Bun.file(join(machineDir(), "disk.img")).text()).toBe("fresh-factory-image");
	});

	test("reopens the provisioning window the fresh disk deserves", async () => {
		seedProvisionedMachine();
		const seeded = loadMachine(NAME) as MachineState;
		expect(isProvisioningWindowOpen(seeded)).toBe(false);

		const instance = QuickCHR.get(NAME);
		await (instance as NonNullable<typeof instance>).clean();

		const after = loadMachine(NAME) as MachineState;
		expect(isProvisioningWindowOpen(after)).toBe(true);
		expect(after.provisioning).toBeUndefined();
		expect(after.lastStartedAt).toBeUndefined();
		// The clue lastStartedAt carried is not lost, just relabelled.
		expect(after.cleanedAt).toBeString();
	});

	test("a provisioning option is accepted again after clean(), not refused", async () => {
		seedProvisionedMachine();
		const before = loadMachine(NAME) as MachineState;
		expect(() => assertProvisioningWindow(before, { deviceMode: { enable: ["container"] } }))
			.toThrow(/has already booted/);

		const instance = QuickCHR.get(NAME);
		await (instance as NonNullable<typeof instance>).clean();

		const after = loadMachine(NAME) as MachineState;
		expect(() => assertProvisioningWindow(after, { deviceMode: { enable: ["container"] } })).not.toThrow();
	});

	test("keeps provisioning intent that is not guest state", async () => {
		seedProvisionedMachine();

		const instance = QuickCHR.get(NAME);
		await (instance as NonNullable<typeof instance>).clean();

		const after = loadMachine(NAME);
		expect(after?.secureLogin).toBe(true);
		expect(after?.version).toBe(VERSION);
		expect(after?.portBase).toBe(9100);
	});

	test("leaves the in-memory instance state consistent with machine.json", async () => {
		seedProvisionedMachine();

		const instance = QuickCHR.get(NAME) as NonNullable<ReturnType<typeof QuickCHR.get>>;
		await instance.clean();

		expect(instance.state.user).toBeUndefined();
		expect(instance.state.managedSshKey).toBeUndefined();
		expect(instance.state.disableAdmin).toBeUndefined();
		expect(instance.state.status).toBe("stopped");
	});
});
