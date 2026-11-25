import { SavedAccountsPicker } from '@/components/SavedAccountsPicker';
import useLocalStorage from '@/hooks/localStorage';
import {
	getTorrinUser,
	isTorrinAuthError,
	isTorrinKeyShaped,
	isTorrinPlanRefusal,
} from '@/services/torrin';
import { getSafeRedirectPath } from '@/utils/router';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useState } from 'react';

/** Where Torrin lists an account's API keys and makes new ones. */
const TORRIN_KEYS_URL = 'https://torrin.app/app/settings';

/**
 * Torrin has no OAuth: an API key is the only credential. Its settings page
 * makes extra keys beside the account's own, each with "login allowed" on or
 * off, so this page asks for one made for DMM with login off. Such a key can
 * add, list and stream, but cannot sign in to Torrin's website.
 */
export default function TorrinLoginPage() {
	const router = useRouter();
	const [, setApiKey] = useLocalStorage<string>('tr:apiKey');
	const [inputApiKey, setInputApiKey] = useState('');
	const [error, setError] = useState('');
	const [checking, setChecking] = useState(false);
	const redirectPath = getSafeRedirectPath(router.query.redirect, '/');

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError('');
		const apiKey = inputApiKey.trim();
		// Caught here rather than sent: a referral code is the other `tr_` string
		// on Torrin's account page, and Torrin would only answer it with a 401.
		if (!isTorrinKeyShaped(apiKey)) {
			setError(
				'That does not look like a Torrin API key. Keys start with tr_; referral codes (tr_ref_...) do not sign in.'
			);
			return;
		}
		setChecking(true);
		try {
			await getTorrinUser(apiKey);
			setApiKey(apiKey);
			await router.replace(redirectPath);
		} catch (err) {
			// A paused or expired plan is a 403 for a key that works: say so,
			// rather than "rejected", since renewing the plan is the way out.
			setError(
				isTorrinAuthError(err)
					? 'Torrin rejected that key.'
					: isTorrinPlanRefusal(err)
						? `That key works, but the plan cannot be used right now. ${err instanceof Error ? err.message : ''}`
						: `Could not check that key: ${err instanceof Error ? err.message : 'unknown error'}`
			);
			setChecking(false);
		}
	};

	return (
		<div className="flex min-h-screen flex-col items-center px-4 pt-[12vh] pb-8">
			<Head>
				<title>Debrid Media Manager - Torrin Login</title>
			</Head>
			<div className="sibling-space-y-4 w-full max-w-md p-4">
				<h1 className="text-center text-2xl font-bold">Connect Torrin</h1>
				{error && <p className="text-center text-red-500">{error}</p>}
				{/* A full load, as the service card's switch does, so nothing loaded before the swap survives it. */}
				<SavedAccountsPicker
					prefix="tr:"
					current={null}
					afterSwitch={() => window.location.assign(redirectPath)}
				/>

				<form onSubmit={handleSubmit} className="sibling-space-y-4">
					<div>
						<label htmlFor="apiKey" className="block text-sm font-medium">
							API Key
						</label>
						<input
							type="text"
							id="apiKey"
							value={inputApiKey}
							onChange={(e) => setInputApiKey(e.target.value)}
							className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden"
							placeholder="tr_..."
							autoComplete="off"
							spellCheck={false}
							required
						/>
					</div>
					<div className="sibling-space-y-2 flex flex-col">
						<button
							type="submit"
							disabled={checking}
							className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
						>
							{checking ? 'Checking...' : 'Save API Key'}
						</button>
						<a
							href={TORRIN_KEYS_URL}
							target="_blank"
							rel="noopener noreferrer"
							className="rounded border-2 border-[#c8956c] bg-[#c8956c]/30 px-4 py-2 text-center text-orange-100 transition-colors hover:bg-[#c8956c]/50"
						>
							Get an API Key from Torrin
						</a>
					</div>
				</form>
				<p className="text-center text-xs text-gray-400">
					On Torrin&rsquo;s settings page, under &ldquo;Additional API keys&rdquo;, create
					a key for DMM with &ldquo;login allowed&rdquo; off. It can add and stream but
					cannot sign in to Torrin, and you can revoke it there at any time.
				</p>
				<p className="text-center text-xs text-gray-400">
					Debrid Media Manager is an integration for Torrin; Torrin did not make it. Your
					key stays in this browser, which calls Torrin directly. It reaches DMM&rsquo;s
					server only with your other logins, when you turn on remembering them across
					devices; linking a TV or Kodi leaves it out. The names and hashes of your Torrin
					downloads go to DMM&rsquo;s server to name the movies and shows in your library,
					as they do for every service.
				</p>
			</div>
		</div>
	);
}
