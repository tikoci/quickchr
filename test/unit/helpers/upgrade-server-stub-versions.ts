/** The channel → version map `upgrade-server-preload.ts` answers with (#316).
 *  A module of its own so a test can import it: importing the preload itself
 *  would replace `fetch` in the test runner too. */
export const STUB_CHANNEL_VERSIONS: Record<string, string> = {
	stable: "7.25.1",
	"long-term": "7.20.8",
	testing: "7.26rc2",
	development: "7.26beta5",
};
