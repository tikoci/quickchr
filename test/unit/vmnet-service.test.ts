import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	SOCKET_VMNET_RELEASE,
	buildCreateScript,
	buildLaunchdPlist,
	buildRemoveScript,
	buildRestartScript,
	describeManagedNetworkStatus,
	machineUsesManagedNetwork,
	managedNetworkLabel,
	managedNetworkSlug,
	parseLaunchctlPrint,
	parseManagedNetworkSpec,
	parseManagedPlist,
	planManagedNetwork,
	readManagedNetworkLog,
	rootOwnedChecks,
	shellQuote,
	socketVmnetAsset,
	socketVmnetAssetUrl,
	type ManagedNetwork,
} from "../../src/lib/vmnet-service.ts";
import { managedSocketPath } from "../../src/lib/platform.ts";

/** The plist hand-installed on Morpheus on 2026-11-07, before quickchr could create
 *  networks (docs/macos-managed-services-research.md), as `plutil -convert json` prints it. */
const MORPHEUS_PLIST = {
	ProgramArguments: [
		"/opt/quickchr/bin/socket_vmnet",
		"--vmnet-mode=bridged",
		"--vmnet-interface=en0",
		"--vmnet-interface-id=CDE475DB-BC96-4F9B-BB48-33FC713772F0",
		"--socket-group=staff",
		"/var/run/socket_vmnet.bridged.en0",
	],
	KeepAlive: true,
	Label: "dev.tikoci.quickchr.net.bridged-en0",
	RunAtLoad: true,
	StandardOutPath: "/var/log/quickchr/net-bridged-en0.log",
	StandardErrorPath: "/var/log/quickchr/net-bridged-en0.log",
};

const PLIST_PATH = "/Library/LaunchDaemons/dev.tikoci.quickchr.net.bridged-en0.plist";

function morpheus(): ManagedNetwork {
	const net = parseManagedPlist(PLIST_PATH, MORPHEUS_PLIST);
	if (!net) throw new Error("fixture did not parse");
	return net;
}

describe("managed network naming", () => {
	test("the specifier machines use is the network's name", () => {
		expect(parseManagedNetworkSpec("shared")).toEqual({ mode: "shared" });
		expect(parseManagedNetworkSpec("bridged:en0")).toEqual({ mode: "bridged", iface: "en0" });
	});

	test("label, socket and slug derive from the specifier, with quickchr-owned names", () => {
		const spec = { mode: "bridged", iface: "en0" } as const;
		expect(managedNetworkSlug(spec)).toBe("bridged-en0");
		expect(managedNetworkLabel(spec)).toBe("dev.tikoci.quickchr.net.bridged-en0");
		expect(managedSocketPath("bridged-en0")).toBe("/var/run/quickchr-net-bridged-en0.sock");
		expect(managedNetworkLabel({ mode: "shared" })).toBe("dev.tikoci.quickchr.net.shared");
	});

	test("refuses anything else, and interface names that are not safe as path or shell words", () => {
		expect(() => parseManagedNetworkSpec("socket::lab")).toThrow(/expected shared or bridged/);
		expect(() => parseManagedNetworkSpec("bridged:en0;rm -rf /")).toThrow(/Not a usable interface name/);
		expect(() => parseManagedNetworkSpec("bridged:../x")).toThrow(/Not a usable interface name/);
	});
});

describe("pinned helper", () => {
	test("each host arch maps to a pinned upstream tarball", () => {
		expect(socketVmnetAsset("x64").file).toBe(`socket_vmnet-${SOCKET_VMNET_RELEASE.version}-x86_64.tar.gz`);
		expect(socketVmnetAsset("arm64").file).toBe(`socket_vmnet-${SOCKET_VMNET_RELEASE.version}-arm64.tar.gz`);
		expect(socketVmnetAssetUrl(socketVmnetAsset("x64"))).toStartWith("https://github.com/lima-vm/socket_vmnet/releases/download/v");
		for (const a of Object.values(SOCKET_VMNET_RELEASE.assets)) {
			expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(a.binarySha256).toMatch(/^[0-9a-f]{64}$/);
		}
		expect(() => socketVmnetAsset("ia32")).toThrow(/no release/);
	});
});

describe("parseManagedPlist", () => {
	test("reads a hand-made quickchr service, including its lima-named socket", () => {
		expect(morpheus()).toMatchObject({
			spec: { mode: "bridged", iface: "en0" },
			label: "dev.tikoci.quickchr.net.bridged-en0",
			helperPath: "/opt/quickchr/bin/socket_vmnet",
			socketPath: "/var/run/socket_vmnet.bridged.en0",
			interfaceId: "CDE475DB-BC96-4F9B-BB48-33FC713772F0",
			logPath: "/var/log/quickchr/net-bridged-en0.log",
		});
	});

	test("the log is where launchd sends stderr, falling back to stdout, and absent without either", () => {
		expect(parseManagedPlist(PLIST_PATH, { ...MORPHEUS_PLIST, StandardErrorPath: "/tmp/err.log" })?.logPath).toBe("/tmp/err.log");
		const { StandardErrorPath: _e, ...stdoutOnly } = MORPHEUS_PLIST;
		expect(parseManagedPlist(PLIST_PATH, stdoutOnly)?.logPath).toBe("/var/log/quickchr/net-bridged-en0.log");
		const { StandardErrorPath: _e2, StandardOutPath: _o, ...noLog } = MORPHEUS_PLIST;
		expect(parseManagedPlist(PLIST_PATH, noLog)?.logPath).toBeUndefined();
	});

	test("ignores services that are not quickchr networks", () => {
		expect(parseManagedPlist("/x.plist", { ...MORPHEUS_PLIST, Label: "homebrew.mxcl.socket_vmnet" })).toBeUndefined();
		expect(parseManagedPlist("/x.plist", { Label: "dev.tikoci.quickchr.net.x" })).toBeUndefined();
	});
});

describe("planManagedNetwork", () => {
	test("re-creating keeps the interface id and moves to the quickchr socket name", () => {
		const plan = planManagedNetwork({ mode: "bridged", iface: "en0" }, morpheus(), "x64");
		expect(plan.interfaceId).toBe("CDE475DB-BC96-4F9B-BB48-33FC713772F0");
		expect(plan.programArguments).toEqual([
			`/opt/quickchr/socket_vmnet/${SOCKET_VMNET_RELEASE.version}/bin/socket_vmnet`,
			"--vmnet-mode=bridged",
			"--vmnet-interface=en0",
			"--vmnet-interface-id=CDE475DB-BC96-4F9B-BB48-33FC713772F0",
			"--socket-group=staff",
			"/var/run/quickchr-net-bridged-en0.sock",
		]);
		expect(plan.logPath).toBe("/var/log/quickchr/net-bridged-en0.log");
		expect(plan.plistPath).toBe(PLIST_PATH);
	});

	test("a new network pins a fresh interface id and has no --vmnet-interface in shared mode", () => {
		const plan = planManagedNetwork({ mode: "shared" }, undefined, "arm64");
		expect(plan.interfaceId).toMatch(/^[0-9A-F-]{36}$/);
		expect(plan.programArguments.some((a) => a.startsWith("--vmnet-interface="))).toBe(false);
		expect(plan.programArguments).toContain("--vmnet-mode=shared");
		expect(plan.socketPath).toBe("/var/run/quickchr-net-shared.sock");
	});
});

describe("generated plist and root scripts", () => {
	const plan = planManagedNetwork({ mode: "bridged", iface: "en0" }, morpheus(), "x64");

	test.skipIf(process.platform !== "darwin")("the plist passes plutil -lint and reads back as the same service", () => {
		const dir = mkdtempSync(join(tmpdir(), "quickchr-tmp-plist-"));
		try {
			const path = join(dir, "svc.plist");
			writeFileSync(path, buildLaunchdPlist(plan));
			expect(Bun.spawnSync(["plutil", "-lint", path]).exitCode).toBe(0);
			const json = JSON.parse(new TextDecoder().decode(Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", path]).stdout));
			expect(json).toMatchObject({ Label: plan.label, ProgramArguments: plan.programArguments, RunAtLoad: true, KeepAlive: true });
			expect(parseManagedPlist(path, json)).toMatchObject({ socketPath: plan.socketPath, logPath: plan.logPath });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("create script checks the pinned hash before loading, and clears both old and new sockets", () => {
		const script = buildCreateScript(plan, "/stage/socket_vmnet");
		const lines = script.split("\n");
		const hash = lines.findIndex((l) => l.includes(plan.asset.binarySha256));
		const bootstrap = lines.findIndex((l) => l.startsWith("launchctl bootstrap system"));
		expect(lines[0]).toBe("set -eu");
		expect(hash).toBeGreaterThan(0);
		expect(bootstrap).toBeGreaterThan(hash);
		expect(script).toContain("rm -f '/var/run/quickchr-net-bridged-en0.sock' '/var/run/socket_vmnet.bridged.en0'");
	});

	test("root takes nothing from a user-writable file unchecked: the plist is embedded, the helper re-hashed in place", () => {
		// Codex review of #267: a staged plist in a user-owned temp dir could be swapped
		// while sudo waits for the password, and root would install it unchecked.
		const script = buildCreateScript(plan, "/stage/socket_vmnet");
		const lines = script.split("\n");
		const install = lines.indexOf(`install -o root -g wheel -m 755 '/stage/socket_vmnet' "$new"`);
		expect(install).toBeGreaterThan(0);
		expect(lines.findIndex((l) => l.includes(plan.asset.binarySha256))).toBeGreaterThan(install);
		expect(script).toContain(`printf '%s' ${shellQuote(buildLaunchdPlist(plan))} > "$tmp"`);
	});

	test("the staged helper is verified before it replaces the live one", () => {
		// Copilot review of #264: installing straight over the live path left unverified
		// bytes there on a hash mismatch, for KeepAlive to run as root.
		const lines = buildCreateScript(plan, "/stage/socket_vmnet").split("\n");
		expect(lines.some((l) => l.startsWith("install ") && l.endsWith(`'${plan.helperPath}'`))).toBe(false);
		const newCheck = lines.findIndex((l) => l.startsWith(`test "$(shasum -a 256 "$new"`));
		const swap = lines.indexOf(`mv -f "$new" '${plan.helperPath}'`);
		const liveCheck = lines.findIndex((l) => l.startsWith(`test "$(shasum -a 256 '${plan.helperPath}'`));
		expect(newCheck).toBeGreaterThan(0);
		expect(swap).toBeGreaterThan(newCheck);
		expect(liveCheck).toBeGreaterThan(swap);
	});

	test("directories are checked before install -d, which would chown a symlink's target", () => {
		// CodeRabbit review of #264: `install -d` follows an existing directory symlink.
		const lines = buildCreateScript(plan).split("\n");
		const install = lines.findIndex((l) => l.startsWith("install -d "));
		const dirChecks = lines.flatMap((l, i) => (l.startsWith("for p in '/opt'") ? [i] : []));
		expect(dirChecks).toHaveLength(2);
		expect(dirChecks[0]).toBeLessThan(install);
		expect(dirChecks[1]).toBeGreaterThan(install);
	});

	test("create skips the helper install when it is already in place, but still checks it", () => {
		const script = buildCreateScript(plan);
		expect(script).not.toContain("/stage/");
		expect(script).toContain(plan.asset.binarySha256);
		// launchd opens the log as root, so an existing log file is checked like the helper.
		expect(script).toContain(`for p in '${plan.helperPath}' '${plan.logPath}'; do`);
	});

	test("remove deletes the plist and socket; restart loads an unloaded job first", () => {
		expect(buildRemoveScript(morpheus())).toContain(`rm -f '${PLIST_PATH}' '/var/run/socket_vmnet.bridged.en0'`);
		const restart = buildRestartScript(morpheus()).split("\n");
		expect(restart[1]).toBe(`launchctl print 'system/${morpheus().label}' >/dev/null 2>&1 || launchctl bootstrap system '${PLIST_PATH}'`);
		expect(restart[2]).toStartWith("launchctl kickstart -k");
	});
});

/**
 * The root scripts are macOS `/bin/sh` scripts, so these tests run them under a POSIX
 * shell. Windows has no `/bin/sh` (`uv_spawn '/bin/sh'` ENOENT, run 43058959832): that
 * is a fact about the test harness, not about the product, which only builds these
 * scripts on macOS. The string-level assertions above still run on every platform.
 */
describe.skipIf(process.platform === "win32")("generated root scripts under /bin/sh", () => {
	const plan = planManagedNetwork({ mode: "bridged", iface: "en0" }, morpheus(), "x64");

	test("create, remove and restart scripts parse", () => {
		for (const script of [buildCreateScript(plan, "/stage/socket_vmnet"), buildCreateScript(plan), buildRemoveScript(morpheus()), buildRestartScript(morpheus())]) {
			expect(Bun.spawnSync(["/bin/sh", "-n", "-c", script]).exitCode).toBe(0);
		}
	});

	test("the plist the script writes with its own printf is byte-for-byte the plan", () => {
		const script = buildCreateScript(plan, "/stage/socket_vmnet");
		const at = script.indexOf("printf '%s' ");
		const printf = script.slice(at, script.indexOf(' > "$tmp"', at));
		const dir = mkdtempSync(join(tmpdir(), "quickchr-tmp-plist-"));
		try {
			const out = join(dir, "p.plist");
			expect(Bun.spawnSync(["/bin/sh", "-c", `${printf} > ${shellQuote(out)}`]).exitCode).toBe(0);
			expect(readFileSync(out, "utf8")).toBe(buildLaunchdPlist(plan));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("shellQuote survives a single quote", () => {
		expect(Bun.spawnSync(["/bin/sh", "-c", `printf %s ${shellQuote("a'b c")}`]).stdout.toString()).toBe("a'b c");
	});

	test("an unload that never finishes stops remove before it deletes anything", () => {
		// Codex review of #264: the wait loop used to fall through after 5 s and the
		// script went on to delete the plist with the service still loaded. launchctl
		// is stubbed to report the job as loaded forever, and sleep to return at once.
		const dir = mkdtempSync(join(tmpdir(), "quickchr-tmp-unload-"));
		try {
			const plistPath = join(dir, "svc.plist");
			const socketPath = join(dir, "svc.sock");
			writeFileSync(plistPath, "plist");
			writeFileSync(socketPath, "sock");
			const net = { ...morpheus(), plistPath, socketPath };
			const stubs = "launchctl() { return 0; }\nsleep() { :; }\n";
			const r = Bun.spawnSync(["/bin/sh", "-c", stubs + buildRemoveScript(net)], { stderr: "pipe" });
			expect(r.exitCode).toBe(1);
			expect(r.stderr.toString()).toContain("still loaded after bootout");
			expect(readFileSync(plistPath, "utf8")).toBe("plist");
			expect(readFileSync(socketPath, "utf8")).toBe("sock");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an already-unloaded job is not an error", () => {
		const dir = mkdtempSync(join(tmpdir(), "quickchr-tmp-unload-"));
		try {
			const plistPath = join(dir, "svc.plist");
			writeFileSync(plistPath, "plist");
			const net = { ...morpheus(), plistPath, socketPath: join(dir, "svc.sock") };
			// bootout fails (not loaded), print fails (not loaded): remove proceeds.
			const stubs = "launchctl() { return 113; }\n";
			expect(Bun.spawnSync(["/bin/sh", "-c", stubs + buildRemoveScript(net)]).exitCode).toBe(0);
			expect(() => readFileSync(plistPath)).toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe.skipIf(process.platform !== "darwin")("rootOwnedChecks (run for real, as the test user)", () => {
	function run(paths: string[]) {
		const r = Bun.spawnSync(["/bin/sh", "-c", ["set -eu", ...rootOwnedChecks(paths)].join("\n")], { stderr: "pipe" });
		return { code: r.exitCode, err: r.stderr.toString() };
	}

	test("root-owned system paths pass and missing paths are skipped", () => {
		expect(run(["/usr", "/usr/bin", "/usr/bin/true", "/opt/quickchr-does-not-exist"]).code).toBe(0);
	});

	test("a symlink, or a path the user owns, stops the script", () => {
		const dir = mkdtempSync(join(tmpdir(), "quickchr-tmp-own-"));
		try {
			mkdirSync(join(dir, "real"));
			symlinkSync(join(dir, "real"), join(dir, "link"));
			expect(run([join(dir, "link")])).toMatchObject({ code: 1, err: expect.stringContaining("is a symlink") });
			expect(run([join(dir, "real")])).toMatchObject({ code: 1, err: expect.stringContaining("not owned by root") });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("machineUsesManagedNetwork", () => {
	const en0 = { mode: "bridged", iface: "en0" } as const;
	const sock = "/var/run/quickchr-net-bridged-en0.sock";
	const auto = { status: "running" as const, networks: [{ id: "net1", specifier: { type: "bridged" as const, iface: "auto" } }] };
	const toEn7 = () => "en7";

	test("a running VM is judged by the socket in its QEMU argv, not today's alias resolution", () => {
		// Codex review of #267: started on en0 via auto; Ethernet en7 gained link since.
		expect(machineUsesManagedNetwork(auto, en0, { socketPath: sock, liveArgs: `qemu ... addr.path=${sock},reconnect-ms=1000`, resolveAlias: toEn7 })).toBe(true);
	});

	test("a readable argv without the socket is a no, even when the stored config says en0", () => {
		// Copilot review of #267: configured bridged:en0, actually on another socket.
		const fixed = { status: "running" as const, networks: [{ id: "net1", specifier: { type: "bridged" as const, iface: "en0" } }] };
		expect(machineUsesManagedNetwork(fixed, en0, { socketPath: sock, liveArgs: "qemu -netdev stream,id=net1,server=off,addr.type=unix,addr.path=/var/run/other.sock" })).toBe(false);
	});

	test("a VM still under the pre-0.5.7 socket_vmnet_client wrapper falls back to its stored config", () => {
		// The wrapper hands QEMU an fd, so the argv names no socket path.
		const fixed = { status: "running" as const, networks: [{ id: "net1", specifier: { type: "bridged" as const, iface: "en0" } }] };
		expect(machineUsesManagedNetwork(fixed, en0, { socketPath: sock, liveArgs: "qemu-system-x86_64 -netdev socket,id=net1,fd=3 -device virtio-net-pci,netdev=net1" })).toBe(true);
	});

	test("a running alias user with no readable argv counts as attached", () => {
		expect(machineUsesManagedNetwork(auto, en0, { socketPath: sock, resolveAlias: toEn7 })).toBe(true);
	});

	test("a stopped alias user is resolved now; fixed interfaces and shared match by name", () => {
		expect(machineUsesManagedNetwork({ ...auto, status: "stopped" }, en0, { resolveAlias: toEn7 })).toBe(false);
		expect(machineUsesManagedNetwork({ ...auto, status: "stopped" }, en0, { resolveAlias: () => "en0" })).toBe(true);
		const fixed = { status: "stopped" as const, networks: [{ id: "net1", specifier: { type: "bridged" as const, iface: "en0" } }] };
		expect(machineUsesManagedNetwork(fixed, en0)).toBe(true);
		expect(machineUsesManagedNetwork(fixed, { mode: "bridged", iface: "en1" })).toBe(false);
		expect(machineUsesManagedNetwork({ status: "stopped", networks: [{ id: "net1", specifier: "shared" }] }, { mode: "shared" })).toBe(true);
	});
});

describe("status", () => {
	// Morpheus, 2026-11-11: `launchctl print system/dev.tikoci.quickchr.net.bridged-en0`
	// as the owner (no sudo). Nested blocks repeat `state =`; only the top-level one counts.
	const PRINT = [
		"system/dev.tikoci.quickchr.net.bridged-en0 = {",
		"\tactive count = 1",
		"\tstate = running",
		"",
		"\tprogram = /opt/quickchr/bin/socket_vmnet",
		"\tendpoints = {",
		"\t\tstate = active",
		"\t}",
		"\truns = 4",
		"\tpid = 53132",
		"\tlast exit code = 0",
		"}",
	].join("\n");

	test("parseLaunchctlPrint reads the service's own state and pid", () => {
		expect(parseLaunchctlPrint(PRINT)).toEqual({ running: true, pid: 53132, lastExit: "0" });
		expect(parseLaunchctlPrint("\tstate = not running\n\tlast exit code = 78: EX_CONFIG\n")).toEqual({ running: false, pid: undefined, lastExit: "78: EX_CONFIG" });
	});

	test("readManagedNetworkLog returns the tail, and nothing for a missing or absent log", async () => {
		const dir = mkdtempSync(join(tmpdir(), "quickchr-net-log-"));
		try {
			const logPath = join(dir, "net.log");
			writeFileSync(logPath, `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
			expect(await readManagedNetworkLog({ logPath }, 3)).toBe("line 28\nline 29\nline 30");
			expect(await readManagedNetworkLog({ logPath: join(dir, "absent.log") })).toBeUndefined();
			expect(await readManagedNetworkLog({})).toBeUndefined();
			writeFileSync(logPath, "");
			expect(await readManagedNetworkLog({ logPath })).toBeUndefined();

			// Only the end is read: a byte bound that cuts mid-line drops the partial line,
			// and a single line longer than the bound still yields its tail.
			writeFileSync(logPath, "first line that will be cut\nsecond\nthird\n");
			expect(await readManagedNetworkLog({ logPath }, 20, 15)).toBe("second\nthird");
			writeFileSync(logPath, `${"x".repeat(100)}\n`);
			expect(await readManagedNetworkLog({ logPath }, 20, 10)).toBe("x".repeat(9));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("status separates service down from socket dead (#256 Done-when)", () => {
		expect(describeManagedNetworkStatus({ loaded: false, running: false })).toMatchObject({ ok: false, text: expect.stringContaining("not loaded") });
		expect(describeManagedNetworkStatus({ loaded: true, running: false, lastExit: "78" })).toMatchObject({ ok: false, text: expect.stringContaining("not running (last exit 78)") });
		expect(describeManagedNetworkStatus({ loaded: true, running: true, pid: 9, socket: { state: "refused", code: "ECONNREFUSED" } })).toMatchObject({ ok: false, text: expect.stringContaining("socket is refused") });
		expect(describeManagedNetworkStatus({ loaded: true, running: true, pid: 9, socket: { state: "accepting" } })).toEqual({ ok: true, text: "running (pid 9), socket accepting" });
	});
});
