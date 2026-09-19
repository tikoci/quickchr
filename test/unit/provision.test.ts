import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { matchesManagedSshKey, opensshSha256Fingerprint, SSH_NULL_DEVICE, waitForAuth, waitForManagedSshKeyListing } from "../../src/lib/provision.ts";

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

describe("waitForAuth", () => {
	/** Stand up a node:http server (restGet uses node:http, not fetch), run fn
	 *  against its port, then close it. */
	async function withServer(
		handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
		fn: (port: number) => Promise<void>,
	): Promise<void> {
		const server = createServer(handler);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			await fn(address.port);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	}

	test("returns immediately when the credentials already work", async () => {
		await withServer(
			(_req, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ "board-name": "CHR" }));
			},
			async (port) => {
				const { attempts, elapsedMs } = await waitForAuth(port, "Basic test", 5_000);
				expect(attempts).toBe(1);
				expect(elapsedMs).toBeLessThan(250);
			},
		);
	});

	test("polls through the 401 window and reports how long it lasted", async () => {
		// The #69 shape: the user record exists, so RouterOS answers, but www
		// rejects the new credentials for a few hundred milliseconds first.
		let requests = 0;
		await withServer(
			(_req, res) => {
				requests++;
				if (requests <= 2) {
					res.writeHead(401);
					res.end("");
					return;
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ "board-name": "CHR" }));
			},
			async (port) => {
				const { attempts, elapsedMs } = await waitForAuth(port, "Basic test", 5_000);
				expect(requests).toBe(3);
				// The attempt count is the claim; elapsed is corroboration only,
				// since request latency alone could account for the milliseconds.
				expect(attempts).toBe(3);
				expect(elapsedMs).toBeGreaterThanOrEqual(400);
			},
		);
	});

	test("polls through a transient 5xx as well as a 401", async () => {
		let requests = 0;
		await withServer(
			(_req, res) => {
				requests++;
				if (requests === 1) { res.writeHead(500); res.end(""); return; }
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ "board-name": "CHR" }));
			},
			async (port) => {
				await waitForAuth(port, "Basic test", 5_000);
				expect(requests).toBe(2);
			},
		);
	});

	test("reports the attempt count, not just elapsed time", async () => {
		// Regression guard for the measurement error this wait was built around:
		// a single slow-but-successful request must read as one attempt, never
		// as a propagation delay.
		await withServer(
			(_req, res) => {
				setTimeout(() => {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ "board-name": "CHR" }));
				}, 600);
			},
			async (port) => {
				const { attempts, elapsedMs } = await waitForAuth(port, "Basic test", 5_000);
				expect(attempts).toBe(1);
				expect(elapsedMs).toBeGreaterThanOrEqual(600);
			},
		);
	});

	test("throws naming the last status when the credentials never work", async () => {
		await withServer(
			(_req, res) => { res.writeHead(401); res.end(""); },
			async (port) => {
				// The failure has to say "visible but not authenticating" rather
				// than surfacing a bare 401 — that distinction is the whole point
				// of the wait existing (#69).
				await expect(waitForAuth(port, "Basic test", 600)).rejects.toThrow(/attempt\(s\).*last HTTP status: 401/);
			},
		);
	});
});
