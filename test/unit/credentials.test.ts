import { describe, test, expect, afterEach, mock } from "bun:test";

const originalEnv = {
	account: process.env.MIKROTIK_WEB_ACCOUNT,
	password: process.env.MIKROTIK_WEB_PASSWORD,
};

function makeSecretsMock() {
	return {
		secretGet: mock(async (_service: string, _name: string) => null as string | null),
		secretSet: mock(async (_service: string, _name: string, _value: string) => {}),
		secretDelete: mock(async (_service: string, _name: string) => false),
		secretStorageLabel: mock(() => "mock storage"),
		secretGetSync: mock((_service: string, _name: string) => null as string | null),
		secretSetSync: mock((_service: string, _name: string, _value: string) => {}),
		secretDeleteSync: mock((_service: string, _name: string) => false),
	};
}

const secretsMock = makeSecretsMock();

function resetSecretsMock(): void {
	secretsMock.secretGet.mockReset();
	secretsMock.secretGet.mockImplementation(async () => null);
	secretsMock.secretSet.mockReset();
	secretsMock.secretSet.mockImplementation(async () => {});
	secretsMock.secretDelete.mockReset();
	secretsMock.secretDelete.mockImplementation(async () => false);
	secretsMock.secretStorageLabel.mockReset();
	secretsMock.secretStorageLabel.mockImplementation(() => "mock storage");
	secretsMock.secretGetSync.mockReset();
	secretsMock.secretGetSync.mockImplementation(() => null);
	secretsMock.secretSetSync.mockReset();
	secretsMock.secretSetSync.mockImplementation(() => {});
	secretsMock.secretDeleteSync.mockReset();
	secretsMock.secretDeleteSync.mockImplementation(() => false);
}

mock.module("../../src/lib/secrets.ts", () => secretsMock);

const credentialsPromise = import("../../src/lib/credentials.ts");

afterEach(() => {
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

	resetSecretsMock();
});

describe("credentials helpers", () => {
	test("getStoredCredentials prefers environment variables over the secret store", async () => {
		process.env.MIKROTIK_WEB_ACCOUNT = "env-account";
		process.env.MIKROTIK_WEB_PASSWORD = "env-password";

		const credentials = await credentialsPromise;
		await expect(credentials.getStoredCredentials()).resolves.toEqual({
			account: "env-account",
			password: "env-password",
		});
		expect(secretsMock.secretGet).not.toHaveBeenCalled();
	});

	test("getStoredCredentials falls back to the secret store and requires both values", async () => {
		secretsMock.secretGet.mockImplementation(async (_service, name) =>
			name === "account" ? "stored-account" : "stored-password"
		);

		delete process.env.MIKROTIK_WEB_ACCOUNT;
		delete process.env.MIKROTIK_WEB_PASSWORD;

		const credentials = await credentialsPromise;
		await expect(credentials.getStoredCredentials()).resolves.toEqual({
			account: "stored-account",
			password: "stored-password",
		});

		secretsMock.secretGet.mockImplementation(async (_service, name) =>
			name === "account" ? "stored-account" : null
		);
		await expect(credentials.getStoredCredentials()).resolves.toBeNull();
	});

	test("saveCredentials and deleteCredentials delegate to the secret store", async () => {
		const credentials = await credentialsPromise;

		await credentials.saveCredentials("alice", "pw");
		expect(secretsMock.secretSet.mock.calls).toEqual([
			["com.quickchr.mikrotik-web", "account", "alice"],
			["com.quickchr.mikrotik-web", "password", "pw"],
		]);

		await credentials.deleteCredentials();
		expect(secretsMock.secretDelete.mock.calls).toEqual([
			["com.quickchr.mikrotik-web", "account"],
			["com.quickchr.mikrotik-web", "password"],
		]);
	});

	test("credentialStorageLabel proxies the secrets label", async () => {
		secretsMock.secretStorageLabel.mockReturnValue("config file (/tmp/test)");

		const credentials = await credentialsPromise;
		expect(credentials.credentialStorageLabel()).toBe("config file (/tmp/test)");
	});

	test("getInstanceCredentials returns parsed credentials and rejects corrupt entries", async () => {
		secretsMock.secretGetSync.mockReturnValueOnce('{"user":"quickchr","password":"secret"}');

		const credentials = await credentialsPromise;
		expect(credentials.getInstanceCredentials("alpha")).toEqual({
			user: "quickchr",
			password: "secret",
		});

		secretsMock.secretGetSync.mockReturnValueOnce("{not-json");
		expect(credentials.getInstanceCredentials("alpha")).toBeNull();

		secretsMock.secretGetSync.mockReturnValueOnce('{"user":"quickchr"}');
		expect(credentials.getInstanceCredentials("alpha")).toBeNull();
	});

	test("saveInstanceCredentials and deleteInstanceCredentials use sync secret helpers", async () => {
		const credentials = await credentialsPromise;

		credentials.saveInstanceCredentials("alpha", "quickchr", "secret");
		expect(secretsMock.secretSetSync).toHaveBeenCalledWith(
			"com.quickchr.instance",
			"alpha",
			'{"user":"quickchr","password":"secret"}',
		);

		credentials.deleteInstanceCredentials("alpha");
		expect(secretsMock.secretDeleteSync).toHaveBeenCalledWith("com.quickchr.instance", "alpha");
	});
});
