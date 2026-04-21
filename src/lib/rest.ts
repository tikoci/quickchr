/**
 * Centralized HTTP client for all RouterOS CHR REST API calls.
 *
 * Uses node:http with agent:false to bypass Bun's connection pool.
 * Bun pools TCP connections by host:port; when a CHR is stopped and a new
 * one starts on the same port, the pool returns stale responses. This is
 * the root cause of "REST flakiness" we chased across 7 sessions.
 *
 * Uses setTimeout + done flag instead of req.setTimeout + req.destroy
 * because Bun's node:http req.destroy() does not reliably emit the
 * "error" event, which would leave the Promise pending forever.
 *
 * External URLs (mikrotik.com, upgrade server) use fetch() — no pool
 * issue there. This module is ONLY for CHR REST calls (127.0.0.1).
 */

import { request as nodeRequest } from "node:http";

export interface RestResponse {
	status: number;
	body: string;
}

/**
 * HTTP GET to a CHR REST endpoint.
 *
 * @param url        Full URL, e.g. "http://127.0.0.1:9100/rest/system/resource"
 * @param auth       HTTP Authorization header value (e.g. "Basic YWRtaW46")
 * @param timeoutMs  Per-request timeout in milliseconds (default 10s)
 */
export function restGet(
	url: string,
	auth: string,
	timeoutMs = 10_000,
): Promise<RestResponse> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		let done = false;

		const timer = setTimeout(() => {
			if (!done) { done = true; req.destroy(); reject(new Error(`restGet timeout after ${timeoutMs}ms: ${url}`)); }
		}, timeoutMs);

		const req = nodeRequest(
			{
				hostname: parsed.hostname,
				port: parsed.port,
				path: parsed.pathname + parsed.search,
				method: "GET",
				headers: { Authorization: auth, Connection: "close" },
				agent: false,
			},
			(res) => {
				let body = "";
				res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
				res.on("end", () => {
					if (!done) { done = true; clearTimeout(timer); resolve({ status: res.statusCode ?? 0, body }); }
				});
				res.on("error", (e) => {
					if (!done) { done = true; clearTimeout(timer); reject(e); }
				});
			},
		);
		req.on("error", (e) => {
			if (!done) { done = true; clearTimeout(timer); reject(e); }
		});
		req.end();
	});
}

/**
 * HTTP POST to a CHR REST endpoint with a JSON body.
 *
 * @param url        Full URL, e.g. "http://127.0.0.1:9100/rest/system/reboot"
 * @param auth       HTTP Authorization header value
 * @param jsonBody   Object to serialize as JSON request body
 * @param timeoutMs  Per-request timeout in milliseconds (default 10s)
 */
export function restPost(
	url: string,
	auth: string,
	jsonBody: Record<string, unknown>,
	timeoutMs = 10_000,
): Promise<RestResponse> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const bodyBuf = Buffer.from(JSON.stringify(jsonBody), "utf-8");
		let done = false;

		const timer = setTimeout(() => {
			if (!done) { done = true; req.destroy(); reject(new Error(`restPost timeout after ${timeoutMs}ms: ${url}`)); }
		}, timeoutMs);

		const req = nodeRequest(
			{
				hostname: parsed.hostname,
				port: parsed.port,
				path: parsed.pathname + parsed.search,
				method: "POST",
				headers: {
					Authorization: auth,
					"Content-Type": "application/json",
					"Content-Length": bodyBuf.length,
					Connection: "close",
				},
				agent: false,
			},
			(res) => {
				let body = "";
				res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
				res.on("end", () => {
					if (!done) { done = true; clearTimeout(timer); resolve({ status: res.statusCode ?? 0, body }); }
				});
				res.on("error", (e) => {
					if (!done) { done = true; clearTimeout(timer); reject(e); }
				});
			},
		);
		req.on("error", (e) => {
			if (!done) { done = true; clearTimeout(timer); reject(e); }
		});
		req.write(bodyBuf);
		req.end();
	});
}

/**
 * HTTP PATCH to a CHR REST endpoint with a JSON body.
 *
 * @param url        Full URL, e.g. "http://127.0.0.1:9100/rest/user/*1"
 * @param auth       HTTP Authorization header value
 * @param jsonBody   Object to serialize as JSON request body
 * @param timeoutMs  Per-request timeout in milliseconds (default 10s)
 */
export function restPatch(
	url: string,
	auth: string,
	jsonBody: Record<string, unknown>,
	timeoutMs = 10_000,
): Promise<RestResponse> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const bodyBuf = Buffer.from(JSON.stringify(jsonBody), "utf-8");
		let done = false;

		const timer = setTimeout(() => {
			if (!done) { done = true; req.destroy(); reject(new Error(`restPatch timeout after ${timeoutMs}ms: ${url}`)); }
		}, timeoutMs);

		const req = nodeRequest(
			{
				hostname: parsed.hostname,
				port: parsed.port,
				path: parsed.pathname + parsed.search,
				method: "PATCH",
				headers: {
					Authorization: auth,
					"Content-Type": "application/json",
					"Content-Length": bodyBuf.length,
					Connection: "close",
				},
				agent: false,
			},
			(res) => {
				let body = "";
				res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
				res.on("end", () => {
					if (!done) { done = true; clearTimeout(timer); resolve({ status: res.statusCode ?? 0, body }); }
				});
				res.on("error", (e) => {
					if (!done) { done = true; clearTimeout(timer); reject(e); }
				});
			},
		);
		req.on("error", (e) => {
			if (!done) { done = true; clearTimeout(timer); reject(e); }
		});
		req.write(bodyBuf);
		req.end();
	});
}

/**
 * Generic HTTP request to a CHR REST endpoint.
 * Used for arbitrary methods (PUT, DELETE) or when method is dynamic.
 *
 * @param url        Full URL
 * @param method     HTTP method
 * @param auth       HTTP Authorization header value
 * @param jsonBody   Optional JSON body (for POST/PUT/PATCH)
 * @param timeoutMs  Per-request timeout in milliseconds (default 10s)
 */
export function restRequest(
	url: string,
	method: string,
	auth: string,
	jsonBody?: Record<string, unknown> | string | null,
	timeoutMs = 10_000,
): Promise<RestResponse> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const bodyStr = jsonBody != null
			? (typeof jsonBody === "string" ? jsonBody : JSON.stringify(jsonBody))
			: null;
		const bodyBuf = bodyStr != null ? Buffer.from(bodyStr, "utf-8") : null;
		let done = false;

		const timer = setTimeout(() => {
			if (!done) { done = true; req.destroy(); reject(new Error(`restRequest timeout after ${timeoutMs}ms: ${method} ${url}`)); }
		}, timeoutMs);

		const headers: Record<string, string | number> = { Authorization: auth, Connection: "close" };
		if (bodyBuf) {
			headers["Content-Type"] = "application/json";
			headers["Content-Length"] = bodyBuf.length;
		}

		const req = nodeRequest(
			{
				hostname: parsed.hostname,
				port: parsed.port,
				path: parsed.pathname + parsed.search,
				method,
				headers,
				agent: false,
			},
			(res) => {
				let body = "";
				res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
				res.on("end", () => {
					if (!done) { done = true; clearTimeout(timer); resolve({ status: res.statusCode ?? 0, body }); }
				});
				res.on("error", (e) => {
					if (!done) { done = true; clearTimeout(timer); reject(e); }
				});
			},
		);
		req.on("error", (e) => {
			if (!done) { done = true; clearTimeout(timer); reject(e); }
		});
		if (bodyBuf) req.write(bodyBuf);
		req.end();
	});
}
