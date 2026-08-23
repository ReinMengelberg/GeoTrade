// import {} from ;

export interface PricePoint {
	timestamp: Date;
	price: number;
}

export interface LivePrice extends PricePoint {
	symbol: string;
}

export interface HistoryPrice {
	symbol: string;
	history: PricePoint[];	
}

export interface IPriceApi {
	fetchLivePrice(symbols: string[]): Promise<LivePrice[]>;
	fetchHistoryPriceTotal(symbol: string, startDate: Date): Promise<HistoryPrice>;
	fetchHistoryPriceMinute(symbol: string, startDate: Date): Promise<HistoryPrice>;
	fetchHistoryPriceHour(symbol: string, startDate: Date): Promise<HistoryPrice>;
}

export class PriceFetcher {
	constructor() {}
	async fetchLivePrice(symbols: string[]): Promise<LivePrice[]> {
		if (symbols.length === 0) return [];

	}

	async fetchHistoryPriceTotal(symbol: string, startDate: Date): Promise<HistoryPrice> {

	}

	async fetchHistoryPriceMinute(symbol: string, startDate: Date): Promise<HistoryPrice> {

	}

	async fetchHistoryPriceHour(symbol: string, startDate: Date): Promise<HistoryPrice> {

	}
}