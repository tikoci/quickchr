import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { runExample } from "../../examples/lib.ts";
import type { ChrInstance } from "../../src/lib/types.ts";

/**
 * `runExample()`'s teardown contract (#145): a failed `remove()` used to be caught and
 * dropped, so a leaked machine showed up only in the smoke harness's final prefix
 * assertion, with the error that explained it gone. No QEMU — the tracked instances
 * are stubs that record their removal.
 */

let errors: string[];
let removed: string[];
const savedExitCode = process.exitCode;

function instance(name: string, removeError?: string): ChrInstance {
	return {
		name,
		remove: async () => {
			removed.push(name);
			if (removeError) throw new Error(removeError);
		},
	} as unknown as ChrInstance;
}

beforeEach(() => {
	errors = [];
	removed = [];
	process.exitCode = 0;
	spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	});
});

afterEach(() => {
	mock.restore();
	process.exitCode = savedExitCode;
});

describe("runExample teardown (#145)", () => {
	test("body passes, teardown passes: exit code untouched, nothing reported", async () => {
		await runExample(async (track) => {
			track(instance("examples-ok"));
		});
		expect(removed).toEqual(["examples-ok"]);
		expect(errors).toEqual([]);
		expect(process.exitCode).toBe(0);
	});

	test("body passes, teardown fails: the run fails and names the machine and its error", async () => {
		await runExample(async (track) => {
			track(instance("examples-leak", "EBUSY: resource busy or locked"));
		});
		expect(process.exitCode).toBe(1);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("teardown failed for examples-leak");
		expect(errors[0]).toContain("EBUSY: resource busy or locked");
		expect(errors[0]).toContain("quickchr remove examples-leak");
	});

	test("body fails and teardown fails: both errors survive, the body's first", async () => {
		await runExample(async (track) => {
			track(instance("examples-rollback", "remove failed"));
			throw new Error('Monitor command timed out after 5000ms: "savevm baseline"');
		});
		expect(process.exitCode).toBe(1);
		expect(errors).toHaveLength(2);
		expect(errors[0]).toContain("example failed");
		expect(errors[0]).toContain("savevm baseline");
		expect(errors[1]).toContain("teardown failed for examples-rollback: remove failed");
	});

	test("one failed removal does not stop the others", async () => {
		await runExample(async (track) => {
			track(instance("examples-a", "first remove failed"));
			track(instance("examples-b"));
		});
		expect(removed).toEqual(["examples-a", "examples-b"]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("examples-a");
		expect(process.exitCode).toBe(1);
	});
});
