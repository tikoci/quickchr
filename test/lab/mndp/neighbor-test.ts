/**
 * LAB — do two CHRs on the same QEMU mcast group discover each other via MNDP?
 * Isolates "RouterOS emits MNDP over the mcast netdev" (QEMU↔QEMU) from the
 * separate question of whether a host process can receive those frames.
 *
 *   KEEP=1 bun run test/lab/mndp/neighbor-test.ts   (reuses running mndp-probe as peer A)
 */
import { QuickCHR, type ChrInstance } from "../../../src/index.ts";

const GROUP = "230.0.0.1";
const PORT = 4001;
const CHR_ARCH = process.arch === "arm64" ? ("arm64" as const) : ("x86" as const);

async function main() {
	let a: ChrInstance | undefined;
	let b: ChrInstance | undefined;
	try {
		// Peer A: reuse the kept mndp-probe if present, else start one.
		a = QuickCHR.get("mndp-probe") ?? undefined;
		if (a) console.log("peer A: reusing running mndp-probe");
		else {
			console.log("peer A: starting…");
			a = await QuickCHR.start({ name: "mndp-probe", version: "stable", arch: CHR_ARCH, background: true, secureLogin: false, cpu: 1, mem: 256, networks: ["user", { type: "socket-mcast", group: GROUP, port: PORT }] });
			await a.waitForBoot(180_000);
			await a.exec("/system/identity/set name=peerA");
		}

		console.log("peer B: starting…");
		b = await QuickCHR.start({ name: "mndp-probe2", version: "stable", arch: CHR_ARCH, background: true, secureLogin: false, cpu: 1, mem: 256, networks: ["user", { type: "socket-mcast", group: GROUP, port: PORT }] });
		await b.waitForBoot(180_000);
		await b.exec("/system/identity/set name=peerB");
		for (const m of [a, b]) {
			await m.exec("/ip/neighbor/discovery-settings/set discover-interface-list=all");
		}

		console.log("waiting 40s for MNDP exchange…");
		await new Promise((r) => setTimeout(r, 40_000));

		for (const [name, m] of [["A", a], ["B", b]] as const) {
			const n = await m.exec("/ip/neighbor/print");
			console.log(`\n── peer ${name} /ip/neighbor ──\n${n.output?.trim() || "(empty)"}`);
		}
	} finally {
		if (!process.env.KEEP) {
			try { await a?.remove(); } catch {}
			try { await b?.remove(); } catch {}
		} else {
			console.log("\nKEEP set — leaving both machines running");
		}
	}
}
main().catch((e) => { console.error(e); process.exit(1); });
