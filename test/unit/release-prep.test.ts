import { describe, expect, test } from "bun:test";
import {
	assertNotBehindLatest,
	extraNpmTags,
	nextVersion,
	parseNpmTag,
	releaseNotesForVersion,
	rolloverChangelog,
} from "../../scripts/release-prep.ts";

// Anchor tests for release metadata: version arithmetic, the explicit npm
// dist-tag choice (next|latest; never inferred from the version), the local CHANGELOG rollover helper, and the CI read-only
// package.json-as-truth release notes path.

describe("nextVersion", () => {
	test("patch/minor/major arithmetic", () => {
		expect(nextVersion("0.4.2", "patch")).toBe("0.4.3");
		expect(nextVersion("0.4.2", "minor")).toBe("0.5.0");
		expect(nextVersion("0.4.2", "major")).toBe("1.0.0");
	});

	test("exact version passes through; garbage rejected", () => {
		expect(nextVersion("0.4.2", "0.6.0")).toBe("0.6.0");
		expect(() => nextVersion("0.4.2", "banana")).toThrow(/patch\/minor\/major/);
		expect(() => nextVersion("not-semver", "patch")).toThrow(/X\.Y\.Z/);
	});
});

describe("parseNpmTag", () => {
	test("defaults to next; accepts next and latest only", () => {
		expect(parseNpmTag(undefined)).toBe("next");
		expect(parseNpmTag("next")).toBe("next");
		expect(parseNpmTag("latest")).toBe("latest");
		expect(() => parseNpmTag("beta")).toThrow(/next or latest/);
	});
});

describe("extraNpmTags", () => {
	test("a latest release also advances next; a next release moves nothing", () => {
		// `next` has no separately maintained line, so it must never point at
		// something older than `latest`.
		expect(extraNpmTags("latest")).toEqual(["next"]);
		expect(extraNpmTags("next")).toEqual([]);
	});

	test("never makes a next release latest", () => {
		expect(extraNpmTags("next")).not.toContain("latest");
	});
});

describe("assertNotBehindLatest", () => {
	test("refuses a version older than npm latest", () => {
		expect(() => assertNotBehindLatest("0.5.1", "0.5.2")).toThrow(/older than npm latest 0\.5\.2/);
		expect(() => assertNotBehindLatest("0.4.9", "0.5.0")).toThrow(/older/);
		expect(() => assertNotBehindLatest("0.9.9", "1.0.0")).toThrow(/older/);
	});

	test("allows equal-or-newer, and an unknown latest", () => {
		expect(() => assertNotBehindLatest("0.5.1", "0.4.8")).not.toThrow();
		expect(() => assertNotBehindLatest("1.0.0", "0.9.9")).not.toThrow();
		expect(() => assertNotBehindLatest("0.5.1", undefined)).not.toThrow();
	});
});

const CHANGELOG = `# Changelog

Intro text.

## [Unreleased]

### Added

- something new

## [0.4.2] — 2026-06-21

- old entry
`;

describe("rolloverChangelog", () => {
	test("moves [Unreleased] content under the new version heading", () => {
		const { changelog, notes } = rolloverChangelog(CHANGELOG, "0.4.3", "2026-07-04");
		expect(notes).toContain("- something new");
		expect(changelog).toContain("## [0.4.3] — 2026-07-04");
		// Fresh empty [Unreleased] stays on top, released section below it.
		const unreleasedIdx = changelog.indexOf("## [Unreleased]");
		const newIdx = changelog.indexOf("## [0.4.3]");
		const oldIdx = changelog.indexOf("## [0.4.2]");
		expect(unreleasedIdx).toBeGreaterThan(-1);
		expect(unreleasedIdx).toBeLessThan(newIdx);
		expect(newIdx).toBeLessThan(oldIdx);
		// Old content untouched.
		expect(changelog).toContain("- old entry");
	});

	test("empty [Unreleased] refuses to release", () => {
		const empty = "# Changelog\n\n## [Unreleased]\n\n## [0.4.2] — 2026-06-21\n\n- old\n";
		expect(() => rolloverChangelog(empty, "0.4.3", "2026-07-04")).toThrow(/\[Unreleased\] is empty/);
	});

	test("missing [Unreleased] heading is an error", () => {
		expect(() => rolloverChangelog("# Changelog\n\n## [0.4.2]\n", "0.4.3", "2026-07-04")).toThrow(
			/no '## \[Unreleased\]'/,
		);
	});
});

describe("releaseNotesForVersion", () => {
	test("extracts an already-promoted release section", () => {
		const notes = releaseNotesForVersion(CHANGELOG, "0.4.2");
		expect(notes).toBe("- old entry");
	});

	test("missing version heading is an error", () => {
		expect(() => releaseNotesForVersion(CHANGELOG, "0.4.3")).toThrow(/no '## \[0\.4\.3\]'/);
	});

	test("empty version section is an error", () => {
		const empty = "# Changelog\n\n## [0.4.3]\n\n## [0.4.2]\n\n- old\n";
		expect(() => releaseNotesForVersion(empty, "0.4.3")).toThrow(/section '## \[0\.4\.3\]' is empty/);
	});
});
