import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { bootDiskPath } from "../../../src/lib/disk.ts";
import { buildHostfwdString, resolveAllNetworks } from "../../../src/lib/network.ts";
import { detectPlatform } from "../../../src/lib/platform.ts";
import { buildQemuArgs } from "../../../src/lib/qemu.ts";
import { loadMachine } from "../../../src/lib/state.ts";

const [name, destination, ...unexpected] = Bun.argv.slice(2);
if (!name || !destination || unexpected.length) {
	throw new Error("Usage: bun test/lab/macos-launchd/generate.ts <lab-machine> <new-output-directory>");
}
if (process.platform !== "darwin") throw new Error("This experiment requires macOS.");
if (process.getuid?.() === 0) throw new Error("Generate as the machine owner, before installing with sudo.");
if (!name.startsWith("launchd-lab-")) throw new Error("Use a disposable launchd-lab- machine.");
const state = loadMachine(name);
if (!state || state.status !== "stopped" || !state.provisioning) {
	throw new Error("Prepare, provision, and shut down the lab machine first.");
}
if (state.arch !== "x86" || state.extraDisks?.length || state.qemuArgs?.length) {
	throw new Error("Initial experiment supports x86, one disk, and no custom QEMU arguments.");
}
const networks = state.networks;
if (networks.length !== 2 || networks[0]?.specifier !== "user") {
	throw new Error("Use user management first and exactly one native vmnet NIC second.");
}
const spec = networks[1]?.specifier;
if (spec !== "vmnet-shared" && !(typeof spec === "object" && spec.type === "vmnet-bridged")) {
	throw new Error("Second NIC must explicitly select vmnet-shared or vmnet-bridged.");
}
if (!networks.every((network) => network.mac)) throw new Error("Both NICs must have persisted MACs.");
const format = state.bootDiskFormat ?? "raw";
const disk = bootDiskPath(state.machineDir, format);
if (!existsSync(disk)) throw new Error("Prepared disk is missing.");
const platform = await detectPlatform();
const argv = await buildQemuArgs({
	arch: state.arch,
	machineDir: state.machineDir,
	bootDisk: { path: disk, format },
	mem: state.mem,
	cpu: state.cpu,
	ports: state.ports,
	networks: resolveAllNetworks(networks, { platform, machine: name }, buildHostfwdString(state.ports)),
	// Select socket channels without spawning or detaching a process.
	background: true,
	portBase: state.portBase,
});
if (!argv[0] || !isAbsolute(argv[0])) throw new Error("QEMU executable must be absolute.");
const output = resolve(destination);
mkdirSync(output, { mode: 0o700 });
const label = `dev.tikoci.quickchr.lab.${crypto.randomUUID()}`;
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${argv.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(state.machineDir)}</string>
<key>RunAtLoad</key><false/>
<key>KeepAlive</key><false/>
<key>StandardOutPath</key><string>${xml(join(output, "qemu.stdout.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(output, "qemu.stderr.log"))}</string>
<key>Umask</key><integer>63</integer>
<key>ExitTimeOut</key><integer>30</integer>
</dict></plist>
`;
await Bun.write(join(output, `${label}.plist`), plist);
await Bun.write(join(output, "deployment.json"), JSON.stringify({
	label, name, machineDir: state.machineDir, ownerUid: process.getuid?.(),
	generatedAt: new Date().toISOString(), argv,
	note: "Uninstalled lab artifact. Does not update quickchr PID/status. KeepAlive and RunAtLoad disabled.",
}, null, 2));
console.log(JSON.stringify({ label, output, plist: join(output, `${label}.plist`) }));
