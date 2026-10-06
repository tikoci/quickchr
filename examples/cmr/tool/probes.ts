import { check } from "../../lib.ts";
import { command, pair, read, until, type Lab } from "./lab.ts";

/**
 * Deliberate beta probes run after the demonstration, on disposable routers only.
 * Observations land in `result` as they are made, so a caller that holds it keeps them if a later probe throws.
 */
export async function probes(lab: Lab, preserveWebhooks = false, result: Record<string, unknown> = {}) {
	const { controller, local } = lab;
	if (!preserveWebhooks) {
		for (const name of ["lab-down", "lab-connected"]) await command(controller, `/cmr/alert/set [find name=${name}] disabled=yes`);
	}
	const quote = (s: string) => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$")}"`;
	const auth = (await controller.descriptor()).services["rest-api"];
	check(auth.available && auth.auth, "Controller login missing");
	const matrix: Record<string, string>[] = [];
	result.pairingMatrix = matrix;
	for (const clientRequirement of ["none", "password"]) {
		for (const serverRequirement of ["none", "password", "confirm"]) {
			await command(local, "/cmr/client/set enabled=no");
			await command(local, "/cmr/client/forget");
			await command(controller, "/cmr/device/remove [find identity=cmr-local]");
			await command(local, `/cmr/client/set enabled=yes controller-addresses=203.0.113.1 pairing-requirement=${clientRequirement}`);
			await until("fresh local device", async () => (await read(controller, "/cmr/device")).some(r => r.identity === "cmr-local"));
			await command(controller, `/cmr/device/set [find identity=cmr-local] pairing-requirement=${serverRequirement}`);
			const before = (await read(controller, "/cmr/device")).find(r => r.identity === "cmr-local");
			if (serverRequirement === "password") {
				// Local pair approves the client side, and proves knowledge of the server login.
				await command(local, `/cmr/client/pair username=${quote(auth.auth.username)} password=${quote(auth.auth.password ?? "")}`);
			} else if (clientRequirement === "password") {
				await pair(controller, local);
			} else if (serverRequirement === "confirm") {
				await command(controller, "/cmr/device/pair [find identity=cmr-local]");
			}
			await until("matrix pairing", async () => (await read(local, "/cmr/client"))[0]?.status === "paired,connected");
			matrix.push({ clientRequirement, serverRequirement, before: before?.state ?? "ok", after: "paired,connected" });
		}
	}
	console.log("Pairing matrix verified: six fresh client/server combinations");
	await command(controller, "/cmr/device/set [find identity=cmr-local] labels=lab,local");

	// Capture the raw RouterOS result, including rejections. A future beta may fix these.
	result.clientConfirmCompletion = await local.rest("/console/inspect", { method: "POST", body: JSON.stringify({ request: "completion", input: "/cmr/client/set pairing-requirement=" }) });
	result.clientConfirm = (await local.exec("/cmr/client/set pairing-requirement=confirm")).output;
	result.defaultRuleEdit = (await controller.exec("/cmr/upgrade/set [find name=default] channel=development")).output;
	if (!(await read(controller, "/file")).some(r => r.name === "cmr-lab-packages")) {
		await command(controller, "/file/add type=directory name=cmr-lab-packages");
	}
	result.directoryWithoutSlash = (await controller.exec("/cmr/set packages-directory=cmr-lab-packages")).output;
	await command(controller, "/cmr/set packages-directory=cmr-lab-packages/");
	await until("CMR clients after directory change", async () => (await read(local, "/cmr/client"))[0]?.status === "paired,connected");
	result.serverSettings = await read(controller, "/cmr");
	result.export = await command(controller, "/cmr/export");
	result.verboseExport = await command(controller, "/cmr/export verbose");
	result.fullVerboseExportHasServerSettings = /(?:^|\n)\/cmr\s+(?:set|\r?\nset)\b/.test(await command(controller, "/export verbose"));
	await command(controller, "/system/backup/save name=cmr-lab password=CMR-Lab-Backup");
	const before = { settings: await read(controller, "/cmr"), devices: (await read(controller, "/cmr/device")).map(r => ({ identity: r.identity, ids: r.ids, labels: r.labels })) };
	result.binaryBackup = { before };
	await command(controller, "/cmr/set enabled=no");
	check((await read(controller, "/cmr"))[0]?.enabled === "no", "Backup control: server did not disable");
	try {
		await controller.rest("/system/backup/load", { method: "POST", body: JSON.stringify({ name: "cmr-lab.backup", password: "CMR-Lab-Backup" }) });
	} catch (error) {
		// The load reboots RouterOS, so the reply can be lost (refused, reset or timed out); the
		// polling below verifies the restore. An HTTP status (bad name, password, auth) stays fatal.
		if (error instanceof Error && error.message.startsWith("REST ")) throw error;
	}
	await until("server enabled after binary backup restore", async () => {
		try { return (await read(controller, "/cmr"))[0]?.enabled === "yes"; }
		catch { return false; } // The restore reboots RouterOS; REST is expected to disconnect.
	}, 120_000);
	const after = { settings: await read(controller, "/cmr"), devices: (await read(controller, "/cmr/device")).map(r => ({ identity: r.identity, ids: r.ids, labels: r.labels })) };
	check(JSON.stringify(before) === JSON.stringify(after), "CMR settings or device pairing IDs changed across binary restore");
	await until("clients reconnected after backup restore", async () => {
		for (const client of [lab.transit, lab.remote, lab.local]) {
			if ((await read(client, "/cmr/client"))[0]?.status !== "paired,connected") return false;
		}
		return true;
	});
	result.binaryBackup = { before, after, restored: true };
	console.log("Binary backup restored server settings and device pairing IDs");
	return result;
}
