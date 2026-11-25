import { ModalProvider } from '@/components/modals/ModalContext';
import { handleAddMultipleHashesInTr } from '@/utils/addMagnet';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import list from '../fixtures/hashlist/fe6e0436-b0c4-4163-9fbd-86a25a274396.json';

// A Torrin-only session on a real shared list (the same list as hashlist.bulkRd).

vi.mock('@/utils/libraryIdentify', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/utils/libraryIdentify')>()),
	identifyLibrary: vi.fn(async () => {}),
}));

vi.mock('next/router', () => ({
	useRouter: vi.fn(() => ({
		push: vi.fn(),
		replace: vi.fn(),
		query: {},
		pathname: '/hashlist',
		asPath: '/hashlist',
		events: { on: vi.fn(), off: vi.fn() },
	})),
}));

vi.mock('next/head', () => ({
	__esModule: true,
	default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('next/link', () => ({
	__esModule: true,
	default: ({ children, href }: { children: ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));

vi.mock('@/hooks/auth', () => ({
	useRealDebridAccessToken: vi.fn(() => [null, false, false]),
	useAllDebridApiKey: vi.fn(() => null),
	useTorBoxAccessToken: vi.fn(() => null),
	usePremiumizeCredential: vi.fn(() => null),
	useOffcloudApiKey: vi.fn(() => null),
	useDebridLinkCredential: vi.fn(() => null),
	usePutioAccessToken: vi.fn(() => null),
	useTorrinApiKey: vi.fn(() => 'tr-key'),
}));

vi.mock('@/contexts/LibraryCacheContext', () => ({
	useLibraryCache: vi.fn(() => ({ addTorrent: vi.fn(), removeTorrent: vi.fn() })),
}));

vi.mock('@/torrent/db', () => ({
	__esModule: true,
	default: vi.fn().mockImplementation(function () {
		return {
			initializeDB: vi.fn().mockResolvedValue(undefined),
			all: vi.fn().mockResolvedValue([]),
			hashes: vi.fn().mockResolvedValue(new Set()),
			addAll: vi.fn().mockResolvedValue(undefined),
			getAllByHash: vi.fn().mockResolvedValue([]),
			deleteByHash: vi.fn().mockResolvedValue(undefined),
		};
	}),
}));

vi.mock('lz-string', () => ({
	__esModule: true,
	default: { decompressFromEncodedURIComponent: vi.fn(() => JSON.stringify(list)) },
}));

vi.mock('react-hot-toast', () => ({
	toast: Object.assign(vi.fn(), {
		error: vi.fn(),
		success: vi.fn(),
		loading: vi.fn(),
		custom: vi.fn(),
		dismiss: vi.fn(),
	}),
	Toaster: () => null,
}));

vi.mock('@/utils/takedownClient', () => ({
	fetchBlockedHashes: vi.fn().mockResolvedValue(new Set()),
}));

// Torrin holds every third release.
vi.mock('@/utils/instantChecks', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/utils/instantChecks')>()),
	checkAvailabilityTr2: vi.fn(async (_key, hashes: string[], setList) => {
		setList((rows: { hash: string; trAvailable: boolean }[]) =>
			rows.map((row, index) => ({ ...row, trAvailable: index % 3 === 0 }))
		);
		return Math.ceil(hashes.length / 3);
	}),
	wrapLoading: (_service: string, p: Promise<number>) => p,
}));

vi.mock('@/utils/addMagnet', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/utils/addMagnet')>()),
	handleAddMultipleHashesInTr: vi.fn().mockResolvedValue(undefined),
}));

const cachedHashes = list.torrents.filter((_, index) => index % 3 === 0).map((t) => t.hash);

async function renderPage() {
	const HashlistPage = (await import('@/pages/hashlist')).default;
	render(
		<ModalProvider>
			<HashlistPage />
		</ModalProvider>
	);
}

describe('HashlistPage with a Torrin key', () => {
	beforeEach(() => {
		vi.mocked(handleAddMultipleHashesInTr).mockClear();
		Object.defineProperty(window, 'location', {
			writable: true,
			value: { hash: '#list', reload: vi.fn() },
		});
	});

	it('asks before adding the cached rows it shows', async () => {
		await renderPage();

		const sweep = `TR Download (${cachedHashes.length})`;
		fireEvent.click(await screen.findByRole('button', { name: sweep }));
		expect(
			await screen.findByText(`Add ${cachedHashes.length} releases to Torrin?`)
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: `Add ${cachedHashes.length}` }));

		await waitFor(() => expect(handleAddMultipleHashesInTr).toHaveBeenCalledTimes(1));
		const [key, hashes] = vi.mocked(handleAddMultipleHashesInTr).mock.calls[0];
		expect(key).toBe('tr-key');
		expect([...hashes].sort()).toEqual([...cachedHashes].sort());
	});

	// The cached-only filter hides what Torrin does not have, and Show All sends the
	// whole list, as it does for every other service.
	it('offers Show All, which lists and sends what Torrin does not have', async () => {
		await renderPage();

		await screen.findByRole('button', { name: `TR Download (${cachedHashes.length})` });
		fireEvent.click(screen.getByRole('button', { name: 'Show All' }));

		const sweep = `TR Download (${list.torrents.length})`;
		fireEvent.click(await screen.findByRole('button', { name: sweep }));
		fireEvent.click(await screen.findByRole('button', { name: `Add ${list.torrents.length}` }));

		await waitFor(() => expect(handleAddMultipleHashesInTr).toHaveBeenCalledTimes(1));
		expect(vi.mocked(handleAddMultipleHashesInTr).mock.calls[0][1]).toHaveLength(
			list.torrents.length
		);
	});
});
