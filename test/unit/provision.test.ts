import { describe, expect, test } from "bun:test";
import { matchesManagedSshKey, opensshSha256Fingerprint, SSH_NULL_DEVICE } from "../../src/lib/provision.ts";

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
});
