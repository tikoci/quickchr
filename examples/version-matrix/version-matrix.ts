#!/usr/bin/env bun
/**
 * version-matrix — boot one CHR per RouterOS channel in parallel and compare them
 *
 * Starts long-term / stable / testing / development side by side (host-native
 * arch), installs an extra package on each, prints a version + package matrix, and
 * diffs each router's `:export` to surface config drift across versions. The shape
 * tikoci/restraml uses to extract a full per-version schema. *(Formerly `matrica`.)*
 *
 * Set VERSION_MATRIX_LITE=1 for the 2-channel (long-term + stable) CI variant.
 *
 * Run:  bun run examples/version-matrix/version-matrix.ts
 *       VERSION_MATRIX_LITE=1 bun run examples/version-matrix/version-matrix.ts
 * Time: ~90 s wall (HVF/KVM, parallel); minutes under TCG — use LITE on x86 CI.
 */
import { join } from "node:path";
import type { Channel } from "../../src/index.ts";
import { QuickCHR } from "../../src/index.ts";
import { check, runExample } from "../lib.ts";

const LITE = !!process.env.VERSION_MATRIX_LITE;
const CHANNELS: Channel[] = LITE
	? ["long-term", "stable"]
	: ["long-term", "stable", "testing", "development"];
// container is on both arches; zerotier is arm64-only (added when host is arm64).
const PACKAGES = process.arch === "arm64" ? ["zerotier", "container"] : ["container"];

if (import.meta.main) {
	await runExample(async (track) => {
		const pid = process.pid.toString(36);

		// Distinct port bases keep parallel starts from racing for the same block.
		// Zip the channel into each handle so we never index back by position.
		const started = await Promise.all(
			CHANNELS.map((channel, i) =>
				QuickCHR.start({
					name: `examples-vm-${channel.replace("-", "")}-${pid}`,
					channel,
					portBase: 9200 + i * 10,
					packages: PACKAGES,
					secureLogin: true, // real creds so upload() below can authenticate
					mem: 256,
				}).then((chr) => ({ channel, chr: track(chr) })),
			),
		);
		check(started.length === CHANNELS.length, "all channels should start");

		// Version + package matrix.
		const rows = await Promise.all(
			started.map(async ({ channel, chr }) => {
				const res = (await chr.rest("/system/resource")) as Record<string, string>;
				const pkgs = (await chr.rest("/system/package")) as Array<Record<string, string>>;
				const active = pkgs
					.filter((p) => p.disabled !== "true")
					.map((p) => p.name)
					.filter((n): n is string => typeof n === "string");
				check(active.includes("container"), `container should be active on ${channel}`);
				return {
					channel,
					version: res.version,
					extras: active.filter((n) => !["routeros", "system"].includes(n)),
				};
			}),
		);
		console.log("\nRouterOS version matrix:");
		for (const r of rows) {
			console.log(`  ${r.channel.padEnd(12)} → ${r.version}  [${r.extras.join(", ")}]`);
		}

		// Demonstrate ChrInstance.upload() (best-effort — the CLI has no file-transfer
		// command, so version-matrix.py can't do this; see the README's "friction found").
		const first = started[0];
		if (first) {
			try {
				const cfg = join(import.meta.dir, "config", "rb5009-arm64.rsc");
				await first.chr.upload(cfg, "/rb5009-arm64.rsc");
				const files = (await first.chr.rest("/file")) as Array<Record<string, string>>;
				if (files.some((f) => (f.name ?? "").includes("rb5009-arm64.rsc"))) {
					console.log(`  uploaded sample config to ${first.channel} via ChrInstance.upload()`);
				}
			} catch (e) {
				console.warn(`  [warn] upload() demo skipped: ${e instanceof Error ? e.message : e}`);
			}
		}

		// Config drift: diff each router's default :export against the baseline channel.
		const exports = await Promise.all(
			started.map(async ({ channel, chr }) => ({ channel, text: (await chr.exec(":export")).output })),
		);
		const norm = (s: string) =>
			new Set(s.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
		const baseline = exports[0];
		if (baseline) {
			const base = norm(baseline.text);
			console.log("\nConfig drift (default :export across versions):");
			for (const e of exports.slice(1)) {
				const cur = norm(e.text);
				const added = [...cur].filter((l) => !base.has(l)).length;
				const removed = [...base].filter((l) => !cur.has(l)).length;
				console.log(
					`  ${baseline.channel} → ${e.channel}: ${added || removed ? `+${added} / -${removed} lines` : "identical"}`,
				);
			}
		}
	});
}
