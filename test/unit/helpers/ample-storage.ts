/**
 * Replace the storage gate with one that always has room (#193).
 *
 * Unit tests that reach `add()`/`start()` are about what those do, not about the
 * host's free space. The real gate measures whatever filesystem holds the test's data
 * dir — `df` on POSIX, `statfsSync` on Windows — so on a small checkout it refuses
 * `INSUFFICIENT_DISK_SPACE` before the code under test runs. Stubbing the gate itself,
 * rather than `df` or `statfsSync`, covers both platforms with one boundary.
 *
 * Import it for its side effect in a worker, or load it into a spawned CLI with
 * `bun --preload <this file>`. Either way it must run before `quickchr.ts` is loaded.
 * The gate's own behaviour is covered in storage.test.ts.
 */
import { spyOn } from "bun:test";
import * as storage from "../../../src/lib/storage.ts";

spyOn(storage, "assertSufficientQuickchrStorage").mockImplementation(() => storage.getQuickchrStorageReport(0, 0));
