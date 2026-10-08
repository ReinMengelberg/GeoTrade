/**
 * `MarketData` with fake feeds. No network. The fake feed factory lets us
 * control every event the feeds emit, so we can exercise routing, the
 * Finnhub overflow rule, and the cache without touching a provider.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketData } from '../../src/lib/server/services/market/marketdata';
import type { Asset, AssetType } from '../../src/lib/server/services/market/types';
import type { FeedProvider, IFeed } from '../../src/lib/server/services/market/live';
import { FakeFeed, sleep } from './helpers';

const AAPL: Asset = { name: 'Apple', symbol: 'AAPL', type: 'us' };
const EURUSD: Asset = { name: 'EUR/USD', symbol: 'EURUSD', type: 'forex' };
const BTC: Asset = { name: 'BTC', symbol: 'BTCUSDT', type: 'crypto' };

function makeFetcher() {
	const byRoute = new Map<string, FakeFeed>();
	const factory = (type: AssetType, _key: string, provider: FeedProvider): IFeed => {
		const key = `${type}:${provider}`;
		const feed = new FakeFeed();
		byRoute.set(key, feed);
		return feed;
	};
	const fetcher = new MarketData('test-finnhub-key', undefined, factory);
	return { fetcher, byRoute };
}

// ─── subscribe / routing ────────────────────────────────────────────────────

test('subscribe: creates one feed per type', async () => {
	const { fetcher, byRoute } = makeFetcher();
	const result = await fetcher.subscribe([AAPL, EURUSD, BTC]);

	assert.ok(byRoute.has('us:primary'));
	assert.ok(byRoute.has('forex:primary'));
	assert.ok(byRoute.has('crypto:primary'));

	assert.deepEqual(
		byRoute.get('us:primary')!.subscribeCalls[0].map((a) => a.symbol),
		['AAPL']
	);
	assert.deepEqual(
		byRoute.get('forex:primary')!.subscribeCalls[0].map((a) => a.symbol),
		['EURUSD']
	);
	assert.deepEqual(
		byRoute.get('crypto:primary')!.subscribeCalls[0].map((a) => a.symbol),
		['BTCUSDT']
	);

	assert.equal(result.failures.length, 0);
	assert.equal(result.subscribed.length, 3);
});

test('subscribe: rejects "us" without a Finnhub key', async () => {
	const fetcher = new MarketData('', undefined, () => new FakeFeed());
	await assert.rejects(fetcher.subscribe([AAPL]), /FINNHUB_API_KEY/);
});

test('subscribe: empty list returns an empty result', async () => {
	const { fetcher, byRoute } = makeFetcher();
	const result = await fetcher.subscribe([]);
	assert.equal(byRoute.size, 0);
	assert.deepEqual(result, { subscribed: [], failures: [] });
});

// ─── Finnhub overflow ───────────────────────────────────────────────────────

test('overflow: 51st US symbol goes to the yahoo-overflow feed', async () => {
	const { fetcher, byRoute } = makeFetcher();
	const usAssets = Array.from({ length: 51 }, (_, i) => ({
		name: `Stock ${i}`,
		symbol: `S${i}`,
		type: 'us' as const
	}));
	await fetcher.subscribe(usAssets);

	const primary = byRoute.get('us:primary')!;
	const overflow = byRoute.get('us:us-yahoo-overflow')!;
	assert.equal(primary.subscribeCalls[0].length, 50);
	assert.equal(overflow.subscribeCalls[0].length, 1);
	assert.equal(overflow.subscribeCalls[0][0].symbol, 'S50');
});

// ─── unsubscribe ────────────────────────────────────────────────────────────

test('unsubscribe: evicts cache and forwards to the feed', async () => {
	const { fetcher, byRoute } = makeFetcher();
	await fetcher.subscribe([AAPL]);
	const feed = byRoute.get('us:primary')!;
	feed.emitTick(AAPL, 150);

	assert.equal(fetcher.snapshot([AAPL]).length, 1);

	await fetcher.unsubscribe([AAPL]);
	assert.equal(fetcher.snapshot([AAPL]).length, 0);
	assert.equal(feed.unsubscribeCalls.length, 1);
});

// ─── snapshot ───────────────────────────────────────────────────────────────

test('snapshot: dedupes the filter by asset key', async () => {
	const { fetcher, byRoute } = makeFetcher();
	await fetcher.subscribe([AAPL]);
	byRoute.get('us:primary')!.emitTick(AAPL, 150);

	const out = fetcher.snapshot([AAPL, AAPL, { ...AAPL, symbol: 'aapl' }]);
	assert.equal(out.length, 1);
});

test('snapshot: returns empty for uncached assets', async () => {
	const { fetcher } = makeFetcher();
	assert.deepEqual(fetcher.snapshot([AAPL]), []);
});

test('snapshot: ageMs grows with time since receipt', async () => {
	const { fetcher, byRoute } = makeFetcher();
	await fetcher.subscribe([AAPL]);
	byRoute.get('us:primary')!.emitTick(AAPL, 150);

	const [before] = fetcher.snapshot([AAPL]);
	await sleep(30);
	const [after] = fetcher.snapshot([AAPL]);
	assert.ok(after.ageMs > before.ageMs);
});

// ─── out-of-order tick guard ────────────────────────────────────────────────

test('onTick: an older tick does not overwrite a newer cache entry', async () => {
	const { fetcher, byRoute } = makeFetcher();
	await fetcher.subscribe([AAPL]);
	const feed = byRoute.get('us:primary')!;

	const t2 = new Date('2026-01-01T00:00:02Z');
	const t1 = new Date('2026-01-01T00:00:01Z');
	feed.emitTick(AAPL, 200, t2);
	feed.emitTick(AAPL, 100, t1);

	const [entry] = fetcher.snapshot([AAPL]);
	assert.equal(entry.point.price, 200);
});

// ─── events ─────────────────────────────────────────────────────────────────

test('price: fires with ageMs = 0 on arrival', async () => {
	const { fetcher, byRoute } = makeFetcher();
	await fetcher.subscribe([AAPL]);
	const prices: Array<{ price: number; ageMs: number }> = [];
	fetcher.on('price', (p) => prices.push({ price: p.point.price, ageMs: p.ageMs }));

	byRoute.get('us:primary')!.emitTick(AAPL, 150);
	await sleep(10);
	assert.equal(prices.length, 1);
	assert.equal(prices[0].price, 150);
	assert.equal(prices[0].ageMs, 0);
});

test('feedStatus: payload is { type, provider, status }', async () => {
	const { fetcher } = makeFetcher();
	const events: Array<{ type: string; provider: string; status: string }> = [];
	fetcher.on('feedStatus', (e) => events.push({ type: e.type, provider: e.provider, status: e.status }));
	await fetcher.subscribe([AAPL]);
	await sleep(10);
	assert.ok(
		events.some((e) => e.type === 'us' && e.provider === 'primary' && e.status === 'open')
	);
});

// ─── stop ───────────────────────────────────────────────────────────────────

test('stop: closes all feeds, clears cache, is idempotent', async () => {
	const { fetcher, byRoute } = makeFetcher();
	await fetcher.subscribe([AAPL, EURUSD]);
	byRoute.get('us:primary')!.emitTick(AAPL, 150);

	await fetcher.stop();
	assert.ok([...byRoute.values()].every((f) => f.closed));
	assert.deepEqual(fetcher.snapshot(), []);
	await assert.doesNotReject(fetcher.stop());
});

test('stop: blocks concurrent subscribe', async () => {
	const { fetcher } = makeFetcher();
	const stopPromise = fetcher.stop();
	await assert.rejects(fetcher.subscribe([AAPL]), /stop\(\) is in progress/);
	await stopPromise;
});

test('stop: concurrent calls share one shutdown', async () => {
	const { fetcher, byRoute } = makeFetcher();
	await fetcher.subscribe([AAPL]);

	const feed = byRoute.get('us:primary')!;
	let closed = false;
	const originalClose = feed.close.bind(feed);
	feed.close = async () => {
		await sleep(50);
		await originalClose();
		closed = true;
	};

	const first = fetcher.stop();
	await sleep(10);
	const second = fetcher.stop();
	await second;

	assert.equal(closed, true, 'second stop() must wait for the first to complete');
});

// ─── fetchBars delegation ───────────────────────────────────────────────────

test('fetchBars: delegates to the injected history provider', async () => {
	let called = 0;
	const fakeHistory = {
		fetchBars: async () => { called++; return []; }
	};
	const fetcher = new MarketData('k', fakeHistory, () => new FakeFeed());
	await fetcher.fetchBars({ asset: AAPL });
	assert.equal(called, 1);
});

// ─── partial-failure contract ───────────────────────────────────────────────

test('subscribe: failed routes are released so they do not consume Finnhub slots', async () => {
	const byRoute = new Map<string, FakeFeed>();
	const factory = (type: AssetType, _key: string, provider: FeedProvider): IFeed => {
		const key = `${type}:${provider}`;
		let feed = byRoute.get(key);
		if (!feed) {
			feed = new FakeFeed();
			byRoute.set(key, feed);
		}
		return feed;
	};
	const fetcher = new MarketData('test-key', undefined, factory);

	// Fail the Finnhub feed.
	const primary = new FakeFeed();
	primary.failOnSubscribe = true;
	byRoute.set('us:primary', primary);

	const failed = Array.from({ length: 50 }, (_, i) => ({
		name: `S${i}`, symbol: `S${i}`, type: 'us' as const
	}));
	const result = await fetcher.subscribe(failed);
	assert.equal(result.subscribed.length, 0);
	assert.equal(result.failures.length, 1);
	assert.equal(result.failures[0].type, 'us');
	assert.equal(result.failures[0].provider, 'primary');

	// Let primary succeed again. Subscribe 50 fresh assets. If the failed
	// routes were released, all 50 fit under the cap.
	primary.failOnSubscribe = false;
	const fresh = Array.from({ length: 50 }, (_, i) => ({
		name: `T${i}`, symbol: `T${i}`, type: 'us' as const
	}));
	const second = await fetcher.subscribe(fresh);
	assert.equal(second.failures.length, 0);
	assert.ok(
		!byRoute.has('us:us-yahoo-overflow'),
		'no overflow feed should be created when failed routes are released'
	);
});

test('subscribe: partial failure is reported in the result, not thrown', async () => {
	const byRoute = new Map<string, FakeFeed>();
	const factory = (type: AssetType, _key: string, provider: FeedProvider): IFeed => {
		const key = `${type}:${provider}`;
		let feed = byRoute.get(key);
		if (!feed) {
			feed = new FakeFeed();
			byRoute.set(key, feed);
		}
		return feed;
	};
	const fetcher = new MarketData('test-key', undefined, factory);

	// Fail the Finnhub route only.
	const usFeed = new FakeFeed();
	usFeed.failOnSubscribe = true;
	byRoute.set('us:primary', usFeed);

	// Finnhub fails; Binance succeeds.
	const result = await fetcher.subscribe([AAPL, BTC]);
	assert.equal(result.subscribed.length, 1);
	assert.equal(result.subscribed[0].symbol, 'BTCUSDT');
	assert.equal(result.failures.length, 1);
	assert.equal(result.failures[0].type, 'us');
	assert.equal(result.failures[0].provider, 'primary');
	assert.equal(result.failures[0].assets.length, 1);
	assert.equal(result.failures[0].assets[0].symbol, 'AAPL');
	assert.ok(result.failures[0].error instanceof Error);

	// Crypto remained subscribed despite the failure.
	const cryptoFeed = byRoute.get('crypto:primary')!;
	assert.equal(cryptoFeed.subscribeCalls.length, 1);
});

test('subscribe: deduplicates the subscribed list', async () => {
	const { fetcher } = makeFetcher();
	const result = await fetcher.subscribe([AAPL, AAPL, { ...AAPL, symbol: 'aapl' }]);
	assert.equal(result.subscribed.length, 1, 'duplicate input collapses to one entry');
	assert.equal(result.subscribed[0].symbol, 'AAPL');
});

test('subscribe: failure payload carries type and provider, not a route string', async () => {
	const byRoute = new Map<string, FakeFeed>();
	const factory = (type: AssetType, _key: string, provider: FeedProvider): IFeed => {
		const key = `${type}:${provider}`;
		let feed = byRoute.get(key);
		if (!feed) {
			feed = new FakeFeed();
			byRoute.set(key, feed);
		}
		return feed;
	};
	const fetcher = new MarketData('test-key', undefined, factory);

	const usFeed = new FakeFeed();
	usFeed.failOnSubscribe = true;
	byRoute.set('us:primary', usFeed);

	const result = await fetcher.subscribe([AAPL]);
	assert.equal(result.failures.length, 1);
	const failure = result.failures[0];
	assert.equal(failure.type, 'us');
	assert.equal(failure.provider, 'primary');
	assert.equal(failure.assets.length, 1);
	assert.ok(failure.error instanceof Error);
	// No composite route string on the failure object.
	assert.ok(!('route' in failure), 'failure should not expose the internal route key');
});

test('stop: instance is reusable afterwards', async () => {
	const { fetcher, byRoute } = makeFetcher();
	await fetcher.subscribe([AAPL]);
	await fetcher.stop();

	// A fresh subscribe after stop must create fresh feeds and work normally.
	const result = await fetcher.subscribe([BTC]);
	assert.equal(result.failures.length, 0);
	assert.equal(result.subscribed.length, 1);

	// A new feed was created (the old map was cleared by stop).
	assert.ok(byRoute.get('crypto:primary')?.subscribeCalls.length === 1);
});

test('subscribe: failure.assets is deduplicated like subscribed', async () => {
	const byRoute = new Map<string, FakeFeed>();
	const factory = (type: AssetType, _key: string, provider: FeedProvider): IFeed => {
		const key = `${type}:${provider}`;
		let feed = byRoute.get(key);
		if (!feed) {
			feed = new FakeFeed();
			byRoute.set(key, feed);
		}
		return feed;
	};
	const fetcher = new MarketData('test-key', undefined, factory);

	const usFeed = new FakeFeed();
	usFeed.failOnSubscribe = true;
	byRoute.set('us:primary', usFeed);

	// Two spellings of the same asset in the input.
	const result = await fetcher.subscribe([AAPL, { ...AAPL, symbol: 'aapl' }]);
	assert.equal(result.failures.length, 1);
	assert.equal(
		result.failures[0].assets.length,
		1,
		'duplicate input collapses to one entry in the failure payload'
	);
});