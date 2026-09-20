#!/usr/bin/env bun
/**
 * validate-network-specifiers — every `--add-network <spec>` printed in the docs has
 * to be a string the parser accepts.
 *
 * `MANUAL.md` and `docs/networking-recipes.md` listed `socket-listen:<port>` /
 * `socket-connect:<port>` / `socket-mcast:<group>:<port>` in their specifier tables.
 * Those are the internal `NetworkSpecifier` *type* names; the CLI takes
 * `socket:listen:<port>`. An external agent building a 3-CHR lab lost a debugging
 * cycle to the difference, and the table read as authoritative precisely because the
 * TS examples beside it were right (#157).
 *
 * Two lists of the same vocabulary drift, so this check removes one of them: the docs
 * are parsed through `parseNetworkSpecifier` itself.
 *
 * Wired into `bun run check`. Exits non-zero on any violation.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

import { parseNetworkSpecifier } from "../src/lib/network.ts";

const ROOT = resolve(import.meta.dir, "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "__pycache__"]);

/** Placeholders a doc uses in a syntax template rather than a runnable value. */
const PLACEHOLDER = /<[^>]+>|\{[^}]+\}|\.\.\.|…/;

/** A doc block describing syntax that does not exist yet opts out explicitly:
 *
 *      <!-- specifier-lint: skip — reason -->
 *
 *  It covers the rest of the markdown section it sits in (up to the next heading of
 *  the same or higher level), and the reason is required so the exemption is
 *  reviewable rather than a silent hole. */
const SKIP_MARKER = /<!--\s*specifier-lint:\s*skip\s*(?:[-—]\s*(.+?))?\s*-->/;

const errors: string[] = [];

/** Line numbers covered by a `specifier-lint: skip` marker. */
/** Markdown heading level per line, or 0. Fence-aware: a shell comment inside a
 *  ```sh block (`# macOS — shared NAT`) is not an H1, and reading it as one cut a
 *  skip region short. */
function headingLevels(lines: string[]): number[] {
	const levels: number[] = [];
	let inFence = false;
	for (const raw of lines) {
		const line = raw ?? "";
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			levels.push(0);
			continue;
		}
		const heading = inFence ? null : /^(#{1,6})\s/.exec(line);
		levels.push(heading ? (heading[1]?.length ?? 0) : 0);
	}
	return levels;
}

function skippedLines(lines: string[]): Set<number> {
	const skipped = new Set<number>();
	const levels = headingLevels(lines);
	for (let i = 0; i < lines.length; i++) {
		const marker = SKIP_MARKER.exec(lines[i] ?? "");
		if (!marker) continue;
		if (!marker[1]?.trim()) {
			errors.push(`  line ${i + 1}: 'specifier-lint: skip' needs a reason after a dash`);
		}
		// Find the heading the marker sits under, then skip to the next heading at that
		// level or higher.
		let level = 0;
		for (let back = i; back >= 0; back--) {
			if (levels[back]) { level = levels[back] as number; break; }
		}
		for (let j = i; j < lines.length; j++) {
			if (j > i && levels[j] && (levels[j] as number) <= level) break;
			skipped.add(j + 1);
		}
	}
	return skipped;
}

function markdownFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") && entry.name !== ".github") continue;
		if (SKIP_DIRS.has(entry.name)) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) markdownFiles(full, out);
		else if (extname(entry.name) === ".md" && statSync(full).isFile()) out.push(full);
	}
	return out;
}

/** Every specifier a doc presents as a CLI value.
 *
 *  Both the flag form (`--add-network socket:listen:5000`) and the bare table-cell
 *  form (a row whose first cell is a specifier in backticks) — the table is where the
 *  wrong spelling actually lived. */
function specifiersIn(text: string): Array<{ spec: string; line: number }> {
	const found: Array<{ spec: string; line: number }> = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		for (const m of line.matchAll(/--add-network[= ]+["']?([^\s"'`|,)]+)/g)) {
			if (m[1]) found.push({ spec: m[1], line: i + 1 });
		}
		// A table row documenting the vocabulary: `| \`socket:listen:<port>\` | ... |`
		//
		// Only a cell that *asserts a CLI spelling* counts: one carrying a colon
		// (`socket:listen:<port>`, and the wrong `socket-listen:<port>` this exists to
		// catch) or one of the bare word specifiers. A `socket-connect` in backticks with
		// no colon is prose naming the TS type, which is correct usage and not a claim
		// about what the CLI accepts.
		if (/^\s*\|/.test(line)) {
			for (const m of line.matchAll(/`([a-z][a-z0-9-]*:[^`]*|user|shared|vmnet-shared)`/g)) {
				const cell = m[1] ?? "";
				if (!/^(user|shared|vmnet-shared|socket|tap|bridged|vmnet-bridged)[:-]?/.test(cell)) continue;
				found.push({ spec: cell, line: i + 1 });
			}
		}
	}
	return found;
}

/** Substitute a placeholder template with values so the *shape* can be parsed.
 *  Returns undefined when the template is not a specifier we can fill in. */
function fillPlaceholders(spec: string): string {
	return spec
		.replace(/<(?:group|addr|address)>/g, "230.0.0.1")
		.replace(/<(?:port|n)>/g, "4000")
		.replace(/<(?:name|iface|ifname|interface)>/g, "lab");
}

for (const file of markdownFiles(ROOT)) {
	const rel = relative(ROOT, file);
	const text = readFileSync(file, "utf-8");
	const skipped = skippedLines(text.split("\n"));
	for (const { spec, line } of specifiersIn(text)) {
		if (skipped.has(line)) continue;
		const candidate = PLACEHOLDER.test(spec) ? fillPlaceholders(spec) : spec;
		if (PLACEHOLDER.test(candidate)) continue; // a template we cannot fill — not a claim about syntax
		try {
			parseNetworkSpecifier(candidate);
		} catch (e) {
			const why = e instanceof Error ? e.message : String(e);
			errors.push(`  ${rel}:${line}: "${spec}" is not a specifier the CLI accepts — ${why}`);
		}
	}
}

if (errors.length > 0) {
	console.error(`Network specifiers in docs that the parser rejects (${errors.length}):`);
	for (const e of errors) console.error(e);
	console.error("\nThese are CLI strings, not `NetworkSpecifier` type names.");
	process.exit(1);
}

console.log("Network specifiers in docs: all parse.");
