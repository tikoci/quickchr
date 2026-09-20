/**
 * #158's acceptance bar: nothing about a named socket should require opening a file
 * under the data dir.
 *
 * The field report that produced #157/#158 built a 3-CHR lab, got interfaces up,
 * addresses assigned and 100% packet loss with no error anywhere, and only found out
 * the link was UDP multicast by reading `machine.json`. Every assertion here covers a
 * place quickchr knew the answer and did not say it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatNetworks } from "../../src/cli/format.ts";
import { describeSocketTransport, qemuSupportsDgram } from "../../src/lib/network.ts";
import {
	_resetSocketCache,
	addSocketMember,
	createNamedSocket,
	getNamedSocket,
	getSocketSlot,
} from "../../src/lib/socket-registry.ts";

/** A short base, not `import.meta.dir`: a `dgram` endpoint path is
 *  `<dir>/networks/<name>.<slot>.sock`, and the whole thing has to fit `sun_path`'s
 *  104 bytes. Under the repo it depends on how deep the checkout is, so these tests
 *  would pass here and fail on a longer path — which is exactly how the limit was
 *  found in the first place. */
const TEST_DIR = mkdtempSync(join(tmpdir(), "qchr-test-"));
const CLI = join(import.meta.dir, "../../src/cli/index.ts");
const origDataDir = process.env.QUICKCHR_DATA_DIR;

async function runQuickchr(args: string[]) {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		env: { ...process.env, QUICKCHR_DATA_DIR: TEST_DIR, NO_COLOR: "1", QUICKCHR_NO_PROMPT: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
	_resetSocketCache();
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	if (origDataDir !== undefined) process.env.QUICKCHR_DATA_DIR = origDataDir;
	else delete process.env.QUICKCHR_DATA_DIR;
	_resetSocketCache();
});

describe("a named socket prints as a name, not as raw JSON", () => {
	test("formatNetworks renders the specifier the parser actually emits", () => {
		// `format.ts` tested `s.type === "socket-named"`, but `parseNetworkSpecifier`
		// emits `{ type: "socket" }` — so the branch never matched and `list`/`info`
		// fell through to JSON.stringify for every named socket.
		expect(formatNetworks([{ specifier: { type: "socket", name: "lab" }, id: "net1" }]))
			.toBe("socket::lab");
	});

	test("the whole NIC list stays readable when a named socket is in it", () => {
		expect(
			formatNetworks([
				{ specifier: "user", id: "net0" },
				{ specifier: { type: "socket", name: "lab" }, id: "net1" },
			]),
		).toBe("user, socket::lab");
	});
});

describe("describeSocketTransport", () => {
	test("names the multicast group and that it is the N-way option", () => {
		createNamedSocket("segment", { mode: "mcast", port: 4000 });
		const entry = getNamedSocket("segment");
		if (!entry) throw new Error("entry missing");
		expect(describeSocketTransport(entry)).toBe("UDP multicast 230.0.0.1:4000 (N-way)");
	});

	test("distinguishes the listening end from the connecting one", () => {
		createNamedSocket("pair", { mode: "listen-connect", port: 4321 });
		addSocketMember("pair", "a");
		addSocketMember("pair", "b");
		const entry = getNamedSocket("pair");
		if (!entry) throw new Error("entry missing");
		expect(describeSocketTransport(entry, getSocketSlot(entry, "a"))).toContain("(listening)");
		expect(describeSocketTransport(entry, getSocketSlot(entry, "b"))).toContain("(connecting)");
		// Unoccupied: describe the link, not a role nobody holds.
		expect(describeSocketTransport(entry)).toBe("TCP pair on 127.0.0.1:4321");
	});

	test("a dgram end names its own socket and its peer's", () => {
		createNamedSocket("pair", { mode: "dgram" });
		addSocketMember("pair", "a");
		const entry = getNamedSocket("pair");
		if (!entry) throw new Error("entry missing");
		const described = describeSocketTransport(entry, 0);
		expect(described).toContain("pair.0.sock");
		expect(described).toContain("pair.1.sock");
		expect(describeSocketTransport(entry)).toContain("pair.{0,1}.sock");
	});
});

describe("qemuSupportsDgram", () => {
	test("7.2 is the floor", () => {
		expect(qemuSupportsDgram("7.1.0")).toBe(false);
		expect(qemuSupportsDgram("7.2.0")).toBe(true);
		expect(qemuSupportsDgram("11.1.1")).toBe(true);
		expect(qemuSupportsDgram("6.2")).toBe(false);
	});
});

describe("networks sockets create", () => {
	test("reports the transport it chose, without being asked", async () => {
		const created = await runQuickchr(["networks", "sockets", "create", "lab"]);
		expect(created.exitCode).toBe(0);
		expect(created.stdout).toContain("Transport:");
	});

	test("--mode reaches the registry's other transports", async () => {
		const lc = await runQuickchr(["networks", "sockets", "create", "lab", "--mode", "listen-connect", "--port", "4500"]);
		expect(lc.exitCode).toBe(0);
		expect(lc.stdout).toContain("listen-connect");
		expect(lc.stdout).toContain("4500");
	});

	test("creating an mcast socket carries the silent-failure caveat at create time", async () => {
		// A doc nobody reads before the link is dead is not visibility.
		const mcast = await runQuickchr(["networks", "sockets", "create", "segment", "--mode", "mcast"]);
		expect(mcast.exitCode).toBe(0);
		expect(mcast.stdout).toContain("silently");
	});

	test("an unknown --mode is refused and lists the real ones", async () => {
		const bad = await runQuickchr(["networks", "sockets", "create", "lab", "--mode", "tcp"]);
		expect(bad.exitCode).toBe(1);
		expect(bad.stderr).toContain("dgram");
		expect(bad.stderr).toContain("listen-connect");
		expect(bad.stderr).toContain("mcast");
	});

	test("an option that cannot apply is an error, not a silent no-op", async () => {
		const group = await runQuickchr(["networks", "sockets", "create", "lab", "--mode", "dgram", "--group", "230.1.2.3"]);
		expect(group.exitCode).toBe(1);
		expect(group.stderr).toContain("--group only applies");

		const port = await runQuickchr(["networks", "sockets", "create", "lab", "--mode", "dgram", "--port", "4000"]);
		expect(port.exitCode).toBe(1);
		expect(port.stderr).toContain("uses no port");
	});

	test("a known option given without its value is refused, not defaulted", async () => {
		// `parseFlags` stores `true` for a valueless flag and `flag()` maps that back to
		// `undefined`, so a bare `--mode` would silently take the platform default —
		// the same shape as #156's valueless-flag bug on `add`.
		for (const key of ["mode", "port", "group"]) {
			const bare = await runQuickchr(["networks", "sockets", "create", "lab", `--${key}`]);
			expect({ key, exitCode: bare.exitCode }).toEqual({ key, exitCode: 1 });
			expect(bare.stderr).toContain(`--${key} requires a value`);
		}
	});

	test("a non-numeric --port is refused", async () => {
		const bad = await runQuickchr(["networks", "sockets", "create", "lab", "--mode", "mcast", "--port", "abc"]);
		expect(bad.exitCode).toBe(1);
		expect(bad.stderr).toContain("--port");
	});

	test("a port with trailing characters is refused", async () => {
		// Number.parseInt("4000abc") is 4000, so the old check accepted it.
		const bad = await runQuickchr(["networks", "sockets", "create", "lab", "--mode", "mcast", "--port", "4000abc"]);
		expect(bad.exitCode).toBe(1);
		expect(bad.stderr).toContain("4000abc");
	});

	test("the network overview names the transport instead of a port that may not exist", async () => {
		// It interpolated `port:${s.port}` and printed `port:undefined` for a dgram link.
		//
		// Compared against `describeSocketTransport()` rather than a literal: the default
		// transport is platform-dependent, so asserting "unix datagram" here passes on
		// POSIX and can never pass on Windows, where the default is `listen-connect`.
		await runQuickchr(["networks", "sockets", "create", "lab"]);
		const overview = await runQuickchr(["networks"]);

		_resetSocketCache();
		const entry = getNamedSocket("lab");
		if (!entry) throw new Error("entry missing");
		expect(overview.stdout).toContain(describeSocketTransport(entry));
		expect(overview.stdout).not.toContain("port:undefined");
	});

	test("the listing names each socket's transport", async () => {
		await runQuickchr(["networks", "sockets", "create", "lab"]);
		const list = await runQuickchr(["networks", "sockets"]);
		expect(list.exitCode).toBe(0);
		expect(list.stdout).toContain("Transport");
		expect(list.stdout).toContain("lab");
	});
});

describe("a start that cannot resolve does not keep the endpoint it claimed", () => {
	test("a dgram link on Windows releases the slot it took", async () => {
		// Membership is persisted *before* networks resolve, because the resolver needs
		// to know which end this machine holds. So a resolution that throws — a dgram
		// link on Windows, or on QEMU older than 7.2 — would otherwise leave a machine
		// holding an endpoint it never used, and two failed starts would fill the link
		// with machines that are not running.
		const { registerAndResolveNetworks } = await import("../../src/lib/quickchr.ts");
		createNamedSocket("win-link", { mode: "dgram" });

		const state = {
			name: "chr1",
			networks: [{ specifier: { type: "socket" as const, name: "win-link" }, id: "net0" }],
		} as unknown as Parameters<typeof registerAndResolveNetworks>[0];

		expect(() =>
			registerAndResolveNetworks(state, {
				platform: { os: "win32", hostArch: "x64", packageManager: "winget", accelAvailable: [] },
			}, ""),
		).toThrow(/Windows cannot provide/);

		_resetSocketCache();
		expect(getNamedSocket("win-link")?.endpoints).toEqual([null, null]);
		expect(getNamedSocket("win-link")?.members).toEqual([]);
	});

	test("a successful resolution keeps the claim", async () => {
		const { registerAndResolveNetworks } = await import("../../src/lib/quickchr.ts");
		createNamedSocket("ok-link", { mode: "dgram" });

		const state = {
			name: "chr1",
			networks: [{ specifier: { type: "socket" as const, name: "ok-link" }, id: "net0" }],
		} as unknown as Parameters<typeof registerAndResolveNetworks>[0];

		registerAndResolveNetworks(state, {
			platform: { os: "linux", hostArch: "x64", packageManager: "apt", accelAvailable: [] },
		}, "");

		_resetSocketCache();
		expect(getNamedSocket("ok-link")?.endpoints).toEqual(["chr1", null]);
	});
});


describe("a machine that is not running holds no endpoint", () => {
	test("a claim on an earlier socket is released when a later one is full", async () => {
		// registerSocketMembers() claims one endpoint per named socket. With the claim
		// outside the cleanup scope, a machine on two links whose second link was full
		// kept the first claim, and the caller could not clean it either — it only learns
		// about the claim once the call returns.
		const { registerAndResolveNetworks } = await import("../../src/lib/quickchr.ts");
		createNamedSocket("link-a", { mode: "dgram" });
		createNamedSocket("link-b", { mode: "dgram" });
		addSocketMember("link-b", "other1");
		addSocketMember("link-b", "other2");

		const state = {
			name: "chr1",
			networks: [
				{ specifier: { type: "socket" as const, name: "link-a" }, id: "net0" },
				{ specifier: { type: "socket" as const, name: "link-b" }, id: "net1" },
			],
		} as unknown as Parameters<typeof registerAndResolveNetworks>[0];

		expect(() =>
			registerAndResolveNetworks(state, {
				platform: { os: "linux", hostArch: "x64", packageManager: "apt", accelAvailable: [] },
			}, ""),
		).toThrow(/carries 2 machines/);

		_resetSocketCache();
		expect(getNamedSocket("link-a")?.endpoints).toEqual([null, null]);
		expect(getNamedSocket("link-a")?.members).toEqual([]);
	});
});
