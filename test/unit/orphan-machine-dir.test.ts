import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dir, ".tmp-orphan-machine-dir");
const CLI = join(import.meta.dir, "../../src/cli/index.ts");

/** A minimal image that passes `isUsableCachedImage()` — an MBR signature plus a
 *  non-empty first partition entry — so `add` never reaches the network. */
function seedCachedImage(version: string, arch: string) {
	const image = Buffer.alloc(1024);
	image[510] = 0x55;
	image[511] = 0xaa;
	image.writeUInt32LE(1, 454);
	image.writeUInt32LE(1, 458);
	const suffix = arch === "arm64" ? "-arm64" : "";
	mkdirSync(join(TEST_DIR, "cache"), { recursive: true });
	writeFileSync(join(TEST_DIR, "cache", `chr-${version}${suffix}.img`), image);
}

async function runQuickchr(args: string[]) {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		env: {
			...process.env,
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
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("a failed add leaves nothing behind (#155)", () => {
	test("a throw after the image copy removes the directory add created", async () => {
		seedCachedImage("7.24.4", "x86");
		// `--boot-disk-format raw` with `--boot-size` is rejected inside
		// ensureConfiguredDisks — i.e. after ensureDir() and the image copy, which is
		// the window that used to strand a directory.
		const result = await runQuickchr([
			"add", "--name", "lab", "--version", "7.24.4", "--arch", "x86",
			"--boot-disk-format", "raw", "--boot-size", "1G",
		]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("INVALID_DISK_SIZE");
		expect(machinesDirContents()).toEqual([]);
	});

	test("an existing machine's directory survives a failed second add", async () => {
		seedCachedImage("7.24.4", "x86");
		const created = await runQuickchr(["add", "--name", "lab", "--version", "7.24.4", "--arch", "x86"]);
		expect(created.exitCode).toBe(0);
		expect(existsSync(join(TEST_DIR, "machines", "lab", "machine.json"))).toBe(true);

		const again = await runQuickchr(["add", "--name", "lab", "--version", "7.24.4", "--arch", "x86"]);
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
		const blocked = await runQuickchr(["add", "--name", "7.24.4-x86-1", "--version", "7.24.3"]);
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

	test("doctor names the orphan and a command that clears it", async () => {
		strandDirectory("half-made");
		const result = await runQuickchr(["doctor"]);
		expect(result.stdout).toContain("half-made");
		expect(result.stdout).toContain("quickchr remove half-made");
		expect(result.stdout).not.toContain("rm -rf");
	});
});
