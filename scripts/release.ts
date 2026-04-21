#!/usr/bin/env bun
/**
 * Release script — creates an annotated git tag and pushes it to trigger publish.yml.
 *
 * Usage: bun run release
 *
 * Pre-release detection: version with odd minor (0.1.x, 0.3.x) → npm tag "next"
 *                        version with even minor (0.2.x, 0.4.x) → npm tag "latest"
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pkgPath = join(import.meta.dir, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const version: string = pkg.version;
const tag = `v${version}`;

function run(...cmd: string[]): { out: string; ok: boolean } {
	const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
	return { out: new TextDecoder().decode(r.stdout).trim(), ok: r.exitCode === 0 };
}

// Validate version format
if (!/^\d+\.\d+\.\d+$/.test(version)) {
	console.error(`Error: invalid version in package.json: "${version}" — expected X.Y.Z`);
	process.exit(1);
}

// Git must be clean
const { out: dirty } = run("git", "status", "--porcelain");
if (dirty) {
	console.error("Error: git working tree is not clean. Commit or stash changes first.");
	process.exit(1);
}

// Warn if not on main
const { out: branch } = run("git", "rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") {
	console.warn(`Warning: releasing from branch '${branch}', not 'main'.`);
	console.warn("Sleeping 3s — Ctrl-C to abort.");
	await Bun.sleep(3000);
}

// Tag must not already exist
const { out: existingTag } = run("git", "tag", "-l", tag);
if (existingTag === tag) {
	console.error(`Error: tag ${tag} already exists. Bump version in package.json first.`);
	process.exit(1);
}

// Determine npm publish track from version minor
const minor = parseInt(version.split(".")[1] ?? "0", 10);
const isPreRelease = minor % 2 !== 0;
const npmTag = isPreRelease ? "next" : "latest";

console.log(`
  Version : ${version}
  Git tag : ${tag}
  npm tag : ${npmTag}  (${isPreRelease ? "pre-release — odd minor" : "stable release — even minor"})
  Branch  : ${branch}
`);

// Create annotated tag
const { ok: tagCreated } = run("git", "tag", "-a", tag, "-m", `Release ${tag}`);
if (!tagCreated) {
	console.error("Error: failed to create git tag.");
	process.exit(1);
}

// Push tag (rolls back local tag on failure)
console.log(`Pushing ${tag} to origin...`);
const pushResult = Bun.spawnSync(["git", "push", "origin", tag], {
	stdout: "inherit",
	stderr: "inherit",
});
if (pushResult.exitCode !== 0) {
	run("git", "tag", "-d", tag);
	console.error("Error: failed to push tag. Local tag removed.");
	process.exit(1);
}

console.log(`\n✓ ${tag} pushed — publish workflow starting.`);
console.log("  https://github.com/tikoci/quickchr/actions/workflows/publish.yml");
console.log("  Monitor: gh run watch --repo tikoci/quickchr");
