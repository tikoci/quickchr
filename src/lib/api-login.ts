/**
 * Native API (`/login` on guest port 8728) as a readiness signal.
 *
 * Built for RouterOS 6, which has no REST API, so the REST probe can never succeed
 * against it — the field report behind #182 watched a 6.49 guest answer www, ssh and
 * api from 15 s in, then get removed at 180 s for not answering `/rest`. It is written
 * as a general alternative to the REST probe rather than a v6 special case: a 7.x
 * guest with REST disabled is the same problem.
 *
 * Only the post-6.43 plain login is spoken (`=name=` + `=password=` in one sentence).
 * Grounded against CHR 6.49.23 under HVF, 2026-10-21:
 *
 * - `admin` / empty password → `!done`, as one 7-byte reply.
 * - wrong user or password → `!trap =message=invalid user name or password (6)`
 *   followed by `!done`, in the same read.
 *
 * Either answer means the API service is up, the way a REST 401 does — the probe is a
 * readiness check, not a credential check.
 */

import { connect } from "node:net";

/** Encode one API word length (RouterOS API "length" prefix, 1–5 bytes). */
export function encodeApiLength(length: number): Uint8Array {
	if (length < 0x80) return Uint8Array.of(length);
	if (length < 0x4000) return Uint8Array.of((length >> 8) | 0x80, length & 0xff);
	if (length < 0x200000) return Uint8Array.of((length >> 16) | 0xc0, (length >> 8) & 0xff, length & 0xff);
	if (length < 0x10000000) {
		return Uint8Array.of((length >>> 24) | 0xe0, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff);
	}
	return Uint8Array.of(0xf0, (length >>> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff);
}

/** A sentence is its words, each length-prefixed, then a zero-length word. */
export function encodeApiSentence(words: string[]): Uint8Array {
	const encoder = new TextEncoder();
	const parts: Uint8Array[] = [];
	for (const word of words) {
		const bytes = encoder.encode(word);
		parts.push(encodeApiLength(bytes.length), bytes);
	}
	parts.push(Uint8Array.of(0));
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

/** Decode a length prefix at `offset`. `null` when the buffer ends inside it. */
function decodeApiLength(buf: Uint8Array, offset: number): { length: number; size: number } | null {
	const first = buf[offset];
	if (first === undefined) return null;
	const size = (first & 0x80) === 0 ? 1
		: (first & 0xc0) === 0x80 ? 2
		: (first & 0xe0) === 0xc0 ? 3
		: (first & 0xf0) === 0xe0 ? 4
		: 5;
	if (offset + size > buf.length) return null;
	let length = size === 5 ? 0 : first & (0xff >> size);
	for (let i = 1; i < size; i++) length = length * 256 + (buf[offset + i] ?? 0);
	return { length, size };
}

/** Every complete sentence in `buf`; a trailing partial sentence is left out. */
export function parseApiSentences(buf: Uint8Array): string[][] {
	const decoder = new TextDecoder();
	const sentences: string[][] = [];
	let words: string[] = [];
	let offset = 0;
	while (offset < buf.length) {
		const prefix = decodeApiLength(buf, offset);
		if (!prefix || offset + prefix.size + prefix.length > buf.length) break;
		offset += prefix.size;
		if (prefix.length === 0) {
			sentences.push(words);
			words = [];
			continue;
		}
		words.push(decoder.decode(buf.subarray(offset, offset + prefix.length)));
		offset += prefix.length;
	}
	return sentences;
}

export type ApiLoginResult =
	/** `!done` with no `!trap` — logged in. */
	| { outcome: "done" }
	/** `!trap` then `!done` — the service answered and refused the credentials. */
	| { outcome: "trap"; message: string }
	/** `!fatal` — the service answered and closed the session (e.g. too many sessions). */
	| { outcome: "fatal"; message: string };

/** What the reply sentences say, once a `!done` or `!fatal` has arrived. `null` while
 *  the login is still unanswered. */
export function classifyLoginReply(sentences: string[][]): ApiLoginResult | null {
	const messageOf = (sentence: string[]) =>
		sentence.find((w) => w.startsWith("=message="))?.slice("=message=".length) ?? sentence.slice(1).join(" ");
	const fatal = sentences.find((s) => s[0] === "!fatal");
	if (fatal) return { outcome: "fatal", message: messageOf(fatal) };
	if (!sentences.some((s) => s[0] === "!done")) return null;
	const trap = sentences.find((s) => s[0] === "!trap");
	return trap ? { outcome: "trap", message: messageOf(trap) } : { outcome: "done" };
}

/** One `/login` round trip on `127.0.0.1:<port>`. Rejects on a socket error, on a close
 *  before the reply completes ("closed before reply"), and on the deadline
 *  ("apiLogin timeout") — the shapes `classifyProbeError()` sorts into outcomes. */
export function apiLogin(port: number, user: string, password: string, timeoutMs = 3000): Promise<ApiLoginResult> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1");
		let received = new Uint8Array(0);
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			fn();
		};
		const timer = setTimeout(() => finish(() => reject(new Error("apiLogin timeout"))), timeoutMs);
		socket.on("connect", () => {
			socket.write(encodeApiSentence(["/login", `=name=${user}`, `=password=${password}`]));
		});
		socket.on("data", (chunk: Uint8Array) => {
			const next = new Uint8Array(received.length + chunk.length);
			next.set(received);
			next.set(chunk, received.length);
			received = next;
			const result = classifyLoginReply(parseApiSentences(received));
			if (result) finish(() => resolve(result));
		});
		socket.on("error", (err) => finish(() => reject(err)));
		socket.on("close", () => finish(() => reject(new Error("closed before reply"))));
	});
}
