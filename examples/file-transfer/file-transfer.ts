#!/usr/bin/env bun
/**
 * file-transfer — copy a file to a CHR and back, round-trip verified
 *
 * `ChrInstance.upload()` / `download()` move files over SCP using the instance's
 * resolved credentials (so you don't hand-roll scp + auth). Here: write a local
 * file, upload it, confirm it landed in `/file`, download it back, and assert the
 * bytes match.
 *
 * `secureLogin: true` provisions a real password so SCP can authenticate.
 *
 * Run:  bun run examples/file-transfer/file-transfer.ts
 * Time: ~40–60 s.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuickCHR } from "../../src/index.ts";
import { check, exampleMachineName, runExample } from "../lib.ts";

if (import.meta.main) {
	await runExample(async (track) => {
		const chr = track(
			await QuickCHR.start({
				name: exampleMachineName("file-transfer"),
				channel: "stable",
				secureLogin: true, // real creds for SCP auth
				mem: 256,
			}),
		);

		const stamp = Date.now().toString(36);
		const localIn = join(tmpdir(), `qc-ft-in-${stamp}.txt`);
		const localOut = join(tmpdir(), `qc-ft-out-${stamp}.txt`);
		const payload = `hello from quickchr ${stamp}`;
		await Bun.write(localIn, payload);

		// Upload → confirm on the router → download → compare bytes.
		await chr.upload(localIn, "/quickchr-ft.txt");
		const files = (await chr.rest("/file")) as Array<Record<string, string>>;
		check(
			files.some((f) => (f.name ?? "").includes("quickchr-ft.txt")),
			"uploaded file should appear in /file",
		);

		await chr.download("/quickchr-ft.txt", localOut);
		const got = (await Bun.file(localOut).text()).trim();
		check(got === payload, `downloaded content should match upload (got "${got}")`);

		console.log(`  upload/download round-trip OK — ${payload.length} bytes match`);
	});
}
