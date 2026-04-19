import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deleteInstanceCredentials, getInstanceCredentials, getStoredCredentials, saveCredentials, saveInstanceCredentials, credentialStorageLabel, deleteCredentials } from "../../src/lib/credentials.ts";

const TMP = join(import.meta.dir, ".tmp-credentials");
const HOME = join(TMP, "home");
const originalBunSecrets = Bun.secrets;
const originalEnv = {
	account: process.env.MIKROTIK_WEB_ACCOUNT,
	password: process.env.MIKROTIK_WEB_PASSWORD,
	home: process.env.HOME,
};

function setBunSecrets(value: typeof Bun.secrets | undefined): void {
	Object.defineProperty(Bun, "secrets", {
		value,
		writable: true,
		enumerable: true,
		configurable: false,
	});
}

function configPath(service: string): string {
	const safeName = service.replace(/[^a-zA-Z0-9._-]/g, "_");
	return join(HOME, ".config", "quickchr", `${safeName}.json`);
}

beforeEach(() => {
	process.env.HOME = HOME;
});

afterEach(() => {
	setBunSecrets(originalBunSecrets);

	if (originalEnv.account === undefined) {
		delete process.env.MIKROTIK_WEB_ACCOUNT;
	} else {
		process.env.MIKROTIK_WEB_ACCOUNT = originalEnv.account;
	}

	if (originalEnv.password === undefined) {
		delete process.env.MIKROTIK_WEB_PASSWORD;
	} else {
		process.env.MIKROTIK_WEB_PASSWORD = originalEnv.password;
	}

	if (originalEnv.home === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalEnv.home;
	}

	rmSync(TMP, { recursive: true, force: true });
});

describe("credentials helpers", () => {
	test("getStoredCredentials prefers environment variables over the secret store", async () => {
		let getCalls = 0;
		setBunSecrets({
			get: async () => {
				getCalls += 1;
				return "should-not-be-used";
			},
			set: async () => {},
			delete: async () => false,
		});

		process.env.MIKROTIK_WEB_ACCOUNT = "env-account";
		process.env.MIKROTIK_WEB_PASSWORD = "env-password";

		await expect(getStoredCredentials()).resolves.toEqual({
			account: "env-account",
			password: "env-password",
		});
		expect(getCalls).toBe(0);
	});

	test("getStoredCredentials falls back to the secret store and requires both values", async () => {
		setBunSecrets({
			get: async ({ name }: { service: string; name: string }) =>
				name === "account" ? "stored-account" : "stored-password",
			set: async () => {},
			delete: async () => false,
		});

		delete process.env.MIKROTIK_WEB_ACCOUNT;
		delete process.env.MIKROTIK_WEB_PASSWORD;

		await expect(getStoredCredentials()).resolves.toEqual({
			account: "stored-account",
			password: "stored-password",
		});

		setBunSecrets({
			get: async ({ name }: { service: string; name: string }) =>
				name === "account" ? "stored-account" : null,
			set: async () => {},
			delete: async () => false,
		});

		await expect(getStoredCredentials()).resolves.toBeNull();
	});

	test("saveCredentials and deleteCredentials delegate to the secret store", async () => {
		const calls: string[] = [];
		setBunSecrets({
			get: async () => null,
			set: async ({ service, name, value }: { service: string; name: string; value: string }) => {
				calls.push(`set:${service}:${name}:${value}`);
			},
			delete: async ({ service, name }: { service: string; name: string }) => {
				calls.push(`delete:${service}:${name}`);
				return true;
			},
		});

		await saveCredentials("alice", "pw");
		await deleteCredentials();

		expect(calls).toEqual([
			"set:com.quickchr.mikrotik-web:account:alice",
			"set:com.quickchr.mikrotik-web:password:pw",
			"delete:com.quickchr.mikrotik-web:account",
			"delete:com.quickchr.mikrotik-web:password",
		]);
	});

	test("credentialStorageLabel reflects live storage mode", () => {
		setBunSecrets(undefined);
		expect(credentialStorageLabel()).toBe(`config file (${join(HOME, ".config", "quickchr")})`);

		setBunSecrets({
			get: async () => null,
			set: async () => {},
			delete: async () => false,
		});
		expect(credentialStorageLabel()).toBe("OS credential store (via Bun.secrets)");
	});

	test("getInstanceCredentials returns parsed credentials and rejects corrupt entries", () => {
		saveInstanceCredentials("alpha", "quickchr", "secret");
		expect(getInstanceCredentials("alpha")).toEqual({
			user: "quickchr",
			password: "secret",
		});

		const path = configPath("com.quickchr.instance");
		writeFileSync(path, '{\n  "alpha": "{not-json"\n}', "utf8");
		expect(getInstanceCredentials("alpha")).toBeNull();

		writeFileSync(path, '{\n  "alpha": "{\\"user\\":\\"quickchr\\"}"\n}', "utf8");
		expect(getInstanceCredentials("alpha")).toBeNull();
	});

	test("saveInstanceCredentials and deleteInstanceCredentials use config-backed sync storage", () => {
		saveInstanceCredentials("alpha", "quickchr", "secret");

		const path = configPath("com.quickchr.instance");
		expect(existsSync(path)).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			alpha: '{"user":"quickchr","password":"secret"}',
		});

		deleteInstanceCredentials("alpha");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
	});
});
