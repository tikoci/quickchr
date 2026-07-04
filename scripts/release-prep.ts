#!/usr/bin/env bun
/**
 * release-prep — compute the next version, roll CHANGELOG.md's [Unreleased]
 * section over to it, and bump package.json. The mutation half of release.yml
 * (see ci.instructions.md "Release Process"); the workflow does the git/npm side.
 *
 * Usage: bun scripts/release-prep.ts <patch|minor|major|X.Y.Z> [--dry-run] [--notes-out <file>]
 *
 * - Fails if CHANGELOG.md's [Unreleased] section is empty — a release must say
 *   what changed. (The end-of-session checklist keeps [Unreleased] current.)
 * - Inserts `## [X.Y.Z] — YYYY-MM-DD` below a fresh [Unreleased] heading.
 * - Prints machine-readable lines: `version=X.Y.Z` and `npm-tag=next|latest`
 *   (odd minor → next, even minor → latest — the repo's pre-release scheme).
 * - --notes-out writes just the released section body (the GitHub Release notes).
 * - --dry-run computes and prints everything but writes no files.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

export function nextVersion(current: string, bump: string): string {
	const m = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!m) throw new Error(`current version "${current}" is not X.Y.Z`);
	const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
	switch (bump) {
		case "patch":
			return `${maj}.${min}.${pat + 1}`;
		case "minor":
			return `${maj}.${min + 1}.0`;
		case "major":
			return `${maj + 1}.0.0`;
		default:
			if (!/^\d+\.\d+\.\d+$/.test(bump)) {
				throw new Error(`bump "${bump}" is not patch/minor/major or an exact X.Y.Z`);
			}
			return bump;
	}
}

export function npmTag(version: string): "next" | "latest" {
	const minor = Number(version.split(".")[1]);
	return minor % 2 !== 0 ? "next" : "latest";
}

export interface Rollover {
	changelog: string;
	notes: string;
}

/** Move [Unreleased] content under a new version heading; fresh empty [Unreleased] on top. */
export function rolloverChangelog(text: string, version: string, date: string): Rollover {
	const lines = text.split("\n");
	const unreleasedIdx = lines.findIndex((l) => /^## \[Unreleased\]/i.test(l));
	if (unreleasedIdx < 0) throw new Error("CHANGELOG.md has no '## [Unreleased]' heading");
	let nextIdx = lines.findIndex((l, i) => i > unreleasedIdx && /^## /.test(l));
	if (nextIdx < 0) nextIdx = lines.length;
	const body = lines.slice(unreleasedIdx + 1, nextIdx);
	const notes = body.join("\n").trim();
	if (!notes) {
		throw new Error(
			"CHANGELOG.md [Unreleased] is empty — a release must document what changed. " +
				"Add entries under '## [Unreleased]' first.",
		);
	}
	const out = [
		...lines.slice(0, unreleasedIdx),
		"## [Unreleased]",
		"",
		`## [${version}] — ${date}`,
		"",
		notes,
		"",
		...lines.slice(nextIdx),
	];
	return { changelog: out.join("\n"), notes };
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const bump = args.find((a) => !a.startsWith("--"));
	const dryRun = args.includes("--dry-run");
	const notesOutIdx = args.indexOf("--notes-out");
	const notesOut = notesOutIdx >= 0 ? args[notesOutIdx + 1] : undefined;
	if (!bump) {
		console.error("usage: bun scripts/release-prep.ts <patch|minor|major|X.Y.Z> [--dry-run] [--notes-out <file>]");
		process.exit(2);
	}

	const pkgPath = join(ROOT, "package.json");
	const clPath = join(ROOT, "CHANGELOG.md");
	const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
	const version = nextVersion(pkg.version, bump);
	const tag = npmTag(version);
	const date = new Date().toISOString().slice(0, 10);

	const { changelog, notes } = rolloverChangelog(readFileSync(clPath, "utf-8"), version, date);

	if (!dryRun) {
		// Preserve package.json formatting by targeted replace of the version line.
		const pkgText = readFileSync(pkgPath, "utf-8");
		const bumped = pkgText.replace(
			`"version": "${pkg.version}"`,
			`"version": "${version}"`,
		);
		if (bumped === pkgText) throw new Error("failed to bump version in package.json");
		writeFileSync(pkgPath, bumped);
		writeFileSync(clPath, changelog);
		if (notesOut) writeFileSync(notesOut, `${notes}\n`);
	}

	console.log(`version=${version}`);
	console.log(`npm-tag=${tag}`);
	console.log(`dry-run=${dryRun}`);
	console.log(`\n--- release notes (${version}) ---\n${notes}`);
}

if (import.meta.main) {
	await main();
}
