import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { QuickCHR } from "../../src/lib/quickchr.ts";
import type { ChrInstance, MachineState } from "../../src/lib/types.ts";

let server: Server | null = null;

afterEach(() => {
	if (server) {
		server.close();
		server = null;
	}
});

function startMockServer(
	handler: (req: { method: string; url: string }, res: {
		writeHead: (status: number, headers?: Record<string, string>) => void;
		end: (body?: string) => void;
	}) => void,
): Promise<{ port: number; server: Server }> {
	return new Promise((resolve) => {
		const nextServer = createServer((req, res) => {
			handler(
				{ method: req.method ?? "GET", url: req.url ?? "/" },
				{
					writeHead: (status, headers) => res.writeHead(status, headers),
					end: (body) => res.end(body),
				},
			);
		});
		nextServer.listen(0, "127.0.0.1", () => {
			const address = nextServer.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({ port, server: nextServer });
		});
	});
}

function makeMachineState(httpPort: number): MachineState {
	return {
		name: "unit-license-provision",
		version: "7.22.1",
		arch: "x86",
		cpu: 1,
		mem: 256,
		networks: [],
		ports: {
			http: { name: "http", host: httpPort, guest: 80, proto: "tcp" },
			https: { name: "https", host: httpPort + 1, guest: 443, proto: "tcp" },
			ssh: { name: "ssh", host: httpPort + 2, guest: 22, proto: "tcp" },
			api: { name: "api", host: httpPort + 3, guest: 8728, proto: "tcp" },
			"api-ssl": { name: "api-ssl", host: httpPort + 4, guest: 8729, proto: "tcp" },
			winbox: { name: "winbox", host: httpPort + 5, guest: 8291, proto: "tcp" },
		},
		packages: [],
		portBase: httpPort,
		excludePorts: [],
		extraPorts: [],
		createdAt: new Date().toISOString(),
		status: "running",
		machineDir: import.meta.dir,
	};
}

describe("QuickCHR._provisionInstance — license failures", () => {
	test("propagates renewal errors instead of logging and continuing", async () => {
		const instance = {} as ChrInstance;
		const started = await startMockServer((req, res) => {
			if (req.url.includes("/rest/system/license/renew")) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify([
					{ ".section": "0", status: "connecting" },
					{ ".section": "1", status: "ERROR: Unauthorized" },
				]));
				return;
			}

			if (req.url.includes("/rest/system/license")) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ "system-id": "TEST" }));
				return;
			}

			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("not found");
		});
		server = started.server;

		await expect(
			QuickCHR._provisionInstance(
				instance,
				makeMachineState(started.port),
				{
					license: {
						account: "user@example.com",
						password: "bad-password",
						level: "p1",
					},
				},
				{} as never,
			),
		).rejects.toMatchObject({
			code: "PROCESS_FAILED",
			message: expect.stringContaining("Unauthorized"),
		});
	}, 10_000);
});
