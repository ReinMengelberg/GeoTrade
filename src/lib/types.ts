export interface Trade {
	id: number;
	symbol: string;
	quantity: number;
	price: number;
}

export type NewTrade = Omit<Trade, 'id'>;
