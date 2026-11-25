import fixture from '@/test/fixtures/torrin/source-derived-06a40e41.json';
import { UserTorrentStatus } from '@/torrent/userTorrent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tr = vi.hoisted(() => ({
	addTorrinMagnet: vi.fn(),
	deleteTorrinMagnet: vi.fn(),
}));
vi.mock('@/services/torrin', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/services/torrin')>()),
	...tr,
}));

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('react-hot-toast', () => ({ __esModule: true, default: toastMock, toast: toastMock }));

import { TorrinError, type TorrinMagnet } from '@/services/torrin';
import { handleAddAsMagnetInTr, handleAddMultipleHashesInTr } from './addMagnet';
import { handleDeleteTrTorrent } from './deleteTorrent';
import { convertToTorrinUserTorrent } from './fetchTorrents';
import { parseTorrinRowId, toTorrinRowId } from './torrinRow';

const cached = fixture['add-cached'].body.data as TorrinMagnet;
const queued = fixture['add-queued'].body.data as TorrinMagnet;
const HASH = cached.hash!;
const hashN = (n: number) => n.toString(16).padStart(40, '0');
const refusal = (key: keyof typeof fixture) => {
	const { status, body } = fixture[key] as { status: number; body: any };
	return new TorrinError(`Torrin: ${body.error.message ?? body.error}`, `http_${status}`, status);
};

beforeEach(() => {
	Object.values(tr).forEach((fn) => fn.mockReset());
	toastMock.mockReset();
	toastMock.success.mockReset();
	toastMock.error.mockReset();
});

describe('Torrin rows', () => {
	it('round-trips a download id and refuses anything else', () => {
		expect(parseTorrinRowId(toTorrinRowId(cached.id))).toBe(cached.id);
		expect(parseTorrinRowId('pt:123')).toBeNull();
		expect(parseTorrinRowId('tr:')).toBeNull();
		expect(parseTorrinRowId('tr: padded ')).toBeNull();
	});

	it('reads a held release as finished, keeping no file or link', () => {
		const row = convertToTorrinUserTorrent(cached);
		expect(row).toMatchObject({
			id: `tr:${cached.id}`,
			hash: HASH,
			status: UserTorrentStatus.finished,
			progress: 100,
			serviceStatus: 'Downloaded',
			bytes: cached.size,
		});
		expect(row.added.toISOString()).toBe(new Date(cached.added_at!).toISOString());
		// Each link is a signed stream URL that works as a key for a day.
		expect(row.links).toEqual([]);
		expect(row.selectedFiles).toEqual([]);
		expect(JSON.stringify(row)).not.toContain('stream.example.test');
	});

	it('reads a queued add as waiting at 0%, named by its hash until Torrin names it', () => {
		const row = convertToTorrinUserTorrent(queued);
		expect(row.status).toBe(UserTorrentStatus.waiting);
		expect(row.progress).toBe(0);
		expect(queued.name).toBe('');
		expect(row.filename).toBe(queued.hash);
		expect(row.bytes).toBe(0);
	});

	it('degrades a row Torrin sent half-empty instead of throwing', () => {
		const row = convertToTorrinUserTorrent({ id: 'x', status: 'something-new' }, HASH);
		expect(row).toMatchObject({ id: 'tr:x', hash: HASH, filename: HASH, bytes: 0 });
		expect(row.status).toBe(UserTorrentStatus.waiting);
	});

	it('reads a failed download as an error', () => {
		expect(convertToTorrinUserTorrent({ ...queued, status: 'failed' }).status).toBe(
			UserTorrentStatus.error
		);
	});
});

describe('handleAddAsMagnetInTr', () => {
	it('refuses an invalid hash before calling Torrin', async () => {
		await expect(handleAddAsMagnetInTr('k', 'nothex')).rejects.toMatchObject({
			code: 'invalid_info_hash',
		});
		expect(tr.addTorrinMagnet).not.toHaveBeenCalled();
	});

	it('hands back the row and says it is ready when Torrin held it', async () => {
		tr.addTorrinMagnet.mockResolvedValue(cached);
		const callback = vi.fn();

		await handleAddAsMagnetInTr('k', HASH, callback);

		expect(tr.addTorrinMagnet).toHaveBeenCalledWith('k', HASH);
		expect(callback.mock.calls[0][0]).toMatchObject({ id: `tr:${cached.id}`, progress: 100 });
		expect(toastMock.success).toHaveBeenCalledWith('On Torrin — ready.', expect.anything());
	});

	it('says a new download started when Torrin did not hold it', async () => {
		tr.addTorrinMagnet.mockResolvedValue(queued);

		await handleAddAsMagnetInTr('k', queued.hash!);

		expect(toastMock.success).toHaveBeenCalledWith(
			'Added to Torrin — downloading.',
			expect.anything()
		);
	});

	it("shows Torrin's own words for a refusal, and throws it on", async () => {
		tr.addTorrinMagnet.mockRejectedValue(refusal('add-monthly-limit'));

		await expect(handleAddAsMagnetInTr('k', HASH)).rejects.toBeInstanceOf(TorrinError);

		expect(toastMock.error).toHaveBeenCalledWith(
			'Torrin: monthly download limit reached, resets on the 1st',
			expect.anything()
		);
	});

	it('stays quiet when asked to', async () => {
		tr.addTorrinMagnet.mockResolvedValue(cached);
		await handleAddAsMagnetInTr('k', HASH, undefined, true);
		tr.addTorrinMagnet.mockRejectedValue(refusal('add-paid-release'));
		await expect(handleAddAsMagnetInTr('k', HASH, undefined, true)).rejects.toThrow();

		expect(toastMock.success).not.toHaveBeenCalled();
		expect(toastMock.error).not.toHaveBeenCalled();
	});

	it('adds once when clicked twice while the first add runs', async () => {
		let finish!: (magnet: TorrinMagnet) => void;
		tr.addTorrinMagnet.mockReturnValue(new Promise((resolve) => (finish = resolve)));

		const first = handleAddAsMagnetInTr('k', HASH);
		await handleAddAsMagnetInTr('k', HASH);
		finish(cached);
		await first;

		expect(tr.addTorrinMagnet).toHaveBeenCalledTimes(1);
	});
});

describe('handleAddMultipleHashesInTr', () => {
	it('adds each hash once, counts what is refused, and calls back', async () => {
		tr.addTorrinMagnet
			.mockResolvedValueOnce(cached)
			.mockRejectedValueOnce(refusal('add-invalid-magnet'))
			.mockResolvedValueOnce(queued);
		const callback = vi.fn();

		await handleAddMultipleHashesInTr(
			'k',
			[hashN(1), hashN(1), 'nothex', hashN(2), hashN(3)],
			callback
		);

		expect(tr.addTorrinMagnet.mock.calls.map(([, h]) => h)).toEqual([
			hashN(1),
			hashN(2),
			hashN(3),
		]);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(toastMock).toHaveBeenCalledWith('Added 2 to Torrin — 2 refused.', expect.anything());
		expect(toastMock.error).not.toHaveBeenCalled();
	});

	// A quota, a full queue, a refused plan or the request limiter answers every
	// later add the same way, so the sweep stops at the first.
	it.each(['add-monthly-limit', 'add-queue-full', 'plan-expired', 'bad-key'] as const)(
		'stops at %s and says why',
		async (key) => {
			tr.addTorrinMagnet.mockResolvedValueOnce(cached).mockRejectedValueOnce(refusal(key));

			await handleAddMultipleHashesInTr('k', [hashN(1), hashN(2), hashN(3)]);

			expect(tr.addTorrinMagnet).toHaveBeenCalledTimes(2);
			expect(toastMock).toHaveBeenCalledWith('Added 1 to Torrin.', expect.anything());
			expect(toastMock.error).toHaveBeenCalledWith(
				expect.stringMatching(/Stopped early\.$/),
				expect.anything()
			);
		}
	);
});

describe('handleDeleteTrTorrent', () => {
	it('deletes by the id inside the row id', async () => {
		tr.deleteTorrinMagnet.mockResolvedValue(undefined);

		expect(await handleDeleteTrTorrent('k', `tr:${cached.id}`)).toBe(true);
		expect(tr.deleteTorrinMagnet).toHaveBeenCalledWith('k', cached.id);
	});

	it('refuses a row id that is not Torrin’s without calling it', async () => {
		expect(await handleDeleteTrTorrent('k', 'pt:12')).toBe(false);
		expect(tr.deleteTorrinMagnet).not.toHaveBeenCalled();
	});

	it('counts a download Torrin no longer has as deleted', async () => {
		tr.deleteTorrinMagnet.mockRejectedValue(refusal('not-found'));

		expect(await handleDeleteTrTorrent('k', `tr:${cached.id}`, true)).toBe(true);
		expect(toastMock.error).not.toHaveBeenCalled();
	});

	it('keeps a row still seeding, in Torrin’s words', async () => {
		tr.deleteTorrinMagnet.mockRejectedValue(refusal('delete-seeding'));

		expect(await handleDeleteTrTorrent('k', `tr:${cached.id}`)).toBe(false);
		expect(toastMock.error).toHaveBeenCalledWith(
			'Torrin: seeding until it meets its ratio/time target'
		);
	});
});
