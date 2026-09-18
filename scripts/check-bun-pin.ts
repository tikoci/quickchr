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
 *     in that step's own `with:` mapping — never a literal `bun-version:`, which
 *     would drift from the pin
 *   - `actions/checkout` precedes `setup-bun` in the job, or the pin file is not
 *     on disk yet when the action reads it
 *
 * The workflows are YAML-parsed rather than scanned line by line: an indentation
 * scan accepts `bun-version-file` sitting under `env:` (where setup-bun never
 * sees it) and is defeated by ordinary reformatting, such as a flow mapping.
 *
 * Wired into `bun run check`. Exits non-zero on any violation.
 */
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PIN_FILE = join(ROOT, ".bun-version");
const WORKFLOWS = join(ROOT, ".github", "workflows");
const SETUP_BUN = "oven-sh/setup-bun@";

interface Step {
	uses?: unknown;
	with?: Record<string, unknown>;
}

const errors: string[] = [];

// ── The pin itself ──────────────────────────────────────────────────────────
const pinFile = Bun.file(PIN_FILE);
if (!(await pinFile.exists())) {
	errors.push("  .bun-version: missing — it is the single source of truth for the tested runtime");
} else {
	const pin = (await pinFile.text()).trim();
	if (!/^\d+\.\d+\.\d+$/.test(pin)) {
		errors.push(
			`  .bun-version: ${JSON.stringify(pin)} is not an exact x.y.z version — ` +
				`"latest", "canary" and ranges are what #148 exists to prevent`,
		);
	}
}

// ── Every consumer reads the pin, from its own `with:` ──────────────────────
for (const name of readdirSync(WORKFLOWS).sort()) {
	if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;

	let workflow: { jobs?: Record<string, { steps?: Step[] }> };
	try {
		workflow = Bun.YAML.parse(await Bun.file(join(WORKFLOWS, name)).text()) as typeof workflow;
	} catch (error) {
		errors.push(`  ${name}: could not be parsed as YAML — ${error instanceof Error ? error.message : error}`);
		continue;
	}

	for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
		const where = `  ${name} / ${jobName}`;
		let checkedOut = false;

		for (const step of job?.steps ?? []) {
			const uses = typeof step?.uses === "string" ? step.uses : "";
			if (uses.includes("actions/checkout")) checkedOut = true;
			if (!uses.includes(SETUP_BUN)) continue;

			// `with` is the only mapping setup-bun receives. A key anywhere else in
			// the step (notably `env:`) is invisible to the action.
			const inputs = step.with ?? {};

			if ("bun-version" in inputs) {
				errors.push(
					`${where}: pins \`bun-version:\` inline — read \`.bun-version\` via ` +
						`\`bun-version-file: .bun-version\` so one file governs every workflow`,
				);
			} else if (inputs["bun-version-file"] !== ".bun-version") {
				errors.push(
					`${where}: \`with.bun-version-file\` is ${JSON.stringify(inputs["bun-version-file"] ?? null)}, ` +
						`expected ".bun-version" — otherwise this step installs whatever Bun is latest at run time (#148)`,
				);
			}

			if (!checkedOut) {
				errors.push(
					`${where}: \`setup-bun\` runs before \`actions/checkout\`, so \`.bun-version\` ` +
						`is not on disk when the action reads it`,
				);
			}
		}
	}
}

if (errors.length > 0) {
	console.error(`check-bun-pin: ${errors.length} violation(s)\n${errors.join("\n")}`);
	process.exit(1);
}
console.log("check-bun-pin: OK");
