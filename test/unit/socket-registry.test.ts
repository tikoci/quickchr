import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createNamedSocket,
	getNamedSocket,
	listNamedSockets,
	removeNamedSocket,
	addSocketMember,
	removeSocketMember,
	getSocketRegistryDir,
	getSocketSlot,
	socketEndpointPath,
	defaultSocketMode,
	_resetSocketCache,
} from "../../src/lib/socket-registry.ts";
import { QuickCHRError } from "../../src/lib/types.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-socket-registry-test");
const origDataDir = process.env.QUICKCHR_DATA_DIR;

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
	_resetSocketCache();
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	if (origDataDir !== undefined) {
		process.env.QUICKCHR_DATA_DIR = origDataDir;
	} else {
		delete process.env.QUICKCHR_DATA_DIR;
	}
});

describe("getSocketRegistryDir", () => {
	test("returns networks dir and creates it", () => {
		const dir = getSocketRegistryDir();
		expect(dir).toEndWith("networks");
		expect(Bun.file(dir).size).toBeDefined(); // dir exists
	});
});

describe("createNamedSocket", () => {
	// The default changed from `mcast` to `dgram` in #158. mcast was the only
	// transport reachable from the CLI, and it fails *silently* on macOS and in
	// UDP-blocked sandboxes — interfaces up, addresses assigned, 100% loss, nothing
	// logged. See DESIGN.md for the evidence behind the flip.
	test("creates a socket with the platform default transport", () => {
		const entry = createNamedSocket("link1");
		expect(entry.name).toBe("link1");
		expect(entry.mode).toBe(defaultSocketMode());
		expect(entry.members).toEqual([]);
		expect(entry.endpoints).toEqual([null, null]);
		expect(entry.createdAt).toBeTruthy();
	});

	test("the default transport is dgram on POSIX and listen-connect on Windows", () => {
		// Windows' AF_UNIX has no SOCK_DGRAM, so it cannot have the unix-datagram pair.
		expect(defaultSocketMode("darwin")).toBe("dgram");
		expect(defaultSocketMode("linux")).toBe("dgram");
		expect(defaultSocketMode("win32")).toBe("listen-connect");
	});

	test("an explicit mcast socket still gets the documented group and port", () => {
		const entry = createNamedSocket("link1", { mode: "mcast" });
		expect(entry.mcastGroup).toBe("230.0.0.1");
		expect(entry.port).toBe(4000);
		expect(entry.endpoints).toBeUndefined();
	});

	test("creates a listen-connect socket without mcastGroup", () => {
		const entry = createNamedSocket("lc1", { mode: "listen-connect", port: 5000 });
		expect(entry.mode).toBe("listen-connect");
		expect(entry.mcastGroup).toBeUndefined();
		expect(entry.port).toBe(5000);
	});

	test("throws STATE_ERROR on duplicate name", () => {
		createNamedSocket("dup");
		expect(() => createNamedSocket("dup")).toThrow(QuickCHRError);
		try {
			createNamedSocket("dup");
		} catch (e) {
			expect((e as QuickCHRError).code).toBe("STATE_ERROR");
		}
	});

	test("uses custom mcast group", () => {
		const entry = createNamedSocket("custom", { mode: "mcast", mcastGroup: "230.1.2.3" });
		expect(entry.mcastGroup).toBe("230.1.2.3");
	});

	test("a group on a non-mcast socket is an error, not a silently dropped option", () => {
		expect(() => createNamedSocket("x", { mode: "dgram", mcastGroup: "230.1.2.3" }))
			.toThrow(/only applies to mode "mcast"/);
	});
});

describe("port auto-allocation", () => {
	test("starts at 4000 when no sockets exist", () => {
		const entry = createNamedSocket("first");
		expect(entry.port).toBe(4000);
	});

	test("increments from highest used port", () => {
		createNamedSocket("a", { port: 4000 });
		createNamedSocket("b", { port: 4005 });
		const c = createNamedSocket("c");
		expect(c.port).toBe(4006);
	});
});

describe("getNamedSocket", () => {
	test("returns entry by name", () => {
		createNamedSocket("findme");
		const found = getNamedSocket("findme");
		expect(found).toBeDefined();
		expect(found?.name).toBe("findme");
	});

	test("returns undefined for non-existent", () => {
		expect(getNamedSocket("nope")).toBeUndefined();
	});
});

describe("listNamedSockets", () => {
	test("returns empty array initially", () => {
		expect(listNamedSockets()).toEqual([]);
	});

	test("returns all sockets", () => {
		createNamedSocket("x");
		createNamedSocket("y");
		const names = listNamedSockets().map((e) => e.name).sort();
		expect(names).toEqual(["x", "y"]);
	});
});

describe("removeNamedSocket", () => {
	test("deletes existing socket and returns true", () => {
		createNamedSocket("rm-me");
		expect(removeNamedSocket("rm-me")).toBe(true);
		expect(getNamedSocket("rm-me")).toBeUndefined();
	});

	test("returns false for non-existent", () => {
		expect(removeNamedSocket("ghost")).toBe(false);
	});
});

describe("member management", () => {
	test("addSocketMember adds a machine", () => {
		createNamedSocket("net1");
		addSocketMember("net1", "chr-1");
		const entry = getNamedSocket("net1");
		expect(entry?.members).toEqual(["chr-1"]);
	});

	test("addSocketMember is idempotent", () => {
		createNamedSocket("net2");
		addSocketMember("net2", "chr-1");
		addSocketMember("net2", "chr-1");
		expect(getNamedSocket("net2")?.members).toEqual(["chr-1"]);
	});

	test("addSocketMember throws for non-existent socket", () => {
		expect(() => addSocketMember("nonet", "chr-1")).toThrow(QuickCHRError);
	});

	test("removeSocketMember removes a machine", () => {
		createNamedSocket("net3");
		addSocketMember("net3", "chr-1");
		addSocketMember("net3", "chr-2");
		removeSocketMember("net3", "chr-1");
		expect(getNamedSocket("net3")?.members).toEqual(["chr-2"]);
	});

	test("removeSocketMember auto-deletes socket when last member removed (autoCreated)", () => {
		createNamedSocket("net4", { autoCreated: true });
		addSocketMember("net4", "chr-1");
		removeSocketMember("net4", "chr-1");
		expect(getNamedSocket("net4")).toBeUndefined();
	});

	test("removeSocketMember preserves user-created socket when last member removed", () => {
		createNamedSocket("user-net");
		addSocketMember("user-net", "chr-1");
		removeSocketMember("user-net", "chr-1");
		const entry = getNamedSocket("user-net");
		expect(entry).toBeDefined();
		expect(entry?.members).toEqual([]);
		expect(entry?.autoCreated).toBe(false);
	});

	test("removeSocketMember on shared auto-created socket only deletes after last member", () => {
		createNamedSocket("shared", { autoCreated: true });
		addSocketMember("shared", "chr-a");
		addSocketMember("shared", "chr-b");
		removeSocketMember("shared", "chr-a");
		expect(getNamedSocket("shared")?.members).toEqual(["chr-b"]);
		removeSocketMember("shared", "chr-b");
		expect(getNamedSocket("shared")).toBeUndefined();
	});

	test("removeSocketMember is a no-op for non-existent socket", () => {
		expect(() => removeSocketMember("ghost", "chr-1")).not.toThrow();
	});
});

describe("backward compatibility", () => {
	test("loads legacy JSON without autoCreated field as autoCreated:false", () => {
		const dir = getSocketRegistryDir();
		const legacy = {
			name: "legacy",
			mode: "mcast",
			mcastGroup: "230.0.0.1",
			port: 4000,
			createdAt: "2024-01-01T00:00:00.000Z",
			members: ["chr-old"],
		};
		writeFileSync(join(dir, "legacy.json"), JSON.stringify(legacy, null, "\t") + "\n");
		_resetSocketCache();
		const entry = getNamedSocket("legacy");
		expect(entry).toBeDefined();
		expect(entry?.autoCreated).toBe(false);
		expect(entry?.members).toEqual(["chr-old"]);
	});
});


describe("endpoint slots (#158)", () => {
	test("the two ends of a pair link are handed out in join order", () => {
		createNamedSocket("pair", { mode: "dgram" });
		addSocketMember("pair", "alpha");
		addSocketMember("pair", "beta");

		const entry = getNamedSocket("pair");
		if (!entry) throw new Error("entry missing");
		expect(entry.endpoints).toEqual(["alpha", "beta"]);
		expect(getSocketSlot(entry, "alpha")).toBe(0);
		expect(getSocketSlot(entry, "beta")).toBe(1);
	});

	test("a machine keeps its slot across a stop and start", () => {
		// The bug this replaces: the role was derived from `members.length` at resolve
		// time, so a listener that stopped and restarted came back as a *second*
		// connector and the link silently went dead.
		createNamedSocket("pair", { mode: "listen-connect" });
		addSocketMember("pair", "listener");
		addSocketMember("pair", "connector");

		removeSocketMember("pair", "listener");
		expect(getNamedSocket("pair")?.endpoints).toEqual([null, "connector"]);

		addSocketMember("pair", "listener");
		const entry = getNamedSocket("pair");
		if (!entry) throw new Error("entry missing");
		expect(getSocketSlot(entry, "listener")).toBe(0);
		expect(getSocketSlot(entry, "connector")).toBe(1);
	});

	test("a third machine on a pair link is refused, and names the N-way alternative", () => {
		// Not a cosmetic cap: on a dgram link a second machine binding the same path
		// unlinks the first one's socket and steals the link with nothing logged, and on
		// listen-connect QEMU stops accepting after one peer while the port stays open.
		createNamedSocket("pair", { mode: "dgram" });
		addSocketMember("pair", "alpha");
		addSocketMember("pair", "beta");

		expect(() => addSocketMember("pair", "gamma")).toThrow(QuickCHRError);
		try {
			addSocketMember("pair", "gamma");
		} catch (e) {
			expect((e as QuickCHRError).code).toBe("NETWORK_UNAVAILABLE");
			expect((e as Error).message).toContain("alpha and beta");
			expect((e as Error).message).toContain("--mode mcast");
		}
		expect(getNamedSocket("pair")?.members).toEqual(["alpha", "beta"]);
	});

	test("re-adding a machine already holding an end is a no-op", () => {
		createNamedSocket("pair", { mode: "dgram" });
		addSocketMember("pair", "alpha");
		addSocketMember("pair", "alpha");
		expect(getNamedSocket("pair")?.endpoints).toEqual(["alpha", null]);
		expect(getNamedSocket("pair")?.members).toEqual(["alpha"]);
	});

	test("mcast has no slots and no member cap", () => {
		createNamedSocket("segment", { mode: "mcast" });
		for (const m of ["a", "b", "c", "d"]) addSocketMember("segment", m);
		const entry = getNamedSocket("segment");
		if (!entry) throw new Error("entry missing");
		expect(entry.endpoints).toBeUndefined();
		expect(entry.members).toEqual(["a", "b", "c", "d"]);
		expect(getSocketSlot(entry, "a")).toBeUndefined();
	});

	test("endpoint paths are keyed by slot, not by machine name", () => {
		// The first machine to start has to name its peer's path before that peer
		// exists, so a slot is the only thing both ends can agree on in advance.
		expect(socketEndpointPath("lab", 0)).toEndWith("lab.0.sock");
		expect(socketEndpointPath("lab", 1)).toEndWith("lab.1.sock");
	});

	test("a dgram path over the sun_path limit fails at create, naming the limit", () => {
		// QEMU otherwise reports `UNIX socket path '...' is too long` at spawn, against
		// a path the caller never chose.
		const deep = join(TEST_DIR, "d".repeat(60), "e".repeat(60));
		mkdirSync(deep, { recursive: true });
		process.env.QUICKCHR_DATA_DIR = deep;
		try {
			expect(() => createNamedSocket("lab", { mode: "dgram" })).toThrow(/104-byte limit/);
		} finally {
			process.env.QUICKCHR_DATA_DIR = TEST_DIR;
		}
	});
});
