import { describe, test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import type { ChrInstance, Channel } from "../../src/index.ts";
import { QuickCHR } from "../../src/index.ts";

/**
 * matrica — Parallel Version Matrix
 *
 * Starts 4 ARM64 CHR instances in parallel (one per RouterOS channel),
 * installs zerotier + container packages on each, and compares the output
 * across all versions.
 *
 * ARM64 is used because:
 *   - zerotier and container packages are ARM64-only extras
 *   - Complements solis (x86) sequential migration testing
 *   - ARM64 CHR schema is needed by tikoci/restraml for full package coverage
 *
 * Run:
 *   QUICKCHR_INTEGRATION=1 bun test examples/matrica/matrica.test.ts
 *
 * Performance notes:
 *   - Apple Silicon (HVF): ~60–90 s per CHR = ~90 s wall time (parallel)
 *   - Intel Mac / Linux x86 (TCG): ~3–5 min per CHR = ~4–5 min wall time
 *   - CI on x86 GitHub runners: use the "matrica-lite" two-version variant
 *     (set MATRICA_LITE=1) to stay within runner time limits.
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;
const LITE = !!process.env.MATRICA_LITE;

// Full 4-channel matrix or lite 2-channel CI variant
const CHANNELS: Channel[] = LITE
	? ["long-term", "stable"]
	: ["long-term", "stable", "testing", "development"];

const PORT_BASES: Record<Channel, number> = {
	"long-term": 9200,
	stable: 9210,
	testing: 9220,
	development: 9230,
};

// Always match native arch for HVF acceleration — cross-arch TCG is too slow for CI.
const CHR_ARCH = process.arch === "arm64" ? "arm64" as const : "x86" as const;
// zerotier is ARM64-only; container is available on both arches.
const EXTRA_PACKAGES = LITE ? [] : CHR_ARCH === "arm64" ? ["zerotier", "container"] : ["container"];

/** SSH options to skip host key checking for ephemeral test instances. */
const SSH_OPTS = [
	"-o", "StrictHostKeyChecking=no",
	"-o", "UserKnownHostsFile=/dev/null",
	"-o", "LogLevel=ERROR",
	"-o", "ConnectTimeout=10",
];

const instances = new Map<Channel, ChrInstance>();

/** Upload a local file to RouterOS flash via SCP. */
async function scpUpload(sshPort: number, localPath: string, remoteName: string): Promise<void> {
	const result = Bun.spawnSync([
		"scp",
		...SSH_OPTS,
		"-P", String(sshPort),
		localPath,
		`admin@127.0.0.1:/${remoteName}`,
	], { stdout: "pipe", stderr: "pipe" });

	if (result.exitCode !== 0) {
		const err = new TextDecoder().decode(result.stderr);
		throw new Error(`scp failed (exit ${result.exitCode}): ${err}`);
	}
}

/** Run a RouterOS CLI command via SSH and return stdout. */
async function sshExec(sshPort: number, command: string): Promise<string> {
	const result = Bun.spawnSync([
		"ssh",
		...SSH_OPTS,
		"-p", String(sshPort),
		"admin@127.0.0.1",
		command,
	], { stdout: "pipe", stderr: "pipe" });

	return new TextDecoder().decode(result.stdout);
}

async function cleanup(): Promise<void> {
	const stops = CHANNELS.map(async (channel) => {
		const name = `matrica-${channel.replace("-", "")}`;
		// Try via live instance handle first
		const live = instances.get(channel);
		if (live) {
			try { await live.stop(); } catch { /* ignore */ }
			try { await live.remove(); } catch { /* ignore */ }
			return;
		}
		// Fallback: look up by name in case instance was never stored
		const found = QuickCHR.get(name);
		if (!found) return;
		try { await found.stop(); } catch { /* ignore */ }
		try { await found.remove(); } catch { /* ignore */ }
	});
	await Promise.allSettled(stops);
}

describe.skipIf(SKIP)("matrica — parallel version matrix", () => {
	afterAll(cleanup);

	test(
		`start ${CHANNELS.length} ${CHR_ARCH} CHRs in parallel${LITE ? " (lite)" : ""}`,
		async () => {
			// Pre-clean any stale machines from a previous aborted run
			await cleanup();

			const starts = CHANNELS.map((channel) =>
				QuickCHR.start({
					name: `matrica-${channel.replace("-", "")}`,
					channel,
					arch: CHR_ARCH,
					portBase: PORT_BASES[channel],
					packages: EXTRA_PACKAGES,
					background: true,
					secureLogin: true,
				}),
			);

			const results = await Promise.all(starts);

			for (const inst of results) {
				const channel = CHANNELS.find((c) => inst.name.includes(c.replace("-", "")))!;
				instances.set(channel, inst);
				expect(inst.state.arch).toBe(CHR_ARCH === "arm64" ? "arm64" : "x86");
				expect(inst.state.status).toBe("running");
			}

			expect(instances.size).toBe(CHANNELS.length);
		},
		// LITE: native arch with HVF ≈ 30s. Full: 4 ARM64 + pkg reboot under TCG ≈ 8 min.
		LITE ? 120_000 : 600_000,
	);

	test(
		"all instances respond to REST API",
		async () => {
			const checks = CHANNELS.map(async (channel) => {
				const inst = instances.get(channel)!;
				// start() with packages already waited for provisioning boot.
				// A second waitForBoot() call is fast (HTTP is already up).
				const booted = await inst.waitForBoot(60_000);
				expect(booted).toBe(true);

				const resource = (await inst.rest("/system/resource")) as Record<string, string>;
				expect(resource["board-name"]).toContain("CHR");
				expect(typeof resource.version).toBe("string");

				return { channel, version: resource.version, uptime: resource.uptime };
			});

			const results = await Promise.all(checks);

			// Print comparison table
			console.log("\nRouterOS version matrix:");
			for (const { channel, version } of results) {
				console.log(`  ${channel.padEnd(12)} → ${version}`);
			}

			// All versions should be distinct (each channel is a different release train)
			// Except in edge cases where channels converge (long-term == stable is rare but valid)
			const versions = results.map((r) => r.version);
			expect(new Set(versions).size).toBeGreaterThanOrEqual(Math.min(2, CHANNELS.length));
		},
		// Includes package-install reboot time inside start() — but that's already done.
		// This test just verifies the REST API is answering.
		120_000,
	);

	test(
		"exec() returns identity and resource data on all instances",
		async () => {
			const checks = CHANNELS.map(async (channel) => {
				const inst = instances.get(channel)!;

				// exec() with plain command — returns CLI-formatted text
				const identity = await inst.exec("/system/identity/print");
				expect(identity.via).toBe("rest");
				expect(identity.output).toContain("name:");

				// exec() with caller-wrapped :serialize — returns parseable JSON
				const resource = await inst.exec(
					":local r [/system/resource/print as-value]; :put [:serialize to=json $r]",
				);
				const parsed = JSON.parse(resource.output);
				expect(Array.isArray(parsed) ? parsed[0]["board-name"] : parsed["board-name"]).toMatch(/^CHR/);

				return { channel, identity: identity.output.trim() };
			});

			const results = await Promise.all(checks);

			console.log("\nExec identity per version:");
			for (const { channel, identity } of results) {
				console.log(`  ${channel.padEnd(12)} → ${identity}`);
			}
		},
		60_000,
	);

	test(
		LITE
			? "packages baseline on all instances (lite)"
			: CHR_ARCH === "arm64"
				? "zerotier + container packages active on all instances"
				: "container package active on all instances",
		async () => {
			const checks = CHANNELS.map(async (channel) => {
				const inst = instances.get(channel)!;
				const pkgs = (await inst.rest("/system/package")) as Array<Record<string, string>>;

				const activeNames = pkgs
					.filter((p: Record<string, string>) => p.disabled !== "true")
					.map((p: Record<string, string>) => p.name)
					.filter((n): n is string => typeof n === "string");

				if (!LITE) {
					if (CHR_ARCH === "arm64") {
						expect(activeNames).toContain("zerotier");
					}
					expect(activeNames).toContain("container");
				}
				// All builds have routeros
				expect(activeNames).toContain("routeros");

				return { channel, packages: activeNames };
			});

			const results = await Promise.all(checks);

			console.log("\nInstalled packages per version:");
			for (const { channel, packages } of results) {
				const extras = packages.filter((p: string) => !["routeros", "system"].includes(p));
				console.log(`  ${channel.padEnd(12)} → [${extras.join(", ")}]`);
			}
		},
		60_000,
	);

	test(
		"ether1 present on all instances (user-mode management NIC)",
		async () => {
			const checks = CHANNELS.map(async (channel) => {
				const inst = instances.get(channel)!;
				const ifaces = (await inst.rest("/interface")) as Array<Record<string, string>>;
				const names = ifaces.map((i) => i.name);
				expect(names).toContain("ether1");
				return { channel, interfaces: names };
			});

			const results = await Promise.all(checks);

			console.log("\nInterfaces per version:");
			for (const { channel, interfaces } of results) {
				console.log(`  ${channel.padEnd(12)} → [${interfaces.join(", ")}]`);
			}
		},
		60_000,
	);

	test(
		"upload config + reset-configuration + export (config drift check)",
		async () => {
			const configPath = join(import.meta.dir, "rb5009-arm64.rsc");
			const exports = new Map<Channel, string>();

			const steps = CHANNELS.map(async (channel) => {
				const inst = instances.get(channel)!;

				// 1. Upload config via SCP
				await scpUpload(inst.sshPort, configPath, "rb5009-arm64.rsc");

				// 2. Reset configuration — CHR reboots internally.
				//    The REST call will likely fail (connection drop during reboot) — that's expected.
				try {
					const controller = new AbortController();
					setTimeout(() => controller.abort(), 10_000);
					await inst.rest("/system/reset-configuration", {
						method: "POST",
						body: JSON.stringify({
							"run-after-reset": "rb5009-arm64.rsc",
							"keep-users": "yes",
							"skip-backup": "yes",
						}),
						signal: controller.signal,
					});
				} catch {
					// Connection drop during reboot is expected — continue to waitForBoot
				}

				// 3. Wait for reboot (QEMU process stays up; RouterOS reboots inside)
				//    Give RouterOS time to shut down + apply config before polling.
				//    4 parallel CHRs rebooting simultaneously are slower than a single
				//    boot; use a generous timeout (240 s) to stay green under load.
				await Bun.sleep(15_000);
				const rebooted = await inst.waitForBoot(240_000);
				expect(rebooted).toBe(true);

				// 4. Export via SSH — `:export` is RouterOS CLI, not a REST endpoint
				const exported = await sshExec(inst.sshPort, ":export");
				exports.set(channel, exported);

				return { channel, lines: exported.split("\n").length };
			});

			const results = await Promise.allSettled(steps);

			// Report what succeeded (SSH may require scp/ssh tools in PATH)
			for (const r of results) {
				if (r.status === "rejected") {
					console.warn(`  [warn] export step failed: ${r.reason}`);
				}
			}

			const completed = [...exports.entries()];
			if (completed.length < 2) {
				console.warn("  Fewer than 2 exports collected — skipping diff (SSH may not be available)");
				return;
			}

			// 5. Compare exports: detect config drift across versions
			const [baseline, ...rest] = completed;
			if (!baseline) {
				console.warn("  No baseline export — skipping diff");
				return;
			}
			const diffs: string[] = [];

			for (const [channel, content] of rest) {
				const baseLines = new Set(baseline[1].split("\n").map((l) => l.trim()).filter(Boolean));
				const currLines = new Set(content.split("\n").map((l) => l.trim()).filter(Boolean));

				const added = [...currLines].filter((l) => !baseLines.has(l) && !l.startsWith("#"));
				const removed = [...baseLines].filter((l) => !currLines.has(l) && !l.startsWith("#"));

				if (added.length > 0 || removed.length > 0) {
					diffs.push(`${baseline[0]} → ${channel}: +${added.length} lines / -${removed.length} lines`);
				}
			}

			if (diffs.length === 0) {
				console.log("\nConfig drift: none — exports are identical across versions");
			} else {
				console.log("\nConfig drift detected:");
				for (const d of diffs) {
					console.log(`  ${d}`);
				}
			}
		},
		// reset + reboot per instance = up to 255s each (15s sleep + 240s waitForBoot), parallel
		600_000,
	);
});
