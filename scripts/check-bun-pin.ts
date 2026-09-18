#!/usr/bin/env bun
/**
 * check-bun-pin — the tested Bun runtime may only change via a reviewed diff.
 *
 * #148: every workflow called `oven-sh/setup-bun` without `bun-version`, so when
 * Bun 1.4.0 shipped during a six-week gap with no `ci.yml` runs, the next run
 * silently moved 1.3.14 -> 1.4.2 and two HTTP-behavior tests went red with no
 * repository change to point at. A runtime upgrade is a toolchain change; it has
 * to be visible in the PR that introduces it.
 *
 * Asserts:
 *   - `.bun-version` exists and holds one exact version (no ranges, no "latest")
 *   - every `oven-sh/setup-bun` step reads it via `bun-version-file: .bun-version`
 *     — never a literal `bun-version:`, which would drift from the pin
 *
 * Wired into `bun run check`. Exits non-zero on any violation.
 */
import { readFileSync, readdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PIN_FILE = join(ROOT, ".bun-version");
const WORKFLOWS = join(ROOT, ".github", "workflows");

const errors: string[] = [];

// ── The pin itself ──────────────────────────────────────────────────────────
if (!existsSync(PIN_FILE)) {
	errors.push(`  .bun-version: missing — it is the single source of truth for the tested runtime`);
} else {
	const pin = readFileSync(PIN_FILE, "utf-8").trim();
	if (!/^\d+\.\d+\.\d+$/.test(pin)) {
		errors.push(
			`  .bun-version: ${JSON.stringify(pin)} is not an exact x.y.z version — ` +
				`"latest", "canary" and ranges are what #148 exists to prevent`,
		);
	}
}

// ── Every consumer reads the pin ────────────────────────────────────────────
for (const name of readdirSync(WORKFLOWS).sort()) {
	if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
	const lines = readFileSync(join(WORKFLOWS, name), "utf-8").split("\n");

	for (const [i, line] of lines.entries()) {
		if (!/uses:\s*oven-sh\/setup-bun@/.test(line)) continue;
		const where = `  ${name}:${i + 1}`;

		// The step's own block: subsequent lines indented deeper than the `- uses:`.
		const baseIndent = (line.match(/^\s*/)?.[0] ?? "").length;
		const block: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const next = lines[j] ?? "";
			if (next.trim() === "") continue;
			const indent = (next.match(/^\s*/)?.[0] ?? "").length;
			if (indent <= baseIndent) break;
			block.push(next);
		}
		const body = block.join("\n");

		if (/^\s*bun-version:/m.test(body)) {
			errors.push(
				`${where}: pins \`bun-version:\` inline — read \`.bun-version\` via ` +
					`\`bun-version-file: .bun-version\` so one file governs every workflow`,
			);
		} else if (!/^\s*bun-version-file:\s*\.bun-version\s*$/m.test(body)) {
			errors.push(
				`${where}: no \`bun-version-file: .bun-version\` — this step would install ` +
					`whatever Bun is latest at run time (#148)`,
			);
		}
	}
}

if (errors.length > 0) {
	console.error(`check-bun-pin: ${errors.length} violation(s)\n${errors.join("\n")}`);
	process.exit(1);
}
console.log("check-bun-pin: OK");
