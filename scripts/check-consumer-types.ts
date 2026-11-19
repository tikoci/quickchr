#!/usr/bin/env bun
/**
 * check-consumer-types — a strict consumer can type-check quickchr's library.
 *
 * #285: quickchr publishes its `.ts` source, not `.d.ts` files, so a consumer's
 * `tsc` checks quickchr's own code under the *consumer's* compiler flags, and
 * `skipLibCheck` does not help (it skips only `.d.ts` files). A tikoci repo on
 * the house tsconfig (tikoci-linting's tsconfig.example.json) hit 84 errors in
 * quickchr's source from `exactOptionalPropertyTypes` alone, while quickchr's
 * own `tsc` was clean because its tsconfig did not set that flag.
 *
 * This packs the package exactly as `npm publish` would, installs the tarball
 * into a throwaway consumer whose tsconfig is the house template (kept here, not
 * read from quickchr's tsconfig, so loosening quickchr's flags fails this check),
 * and type-checks a file that imports the public entry point.
 *
 * Offline: the package's runtime `dependencies`, `@types/bun` and `tsc` come
 * from this repo's node_modules (symlinked). Wired into `bun run check`. Exits
 * non-zero on any error.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

// tikoci-linting's tsconfig.example.json compilerOptions, as of 2026-11-18.
// Update it when the house template changes; quickchr's tsconfig.json follows it.
const HOUSE_COMPILER_OPTIONS = {
	lib: ["ESNext"],
	target: "ESNext",
	module: "Preserve",
	moduleResolution: "bundler",
	moduleDetection: "force",
	types: ["bun"],
	allowImportingTsExtensions: true,
	verbatimModuleSyntax: true,
	noEmit: true,
	skipLibCheck: true,
	strict: true,
	noUncheckedIndexedAccess: true,
	exactOptionalPropertyTypes: true,
	noImplicitReturns: true,
	noImplicitOverride: true,
	noFallthroughCasesInSwitch: true,
	noUncheckedSideEffectImports: true,
	erasableSyntaxOnly: true,
	noUnusedLocals: false,
	noUnusedParameters: false,
	noPropertyAccessFromIndexSignature: false,
};

// Imports the whole public surface, and passes possibly-undefined values into
// public option types, as a strict caller forwarding its own options would.
const CONSUMER_SOURCE = `import * as quickchr from "@tikoci/quickchr";
import { defaultBootTimeout, QuickCHR, type Channel, type StartOptions } from "@tikoci/quickchr";

export { quickchr };

const channel = process.env.CHANNEL as Channel | undefined;
const extra = process.env.EXTRA === undefined ? undefined : Number(process.env.EXTRA);
export const options: StartOptions = { channel, timeoutExtra: extra, name: undefined };
export const budgetMs: number = defaultBootTimeout("x86") + (extra ?? 0);
export const start = () => QuickCHR.start(options);
`;

function run(cmd: string[], cwd: string): { ok: boolean; out: string } {
	const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	return { ok: p.exitCode === 0, out: `${p.stdout.toString()}${p.stderr.toString()}`.trim() };
}

const work = mkdtempSync(join(tmpdir(), "quickchr-consumer-"));
let failed = false;
try {
	const pack = run(["bun", "pm", "pack", "--quiet", "--ignore-scripts", "--destination", work], ROOT);
	const tarball = pack.out.split("\n").map((l) => l.trim()).filter((l) => l.endsWith(".tgz")).pop();
	if (!pack.ok || !tarball) throw new Error(`bun pm pack failed:\n${pack.out}`);

	const pkgDir = join(work, "node_modules", "@tikoci", "quickchr");
	mkdirSync(pkgDir, { recursive: true });
	const tarPath = tarball.startsWith("/") ? tarball : join(work, tarball);
	const extract = run(["tar", "-xzf", tarPath, "-C", pkgDir, "--strip-components=1"], work);
	if (!extract.ok) throw new Error(`tar failed:\n${extract.out}`);

	const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
	for (const dep of [...Object.keys(manifest.dependencies ?? {}), "@types/bun", "bun-types"]) {
		const link = join(work, "node_modules", dep);
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(join(ROOT, "node_modules", dep), link, "dir");
	}

	writeFileSync(join(work, "package.json"), JSON.stringify({ name: "quickchr-consumer", private: true, type: "module" }));
	writeFileSync(join(work, "tsconfig.json"), JSON.stringify({ compilerOptions: HOUSE_COMPILER_OPTIONS, include: ["index.ts"] }, null, 2));
	writeFileSync(join(work, "index.ts"), CONSUMER_SOURCE);

	const tsc = run([join(ROOT, "node_modules", ".bin", "tsc"), "-p", "."], work);
	if (!tsc.ok) {
		failed = true;
		console.error("check-consumer-types: a consumer on the house tsconfig cannot type-check quickchr (#285):\n");
		console.error(tsc.out);
		console.error("\nFix quickchr's source, not this check: for exactOptionalPropertyTypes, widen the optional property to `T | undefined`.");
	} else {
		console.log("check-consumer-types: packed quickchr type-checks under the house tsconfig");
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
