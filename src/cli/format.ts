/**
 * CLI output formatting — tables, colors, status indicators.
 */

const COLORS = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	cyan: "\x1b[36m",
} as const;

const NO_COLORS = Object.fromEntries(
	Object.keys(COLORS).map((k) => [k, ""]),
) as typeof COLORS;

function c(): typeof COLORS {
	// Respect NO_COLOR env and pipe detection
	if (process.env.NO_COLOR || !process.stdout.isTTY) return NO_COLORS;
	return COLORS;
}

export function statusIcon(status: string): string {
	const col = c();
	switch (status) {
		case "running": return `${col.green}●${col.reset}`;
		case "stopped": return `${col.dim}○${col.reset}`;
		case "error": return `${col.red}✗${col.reset}`;
		case "ok": return `${col.green}✓${col.reset}`;
		case "warn": return `${col.yellow}⚠${col.reset}`;
		default: return `${col.dim}?${col.reset}`;
	}
}

export function bold(text: string): string {
	const col = c();
	return `${col.bold}${text}${col.reset}`;
}

export function dim(text: string): string {
	const col = c();
	return `${col.dim}${text}${col.reset}`;
}

export function cyan(text: string): string {
	const col = c();
	return `${col.cyan}${text}${col.reset}`;
}

/** Format a simple table with columns. */
export function table(headers: string[], rows: string[][]): string {
	const widths = headers.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => stripAnsi(r[i] ?? "").length)),
	);

	const sep = widths.map((w) => "─".repeat(w + 2)).join("┼");
	const headerLine = headers
		.map((h, i) => ` ${bold(h.padEnd(widths[i]!))} `)
		.join("│");
	const dataLines = rows.map((row) =>
		row.map((cell, i) => {
			const stripped = stripAnsi(cell);
			const padding = (widths[i] ?? 0) - stripped.length;
			return ` ${cell}${" ".repeat(Math.max(0, padding))} `;
		}).join("│"),
	);

	return [headerLine, sep, ...dataLines].join("\n");
}

/** Strip ANSI escape codes for width calculation. */
function stripAnsi(str: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires matching ESC (0x1b)
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Format port mappings as a compact string. */
export function formatPorts(ports: Record<string, { host: number; guest: number }>): string {
	return Object.entries(ports)
		.map(([name, p]) => `${name}:${p.host}`)
		.join(" ");
}

/** Format a clickable URL (some terminals support this). */
export function link(url: string, label?: string): string {
	const col = c();
	if (!process.stdout.isTTY) return label ?? url;
	return `${col.cyan}${label ?? url}${col.reset}`;
}
