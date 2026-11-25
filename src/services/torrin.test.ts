import derived from '@/test/fixtures/torrin/source-derived-06a40e41.json';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CACHE_CHECK_CHUNK_SIZE,
	DEFAULT_TORRIN_BASE_URL,
	RATE_LIMIT_BACKOFF_MS,
	TorrinError,
	_testing,
	addTorrinMagnet,
	addTorrinNewz,
	checkTorrinCache,
	deleteTorrinMagnet,
	getTorrinMagnet,
	getTorrinUser,
	isTorrinAuthError,
	isTorrinKeyShaped,
	isTorrinPlanRefusal,
	isTorrinRateLimited,
	listTorrinMagnets,
	torrinBaseUrl,
	torrinMagnetHash,
	torrinMagnetStatus,
} from './torrin';

const KEY = 'tr_testKey0123456789ab';
const BUNNY = 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c';
const SINTEL = '08ada5a7a6183aae1e09d831df6748d566095a10';
const TEARS = '209c8226b299b308beaf2b9cd3fb49212dbd13ec';
const MAGNET = `magnet:?xt=urn:btih:${BUNNY}&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftracker.example%3A1337`;

const reply = (body: unknown, status = 200) =>
	({
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	}) as unknown as Response;

const derivedReply = (name: keyof typeof derived) =>
	reply(derived[name].body, derived[name].status);

/** A 204 has no body at all, so reading one as JSON throws. */
const noContent = () =>
	({
		ok: true,
		status: 204,
		json: async () => {
			throw new SyntaxError('Unexpected end of JSON input');
		},
	}) as unknown as Response;

const fetchMock = vi.fn();

/** The url, method, headers and JSON body of the nth fetch. */
const call = (n: number) => {
	const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit];
	const parsed = new URL(url);
	return {
		origin: parsed.origin,
		path: parsed.pathname,
		query: Object.fromEntries(parsed.searchParams),
		method: init.method,
		headers: init.headers as Record<string, string>,
		json: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
		body: init.body,
	};
};

beforeEach(() => {
	_testing.resetRateLimit();
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe('Torrin request envelope', () => {
	it('sends the key as a Bearer header to the store API, never in the query', async () => {
		fetchMock.mockResolvedValueOnce(derivedReply('user'));
		const user = await getTorrinUser(KEY);
		expect(user.subscription_status).toBe('premium');
		const { origin, path, query, headers } = call(0);
		expect(origin).toBe(DEFAULT_TORRIN_BASE_URL);
		expect(path).toBe(`${_testing.STORE_PATH}/user`);
		expect(headers.Authorization).toBe(`Bearer ${KEY}`);
		expect(Object.values(query)).not.toContain(KEY);
	});

	it('never sends the StremThru header, which the browser preflight would refuse', async () => {
		fetchMock.mockResolvedValueOnce(derivedReply('user'));
		await getTorrinUser(KEY);
		const names = Object.keys(call(0).headers).map((name) => name.toLowerCase());
		expect(names).not.toContain('x-stremthru-store-authorization');
		// A GET carries no body, so it needs no Content-Type either.
		expect(names).not.toContain('content-type');
	});

	it('trims a pasted key and refuses an empty one without a request', async () => {
		fetchMock.mockResolvedValueOnce(derivedReply('user'));
		await getTorrinUser(`  ${KEY}\n`);
		expect(call(0).headers.Authorization).toBe(`Bearer ${KEY}`);

		await expect(getTorrinUser('   ')).rejects.toMatchObject({ code: 'missing_key' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('talks to a self-hosted Torrin when one is configured', async () => {
		vi.stubEnv('NEXT_PUBLIC_TORRIN_BASE_URL', 'https://torrin.example.test/');
		expect(torrinBaseUrl()).toBe('https://torrin.example.test');
		fetchMock.mockResolvedValueOnce(derivedReply('user'));
		await getTorrinUser(KEY);
		expect(call(0).origin).toBe('https://torrin.example.test');
		expect(call(0).path).toBe('/v0/store/user');
	});

	it('turns a 401 into an auth error with its own message', async () => {
		fetchMock.mockResolvedValueOnce(derivedReply('bad-key'));
		const error = await getTorrinUser(KEY).catch((e) => e);
		expect(error).toBeInstanceOf(TorrinError);
		expect(error).toMatchObject({ status: 401, code: 'http_401' });
		expect(isTorrinAuthError(error)).toBe(true);
		expect(error.message).toBe(
			'Torrin did not accept this API key. Sign in again with a current one.'
		);
	});

	it.each(['plan-paused', 'plan-expired'] as const)(
		'reads %s as a plan refusal that keeps the key, in the words Torrin used',
		async (name) => {
			fetchMock.mockResolvedValueOnce(derivedReply(name));
			const error = await getTorrinUser(KEY).catch((e) => e);
			expect(isTorrinPlanRefusal(error)).toBe(true);
			expect(isTorrinAuthError(error)).toBe(false);
			expect(error.message).toBe(`Torrin: ${derived[name].body.error.message}`);
		}
	);

	it('keeps a network failure apart from a refusal', async () => {
		fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
		const error = await getTorrinUser(KEY).catch((e) => e);
		expect(error).toMatchObject({ code: 'network_error', status: 0 });
		expect(isTorrinAuthError(error)).toBe(false);
	});

	it('refuses a 200 that is not JSON, or that carries no data', async () => {
		fetchMock
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => {
					throw new SyntaxError('Unexpected token <');
				},
			})
			.mockResolvedValueOnce(reply({ items: [] }));
		await expect(getTorrinUser(KEY)).rejects.toMatchObject({ code: 'non_json_response' });
		await expect(listTorrinMagnets(KEY)).rejects.toMatchObject({ code: 'invalid_response' });
	});

	it('names a server error with no message by its status', async () => {
		fetchMock.mockResolvedValueOnce(reply(null, 502));
		await expect(getTorrinUser(KEY)).rejects.toMatchObject({
			status: 502,
			message: 'Torrin had a server error (502). Try again later.',
		});
	});

	it('shows a long or multi-line message from Torrin as one bounded line', async () => {
		fetchMock.mockResolvedValueOnce(
			reply({ error: { code: 400, message: `bad\n\nrequest ${'x'.repeat(500)}` } }, 400)
		);
		const error = await getTorrinUser(KEY).catch((e) => e);
		expect(error.message.startsWith('Torrin: bad request x')).toBe(true);
		expect(error.message).not.toContain('\n');
		expect(error.message.length).toBeLessThanOrEqual('Torrin: '.length + 200);
	});

	it('stands down for the whole window after the request limiter answers', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		fetchMock.mockResolvedValueOnce(derivedReply('rate-limited'));
		const error = await getTorrinUser(KEY).catch((e) => e);
		expect(isTorrinRateLimited(error)).toBe(true);
		expect(error.message).toBe('Torrin is limiting requests. Wait a moment and try again.');
		await expect(listTorrinMagnets(KEY)).rejects.toMatchObject({ code: 'rate_limited' });
		expect(fetchMock).toHaveBeenCalledTimes(1);

		vi.setSystemTime(Date.now() + RATE_LIMIT_BACKOFF_MS + 1);
		fetchMock.mockResolvedValueOnce(derivedReply('user'));
		await expect(getTorrinUser(KEY)).resolves.toMatchObject({ subscription_status: 'premium' });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('reads a 429 with no body as the limiter too', async () => {
		fetchMock.mockResolvedValueOnce(reply(null, 429));
		await expect(getTorrinUser(KEY)).rejects.toMatchObject({ code: 'rate_limited' });
	});

	it('does not stand down after a download quota, which refuses only that add', async () => {
		fetchMock
			.mockResolvedValueOnce(derivedReply('add-monthly-limit'))
			.mockResolvedValueOnce(derivedReply('magnets-list-empty'));
		const error = await addTorrinMagnet(KEY, MAGNET).catch((e) => e);
		expect(error).toMatchObject({ status: 429, code: 'http_429' });
		expect(isTorrinRateLimited(error)).toBe(false);
		expect(error.message).toBe('Torrin: monthly download limit reached, resets on the 1st');
		await expect(listTorrinMagnets(KEY)).resolves.toEqual([]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe('getTorrinUser', () => {
	it('refuses an answer without an account id', async () => {
		fetchMock.mockResolvedValueOnce(reply({ data: { subscription_status: 'premium' } }));
		await expect(getTorrinUser(KEY)).rejects.toMatchObject({ code: 'invalid_response' });
	});
});

describe('checkTorrinCache', () => {
	it('asks once with comma-joined hashes and reads the three answers (source-derived)', async () => {
		fetchMock.mockResolvedValueOnce(derivedReply('check-mixed'));
		const results = await checkTorrinCache(KEY, [BUNNY, SINTEL, TEARS]);
		expect(call(0)).toMatchObject({
			path: `${_testing.STORE_PATH}/magnets/check`,
			method: 'GET',
			query: { hash: `${BUNNY},${SINTEL},${TEARS}` },
		});
		expect(results.map(({ hash, status }) => ({ hash, status }))).toEqual([
			{ hash: BUNNY, status: 'cached' },
			{ hash: SINTEL, status: 'acceleratable' },
			{ hash: TEARS, status: 'unknown' },
		]);
		expect(results[0].name).toBe('Big Buck Bunny');
		expect(results[0].files[0]).toMatchObject({
			name: 'big_buck_bunny_1080p.mkv',
			size: 276134947,
			media_info: { resolution: '1080p' },
		});
		expect(results[1].files).toEqual([]);
	});

	it('takes magnets and hashes alike, deduplicated, and drops what has no hash', async () => {
		fetchMock.mockResolvedValueOnce(derivedReply('check-mixed'));
		await checkTorrinCache(KEY, [MAGNET, BUNNY.toUpperCase(), 'not a hash', SINTEL]);
		expect(call(0).query.hash).toBe(`${BUNNY},${SINTEL}`);
	});

	it('makes no request when nothing has a valid hash', async () => {
		await expect(checkTorrinCache(KEY, ['', 'magnet:?xt=urn:btih:zzzz'])).resolves.toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('asks in chunks, one request at a time, in order', async () => {
		const hashes = Array.from({ length: CACHE_CHECK_CHUNK_SIZE + 3 }, (_, i) =>
			i.toString(16).padStart(40, '0')
		);
		fetchMock.mockResolvedValue(reply({ data: { items: [] } }));
		const results = await checkTorrinCache(KEY, hashes);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(call(0).query.hash.split(',')).toHaveLength(CACHE_CHECK_CHUNK_SIZE);
		expect(call(1).query.hash.split(',')).toEqual(hashes.slice(CACHE_CHECK_CHUNK_SIZE));
		expect(results.map((r) => r.hash)).toEqual(hashes);
	});

	it('matches answers by hash, not position, and reads anything unclear as unknown', async () => {
		fetchMock.mockResolvedValueOnce(
			reply({
				data: {
					items: [
						{ hash: TEARS.toUpperCase(), status: 'cached', files: [] },
						{ hash: SINTEL, status: 'warming', files: [] },
						{ hash: 'f'.repeat(40), status: 'cached', files: [] },
					],
				},
			})
		);
		const results = await checkTorrinCache(KEY, [BUNNY, SINTEL, TEARS]);
		expect(results.map((r) => [r.hash, r.status])).toEqual([
			[BUNNY, 'unknown'],
			[SINTEL, 'unknown'],
			[TEARS, 'cached'],
		]);
	});

	it('keeps files only for a cached answer', async () => {
		fetchMock.mockResolvedValueOnce(
			reply({
				data: {
					items: [
						{ hash: SINTEL, status: 'acceleratable', files: [{ index: 0, name: 'x' }] },
					],
				},
			})
		);
		const [result] = await checkTorrinCache(KEY, [SINTEL]);
		expect(result).toEqual({ hash: SINTEL, status: 'acceleratable', name: '', files: [] });
	});
});

describe('listTorrinMagnets', () => {
	it('reads every status, newest first, with files only once downloaded (source-derived)', async () => {
		fetchMock.mockResolvedValueOnce(derivedReply('magnets-list'));
		const magnets = await listTorrinMagnets(KEY);
		expect(call(0).path).toBe(`${_testing.STORE_PATH}/magnets`);
		expect(magnets).toHaveLength(derived['magnets-list'].body.data.total_items);
		expect(magnets.map(torrinMagnetStatus)).toEqual([
			'failed',
			'queued',
			'downloading',
			'downloaded',
		]);
		expect(magnets.filter((m) => m.files?.length).map(torrinMagnetHash)).toEqual([BUNNY]);
	});

	it('reads an empty account', async () => {
		fetchMock.mockResolvedValueOnce(derivedReply('magnets-list-empty'));
		await expect(listTorrinMagnets(KEY)).resolves.toEqual([]);
	});

	it('throws instead of returning an empty list when the answer has none', async () => {
		fetchMock.mockResolvedValueOnce(reply({ data: { total_items: 0 } }));
		await expect(listTorrinMagnets(KEY)).rejects.toMatchObject({ code: 'invalid_response' });
	});

	it('drops rows that have no id to act on', async () => {
		fetchMock.mockResolvedValueOnce(
			reply({ data: { items: [{ id: 'a', status: 'queued' }, { status: 'queued' }, null] } })
		);
		await expect(listTorrinMagnets(KEY)).resolves.toEqual([{ id: 'a', status: 'queued' }]);
	});
});

describe('adding', () => {
	it('validates the info hash before any request', async () => {
		await expect(addTorrinMagnet(KEY, 'magnet:?xt=urn:btih:zzzz')).rejects.toMatchObject({
			code: 'invalid_info_hash',
		});
		await expect(addTorrinMagnet(KEY, 'https://example.test/x.torrent')).rejects.toMatchObject({
			code: 'invalid_info_hash',
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('posts a pasted magnet as JSON, name and trackers kept (source-derived)', async () => {
		fetchMock.mockResolvedValueOnce(derivedReply('add-cached'));
		const magnet = await addTorrinMagnet(KEY, ` ${MAGNET} `);
		expect(call(0)).toMatchObject({
			path: `${_testing.STORE_PATH}/magnets`,
			method: 'POST',
			json: { magnet: MAGNET },
		});
		expect(call(0).headers['Content-Type']).toBe('application/json');
		// Something Torrin already holds is ready at once, files and links included.
		expect(torrinMagnetStatus(magnet)).toBe('downloaded');
		expect(magnet.files?.[0].link).toMatch(/^https:\/\/stream\.example\.test\//);
	});

	it('turns a bare hash into a magnet, and reads the queued answer (source-derived)', async () => {
		fetchMock.mockResolvedValueOnce(derivedReply('add-queued'));
		const magnet = await addTorrinMagnet(KEY, TEARS.toUpperCase());
		expect(call(0).json).toEqual({ magnet: `magnet:?xt=urn:btih:${TEARS}` });
		expect(magnet).toMatchObject({ status: 'queued', files: [], size: 0 });
	});

	it('shows the reason Torrin gives for a full queue, a paid-plan release and a bad magnet', async () => {
		fetchMock
			.mockResolvedValueOnce(derivedReply('add-queue-full'))
			.mockResolvedValueOnce(derivedReply('add-paid-release'))
			.mockResolvedValueOnce(derivedReply('add-invalid-magnet'));
		const queueFull = await addTorrinMagnet(KEY, MAGNET).catch((e) => e);
		const paidOnly = await addTorrinMagnet(KEY, MAGNET).catch((e) => e);
		const invalid = await addTorrinMagnet(KEY, MAGNET).catch((e) => e);
		expect(queueFull).toMatchObject({ status: 429, message: 'Torrin: download queue full' });
		expect(isTorrinRateLimited(queueFull)).toBe(false);
		expect(isTorrinPlanRefusal(paidOnly)).toBe(true);
		expect(paidOnly.message).toBe('Torrin: this release requires a paid plan');
		expect(invalid).toMatchObject({ status: 400, message: 'Torrin: invalid magnet' });
	});

	it('refuses an answer without a download id', async () => {
		fetchMock.mockResolvedValueOnce(reply({ data: { status: 'queued' } }));
		await expect(addTorrinMagnet(KEY, MAGNET)).rejects.toMatchObject({
			code: 'invalid_response',
		});
	});
});

describe('adding an NZB', () => {
	const NZB = new Blob(['<nzb/>'], { type: 'application/x-nzb' });

	it('uploads it as a multipart file, leaving the Content-Type to the browser', async () => {
		fetchMock.mockResolvedValueOnce(
			reply({ data: { id: 'a1b2', hash: 'a1b2', status: 'queued' } }, 201)
		);
		const added = await addTorrinNewz(KEY, NZB, 'Some.Release.nzb');

		expect(call(0)).toMatchObject({ path: `${_testing.STORE_PATH}/newz`, method: 'POST' });
		expect(call(0).headers.Authorization).toBe(`Bearer ${KEY}`);
		expect(Object.keys(call(0).headers).map((name) => name.toLowerCase())).not.toContain(
			'content-type'
		);
		const file = (call(0).body as FormData).get('file') as File;
		expect(file.name).toBe('Some.Release.nzb');
		expect(added).toEqual({ id: 'a1b2', status: 'queued' });
	});

	it('reads one Torrin already holds as downloaded', async () => {
		fetchMock.mockResolvedValueOnce(reply({ data: { id: 'a1b2', status: 'downloaded' } }, 201));
		expect((await addTorrinNewz(KEY, NZB, 'x.nzb')).status).toBe('downloaded');
	});

	it('shows Torrin’s reason for a plan without Usenet', async () => {
		fetchMock.mockResolvedValueOnce(
			reply({ error: { code: 403, message: 'your plan does not include usenet' } }, 403)
		);
		await expect(addTorrinNewz(KEY, NZB, 'x.nzb')).rejects.toMatchObject({
			status: 403,
			message: 'Torrin: your plan does not include usenet',
		});
	});

	it('refuses an answer without a download id', async () => {
		fetchMock.mockResolvedValueOnce(reply({ data: { status: 'queued' } }, 201));
		await expect(addTorrinNewz(KEY, NZB, 'x.nzb')).rejects.toMatchObject({
			code: 'invalid_response',
		});
	});
});

describe('one download', () => {
	it('reads its files and stream links by id (source-derived)', async () => {
		fetchMock.mockResolvedValueOnce(derivedReply('magnet-downloaded'));
		const id = derived['magnet-downloaded'].body.data.id;
		const magnet = await getTorrinMagnet(KEY, id);
		expect(call(0).path).toBe(`${_testing.STORE_PATH}/magnets/${id}`);
		expect(magnet.files?.map((f) => f.name)).toEqual([
			'big_buck_bunny_1080p.mkv',
			'poster.jpg',
		]);
		expect(magnet.files?.[0].media_info).toMatchObject({
			height: 1080,
			audio: [{ channels: 6, language: 'eng' }],
			subtitles: [{ language: 'eng' }],
		});
		// SDR video carries no `hdr` at all; Torrin names only DV, HDR10 and HLG.
		expect(magnet.files?.[0].media_info?.hdr).toBeUndefined();
	});

	it('escapes an id rather than letting it reach another route', async () => {
		fetchMock.mockResolvedValueOnce(derivedReply('magnet-downloaded'));
		await getTorrinMagnet(KEY, '../user');
		expect(call(0).path).toBe(`${_testing.STORE_PATH}/magnets/..%2Fuser`);
	});

	it('says plainly when the download is gone', async () => {
		fetchMock.mockResolvedValueOnce(derivedReply('not-found'));
		const error = await getTorrinMagnet(KEY, 'gone').catch((e) => e);
		expect(error).toMatchObject({ status: 404, message: 'Torrin no longer has that item.' });
		expect(isTorrinAuthError(error)).toBe(false);
	});

	it('deletes with no body and reads the empty 204', async () => {
		fetchMock.mockResolvedValueOnce(noContent());
		await expect(deleteTorrinMagnet(KEY, 'abc')).resolves.toBeUndefined();
		expect(call(0)).toMatchObject({
			path: `${_testing.STORE_PATH}/magnets/abc`,
			method: 'DELETE',
			body: undefined,
		});
	});

	it('shows why a release still seeding cannot be removed yet (source-derived)', async () => {
		fetchMock.mockResolvedValueOnce(derivedReply('delete-seeding'));
		await expect(deleteTorrinMagnet(KEY, 'abc')).rejects.toMatchObject({
			status: 409,
			message: 'Torrin: seeding until it meets its ratio/time target',
		});
	});

	it('refuses an empty id without a request, so nothing lands on the list route', async () => {
		await expect(deleteTorrinMagnet(KEY, ' ')).rejects.toMatchObject({ code: 'invalid_id' });
		await expect(getTorrinMagnet(KEY, '')).rejects.toMatchObject({ code: 'invalid_id' });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('helpers', () => {
	it('reads a status this client does not know yet as queued, never as failed', () => {
		expect(torrinMagnetStatus({ status: 'downloaded' })).toBe('downloaded');
		expect(torrinMagnetStatus({ status: 'verifying' })).toBe('queued');
		expect(torrinMagnetStatus({ status: null })).toBe('queued');
	});

	it('finds the hash of a download in its hash field, else in its magnet', () => {
		expect(torrinMagnetHash({ hash: BUNNY.toUpperCase() })).toBe(BUNNY);
		expect(torrinMagnetHash({ hash: 'short', magnet: MAGNET })).toBe(BUNNY);
		expect(torrinMagnetHash({ hash: null, magnet: 'https://example.test' })).toBe('');
	});

	it('tells an API key from a referral code and from other pastes', () => {
		expect(isTorrinKeyShaped(KEY)).toBe(true);
		expect(isTorrinKeyShaped(' tr_AbC-d_ef0123456789 ')).toBe(true);
		expect(isTorrinKeyShaped('tr_ref_0123456789ab')).toBe(false);
		expect(isTorrinKeyShaped('tr_')).toBe(false);
		expect(isTorrinKeyShaped('Bearer tr_abc')).toBe(false);
		expect(isTorrinKeyShaped(BUNNY)).toBe(false);
	});
});
