import type { ApiClient } from '$lib/services/api';
import type { NewTrade, Trade } from '$lib/types';

export class TradeStore {
	trades = $state<Trade[]>([]);

	constructor(
		private api: ApiClient,
		initial: Trade[]
	) {
		this.trades = initial;
	}

	async create(input: NewTrade) {
		const created = await this.api.post<Trade>('/api/trades', input);
		this.trades.push(created);
	}

	async refresh() {
		this.trades = await this.api.get<Trade[]>('/api/trades');
	}
}
