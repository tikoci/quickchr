/**
 * Cryptographically random password generation for quickchr managed accounts.
 *
 * Generates URL-safe passwords suitable for RouterOS usernames/passwords
 * and HTTP Basic Auth.  Avoids special characters that cause quoting issues
 * in RouterOS CLI or shell contexts.
 */

const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Generate a cryptographically random password of the given length. */
export function generatePassword(length = 24): string {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	let result = "";
	for (let i = 0; i < length; i++) {
		const byte = bytes[i] as number;
		result += CHARSET[byte % CHARSET.length];
	}
	return result;
}
