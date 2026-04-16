/**
 * SSH Key Provisioning Lab
 *
 * Tests SSH public key installation on RouterOS CHR via REST API.
 * Documents the two methods (add vs import) and key type support.
 *
 * Run: QUICKCHR_INTEGRATION=1 bun test test/lab/ssh-keys/ssh-keys.test.ts
 * Requires: A running CHR instance on default ports (9100 HTTP, 9102 SSH)
 */

import { describe, test, expect, afterAll } from "bun:test";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as nodeRequest } from "node:http";

const HTTP_PORT = process.env.CHR_HTTP_PORT ?? "9100";
const SSH_PORT = process.env.CHR_SSH_PORT ?? "9102";
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const AUTH = `Basic ${Buffer.from("admin:").toString("base64")}`;

function restCall(
	method: string,
	path: string,
	body?: object,
	timeoutMs = 10_000,
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		let done = false;
		const timer = setTimeout(() => {
			if (!done) {
				done = true;
				req.destroy();
				reject(new Error("timeout"));
			}
		}, timeoutMs);

		const opts: import("node:http").RequestOptions = {
			hostname: "127.0.0.1",
			port: Number(HTTP_PORT),
			path,
			method,
			headers: {
				Authorization: AUTH,
				"Content-Type": "application/json",
			},
			agent: false,
		};

		const req = nodeRequest(opts, (res) => {
			let data = "";
			res.on("data", (chunk: Buffer) => {
				data += chunk.toString();
			});
			res.on("end", () => {
				if (!done) {
					done = true;
					clearTimeout(timer);
					resolve({ status: res.statusCode ?? 0, body: data });
				}
			});
			res.on("error", (err) => {
				if (!done) {
					done = true;
					clearTimeout(timer);
					reject(err);
				}
			});
		});
		req.on("error", (err) => {
			if (!done) {
				done = true;
				clearTimeout(timer);
				reject(err);
			}
		});
		if (body) req.write(JSON.stringify(body));
		req.end();
	});
}

const tmpDir = mkdtempSync(join(tmpdir(), "ssh-keys-lab-"));
const keyIds: string[] = [];

afterAll(async () => {
	// Clean up all keys we added
	for (const id of keyIds) {
		try {
			await restCall("DELETE", `/rest/user/ssh-keys/${id}`);
		} catch {
			// ignore
		}
	}
	// Clean up temp dir
	rmSync(tmpDir, { recursive: true, force: true });
});

describe.skipIf(!process.env.QUICKCHR_INTEGRATION)(
	"SSH Key Provisioning",
	() => {
		test("add RSA key via PUT /rest/user/ssh-keys", async () => {
			// Generate RSA key
			const keyPath = join(tmpDir, "test-rsa");
			execSync(
				`ssh-keygen -t rsa -b 2048 -f ${keyPath} -N "" -C "lab-rsa-add"`,
				{ stdio: "pipe" },
			);
			const pubKey = readFileSync(`${keyPath}.pub`, "utf-8").trim();

			const { status, body } = await restCall("PUT", "/rest/user/ssh-keys", {
				user: "admin",
				key: pubKey,
			});

			expect(status).toBe(201);
			const result = JSON.parse(body);
			expect(result[".id"]).toBeDefined();
			expect(result["key-owner"]).toBe("lab-rsa-add");
			expect(result.user).toBe("admin");
			expect(result.bits).toBe("2048");
			keyIds.push(result[".id"]);
		});

		test("ed25519 key fails on add (< 7.16)", async () => {
			// ed25519 support was added around 7.16
			const keyPath = join(tmpDir, "test-ed25519");
			execSync(
				`ssh-keygen -t ed25519 -f ${keyPath} -N "" -C "lab-ed25519"`,
				{ stdio: "pipe" },
			);
			const pubKey = readFileSync(`${keyPath}.pub`, "utf-8").trim();

			const { status, body } = await restCall("PUT", "/rest/user/ssh-keys", {
				user: "admin",
				key: pubKey,
			});

			// On 7.10: fails with 400 "wrong format"
			// On newer versions: may succeed — update this test when testing on 7.18+
			const result = JSON.parse(body);
			if (status === 400) {
				expect(result.detail).toContain("unable to load key file");
			} else {
				// If it succeeds on newer version, track the ID for cleanup
				expect(status).toBe(201);
				keyIds.push(result[".id"]);
			}
		});

		test("ECDSA key fails on add", async () => {
			const keyPath = join(tmpDir, "test-ecdsa");
			execSync(
				`ssh-keygen -t ecdsa -b 256 -f ${keyPath} -N "" -C "lab-ecdsa"`,
				{ stdio: "pipe" },
			);
			const pubKey = readFileSync(`${keyPath}.pub`, "utf-8").trim();

			const { status, body } = await restCall("PUT", "/rest/user/ssh-keys", {
				user: "admin",
				key: pubKey,
			});

			// On 7.10: fails — same "wrong format" error
			const result = JSON.parse(body);
			if (status === 400) {
				expect(result.detail).toContain("unable to load key file");
			} else {
				expect(status).toBe(201);
				keyIds.push(result[".id"]);
			}
		});

		test("import RSA key from uploaded file", async () => {
			// Generate a separate RSA key for import test
			const keyPath = join(tmpDir, "test-rsa-import");
			execSync(
				`ssh-keygen -t rsa -b 2048 -f ${keyPath} -N "" -C "lab-rsa-import"`,
				{ stdio: "pipe" },
			);
			const pubKey = readFileSync(`${keyPath}.pub`, "utf-8").trim();

			// Step 1: Upload public key file to RouterOS
			const uploadResult = await restCall("PUT", "/rest/file", {
				name: "lab-import-test.pub",
				contents: pubKey,
			});
			expect(uploadResult.status).toBe(201);

			// Step 2: Import from file
			const importResult = await restCall(
				"POST",
				"/rest/user/ssh-keys/import",
				{
					user: "admin",
					"public-key-file": "lab-import-test.pub",
				},
			);
			expect(importResult.status).toBe(200);

			// Step 3: Verify the key appears in the list
			const listResult = await restCall("GET", "/rest/user/ssh-keys");
			const keys = JSON.parse(listResult.body);
			const imported = keys.find(
				(k: { "key-owner": string }) => k["key-owner"] === "lab-rsa-import",
			);
			expect(imported).toBeDefined();
			expect(imported.user).toBe("admin");
			keyIds.push(imported[".id"]);

			// Clean up uploaded file
			try {
				const files = JSON.parse(
					(await restCall("GET", "/rest/file?.proplist=.id,name")).body,
				);
				const f = files.find(
					(f: { name: string }) => f.name === "lab-import-test.pub",
				);
				if (f) await restCall("DELETE", `/rest/file/${f[".id"]}`);
			} catch {
				// file cleanup best-effort
			}
		});

		test(
			"SSH login works with installed key",
			async () => {
				// Use the RSA key from the first test
				const keyPath = join(tmpDir, "test-rsa");

				const result = spawnSync(
					"ssh",
					[
						"-o",
						"StrictHostKeyChecking=no",
						"-o",
						"UserKnownHostsFile=/dev/null",
						"-o",
						"PasswordAuthentication=no",
						"-o",
						"BatchMode=yes",
						"-i",
						keyPath,
						`admin@127.0.0.1`,
						"-p",
						SSH_PORT,
						':put "ssh-key-auth-works"',
					],
					{ timeout: 15_000, encoding: "utf-8" },
				);

				expect(result.stdout).toContain("ssh-key-auth-works");
				expect(result.status).toBe(0);
			},
			30_000,
		);

		test("remove SSH key via DELETE", async () => {
			// We should have at least one key from earlier tests
			expect(keyIds.length).toBeGreaterThan(0);

			const idToRemove = keyIds[0];
			const { status } = await restCall(
				"DELETE",
				`/rest/user/ssh-keys/${idToRemove}`,
			);
			// DELETE returns 204 No Content on success
			expect(status).toBe(204);

			// Verify it's gone
			const listResult = await restCall("GET", "/rest/user/ssh-keys");
			const keys = JSON.parse(listResult.body);
			const removed = keys.find(
				(k: { ".id": string }) => k[".id"] === idToRemove,
			);
			expect(removed).toBeUndefined();

			// Remove from cleanup list
			keyIds.splice(0, 1);
		});

		test("response shape has expected fields", async () => {
			// List all keys and verify shape
			const { status, body } = await restCall("GET", "/rest/user/ssh-keys");
			expect(status).toBe(200);

			const keys = JSON.parse(body);
			// Should be an array
			expect(Array.isArray(keys)).toBe(true);

			if (keys.length > 0) {
				const key = keys[0];
				// Verify expected fields exist
				expect(key[".id"]).toBeDefined();
				expect(key.user).toBeDefined();
				expect(key["key-owner"]).toBeDefined();
				expect(key.bits).toBeDefined();
				// RSA field exists (meaning unclear — always "false" in our tests)
				expect(key.RSA).toBeDefined();
			}
		});
	},
);
