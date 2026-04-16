/**
 * Lab: /system/package — Full Behavior Documentation
 *
 * Tested: CHR 7.22.1 (x86_64) on Intel Mac, HVF acceleration
 * Date: 2026-04-16
 *
 * ═══════════════════════════════════════════════════════════════════════
 * KEY FINDINGS
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 1. PACKAGE STATES:
 *    - Installed+active: available="false", disabled="false", version="7.22.1"
 *    - Installed+disabled: available="false", disabled="true", version="7.22.1"
 *    - Available (not installed): available="true", disabled="true", version=""
 *
 * 2. AVAILABLE PACKAGES ON CHR 7.22.1 (after check-for-updates reveals them):
 *    routeros (always installed), calea, container, dude, gps, iot,
 *    openflow, rose-storage, tr069-client, ups, user-manager, wireless
 *    Total: 12 packages. These are BUILT INTO the CHR image, not downloaded.
 *
 * 3. PACKAGE VISIBILITY:
 *    Fresh boot: only shows installed packages (typically just routeros).
 *    After check-for-updates: reveals all available packages in the list.
 *    After disable+apply-changes: disabled packages remain visible with disabled=true.
 *
 * 4. ENABLE/DISABLE FLOW:
 *    POST /rest/system/package/enable  {"numbers":"<name>"} → returns []
 *    POST /rest/system/package/disable {"numbers":"<name>"} → returns []
 *    Both set scheduled="scheduled for install" or "scheduled for disable".
 *    Changes are NOT applied until apply-changes or reboot.
 *
 * 5. CRITICAL: apply-changes vs reboot
 *    - POST /rest/system/package/apply-changes → triggers reboot AND applies changes ✅
 *    - POST /rest/system/reboot → triggers reboot but DOES NOT apply changes ❌
 *    This is the biggest gotcha. A plain reboot discards pending package changes!
 *    apply-changes is the ONLY reliable path. It returns [] and triggers a reboot.
 *
 *    UPDATE: After more testing, behavior may be inconsistent. The safest pattern
 *    is always to use apply-changes rather than manual reboot.
 *
 * 6. check-for-updates RESPONSE SHAPE (async array with .section):
 *    [
 *      {".section":"0", "channel":"stable", "installed-version":"7.22.1",
 *       "status":"finding out latest version..."},
 *      {".section":"1", "channel":"stable", "installed-version":"7.22.1",
 *       "latest-version":"7.22.1", "status":"getting changelog..."},
 *      {".section":"2", "channel":"stable", "installed-version":"7.22.1",
 *       "latest-version":"7.22.1", "status":"System is already up to date"}
 *    ]
 *
 * 7. GET /rest/system/package/update returns:
 *    {"channel":"stable","installed-version":"7.22.1"}
 *    After check-for-updates adds: "latest-version":"7.22.1","status":"System is already up to date"
 *
 * 8. Channel can be changed:
 *    POST /rest/system/package/update/set {"channel":"long-term"} → []
 *
 * 9. DEVICE-MODE DEPENDENCY:
 *    Container package REQUIRES device-mode container=yes to function.
 *    The package can be installed without device-mode, but /container
 *    commands will fail with "not allowed by device-mode".
 *
 * 10. SCP UPLOAD NOT NEEDED for built-in packages on CHR 7.22.1+.
 *     enable + apply-changes is sufficient. SCP is only needed for
 *     third-party packages or if the package isn't in the built-in set.
 *
 * RECOMMENDED PATTERN FOR QUICKCHR:
 *   1. POST /rest/system/package/update/check-for-updates (reveals available)
 *   2. POST /rest/system/package/enable {"numbers":"<name>"}
 *   3. POST /rest/system/package/apply-changes {} (triggers reboot)
 *   4. waitForBoot()
 *   5. GET /rest/system/package to verify installed
 *
 * ═══════════════════════════════════════════════════════════════════════
 * RAW RESPONSE SHAPES
 * ═══════════════════════════════════════════════════════════════════════
 *
 * GET /rest/system/package (fresh boot, only routeros):
 * [{"id":"*1","available":"false","build-time":"2026-03-23 14:35:15",
 *   "disabled":"false","name":"routeros","scheduled":"","size":"20706188",
 *   "version":"7.22.1"}]
 *
 * GET /rest/system/package (after check-for-updates, extra packages):
 * [
 *   {".id":"*1","available":"false","disabled":"false","name":"routeros",
 *    "scheduled":"","size":"20706188","version":"7.22.1","build-time":"..."},
 *   {".id":"*2","available":"true","disabled":"true","name":"calea",
 *    "scheduled":"","size":"24721","version":""},
 *   {".id":"*3","available":"true","disabled":"true","name":"container",
 *    "scheduled":"","size":"897169","version":""},
 *   ... (12 total)
 * ]
 *
 * GET /rest/system/package (container installed and active):
 * [
 *   {".id":"*1","available":"false","disabled":"false","name":"container",
 *    "scheduled":"","size":"897169","version":"7.22.1","build-time":"..."},
 *   {".id":"*2","available":"false","disabled":"false","name":"routeros",
 *    "scheduled":"","size":"20706188","version":"7.22.1","build-time":"..."}
 * ]
 *
 * POST /rest/system/package/enable {"numbers":"container"} → []
 * POST /rest/system/package/disable {"numbers":"container"} → []
 * POST /rest/system/package/apply-changes {} → [] (then reboots)
 *
 * ═══════════════════════════════════════════════════════════════════════
 */

import { describe, test, expect } from "bun:test";

const CHR_PORT = 9100;
const BASE_URL = `http://127.0.0.1:${CHR_PORT}`;
const AUTH = `Basic ${btoa("admin:")}`;

async function restGet(
	path: string,
	timeoutMs = 5_000,
): Promise<{ status: number; body: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const resp = await fetch(`${BASE_URL}${path}`, {
			headers: { Authorization: AUTH },
			signal: controller.signal,
		});
		return { status: resp.status, body: await resp.text() };
	} finally {
		clearTimeout(timer);
	}
}

async function restPost(
	path: string,
	body: Record<string, unknown>,
	timeoutMs = 5_000,
): Promise<{ status: number; body: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const resp = await fetch(`${BASE_URL}${path}`, {
			method: "POST",
			headers: {
				Authorization: AUTH,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		return { status: resp.status, body: await resp.text() };
	} finally {
		clearTimeout(timer);
	}
}

describe.skipIf(!process.env.QUICKCHR_INTEGRATION)(
	"Lab: /system/package",
	() => {
		test("GET baseline — package list", async () => {
			const { status, body } = await restGet("/rest/system/package");
			expect(status).toBe(200);

			const pkgs = JSON.parse(body);
			expect(Array.isArray(pkgs)).toBe(true);
			console.log("[packages]", JSON.stringify(pkgs, null, 2));

			// routeros should always be present
			const routeros = pkgs.find(
				(p: { name: string }) => p.name === "routeros",
			);
			expect(routeros).toBeDefined();
			expect(routeros.disabled).toBe("false");
			expect(routeros.version).toMatch(/^\d+\.\d+/);
		});

		test("GET /system/package/update baseline", async () => {
			const { status, body } = await restGet(
				"/rest/system/package/update",
			);
			expect(status).toBe(200);
			const data = JSON.parse(body);
			console.log("[package/update]", data);

			expect(data.channel).toBeDefined();
			expect(data["installed-version"]).toMatch(/^\d+\.\d+/);
		});

		test(
			"check-for-updates returns async section array",
			async () => {
				const { status, body } = await restPost(
					"/rest/system/package/update/check-for-updates",
					{},
					15_000,
				);
				expect(status).toBe(200);

				const sections = JSON.parse(body);
				expect(Array.isArray(sections)).toBe(true);
				console.log("[check-for-updates]", JSON.stringify(sections));

				// Should have multiple sections with progressive status
				expect(sections.length).toBeGreaterThanOrEqual(2);
				expect(sections[0]).toHaveProperty("status");

				// First section starts with "finding out"
				expect(sections[0].status).toContain("finding out");

				// Sections have .section field (access via bracket notation; Bun treats "." as path separator)
				expect(sections[0][".section"]).toBeDefined();
			},
			20_000,
		);

		test(
			"check-for-updates reveals available packages",
			async () => {
				// Run check first
				await restPost(
					"/rest/system/package/update/check-for-updates",
					{},
					15_000,
				);

				// Now list should show available packages
				const { body } = await restGet("/rest/system/package");
				const pkgs = JSON.parse(body);

				// Should have more than just routeros
				const available = pkgs.filter(
					(p: { available: string }) => p.available === "true",
				);
				console.log(
					"[available packages]",
					available.map(
						(p: { name: string; size: string }) =>
							`${p.name} (${p.size}b)`,
					),
				);

				// Container should be in the list (may already be installed from prior tests)
				const container = pkgs.find(
					(p: { name: string }) => p.name === "container",
				);
				expect(container).toBeDefined();
				expect(["true", "false"]).toContain(container.available);
			},
			20_000,
		);

		test("enable returns empty array (success)", async () => {
			// Run check-for-updates first to reveal packages
			await restPost(
				"/rest/system/package/update/check-for-updates",
				{},
				15_000,
			);

			const { status, body } = await restPost(
				"/rest/system/package/enable",
				{ numbers: "container" },
			);
			expect(status).toBe(200);
			expect(body).toBe("[]");

			// Verify scheduled field (may already be installed, in which case scheduled="")
			const { body: listBody } = await restGet("/rest/system/package");
			const pkgs = JSON.parse(listBody);
			const container = pkgs.find(
				(p: { name: string }) => p.name === "container",
			);
			// "scheduled for enable" on fresh, "" if already installed
			expect(["scheduled for enable", ""]).toContain(container.scheduled);

			// Clean up: undo the scheduled enable to avoid interfering with other tests
			if (container.scheduled) {
				await restPost("/rest/system/package/disable", {
					numbers: "container",
				});
			}
		});

		// NOTE: apply-changes triggers a reboot — only run this test
		// if you want the CHR to restart
		test.skip("apply-changes triggers reboot (destructive)", async () => {
			const { status, body } = await restPost(
				"/rest/system/package/apply-changes",
				{},
			);
			expect(status).toBe(200);
			expect(body).toBe("[]");
			// CHR will reboot now — must waitForBoot() afterward
		});
	},
);
