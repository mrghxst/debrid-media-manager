import { extractTorrentInputs, isValidHash } from '@/utils/extractHashes';

/**
 * Torrin API client, called straight from the browser.
 *
 * Torrin (torrin.app, AGPL-3.0, self-hostable) is a debrid that downloads on its
 * own servers and streams from a shared cache. Of the three APIs it serves, this
 * client speaks its StremThru-compatible store API under `/v0/store`: the one
 * whose file listings carry ready stream links and whose cache check says more
 * than yes or no. Its Real-Debrid look-alike under `/rest/1.0` fakes progress,
 * cannot page and needs an unrestrict call per file, so it is not used.
 *
 * Torrin publishes no API docs. This is written to its source
 * (torrin-app/torrin @ 06a40e41, `api/internal/stremthru` and
 * `api/internal/middleware`), and `src/test/fixtures/torrin/README.md` lists
 * what each answer is built from. Fields are read tolerantly, so one that turns
 * out missing or null degrades a row instead of throwing.
 *
 * What is load-bearing:
 *
 *  - **CORS is `*` and allows only `Authorization` and `Content-Type`**, so there
 *    is no DMM proxy. The key travels as `Authorization: Bearer`, never in a
 *    query string, and never as `X-StremThru-Store-Authorization`: Torrin reads
 *    that header too, but the browser's preflight refuses to send it.
 *  - **Bodies are JSON**, and every answer is `{data: ...}`. Errors are
 *    `{error: {code, message}}`, where `code` is only the HTTP status again.
 *  - **A 429 means two different things.** The per-key request limiter in front
 *    of every route (30 a second, bursts of 60) answers `{error: "..."}` with a
 *    plain string; a download quota (monthly, hourly, a full queue) answers the
 *    usual error object. Only the first stands every call down for a while. A
 *    quota refuses that one add, and reads keep working.
 *  - **Only a 401 means signed out.** A 403 is a plan that is paused or expired,
 *    or a release that needs a paid plan; network errors, 429 and 5xx keep the
 *    key too.
 *  - **Stream links are credentials.** Each file's `link` is a signed URL good
 *    for 24 hours from anywhere, so it is fetched when needed, never logged or
 *    kept. Errors here carry a code and Torrin's own message, nothing from the
 *    account.
 *  - **Torrin's error messages are written for people** ("monthly download limit
 *    reached, resets on the 1st"), so unlike put.io's they are shown, after the
 *    service's name.
 */

/** The hosted instance. A self-hosted DMM can point at its own Torrin instead. */
export const DEFAULT_TORRIN_BASE_URL = 'https://torrin.app';

/** Where Torrin's web server routes the store API to its `api` service. */
const STORE_PATH = '/v0/store';

/**
 * The Torrin origin this DMM talks to, without a trailing slash. Read on every
 * call rather than once, so tests and a changed build both see the current one.
 */
export const torrinBaseUrl = (): string =>
	(process.env.NEXT_PUBLIC_TORRIN_BASE_URL || DEFAULT_TORRIN_BASE_URL).replace(/\/+$/, '');

/**
 * Longer than the 20 s Torrin's cache check gives itself, so a slow check ends
 * with Torrin's own answer instead of a local timeout.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long every call stands down after the request limiter answers. Torrin
 * sends `Retry-After: 1`, but CORS does not expose that header to the browser,
 * so this waits twice that without asking.
 */
export const RATE_LIMIT_BACKOFF_MS = 2_000;

/**
 * Hashes per cache check. Torrin checks each one against its own stores and
 * then live against the upstream services it can pull from, all inside one 20 s
 * budget, and its source notes that a batch of 130+ once ran out of it. This
 * stays well under that.
 */
export const CACHE_CHECK_CHUNK_SIZE = 50;

/** Longest error message from Torrin that is shown as it came. */
const MAX_SHOWN_MESSAGE_LENGTH = 200;

/** Every status `stStatus` maps a Torrin job to. */
export const TORRIN_MAGNET_STATUSES = ['queued', 'downloading', 'downloaded', 'failed'] as const;

export type TorrinMagnetStatus = (typeof TORRIN_MAGNET_STATUSES)[number];

/**
 * Every answer the cache check gives per hash:
 *
 *  - `cached`: Torrin holds the files now; an add is instant and the check
 *    already lists them, links included.
 *  - `acceleratable`: Torrin does not hold them, but it knows a fast way to get
 *    them: a release link it has on record, its shared AllDebrid pool, a live
 *    TorrentClaw check, or the account's own Real-Debrid, AllDebrid,
 *    Premiumize, TorBox or Offcloud key on a plan that allows that. An add is
 *    fast but not instant, and lists no files yet.
 *  - `unknown`: neither. An add downloads it the slow way, if the plan allows.
 */
export const TORRIN_CACHE_STATUSES = ['cached', 'acceleratable', 'unknown'] as const;

export type TorrinCacheStatus = (typeof TORRIN_CACHE_STATUSES)[number];

/** What Torrin measured from the file itself; every field is optional on the wire. */
export interface TorrinMediaInfo {
	width?: number;
	height?: number;
	resolution?: string;
	duration_sec?: number;
	bitrate?: number;
	video_codec?: string;
	hdr?: string;
}

export interface TorrinFile {
	index: number;
	name: string;
	/** `name` with a leading `/`, nothing more. */
	path?: string | null;
	size?: number | null;
	/** A signed stream URL, good for 24 hours. A credential: see the header. */
	link?: string | null;
	media_info?: TorrinMediaInfo | null;
}

/** The fields DMM reads. All but `id` may be null or missing on the wire. */
export interface TorrinMagnet {
	/** Opaque; Torrin's job id. Only ever passed back, never parsed. */
	id: string;
	hash?: string | null;
	magnet?: string | null;
	name?: string | null;
	status?: string | null;
	size?: number | null;
	/** RFC 3339, from when the account added it. */
	added_at?: string | null;
	/** Filled only once `downloaded`; empty while it is still on the way. */
	files?: TorrinFile[] | null;
}

export interface TorrinUser {
	id: string;
	email?: string;
	/**
	 * Always `"premium"`: Torrin refuses a paused or expired plan with a 403
	 * before it answers at all, so reaching this says the plan is active.
	 */
	subscription_status?: string;
}

export interface TorrinCacheResult {
	hash: string;
	status: TorrinCacheStatus;
	/** Torrin's name for the release, or '' when it has none. */
	name: string;
	/** Listed only for `cached`, with signed links. Empty otherwise. */
	files: TorrinFile[];
}

export class TorrinError extends Error {
	/** `http_<status>` for a refusal from Torrin, else a local code. */
	readonly code: string;
	/** HTTP status, 0 when none was received. */
	readonly status: number;

	constructor(message: string, code: string, status = 0) {
		super(message);
		this.name = 'TorrinError';
		this.code = code;
		this.status = status;
	}
}

export const isTorrinAuthError = (error: unknown): boolean =>
	error instanceof TorrinError && error.status === 401;

/** The request limiter answered, as opposed to a download quota (see the header). */
export const isTorrinRateLimited = (error: unknown): boolean =>
	error instanceof TorrinError && error.code === 'rate_limited';

/**
 * The key is fine but the plan refused: paused, expired, or a release that needs
 * a paid plan. The message says which, in Torrin's words.
 */
export const isTorrinPlanRefusal = (error: unknown): boolean =>
	error instanceof TorrinError && error.status === 403;

/**
 * Whether a pasted value has the shape of a Torrin API key, before it is sent
 * anywhere. Keys are `tr_` and URL-safe base64. A referral code also starts
 * with `tr_`, but goes on `ref_` and twelve hex digits, and opens nothing.
 * Deliberately loose on length, so a key Torrin mints longer later still passes.
 */
export const isTorrinKeyShaped = (value: string): boolean => {
	const key = value.trim();
	return /^tr_[A-Za-z0-9_-]+$/.test(key) && !/^tr_ref_[0-9a-f]{12}$/.test(key);
};

/** Torrin's message, made safe to show: one line, of a bounded length. */
const shownMessage = (message: string): string => {
	const line = message.replace(/\s+/g, ' ').trim();
	return line.length > MAX_SHOWN_MESSAGE_LENGTH
		? `${line.slice(0, MAX_SHOWN_MESSAGE_LENGTH - 1)}…`
		: line;
};

/**
 * What a person reads. Signed out, gone and the request limiter get DMM's own
 * words, since Torrin's there say less ("invalid api key", "not found"); every
 * other refusal is Torrin's message, which names the plan, quota or state.
 */
const readable = (status: number, message: string): string => {
	if (status === 401)
		return 'Torrin did not accept this API key. Sign in again with a current one.';
	if (status === 404) return 'Torrin no longer has that item.';
	if (status === 429 && !message)
		return 'Torrin is limiting requests. Wait a moment and try again.';
	if (message) return `Torrin: ${shownMessage(message)}`;
	if (status >= 500) return `Torrin had a server error (${status}). Try again later.`;
	return `Torrin refused the request (${status}).`;
};

let rateLimitedUntil = 0;

interface RequestOptions {
	method?: 'GET' | 'POST' | 'DELETE';
	query?: Record<string, string>;
	json?: unknown;
}

/**
 * One call to the store API, returning what is inside `data`, or undefined for
 * a 204. Every failure is a `TorrinError`.
 */
async function trRequest<T>(
	apiKey: string,
	path: string,
	{ method = 'GET', query, json }: RequestOptions = {}
): Promise<T> {
	// An empty key would only earn a 401 that reads as "signed out".
	if (!apiKey.trim()) throw new TorrinError('No Torrin API key is set.', 'missing_key');
	if (Date.now() < rateLimitedUntil) {
		throw new TorrinError(readable(429, ''), 'rate_limited', 429);
	}

	const url = new URL(`${torrinBaseUrl()}${STORE_PATH}${path}`);
	for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(url.toString(), {
			method,
			headers: {
				Accept: 'application/json',
				Authorization: `Bearer ${apiKey.trim()}`,
				...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
			},
			...(json === undefined ? {} : { body: JSON.stringify(json) }),
			signal: controller.signal,
		});
	} catch {
		throw new TorrinError('Could not reach Torrin.', 'network_error');
	} finally {
		clearTimeout(timer);
	}

	// A delete answers 204 with no body at all.
	if (response.status === 204) return undefined as T;

	let body: Record<string, unknown> | null = null;
	try {
		body = (await response.json()) as Record<string, unknown>;
	} catch {
		// Not JSON: judged by the status alone below.
	}

	// The limiter's error is a bare string; a quota's is the usual object.
	const error = body?.error;
	const fromHandler = typeof error === 'object' && error !== null;
	if (response.status === 429 && !fromHandler) {
		rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
		throw new TorrinError(readable(429, ''), 'rate_limited', 429);
	}

	if (!response.ok) {
		const message =
			fromHandler && typeof (error as { message?: unknown }).message === 'string'
				? (error as { message: string }).message
				: typeof error === 'string'
					? error
					: '';
		throw new TorrinError(
			readable(response.status, message),
			`http_${response.status}`,
			response.status
		);
	}
	if (body === null) {
		throw new TorrinError(
			'Torrin answered with something other than JSON.',
			'non_json_response'
		);
	}
	if (!('data' in body)) {
		throw new TorrinError('Torrin answered without any data.', 'invalid_response');
	}
	return body.data as T;
}

/** The v1 info hash of a magnet or bare hash, or null. Only 40-hex is accepted. */
const btihOf = (source: string): string | null => {
	const hash = extractTorrentInputs(source.trim())[0]?.hash ?? null;
	return hash && isValidHash(hash) ? hash : null;
};

const requireBtih = (source: string): string => {
	const hash = btihOf(source);
	if (!hash) throw new TorrinError('That is not a valid info hash.', 'invalid_info_hash');
	return hash;
};

/** A job id for a path, refused when empty so no call lands on the list route. */
const pathId = (id: string): string => {
	if (typeof id !== 'string' || !id.trim()) {
		throw new TorrinError('Refusing an empty Torrin id.', 'invalid_id');
	}
	return encodeURIComponent(id.trim());
};

const requireMagnet = (magnet: TorrinMagnet | undefined): TorrinMagnet => {
	if (!magnet || typeof magnet.id !== 'string' || !magnet.id) {
		throw new TorrinError('Torrin answered without a download id.', 'invalid_response');
	}
	return magnet;
};

/**
 * The account behind the key. Answering at all means the key works and the
 * plan is active; a paused or expired plan is a 403 (`isTorrinPlanRefusal`).
 */
export async function getTorrinUser(apiKey: string): Promise<TorrinUser> {
	const user = await trRequest<TorrinUser | undefined>(apiKey, '/user');
	if (!user || typeof user.id !== 'string') {
		throw new TorrinError('Torrin answered without an account.', 'invalid_response');
	}
	return user;
}

const asCacheStatus = (status: unknown): TorrinCacheStatus =>
	TORRIN_CACHE_STATUSES.includes(status as TorrinCacheStatus)
		? (status as TorrinCacheStatus)
		: 'unknown';

/**
 * Batch cache probe. Nothing is added to the account. Inputs may be magnets or
 * bare hashes; what has no valid v1 hash is dropped, and the rest come back one
 * per hash, in order, deduplicated.
 *
 * Torrin answers every hash it was asked about, but the answers are matched by
 * hash rather than by position, so one it leaves out or adds unasked cannot
 * shift the others. A hash with no answer reads as `unknown`, as does a status
 * this client does not know yet.
 */
export async function checkTorrinCache(
	apiKey: string,
	hashes: string[]
): Promise<TorrinCacheResult[]> {
	const wanted = [...new Set(hashes.map(btihOf).filter((hash): hash is string => !!hash))];
	if (wanted.length === 0) return [];

	const results: TorrinCacheResult[] = [];
	for (let start = 0; start < wanted.length; start += CACHE_CHECK_CHUNK_SIZE) {
		const chunk = wanted.slice(start, start + CACHE_CHECK_CHUNK_SIZE);
		const data = await trRequest<{ items?: unknown } | undefined>(apiKey, '/magnets/check', {
			query: { hash: chunk.join(',') },
		});
		const items = Array.isArray(data?.items) ? (data.items as Record<string, unknown>[]) : [];
		const byHash = new Map<string, Record<string, unknown>>();
		for (const item of items) {
			if (typeof item?.hash === 'string') byHash.set(item.hash.toLowerCase(), item);
		}
		for (const hash of chunk) {
			const item = byHash.get(hash);
			const status = asCacheStatus(item?.status);
			results.push({
				hash,
				status,
				name: typeof item?.name === 'string' ? item.name : '',
				files: status === 'cached' && Array.isArray(item?.files) ? item.files : [],
			});
		}
	}
	return results;
}

/**
 * Every download on the account, newest first. Torrin does not page this list
 * for clients, so it is one request however large the library; it walks its own
 * database in pages of 500 up to 100,000 rows behind that. A row whose download
 * is not finished lists no files yet.
 *
 * An answer without a list throws rather than reading as empty, which a caller
 * could not tell from a library that really emptied. One thing this cannot
 * catch: when one of those inner pages fails, Torrin answers with the rows it
 * already had and says nothing, so a list that shrank is not proof of a delete.
 */
export async function listTorrinMagnets(apiKey: string): Promise<TorrinMagnet[]> {
	const data = await trRequest<{ items?: unknown } | undefined>(apiKey, '/magnets');
	if (!Array.isArray(data?.items)) {
		throw new TorrinError('Torrin answered without a download list.', 'invalid_response');
	}
	// A row without an id cannot be opened or removed, so it is not a row.
	return (data.items as TorrinMagnet[]).filter(
		(item) => typeof item?.id === 'string' && item.id.length > 0
	);
}

/** One download with its files and fresh stream links, once it is downloaded. */
export const getTorrinMagnet = async (apiKey: string, id: string): Promise<TorrinMagnet> =>
	requireMagnet(await trRequest<TorrinMagnet | undefined>(apiKey, `/magnets/${pathId(id)}`));

/**
 * Adds one magnet or bare hash, after validating its info hash.
 *
 * Nothing needs checking first. Torrin dedupes per account and hash, answering
 * a second add with the download it already has. Something Torrin already holds
 * comes back `downloaded` with its files; something another account is still
 * downloading is joined and comes back `downloading`; anything else is
 * `queued`. Only an add that starts a new download counts against the plan's
 * monthly and hourly limits, and running into one, or into a full queue, is a
 * 429 whose message names it. A release that needs a paid plan is a 403.
 */
export async function addTorrinMagnet(apiKey: string, magnetOrHash: string): Promise<TorrinMagnet> {
	const source = magnetOrHash.trim();
	const hash = requireBtih(source);
	// A pasted magnet keeps its name and trackers; a bare hash becomes one.
	const magnet = /^magnet:\?/i.test(source) ? source : `magnet:?xt=urn:btih:${hash}`;
	return requireMagnet(
		await trRequest<TorrinMagnet | undefined>(apiKey, '/magnets', {
			method: 'POST',
			json: { magnet },
		})
	);
}

/**
 * Removes a download from the account. A finished release that no other
 * account holds is handed to Torrin's shared cache rather than deleted, so it
 * stays instant for whoever adds it next. A release still seeding toward its
 * target is refused with a 409.
 */
export async function deleteTorrinMagnet(apiKey: string, id: string): Promise<void> {
	await trRequest<undefined>(apiKey, `/magnets/${pathId(id)}`, { method: 'DELETE' });
}

/** A download's status, with one this client does not know yet read as `queued`. */
export const torrinMagnetStatus = (magnet: Pick<TorrinMagnet, 'status'>): TorrinMagnetStatus =>
	TORRIN_MAGNET_STATUSES.includes(magnet.status as TorrinMagnetStatus)
		? (magnet.status as TorrinMagnetStatus)
		: 'queued';

/**
 * A download's info hash: `hash` when it is a valid one, else the btih of its
 * `magnet`, else ''.
 */
export const torrinMagnetHash = (magnet: Pick<TorrinMagnet, 'hash' | 'magnet'>): string => {
	if (magnet.hash && isValidHash(magnet.hash)) return magnet.hash.toLowerCase();
	const source = magnet.magnet ?? '';
	return (/^magnet:\?/i.test(source.trim()) && btihOf(source)) || '';
};

export const _testing = {
	STORE_PATH,
	resetRateLimit: () => {
		rateLimitedUntil = 0;
	},
};
