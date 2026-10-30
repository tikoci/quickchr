import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertRestAnswering, rebootForPackageActivation } from "../../src/lib/quickchr.ts";
import { QuickCHRError } from "../../src/lib/types.ts";

/**
 * `installPackage()` against a mock guest — the paths a live CHR cannot be
 * asked to take on purpose.
 *
 * A worker subprocess (see `helpers/install-package-worker.ts`) drives the
 * public method with the package download and SCP mocked out and a mock HTTP
 * guest answering REST, then reports what happened as JSON. Module mocks cannot
 * live in this process alongside the other unit tests, hence the subprocess —
 * the same shape as the wizard/boot-timeout workers.
 *
 * The applied-for-real path stays in `test/integration/` (`set-package` for
 * the CLI route, `start-stop` for the library method).
 */

const TEST_DIR = join(import.meta.dir, ".tmp-install-package-test");
const WORKER = join(import.meta.dir, "helpers/install-package-worker.ts");

interface WorkerReport {
	scenario: string;
	returned?: string[];
	code?: string | null;
	message?: string;
	elapsedMs: number;
	persistedPackages: string[] | null;
	persistedSteps: string[] | null;
	uploadCalls: Array<{ paths: string[]; sshPort: number; user: string; password: string }>;
}

async function runWorker(scenario: string): Promise<WorkerReport> {
	const dir = join(TEST_DIR, scenario);
	mkdirSync(dir, { recursive: true });
	const proc = Bun.spawn([process.execPath, WORKER, scenario, dir], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });
	return JSON.parse(stdout.trim().split("\n").at(-1) as string) as WorkerReport;
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("installPackage() — a guest-rejected reboot is a failure, not a success", () => {
	test("HTTP 401 on the reboot POST throws before anything is recorded", async () => {
		// The pre-flight probe passed with these credentials moments earlier, so
		// the 401 is the guest refusing this reboot — swallowing it used to let
		// waitForBoot pass immediately (the machine never went down) and persist
		// the packages as installed.
		const report = await runWorker("rejected-401");
		expect(report.code).toBe("PROCESS_FAILED");
		expect(report.message).toContain("401");
		expect(report.returned).toBeUndefined();
		// Nothing recorded: machine.json must not claim an install that never
		// activated, or a later start treats it as a satisfied no-op.
		expect(report.persistedPackages).toEqual([]);
		expect(report.persistedSteps).toBeNull();
		// And the upload went over the machine's own credentials — admin is
		// disabled on this machine, so factory `admin:` would have failed.
		expect(report.uploadCalls).toHaveLength(1);
		expect(report.uploadCalls[0]).toMatchObject({ user: "lab", password: "lab-pass-1" });
	});

	test("HTTP 400 on the reboot POST throws a reboot error, not an auth one", async () => {
		const report = await runWorker("rejected-400");
		expect(report.code).toBe("REBOOT_FAILED");
		expect(report.message).toContain("400");
		expect(report.returned).toBeUndefined();
		expect(report.persistedPackages).toEqual([]);
		expect(report.persistedSteps).toBeNull();
	});
});

describe("installPackage() — what an install records for the provisioning window", () => {
	test("a clean install records the packages and the step", async () => {
		const report = await runWorker("applied");
		expect(report.code).toBeUndefined();
		expect(report.returned).toEqual(["container"]);
		expect(report.persistedPackages).toEqual(["container"]);
		expect(report.persistedSteps).toEqual(["packages"]);
	}, 30_000);

	test("add-time packages that never ran keep the step unrecorded", async () => {
		// `ups` is desired config from add(); its first boot never installed it.
		// Recording the step would let a later `start --add-package ups` pass as
		// already applied — a silent drop (#176). Unrecorded, that start is
		// refused with the `set --package` route instead.
		const report = await runWorker("desired-unapplied");
		expect(report.code).toBeUndefined();
		expect(report.returned).toEqual(["container"]);
		expect(report.persistedPackages).toEqual(["ups", "container"]);
		expect(report.persistedSteps).toBeNull();
	}, 30_000);
});

describe("installPackage() — unknown names return [] without probing the guest", () => {
	test("no match in all_packages means no REST probe, no upload, no reboot", async () => {
		// There is no guest at all in this scenario — the REST port is closed.
		// A probe-before-match order spends the whole 30 s pre-flight budget and
		// throws BOOT_TIMEOUT for a request that names nothing installable.
		const report = await runWorker("unknown-name");
		expect(report.returned).toEqual([]);
		expect(report.code).toBeUndefined();
		expect(report.uploadCalls).toHaveLength(0);
		expect(report.persistedPackages).toEqual([]);
		expect(report.persistedSteps).toBeNull();
		expect(report.elapsedMs).toBeLessThan(10_000);
	});
});

/**
 * The reboot sequence below `installPackage()`, against mock guests with tiny
 * budgets — the two BOOT_TIMEOUT paths, the remaining rejection branches, and
 * down-detection. No module mocks here: these helpers only speak HTTP.
 */

const mockServers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
	for (const server of mockServers.splice(0)) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

type MockRoute = (req: IncomingMessage, res: ServerResponse) => void;

async function mockGuest(onRequest: MockRoute): Promise<number> {
	const server = createServer(onRequest);
	mockServers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as AddressInfo).port;
}

async function closedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

function resourceOk(res: ServerResponse): void {
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ "board-name": "CHR", version: "7.24.4" }));
}

const AUTH = `Basic ${btoa("lab:lab-pass-1")}`;

async function codeOf(promise: Promise<unknown>): Promise<{ code: string | null; message: string }> {
	try {
		await promise;
		return { code: null, message: "" };
	} catch (e) {
		return {
			code: e instanceof QuickCHRError ? e.code : null,
			message: e instanceof Error ? e.message : String(e),
		};
	}
}

describe("assertRestAnswering() — the pre-upload probe", () => {
	test("a REST-dead machine is refused with BOOT_TIMEOUT", async () => {
		const port = await closedPort();
		const { code, message } = await codeOf(assertRestAnswering(port, AUTH, "lab", 500));
		expect(code).toBe("BOOT_TIMEOUT");
		expect(message).toContain("did not answer");
	});

	test("an answering machine passes", async () => {
		const port = await mockGuest((req, res) => {
			if (req.method === "GET" && req.url === "/rest/system/resource") resourceOk(res);
			else { res.writeHead(404, {}); res.end("{}"); }
		});
		await assertRestAnswering(port, AUTH, "lab", 30_000);
	});
});

describe("rebootForPackageActivation() — status check, down-detection, wait", () => {
	test("HTTP 403 rejects like 401 — an auth failure, not a reboot failure", async () => {
		const port = await mockGuest((req, res) => {
			if (req.method === "POST" && req.url === "/rest/system/reboot") {
				res.writeHead(403, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ detail: "forbidden" }));
			} else if (req.method === "GET") resourceOk(res);
			else { res.writeHead(404, {}); res.end("{}"); }
		});
		const { code, message } = await codeOf(rebootForPackageActivation(port, AUTH, "lab", 1500, 1500));
		expect(code).toBe("PROCESS_FAILED");
		expect(message).toContain("403");
	});

	test("HTTP 500 rejects as a reboot failure", async () => {
		const port = await mockGuest((req, res) => {
			if (req.method === "POST" && req.url === "/rest/system/reboot") {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end("router exploded");
			} else if (req.method === "GET") resourceOk(res);
			else { res.writeHead(404, {}); res.end("{}"); }
		});
		const { code, message } = await codeOf(rebootForPackageActivation(port, AUTH, "lab", 1500, 1500));
		expect(code).toBe("REBOOT_FAILED");
		expect(message).toContain("500");
	});

	test("a dropped POST followed by recovery succeeds", async () => {
		// The production shape: the reboot POST drops mid-request, the guest is
		// unreachable long enough for two probes (1 s apart) to fail, then REST
		// comes back.
		const downUntil = Date.now() + 2500;
		const port = await mockGuest((req, res) => {
			if (req.method === "POST" && req.url === "/rest/system/reboot") {
				res.destroy();
			} else if (req.method === "GET" && req.url === "/rest/system/resource") {
				if (Date.now() < downUntil) res.destroy();
				else resourceOk(res);
			} else { res.writeHead(404, {}); res.end("{}"); }
		});
		await rebootForPackageActivation(port, AUTH, "lab", 30_000, 10_000);
	}, 15_000);

	test("REST that never goes down after an accepted reboot is a reboot failure", async () => {
		// 200 on the POST, then the guest keeps answering: the reboot did not
		// happen, and waiting for boot would pass immediately on a machine that
		// never went down.
		const port = await mockGuest((req, res) => {
			if (req.method === "POST" && req.url === "/rest/system/reboot") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end("{}");
			} else if (req.method === "GET") resourceOk(res);
			else { res.writeHead(404, {}); res.end("{}"); }
		});
		const { code, message } = await codeOf(rebootForPackageActivation(port, AUTH, "lab", 1500, 1500));
		expect(code).toBe("REBOOT_FAILED");
		expect(message).toContain("did not go down");
	});

	test("one dropped probe with the guest still up is not a reboot", async () => {
		// A slow guest can drop or time out a single request. Read as "went
		// down", waitForBoot would pass at once and the install would be
		// recorded although the reboot never happened.
		let probes = 0;
		const port = await mockGuest((req, res) => {
			if (req.method === "POST" && req.url === "/rest/system/reboot") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end("{}");
			} else if (req.method === "GET" && req.url === "/rest/system/resource") {
				if (probes++ === 0) res.destroy();
				else resourceOk(res);
			} else { res.writeHead(404, {}); res.end("{}"); }
		});
		const { code, message } = await codeOf(rebootForPackageActivation(port, AUTH, "lab", 1500, 2500));
		expect(code).toBe("REBOOT_FAILED");
		expect(message).toContain("did not go down");
	});

	test("a guest that goes down and never comes back is a BOOT_TIMEOUT", async () => {
		const port = await mockGuest((_req, res) => {
			// Every request drops: the POST and every probe after it.
			res.destroy();
		});
		const { code, message } = await codeOf(rebootForPackageActivation(port, AUTH, "lab", 1500, 5000));
		expect(code).toBe("BOOT_TIMEOUT");
		expect(message).toContain("did not come back up");
	});
});
