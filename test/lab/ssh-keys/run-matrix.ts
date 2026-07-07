/**
 * SSH Key Provisioning — Matrix Runner (issue #74, comment 4899388604 cells A–E)
 *
 * Exercises SSH public-key install across install-method × key-algorithm, and
 * gates every cell on a REAL host-OpenSSH batch login — not just "the key shows
 * up in the REST listing". Also captures the server-side /ip/ssh surface and the
 * host-key type so REPORT.md is grounded against a live CHR rather than a memory.
 *
 * This is a research runner (prints a table + facts), not a bun:test assertion
 * suite — the sibling ssh-keys.test.ts remains the anchor test.
 *
 * Run against a running CHR:
 *   CHR_HTTP_PORT=9100 CHR_SSH_PORT=9102 \
 *   CHR_MACHINE_DIR=~/.local/share/quickchr/machines/ssh-floor \
 *   CHR_PORT_BASE=9100 \
 *   bun run test/lab/ssh-keys/run-matrix.ts
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { consoleExec } from "../../../src/lib/console.ts";
import { restRequest } from "../../../src/lib/rest.ts";
import { SSH_KEY_REJECTION_PATTERN } from "../../../src/lib/provision.ts";

const HTTP_PORT = Number(process.env.CHR_HTTP_PORT ?? "9100");
const SSH_PORT = Number(process.env.CHR_SSH_PORT ?? "9102");
const MACHINE_DIR = (process.env.CHR_MACHINE_DIR ?? "").replace(/^~/, process.env.HOME ?? "~");
const PORT_BASE = process.env.CHR_PORT_BASE ? Number(process.env.CHR_PORT_BASE) : undefined;
const AUTH = `Basic ${Buffer.from("admin:").toString("base64")}`;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;

const tmp = mkdtempSync(join(tmpdir(), "ssh-matrix-"));
const dec = new TextDecoder();

// All CHR REST goes through src/lib/rest.ts (node:http + agent:false), NOT bare
// fetch — Bun pools TCP connections by host:port and can return stale responses
// after a CHR restarts on the same port (rest.ts header documents the root cause).
function rest(method: string, path: string, body?: Record<string, unknown>) {
	return restRequest(`${BASE}${path}`, method, AUTH, body);
}

type Algo = "ed25519" | "rsa" | "ecdsa";
function keygen(algo: Algo, tag: string): { priv: string; pub: string } {
	const priv = join(tmp, tag);
	const args =
		algo === "rsa"
			? ["-t", "rsa", "-b", "2048"]
			: algo === "ecdsa"
				? ["-t", "ecdsa", "-b", "256"]
				: ["-t", "ed25519"];
	const r = Bun.spawnSync(["ssh-keygen", ...args, "-f", priv, "-N", "", "-C", tag], { stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`ssh-keygen ${algo}: ${dec.decode(r.stderr)}`);
	return { priv, pub: readFileSync(`${priv}.pub`, "utf-8").trim() };
}

/** Real host-OpenSSH batch login — the load-bearing pass criterion. */
function batchLogin(priv: string, tag: string): { ok: boolean; detail: string } {
	const r = Bun.spawnSync(
		[
			"ssh",
			"-o", "StrictHostKeyChecking=no",
			"-o", "UserKnownHostsFile=/dev/null",
			"-o", "PasswordAuthentication=no",
			"-o", "BatchMode=yes",
			"-o", "ConnectTimeout=10",
			"-i", priv,
			"admin@127.0.0.1", "-p", String(SSH_PORT),
			`:put "LOGIN-OK-${tag}"`,
		],
		{ timeout: 20_000, stdout: "pipe", stderr: "pipe" },
	);
	const out = dec.decode(r.stdout) + dec.decode(r.stderr);
	return { ok: out.includes(`LOGIN-OK-${tag}`), detail: out.trim().split("\n").slice(-1)[0] ?? "" };
}

// The key comment lands in `key-owner` on ≤7.20.x and in `info` on 7.23.x — the
// response schema changed. Match either so the runner is version-agnostic.
type KeyRow = { ".id": string; user: string; "key-owner"?: string; info?: string; bits?: string; "key-type"?: string };
const ownerOf = (k: KeyRow) => k.info ?? k["key-owner"] ?? "";
async function listKeys(): Promise<KeyRow[]> {
	const { body } = await rest("GET", "/rest/user/ssh-keys");
	return JSON.parse(body);
}
async function removeByOwner(owner: string) {
	for (const k of await listKeys()) {
		if (ownerOf(k) === owner) await rest("DELETE", `/rest/user/ssh-keys/${k[".id"]}`);
	}
}

interface Cell {
	cell: string;
	method: string;
	algo: Algo;
	installStatus: string;
	installOk: boolean;
	loginOk: boolean;
	note: string;
}
const results: Cell[] = [];

/** Method 1: REST inline add — PUT /rest/user/ssh-keys {user,key} */
async function restAdd(algo: Algo, cell: string) {
	const tag = `q-rest-add-${algo}`;
	const { priv, pub } = keygen(algo, tag);
	const { status, body } = await rest("PUT", "/rest/user/ssh-keys", { user: "admin", key: pub });
	const installOk = status >= 200 && status < 300;
	let loginOk = false;
	let note = "";
	if (installOk) {
		const l = batchLogin(priv, tag);
		loginOk = l.ok;
		note = l.ok ? "" : l.detail;
	} else {
		try { note = (JSON.parse(body).detail ?? body).slice(0, 120); } catch { note = body.slice(0, 120); }
	}
	results.push({ cell, method: "REST add", algo, installStatus: String(status), installOk, loginOk, note });
	await removeByOwner(tag);
}

/** Method 2: REST import — upload file then POST /rest/user/ssh-keys/import */
async function restImport(algo: Algo, cell: string) {
	const tag = `q-rest-import-${algo}`;
	const { priv, pub } = keygen(algo, tag);
	const fname = `${tag}.pub`;
	const up = await rest("PUT", "/rest/file", { name: fname, contents: pub });
	const imp = await rest("POST", "/rest/user/ssh-keys/import", { user: "admin", "public-key-file": fname });
	const installOk = up.status < 300 && imp.status < 300 && (await listKeys()).some((k) => ownerOf(k) === tag);
	let loginOk = false;
	let note = "";
	if (installOk) {
		const l = batchLogin(priv, tag);
		loginOk = l.ok;
		note = l.ok ? "" : l.detail;
	} else {
		note = `upload=${up.status} import=${imp.status} ${(imp.body || up.body).slice(0, 100)}`;
	}
	results.push({ cell, method: "REST import", algo, installStatus: `${up.status}/${imp.status}`, installOk, loginOk, note });
	await removeByOwner(tag);
	// best-effort file cleanup
	try {
		const files = JSON.parse((await rest("GET", "/rest/file?.proplist=.id,name")).body) as Array<{ ".id": string; name: string }>;
		const f = files.find((x) => x.name === fname);
		if (f) await rest("DELETE", `/rest/file/${f[".id"]}`);
	} catch { /* ignore */ }
}

/** Method 3: console add — quickchr's shipped installSshKey() transport */
async function consoleAdd(algo: Algo, cell: string) {
	if (!MACHINE_DIR) {
		results.push({ cell, method: "console add", algo, installStatus: "skipped", installOk: false, loginOk: false, note: "CHR_MACHINE_DIR not set" });
		return;
	}
	const tag = `q-console-add-${algo}`;
	const { priv, pub } = keygen(algo, tag);
	let installStatus = "ok";
	let installOk = false;
	let note = "";
	try {
		const { output } = await consoleExec(MACHINE_DIR, `/user/ssh-keys/add user="admin" key="${pub}"`, "admin", "", 30_000, PORT_BASE);
		if (SSH_KEY_REJECTION_PATTERN.test(output)) {
			note = output.trim().slice(0, 120);
			installStatus = "rejected";
		} else {
			installOk = (await listKeys()).some((k) => ownerOf(k) === tag);
			if (!installOk) note = `console clean but not in listing: ${output.trim().slice(0, 80)}`;
		}
	} catch (e) {
		installStatus = "error";
		note = String(e).slice(0, 120);
	}
	let loginOk = false;
	if (installOk) {
		const l = batchLogin(priv, tag);
		loginOk = l.ok;
		if (!l.ok) note = l.detail;
	}
	results.push({ cell, method: "console add", algo, installStatus, installOk, loginOk, note });
	await removeByOwner(tag);
}

async function main() {
	const ver = JSON.parse((await rest("GET", "/rest/system/resource")).body).version;
	const ssh = JSON.parse((await rest("GET", "/rest/ip/ssh")).body);

	console.log(`\n=== CHR ${ver} — SSH key install matrix ===`);
	console.log(`host: ${dec.decode(Bun.spawnSync(["ssh", "-V"], { stderr: "pipe" }).stderr).trim()}`);
	console.log(`/ip/ssh: ${JSON.stringify(ssh)}`);

	// host key type actually offered on the wire (drives known_hosts / TOFU)
	const scan = Bun.spawnSync(["ssh-keyscan", "-p", String(SSH_PORT), "127.0.0.1"], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
	const hostKeyTypes = dec.decode(scan.stdout).split("\n").filter(Boolean).map((l) => l.split(" ")[1]).filter(Boolean);
	console.log(`host keys offered (ssh-keyscan): ${[...new Set(hostKeyTypes)].join(", ") || "none"}`);

	// Cells A–D + ed25519/ecdsa on REST add for the boundary picture. Each cell is
	// isolated: a transient failure in one records/logs and continues so the summary
	// table and JSON_RESULTS still print for every completed cell.
	const plan: Array<[() => Promise<void>, string]> = [
		[() => consoleAdd("ed25519", "A"), "A console-add ed25519"],
		[() => restImport("ed25519", "B"), "B rest-import ed25519"],
		[() => consoleAdd("rsa", "C"), "C console-add rsa"],
		[() => restImport("rsa", "D"), "D rest-import rsa"],
		[() => restAdd("ed25519", "A'"), "A' rest-add ed25519"],
		[() => restAdd("rsa", "C'"), "C' rest-add rsa"],
		[() => restAdd("ecdsa", "F"), "F rest-add ecdsa"],
	];
	for (const [run, label] of plan) {
		try {
			await run();
		} catch (e) {
			console.error(`cell ${label} threw (continuing): ${e}`);
		}
	}

	console.log("\ncell | method       | algo    | install         | login | note");
	console.log("-----+--------------+---------+-----------------+-------+-----");
	for (const r of results) {
		console.log(
			`${r.cell.padEnd(4)} | ${r.method.padEnd(12)} | ${r.algo.padEnd(7)} | ` +
			`${(r.installOk ? "OK " : "FAIL").padEnd(4)} ${r.installStatus.padEnd(10)} | ` +
			`${(r.loginOk ? "OK " : "-- ").padEnd(5)} | ${r.note}`,
		);
	}
	console.log(`\nJSON_RESULTS=${JSON.stringify({ version: ver, ssh, hostKeyTypes: [...new Set(hostKeyTypes)], results })}`);
	rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
