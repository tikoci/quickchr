#!/usr/bin/env bun
/**
 * release-prep — release metadata helper with two modes:
 *
 * - Local prep mode computes the next version, rolls CHANGELOG.md's [Unreleased]
 *   section over to it, and bumps package.json for a manual/PR-owned release prep.
 * - CI mode (--from-package) reads the committed package.json version plus its
 *   matching CHANGELOG.md section and never mutates tracked files.
 *
 * Usage: bun scripts/release-prep.ts <patch|minor|major|X.Y.Z> [--dry-run] [--notes-out <file>]
 *        bun scripts/release-prep.ts --from-package [--npm-tag next|latest]
 *                [--current-latest X.Y.Z] [--notes-out <file>]
 *
 * - Local prep mode fails if CHANGELOG.md's [Unreleased] section is empty, then
 *   inserts `## [X.Y.Z] — YYYY-MM-DD` below a fresh [Unreleased] heading.
 * - CI mode fails if CHANGELOG.md lacks a non-empty `## [X.Y.Z]` section matching
 *   package.json.
 * - Prints machine-readable lines: `version=X.Y.Z`, `npm-tag=next|latest`
 *   (the dist-tag is chosen per release with --npm-tag, default `next`; it is not
 *   derived from the version number), and `npm-extra-tags=` (comma list) for tags
 *   moved onto the release after publish: a `latest` release also advances `next`
 *   so it never lags `latest`.
 * - --current-latest X.Y.Z (the registry's current `latest`) refuses a version
 *   older than it, so neither tag can ever be pointed backwards.
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

export type NpmTag = "next" | "latest";

/** The dist-tag is a per-release decision (default `next`), never inferred from the version. */
export function parseNpmTag(value: string | undefined): NpmTag {
	const tag = value ?? "next";
	if (tag !== "next" && tag !== "latest") {
		throw new Error(`npm tag "${tag}" is not next or latest`);
	}
	return tag;
}

/**
 * Dist-tags to move onto the release *after* publishing it under `tag`.
 *
 * There is no separately maintained pre-release line: a quickchr bug is fixed on
 * main and ships in the next release. So `next` must never point at something
 * older than `latest` — left alone it strands `@next` consumers on whatever the
 * last prerelease was. Publishing to `latest` therefore also advances `next`.
 * Publishing to `next` moves nothing else; it must not become `latest`.
 */
export function extraNpmTags(tag: NpmTag): string[] {
	return tag === "latest" ? ["next"] : [];
}

function parseXyz(version: string): number[] {
	const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!m) throw new Error(`version "${version}" is not X.Y.Z`);
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Refuse a release older than the registry's current `latest` (that would point a tag backwards). */
export function assertNotBehindLatest(version: string, currentLatest: string | undefined): void {
	if (!currentLatest) return;
	const [a, b] = [parseXyz(version), parseXyz(currentLatest)];
	const diff = a.map((n, i) => n - (b[i] ?? 0)).find((d) => d !== 0) ?? 0;
	if (diff < 0) {
		throw new Error(
			`version ${version} is older than npm latest ${currentLatest} — next must never lag latest`,
		);
	}
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
		if (arg === "--notes-out" || arg === "--npm-tag" || arg === "--current-latest") {
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
	const valueOf = (flag: string): string | undefined => {
		const i = args.indexOf(flag);
		if (i < 0) return undefined;
		const v = args[i + 1];
		if (!v || v.startsWith("--")) {
			console.error(`${flag} requires a value`);
			process.exit(2);
		}
		return v;
	};
	const tag = parseNpmTag(valueOf("--npm-tag"));
	const currentLatest = valueOf("--current-latest");
	if (fromPackage && bump) {
		console.error("--from-package does not accept a bump argument");
		process.exit(2);
	}
	if (!fromPackage && !bump) {
		console.error(
			"usage: bun scripts/release-prep.ts <patch|minor|major|X.Y.Z> [--npm-tag next|latest] [--dry-run] [--notes-out <file>]\n" +
				"       bun scripts/release-prep.ts --from-package [--npm-tag next|latest] [--current-latest X.Y.Z] [--notes-out <file>]",
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
		assertNotBehindLatest(version, currentLatest);
		const notes = releaseNotesForVersion(readFileSync(clPath, "utf-8"), version);
		if (notesOut) writeFileSync(notesOut, `${notes}\n`);
		console.log(`version=${version}`);
		console.log(`npm-tag=${tag}`);
		console.log(`npm-extra-tags=${extraNpmTags(tag).join(",")}`);
		console.log("from-package=true");
		console.log(`\n--- release notes (${version}) ---\n${notes}`);
		return;
	}

	const version = nextVersion(pkg.version, bump ?? "");
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
	console.log(`npm-extra-tags=${extraNpmTags(tag).join(",")}`);
	console.log(`dry-run=${dryRun}`);
	console.log(`\n--- release notes (${version}) ---\n${notes}`);
}

if (import.meta.main) {
	await main();
}
