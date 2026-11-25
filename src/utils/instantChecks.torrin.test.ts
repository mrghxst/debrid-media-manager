import type { SearchResult } from '@/services/mediasearch';
import fixture from '@/test/fixtures/torrin/source-derived-06a40e41.json';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const checkTorrinCache = vi.hoisted(() => vi.fn());
vi.mock('@/services/torrin', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/services/torrin')>()),
	checkTorrinCache,
}));

import { checkAvailabilityTr, checkAvailabilityTr2 } from './instantChecks';

/** A list held the way a page holds it, so the setter sees what a render would. */
const harness = <T>(initial: T[]) => {
	let state = initial;
	const setter = vi.fn((update: T[] | ((prev: T[]) => T[])) => {
		state = typeof update === 'function' ? update(state) : update;
	});
	return { setter, state: () => state };
};

const row = (hash: string, extra: Partial<SearchResult> = {}) =>
	({
		hash,
		title: hash,
		fileSize: 0,
		noVideos: false,
		files: [],
		medianFileSize: 0,
		biggestFileSize: 0,
		videoCount: 0,
		...extra,
	}) as SearchResult;

const identity = <T>(rows: T[]) => rows;
const checked = fixture['check-mixed'].body.data.items;
const [CACHED, ACCELERATABLE, UNKNOWN] = checked.map((item) => item.hash);

beforeEach(() => checkTorrinCache.mockReset());

describe('Torrin instant check', () => {
	// The client has already turned Torrin's answer into one result per hash.
	const answer = () =>
		checked.map((item) => ({
			hash: item.hash,
			status: item.status,
			name: item.name ?? '',
			files: item.status === 'cached' ? item.files : [],
		}));

	it('marks only what Torrin calls cached, never an acceleratable claim', async () => {
		expect(checked.map((item) => item.status)).toEqual(['cached', 'acceleratable', 'unknown']);
		checkTorrinCache.mockResolvedValue(answer());
		const { setter, state } = harness([row(CACHED), row(ACCELERATABLE), row(UNKNOWN)]);

		const hits = await checkAvailabilityTr(
			'tr-key',
			[CACHED, ACCELERATABLE, UNKNOWN],
			setter,
			identity
		);

		expect(hits).toBe(1);
		expect(checkTorrinCache).toHaveBeenCalledWith('tr-key', [CACHED, ACCELERATABLE, UNKNOWN]);
		expect(state().map((r) => Boolean(r.trAvailable))).toEqual([true, false, false]);
	});

	it('gives a row scraped without a size the total of the files Torrin lists', async () => {
		checkTorrinCache.mockResolvedValue(answer());
		const { setter, state } = harness([row(CACHED), row(UNKNOWN)]);

		await checkAvailabilityTr('tr-key', [CACHED, UNKNOWN], setter, identity);

		const total = checked[0].files.reduce((acc, file) => acc + (file.size ?? 0), 0);
		expect(total).toBeGreaterThan(0);
		expect(state()[0].fileSize).toBeCloseTo(total / 1024 / 1024);
		// The files are not kept: each carries a signed stream link.
		expect(JSON.stringify(state())).not.toContain('stream.example.test');
	});

	it('keeps a size the row already has', async () => {
		checkTorrinCache.mockResolvedValue(answer());
		const { setter, state } = harness([row(CACHED, { fileSize: 1234 })]);

		await checkAvailabilityTr('tr-key', [CACHED], setter, identity);

		expect(state()[0].fileSize).toBe(1234);
	});

	it('skips a row known to hold no video, as every instant check does', async () => {
		checkTorrinCache.mockResolvedValue(answer());
		const { setter, state } = harness([row(CACHED, { noVideos: true })]);

		expect(await checkAvailabilityTr('tr-key', [CACHED], setter, identity)).toBe(0);
		expect(state()[0].trAvailable).toBeUndefined();
	});

	it('does not touch the list when nothing is cached', async () => {
		checkTorrinCache.mockResolvedValue(answer().slice(1));
		const { setter } = harness([row(ACCELERATABLE)]);

		expect(await checkAvailabilityTr2('tr-key', [ACCELERATABLE], setter as any)).toBe(0);
		expect(setter).not.toHaveBeenCalled();
	});

	it('matches a mixed-case hash on the page', async () => {
		checkTorrinCache.mockResolvedValue(answer());
		const { setter, state } = harness([row(CACHED.toUpperCase())]);

		await checkAvailabilityTr('tr-key', [CACHED], setter, identity);

		expect(state()[0].trAvailable).toBe(true);
	});
});
