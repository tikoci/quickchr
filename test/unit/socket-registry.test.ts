import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	createNamedSocket,
	getNamedSocket,
	listNamedSockets,
	removeNamedSocket,
	addSocketMember,
	removeSocketMember,
	getSocketRegistryDir,
} from "../../src/lib/socket-registry.ts";
import { QuickCHRError } from "../../src/lib/types.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-socket-registry-test");
const origDataDir = process.env.QUICKCHR_DATA_DIR;

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
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
	test("creates a socket with default mcast settings", () => {
		const entry = createNamedSocket("link1");
		expect(entry.name).toBe("link1");
		expect(entry.mode).toBe("mcast");
		expect(entry.mcastGroup).toBe("230.0.0.1");
		expect(entry.port).toBe(4000);
		expect(entry.members).toEqual([]);
		expect(entry.createdAt).toBeTruthy();
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
		const entry = createNamedSocket("custom", { mcastGroup: "230.1.2.3" });
		expect(entry.mcastGroup).toBe("230.1.2.3");
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

	test("removeSocketMember auto-deletes socket when last member removed", () => {
		createNamedSocket("net4");
		addSocketMember("net4", "chr-1");
		removeSocketMember("net4", "chr-1");
		expect(getNamedSocket("net4")).toBeUndefined();
	});

	test("removeSocketMember is a no-op for non-existent socket", () => {
		expect(() => removeSocketMember("ghost", "chr-1")).not.toThrow();
	});
});
