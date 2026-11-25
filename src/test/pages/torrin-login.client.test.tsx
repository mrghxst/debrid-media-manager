import TorrinLoginPage from '@/pages/torrin/login';
import { TorrinError } from '@/services/torrin';
import { listSavedAccounts, parkCurrentAccount } from '@/utils/savedAccounts';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRouter } from 'next/router';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/router', () => ({ useRouter: vi.fn() }));

vi.mock('next/head', () => ({
	__esModule: true,
	default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const setApiKey = vi.fn();
vi.mock('@/hooks/localStorage', () => ({
	__esModule: true,
	default: (key: string) => [null, key === 'tr:apiKey' ? setApiKey : vi.fn()],
	notifyLocalStorageChange: vi.fn(),
}));

vi.mock('@/torrent/db', () => ({
	__esModule: true,
	default: vi.fn().mockImplementation(function () {
		return { clear: vi.fn() };
	}),
}));

const getTorrinUser = vi.fn();
vi.mock('@/services/torrin', async () => {
	const actual = await vi.importActual<typeof import('@/services/torrin')>('@/services/torrin');
	return {
		...actual,
		getTorrinUser: (...args: unknown[]) => getTorrinUser(...args),
	};
});

const replace = vi.fn();
const realLocation = window.location;
const assign = vi.fn();

const KEY = 'tr_test-api-key';
const account = { id: 'u-1', email: 'me@example.com', subscription_status: 'active' };

const submit = (key = KEY) => {
	fireEvent.change(screen.getByLabelText('API Key'), { target: { value: key } });
	fireEvent.click(screen.getByRole('button', { name: 'Save API Key' }));
};

beforeEach(() => {
	setApiKey.mockReset();
	getTorrinUser.mockReset();
	replace.mockReset();
	vi.mocked(useRouter).mockReturnValue({ replace, query: {} } as any);
	localStorage.clear();
	assign.mockReset();
	Object.defineProperty(window, 'location', {
		configurable: true,
		writable: true,
		value: { ...realLocation, assign },
	});
});

afterEach(() => {
	Object.defineProperty(window, 'location', {
		configurable: true,
		writable: true,
		value: realLocation,
	});
});

describe('TorrinLoginPage', () => {
	it('stores the key under tr:apiKey and redirects once Torrin accepts it', async () => {
		getTorrinUser.mockResolvedValue(account);

		render(<TorrinLoginPage />);
		submit();

		await waitFor(() => expect(setApiKey).toHaveBeenCalledWith(KEY));
		expect(getTorrinUser).toHaveBeenCalledWith(KEY);
		expect(replace).toHaveBeenCalledWith('/');
	});

	it('returns the user to where they came from', async () => {
		vi.mocked(useRouter).mockReturnValue({ replace, query: { redirect: '/library' } } as any);
		getTorrinUser.mockResolvedValue(account);

		render(<TorrinLoginPage />);
		submit();

		await waitFor(() => expect(replace).toHaveBeenCalledWith('/library'));
	});

	it('trims the pasted key', async () => {
		getTorrinUser.mockResolvedValue(account);

		render(<TorrinLoginPage />);
		submit(`  ${KEY}  `);

		await waitFor(() => expect(setApiKey).toHaveBeenCalledWith(KEY));
		expect(getTorrinUser).toHaveBeenCalledWith(KEY);
	});

	// A referral code is the other tr_ string on Torrin's account page; it is
	// caught before anything is sent, with a message that names the mix-up.
	it.each([
		['a referral code', 'tr_ref_0123456789ab'],
		['something else', 'not-a-key'],
	])('refuses %s without asking Torrin', async (_, value) => {
		render(<TorrinLoginPage />);
		submit(value);

		expect(
			await screen.findByText(/referral codes \(tr_ref_\.\.\.\) do not sign in/)
		).toBeInTheDocument();
		expect(getTorrinUser).not.toHaveBeenCalled();
		expect(setApiKey).not.toHaveBeenCalled();
	});

	it('reports a rejected key', async () => {
		getTorrinUser.mockRejectedValue(new TorrinError('invalid api key', 'unauthorized', 401));

		render(<TorrinLoginPage />);
		submit();

		expect(await screen.findByText('Torrin rejected that key.')).toBeInTheDocument();
		expect(setApiKey).not.toHaveBeenCalled();
		expect(replace).not.toHaveBeenCalled();
	});

	// A paused or expired plan answers 403 for a key that is fine: telling the
	// user it was rejected would send them to make a new key for nothing.
	it('tells a refused plan apart from a rejected key, in Torrin words', async () => {
		getTorrinUser.mockRejectedValue(
			new TorrinError('subscription expired', 'subscription_inactive', 403)
		);

		render(<TorrinLoginPage />);
		submit();

		expect(
			await screen.findByText(
				/That key works, but the plan cannot be used right now\. subscription expired/
			)
		).toBeInTheDocument();
		expect(screen.queryByText('Torrin rejected that key.')).not.toBeInTheDocument();
		expect(setApiKey).not.toHaveBeenCalled();
	});

	it('surfaces any other failure as one, and lets the user try again', async () => {
		getTorrinUser.mockRejectedValueOnce(new TorrinError('Torrin is not answering', 'network'));

		render(<TorrinLoginPage />);
		submit();

		expect(
			await screen.findByText('Could not check that key: Torrin is not answering')
		).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Save API Key' })).toBeEnabled();
	});

	it('links to the page where Torrin makes keys, and asks for one without login', () => {
		render(<TorrinLoginPage />);

		expect(screen.getByRole('link', { name: 'Get an API Key from Torrin' })).toHaveAttribute(
			'href',
			'https://torrin.app/app/settings'
		);
		expect(screen.getByText(/with “login allowed” off/)).toBeInTheDocument();
	});

	describe('with a parked account', () => {
		beforeEach(async () => {
			localStorage.setItem('tr:apiKey', '"dad-key"');
			await parkCurrentAccount('tr:', { id: 'u-1', label: 'dad' });
		});

		it('offers to continue as it, restoring its key and loading the redirect', async () => {
			vi.mocked(useRouter).mockReturnValue({
				replace,
				query: { redirect: '/library' },
			} as any);

			render(<TorrinLoginPage />);
			fireEvent.click(await screen.findByRole('button', { name: 'dad' }));

			await waitFor(() => expect(assign).toHaveBeenCalledWith('/library'));
			expect(localStorage.getItem('tr:apiKey')).toBe('"dad-key"');
			expect(listSavedAccounts('tr:')).toEqual([]);
			expect(replace).not.toHaveBeenCalled();
		});
	});
});
