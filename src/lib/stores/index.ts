import { getContext, setContext } from 'svelte';
import { ApiClient } from '$lib/services/api';
import { auth } from '$lib/stores/auth.svelte';
import { TradeStore } from '$lib/stores/trades.svelte';
import type { Trade } from '$lib/types';

export interface SeedData {
	trades: Trade[];
}

export interface Stores {
	api: ApiClient;
	auth: typeof auth;
	trades: TradeStore;
}

const KEY = Symbol('stores');

// Called once from (app)/+layout.svelte. Runs during render, so every SSR
// request builds its own instances — seeding here can never leak across users.
// Store methods only run from browser events, so the default fetch is fine.
export function initStores(seed: SeedData): Stores {
	const api = new ApiClient();

	return setContext<Stores>(KEY, {
		api,
		auth,
		trades: new TradeStore(api, seed.trades)
	});
}

export function useStores(): Stores {
	return getContext<Stores>(KEY);
}
