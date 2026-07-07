---
applyTo: "src/**"
---

# General Code Instructions

## Runtime

- **Bun** — not Node.js. Always use Bun APIs: `Bun.spawn()`, `Bun.write()`, `Bun.sleep()`.
- All code is ESM. Use `.ts` extensions in relative imports.
- No CommonJS (`require`, `module.exports`).

## Layer Rules

- `src/lib/` — Pure library. NEVER import from `src/cli/`. No `process.exit()`.
- `src/cli/` — CLI wrapper. May import from `src/lib/`. Owns terminal output and `process.exit()`.
- `src/index.ts` — Public barrel export. Only re-exports from `src/lib/`.

## Error Handling

- Throw `QuickCHRError(code, message, installHint?)` from library code.
- CLI layer catches errors and prints user-friendly messages.
- The canonical list of codes is the `ErrorCode` union in `src/lib/types.ts` — keep that as the single source of truth. Commonly thrown: `MISSING_QEMU`, `MISSING_FIRMWARE`, `PORT_CONFLICT`, `DOWNLOAD_FAILED`, `BOOT_TIMEOUT`, `QGA_TIMEOUT`, `QGA_UNSUPPORTED`, `MACHINE_STOPPED`, `MACHINE_RUNNING`, `INVALID_VERSION`, `EXEC_FAILED`, `SPAWN_FAILED`, `STATE_ERROR`.
- There is no bare `TIMEOUT` code — boot waits throw `BOOT_TIMEOUT`, QGA waits throw `QGA_TIMEOUT`.

## Key API Patterns

- `QuickCHR.start(opts)` returns `ChrInstance` — the runtime handle.
- `ChrInstance` has: `.stop()`, `.remove()`, `.rest()`, `.monitor()`, `.serial()`, `.qga()`, `.ports`, `.state`.
- Port blocks: 10 ports per instance, base 9100. Offsets: +0=HTTP, +1=HTTPS, +2=SSH, +3=API, +4=API-SSL, +5=WinBox.

## RouterOS "expired admin" Caveat

The `expired: true` flag on the default admin account does NOT block REST API access.
It only affects CLI/Winbox/SSH login (shows a password-change prompt, bypassable with Ctrl-C).
Do not add workarounds targeting `expired` for REST paths — if REST fails early,
the root cause is a startup timing race, not the expired flag.

## Style

- Biome 2.x lint only (no formatting). Run: `bun run lint:biome`.
- Tabs for indentation.
- No unnecessary comments on obvious code.

## End-of-Session Review

After completing significant work (new features, design changes, bug fixes with architectural impact), check:

1. **GitHub issue** — Close the issue this work resolved, or open one for follow-up work you uncovered. Work is tracked in Issues, not BACKLOG.md — see CONTRIBUTING.md "Tracking work".
2. **Durable knowledge** — Record any new design decision or discovered constraint in **DESIGN.md**, and any grounded RouterOS/QEMU behaviour fact in the narrowest scoped doc (`.github/instructions/*.md`, `docs/`, or `test/lab/<topic>/REPORT.md`). Review the git diff for "added but undocumented" behavior. Do not re-grow BACKLOG.md.
3. **CHANGELOG.md** — Add an entry if the change is user-facing.
4. **If the work landed on a PR — resolve every review conversation thread.** This one *is* a hard merge gate (`required_conversation_resolution`), not a habit. **Replying to a finding does NOT resolve its thread** — resolving is a separate, explicit action, and an unresolved thread silently blocks the merge button even with all-green CI and every finding answered. After you fix or grounded-dismiss each finding, resolve the threads — in the UI ("Resolve conversation") or in bulk:

   ```sh
   # PR = the PR number. List still-unresolved threads:
   gh api graphql -f query='query{repository(owner:"tikoci",name:"quickchr"){pullRequest(number:PR){reviewThreads(first:50){nodes{id isResolved path line}}}}}' \
     --jq '.data.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved==false)|"\(.id)\t\(.path):\(.line)"'
   # Resolve one (repeat per id above):
   gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=THREAD_ID
   ```

   Then confirm `gh pr view PR --json mergeStateStatus` reads `CLEAN`. Do NOT resolve a *human* reviewer's thread on their behalf without addressing it — bot threads (Copilot/CodeRabbit) you own once the finding is handled.

Steps 1–3 are a lightweight habit — skip for trivial changes. Step 4 is a gate whenever a PR exists.
