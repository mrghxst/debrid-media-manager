import { addTorrinNewz, type TorrinMagnetStatus } from '@/services/torrin';
import { fetchCleanNzb } from '@/utils/nzbDownload';

/**
 * Sends one search result to the member's Torrin Usenet downloads. The NZB is
 * the cleaned one DMM's server fetches (the indexer key never reaches the
 * browser), and the browser uploads it with the member's own Torrin key.
 * Failures throw a `TorrinError` whose message is Torrin's own.
 */
export async function sendNzbToTorrin(
	trKey: string,
	id: string,
	title: string
): Promise<TorrinMagnetStatus> {
	const { blob, name } = await fetchCleanNzb(id, title);
	return (await addTorrinNewz(trKey, blob, name)).status;
}
