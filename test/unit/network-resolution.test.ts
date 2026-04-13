import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
	resolveNetworkConfig,
	resolveAllNetworks,
	type ResolutionContext,
} from "../../src/lib/network.ts";
import type { NetworkConfig, SocketVmnetInfo } from "../../src/lib/types.ts";
import { QuickCHRError } from "../../src/lib/types.ts";

// ── Helpers ─────────────────────────────────────────────────────────

function macCtx(socketVmnet?: SocketVmnetInfo): ResolutionContext {
	return {
		platform: {
			os: "darwin",
			hostArch: "arm64",
			packageManager: "brew",
			accelAvailable: ["hvf"],
			socketVmnet,
		},
		socketVmnet,
	};
}

function linuxCtx(): ResolutionContext {
	return {
		platform: {
			os: "linux",
			hostArch: "x64",
			packageManager: "apt",
			accelAvailable: ["kvm"],
		},
	};
}

const MOCK_SVN: SocketVmnetInfo = {
	client: "/opt/homebrew/opt/socket_vmnet/bin/socket_vmnet_client",
	sharedSocket: "/opt/homebrew/var/run/socket_vmnet",
	bridgedSockets: {
		en0: "/opt/homebrew/var/run/socket_vmnet.bridged.en0",
	},
};

function cfg(specifier: NetworkConfig["specifier"], id = "net0"): NetworkConfig {
	return { specifier, id };
}

function resolved(config: NetworkConfig) {
	expect(config.resolved).toBeDefined();
	return config.resolved as NonNullable<typeof config.resolved>;
}

// ── User mode ───────────────────────────────────────────────────────

describe("resolveNetworkConfig", () => {
	describe("user", () => {
		test("resolves on macOS", () => {
			const result = resolveNetworkConfig(cfg("user"), macCtx());
			expect(result.resolved).toBeDefined();
			expect(resolved(result).qemuNetdevArgs).toContain("-netdev");
			const netdev = resolved(result).qemuNetdevArgs[1];
			expect(netdev).toStartWith("user,id=net0");
			expect(resolved(result).wrapper).toBeUndefined();
		});

		test("resolves on Linux", () => {
			const result = resolveNetworkConfig(cfg("user"), linuxCtx());
			expect(result.resolved).toBeDefined();
			const netdev = resolved(result).qemuNetdevArgs[1];
			expect(netdev).toStartWith("user,id=net0");
		});

		test("includes hostfwd when provided", () => {
			const result = resolveNetworkConfig(
				cfg("user"),
				linuxCtx(),
				"hostfwd=tcp::9100-:80",
			);
			const netdev = resolved(result).qemuNetdevArgs[1];
			expect(netdev).toContain("hostfwd=tcp::9100-:80");
		});

		test("no trailing comma when hostfwd empty", () => {
			const result = resolveNetworkConfig(cfg("user"), linuxCtx());
			const netdev = resolved(result).qemuNetdevArgs[1];
			expect(netdev).toBe("user,id=net0");
		});
	});

	// ── Shared ────────────────────────────────────────────────────────

	describe("shared", () => {
		test("uses socket_vmnet when available on macOS", () => {
			const result = resolveNetworkConfig(cfg("shared"), macCtx(MOCK_SVN));
			expect(resolved(result).wrapper).toEqual([
				"/opt/homebrew/opt/socket_vmnet/bin/socket_vmnet_client",
				"/opt/homebrew/var/run/socket_vmnet",
			]);
			const netdev = resolved(result).qemuNetdevArgs[1];
			expect(netdev).toBe("socket,id=net0,fd=3");
			expect(resolved(result).downgraded).toBeUndefined();
		});

		test("falls back to vmnet-shared without socket_vmnet on macOS", () => {
			const result = resolveNetworkConfig(cfg("shared"), macCtx());
			const netdev = resolved(result).qemuNetdevArgs[1];
			expect(netdev).toBe("vmnet-shared,id=net0");
			expect(resolved(result).downgraded).toBeDefined();
			expect(resolved(result).downgraded?.reason).toContain("root");
		});

		test("throws on Linux", () => {
			expect(() => resolveNetworkConfig(cfg("shared"), linuxCtx())).toThrow(
				QuickCHRError,
			);
		});
	});

	// ── vmnet-shared ──────────────────────────────────────────────────

	describe("vmnet-shared", () => {
		test("resolves on macOS", () => {
			const result = resolveNetworkConfig(cfg("vmnet-shared"), macCtx());
			const netdev = resolved(result).qemuNetdevArgs[1];
			expect(netdev).toBe("vmnet-shared,id=net0");
		});

		test("throws on Linux", () => {
			expect(() =>
				resolveNetworkConfig(cfg("vmnet-shared"), linuxCtx()),
			).toThrow(QuickCHRError);
			try {
				resolveNetworkConfig(cfg("vmnet-shared"), linuxCtx());
			} catch (err) {
				expect((err as QuickCHRError).code).toBe("NETWORK_UNAVAILABLE");
			}
		});
	});

	// ── Bridged ───────────────────────────────────────────────────────

	describe("bridged", () => {
		test("uses socket_vmnet when available on macOS", () => {
			const result = resolveNetworkConfig(
				cfg({ type: "bridged", iface: "en0" }),
				macCtx(MOCK_SVN),
			);
			expect(resolved(result).wrapper).toEqual([
				"/opt/homebrew/opt/socket_vmnet/bin/socket_vmnet_client",
				"/opt/homebrew/var/run/socket_vmnet.bridged.en0",
			]);
			const netdev = resolved(result).qemuNetdevArgs[1];
			expect(netdev).toBe("socket,id=net0,fd=3");
		});

		test("falls back to vmnet-bridged without socket_vmnet on macOS", () => {
			const result = resolveNetworkConfig(
				cfg({ type: "bridged", iface: "en0" }),
				macCtx(),
			);
			const netdev = resolved(result).qemuNetdevArgs[1];
			expect(netdev).toContain("vmnet-bridged,id=net0,ifname=en0");
			expect(resolved(result).downgraded).toBeDefined();
		});

		test("throws on Linux", () => {
			expect(() =>
				resolveNetworkConfig(
					cfg({ type: "bridged", iface: "en0" }),
					linuxCtx(),
				),
			).toThrow(QuickCHRError);
		});
	});

	// ── vmnet-bridged ─────────────────────────────────────────────────

	describe("vmnet-bridged", () => {
		test("resolves on macOS", () => {
			const result = resolveNetworkConfig(
				cfg({ type: "vmnet-bridged", iface: "en0" }),
				macCtx(),
			);
			const netdev = resolved(result).qemuNetdevArgs[1];
			expect(netdev).toBe("vmnet-bridged,id=net0,ifname=en0");
		});

		test("throws on Linux", () => {
			expect(() =>
				resolveNetworkConfig(
					cfg({ type: "vmnet-bridged", iface: "en0" }),
					linuxCtx(),
				),
			).toThrow(QuickCHRError);
		});
	});

	// ── Socket: named ─────────────────────────────────────────────────

	describe("socket-named", () => {
		let getNamedSocketFn = mock((_name?: unknown) => undefined as unknown);

		mock.module("../../src/lib/socket-registry.ts", () => ({
			getNamedSocket: (...args: unknown[]) => getNamedSocketFn(args[0]),
		}));

		beforeEach(() => {
			getNamedSocketFn = mock((_name?: unknown) => undefined as unknown);
		});

		test("resolves mcast socket", async () => {
			getNamedSocketFn.mockReturnValue({
				name: "mylink",
				mode: "mcast",
				mcastGroup: "230.0.0.1",
				port: 4000,
				createdAt: "",
				members: [],
			});
			const { resolveNetworkConfig: resolve } = await import(
				"../../src/lib/network.ts"
			);
			const result = resolve(
				cfg({ type: "socket", name: "mylink" }),
				linuxCtx(),
			);
			const netdev = resolved(result).qemuNetdevArgs[1];
			expect(netdev).toBe("socket,id=net0,mcast=230.0.0.1:4000");
		});

		test("resolves listen-connect: first member listens", async () => {
			getNamedSocketFn.mockReturnValue({
				name: "mylink",
				mode: "listen-connect",
				port: 4000,
				createdAt: "",
				members: [],
			});
			const { resolveNetworkConfig: resolve } = await import(
				"../../src/lib/network.ts"
			);
			const result = resolve(
				cfg({ type: "socket", name: "mylink" }),
				linuxCtx(),
			);
			const netdev = resolved(result).qemuNetdevArgs[1];
			expect(netdev).toBe("socket,id=net0,listen=:4000");
		});

		test("resolves listen-connect: subsequent members connect", async () => {
			getNamedSocketFn.mockReturnValue({
				name: "mylink",
				mode: "listen-connect",
				port: 4000,
				createdAt: "",
				members: ["chr1"],
			});
			const { resolveNetworkConfig: resolve } = await import(
				"../../src/lib/network.ts"
			);
			const result = resolve(
				cfg({ type: "socket", name: "mylink" }),
				linuxCtx(),
			);
			const netdev = resolved(result).qemuNetdevArgs[1];
			expect(netdev).toBe("socket,id=net0,connect=127.0.0.1:4000");
		});

		test("throws when socket not found", async () => {
			getNamedSocketFn.mockReturnValue(undefined);
			const { resolveNetworkConfig: resolve } = await import(
				"../../src/lib/network.ts"
			);
			expect(() =>
				resolve(
					cfg({ type: "socket", name: "missing" }),
					linuxCtx(),
				),
			).toThrow(QuickCHRError);
		});
	});

	// ── Socket: listen/connect/mcast ──────────────────────────────────

	describe("socket-listen", () => {
		test("resolves direct listen", () => {
			const result = resolveNetworkConfig(
				cfg({ type: "socket-listen", port: 4001 }),
				linuxCtx(),
			);
			const netdev = resolved(result).qemuNetdevArgs[1];
			expect(netdev).toBe("socket,id=net0,listen=:4001");
		});
	});

	describe("socket-connect", () => {
		test("resolves direct connect", () => {
			const result = resolveNetworkConfig(
				cfg({ type: "socket-connect", port: 4001 }),
				linuxCtx(),
			);
			const netdev = resolved(result).qemuNetdevArgs[1];
			expect(netdev).toBe("socket,id=net0,connect=127.0.0.1:4001");
		});
	});

	describe("socket-mcast", () => {
		test("resolves direct mcast", () => {
			const result = resolveNetworkConfig(
				cfg({ type: "socket-mcast", group: "230.0.0.1", port: 4001 }),
				macCtx(),
			);
			const netdev = resolved(result).qemuNetdevArgs[1];
			expect(netdev).toBe("socket,id=net0,mcast=230.0.0.1:4001");
		});
	});

	// ── TAP ───────────────────────────────────────────────────────────

	describe("tap", () => {
		test("resolves on Linux", () => {
			const result = resolveNetworkConfig(
				cfg({ type: "tap", ifname: "tap-chr0" }),
				linuxCtx(),
			);
			const netdev = resolved(result).qemuNetdevArgs[1];
			expect(netdev).toBe(
				"tap,id=net0,ifname=tap-chr0,script=no,downscript=no",
			);
		});

		test("throws on macOS", () => {
			expect(() =>
				resolveNetworkConfig(
					cfg({ type: "tap", ifname: "tap-chr0" }),
					macCtx(),
				),
			).toThrow(QuickCHRError);
		});
	});

	// ── Device args ───────────────────────────────────────────────────

	describe("device args", () => {
		test("always includes virtio-net-pci device", () => {
			const result = resolveNetworkConfig(cfg("user"), linuxCtx());
			const args = resolved(result).qemuNetdevArgs;
			expect(args).toContain("-device");
			expect(args).toContain("virtio-net-pci,netdev=net0");
		});

		test("uses correct id in device arg", () => {
			const result = resolveNetworkConfig(cfg("user", "net2"), linuxCtx());
			expect(resolved(result).qemuNetdevArgs).toContain(
				"virtio-net-pci,netdev=net2",
			);
		});
	});
});

// ── Batch resolver ──────────────────────────────────────────────────

describe("resolveAllNetworks", () => {
	test("resolves multiple configs", () => {
		const configs = [
			cfg("user", "net0"),
			cfg({ type: "socket-listen", port: 4001 }, "net1"),
		];
		const results = resolveAllNetworks(configs, linuxCtx());
		expect(results).toHaveLength(2);
		expect(results[0]?.resolved).toBeDefined();
		expect(results[1]?.resolved).toBeDefined();
	});

	test("throws on multiple user-mode NICs", () => {
		const configs = [
			cfg("user", "net0"),
			cfg("user", "net1"),
		];
		expect(() => resolveAllNetworks(configs, linuxCtx())).toThrow(
			QuickCHRError,
		);
	});

	test("throws on multiple socket_vmnet wrappers", () => {
		const configs = [
			cfg("shared", "net0"),
			cfg("shared", "net1"),
		];
		const ctx = macCtx(MOCK_SVN);
		expect(() => resolveAllNetworks(configs, ctx)).toThrow(QuickCHRError);
	});

	test("preserves original config fields", () => {
		const original = cfg("user", "net0");
		const results = resolveAllNetworks([original], linuxCtx());
		expect(results[0]?.specifier).toBe("user");
		expect(results[0]?.id).toBe("net0");
	});
});
