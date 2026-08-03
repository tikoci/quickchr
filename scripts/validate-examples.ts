#!/usr/bin/env bun
/**
 * validate-examples — cheap convention + drift checker for examples/ (no QEMU).
 *
 * Asserts, for each examples/<name>/:
 *   - a README.md and a primary script (<name>.ts or <name>.test.ts) exist
 *   - no Makefile / stray files (only .ts/.test.ts/.sh/.ps1/.py/.md + known subdirs)
 *   - the primary script is named after its directory
 *   - every relative link and run-command file reference in the README resolves
 *   - each .ps1 sets $ErrorActionPreference before dot-sourcing common.ps1
 *
 * Wired into `bun run check`. Exits non-zero on any violation.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const EXAMPLES = resolve(import.meta.dir, "..", "examples");
const ALLOWED_EXT = new Set([".ts", ".sh", ".ps1", ".py", ".md"]);
const SKIP_DIRS = new Set(["_template", "config", "tool", "node_modules"]);
// (Top-level files like README.md / lib.ts / common.sh are skipped implicitly:
// the dir scan below only descends into directories, never stat's loose files.)

const errors: string[] = [];
const err = (where: string, msg: string) => errors.push(`  ${where}: ${msg}`);

function fileExt(name: string): string {
	const i = name.lastIndexOf(".");
	return i < 0 ? "" : name.slice(i);
}

/** Collect every relative file reference in a README: markdown links + run cmds. */
function referencedPaths(readme: string): string[] {
	const refs = new Set<string>();
	// Markdown links: [text](./x) or (../x) — skip http(s) and pure anchors.
	for (const m of readme.matchAll(/\]\(([^)]+)\)/g)) {
		const target = (m[1] ?? "").split("#")[0]?.trim() ?? "";
		if (!target || /^https?:\/\//.test(target) || target.startsWith("mailto:")) continue;
		if (target.startsWith("./") || target.startsWith("../")) refs.add(target);
	}
	// Run commands: bun run <f>, sh <f>, pwsh <f>, uv run <f> with a script path.
	for (const m of readme.matchAll(/(?:bun run|uv run|^\s*sh|pwsh)\s+([\w./-]+\.(?:ts|sh|ps1|py))/gm)) {
		if (m[1]) refs.add(m[1]);
	}
	return [...refs];
}

const entries = readdirSync(EXAMPLES);
const dirs = entries.filter((e) => {
	const p = join(EXAMPLES, e);
	return statSync(p).isDirectory() && !SKIP_DIRS.has(e) && !e.startsWith(".");
});

if (!existsSync(join(EXAMPLES, "README.md"))) err("examples/", "missing top-level README.md");
if (!existsSync(join(EXAMPLES, "COVERAGE.md"))) err("examples/", "missing COVERAGE.md");

for (const name of dirs) {
	const dir = join(EXAMPLES, name);
	const where = `examples/${name}`;
	const files = readdirSync(dir);

	// README + primary script.
	if (!files.includes("README.md")) err(where, "missing README.md");
	const hasPrimary = files.includes(`${name}.ts`) || files.includes(`${name}.test.ts`);
	if (!hasPrimary) err(where, `missing primary script ${name}.ts (or ${name}.test.ts)`);

	for (const f of files) {
		const p = join(dir, f);
		if (statSync(p).isDirectory()) {
			if (!SKIP_DIRS.has(f)) err(where, `unexpected subdir "${f}/" (allowed: config/, tool/)`);
			continue;
		}
		if (f === "Makefile") err(where, "Makefile is not allowed — use <name>.sh / <name>.ps1");
		if (f === ".DS_Store") continue;
		const ext = fileExt(f);
		if (!ALLOWED_EXT.has(ext)) err(where, `unexpected file "${f}" (allowed: .ts/.sh/.ps1/.py/.md)`);
		// Script files should be named after the directory (or be the test).
		if ([".ts", ".sh", ".ps1", ".py"].includes(ext)) {
			const base = f.replace(/\.(test\.)?(ts|sh|ps1|py)$/, "");
			if (base !== name) err(where, `script "${f}" should be named "${name}${ext}"`);
		}
	}

	// PowerShell examples must arm $ErrorActionPreference themselves, BEFORE
	// dot-sourcing common.ps1. A common.ps1 that fails to load leaves the
	// preference at 'Continue', so every undefined helper is a non-terminating
	// error and the example exits 0 having run no quickchr command at all — the
	// false green in #102, reproduced locally 2026-08-03 (pwsh 7.4.6: rc=0 without
	// the guard, rc=1 with it).
	for (const f of files.filter((x) => x.endsWith(".ps1"))) {
		const lines = readFileSync(join(dir, f), "utf8").split(/\r?\n/);
		const dotSource = lines.findIndex((l) => /^\s*\.\s+["']\$PSScriptRoot/.test(l));
		if (dotSource < 0) continue; // self-contained script, nothing to guard against
		const armed = lines
			.slice(0, dotSource)
			.some((l) => /^\s*\$ErrorActionPreference\s*=\s*'Stop'/.test(l));
		if (!armed) {
			err(where, `"${f}" must set $ErrorActionPreference = 'Stop' BEFORE dot-sourcing common.ps1`);
		}
	}

	// README references resolve.
	const readmePath = join(dir, "README.md");
	if (existsSync(readmePath)) {
		const readme = require("node:fs").readFileSync(readmePath, "utf8") as string;
		for (const ref of referencedPaths(readme)) {
			if (!existsSync(resolve(dir, ref))) err(where, `README references missing path "${ref}"`);
		}
	}
}

if (errors.length) {
	console.error(`✗ validate-examples: ${errors.length} issue(s):\n${errors.join("\n")}`);
	process.exit(1);
}
console.log(`✓ validate-examples: ${dirs.length} examples conform to the convention`);
