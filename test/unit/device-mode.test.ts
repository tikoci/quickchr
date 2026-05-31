import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
	formatDeviceModeSelection,
	readDeviceMode,
	resolveDeviceModeOptions,
	shouldApplyDeviceMode,
	startDeviceModeUpdate,
	verifyDeviceMode,
	waitForDeviceModeApi,
} from "../../src/lib/device-mode.ts";

type MockHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

let server: Server | null = null;

function startMockServer(handler: MockHandler): Promise<number> {
	return new Promise((resolve) => {
		server = createServer((req, res) => {
			Promise.resolve(handler(req, res)).catch((error) => {
				res.writeHead(500, { "Content-Type": "text/plain" });
				res.end(String(error));
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const addr = server?.address();
			resolve(typeof addr === "object" && addr ? addr.port : 0);
		});
	});
}

function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

afterEach(async () => {
	if (!server) return;
	const closing = server;
	server = null;
	await new Promise<void>((resolve, reject) => {
		closing.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
});

describe("device-mode option resolution", () => {
	test("undefined options → skip (no provisioning)", () => {
		const resolved = resolveDeviceModeOptions();
		expect(resolved.skip).toBe(true);
		expect(shouldApplyDeviceMode(resolved)).toBe(false);
		expect(resolved.warnings.length).toBe(0);
	});

	test("explicit auto resolves to rose", () => {
		const resolved = resolveDeviceModeOptions({ mode: "auto" });
		expect(resolved.skip).toBe(false);
		expect(resolved.mode).toBe("rose");
		expect(shouldApplyDeviceMode(resolved)).toBe(true);
		expect(formatDeviceModeSelection(resolved)).toBe("mode=rose");
	});

	test("skip mode disables provisioning", () => {
		const resolved = resolveDeviceModeOptions({
			mode: "skip",
			enable: ["container"],
			disable: ["zerotier"],
		});
		expect(resolved.skip).toBe(true);
		expect(shouldApplyDeviceMode(resolved)).toBe(false);
		expect(resolved.warnings.some((w) => w.includes("ignores"))).toBe(true);
	});

	test("enterprise alias maps to advanced", () => {
		const resolved = resolveDeviceModeOptions({ mode: "enterprise" });
		expect(resolved.mode).toBe("advanced");
		expect(resolved.warnings.some((w) => w.includes("legacy"))).toBe(true);
	});

	test("options with enable but no mode defaults to auto → rose", () => {
		const resolved = resolveDeviceModeOptions({ enable: ["container"] });
		expect(resolved.skip).toBe(false);
		expect(resolved.mode).toBe("rose");
		expect(resolved.features.container).toBe("yes");
	});

	test("unknown mode and feature only warn", () => {
		const resolved = resolveDeviceModeOptions({
			mode: "future-mode",
			enable: ["new-feature"],
		});
		expect(resolved.mode).toBe("future-mode");
		expect(resolved.features["new-feature"]).toBe("yes");
		expect(resolved.warnings.some((w) => w.includes("unknown device-mode 'future-mode'"))).toBe(true);
		expect(resolved.warnings.some((w) => w.includes("unknown device-mode feature 'new-feature'"))).toBe(true);
	});

	test("disable wins when feature appears in both lists", () => {
		const resolved = resolveDeviceModeOptions({
			mode: "advanced",
			enable: ["container"],
			disable: ["container"],
		});
		expect(resolved.features.container).toBe("no");
		expect(resolved.warnings.some((w) => w.includes("both enable and disable"))).toBe(true);
	});

	test("normalizes comma-separated feature lists including install-any-version", () => {
		const resolved = resolveDeviceModeOptions({
			mode: "advanced",
			enable: [" Container,install-any-version ", "container"],
			disable: ["fetch, fetch"],
		});

		expect(resolved.features).toEqual({
			container: "yes",
			"install-any-version": "yes",
			fetch: "no",
		});
		expect(resolved.warnings).toEqual([]);
	});
});

describe("device-mode verification", () => {
	test("verification succeeds when mode/features match", () => {
		const resolved = resolveDeviceModeOptions({
			mode: "rose",
			enable: ["routerboard"],
			disable: ["zerotier"],
		});
		const verification = verifyDeviceMode(resolved, {
			mode: "rose",
			routerboard: "yes",
			zerotier: "no",
		});
		expect(verification.ok).toBe(true);
		expect(verification.mismatches.length).toBe(0);
	});

	test("verification reports mismatches", () => {
		const resolved = resolveDeviceModeOptions({
			mode: "rose",
			enable: ["routerboard"],
		});
		const verification = verifyDeviceMode(resolved, {
			mode: "advanced",
			routerboard: "no",
		});
		expect(verification.ok).toBe(false);
		expect(verification.mismatches.some((m) => m.includes("mode"))).toBe(true);
		expect(verification.mismatches.some((m) => m.includes("routerboard"))).toBe(true);
	});

	test("verification accepts RouterOS-style string booleans", () => {
		const resolved = resolveDeviceModeOptions({
			mode: "basic",
			enable: ["bandwidth-test", "ipsec"],
			disable: ["smb"],
		});
		const verification = verifyDeviceMode(resolved, {
			mode: "basic",
			"bandwidth-test": "true",
			ipsec: "true",
			smb: "false",
		});
		expect(verification.ok).toBe(true);
		expect(verification.mismatches.length).toBe(0);
	});
});

describe("device-mode REST reads", () => {
	test("normalizes singleton response keys and RouterOS boolean strings", async () => {
		const port = await startMockServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				Mode: "Advanced",
				container: "true",
				"install-any-version": "false",
				fetch: "enabled",
				proxy: "disabled",
			}));
		});

		await expect(readDeviceMode(port)).resolves.toEqual({
			mode: "advanced",
			container: "yes",
			"install-any-version": "no",
			fetch: "yes",
			proxy: "no",
		});
	});

	test("accepts an array response by reading the first record", async () => {
		const port = await startMockServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify([{ mode: "rose", container: "false" }]));
		});

		await expect(readDeviceMode(port)).resolves.toMatchObject({
			mode: "rose",
			container: "no",
		});
	});

	test("classifies non-JSON and wrong-endpoint resource bodies as PROCESS_FAILED", async () => {
		const invalidJsonPort = await startMockServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("not-json");
		});
		const invalidJsonError = await readDeviceMode(invalidJsonPort).catch((error) => error);
		expect(invalidJsonError.code).toBe("PROCESS_FAILED");
		expect(invalidJsonError.message).toContain("not JSON");

		await new Promise<void>((resolve) => server?.close(() => resolve()));
		server = null;

		const resourcePort = await startMockServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ "board-name": "CHR", "architecture-name": "x86_64" }));
		});
		const resourceError = await readDeviceMode(resourcePort).catch((error) => error);
		expect(resourceError.code).toBe("PROCESS_FAILED");
		expect(resourceError.message).toContain("system resource data");
	});
});

describe("device-mode REST orchestration helpers", () => {
	test("waitForDeviceModeApi sends default admin auth and returns on 2xx", async () => {
		let authorization: string | undefined;
		const port = await startMockServer((req, res) => {
			authorization = req.headers.authorization;
			res.writeHead(204);
			res.end();
		});

		await waitForDeviceModeApi(port, 1000);

		expect(authorization).toBe(`Basic ${btoa("admin:")}`);
	});

	test("waitForDeviceModeApi fails immediately on HTTP 401", async () => {
		const port = await startMockServer((_req, res) => {
			res.writeHead(401);
			res.end();
		});

		const error = await waitForDeviceModeApi(port, 5000).catch((e) => e);

		expect(error.code).toBe("PROCESS_FAILED");
		expect(error.message).toContain("HTTP 401");
	});

	test("startDeviceModeUpdate short-circuits skipped options", async () => {
		await expect(startDeviceModeUpdate(1, { skip: true, features: {}, warnings: [] })).resolves.toEqual({
			status: 200,
			body: "",
		});
	});

	test("startDeviceModeUpdate posts requested mode and feature flags", async () => {
		let body = "";
		let path: string | undefined;
		let authorization: string | undefined;
		const port = await startMockServer(async (req, res) => {
			path = req.url;
			authorization = req.headers.authorization;
			body = await readRequestBody(req);
			res.writeHead(202, { "Content-Type": "application/json" });
			res.end('{"pending":true}');
		});
		const resolved = resolveDeviceModeOptions({
			mode: "advanced",
			enable: ["container", "install-any-version"],
			disable: ["fetch"],
		});

		const response = await startDeviceModeUpdate(port, resolved);

		expect(response).toEqual({ status: 202, body: '{"pending":true}' });
		expect(path).toBe("/rest/system/device-mode/update");
		expect(authorization).toBe(`Basic ${btoa("admin:")}`);
		expect(JSON.parse(body)).toEqual({
			mode: "advanced",
			container: "yes",
			"install-any-version": "yes",
			fetch: "no",
		});
	});
});
