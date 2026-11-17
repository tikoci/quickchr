/** Preload for CLI subprocess tests (#259): every signal to the pid named by
 *  `QUICKCHR_TEST_FOREIGN_PID` is refused with EPERM, as it would be for a root-owned
 *  QEMU. Every other pid behaves normally. */
const foreign = Number(process.env.QUICKCHR_TEST_FOREIGN_PID);
const realKill = process.kill.bind(process);

process.kill = ((pid: number, signal?: string | number) => {
	if (pid === foreign) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
	return realKill(pid, signal);
}) as typeof process.kill;
