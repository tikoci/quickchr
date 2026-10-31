#!/usr/bin/env bun
/**
 * ci-plan — guards on the integration plan matrix.
 *
 *   printf '%s' "$MATRIX_JSON" | bun scripts/ci-plan.ts check
 *
 * WHY THIS EXISTS. Two legs on one platform resolving to one version
 * (`routeros-targets=stable,7.25` when stable IS 7.25) are indistinguishable
 * in every downstream identity: same suite-record target, same checkpoint
 * external_id, same ndjson filename, same ledger key. The second leg adds no
 * signal — it overwrites the first's checkpoint entry, collides its ndjson
 * file, and shares its ledger row. The plan used to demote the second leg to
 * cache-reader and run both; that fixed only the cache race. Now the plan
 * rejects such a matrix outright: a dispatch that cannot produce attributable
 * results fails here in seconds with a named error instead of running legs
 * whose evidence overwrites each other (#245).
 */
import { plannedLegKey } from "./ci-leg-ledger.ts";

/** One matrix entry, reduced to what the guards read. */
export interface MatrixLeg {
	id: string;
	label: string;
	target: string;
	resolved?: string;
}

/** One platform+version dispatched more than once. */
export interface DuplicateLegs {
	platform: string;
	resolved: string;
	targets: string[];
}

/**
 * Matrix legs sharing one reconciliation identity, in dispatch order within
 * each group and sorted across groups. Identity is {@link plannedLegKey} —
 * the resolved version, falling back to the label — so this is the same rule
 * the ledger reconciles under, checked before anything runs.
 */
export function findDuplicateLegs(legs: readonly MatrixLeg[]): DuplicateLegs[] {
	const groups = new Map<string, MatrixLeg[]>();
	for (const leg of legs) {
		const key = plannedLegKey(leg);
		const group = groups.get(key);
		if (group) group.push(leg);
		else groups.set(key, [leg]);
	}
	const out: DuplicateLegs[] = [];
	for (const key of [...groups.keys()].sort()) {
		const group = groups.get(key) ?? [];
		if (group.length < 2) continue;
		const first = group[0];
		if (!first) continue;
		out.push({
			platform: first.id,
			resolved: first.resolved ?? first.target,
			targets: group.map((l) => l.target),
		});
	}
	return out;
}

async function check(): Promise<void> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await Bun.stdin.text());
	} catch {
		console.log("::error title=Plan matrix::plan matrix is not valid JSON — refusing to emit it");
		process.exit(1);
	}
	const legs = Array.isArray(parsed) ? parsed : (parsed as { include?: unknown }).include;
	if (!Array.isArray(legs)) {
		console.log("::error title=Plan matrix::plan matrix is neither an array nor {include: [...]} — refusing to emit it");
		process.exit(1);
	}
	const duplicates = findDuplicateLegs(legs as MatrixLeg[]);
	if (duplicates.length === 0) return;
	for (const group of duplicates) {
		console.log(
			`::error title=Plan matrix::${group.platform} · ${group.resolved} is dispatched ${group.targets.length}× (targets: ${group.targets.join(", ")}) — legs sharing one platform+version are indistinguishable downstream (suite record, checkpoint id, ndjson file, ledger row) and overwrite each other's evidence. Drop all but one of these targets.`,
		);
	}
	process.exit(1);
}

if (import.meta.main) {
	if (process.argv[2] === "check") await check();
	else {
		console.error("usage: <matrix json> | ci-plan check");
		process.exit(2);
	}
}
