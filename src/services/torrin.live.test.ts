// @vitest-environment node
//
// Node, not jsdom: the client aborts its own timeouts with an AbortController,
// and jsdom's AbortSignal is a different realm's object than the undici fetch
// underneath it, which rejects it outright. A browser has one realm for both.
import { describe, expect, it } from 'vitest';
import {
	TORRIN_CACHE_STATUSES,
	TORRIN_MAGNET_STATUSES,
	addTorrinMagnet,
	checkTorrinCache,
	deleteTorrinMagnet,
	getTorrinMagnet,
	getTorrinUser,
	listTorrinMagnets,
	torrinMagnetHash,
} from './torrin';

/**
 * Opt-in live checks against a real Torrin account.
 *
 * Skipped unless TORRIN_LIVE_KEY is set, so `npm run test` never reaches Torrin.
 * Use a key made for this with "login allowed" off. The default checks only
 * read: the account, the download list, one download's files and a cache check
 * (which adds nothing). NEXT_PUBLIC_TORRIN_BASE_URL points them at a self-hosted
 * Torrin instead of torrin.app.
 *
 * TORRIN_LIVE_MUTATE=1 also adds TORRIN_LIVE_HASH (Big Buck Bunny by default),
 * adds it a second time to check the dedupe, reads it back by id and removes
 * it again. It does nothing when the account already holds the hash, or when
 * the cache check answers `unknown`. Unless the answer is `cached`, the add
 * starts a real download, which uses one of the plan's hourly downloads and
 * may count toward its monthly limit (about 276 MB for the default) even
 * though the removal cancels it. `acceleratable` is no guarantee, since it has
 * been seen for every hash asked. A removed download that finished stays in
 * Torrin's shared cache.
 *
 *	TORRIN_LIVE_KEY=<key> npx vitest run --config vitest.live.config.ts src/services/torrin.live.test.ts
 *
 * Nothing is printed from the account: stream links are signed and work as a
 * key to the file, and names and hashes are the account's own.
 */
const KEY = process.env.TORRIN_LIVE_KEY;
const MUTATE = process.env.TORRIN_LIVE_MUTATE === '1';
const HASH = process.env.TORRIN_LIVE_HASH ?? 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c';

describe.skipIf(!KEY)('Integration: Torrin live reads', () => {
	it('reads the account, every download, one download and a cache check', async () => {
		const user = await getTorrinUser(KEY!);
		expect(typeof user.id).toBe('string');

		const magnets = await listTorrinMagnets(KEY!);
		expect(new Set(magnets.map((m) => m.id)).size).toBe(magnets.length);
		for (const magnet of magnets) {
			expect(TORRIN_MAGNET_STATUSES).toContain(magnet.status);
		}

		const downloaded = magnets.find((m) => m.status === 'downloaded');
		if (downloaded) {
			const full = await getTorrinMagnet(KEY!, downloaded.id);
			expect(full.id).toBe(downloaded.id);
			for (const file of full.files ?? []) {
				expect(typeof file.index).toBe('number');
				expect(typeof file.link).toBe('string');
			}
		}

		const [probe] = await checkTorrinCache(KEY!, [HASH]);
		expect(probe.hash).toBe(HASH);
		expect(TORRIN_CACHE_STATUSES).toContain(probe.status);

		console.log(
			`live: downloads=${magnets.length} withDownloaded=${Boolean(downloaded)} probe=${probe.status}`
		);
	}, 60_000);
});

describe.skipIf(!KEY || !MUTATE)('Integration: Torrin live add (TORRIN_LIVE_MUTATE=1)', () => {
	it('adds a magnet, reads it back by id and removes it again', async () => {
		const held = (await listTorrinMagnets(KEY!)).some((m) => torrinMagnetHash(m) === HASH);
		if (held) {
			console.log('live: the account already holds the hash; not adding or removing it');
			return;
		}
		const [probe] = await checkTorrinCache(KEY!, [HASH]);
		if (probe.status === 'unknown') {
			console.log('live: Torrin cannot fetch the hash fast; not starting a real download');
			return;
		}
		const added = await addTorrinMagnet(KEY!, `magnet:?xt=urn:btih:${HASH}`);
		// Torrin dedupes per account and hash, so a second add is the same download.
		const again = await addTorrinMagnet(KEY!, HASH);
		expect(again.id).toBe(added.id);

		const fresh = await getTorrinMagnet(KEY!, added.id);
		expect(fresh.id).toBe(added.id);
		await deleteTorrinMagnet(KEY!, added.id);
		console.log(`live: added status=${added.status} now=${fresh.status}`);
	}, 60_000);
});
