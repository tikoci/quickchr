import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const TMP = join(import.meta.dir, ".tmp-secrets");
const HOME = join(TMP, "home");
const originalBunSecrets = Bun.secrets;
const originalHome = process.env.HOME;

function setBunSecrets(value: typeof Bun.secrets | undefined): void {
	Object.defineProperty(Bun, "secrets", {
		value,
		writable: true,
		enumerable: true,
		configurable: false,
	});
}

function configPath(home: string, service: string): string {
	const safeName = service.replace(/[^a-zA-Z0-9._-]/g, "_");
	return join(home, ".config", "quickchr", `${safeName}.json`);
}

const secretsPromise = import("../../src/lib/secrets.ts");

beforeEach(() => {
	process.env.HOME = HOME;
});

afterEach(() => {
	setBunSecrets(originalBunSecrets);
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	rmSync(TMP, { recursive: true, force: true });
});

describe("secrets config-file fallback", () => {
	test("sync helpers read, write, sanitize service names, and use 0600 permissions", async () => {
		const service = "svc/with spaces";
		const secrets = await secretsPromise;
		setBunSecrets(undefined);

		secrets.secretSetSync(service, "token", "abc123");

		const path = configPath(HOME, service);
		expect(existsSync(path)).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ token: "abc123" });
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(secrets.secretGetSync(service, "token")).toBe("abc123");

		expect(secrets.secretDeleteSync(service, "token")).toBe(true);
		expect(secrets.secretGetSync(service, "token")).toBeNull();
		expect(secrets.secretDeleteSync(service, "token")).toBe(false);
	});

	test("secretGet uses Bun.secrets directly when available", async () => {
		const secrets = await secretsPromise;
		setBunSecrets({
			get: async ({ name }: { service: string; name: string }) =>
				name === "token" ? "keychain-value" : null,
			set: async () => {},
			delete: async () => false,
		});

		await expect(secrets.secretGet("svc", "token")).resolves.toBe("keychain-value");
		await expect(secrets.secretGet("svc", "other")).resolves.toBeNull();
	});

	test("secretGet falls back to config file when Bun.secrets.get throws", async () => {
		const secrets = await secretsPromise;
		setBunSecrets({
			get: async () => {
				throw new Error("no keyring");
			},
			set: async () => {},
			delete: async () => false,
		});

		secrets.secretSetSync("svc", "account", "alice");

		await expect(secrets.secretGet("svc", "account")).resolves.toBe("alice");
	});

	test("secretSet and secretDelete fall back to config file when Bun.secrets throws", async () => {
		const secrets = await secretsPromise;
		setBunSecrets({
			get: async () => null,
			set: async () => {
				throw new Error("no keyring");
			},
			delete: async () => {
				throw new Error("no keyring");
			},
		});

		await secrets.secretSet("svc", "password", "p@ss");
		expect(secrets.secretGetSync("svc", "password")).toBe("p@ss");

		await expect(secrets.secretDelete("svc", "password")).resolves.toBe(true);
		expect(secrets.secretGetSync("svc", "password")).toBeNull();
	});

	test("secretDelete always cleans up config file even when Bun.secrets.delete succeeds", async () => {
		// secretDelete is belt-and-suspenders: it always removes from the config
		// file too, even when Bun.secrets succeeds. This covers the migration case
		// where a value was written by an older version that used only config files.
		const secrets = await secretsPromise;

		secrets.secretSetSync("svc", "key", "value");

		setBunSecrets({
			get: async () => null,
			set: async () => {},
			delete: async () => true, // Bun.secrets reports success
		});

		const result = await secrets.secretDelete("svc", "key");
		expect(result).toBe(true);
		// Config file entry must be gone even though Bun.secrets claimed to delete it
		expect(secrets.secretGetSync("svc", "key")).toBeNull();
	});

	test("secretStorageLabel reflects whether Bun.secrets is available", async () => {
		const secrets = await secretsPromise;

		setBunSecrets(undefined);
		expect(secrets.secretStorageLabel()).toBe(`config file (${join(HOME, ".config", "quickchr")})`);

		setBunSecrets({
			get: async () => null,
			set: async () => {},
			delete: async () => false,
		});
		expect(secrets.secretStorageLabel()).toBe("OS credential store (via Bun.secrets)");
	});
});
