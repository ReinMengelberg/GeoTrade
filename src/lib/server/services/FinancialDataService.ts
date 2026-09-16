export type AssetType = 'stock' | 'forex' | 'crypto';

export interface Asset {
	symbol: string;
	type: AssetType;
}

export interface PricePoint {
	timestamp: Date;
	price: number;
}

export interface AssetPrice {
	asset: Asset;
	point: PricePoint;
}

export interface AssetPriceSeries {
	asset: Asset;
	points: PricePoint[];
}

export interface Duration {
	value: number;
	unit: 'min' | 'hour' | 'day';
}

type Bar = {
	date: string;
	close: number;
};

type StockQuote = {
	ticker: string;
	timestamp: string;
	tngoLast: number | null;
	last: number | null;
};

type ForexQuote = {
	ticker: string;
	quoteTimestamp: string;
	midPrice: number | null;
};

type CryptoQuote = {
	ticker: string;
	priceData?: Bar[];
};

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface IPriceFetcher {
	fetchLivePrices(assets: Asset[]): Promise<AssetPrice[]>;
	fetchDailySeries(asset: Asset, startTime: Date, endTime?: Date): Promise<AssetPriceSeries>;
	fetchPriceSeries(asset: Asset, startTime: Date, interval: Duration, period: Duration): Promise<AssetPriceSeries>;
}

export class PriceFetcher implements IPriceFetcher {
	private static readonly LOOKBACK_DAYS_MS = [
		1 * DAY_MS,
		2 * DAY_MS,
		3 * DAY_MS,
		4 * DAY_MS,
		10 * DAY_MS,
		11 * DAY_MS
	];

	private readonly baseUrl = 'https://api.tiingo.com';
	private readonly token: string;

	constructor(token: string) {
		if (!token)
			throw new Error('Tiingo API token is missing');
		this.token = token;
	}

	async fetchLivePrices(assets: Asset[]): Promise<AssetPrice[]> {
		const stocks = assets.filter(asset => asset.type === 'stock');
		const forex = assets.filter(asset => asset.type === 'forex');
		const crypto = assets.filter(asset => asset.type === 'crypto');
		const [stockPrices, forexPrices, cryptoPrices] = await Promise.all([
			this.fetchLiveStocks(stocks),
			this.fetchLiveForex(forex),
			this.fetchLiveCrypto(crypto)
		]);
		return [...stockPrices, ...forexPrices, ...cryptoPrices];
	}

	async fetchDailySeries(asset: Asset, startTime: Date, endTime?: Date): Promise<AssetPriceSeries> {
		const params = this.createParams(asset, startTime, endTime, '1day');
		const points = await this.fetchBars(asset, params);
		return {asset, points};
	}

	async fetchPriceSeries(asset: Asset, startTime: Date, interval: Duration, period: Duration): Promise<AssetPriceSeries> {
		const startMs = startTime.getTime();
		const endMs = startMs + this.toMs(period);
		for (const lookbackMs of PriceFetcher.LOOKBACK_DAYS_MS) {
			const params = this.createParams(asset, new Date(startMs - lookbackMs), new Date(endMs), `${interval.value}${interval.unit}`);
			const points = await this.fetchBars(asset, params);
			if (!points.length)
				continue;
			if (points[0].timestamp.getTime() > startMs)
				continue;
			return {asset, points: this.createPriceSeries(points, startMs, endMs, this.toMs(interval))};
		}
		throw new Error(`No price available for ${asset.symbol} at ${startTime.toISOString()}`);
	}

	private async fetchLiveStocks(assets: Asset[]): Promise<AssetPrice[]> {
		if (!assets.length)
			return [];
		const symbols = assets.map(asset => encodeURIComponent(asset.symbol)).join(',');
		const quotes = await this.httpGet<StockQuote[]>(`/iex/${symbols}`);
		const prices: AssetPrice[] = [];
		for (const quote of quotes) {
			const asset = assets.find(asset => asset.symbol.toLowerCase() === quote.ticker.toLowerCase());
			if (!asset)
				continue;
			let price = quote.tngoLast;
			if (price == null)
				price = quote.last;
			if (price == null)
				continue;
			prices.push({asset, point: {timestamp: new Date(quote.timestamp), price}});
		}
		return prices;
	}

	private async fetchLiveForex(assets: Asset[]): Promise<AssetPrice[]> {
		if (!assets.length)
			return [];
		const tickers = assets.map(asset => asset.symbol).join(',');
		const quotes = await this.httpGet<ForexQuote[]>('/tiingo/fx/top', {tickers});
		const prices: AssetPrice[] = [];
		for (const quote of quotes) {
			const asset = assets.find(asset => asset.symbol.toLowerCase() === quote.ticker.toLowerCase());
			if (!asset)
				continue;
			if (quote.midPrice == null)
				continue;
			prices.push({asset, point: {timestamp: new Date(quote.quoteTimestamp), price: quote.midPrice}});
		}
		return prices;
	}

	private async fetchLiveCrypto(assets: Asset[]): Promise<AssetPrice[]> {
		if (!assets.length)
			return [];
		const tickers = assets.map(asset => asset.symbol).join(',');
		const quotes = await this.httpGet<CryptoQuote[]>('/tiingo/crypto/prices', {tickers});
		const prices: AssetPrice[] = [];
		for (const quote of quotes) {
			const asset = assets.find(asset => asset.symbol.toLowerCase() === quote.ticker.toLowerCase());
			if (!asset)
				continue;
			if (!quote.priceData)
				continue;
			const bar = quote.priceData.at(-1);
			if (!bar)
				continue;
			prices.push({asset, point: {timestamp: new Date(bar.date), price: bar.close}});
		}
		return prices;
	}

	private toMs(duration: Duration): number {
		if (duration.unit === 'min')
			return duration.value * MINUTE_MS;
		else if (duration.unit === 'hour')
			return duration.value * HOUR_MS;
		else
			return duration.value * DAY_MS;
	}

	private createParams(asset: Asset, startTime: Date, endTime: Date | undefined, resampleFreq: string): Record<string, string> {
		const params: Record<string, string> = {};
		if (asset.type === 'stock') {
			params.startDate = startTime.toISOString().slice(0, 10);
			if (endTime)
				params.endDate = endTime.toISOString().slice(0, 10);
			if (resampleFreq !== '1day')
				params.resampleFreq = resampleFreq;
		} else if (asset.type === 'forex') {
			params.startDate = startTime.toISOString();
			if (endTime)
				params.endDate = endTime.toISOString();
			params.resampleFreq = resampleFreq;
		} else {
			params.startDate = startTime.toISOString();
			if (endTime)
				params.endDate = endTime.toISOString();
			params.resampleFreq = resampleFreq;
			params.tickers = asset.symbol;
		}
		return params;
	}

	private async fetchBars(asset: Asset, params: Record<string, string>): Promise<PricePoint[]> {
		let bars: Bar[];
		if (asset.type === 'stock')
			bars = await this.fetchStockBars(asset, params);
		else if (asset.type === 'forex')
			bars = await this.fetchForexBars(asset, params);
		else
			bars = await this.fetchCryptoBars(params);
		const points = bars.map(bar => {
			return {timestamp: new Date(bar.date), price: bar.close};
		});
		points.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
		return points;
	}

	private async fetchStockBars(asset: Asset, params: Record<string, string>): Promise<Bar[]> {
		const path = encodeURIComponent(asset.symbol);
		if (params.resampleFreq)
			return this.httpGet<Bar[]>(`/iex/${path}/prices`, params);
		return this.httpGet<Bar[]>(`/tiingo/daily/${path}/prices`, params);
	}

	private async fetchForexBars(asset: Asset, params: Record<string, string>): Promise<Bar[]> {
		const path = encodeURIComponent(asset.symbol);
		return this.httpGet<Bar[]>(`/tiingo/fx/${path}/prices`, params);
	}

	private async fetchCryptoBars(params: Record<string, string>): Promise<Bar[]> {
		const quotes = await this.httpGet<CryptoQuote[]>('/tiingo/crypto/prices', params);
		if (!quotes.length)
			return [];
		const bars = quotes[0].priceData;
		if (!bars)
			return [];
		return bars;
	}

	private createPriceSeries(points: PricePoint[], startMs: number, endMs: number, intervalMs: number): PricePoint[] {
		const series: PricePoint[] = [];
		let index = 0;
		let lastKnownPrice = points[0].price;
		for (let time = startMs; time < endMs; time += intervalMs) {
			while (index < points.length && points[index].timestamp.getTime() <= time) {
				lastKnownPrice = points[index].price;
				index++;
			}
			series.push({timestamp: new Date(time), price: lastKnownPrice});
		}
		return series;
	}

	private async httpGet<T>(path: string, params?: Record<string, string>): Promise<T> {
		const url = new URL(path, this.baseUrl);
		if (params) {
			for (const [key, value] of Object.entries(params))
				url.searchParams.set(key, value);
		}
		const headers = {Authorization: `Token ${this.token}`, Accept: 'application/json'};
		const response = await fetch(url, {headers});
		if (!response.ok)
			throw new Error(`Tiingo API error ${response.status} for ${path}`);
		return response.json() as Promise<T>;
	}
}