#!/usr/bin/env bun
/**
 * Shared helpers for quickchr runnable examples.
 *
 * Kept deliberately tiny so an example stays readable on its own. If you copy a
 * single example directory into your own project, either copy this file too or
 * inline the three helpers you use — each is a few lines.
 *
 * In-repo, examples import quickchr from `../../src/index.ts`. As an external
 * consumer, replace that with `@tikoci/quickchr` (see ../README.md).
 */
import { createServer } from "node:net";
import type { ChrInstance } from "../src/index.ts";

/**
 * Deterministic, collision-resistant machine name: `examples-<slug>-<unique>`.
 *
 * The `examples-` prefix lets CI reap leftovers by prefix and keeps example
 * machines distinct from a user's own; the unique suffix (pid + crypto-random)
 * makes parallel runs safe and interrupted-run recovery deterministic.
 */
export function exampleMachineName(slug: string): string {
	const unique = `${process.pid.toString(36)}${crypto.randomUUID().slice(0, 8)}`;
	return `examples-${slug}-${unique}`;
}

/**
 * Allocate a free ephemeral TCP port on loopback.
 *
 * Use it for a `socket-connect` NIC, a host listener, or to pick a `--forward`
 * host port that won't collide — never hard-code a host port in an example.
 */
export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => resolve(port));
		});
	});
}

/**
 * Assertion for runnable scripts (no test framework). Throws on failure;
 * {@link runExample}'s catch turns the throw into a non-zero exit + teardown.
 */
export function check(cond: unknown, message: string): asserts cond {
	if (!cond) throw new Error(message);
}

/**
 * Run an example body with **guaranteed teardown**.
 *
 * The body receives a `track` callback to register every {@link ChrInstance} it
 * creates; on success OR failure they are removed in a `finally`. On failure the
 * process exit code is set to 1 — we never call `process.exit()` before teardown,
 * which would strand a running QEMU/machine (quickchr spawns QEMU detached, so an
 * abrupt exit leaves a tracked-but-running machine until `quickchr remove` reaps it).
 *
 * A failed removal is never silent (#145): it is printed with the machine name and
 * its error, the remaining machines are still removed, and the run exits 1 even
 * when the body passed. The body's own error is printed first and stays the
 * primary failure.
 *
 * @example
 * if (import.meta.main) {
 *   await runExample(async (track) => {
 *     const chr = track(await QuickCHR.start({ name: exampleMachineName("quickstart") }));
 *     // ... do something real, check() the result ...
 *   });
 * }
 */
export async function runExample(
	body: (track: <T extends ChrInstance>(instance: T) => T) => Promise<void>,
): Promise<void> {
	const tracked: ChrInstance[] = [];
	const track = <T extends ChrInstance>(instance: T): T => {
		tracked.push(instance);
		return instance;
	};
	try {
		await body(track);
	} catch (err) {
		console.error(`\n✗ example failed: ${errorText(err)}`);
		process.exitCode = 1;
	} finally {
		for (const instance of tracked) {
			try {
				await instance.remove();
			} catch (err) {
				console.error(`✗ teardown failed for ${instance.name}: ${errorText(err)} — clear it with: quickchr remove ${instance.name}`);
				process.exitCode = 1;
			}
		}
	}
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
