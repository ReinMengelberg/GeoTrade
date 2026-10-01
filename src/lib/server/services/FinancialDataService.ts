import { EventEmitter } from 'node:events';
import { assetKey, createFeed } from './FeedService';
import type { Asset, AssetType, FeedProvider, IFeed } from './FeedService';
import type { WsStatus } from './WebSocketService';

export type { Asset, AssetType, WsStatus };

// ============================================================================
// Types
// ============================================================================

export interface PricePoint {
	timestamp: Date;
	price: number;
}

export interface AssetPrice {
	asset: Asset;
	point: PricePoint;
	/** Milliseconds since this price was received locally (not the market age). */
	ageMs: number;
}

export interface IPriceFetcher {
	subscribe(assets: Asset[]): Promise<void>;
	unsubscribe(assets: Asset[]): Promise<void>;
	stop(): Promise<void>;
	snapshot(filter?: Asset[]): AssetPrice[];
	on(event: 'price', listener: (price: AssetPrice) => void): this;
	on(event: 'feedStatus', listener: (provider: AssetType, status: WsStatus) => void): this;
	on(event: 'feedError', listener: (provider: AssetType, error: Error) => void): this;
}

interface CacheEntry {
	asset: Asset;
	point: PricePoint;
	receivedAt: number;
}

interface Route {
	key: string;
	type: AssetType;
	provider: FeedProvider;
}

const makeRoute = (type: AssetType, provider: FeedProvider = 'primary'): Route => ({
	key: provider === 'primary' ? type : `${type}:${provider}`,
	type,
	provider
});

// ============================================================================
// PriceFetcher
// ============================================================================

/**
 * Routes assets to one feed per asset type and keeps the latest price of each.
 * "us" assets go to Finnhub until its symbol limit is reached; the rest go to Yahoo.
 *
 * Events:
 *   'price'      (AssetPrice)               every tick
 *   'feedStatus' (type, status)             note: both "us" feeds report as 'us'
 *   'feedError'  (type, error)
 */
export class PriceFetcher extends EventEmitter implements IPriceFetcher {
	private static readonly FINNHUB_MAX_SYMBOLS = 50;

	private readonly feeds = new Map<string, IFeed>();
	private readonly routes = new Map<string, Route>();
	private readonly cache = new Map<string, CacheEntry>();

	constructor(private readonly finnhubApiKey: string) {
		super();
	}

	// --------------------------------------------------------------------------
	// Public API
	// --------------------------------------------------------------------------

	async subscribe(assets: Asset[]): Promise<void> {
		if (!this.finnhubApiKey && assets.some((a) => a.type === 'us')) {
			throw new Error('FINNHUB_API_KEY required for "us" assets');
		}

		const groups = PriceFetcher.groupByRoute(assets, (asset) => this.assign(asset));
		const results = await Promise.allSettled(
			[...groups.values()].map(({ route, assets }) => this.getFeed(route).subscribe(assets))
		);

		const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
		if (failures.length > 0 && failures.length === results.length) throw failures[0].reason;
	}

	async unsubscribe(assets: Asset[]): Promise<void> {
		for (const asset of assets) this.cache.delete(assetKey(asset));

		const groups = PriceFetcher.groupByRoute(assets, (asset) => {
			const key = assetKey(asset);
			const route = this.routes.get(key);
			this.routes.delete(key);
			return route;
		});
		await Promise.all(
			[...groups.values()].map(({ route, assets }) => this.feeds.get(route.key)?.unsubscribe(assets))
		);
	}

	async stop(): Promise<void> {
		const feeds = [...this.feeds.values()];
		this.feeds.clear();
		this.routes.clear();
		await Promise.all(feeds.map((feed) => feed.close()));
		this.cache.clear();
	}

	snapshot(filter?: Asset[]): AssetPrice[] {
		const now = Date.now();
		const entries = filter
			? filter.flatMap((asset) => this.cache.get(assetKey(asset)) ?? [])
			: [...this.cache.values()];

		return entries.map(({ asset, point, receivedAt }) => ({ asset, point, ageMs: now - receivedAt }));
	}

	// --------------------------------------------------------------------------
	// Internals
	// --------------------------------------------------------------------------

	private static groupByRoute(
		assets: Asset[],
		routeOf: (asset: Asset) => Route | undefined
	): Map<string, { route: Route; assets: Asset[] }> {
		const groups = new Map<string, { route: Route; assets: Asset[] }>();
		for (const asset of assets) {
			const route = routeOf(asset);
			if (!route) continue;
			const group = groups.get(route.key) ?? { route, assets: [] };
			group.assets.push(asset);
			groups.set(route.key, group);
		}
		return groups;
	}

	private assign(asset: Asset): Route {
		const key = assetKey(asset);
		let route = this.routes.get(key);
		if (!route) {
			const finnhubFull =
				asset.type === 'us' && this.finnhubCount() >= PriceFetcher.FINNHUB_MAX_SYMBOLS;
			route = makeRoute(asset.type, finnhubFull ? 'us-yahoo-overflow' : 'primary');
			this.routes.set(key, route);
		}
		return route;
	}

	private finnhubCount(): number {
		let count = 0;
		for (const route of this.routes.values()) {
			if (route.type === 'us' && route.provider === 'primary') count++;
		}
		return count;
	}

	private getFeed(route: Route): IFeed {
		let feed = this.feeds.get(route.key);
		if (!feed) {
			feed = createFeed(route.type, this.finnhubApiKey, route.provider);
			feed.on('tick', (asset, price, time) => this.onTick(asset, price, time));
			feed.on('status', (status) => this.emit('feedStatus', route.type, status));
			feed.on('error', (error) => this.emit('feedError', route.type, error));
			this.feeds.set(route.key, feed);
		}
		return feed;
	}

	/**
	 * Feeds emit validated ticks (price > 0, valid time). We only guard against
	 * out-of-order arrivals here: a batched provider (Yahoo) can deliver an
	 * older tick after a newer one, and the cache must keep the newest.
	 */
	private onTick(asset: Asset, price: number, marketTime: Date): void {
		const key = assetKey(asset);
		const existing = this.cache.get(key);
		if (existing && marketTime.getTime() < existing.point.timestamp.getTime()) return;

		const point: PricePoint = { timestamp: marketTime, price };
		this.cache.set(key, { asset, point, receivedAt: Date.now() });
		this.emit('price', { asset, point, ageMs: 0 } satisfies AssetPrice);
	}
}