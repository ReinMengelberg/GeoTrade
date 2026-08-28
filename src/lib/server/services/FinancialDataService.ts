// import { TIINGO_API_KEY } from '$env/static/private';

export type AssetType =
	'stock' |
	'forex' |
	'crypto';

export interface Asset {
	symbol: string;
	type: AssetType;
}

export interface PricePoint {
	date: Date;
	price: number;
}

export interface AssetPrice extends PricePoint {
	asset: Asset;
}

export interface AssetPriceSeries {
	asset: Asset;
	priceSeries: PricePoint[];	
}

export interface IPriceFetcher {
	fetchAssetPrice(
		assets?: Asset[]
	): Promise<AssetPrice[]>;

	fetchAssetPriceSeriesTotal(
		asset: Asset
	): Promise<AssetPriceSeries>;

	fetchAssetPriceSeriesMinute(
		asset: Asset,
		startDate: Date
	): Promise<AssetPriceSeries>;

	fetchAssetPriceSeriesHour(
		asset: Asset,
		startDate: Date
	): Promise<AssetPriceSeries>;
}

interface TiingoQuote {
	ticker: string;
	timestamp?: string;
	quoteTimestamp?: string;
	lastSaleTimeStamp?: string;
	date?: string;
	last?: number;
	tngoLast?: number;
	close?: number;
	midPrice?: number;
	bidPrice?: number;
	priceData?: Array<{
		date?: string;
		timestamp?: string;
		close: number
	}>;
}

export class PriceFetcher implements IPriceFetcher {
	private readonly apiKey: string;
	private readonly baseUrl = 'https://api.tiingo.com';
	private readonly maxUrlLength = 2048;
	private readonly maxCryptoTickers = 5;
	private readonly rateLimitDelayMs = 250;

	constructor(apiKey?: string) {
		this.apiKey = apiKey || process.env.TIINGO_API_KEY || '';
		if (!this.apiKey) {
			throw new Error('Tiingo API key missing. Pass to constructor or set TIINGO_API_KEY.');
		}
	}

	private async httpGet<T>(path: string): Promise<T> {
		const url = new URL(path, this.baseUrl).toString();
		
		const response = await fetch(url, {
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Token ${this.apiKey}`
			}
		});

		if (!response.ok) {
			throw new Error(`Tiingo API error (${response.status}): ${response.statusText}`);
		}

		return response.json() as Promise<T>;
	}

	private formatDate(date: Date): string {
		return date.toISOString().split('T')[0];
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private parseDate(rawDate?: string | null): Date {
		if (!rawDate) return new Date();
		const parsed = new Date(rawDate);
		return isNaN(parsed.getTime()) ? new Date() : parsed;
	}

	private buildUrlPaths(basePath: string, symbols: string[], maxCount = Infinity): string[] {
		if (symbols.length === 0) return [];

		const paths: string[] = [];
		let currentChunk: string[] = [];
		let currentLen = 0;
		
		const delimiter = basePath.includes('?') ? '&' : '?';
		const prefixLen = this.baseUrl.length + basePath.length + delimiter.length + 8;

		for (const symbol of symbols) {
			const addedLen = currentChunk.length === 0 ? symbol.length : symbol.length + 1;

			if (currentChunk.length >= maxCount || prefixLen + currentLen + addedLen > this.maxUrlLength) {
				paths.push(`${basePath}${delimiter}tickers=${currentChunk.join(',')}`);
				currentChunk = [symbol];
				currentLen = symbol.length;
			} else {
				currentChunk.push(symbol);
				currentLen += addedLen;
			}
		}

		if (currentChunk.length > 0) {
			paths.push(`${basePath}${delimiter}tickers=${currentChunk.join(',')}`);
		}

		return paths;
	}

	async fetchAssetPrice(assets: Asset[] = []): Promise<AssetPrice[]> {
		if (!assets.length) return [];

		const assetMap = new Map<string, Asset>(
			assets.map(a => [`${a.type}:${a.symbol.toLowerCase()}`, a])
		);

		const requests = [
			...this.buildUrlPaths('/iex/', assets.filter(a => a.type === 'stock').map(a => a.symbol))
				.map(path => ({ path, type: 'stock' as AssetType })),
			...this.buildUrlPaths('/tiingo/fx/top', assets.filter(a => a.type === 'forex').map(a => a.symbol))
				.map(path => ({ path, type: 'forex' as AssetType })),
			...this.buildUrlPaths('/tiingo/crypto/prices', assets.filter(a => a.type === 'crypto').map(a => a.symbol.toLowerCase()), this.maxCryptoTickers)
				.map(path => ({ path, type: 'crypto' as AssetType }))
		];

		const results: AssetPrice[] = [];

		for (let i = 0; i < requests.length; i++) {
			if (i > 0) await this.delay(this.rateLimitDelayMs);
			const rawData = await this.httpGet<TiingoQuote[]>(requests[i].path);
			results.push(...this.parseLiveResponse(rawData, requests[i].type, assetMap));
		}

		return results;
	}

	private parseLiveResponse(raw: TiingoQuote[], type: AssetType, assetMap: Map<string, Asset>): AssetPrice[] {
		if (!Array.isArray(raw)) return [];

		return raw.flatMap(item => {
			const key = `${type}:${item.ticker.toLowerCase()}`;
			const asset = assetMap.get(key) ?? { symbol: item.ticker, type };

			if (type === 'crypto') {
				const latest = item.priceData?.[0];
				if (!latest) return [];
				return [{
					asset,
					price: latest.close,
					date: this.parseDate(latest.date ?? latest.timestamp ?? item.timestamp)
				}];
			}

			const price = item.last ?? item.tngoLast ?? item.close ?? item.midPrice ?? item.bidPrice;
			const rawDate = item.timestamp ?? item.quoteTimestamp ?? item.lastSaleTimeStamp ?? item.date;

			if (price === undefined) return [];

			return [{
				asset,
				price,
				date: this.parseDate(rawDate)
			}];
		});
	}

	async fetchAssetPriceSeriesTotal(asset: Asset): Promise<AssetPriceSeries> {
		return this.fetchIntervalPrices(asset, '1900-01-01', undefined, '1day');
	}

	async fetchAssetPriceSeriesMinute(asset: Asset, startDate: Date): Promise<AssetPriceSeries> {
		const endDate = new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);
		return this.fetchIntervalPrices(asset, this.formatDate(startDate), this.formatDate(endDate), '10min');
	}

	async fetchAssetPriceSeriesHour(asset: Asset, startDate: Date): Promise<AssetPriceSeries> {
		const endDate = new Date(startDate.getTime() + 30 * 24 * 60 * 60 * 1000);
		return this.fetchIntervalPrices(asset, this.formatDate(startDate), this.formatDate(endDate), '1hour');
	}

	private async fetchIntervalPrices(asset: Asset, startStr: string, endStr?: string, freq = '1day'): Promise<AssetPriceSeries> {
		// Using URLSearchParams elegantly handles ? and & combinations
		const params = new URLSearchParams({ startDate: startStr });
		if (endStr) params.append('endDate', endStr);
		if (freq !== '1day') params.append('resampleFreq', freq);

		let basePath = '';
		if (asset.type === 'stock') {
			basePath = freq === '1day' ? `/tiingo/daily/${asset.symbol}/prices` : `/iex/${asset.symbol}/prices`;
		} else if (asset.type === 'forex') {
			basePath = `/tiingo/fx/${asset.symbol}/prices`;
		} else if (asset.type === 'crypto') {
			basePath = `/tiingo/crypto/prices`;
			params.append('tickers', asset.symbol.toLowerCase());
		}

		const rawData = await this.httpGet<TiingoQuote[]>(`${basePath}?${params.toString()}`);
		
		return {
			asset,
			priceSeries: this.parseHistoryData(rawData, asset.type)
		};
	}

	private parseHistoryData(rawData: TiingoQuote[], type: AssetType): PricePoint[] {
		if (!Array.isArray(rawData) || rawData.length === 0) return [];

		if (type === 'crypto' && rawData[0]?.priceData) {
			return rawData[0].priceData.map(p => ({
				date: this.parseDate(p.date ?? p.timestamp),
				price: p.close
			}));
		}

		return rawData.map(p => ({
			date: this.parseDate(p.date ?? p.timestamp),
			price: p.close ?? p.midPrice ?? 0
		}));
	}
}