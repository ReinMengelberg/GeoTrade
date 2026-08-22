import { getContext, setContext } from 'svelte';
import { auth } from '$lib/stores/auth.svelte';
import { TradeStore } from '$lib/stores/trades.svelte';
import type { Trade } from '$lib/types';

export interface SeedData {
	trades: Trade[];
}

export interface Stores {
	auth: typeof auth;
	trades: TradeStore;
}

const KEY = Symbol('stores');

// Called once from (app)/+layout.svelte. Runs during render, so every SSR
// request builds its own instances — seeding here can never leak across users.
export function initStores(seed: SeedData): Stores {
	return setContext<Stores>(KEY, {
		auth,
		trades: new TradeStore(seed.trades)
	});
}

export function useStores(): Stores {
	return getContext<Stores>(KEY);
}
