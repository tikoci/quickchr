import { describe, expect, test } from "bun:test";
import { findDuplicateLegs, type MatrixLeg } from "../../scripts/ci-plan.ts";

// The plan must refuse matrices whose legs cannot produce attributable
// results (#245 follow-up). Two legs on one platform resolving to one version
// share every downstream identity — suite-record target, checkpoint
// external_id, ndjson filename, ledger key — so the second leg overwrites the
// first's evidence instead of adding signal. Unknown platform ids and
// malformed targets already fail the plan the same way: a dispatch that
// cannot be reconciled fails here, not as corrupt data later.

const LABEL: Record<string, string> = {
	"linux-x86": "linux/x86_64",
	"linux-arm64": "linux/aarch64",
	"macos-arm64": "macos/arm64",
	"macos-x86": "macos/x86_64",
	"windows-x86": "windows/x86_64",
};

const leg = (id: string, target: string, resolved?: string): MatrixLeg => ({
	id,
	label: LABEL[id] ?? id,
	target,
	resolved,
});

describe("findDuplicateLegs", () => {
	test("flags two targets resolving to one version on one platform", () => {
		// `routeros-targets=stable,7.25` when stable IS 7.25: the supported
		// dispatch shape that used to ship two indistinguishable legs.
		const duplicates = findDuplicateLegs([
			leg("linux-x86", "stable", "7.25"),
			leg("linux-x86", "7.25", "7.25"),
		]);
		expect(duplicates).toHaveLength(1);
		expect(duplicates[0]?.platform).toBe("linux-x86");
		expect(duplicates[0]?.resolved).toBe("7.25");
		// Dispatch order, naming every leg so the error says what to drop.
		expect(duplicates[0]?.targets).toEqual(["stable", "7.25"]);
	});

	test("flags the same target listed twice", () => {
		const duplicates = findDuplicateLegs([leg("linux-x86", "stable", "7.25"), leg("linux-x86", "stable", "7.25")]);
		expect(duplicates).toHaveLength(1);
		expect(duplicates[0]?.targets).toEqual(["stable", "stable"]);
	});

	test("a three-way collision is one group naming all three targets", () => {
		const duplicates = findDuplicateLegs([
			leg("linux-x86", "stable", "7.25"),
			leg("linux-x86", "7.25", "7.25"),
			leg("linux-x86", "7.25.0", "7.25"),
		]);
		expect(duplicates).toHaveLength(1);
		expect(duplicates[0]?.targets).toEqual(["stable", "7.25", "7.25.0"]);
	});

	test("distinct versions on one platform pass", () => {
		expect(
			findDuplicateLegs([
				leg("linux-x86", "stable", "7.25"),
				leg("linux-x86", "long-term", "7.23.7"),
				leg("linux-x86", "testing", "7.26beta1"),
			]),
		).toEqual([]);
	});

	test("the same version on different platforms passes", () => {
		expect(
			findDuplicateLegs([
				leg("linux-x86", "stable", "7.25"),
				leg("linux-arm64", "stable", "7.25"),
				leg("macos-arm64", "stable", "7.25"),
			]),
		).toEqual([]);
	});

	test("legs without a resolution fall back to the label", () => {
		// Same rule the ledger reconciles under: unresolved legs key by
		// target, so only identical targets collide.
		expect(findDuplicateLegs([leg("linux-x86", "stable"), leg("linux-x86", "stable")])).toHaveLength(1);
		expect(findDuplicateLegs([leg("linux-x86", "stable"), leg("linux-x86", "testing")])).toEqual([]);
	});

	test("empty and singleton matrices pass", () => {
		expect(findDuplicateLegs([])).toEqual([]);
		expect(findDuplicateLegs([leg("linux-x86", "stable", "7.25")])).toEqual([]);
	});

	test("groups come out sorted, so the error reads deterministically", () => {
		const duplicates = findDuplicateLegs([
			leg("windows-x86", "stable", "7.25"),
			leg("linux-x86", "stable", "7.25"),
			leg("windows-x86", "7.25", "7.25"),
			leg("linux-x86", "7.25", "7.25"),
		]);
		expect(duplicates.map((group) => `${group.platform}|${group.resolved}`)).toEqual(["linux-x86|7.25", "windows-x86|7.25"]);
	});
});
