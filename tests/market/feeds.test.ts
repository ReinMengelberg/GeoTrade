/**
 * Concrete feed classes against a local WebSocket server. Each test stands
 * up a fake provider that speaks just enough of the real protocol to
 * exercise the feed's subscribe / unsubscribe / dispatch path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	BinanceFeed,
	FinnhubFeed,
	YahooFeed
} from '../../src/lib/server/services/market/live';
import type { Asset } from '../../src/lib/server/services/market/types';
import { startTestServer, waitFor } from './helpers';

const AAPL: Asset = { name: 'Apple', symbol: 'AAPL', type: 'us' };
const MSFT: Asset = { name: 'Microsoft', symbol: 'MSFT', type: 'us' };
const BTC: Asset = { name: 'Bitcoin', symbol: 'BTCUSDT', type: 'crypto' };

// ─── FinnhubFeed ────────────────────────────────────────────────────────────

test('FinnhubFeed: subscribe sends one frame per asset', async () => {
	const server = await startTestServer();
	try {
		const feed = new FinnhubFeed('test-key', server.url);
		await feed.subscribe([AAPL, MSFT]);
		await waitFor(() => (server.frames[0]?.length ?? 0) >= 2);
		assert.equal(server.frames[0].length, 2);
		const parsed = server.frames[0].map((f) => JSON.parse(f));
		assert.deepEqual(parsed, [
			{ type: 'subscribe', symbol: 'AAPL' },
			{ type: 'subscribe', symbol: 'MSFT' }
		]);
		await feed.close();
	} finally {
		await server.close();
	}
});

test('FinnhubFeed: unsubscribing sends unsubscribe frames', async () => {
	const server = await startTestServer();
	try {
		const feed = new FinnhubFeed('test-key', server.url);
		await feed.subscribe([AAPL, MSFT]);
		await waitFor(() => (server.frames[0]?.length ?? 0) >= 2);
		await feed.unsubscribe([AAPL]);
		await waitFor(() => (server.frames[0]?.length ?? 0) >= 3);
		assert.equal(server.frames[0].length, 3);
		assert.deepEqual(
			JSON.parse(server.frames[0][2]),
			{ type: 'unsubscribe', symbol: 'AAPL' }
		);
		await feed.close();
	} finally {
		await server.close();
	}
});

test('FinnhubFeed: dispatches ticks to listeners', async () => {
	const server = await startTestServer();
	try {
		const feed = new FinnhubFeed('test-key', server.url);
		const received: Array<{ asset: Asset; price: number }> = [];
		feed.on('tick', (asset, price) => received.push({ asset, price }));
		await feed.subscribe([AAPL]);
		await waitFor(() => server.clients.length > 0);
		server.broadcast(JSON.stringify({
			type: 'trade',
			data: [{ s: 'AAPL', p: 150.25, t: Date.now() }]
		}));
		await waitFor(() => received.length === 1);
		assert.equal(received[0].asset.symbol, 'AAPL');
		assert.equal(received[0].price, 150.25);
		await feed.close();
	} finally {
		await server.close();
	}
});

test('FinnhubFeed: ticks for unsubscribed symbols are dropped', async () => {
	const server = await startTestServer();
	try {
		const feed = new FinnhubFeed('test-key', server.url);
		const received: string[] = [];
		feed.on('tick', (asset) => received.push(asset.symbol));
		await feed.subscribe([AAPL]);
		await waitFor(() => server.clients.length > 0);
		server.broadcast(JSON.stringify({
			type: 'trade',
			data: [{ s: 'GOOG', p: 100, t: Date.now() }]
		}));
		await new Promise((r) => setTimeout(r, 50));
		assert.deepEqual(received, []);
		await feed.close();
	} finally {
		await server.close();
	}
});

// ─── YahooFeed ──────────────────────────────────────────────────────────────

test('YahooFeed: sends a single frame with the full symbol list', async () => {
	const server = await startTestServer();
	try {
		const feed = new YahooFeed(server.url);
		await feed.subscribe([AAPL, MSFT]);
		await waitFor(() => (server.frames[0]?.length ?? 0) >= 1);
		assert.equal(server.frames[0].length, 1);
		assert.deepEqual(JSON.parse(server.frames[0][0]), { subscribe: ['AAPL', 'MSFT'] });
		await feed.close();
	} finally {
		await server.close();
	}
});

test('YahooFeed: resends the full list on further subscribes', async () => {
	const server = await startTestServer();
	try {
		const feed = new YahooFeed(server.url);
		await feed.subscribe([AAPL]);
		await waitFor(() => (server.frames[0]?.length ?? 0) >= 1);
		await feed.subscribe([MSFT]);
		await waitFor(() => (server.frames[0]?.length ?? 0) >= 2);
		assert.equal(server.frames[0].length, 2);
		assert.deepEqual(JSON.parse(server.frames[0][1]), { subscribe: ['AAPL', 'MSFT'] });
		await feed.close();
	} finally {
		await server.close();
	}
});

test('YahooFeed: unsubscribe does not send a frame', async () => {
	const server = await startTestServer();
	try {
		const feed = new YahooFeed(server.url);
		await feed.subscribe([AAPL, MSFT]);
		await waitFor(() => (server.frames[0]?.length ?? 0) >= 1);
		await feed.unsubscribe([AAPL]);
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(server.frames[0].length, 1);
		await feed.close();
	} finally {
		await server.close();
	}
});

// ─── BinanceFeed ────────────────────────────────────────────────────────────

test('BinanceFeed: opens a URL-based stream, no frames sent', async () => {
	const server = await startTestServer();
	try {
		const feed = new BinanceFeed(`ws://127.0.0.1:${new URL(server.url).port}`);
		await feed.subscribe([BTC]);
		await waitFor(() => server.clients.length > 0);
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(server.frames[0]?.length ?? 0, 0);
		await feed.close();
	} finally {
		await server.close();
	}
});

// ─── BaseFeed: transactional rollback ───────────────────────────────────────

test('BaseFeed: a rejected subscribe is retryable', async () => {
	// Unreachable host, so `ensureConnected` rejects.
	const feed = new FinnhubFeed('test-key', 'ws://127.0.0.1:1');
	try {
		await assert.rejects(feed.subscribe([AAPL]));
		// Second call retries rather than silently no-op'ing.
		await assert.rejects(feed.subscribe([AAPL]));
	} finally {
		await feed.close();
	}
});