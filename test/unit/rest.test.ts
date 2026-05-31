import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { restGet, restPatch, restPost, restRequest } from "../../src/lib/rest.ts";

type MockHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

const auth = "Basic test-token";
const servers: Server[] = [];

function startMockServer(handler: MockHandler): Promise<{ port: number; server: Server }> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			Promise.resolve(handler(req, res)).catch((error) => {
				res.writeHead(500, { "Content-Type": "text/plain" });
				res.end(String(error));
			});
		});
		server.listen(0, "127.0.0.1", () => {
			servers.push(server);
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			resolve({ port, server });
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
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
	await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

describe("restGet", () => {
	test("sends auth and close headers, preserves query strings, and returns streamed body", async () => {
		const seen: Record<string, string | undefined> = {};
		const { port } = await startMockServer((req, res) => {
			seen.method = req.method;
			seen.url = req.url;
			seen.authorization = req.headers.authorization;
			seen.connection = req.headers.connection;
			res.writeHead(207, { "Content-Type": "application/json" });
			res.write('{"ok":');
			res.end("true}");
		});

		const response = await restGet(`http://127.0.0.1:${port}/rest/system/resource?detail=yes`, auth);

		expect(response).toEqual({ status: 207, body: '{"ok":true}' });
		expect(seen).toEqual({
			method: "GET",
			url: "/rest/system/resource?detail=yes",
			authorization: auth,
			connection: "close",
		});
	});

	test("rejects directly on timeout instead of hanging on req.destroy", async () => {
		let heldResponse: ServerResponse | undefined;
		const { port } = await startMockServer((_req, res) => {
			heldResponse = res;
		});

		const start = Date.now();
		const error = await restGet(`http://127.0.0.1:${port}/rest/system/resource`, auth, 50).catch((e) => e);
		heldResponse?.destroy();
		const elapsed = Date.now() - start;

		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain("restGet timeout after 50ms");
		expect(elapsed).toBeLessThan(1000);
	});
});

describe("JSON REST methods", () => {
	test("restPost and restPatch serialize JSON bodies with content headers", async () => {
		const seen: Array<{
			method?: string;
			url?: string;
			body: string;
			contentType?: string | string[];
			contentLength?: string | string[];
			authorization?: string;
		}> = [];
		const { port } = await startMockServer(async (req, res) => {
			const body = await readRequestBody(req);
			seen.push({
				method: req.method,
				url: req.url,
				body,
				contentType: req.headers["content-type"],
				contentLength: req.headers["content-length"],
				authorization: req.headers.authorization,
			});
			res.writeHead(req.method === "PATCH" ? 204 : 200, { "Content-Type": "application/json" });
			res.end(req.method === "PATCH" ? "" : '{"accepted":true}');
		});

		const postBody = { name: "chr", disabled: false };
		const patchBody = { disabled: true };
		const post = await restPost(`http://127.0.0.1:${port}/rest/user`, auth, postBody);
		const patch = await restPatch(`http://127.0.0.1:${port}/rest/user/*1`, auth, patchBody);

		expect(post).toEqual({ status: 200, body: '{"accepted":true}' });
		expect(patch).toEqual({ status: 204, body: "" });
		expect(seen).toEqual([
			{
				method: "POST",
				url: "/rest/user",
				body: JSON.stringify(postBody),
				contentType: "application/json",
				contentLength: String(Buffer.byteLength(JSON.stringify(postBody))),
				authorization: auth,
			},
			{
				method: "PATCH",
				url: "/rest/user/*1",
				body: JSON.stringify(patchBody),
				contentType: "application/json",
				contentLength: String(Buffer.byteLength(JSON.stringify(patchBody))),
				authorization: auth,
			},
		]);
	});

	test("restRequest supports raw string bodies and bodyless methods", async () => {
		const seen: Array<{
			method?: string;
			body: string;
			contentType?: string | string[];
			contentLength?: string | string[];
		}> = [];
		const { port } = await startMockServer(async (req, res) => {
			seen.push({
				method: req.method,
				body: await readRequestBody(req),
				contentType: req.headers["content-type"],
				contentLength: req.headers["content-length"],
			});
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("ok");
		});

		const raw = '{"raw":true}';
		const put = await restRequest(`http://127.0.0.1:${port}/rest/user`, "PUT", auth, raw);
		const del = await restRequest(`http://127.0.0.1:${port}/rest/user/*1`, "DELETE", auth, null);

		expect(put).toEqual({ status: 200, body: "ok" });
		expect(del).toEqual({ status: 200, body: "ok" });
		expect(seen).toEqual([
			{
				method: "PUT",
				body: raw,
				contentType: "application/json",
				contentLength: String(Buffer.byteLength(raw)),
			},
			{
				method: "DELETE",
				body: "",
				contentType: undefined,
				contentLength: "0",
			},
		]);
	});
});
