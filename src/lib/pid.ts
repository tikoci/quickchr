/** What a signal-0 probe says about a pid.
 *  - `alive`: the process exists and this user may signal it.
 *  - `foreign`: the process exists but belongs to another user (`EPERM`) — for
 *    example a QEMU started with `sudo quickchr start` for native vmnet. It is
 *    running; this process just cannot stop it.
 *  - `dead`: no such process (`ESRCH`, or any other error).
 *
 *  `EPERM` must never read as dead: that once let `list` persist `stopped` over a
 *  root-owned QEMU, after which `stop` claimed success and a later `start` could put
 *  a second QEMU on the same disk (#259). */
export type PidLiveness = "alive" | "foreign" | "dead";

export function pidLiveness(pid: number): PidLiveness {
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM" ? "foreign" : "dead";
	}
}
