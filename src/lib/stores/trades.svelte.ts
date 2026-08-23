import { api } from '$lib/services/api';
import type { NewTrade, Trade } from '$lib/types';

export class TradeStore {
	trades = $state<Trade[]>([]);

	constructor(initial: Trade[]) {
		this.trades = initial;
	}

	async create(input: NewTrade) {
		const created = await api.post<Trade>('/api/trades', input);
		this.trades.push(created);
	}

	async refresh() {
		this.trades = await api.get<Trade[]>('/api/trades');
	}
}
