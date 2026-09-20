/**
 * Tips — short, dim, one-line pointers at the thing that would have gone better.
 *
 * Three rules, so tips stay useful instead of becoming chrome:
 *
 * 1. **stderr, always.** stdout is the command's result and has to stay parseable:
 *    `quickchr inspect --json | jq` must not have to filter advice out of its input.
 * 2. **A tip names a next command or a better-suited tool.** It never restates what
 *    just happened, and it never appears where the command already said the thing.
 * 3. **Suppressible.** `QUICKCHR_NO_TIPS=1` silences them. Not gated on TTY: the
 *    audience for "you probably wanted X" is agents and first-time users, both of
 *    which usually run without one.
 */

/** Where quickchr stops and a validating RouterOS client starts.
 *
 *  quickchr's `exec` is a thin `/rest/execute` pipe: it will happily send a command
 *  RouterOS rejects, and hand back the rejection. centrs validates a RouterOS-shaped
 *  command before running it and has a per-verb help system — the difference between
 *  one round trip and five. It takes a verb first (`retrieve` to read, `execute` to
 *  write, `explain` to analyze without running) and resolves the machine through
 *  `quickchr inspect`; see docs/centrs-interface.md. */
export const CENTRS_EXEC_TIP =
	"centrs validates RouterOS commands before running them: centrs execute --quickchr <name> <command>";

/** The same pointer, as a help-text block. Help is where a reader is already asking
 *  "what should I use for this?", so it gets the fuller version. */
export const CENTRS_SEE_ALSO = `See also — centrs (@tikoci/centrs) validates a RouterOS-shaped command
before running it, and has per-verb help. 'quickchr exec' does not: it is a
raw /rest/execute pipe, and whatever you type is what RouterOS is asked to run.

  centrs retrieve --quickchr <name> /system/resource    Read state
  centrs execute  --quickchr <name> <command>           Run a read/write command
  centrs explain  <command>                             Analyze without running it

centrs resolves the machine through 'quickchr inspect' — it never reads machine.json.
Install: bun add -g @tikoci/centrs`;

/** True when tips are switched off for this run. */
export function tipsSuppressed(): boolean {
	const value = process.env.QUICKCHR_NO_TIPS;
	return value !== undefined && value !== "" && value !== "0";
}

/** Print one tip line to stderr. No-op when tips are suppressed. */
export function tip(line: string): void {
	if (tipsSuppressed()) return;
	const dim = process.env.NO_COLOR ? (s: string) => s : (s: string) => `\x1b[2m${s}\x1b[0m`;
	console.error(dim(`tip: ${line}`));
}

/** Tips that belong with a specific error code, printed by the CLI's error handler.
 *  `command` is the subcommand that failed, so a tip can stay scoped to where it helps. */
export function tipsForError(code: string, command?: string): string[] {
	if (code === "EXEC_FAILED" && command === "exec") return [CENTRS_EXEC_TIP];
	return [];
}
