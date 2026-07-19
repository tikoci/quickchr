#!/usr/bin/env bun
/**
 * release-prep — compute the next version, roll CHANGELOG.md's [Unreleased]
 * section over to it, and bump package.json for a local/manual release-prep PR.
 * The CI release workflow uses --from-package instead: it reads committed
 * package.json + CHANGELOG.md and never mutates tracked files.
 *
 * Usage: bun scripts/release-prep.ts <patch|minor|major|X.Y.Z> [--dry-run] [--notes-out <file>]
 *        bun scripts/release-prep.ts --from-package [--notes-out <file>]
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
	const m = version.match(/^\d+\.(\d+)\.\d+$/);
	if (!m) throw new Error(`version "${version}" is not X.Y.Z`);
	return Number(m[1]) % 2 !== 0 ? "next" : "latest";
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

/** Extract the already-promoted changelog section for package.json's version. */
export function releaseNotesForVersion(text: string, version: string): string {
	const lines = text.split("\n");
	const heading = new RegExp(`^## \\[${escapeRegex(version)}\\](?:\\s|$)`);
	const versionIdx = lines.findIndex((l) => heading.test(l));
	if (versionIdx < 0) {
		throw new Error(`CHANGELOG.md has no '## [${version}]' heading`);
	}
	let nextIdx = lines.findIndex((l, i) => i > versionIdx && /^## /.test(l));
	if (nextIdx < 0) nextIdx = lines.length;
	const notes = lines.slice(versionIdx + 1, nextIdx).join("\n").trim();
	if (!notes) {
		throw new Error(`CHANGELOG.md section '## [${version}]' is empty`);
	}
	return notes;
}

function positionals(args: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] ?? "";
		if (arg === "--notes-out") {
			i += 1;
			continue;
		}
		if (!arg.startsWith("--")) out.push(arg);
	}
	return out;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const fromPackage = args.includes("--from-package");
	const [bump] = positionals(args);
	const dryRun = args.includes("--dry-run");
	const notesOutIdx = args.indexOf("--notes-out");
	const notesOut = notesOutIdx >= 0 ? args[notesOutIdx + 1] : undefined;
	if (notesOutIdx >= 0 && (!notesOut || notesOut.startsWith("--"))) {
		console.error("--notes-out requires a file path");
		process.exit(2);
	}
	if (fromPackage && bump) {
		console.error("--from-package does not accept a bump argument");
		process.exit(2);
	}
	if (!fromPackage && !bump) {
		console.error(
			"usage: bun scripts/release-prep.ts <patch|minor|major|X.Y.Z> [--dry-run] [--notes-out <file>]\n" +
				"       bun scripts/release-prep.ts --from-package [--notes-out <file>]",
		);
		process.exit(2);
	}

	const pkgPath = join(ROOT, "package.json");
	const clPath = join(ROOT, "CHANGELOG.md");
	const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
	if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
		throw new Error(`package.json version "${pkg.version}" is not X.Y.Z`);
	}

	if (fromPackage) {
		const version = pkg.version;
		const tag = npmTag(version);
		const notes = releaseNotesForVersion(readFileSync(clPath, "utf-8"), version);
		if (notesOut) writeFileSync(notesOut, `${notes}\n`);
		console.log(`version=${version}`);
		console.log(`npm-tag=${tag}`);
		console.log("from-package=true");
		console.log(`\n--- release notes (${version}) ---\n${notes}`);
		return;
	}

	const version = nextVersion(pkg.version, bump ?? "");
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
