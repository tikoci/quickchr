#!/usr/bin/env bun
/**
 * service-forward — pin a guest service to a chosen host port (host→guest hostfwd)
 *
 * Some clients assume a fixed local port (e.g. a Wine-hosted Dude/WinBox client
 * that only connects to 127.0.0.1:8291). Instead of a loopback proxy, forward the
 * guest service straight to the host port you want with `extraPorts` (the library
 * form of the CLI `--forward`). Here: pin guest WinBox (8291) to a free host port
 * and prove it's reachable. This is the donny WinBox-pinning recipe.
 *
 * Never hard-code a host port — `freePort()` allocates one so parallel runs don't
 * collide.
 *
 * Run:  bun run examples/service-forward/service-forward.ts
 * Time: ~25–45 s.
 */
import net from "node:net";
import { QuickCHR } from "../../src/index.ts";
import { check, exampleMachineName, freePort, runExample } from "../lib.ts";

if (import.meta.main) {
	await runExample(async (track) => {
		const hostPort = await freePort();

		const chr = track(
			await QuickCHR.start({
				name: exampleMachineName("service-forward"),
				channel: "stable",
				secureLogin: false,
				mem: 256,
				// Pin guest WinBox (8291) to the chosen host port (== CLI --forward winbox:<port>).
				extraPorts: [{ name: "winbox", host: hostPort, guest: 8291, proto: "tcp" }],
			}),
		);
		check(await chr.waitForBoot(120_000), "CHR did not become REST-ready");

		// WinBox (8291) is enabled by default. Verify the host port reaches it.
		const reachable = await new Promise<boolean>((resolve) => {
			const sock = net.connect({ host: "127.0.0.1", port: hostPort }, () => {
				sock.end();
				resolve(true);
			});
			sock.on("error", () => resolve(false));
			sock.setTimeout(10_000, () => {
				sock.destroy();
				resolve(false);
			});
		});

		check(reachable, `guest WinBox should be reachable on host port ${hostPort}`);
		console.log(`  guest WinBox 8291 pinned to host 127.0.0.1:${hostPort} (TCP connect OK)`);
	});
}
