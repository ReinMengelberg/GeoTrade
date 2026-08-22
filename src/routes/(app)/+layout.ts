import { ApiClient } from '$lib/services/api';
import type { Trade } from '$lib/types';
import type { LayoutLoad } from './$types';

// Fetches the seed data for the stores set up in +layout.svelte. Uses the
// load-provided fetch so SSR forwards the session cookie and the response is
// inlined into the page — the browser replays it during hydration instead of
// fetching again.
export const load: LayoutLoad = async ({ fetch, data }) => {
	const api = new ApiClient(fetch);

	return {
		...data,
		trades: await api.get<Trade[]>('/api/trades')
	};
};
