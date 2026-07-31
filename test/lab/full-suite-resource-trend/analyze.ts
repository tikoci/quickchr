/**
 * B7 (#76) — fold a sampled full-suite run into the two questions the bite asks.
 *
 *   1. Does per-file cost INFLATE as the suite progresses, or stay flat?
 *   2. Does any OS-level resource climb monotonically across files?
 *
 * Question 1 cannot be answered from local durations alone: the files have wildly
 * different intrinsic cost (provisioning ~510 s vs license ~40 s in CI), so a
 * rising raw duration across the run would just be file ordering. What IS
 * comparable is each file's local duration as a RATIO of the same file's CI
 * duration on a completing platform. If the ratio is flat, per-file cost is
 * position-independent and #76 is not cumulative slowdown. If it climbs with
 * position, later files really are getting more expensive.
 *
 * Usage:
 *   bun test/lab/full-suite-resource-trend/analyze.ts <run-dir>
 */

import { basename } from "node:path";

type Sample = {
	ts: number;
	file: string;
	load1: number;
	pressure: number;
	free_mb: number;
	inactive_mb: number;
	wired_mb: number;
	compressed_mb: number;
	swap_used_mb: number;
	qemu_procs: number;
	qemu_rss_mb: number;
	disk_free_mb: number;
};

/**
 * Full-suite per-file seconds from CI run 30507484030 (`stable`, 12 files), the
 * baseline named in #110's Grounding table. windows-x86 is the reference because
 * it is the slowest platform that COMPLETES, so a local ratio against it says
 * how this laptop compares to a runner that never loses communication.
 *
 * Extracted with:
 *   git show origin/ci-data:runs/30507484030-<platform>-stable.ndjson \
 *     | jq -r 'select(.kind=="test-file")|"\(.file) \(.duration_s) \(.status)"'
 *
 * All 36 records are `pass`. `examples-smoke` is 0 s and `library-api` 1 s on
 * every platform — they self-skip in the integration job, so they carry no
 * timing signal and are excluded from the ratio statistics below.
 */
const CI_REFERENCE_RUN = "30507484030";

const CI_STABLE: Record<string, Record<string, number>> = {
	"windows-x86": {
		"anchor.test.ts": 39,
		"device-mode.test.ts": 254,
		"disk.test.ts": 91,
		"examples-smoke.test.ts": 0,
		"exec.test.ts": 142,
		"file-transfer.test.ts": 51,
		"forward-cli.test.ts": 37,
		"library-api.test.ts": 1,
		"license.test.ts": 38,
		"provisioning.test.ts": 502,
		"settings-secure-login-cli.test.ts": 72,
		"start-stop.test.ts": 376,
	},
	"linux-x86": {
		"anchor.test.ts": 31,
		"device-mode.test.ts": 154,
		"disk.test.ts": 60,
		"examples-smoke.test.ts": 0,
		"exec.test.ts": 117,
		"file-transfer.test.ts": 30,
		"forward-cli.test.ts": 27,
		"library-api.test.ts": 1,
		"license.test.ts": 28,
		"provisioning.test.ts": 370,
		"settings-secure-login-cli.test.ts": 46,
		"start-stop.test.ts": 226,
	},
	"macos-arm64": {
		"anchor.test.ts": 33,
		"device-mode.test.ts": 221,
		"disk.test.ts": 64,
		"examples-smoke.test.ts": 0,
		"exec.test.ts": 105,
		"file-transfer.test.ts": 39,
		"forward-cli.test.ts": 31,
		"library-api.test.ts": 1,
		"license.test.ts": 33,
		"provisioning.test.ts": 448,
		"settings-secure-login-cli.test.ts": 61,
		"start-stop.test.ts": 330,
	},
};

/** Files whose CI duration is ~0 carry no timing signal — they self-skip. */
const NO_SIGNAL = new Set(["examples-smoke.test.ts", "library-api.test.ts"]);

function median(xs: number[]): number {
	if (xs.length === 0) return Number.NaN;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	const hi = s[m] ?? Number.NaN;
	return s.length % 2 ? hi : ((s[m - 1] ?? Number.NaN) + hi) / 2;
}

/** Least-squares slope of y over x. Units: y-units per x-unit. */
function slope(xs: number[], ys: number[]): number {
	const n = xs.length;
	if (n < 2) return Number.NaN;
	const mx = xs.reduce((a, b) => a + b, 0) / n;
	const my = ys.reduce((a, b) => a + b, 0) / n;
	let num = 0;
	let den = 0;
	for (let i = 0; i < n; i++) {
		const dx = (xs[i] ?? 0) - mx;
		num += dx * ((ys[i] ?? 0) - my);
		den += dx ** 2;
	}
	return den === 0 ? Number.NaN : num / den;
}

export function parseTiming(text: string): Array<{ file: string; duration_s: number; status: string }> {
	const out: Array<{ file: string; duration_s: number; status: string }> = [];
	for (const line of text.split("\n")) {
		const m = line.match(/^(\S+)\s+(\d+)s\s+(\S+)$/);
		if (m?.[1] && m[2] && m[3]) out.push({ file: m[1], duration_s: Number(m[2]), status: m[3] });
	}
	return out;
}

export function parseSamples(text: string): Sample[] {
	const out: Sample[] = [];
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		// A sampler tick can be torn if the run is read while a write is in
		// flight. Skipping is correct — inventing a value would be worse.
		try {
			out.push(JSON.parse(t) as Sample);
		} catch {}
	}
	return out;
}

/** Per-file resource summary, using only the samples attributed to that file. */
export function perFile(samples: Sample[], file: string) {
	const s = samples.filter((x) => x.file === file);
	const first = s.at(0);
	const last = s.at(-1);
	if (!first || !last) return undefined;
	// Samples where no QEMU is running are time the file spent NOT exercising a
	// VM — overwhelmingly image/package download. This is the column that
	// separates "this file is slow" from "this file waited on the network", and
	// it is what unmasked provisioning.test.ts as a cold-download artifact
	// rather than cumulative inflation.
	const idle = s.filter((x) => x.qemu_procs === 0).length;
	return {
		samples: s.length,
		idleSamples: idle,
		idleFrac: idle / s.length,
		peakQemuProcs: Math.max(...s.map((x) => x.qemu_procs)),
		endQemuProcs: last.qemu_procs,
		peakQemuRssMb: Math.max(...s.map((x) => x.qemu_rss_mb)),
		medLoad: median(s.map((x) => x.load1)),
		maxPressure: Math.max(...s.map((x) => x.pressure)),
		endFreeMb: last.free_mb,
		endCompressedMb: last.compressed_mb,
		deltaCompressedMb: last.compressed_mb - first.compressed_mb,
		endSwapMb: last.swap_used_mb,
		endDiskFreeMb: last.disk_free_mb,
		deltaDiskFreeMb: last.disk_free_mb - first.disk_free_mb,
	};
}

async function main() {
	const dir = process.argv[2];
	if (!dir) {
		console.error("usage: bun analyze.ts <run-dir>");
		process.exit(2);
	}

	const timing = parseTiming(await Bun.file(`${dir}/timing.txt`).text());
	const samples = parseSamples(await Bun.file(`${dir}/samples.ndjson`).text());
	const host = await Bun.file(`${dir}/host.txt`).text();

	console.log(`# B7 full-suite resource trend — ${basename(dir)}\n`);
	console.log("```text");
	console.log(host.trim());
	console.log("```\n");

	const total = timing.reduce((a, t) => a + t.duration_s, 0);
	const firstSample = samples.at(0);
	const lastSample = samples.at(-1);
	const wall = firstSample && lastSample ? lastSample.ts - firstSample.ts : 0;
	console.log(
		`**${timing.length} files, ${total} s of test time (${(total / 60).toFixed(1)} min), ` +
			`${wall} s wall (${(wall / 60).toFixed(1)} min), ` +
			`${timing.filter((t) => t.status === "fail").length} failed.**\n`,
	);

	console.log("## Per-file cost and resource state at file exit\n");
	console.log(
		"| # | file | s | status | peak QEMU | QEMU at exit | med load | free MB | compressed MB | Δ compressed | swap MB | disk free MB | Δ disk |",
	);
	console.log("|--:|---|--:|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
	timing.forEach((t, i) => {
		const r = perFile(samples, t.file);
		if (!r) {
			console.log(`| ${i + 1} | \`${t.file}\` | ${t.duration_s} | ${t.status} | — | — | — | — | — | — | — | — | — |`);
			return;
		}
		console.log(
			`| ${i + 1} | \`${t.file}\` | ${t.duration_s} | ${t.status} | ${r.peakQemuProcs} | ${r.endQemuProcs} | ` +
				`${r.medLoad.toFixed(1)} | ${r.endFreeMb} | ${r.endCompressedMb} | ${r.deltaCompressedMb >= 0 ? "+" : ""}${r.deltaCompressedMb} | ` +
				`${r.endSwapMb} | ${r.endDiskFreeMb} | ${r.deltaDiskFreeMb >= 0 ? "+" : ""}${r.deltaDiskFreeMb} |`,
		);
	});

	console.log("\n## Monotonic-climb check (question 2)\n");
	const t0 = samples[0]?.ts ?? 0;
	const xs = samples.map((s) => (s.ts - t0) / 60);
	const metrics: Array<[string, (s: Sample) => number, string]> = [
		["free_mb", (s) => s.free_mb, "MB/min"],
		["compressed_mb", (s) => s.compressed_mb, "MB/min"],
		["swap_used_mb", (s) => s.swap_used_mb, "MB/min"],
		["wired_mb", (s) => s.wired_mb, "MB/min"],
		["disk_free_mb", (s) => s.disk_free_mb, "MB/min"],
		["qemu_procs", (s) => s.qemu_procs, "procs/min"],
	];
	console.log("| metric | first | last | net | slope |");
	console.log("|---|--:|--:|--:|--:|");
	for (const [name, get, unit] of metrics) {
		const ys = samples.map(get);
		const first = ys[0] ?? Number.NaN;
		const last = ys[ys.length - 1] ?? Number.NaN;
		const k = slope(xs, ys);
		console.log(
			`| \`${name}\` | ${first} | ${last} | ${last - first >= 0 ? "+" : ""}${(last - first).toFixed(0)} | ${k.toFixed(2)} ${unit} |`,
		);
	}

	// The single most direct #76 mechanism: a QEMU process surviving its own file
	// and burning CPU inside every subsequent file's environment.
	//
	// Detect it by PEAK CONCURRENCY, not by the process count in the last sample
	// of a file. The marker only advances when the NEXT file starts, so a file's
	// final sample is taken while its own QEMU is legitimately still running —
	// reading that as "exited with 1 orphan" would report a leak for every file.
	// Peak has no such blind spot: the suite boots one CHR at a time, so any file
	// observing 2+ concurrent QEMU processes is seeing a predecessor's orphan
	// alongside its own. This works whether or not samples land in the gaps.
	const concurrent = timing
		.map((t) => ({ t, r: perFile(samples, t.file) }))
		.filter((x) => (x.r?.peakQemuProcs ?? 0) > 1);
	const tail = samples.filter((s) => s.file === "(done)");
	console.log("\n## Orphaned QEMU (peak concurrency > 1)\n");
	if (concurrent.length === 0) {
		console.log(
			"None — no file ever observed more than one concurrent `qemu-system` process, " +
				"so no file leaked QEMU into its successor's environment.\n",
		);
	} else {
		for (const l of concurrent) {
			console.log(`- \`${l.t.file}\` saw **${l.r?.peakQemuProcs}** concurrent QEMU processes — a predecessor leaked.`);
		}
		console.log("");
	}
	if (tail.length > 0) {
		const t = tail[tail.length - 1];
		console.log(`Post-suite settled sample: **${t?.qemu_procs} QEMU process(es)**, ${t?.free_mb} MB free, ${t?.compressed_mb} MB compressed.\n`);
	}

	console.log(`\n## Position-vs-cost (question 1)\n`);
	console.log(
		`Raw local duration cannot answer this directly — the files differ intrinsically. ` +
			`Each file's local seconds are shown as a ratio against the same file on the CI platforms ` +
			`that COMPLETE the full suite (run ${CI_REFERENCE_RUN}, \`stable\`). A **flat** ratio down the ` +
			`column means per-file cost is position-independent, so a 60-minute macos-x86 suite is not ` +
			`explained by later files getting slower. A **rising** ratio means real cumulative inflation.\n`,
	);
	console.log(
		`\`no-VM s\` is time the file spent with zero QEMU processes — effectively image/package ` +
			`download. \`VM s\` subtracts it, and \`vs win (VM)\` is the ratio that actually compares ` +
			`compute cost rather than network luck. Both are shown because the raw ratio is what a ` +
			`CI budget has to survive, while the VM-only ratio is what a resource hypothesis rests on.\n`,
	);
	const plats = Object.keys(CI_STABLE);
	console.log(`| # | file | local s | no-VM s | VM s | ${plats.map((p) => `vs ${p}`).join(" | ")} | vs win (VM) |`);
	console.log(`|--:|---|--:|--:|--:|${plats.map(() => "--:").join("|")}|--:|`);
	const ratioPos: number[] = [];
	const ratioVal: number[] = [];
	const vmRatioVal: number[] = [];
	timing.forEach((t, i) => {
		const r = perFile(samples, t.file);
		const noVm = r ? Math.round(r.idleFrac * t.duration_s) : 0;
		const vm = t.duration_s - noVm;
		const cells = plats.map((p) => {
			const ref = CI_STABLE[p]?.[t.file];
			if (!ref || NO_SIGNAL.has(t.file)) return "—";
			const ratio = t.duration_s / ref;
			if (p === "windows-x86") {
				ratioPos.push(i + 1);
				ratioVal.push(ratio);
			}
			return `${ratio.toFixed(2)}×`;
		});
		const winRef = CI_STABLE["windows-x86"]?.[t.file];
		let vmCell = "—";
		if (winRef && !NO_SIGNAL.has(t.file)) {
			const vr = vm / winRef;
			vmRatioVal.push(vr);
			vmCell = `${vr.toFixed(2)}×`;
		}
		console.log(`| ${i + 1} | \`${t.file}\` | ${t.duration_s} | ${noVm} | ${vm} | ${cells.join(" | ")} | ${vmCell} |`);
	});

	if (ratioVal.length >= 2) {
		const fmt = (vals: number[], label: string) => {
			const k = slope(ratioPos, vals);
			return (
				`- **${label}**: median ${median(vals).toFixed(2)}×, ` +
				`range ${Math.min(...vals).toFixed(2)}×–${Math.max(...vals).toFixed(2)}×, ` +
				`slope vs position **${k >= 0 ? "+" : ""}${k.toFixed(3)}× per file**`
			);
		};
		console.log(`\nAgainst windows-x86 (${ratioVal.length} files with timing signal):\n`);
		console.log(fmt(ratioVal, "raw"));
		if (vmRatioVal.length === ratioVal.length) console.log(fmt(vmRatioVal, "VM-only (download excluded)"));
		console.log(
			`\nA slope near zero means per-file cost does not depend on how late the file runs — ` +
				`i.e. no cumulative inflation, which is the hypothesis B7 exists to test.\n`,
		);
	}

	// The suite's own projection for macos-x86. #110's Grounding estimated
	// 27–32 min by naive scaling from a single filtered file; this replaces that
	// estimate with a measured 12-file total on Intel/HVF.
	const winTotal = Object.values(CI_STABLE["windows-x86"] ?? {}).reduce((a, b) => a + b, 0);
	console.log(
		`For reference, the same 12 files total **${winTotal} s (${(winTotal / 60).toFixed(1)} min)** on windows-x86, ` +
			`which completes its job. Local total here is ${total} s (${(total / 60).toFixed(1)} min).\n`,
	);
}

if (import.meta.main) await main();
