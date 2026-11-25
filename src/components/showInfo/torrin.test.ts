import fixture from '@/test/fixtures/torrin/source-derived-06a40e41.json';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	modalFireMock: vi.fn(),
	modalShowLoadingMock: vi.fn(),
	modalCloseMock: vi.fn(),
	handleShareMock: vi.fn(),
	fetchMock: vi.fn(),
}));

vi.mock('../modals/modal', () => ({
	__esModule: true,
	default: {
		fire: mocks.modalFireMock,
		showLoading: mocks.modalShowLoadingMock,
		close: mocks.modalCloseMock,
		showValidationMessage: vi.fn(),
		DismissReason: {},
	},
}));

vi.mock('axios', () => {
	const axiosMock: any = { get: vi.fn(), post: vi.fn(), delete: vi.fn() };
	axiosMock.create = vi.fn(() => axiosMock);
	axiosMock.interceptors = {
		request: { use: vi.fn(), eject: vi.fn() },
		response: { use: vi.fn(), eject: vi.fn() },
	};
	return { __esModule: true, default: axiosMock, ...axiosMock };
});

vi.mock('../../utils/hashList', () => ({
	__esModule: true,
	handleShare: mocks.handleShareMock,
}));

import { _testing } from '@/services/torrin';
import toast from 'react-hot-toast';
import { showInfoForTR } from './index';

const downloaded = fixture['magnet-downloaded'];
const magnet = downloaded.body.data;

/** The real Torrin client over a fetch that answers from the fixtures. */
const answer = (entry: { status: number; body: unknown }) => ({
	ok: entry.status >= 200 && entry.status < 300,
	status: entry.status,
	json: async () => entry.body,
});

const row = (progress = 100) => ({
	id: `tr:${magnet.id}`,
	hash: magnet.hash,
	filename: magnet.name,
	title: magnet.name,
	bytes: magnet.size,
	serviceStatus: 'Downloaded',
	progress,
	added: new Date(magnet.added_at),
});

const htmlOfLastModal = () => mocks.modalFireMock.mock.calls.at(-1)![0].html as string;
const openForReal = () =>
	mocks.modalFireMock.mockImplementation(async ({ html, didOpen }) => {
		document.body.innerHTML = html;
		didOpen();
		return { isConfirmed: false };
	});

beforeEach(() => {
	_testing.resetRateLimit();
	mocks.fetchMock.mockResolvedValue(answer(downloaded));
	vi.stubGlobal('fetch', mocks.fetchMock);
	mocks.modalFireMock.mockResolvedValue({ isConfirmed: false });
	mocks.handleShareMock.mockResolvedValue('/hashlist#share');
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	document.body.innerHTML = '';
});

describe('showInfoForTR', () => {
	it('reads the download fresh and lists its files, keeping links out of the page', async () => {
		await showInfoForTR('tr-key', row());

		expect(new URL(mocks.fetchMock.mock.calls[0][0]).pathname).toBe(
			`/v0/store/magnets/${magnet.id}`
		);
		const html = htmlOfLastModal();
		expect(html).toContain('big_buck_bunny_1080p.mkv');
		expect(html).toContain('poster.jpg');
		expect(html).toContain('Downloaded');
		expect(html).not.toContain('Watch');
		expect(html).not.toContain('stream.example.test');
		expect(html).not.toContain('tr-key');
	});

	it('opens the clicked file’s own link', async () => {
		const open = vi.spyOn(window, 'open').mockReturnValue(null);
		openForReal();

		await showInfoForTR('tr-key', row());
		document.querySelector<HTMLButtonElement>('button[data-pm-file-id="1"]')!.click();

		expect(open).toHaveBeenCalledWith(magnet.files[1].link, '_blank', 'noopener');
	});

	it('warns that exported links play the files and must not be shared', async () => {
		const success = vi.spyOn(toast, 'success');
		URL.createObjectURL = vi.fn(() => 'blob:links');
		URL.revokeObjectURL = vi.fn();
		openForReal();

		await showInfoForTR('tr-key', row());
		document.getElementById('btn-export-links-tr')!.click();

		expect(success).toHaveBeenCalledWith(
			expect.stringMatching(/play your Torrin files for a day from anywhere: do not share/),
			expect.anything()
		);
	});

	it('says why it lists nothing when Torrin no longer has the download', async () => {
		mocks.fetchMock.mockResolvedValue(answer(fixture['not-found']));

		await showInfoForTR('tr-key', row());

		expect(htmlOfLastModal()).toContain('Torrin no longer has that item.');
	});

	it('says files come once a download is finished', async () => {
		mocks.fetchMock.mockResolvedValue(answer(fixture['add-queued']));

		await showInfoForTR('tr-key', row(0));

		const html = htmlOfLastModal();
		expect(html).toContain('Queued');
		expect(html).toContain('Torrin lists the files once the download is finished.');
	});

	it('refuses a row id that is not Torrin’s without calling it', async () => {
		await showInfoForTR('tr-key', { ...row(), id: 'pt:12' });

		expect(mocks.fetchMock).not.toHaveBeenCalled();
		expect(mocks.modalFireMock).not.toHaveBeenCalled();
	});
});
