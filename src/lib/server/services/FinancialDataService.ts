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
	unit: 'minute' | 'hour' | 'day';
}

export interface IPriceFetcher {
	fetchLivePrices(assets: Asset[]): Promise<AssetPrice[]>;
	fetchDailySeries(asset: Asset, startTime: Date, endTime?: Date): Promise<AssetPriceSeries>;
	fetchPriceSeries(asset: Asset, startTime: Date, interval: Duration, period: Duration): Promise<AssetPriceSeries>;
}

type TiingoBar = {
	date: string;
	close: number;
};

type TiingoStockQuote = {
	ticker: string;
	timestamp: string;
	tngoLast: number | null;
	last: number | null;
};

type TiingoForexQuote = {
	ticker: string;
	quoteTimestamp: string;
	midPrice: number | null;
};

type TiingoCryptoPrice = {
	ticker: string;
	priceData: TiingoBar | TiingoBar[];
};

type RequestSpec = { path: string; params?: Record<string, string> };

function assertNever(value: never): never {
	throw new Error(`Unhandled asset type: ${JSON.stringify(value)}`);
}

export class PriceFetcher implements IPriceFetcher {
	private static readonly MAX_URL_LENGTH = 8000;
	private static readonly ASSET_TYPES: readonly AssetType[] = ['stock', 'forex', 'crypto'];
	private readonly baseUrl = 'https://api.tiingo.com';
	private readonly token: string;

	constructor(token: string) {
		if (!token) throw new Error('Tiingo API token is missing');
		this.token = token;
	}

	async fetchLivePrices(assets: Asset[]): Promise<AssetPrice[]> {
		if (assets.length === 0) return [];
		for (const asset of assets) this.validateAsset(asset);

		const [stocks, forex, crypto] = await Promise.all([
			this.fetchLiveStocks(assets.filter((a) => a.type === 'stock')),
			this.fetchLiveForex(assets.filter((a) => a.type === 'forex')),
			this.fetchLiveCrypto(assets.filter((a) => a.type === 'crypto'))
		]);
		return [...stocks, ...forex, ...crypto];
	}

	async fetchDailySeries(asset: Asset, startTime: Date, endTime?: Date): Promise<AssetPriceSeries> {
		this.validateAsset(asset);
		this.validateDate(startTime);
		if (endTime !== undefined) {
			this.validateDate(endTime);
			if (endTime <= startTime) throw new Error('End time must be after start time');
		}

		const bars = await this.fetchDailyBars(asset, startTime, endTime);
		const points = this.toPricePoints(bars)
			.filter((point) => point.timestamp >= startTime && (endTime === undefined || point.timestamp < endTime))
			.sort(this.comparePoints);

		return { asset, points };
	}

	async fetchPriceSeries(asset: Asset, startTime: Date, interval: Duration, period: Duration): Promise<AssetPriceSeries> {
		this.validateAsset(asset);
		this.validateDate(startTime);
		this.validateDuration(interval);
		this.validateDuration(period);
		if (interval.unit === 'day') throw new Error('Use fetchDailySeries() for daily prices');

		const intervalMs = this.durationToMilliseconds(interval);
		const periodMs = this.durationToMilliseconds(period);
		if (periodMs < intervalMs) throw new Error('Period must be at least as long as interval');

		const endTime = new Date(startTime.getTime() + periodMs);
		const lookbackStart = this.getLookbackStart(startTime, intervalMs);
		const bars = await this.fetchIntradayBars(asset, lookbackStart, endTime, interval);
		const points = this.toPricePoints(bars).sort(this.comparePoints);

		return {
			asset,
			points: this.buildPriceSeries(asset, points, startTime, endTime, intervalMs)
		};
	}

	private fetchLiveStocks(assets: Asset[]): Promise<AssetPrice[]> {
		return this.fetchBatchedLive(
			assets,
			(symbols) => ({ path: `/iex/${symbols.map(encodeURIComponent).join(',')}` }),
			async (batch) => {
				const quotes = await this.httpGet<TiingoStockQuote[]>(batch.path, batch.params);
				return quotes.flatMap((quote) => {
					const asset = this.findAsset(batch.assets, quote.ticker);
					const price = quote.tngoLast ?? quote.last;
					if (!asset || price == null) return [];
					return [{ asset, point: { timestamp: new Date(quote.timestamp), price } }];
				});
			}
		);
	}

	private fetchLiveForex(assets: Asset[]): Promise<AssetPrice[]> {
		return this.fetchBatchedLive(
			assets,
			(symbols) => ({ path: '/tiingo/fx/top', params: { tickers: symbols.join(',') } }),
			async (batch) => {
				const quotes = await this.httpGet<TiingoForexQuote[]>(batch.path, batch.params);
				return quotes.flatMap((quote) => {
					const asset = this.findAsset(batch.assets, quote.ticker);
					if (!asset || quote.midPrice == null) return [];
					return [{ asset, point: { timestamp: new Date(quote.quoteTimestamp), price: quote.midPrice } }];
				});
			}
		);
	}

	private fetchLiveCrypto(assets: Asset[]): Promise<AssetPrice[]> {
		return this.fetchBatchedLive(
			assets,
			(symbols) => ({ path: '/tiingo/crypto/prices', params: { tickers: symbols.join(',') } }),
			async (batch) => {
				const quotes = await this.httpGet<TiingoCryptoPrice[]>(batch.path, batch.params);
				return quotes.flatMap((quote) => {
					const asset = this.findAsset(batch.assets, quote.ticker);
					if (!asset) return [];
					const priceData = Array.isArray(quote.priceData) ? quote.priceData[quote.priceData.length - 1] : quote.priceData;
					if (!priceData) return [];
					return [{ asset, point: { timestamp: new Date(priceData.date), price: priceData.close } }];
				});
			}
		);
	}

	private async fetchBatchedLive(
		assets: Asset[],
		buildRequest: (symbols: string[]) => RequestSpec,
		parseBatch: (batch: { assets: Asset[] } & RequestSpec) => Promise<AssetPrice[]>
	): Promise<AssetPrice[]> {
		if (assets.length === 0) return [];
		const batches = this.splitAssetBatches(assets, buildRequest);
		const results = await Promise.all(batches.map(parseBatch));
		return results.flat();
	}

	private splitAssetBatches(assets: Asset[], buildRequest: (symbols: string[]) => RequestSpec): Array<{ assets: Asset[] } & RequestSpec> {
		const result: Array<{ assets: Asset[] } & RequestSpec> = [];
		let current: Asset[] = [];

		const requestLength = (batchAssets: Asset[]): number => {
			const { path, params } = buildRequest(batchAssets.map((a) => a.symbol));
			return this.buildUrl(path, params).length;
		};

		for (const asset of assets) {
			if (current.length === 0 && requestLength([asset]) > PriceFetcher.MAX_URL_LENGTH) {
				throw new Error(`Asset symbol is too long for an HTTP request: ${asset.symbol}`);
			}
			if (current.length > 0 && requestLength([...current, asset]) > PriceFetcher.MAX_URL_LENGTH) {
				result.push({ assets: current, ...buildRequest(current.map((a) => a.symbol)) });
				current = [];
			}
			current.push(asset);
		}
		if (current.length > 0) result.push({ assets: current, ...buildRequest(current.map((a) => a.symbol)) });
		return result;
	}

	private async fetchDailyBars(asset: Asset, startTime: Date, endTime?: Date): Promise<TiingoBar[]> {
		const params: Record<string, string> = { startDate: startTime.toISOString() };
		if (endTime) params.endDate = endTime.toISOString();

		switch (asset.type) {
			case 'stock':
				return this.httpGet<TiingoBar[]>(`/tiingo/daily/${encodeURIComponent(asset.symbol)}/prices`, params);
			case 'forex':
				return this.httpGet<TiingoBar[]>(`/tiingo/fx/${encodeURIComponent(asset.symbol)}/prices`, { ...params, resampleFreq: '1day' });
			case 'crypto': {
				const response = await this.httpGet<TiingoCryptoPrice[]>('/tiingo/crypto/prices', { ...params, tickers: asset.symbol, resampleFreq: '1day' });
				const data = response[0]?.priceData;
				return Array.isArray(data) ? data : data ? [data] : [];
			}
			default:
				return assertNever(asset.type);
		}
	}

	private toDateOnly(date: Date): string {
		return date.toISOString().slice(0, 10); // "YYYY-MM-DD"
	}

	private async fetchIntradayBars(asset: Asset, startTime: Date, endTime: Date, interval: Duration): Promise<TiingoBar[]> {
		const params = {
			startDate: startTime.toISOString(),
			endDate: endTime.toISOString(),
			resampleFreq: this.durationToTiingoFrequency(interval)
		};

		switch (asset.type) {
			case 'stock':
				return this.httpGet<TiingoBar[]>(`/iex/${encodeURIComponent(asset.symbol)}/prices`, {
					...params,
					startDate: this.toDateOnly(startTime),   // IEX rejects timestamps, only accepts dates
					endDate: this.toDateOnly(endTime)
				});
			case 'forex':
				return this.httpGet<TiingoBar[]>(`/tiingo/fx/${encodeURIComponent(asset.symbol)}/prices`, params);
			case 'crypto': {
				const response = await this.httpGet<TiingoCryptoPrice[]>('/tiingo/crypto/prices', { ...params, tickers: asset.symbol });
				const data = response[0]?.priceData;
				return Array.isArray(data) ? data : data ? [data] : [];
			}
			default:
				return assertNever(asset.type);
		}
	}

	private buildPriceSeries(asset: Asset, points: PricePoint[], startTime: Date, endTime: Date, intervalMs: number): PricePoint[] {
		const result: PricePoint[] = [];
		let index = 0;
		let lastPrice: number | undefined;

		for (let time = startTime.getTime(); time < endTime.getTime(); time += intervalMs) {
			while (index < points.length && points[index].timestamp.getTime() <= time) {
				lastPrice = points[index].price;
				index++;
			}
			if (lastPrice === undefined) {
				throw new Error(`No price available at or before ${new Date(time).toISOString()} for ${asset.type} ${asset.symbol}`);
			}
			result.push({ timestamp: new Date(time), price: lastPrice });
		}
		return result;
	}

	private getLookbackStart(startTime: Date, intervalMs: number): Date {
		return new Date(startTime.getTime() - intervalMs);
	}

	private toPricePoints(bars: TiingoBar[]): PricePoint[] {
		return bars.flatMap((bar) => {
			const timestamp = new Date(bar.date);
			if (Number.isNaN(timestamp.getTime()) || !Number.isFinite(bar.close)) return [];
			return [{ timestamp, price: bar.close }];
		});
	}

	private findAsset(assets: Asset[], symbol: string): Asset | undefined {
		const normalized = symbol.toUpperCase();
		return assets.find((asset) => asset.symbol.toUpperCase() === normalized);
	}

	private validateAsset(asset: Asset): void {
		if (!asset.symbol.trim()) throw new Error('Asset symbol is missing');
		if (!PriceFetcher.ASSET_TYPES.includes(asset.type)) {
			throw new Error(`Unknown asset type: ${asset.type}`);
		}
	}

	private validateDate(date: Date): void {
		if (Number.isNaN(date.getTime())) throw new Error('Invalid date');
	}

	private validateDuration(duration: Duration): void {
		if (!Number.isInteger(duration.value) || duration.value <= 0) {
			throw new Error('Duration value must be a positive integer');
		}
	}

	private durationToMilliseconds(duration: Duration): number {
		const factors = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
		return duration.value * factors[duration.unit];
	}

	private durationToTiingoFrequency(duration: Duration): string {
		const suffixes = { minute: 'min', hour: 'hour', day: 'day' };
		return `${duration.value}${suffixes[duration.unit]}`;
	}

	private buildUrl(path: string, params?: Record<string, string>): string {
		const url = new URL(path, this.baseUrl);
		if (params) {
			for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
		}
		return url.toString();
	}

	private async httpGet<T>(path: string, params?: Record<string, string>): Promise<T> {
		const url = this.buildUrl(path, params);
		const response = await fetch(url, {
			method: 'GET',
			headers: { Authorization: `Token ${this.token}`, Accept: 'application/json' }
		});
		if (!response.ok) {
			const body = await response.text();
			throw new Error(`Tiingo API error ${response.status}: ${body}`);
		}
		return response.json() as Promise<T>;
	}

	private comparePoints(a: PricePoint, b: PricePoint): number {
		return a.timestamp.getTime() - b.timestamp.getTime();
	}
}
