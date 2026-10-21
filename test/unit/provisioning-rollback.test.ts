import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failProvisioning, QuickCHR, rollbackFailedProvisioning } from "../../src/lib/quickchr.ts";
import { loadMachine, saveMachine } from "../../src/lib/state.ts";
import { getInstanceCredentials, saveInstanceCredentials, STORED_IN_SECRETS_PASSWORD } from "../../src/lib/credentials.ts";
import { isProvisioningWindowOpen } from "../../src/lib/provisioning-window.ts";
import { QuickCHRError, type ChrInstance, type MachineState } from "../../src/lib/types.ts";

/**
 * A first boot whose provisioning throws is rolled back, so the retry is the same
 * command again (#176).
 *
 * Before this, the throw left a running, half-provisioned guest with `lastStartedAt`
 * set: the provisioning window was closed, and the retry was refused with
 * `PROVISIONING_WINDOW_CLOSED`. These tests drive the rollback directly against a
 * seeded machine directory — no QEMU — the way `clean-credential-state.test.ts`
 * drives `clean()`.
 */

const TEST_DIR = join(import.meta.dir, ".tmp-provisioning-rollback");
const NAME = "rollback-test";
const VERSION = "7.24.4";

const origEnv = {
	dataDir: process.env.QUICKCHR_DATA_DIR,
	home: process.env.HOME,
	preserve: process.env.QUICKCHR_PRESERVE_ON_FAILURE,
};

function machineDir(): string {
	return join(TEST_DIR, "machines", NAME);
}

/** What `add()` recorded: provisioning intent, window open. */
function addedRecord(): MachineState {
	return {
		name: NAME,
		version: VERSION,
		arch: "x86",
		cpu: 1,
		mem: 512,
		networks: [{ specifier: "user", id: "net0" }],
		ports: {},
		packages: [],
		installAllPackages: true,
		user: { name: "ops", password: "OpsPass1" },
		disableAdmin: true,
		portBase: 9100,
		excludePorts: [],
		extraPorts: [],
		createdAt: "2026-10-21T00:00:00.000Z",
		status: "stopped",
		machineDir: machineDir(),
	};
}

/** The same machine after a first boot whose provisioning threw half-way: launched,
 *  a guest account created, a managed keypair on disk, no provisioning record. */
function seedHalfProvisioned(): { instance: ChrInstance; restore: MachineState } {
	const restore = addedRecord();
	const dir = machineDir();
	mkdirSync(join(dir, "ssh"), { recursive: true });
	writeFileSync(join(dir, "disk.img"), "half-provisioned-guest");
	writeFileSync(join(dir, "ssh", "id_ed25519"), "KEY FOR A HALF-CREATED ACCOUNT");
	saveMachine({
		...restore,
		user: { name: "ops", password: STORED_IN_SECRETS_PASSWORD },
		lastStartedAt: "2026-10-21T00:01:00.000Z",
		lastBootMs: 31_000,
		status: "stopped",
	});
	saveInstanceCredentials(NAME, "ops", "OpsPass1");

	const cacheDir = join(TEST_DIR, "cache");
	mkdirSync(cacheDir, { recursive: true });
	writeFileSync(join(cacheDir, `chr-${VERSION}.img`), "fresh-factory-image");

	const instance = QuickCHR.get(NAME);
	if (!instance) throw new Error("seeded machine did not load");
	return { instance, restore };
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
	// Instance credentials fall back to ~/.config/quickchr — keep the real store out.
	process.env.HOME = join(TEST_DIR, "home");
	delete process.env.QUICKCHR_PRESERVE_ON_FAILURE;
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	for (const [key, value] of [
		["QUICKCHR_DATA_DIR", origEnv.dataDir],
		["HOME", origEnv.home],
		["QUICKCHR_PRESERVE_ON_FAILURE", origEnv.preserve],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("rollbackFailedProvisioning — add()-created machine", () => {
	test("puts the disk back to the factory image", async () => {
		const { instance, restore } = seedHalfProvisioned();
		await rollbackFailedProvisioning(instance, restore);
		expect(readFileSync(join(machineDir(), "disk.img"), "utf-8")).toBe("fresh-factory-image");
	});

	test("restores the record add() wrote, so the window is open again", async () => {
		const { instance, restore } = seedHalfProvisioned();
		await rollbackFailedProvisioning(instance, restore);

		const after = loadMachine(NAME) as MachineState;
		expect(after.lastStartedAt).toBeUndefined();
		expect(after.provisioning).toBeUndefined();
		expect(isProvisioningWindowOpen(after)).toBe(true);
		// The intent is the point: a plain `start` has to find it again.
		expect(after.installAllPackages).toBe(true);
		expect(after.user).toEqual({ name: "ops", password: "OpsPass1" });
		expect(after.disableAdmin).toBe(true);
	});

	test("drops credential material for the erased guest account", async () => {
		const { instance, restore } = seedHalfProvisioned();
		await rollbackFailedProvisioning(instance, restore);
		expect(getInstanceCredentials(NAME)).toBeNull();
		expect(existsSync(join(machineDir(), "ssh"))).toBe(false);
	});

	test("updates the handle the caller holds, not just machine.json", async () => {
		const { instance, restore } = seedHalfProvisioned();
		await rollbackFailedProvisioning(instance, restore);
		expect(instance.state.lastStartedAt).toBeUndefined();
		expect(isProvisioningWindowOpen(instance.state)).toBe(true);
	});

	test("the message says the retry is the same command", async () => {
		const { instance, restore } = seedHalfProvisioned();
		const message = await rollbackFailedProvisioning(instance, restore);
		expect(message).toContain("never-booted state");
		expect(message).toContain("re-run the same start command");
	});
});

describe("rollbackFailedProvisioning — start()-created machine", () => {
	test("removes the machine, as a boot timeout does", async () => {
		const { instance } = seedHalfProvisioned();
		const message = await rollbackFailedProvisioning(instance, undefined);
		expect(loadMachine(NAME)).toBeUndefined();
		expect(existsSync(machineDir())).toBe(false);
		expect(message).toContain("has been removed");
	});
});

describe("rollbackFailedProvisioning — QUICKCHR_PRESERVE_ON_FAILURE=1", () => {
	test("leaves the half-provisioned machine for inspection and says how to reset it", async () => {
		process.env.QUICKCHR_PRESERVE_ON_FAILURE = "1";
		const { instance, restore } = seedHalfProvisioned();
		const message = await rollbackFailedProvisioning(instance, restore);

		expect(readFileSync(join(machineDir(), "disk.img"), "utf-8")).toBe("half-provisioned-guest");
		expect(loadMachine(NAME)?.lastStartedAt).toBe("2026-10-21T00:01:00.000Z");
		expect(message).toContain("preserved half-provisioned");
		expect(message).toContain(`quickchr clean ${NAME}`);
	});
});

describe("rollbackFailedProvisioning — a rollback that itself fails", () => {
	test("is reported in the message, not thrown over the provisioning error", async () => {
		const { instance, restore } = seedHalfProvisioned();
		// No factory image to reset from.
		rmSync(join(TEST_DIR, "cache"), { recursive: true, force: true });

		const message = await rollbackFailedProvisioning(instance, restore);
		expect(message).toContain("Rolling back machine");
		expect(message).toContain("also failed");
		expect(message).toContain("Cached image not found");
	});
});

describe("failProvisioning — what start() and _launchExisting() rethrow", () => {
	// Both wrappers are `catch (err) { throw await failProvisioning(err, …) }`. Those
	// paths need a real boot, so test/integration/provisioning.test.ts drives them;
	// this pins the error they rethrow.
	test("keeps the provisioning error's type, code and stack, with the rollback on its own line", async () => {
		const { instance, restore } = seedHalfProvisioned();
		const original = new QuickCHRError("PROCESS_FAILED", 'Failed to create user "-2": HTTP 400 — {"detail":"failure: invalid user name"}');
		const stack = original.stack;

		const rethrown = await failProvisioning(original, instance, restore);

		expect(rethrown).toBe(original);
		expect((rethrown as QuickCHRError).code).toBe("PROCESS_FAILED");
		expect((rethrown as QuickCHRError).stack).toBe(stack);
		expect((rethrown as Error).message).toMatch(/invalid user name"\}\nMachine "rollback-test" was reset/);
	});

	test("wraps a non-Error throw rather than losing it", async () => {
		const { instance } = seedHalfProvisioned();
		const rethrown = await failProvisioning("socket hang up", instance, undefined);
		expect(rethrown).toBeInstanceOf(QuickCHRError);
		expect((rethrown as QuickCHRError).code).toBe("PROCESS_FAILED");
		expect((rethrown as Error).message).toContain("Provisioning failed: socket hang up");
		expect((rethrown as Error).message).toContain("has been removed");
	});
});
