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

## CLI Conventions

Four rules the CLI layer enforces centrally. A new subcommand gets `--help` handling
and flag arity for free; it has to opt into the other two.

- **`--help` is answered before dispatch.** The guard is in `main()`
  (`wantsCommandHelp`), not per-command, so a new subcommand cannot forget it.
  Give every command a `printCommandHelp()` case — `test/unit/cli-help-guard.test.ts`
  fails a command that falls through to "No detailed help". The scan stops at a bare
  `--`: everything after it is the caller's payload.
- **A machine-creating command validates its flags.** `add` and `start` check against
  `ADD_FLAGS` / `START_FLAGS` in `src/cli/flags.ts`. **Adding a flag to either command
  means adding it to that registry** — a test cross-checks the registry against each
  command's own help text, so the two cannot drift. Read-only commands stay tolerant
  of stray arguments on purpose.
- **A flag's arity is declared, never guessed.** `VALUE_FLAGS` in `src/cli/flags.ts`
  is `parseFlags`'s arity table, not just a validation list: a flag in it consumes the
  next argument, and a flag absent from it is boolean and leaves the next argument
  alone. **A new value-taking flag goes in that set** — `test/unit/cli-flag-arity.test.ts`
  scans the CLI source for every flag read, both the helpers (`flag()`, `flagList()`,
  `flagBool()`) and direct access (`flags["older-than"]`, `flags.accel`), and fails if a
  name is read as a value without being declared, or read as a boolean while declared.
  The direct-access half is not decoration: three `cache prune` flags are read that way,
  and a helpers-only audit called the registry complete while `--older-than` had already
  stopped taking its value. A removed flag name goes in `REMOVED_FLAGS` and errors with its
  replacement, so it cannot come back as a silently ignored argument.
- **Tips go to stderr.** `src/cli/tips.ts`. stdout is the command's result and has to
  stay usable in a pipe; a tip names a next command or a better-suited tool, never restates
  what just happened, and is suppressible with `QUICKCHR_NO_TIPS=1`. `exec` points at
  `centrs --quickchr` because quickchr's `exec` is a raw `/rest/execute` pipe with no
  command validation.

**Nothing quickchr creates may require `rm -rf` on the data dir to clear.** A failed
`add` removes the directory it made; `remove` clears a directory with no readable
`machine.json`; `doctor` names `quickchr remove <name>`. Resource names
(`src/lib/names.ts`) are validated before any write, since they become path segments.

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
