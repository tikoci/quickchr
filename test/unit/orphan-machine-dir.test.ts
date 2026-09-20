import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

const TEST_DIR = join(import.meta.dir, ".tmp-orphan-machine-dir");
const STUB_BIN = join(TEST_DIR, "stub-bin");
const CLI = join(import.meta.dir, "../../src/cli/index.ts");

/** `add()` calls `requireQemu(arch)` before it creates anything, and that only checks
 *  the binary is findable on PATH (`findQemuBinary`). These stubs satisfy that check on
 *  a runner with no QEMU — the unit tier must not need one. They are never executed:
 *  every path below fails before any QEMU or qemu-img invocation, and a stub that did
 *  run would exit 1 and fail the test loudly rather than silently pass. */
function installQemuStubs() {
	mkdirSync(STUB_BIN, { recursive: true });
	for (const bin of ["qemu-system-x86_64", "qemu-system-aarch64", "qemu-img"]) {
		const path = join(STUB_BIN, bin);
		writeFileSync(path, `#!/bin/sh\necho "stub ${bin} was executed — this test must not reach QEMU" >&2\nexit 1\n`);
		chmodSync(path, 0o755);
	}
}

/** A minimal image that passes `isUsableCachedImage()` — an MBR signature plus a
 *  non-empty first partition entry — so `add` never reaches the network. */
function seedCachedImage(version: string, arch: string) {
	const image = Buffer.alloc(1024);
	image[510] = 0x55;
	image[511] = 0xaa;
	image.writeUInt32LE(1, 454);
	image.writeUInt32LE(1, 458);
	mkdirSync(join(TEST_DIR, "cache"), { recursive: true });
	writeFileSync(join(TEST_DIR, "cache", cachedImageName(version, arch)), image);
}

function cachedImageName(version: string, arch: string): string {
	return `chr-${version}${arch === "arm64" ? "-arm64" : ""}.img`;
}

async function runQuickchr(args: string[]) {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		env: {
			...process.env,
			PATH: `${STUB_BIN}${delimiter}${process.env.PATH ?? ""}`,
			QUICKCHR_DATA_DIR: TEST_DIR,
			NO_COLOR: "1",
			QUICKCHR_NO_PROMPT: "1",
		},
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

function machinesDirContents(): string[] {
	const dir = join(TEST_DIR, "machines");
	return existsSync(dir) ? readdirSync(dir).sort() : [];
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	installQemuStubs();
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("a failed add leaves nothing behind (#155)", () => {
	test("a throw after ensureDir removes the directory add created", async () => {
		// The fault has to land *inside* add()'s try, after ensureDir(machineDir) —
		// anything rejected earlier (a bad version, normalizeDiskOptions) never creates
		// a directory, so asserting on an empty data dir would pass without exercising
		// the cleanup at all.
		//
		// A directory where the cached image belongs does it: isUsableCachedImage()
		// reports false, and ensureCachedImage()'s `unlinkSync(imgPath)` of the stale
		// entry throws (EPERM on darwin, EISDIR on linux). That call is the first
		// statement inside the try.
		mkdirSync(join(TEST_DIR, "cache", cachedImageName("7.24.4", "x86")), { recursive: true });

		const result = await runQuickchr([
			"add", "--name", "lab", "--version", "7.24.4", "--arch", "x86",
		]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).not.toContain("stub");
		expect(machinesDirContents()).toEqual([]);
	});

	test("a truncated machine.json is cleaned up, not mistaken for a finished machine", async () => {
		// The predicate has to be "no *readable* state", not "no machine.json": a
		// saveMachine() that dies mid-write (disk full) leaves a partial file, and a
		// file-exists check would read that as a finished machine and strand the
		// directory. Driving a real partial write from the CLI is not practical, so this
		// pins the predicate itself — the same one add()'s catch and remove() use.
		const { isOrphanMachineDir } = await import("../../src/lib/state.ts");
		const machineDir = join(TEST_DIR, "machines", "half-written");
		mkdirSync(machineDir, { recursive: true });
		writeFileSync(join(machineDir, "machine.json"), '{"name":"half-written","ver');

		const prev = process.env.QUICKCHR_DATA_DIR;
		process.env.QUICKCHR_DATA_DIR = TEST_DIR;
		try {
			expect(isOrphanMachineDir("half-written")).toBe(true);
			expect(existsSync(join(machineDir, "machine.json"))).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.QUICKCHR_DATA_DIR;
			else process.env.QUICKCHR_DATA_DIR = prev;
		}
	});

	test("an existing machine's directory survives a failed second add", async () => {
		seedCachedImage("7.24.4", "x86");
		// `--boot-disk-format raw` keeps the whole path clear of qemu-img.
		const created = await runQuickchr([
			"add", "--name", "lab", "--version", "7.24.4", "--arch", "x86",
			"--boot-disk-format", "raw",
		]);
		expect(created.exitCode).toBe(0);
		expect(existsSync(join(TEST_DIR, "machines", "lab", "machine.json"))).toBe(true);

		const again = await runQuickchr([
			"add", "--name", "lab", "--version", "7.24.4", "--arch", "x86",
			"--boot-disk-format", "raw",
		]);
		expect(again.exitCode).toBe(1);
		expect(again.stderr).toContain("already exists");
		expect(existsSync(join(TEST_DIR, "machines", "lab", "machine.json"))).toBe(true);
	});
});

describe("an orphan directory is recoverable (#155)", () => {
	// A crash or SIGKILL can still strand one, so the recovery path matters
	// independently of add()'s cleanup.
	function strandDirectory(name: string) {
		mkdirSync(join(TEST_DIR, "machines", name), { recursive: true });
	}

	test("remove clears a directory with no machine.json", async () => {
		strandDirectory("7.24.4-x86-1");
		const result = await runQuickchr(["remove", "7.24.4-x86-1"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("leftover directory");
		expect(machinesDirContents()).toEqual([]);
	});

	test("remove and add cannot both be true for one name", async () => {
		strandDirectory("7.24.4-x86-1");
		const blocked = await runQuickchr([
			"add", "--name", "7.24.4-x86-1", "--version", "7.24.3", "--arch", "x86",
		]);
		expect(blocked.exitCode).toBe(1);
		expect(blocked.stderr).toContain("leftover directory");
		expect(blocked.stderr).toContain("quickchr remove 7.24.4-x86-1");

		const removed = await runQuickchr(["remove", "7.24.4-x86-1"]);
		expect(removed.exitCode).toBe(0);
		expect(machinesDirContents()).toEqual([]);
	});

	test("a corrupt machine.json counts as an orphan, not a machine", async () => {
		strandDirectory("broken");
		writeFileSync(join(TEST_DIR, "machines", "broken", "machine.json"), "{ not json");
		const result = await runQuickchr(["remove", "broken"]);
		expect(result.exitCode).toBe(0);
		expect(machinesDirContents()).toEqual([]);
	});

	test("remove still reports a genuinely missing machine as not found", async () => {
		const result = await runQuickchr(["remove", "never-existed"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("not found");
	});

	test("not-found does not offer an orphan as an available machine", async () => {
		strandDirectory("half-made");
		const result = await runQuickchr(["remove", "typo-name"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("not found");
		expect(result.stderr).not.toContain("Available: half-made");
		expect(result.stderr).toContain("Leftover directories");
	});

	test("a traversal name never deletes outside machines/<name>/", async () => {
		// `remove ..` used to resolve to the data directory itself and delete every
		// machine, the image cache and the socket registry — reporting success. The
		// orphan predicate made it reachable: the data dir exists and holds no
		// machine.json, so it looked exactly like a half-created machine.
		mkdirSync(join(TEST_DIR, "machines", "keep-me"), { recursive: true });
		writeFileSync(join(TEST_DIR, "machines", "keep-me", "machine.json"), '{"name":"keep-me"}');
		mkdirSync(join(TEST_DIR, "cache"), { recursive: true });
		writeFileSync(join(TEST_DIR, "cache", "keep.img"), "seed");

		for (const name of ["..", ".", "../..", "a/b"]) {
			const result = await runQuickchr(["remove", name]);
			expect({ name, exitCode: result.exitCode }).toEqual({ name, exitCode: 1 });
			expect(result.stderr).toContain("INVALID_NAME");
		}

		expect(existsSync(join(TEST_DIR, "machines", "keep-me", "machine.json"))).toBe(true);
		expect(existsSync(join(TEST_DIR, "cache", "keep.img"))).toBe(true);
	});

	test("doctor names the orphan and a command that clears it", async () => {
		strandDirectory("half-made");
		const result = await runQuickchr(["doctor"]);
		expect(result.stdout).toContain("half-made");
		expect(result.stdout).toContain("quickchr remove half-made");
		expect(result.stdout).not.toContain("rm -rf");
	});
});
