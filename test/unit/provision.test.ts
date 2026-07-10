import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { matchesManagedSshKey, opensshSha256Fingerprint, SSH_NULL_DEVICE, waitForManagedSshKeyListing } from "../../src/lib/provision.ts";

// cspell:ignore NUL
const ED25519_PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM7qj0C9zOslwAKpRuQxpmMlVSBKczuqv+T71uMhQ/w7 quickchr@test";
const ED25519_FINGERPRINT = "SHA256:s0C3Z0xu1KwRxQkbYA4Q4xJmHMO9wR3jF+0VRv/v8qE";

describe("managed SSH key helpers", () => {
	test("uses the platform null device for OpenSSH config isolation", () => {
		expect(SSH_NULL_DEVICE).toBe(process.platform === "win32" ? "NUL" : "/dev/null");
	});

	test("computes OpenSSH SHA256 fingerprints without base64 padding", () => {
		expect(opensshSha256Fingerprint(ED25519_PUBLIC_KEY)).toBe(ED25519_FINGERPRINT);
	});

	test("matches generated key rows across RouterOS field drift", () => {
		expect(matchesManagedSshKey(
			{
				user: "quickchr",
				"key-owner": "quickchr@test",
				"key-type": "ed25519",
				fingerprint: `${ED25519_FINGERPRINT}=`,
			},
			"quickchr",
			"quickchr@test",
			ED25519_FINGERPRINT,
		)).toBe(true);
		expect(matchesManagedSshKey(
			{
				user: "quickchr",
				info: "quickchr@test",
				"key-type": "rsa",
				fingerprint: ED25519_FINGERPRINT,
			},
			"quickchr",
			"quickchr@test",
			ED25519_FINGERPRINT,
		)).toBe(false);
	});

	test("gives a slow first SSH key listing request the full convergence budget", async () => {
		const server = createServer((_req, res) => {
			setTimeout(() => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify([{
					user: "quickchr",
					info: "quickchr@test",
					"key-type": "ed25519",
					fingerprint: ED25519_FINGERPRINT,
				}]));
			}, 150);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			const result = await waitForManagedSshKeyListing(
				address.port,
				"Basic test",
				"quickchr",
				"quickchr@test",
				ED25519_FINGERPRINT,
				1_000,
			);

			expect(result.listed).toBe(true);
			expect(result.attempts).toBe(1);
			expect(result.elapsedMs).toBeGreaterThanOrEqual(100);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	});

	test("tracks retries before the managed key appears", async () => {
		let requests = 0;
		const server = createServer((_req, res) => {
			requests++;
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(requests === 1 ? "[]" : JSON.stringify([{
				user: "quickchr",
				info: "quickchr@test",
				"key-type": "ed25519",
				fingerprint: ED25519_FINGERPRINT,
			}]));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			const result = await waitForManagedSshKeyListing(
				address.port,
				"Basic test",
				"quickchr",
				"quickchr@test",
				ED25519_FINGERPRINT,
				2_000,
			);

			expect(result.listed).toBe(true);
			expect(result.attempts).toBe(2);
			expect(requests).toBe(2);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	});

	test("preserves HTTP status and body when a 2xx listing response isn't valid JSON", async () => {
		const server = createServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end("<html>not json</html>");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			const result = await waitForManagedSshKeyListing(
				address.port,
				"Basic test",
				"quickchr",
				"quickchr@test",
				ED25519_FINGERPRINT,
				300,
			);

			expect(result.listed).toBe(false);
			expect(result.lastDiagnostic).toContain("HTTP 200");
			expect(result.lastDiagnostic).toContain("not json");
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	});
});
