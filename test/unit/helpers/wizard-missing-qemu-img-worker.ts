import { mock } from "bun:test";
import { QuickCHRError } from "../../../src/lib/types.ts";

const platform = await import("../../../src/lib/platform.ts");
const images = await import("../../../src/lib/images.ts");

const calls = { prompts: 0, downloads: 0, starts: 0 };
const unexpectedPrompt = () => {
	calls.prompts++;
	throw new Error("Wizard prompted before checking qemu-img");
};
mock.module("@clack/prompts", () => ({
	intro: () => {},
	select: unexpectedPrompt,
	text: unexpectedPrompt,
	confirm: unexpectedPrompt,
	isCancel: () => false,
	log: { info: () => {}, warn: () => {} },
}));
mock.module("../../../src/lib/platform.ts", () => ({
	...platform,
	requireQemuImg: () => { throw new QuickCHRError("MISSING_QEMU", "qemu-img not found (required for disk operations)", "Install QEMU including qemu-img"); },
	findQemuImg: () => undefined,
	getQemuInstallHint: () => "Install QEMU including qemu-img",
}));
mock.module("../../../src/lib/images.ts", () => ({
	...images,
	ensureCachedImage: () => { calls.downloads++; throw new Error("Unexpected image download"); },
}));
mock.module("../../../src/lib/quickchr.ts", () => ({
	QuickCHR: { start: () => { calls.starts++; throw new Error("Unexpected start"); } },
}));
const { runWizard } = await import("../../../src/cli/wizard.ts");
try {
	await runWizard();
	throw new Error("Expected missing-tool refusal");
} catch (error) {
	console.log(JSON.stringify({
		...calls,
		code: error instanceof QuickCHRError ? error.code : null,
		message: error instanceof Error ? error.message : String(error),
		installHint: error instanceof QuickCHRError ? error.installHint : null,
	}));
}
