import type { TorrinMagnetStatus } from '@/services/torrin';
import { UserTorrentStatus } from '@/torrent/userTorrent';

/**
 * Torrin library rows.
 *
 * A row is one download, `tr:<id>`. Torrin's ids are opaque strings (UUIDv7s
 * today) and are only ever passed back. The prefix is three characters like
 * `rd:` and `pt:`: several places slice row ids with `substring(0, 3)`.
 */
export const TR_ID_PREFIX = 'tr:';

export const toTorrinRowId = (id: string): string => `${TR_ID_PREFIX}${id}`;

/** The download id inside a row id, or null: a destructive call never gets a guess. */
export const parseTorrinRowId = (rowId: string): string | null => {
	if (!rowId.startsWith(TR_ID_PREFIX)) return null;
	const id = rowId.slice(TR_ID_PREFIX.length);
	return id.trim() === id && id.length > 0 ? id : null;
};

/**
 * Torrin's four statuses as a library status and a label. Torrin reports no
 * progress, so a row is 0% until it is downloaded and 100% from then on.
 */
const TR_STATUS: Record<TorrinMagnetStatus, [UserTorrentStatus, string]> = {
	queued: [UserTorrentStatus.waiting, 'Queued'],
	downloading: [UserTorrentStatus.downloading, 'Downloading'],
	downloaded: [UserTorrentStatus.finished, 'Downloaded'],
	failed: [UserTorrentStatus.error, 'Failed'],
};

export const getTorrinStatusText = (status: TorrinMagnetStatus): string => TR_STATUS[status][1];

export const getTorrinUserTorrentStatus = (
	status: TorrinMagnetStatus
): [UserTorrentStatus, number] => {
	const mapped = TR_STATUS[status][0];
	return [mapped, mapped === UserTorrentStatus.finished ? 100 : 0];
};
