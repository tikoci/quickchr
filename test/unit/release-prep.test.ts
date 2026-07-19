import { describe, expect, test } from "bun:test";
import {
	nextVersion,
	npmTag,
	releaseNotesForVersion,
	rolloverChangelog,
} from "../../scripts/release-prep.ts";

// Anchor tests for release metadata: version arithmetic, the odd/even-minor npm
// dist-tag scheme, the local CHANGELOG rollover helper, and the CI read-only
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

describe("npmTag", () => {
	test("odd minor → next (pre-release), even minor → latest", () => {
		expect(npmTag("0.5.0")).toBe("next");
		expect(npmTag("0.4.3")).toBe("latest");
		expect(npmTag("1.0.0")).toBe("latest");
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
