/** Preload for CLI subprocess tests (#316): every `fetch()` in the process is
 *  answered locally, so a test that runs `quickchr version` never reaches
 *  upgrade.mikrotik.com. `QUICKCHR_TEST_UPGRADE_STUB` picks the answer:
 *
 *  - `answer`: each `NEWESTa7.<channel>` URL gets the body the real server sends,
 *    `"<version> <unix time>"`, from `upgrade-server-stub-versions.ts`.
 *  - `offline`: every fetch throws a plain error. It is deliberately not a
 *    connection-class failure, so `fetchResilient` does not go on to try public
 *    DNS, which would be a network call of its own.
 *
 *  Any other URL throws as well, so a new network call on this path shows up as
 *  a failed assertion rather than a slow test.
 *
 *  Load it only with `bun --preload` in a spawned CLI, never by importing it from
 *  a test file: it replaces `fetch` for the whole process. */
import { STUB_CHANNEL_VERSIONS } from "./upgrade-server-stub-versions.ts";

const mode = process.env.QUICKCHR_TEST_UPGRADE_STUB ?? "answer";
const UPGRADE_URL = /^https:\/\/upgrade\.mikrotik\.com\/routeros\/NEWESTa7\.([a-z-]+)$/;

const stubFetch = async (input: string | URL | Request): Promise<Response> => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	if (mode === "offline") throw new Error(`upgrade-server stub: offline (${url})`);
	const channel = UPGRADE_URL.exec(url)?.[1];
	const version = channel === undefined ? undefined : STUB_CHANNEL_VERSIONS[channel];
	if (version === undefined) throw new Error(`upgrade-server stub: unexpected fetch ${url}`);
	return new Response(`${version} 1774276515\n`);
};

globalThis.fetch = Object.assign(stubFetch, { preconnect: () => {} }) as unknown as typeof fetch;
