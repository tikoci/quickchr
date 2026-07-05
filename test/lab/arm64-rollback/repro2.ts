#!/usr/bin/env bun
/**
 * arm64 rollback repro, instrumented (issue #31) — raw monitor I/O around
 * savevm/loadvm + guest liveness probes, machine kept for post-mortem.
 *
 *   bun test/lab/arm64-rollback/repro2.ts
 */
import { QuickCHR } from "../../../src/index.ts";
import { monitorCommand } from "../../../src/lib/channels.ts";

const name = "lab-arm64-rollback2";

try {
	const stale = await QuickCHR.get(name);
	if (stale) await stale.remove();
} catch { /* none */ }

const chr = await QuickCHR.start({
	name,
	channel: "stable",
	arch: "arm64",
	secureLogin: false,
	mem: 256,
	bootDiskFormat: "qcow2",
	background: true,
});

const dir = chr.state.machineDir;
const portBase = chr.state.portBase;
const mon = (cmd: string) => monitorCommand(dir, cmd, undefined, portBase);

async function alive(): Promise<string> {
	try {
		const r = (await chr.rest("/system/identity")) as { name?: string };
		return `REST ok, identity=${r.name}`;
	} catch (e) {
		return `REST dead: ${(e as Error).message.slice(0, 80)}`;
	}
}

console.log("=== booted ===");
console.log(await alive());

await chr.exec("/system/identity/set name=before-snapshot");

console.log("=== savevm baseline (raw monitor output) ===");
console.log(JSON.stringify(await mon("savevm baseline")));

console.log("=== info snapshots ===");
console.log(JSON.stringify(await mon("info snapshots")));

await chr.exec("/system/identity/set name=after-change");
console.log("pre-loadvm:", await alive());

console.log("=== info status (before loadvm) ===");
console.log(JSON.stringify(await mon("info status")));

console.log("=== loadvm baseline (raw monitor output) ===");
console.log(JSON.stringify(await mon("loadvm baseline")));

console.log("=== info status (right after loadvm) ===");
console.log(JSON.stringify(await mon("info status")));

await Bun.sleep(10_000);
console.log("t+10s:", await alive());
console.log("=== info status (t+10s) ===");
console.log(JSON.stringify(await mon("info status")));

await Bun.sleep(30_000);
console.log("t+40s:", await alive());

console.log(`machine kept for post-mortem: ${dir} (remove with: bun run dev -- remove ${name} --force)`);
