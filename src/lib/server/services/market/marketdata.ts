/**
 * marketdata.ts — the application's entry point for market data.
 *
 * Routes live subscriptions to one feed per asset type, keeps the latest tick
 * of each in memory, and forwards historical requests to a provider. Knows
 * nothing about sockets or protocols — those live behind `IFeed` and
 * `IHistoryProvider`.
 */

import { EventEmitter } from 'node:events';
import {
	assetKey,
	type Asset,
	type AssetPrice,
	type AssetType,
	type Bar,
	type ConnectionStatus,
	type HistoryRequest,
	type PricePoint
} from './types';
import { createFeed, type FeedProvider, type IFeed } from './live';
import { createHistoryProvider, type IHistoryProvider } from './history';

/** Payload of the `'feedStatus'` event. */
export interface FeedStatusEvent {
	type: AssetType;
	provider: FeedProvider;
	status: ConnectionStatus;
}

/** Payload of the `'feedError'` event. */
export interface FeedErrorEvent {
	type: AssetType;
	provider: FeedProvider;
	error: Error;
}

/** One route's failure to subscribe. */
export interface SubscribeFailure {
	type: AssetType;
	provider: FeedProvider;
	/** The assets this route was asked to subscribe, deduplicated by asset key. */
	assets: Asset[];
	/** The original error from the feed. */
	error: Error;
}

/** Returned by `subscribe()`. */
export interface SubscribeResult {
	/** Assets passed to this call that are now subscribed, deduplicated. */
	subscribed: Asset[];
	/** Per-route failures. Empty when every route succeeded. */
	failures: SubscribeFailure[];
}

export interface IMarketData {
	/**
	 * Subscribes to `assets`. Never rejects for feed failures — those arrive
	 * in `SubscribeResult.failures`. Rejects only for precondition errors
	 * (a missing Finnhub key, or a concurrent `stop()`).
	 */
	subscribe(assets: Asset[]): Promise<SubscribeResult>;
	unsubscribe(assets: Asset[]): Promise<void>;
	stop(): Promise<void>;
	snapshot(filter?: Asset[]): AssetPrice[];
	fetchBars(req: HistoryRequest): Promise<Bar[]>;
	on(event: 'price', listener: (price: AssetPrice) => void): this;
	on(event: 'feedStatus', listener: (event: FeedStatusEvent) => void): this;
	on(event: 'feedError', listener: (event: FeedErrorEvent) => void): this;
}

interface CacheEntry {
	asset: Asset;
	point: PricePoint;
	/** Wall-clock millis when this tick arrived. `ageMs` derives from this. */
	receivedAt: number;
}

interface Route {
	/** Feed-map key: `type` for primary, `type:provider` for overflow. */
	key: string;
	type: AssetType;
	provider: FeedProvider;
}

/**
 * Live:
 *   Routes assets to a feed per type, keeps the latest tick of each, pushes
 *   every tick as `'price'`. "us" assets go to Finnhub until its symbol limit
 *   is reached, then to Yahoo.
 *
 * Historical:
 *   Delegates to an `IHistoryProvider` selected by asset type.
 *
 * Events:
 *   'price'      (AssetPrice)            every tick
 *   'feedStatus' (FeedStatusEvent)       { type, provider, status }
 *   'feedError'  (FeedErrorEvent)        { type, provider, error }
 *
 * Contract:
 *   - `subscribe()` resolves with a `SubscribeResult`. Feed failures are not
 *     thrown; the caller inspects `failures` if it cares. Precondition errors
 *     (missing key, concurrent stop) still reject.
 *   - `stop()` is a reset. After it completes, the instance is reusable: a
 *     subsequent `subscribe()` starts fresh feeds. It is not final.
 *   - `subscribe()` calls must not overlap with each other, and must not
 *     overlap with `stop()`. Serialize them at the call site. Two concurrent
 *     subscribes to the same new asset can both resolve with the asset listed
 *     as subscribed, while only one of them actually subscribed it.
 *
 * Known limitations (deliberate):
 *   - `snapshot()` and `'price'` events return references to the cached
 *     objects. Treat as read-only. Safe for a single trusted caller, but
 *     would need freezing or cloning if exposed to plugins.
 *   - Route stickiness: once an asset is assigned to the Yahoo overflow feed
 *     because the Finnhub cap was hit, it stays there even if earlier assets
 *     are unsubscribed.
 *   - `ManagedWebSocket.connect()` rejects on the first failure but keeps
 *     retrying in the background. `BaseFeed` compensates by closing the
 *     socket when the rollback empties the asset set.
 *   - If BiQuote's SignalR auto-reconnect gives up while a `subscribe()` is
 *     pending during the reconnect window, that promise resolves successfully
 *     (the asset is registered) but no connection serves it. Recovery is via
 *     a subsequent `subscribe`. There is no event for this case.
 */
export class MarketData extends EventEmitter implements IMarketData {
	private static readonly FINNHUB_MAX_SYMBOLS = 50;

	private readonly feeds = new Map<string, IFeed>();
	private readonly routes = new Map<string, Route>();
	private readonly cache = new Map<string, CacheEntry>();

	/** Non-undefined while a shutdown is in flight. */
	private stopping?: Promise<void>;

	constructor(
		private readonly finnhubApiKey: string,
		private readonly history: IHistoryProvider = createHistoryProvider(),
		private readonly feedFactory: (t: AssetType, k: string, p: FeedProvider) => IFeed = createFeed
	) {
		super();
	}

	// ─── Live ───────────────────────────────────────────────────────────────

	async subscribe(assets: Asset[]): Promise<SubscribeResult> {
		if (this.stopping) throw new Error('Cannot subscribe while stop() is in progress');
		// Overlapping subscribe() calls race — see the contract block above.
		if (!this.finnhubApiKey && assets.some((a) => a.type === 'us')) {
			throw new Error('FINNHUB_API_KEY required for "us" assets');
		}

		// Snapshot which routes existed before this call. On failure, only
		// newly claimed routes are released — pre-existing subscriptions keep
		// theirs. Without this, a failed subscribe would leave its routes
		// behind and block Finnhub slots until explicitly unsubscribed.
		const preexisting = new Set<string>();
		for (const asset of assets) {
			const key = assetKey(asset);
			if (this.routes.has(key)) preexisting.add(key);
		}

		const entries = [...MarketData.groupByRoute(assets, (asset) => this.routeOf(asset)).entries()];

		// One result per route group. Settled in parallel; flattened in the
		// order `entries` was built so the output is stable.
		const perGroup = await Promise.all(
			entries.map(async ([, group]): Promise<
				| { ok: true; assets: Asset[] }
				| { ok: false; failure: SubscribeFailure }
			> => {
				try {
					await this.getFeed(group.route).subscribe(group.assets);
					return { ok: true, assets: group.assets };
				} catch (error) {
					// Release routes claimed by this call so they don't hold slots.
					for (const asset of group.assets) {
						const key = assetKey(asset);
						if (!preexisting.has(key)) this.routes.delete(key);
					}
					return {
						ok: false,
						failure: {
							type: group.route.type,
							provider: group.route.provider,
							assets: dedupeAssets(group.assets),
							error: error instanceof Error ? error : new Error(String(error))
						}
					};
				}
			})
		);

		const subscribed = dedupeAssets(perGroup.flatMap((r) => (r.ok ? r.assets : [])));
		const failures = perGroup
			.filter((r): r is { ok: false; failure: SubscribeFailure } => !r.ok)
			.map((r) => r.failure);
		return { subscribed, failures };
	}

	async unsubscribe(assets: Asset[]): Promise<void> {
		for (const asset of assets) this.cache.delete(assetKey(asset));

		// Deleting the route inside the callback keeps bucketing and state
		// mutation in one pass.
		const groups = MarketData.groupByRoute(assets, (asset) => {
			const key = assetKey(asset);
			const route = this.routes.get(key);
			if (!route) return undefined;
			this.routes.delete(key);
			return route;
		});
		await Promise.all(
			[...groups.values()].map(({ route, assets }) =>
				this.feeds.get(route.key)?.unsubscribe(assets)
			)
		);
	}

	stop(): Promise<void> {
		if (this.stopping) return this.stopping;
		this.stopping = this.doStop();
		return this.stopping;
	}

	private async doStop(): Promise<void> {
		try {
			const feeds = [...this.feeds.values()];
			this.feeds.clear();
			this.routes.clear();
			await Promise.all(feeds.map((feed) => feed.close()));
		} finally {
			// Cache is cleared even if a feed's close failed.
			this.cache.clear();
			this.stopping = undefined;
		}
	}

	snapshot(filter?: Asset[]): AssetPrice[] {
		const now = Date.now();

		// Dedupe by asset key: a filter listing the same asset twice returns
		// one entry, not two. Preserves first-occurrence order.
		const seen = new Set<string>();
		const out: AssetPrice[] = [];
		const push = (key: string, entry: CacheEntry): void => {
			if (seen.has(key)) return;
			seen.add(key);
			out.push({
				asset: entry.asset,
				point: entry.point,
				ageMs: now - entry.receivedAt
			});
		};

		if (filter) {
			for (const asset of filter) {
				const key = assetKey(asset);
				const entry = this.cache.get(key);
				if (entry) push(key, entry);
			}
		} else {
			for (const [key, entry] of this.cache) push(key, entry);
		}
		return out;
	}

	fetchBars(req: HistoryRequest): Promise<Bar[]> {
		return this.history.fetchBars(req);
	}

	// ─── Internals ──────────────────────────────────────────────────────────

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

	/**
	 * Called synchronously during grouping. Relies on JS being single-threaded
	 * so two concurrent subscribes can't assign the same symbol twice.
	 */
	private routeOf(asset: Asset): Route {
		const key = assetKey(asset);
		const existing = this.routes.get(key);
		if (existing) return existing;

		const finnhubFull =
			asset.type === 'us' && this.finnhubPrimaryCount() >= MarketData.FINNHUB_MAX_SYMBOLS;
		const provider: FeedProvider = finnhubFull ? 'us-yahoo-overflow' : 'primary';
		const route: Route = {
			key: provider === 'primary' ? asset.type : `${asset.type}:${provider}`,
			type: asset.type,
			provider
		};
		this.routes.set(key, route);
		return route;
	}

	/** Derived from `routes`. O(n), called once per new asset per subscribe. */
	private finnhubPrimaryCount(): number {
		let n = 0;
		for (const route of this.routes.values()) {
			if (route.type === 'us' && route.provider === 'primary') n++;
		}
		return n;
	}

	private getFeed(route: Route): IFeed {
		let feed = this.feeds.get(route.key);
		if (!feed) {
			feed = this.feedFactory(route.type, this.finnhubApiKey, route.provider);
			feed.on('tick', (asset, price, time) => this.onTick(asset, price, time));
			feed.on('status', (status) =>
				this.emit('feedStatus', {
					type: route.type,
					provider: route.provider,
					status
				} satisfies FeedStatusEvent)
			);
			feed.on('error', (error) =>
				this.emit('feedError', {
					type: route.type,
					provider: route.provider,
					error
				} satisfies FeedErrorEvent)
			);
			this.feeds.set(route.key, feed);
		}
		return feed;
	}

	/**
	 * Feeds emit validated ticks. We guard against out-of-order arrivals here:
	 * a batched provider (Yahoo) can deliver an older tick after a newer one.
	 */
	private onTick(asset: Asset, price: number, marketTime: Date): void {
		const key = assetKey(asset);
		const existing = this.cache.get(key);
		if (existing && marketTime.getTime() < existing.point.timestamp.getTime()) return;

		const point: PricePoint = { timestamp: marketTime, price };
		this.cache.set(key, { asset, point, receivedAt: Date.now() });
		// ageMs is zero by construction here; it only grows in snapshots.
		this.emit('price', { asset, point, ageMs: 0 } satisfies AssetPrice);
	}
}

/**
 * Deduplicates a list of assets by `assetKey`, preserving first-occurrence
 * order. Used to keep `subscribed` and `failures[].assets` consistent — both
 * are built from raw input that may contain the same asset twice.
 */
function dedupeAssets(assets: Asset[]): Asset[] {
	const seen = new Set<string>();
	const out: Asset[] = [];
	for (const asset of assets) {
		const key = assetKey(asset);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(asset);
	}
	return out;
}