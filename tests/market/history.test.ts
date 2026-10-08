/**
 * History providers with `fetch` mocked. Verifies URL construction, response
 * parsing, and error handling without hitting the network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	BinanceHistory,
	HistoryRouter,
	YahooHistory,
	toBinanceInterval,
	toYahooInterval,
	toYahooSymbol
} from '../../src/lib/server/services/market/history';
import type { Asset } from '../../src/lib/server/services/market/types';

const AAPL: Asset = { name: 'Apple', symbol: 'AAPL', type: 'us' };
const EURUSD: Asset = { name: 'EUR/USD', symbol: 'EURUSD', type: 'forex' };
const BTC: Asset = { name: 'BTC', symbol: 'BTCUSDT', type: 'crypto' };

// ─── toYahooSymbol ──────────────────────────────────────────────────────────

test('toYahooSymbol: forex gets =X suffix, idempotently', () => {
	assert.equal(toYahooSymbol(EURUSD), 'EURUSD=X');
	assert.equal(toYahooSymbol({ ...EURUSD, symbol: 'EUR/USD' }), 'EURUSD=X');
	assert.equal(toYahooSymbol({ ...EURUSD, symbol: 'EURUSD=X' }), 'EURUSD=X');
	assert.equal(toYahooSymbol({ ...EURUSD, symbol: 'OANDA:EUR_USD' }), 'EURUSD=X');
});

test('toYahooSymbol: metals map to futures contracts', () => {
	assert.equal(toYahooSymbol({ name: 'Gold', symbol: 'XAUUSD', type: 'forex' }), 'GC=F');
	assert.equal(toYahooSymbol({ name: 'Silver', symbol: 'XAGUSD', type: 'forex' }), 'SI=F');
	assert.equal(toYahooSymbol({ name: 'Platinum', symbol: 'XPTUSD', type: 'forex' }), 'PL=F');
	assert.equal(toYahooSymbol({ name: 'Palladium', symbol: 'XPDUSD', type: 'forex' }), 'PA=F');
});

test('toYahooSymbol: us and global are case-folded only', () => {
	assert.equal(toYahooSymbol({ ...AAPL, symbol: 'aapl' }), 'AAPL');
	assert.equal(toYahooSymbol({ name: 'SAP', symbol: 'sap.de', type: 'global' }), 'SAP.DE');
});

// ─── toYahooInterval / toBinanceInterval ────────────────────────────────────

test('toYahooInterval: supported values map to strings', () => {
	assert.equal(toYahooInterval({ value: 1, unit: 'day' }), '1d');
	assert.equal(toYahooInterval({ value: 1, unit: 'hour' }), '1h');
	assert.equal(toYahooInterval({ value: 5, unit: 'min' }), '5m');
	assert.equal(toYahooInterval({ value: 30, unit: 'min' }), '30m');
});

test('toYahooInterval: unsupported values throw', () => {
	assert.throws(() => toYahooInterval({ value: 2, unit: 'hour' }));
	assert.throws(() => toYahooInterval({ value: 4, unit: 'min' }));
});

test('toBinanceInterval: covers min/hour/day', () => {
	assert.equal(toBinanceInterval({ value: 1, unit: 'min' }), '1m');
	assert.equal(toBinanceInterval({ value: 15, unit: 'min' }), '15m');
	assert.equal(toBinanceInterval({ value: 1, unit: 'hour' }), '1h');
	assert.equal(toBinanceInterval({ value: 4, unit: 'hour' }), '4h');
	assert.equal(toBinanceInterval({ value: 1, unit: 'day' }), '1d');
});

// ─── YahooHistory ───────────────────────────────────────────────────────────

function mockFetchJson(payload: unknown, status = 200): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify(payload), {
			status,
			headers: { 'Content-Type': 'application/json' }
		})) as typeof fetch;
	return () => { globalThis.fetch = original; };
}

test('YahooHistory: parses a well-formed response', async () => {
	const restore = mockFetchJson({
		chart: {
			result: [{
				timestamp: [1_700_000_000, 1_700_086_400],
				indicators: {
					quote: [{
						open: [100, 101],
						high: [105, 106],
						low: [99, 100],
						close: [104, 105],
						volume: [1_000_000, 1_100_000]
					}],
					adjclose: [{ adjclose: [104, 105] }]
				}
			}]
		}
	});
	try {
		const bars = await new YahooHistory().fetchBars({
			asset: AAPL,
			from: new Date('2024-01-01'),
			to: new Date('2024-02-01')
		});
		assert.equal(bars.length, 2);
		assert.equal(bars[0].open, 100);
		assert.equal(bars[0].close, 104);
		assert.equal(bars[0].adjClose, 104);
		assert.equal(bars[0].volume, 1_000_000);
	} finally { restore(); }
});

test('YahooHistory: skips rows with null OHLC', async () => {
	const restore = mockFetchJson({
		chart: {
			result: [{
				timestamp: [1, 2, 3],
				indicators: {
					quote: [{
						open: [100, null, 102],
						high: [105, null, 106],
						low: [99, null, 100],
						close: [104, null, 105],
						volume: [1, null, 3]
					}]
				}
			}]
		}
	});
	try {
		const bars = await new YahooHistory().fetchBars({ asset: AAPL });
		assert.equal(bars.length, 2);
	} finally { restore(); }
});

test('YahooHistory: throws on HTTP error', async () => {
	const restore = mockFetchJson({}, 500);
	try {
		await assert.rejects(new YahooHistory().fetchBars({ asset: AAPL }), /HTTP 500/);
	} finally { restore(); }
});

test('YahooHistory: throws on missing result', async () => {
	const restore = mockFetchJson({ chart: { error: { code: 'x', description: 'nope' } } });
	try {
		await assert.rejects(new YahooHistory().fetchBars({ asset: AAPL }), /nope/);
	} finally { restore(); }
});

// ─── BinanceHistory ─────────────────────────────────────────────────────────

test('BinanceHistory: parses a page of klines', async () => {
	const restore = mockFetchJson([
		[1_700_000_000_000, '100', '105', '99', '104', '1000', 1_700_000_059_999],
		[1_700_000_060_000, '104', '106', '103', '105', '2000', 1_700_000_119_999]
	]);
	try {
		const bars = await new BinanceHistory().fetchBars({ asset: BTC });
		assert.equal(bars.length, 2);
		assert.equal(bars[0].open, 100);
		assert.equal(bars[0].volume, 1000);
		assert.equal(bars[0].adjClose, null);
	} finally { restore(); }
});

test('BinanceHistory: normalizes symbol before requesting', async () => {
	let requestedUrl = '';
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: string) => {
		requestedUrl = url;
		return new Response('[]', { status: 200 });
	}) as typeof fetch;
	try {
		await new BinanceHistory().fetchBars({
			asset: { ...BTC, symbol: 'BTC/USDT' }
		});
		assert.ok(
			requestedUrl.includes('symbol=BTCUSDT'),
			`expected normalized symbol in URL: ${requestedUrl}`
		);
	} finally { globalThis.fetch = original; }
});

// ─── HistoryRouter ──────────────────────────────────────────────────────────

test('HistoryRouter: routes crypto to Binance, else to Yahoo', async () => {
	let yahoo = 0;
	let binance = 0;
	const fakeYahoo = { fetchBars: async () => { yahoo++; return []; } };
	const fakeBinance = { fetchBars: async () => { binance++; return []; } };
	const router = new HistoryRouter(fakeYahoo, fakeBinance);

	await router.fetchBars({ asset: AAPL });
	await router.fetchBars({ asset: EURUSD });
	await router.fetchBars({ asset: BTC });

	assert.equal(yahoo, 2);
	assert.equal(binance, 1);
});

test('YahooHistory: adjClose is null for non-equity assets', async () => {
	const restore = mockFetchJson({
		chart: {
			result: [{
				timestamp: [1_700_000_000],
				indicators: {
					quote: [{
						open: [1.08], high: [1.09], low: [1.07], close: [1.085], volume: [0]
					}],
					// Yahoo sends adjclose even for forex; the parser must ignore it.
					adjclose: [{ adjclose: [1.085] }]
				}
			}]
		}
	});
	try {
		const bars = await new YahooHistory().fetchBars({ asset: EURUSD });
		assert.equal(bars.length, 1);
		assert.equal(bars[0].adjClose, null, 'adjClose must be null for forex');
	} finally { restore(); }
});

test('BinanceHistory: rejects invalid maxLimit', () => {
	assert.throws(() => new BinanceHistory(0));
	assert.throws(() => new BinanceHistory(-1));
	assert.throws(() => new BinanceHistory(1001));
	assert.throws(() => new BinanceHistory(1.5));
});

test('BinanceHistory: bounds the default start time for intraday requests', async () => {
	let requestedUrl = '';
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: string) => {
		requestedUrl = url;
		return new Response('[]', { status: 200 });
	}) as typeof fetch;
	try {
		await new BinanceHistory().fetchBars({
			asset: BTC,
			interval: { value: 1, unit: 'min' }
		});
		const match = requestedUrl.match(/startTime=(\d+)/);
		assert.ok(match, `expected startTime in URL: ${requestedUrl}`);
		const startTime = Number(match[1]);
		// The clamp is applied at the moment the request is built; the test
		// computes its reference a few milliseconds later. Allow 5s tolerance
		// so the test isn't sensitive to scheduler jitter.
		const expected = Date.now() - 30 * 86_400_000;
		assert.ok(
			Math.abs(startTime - expected) < 5_000,
			`startTime ${startTime} not within 5s of expected 30-day bound ${expected}`
		);
	} finally { globalThis.fetch = original; }
});

test('BinanceHistory: explicit from is used unchanged', async () => {
	let requestedUrl = '';
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: string) => {
		requestedUrl = url;
		return new Response('[]', { status: 200 });
	}) as typeof fetch;
	try {
		const explicit = new Date('2020-06-15T00:00:00.000Z');
		await new BinanceHistory().fetchBars({
			asset: BTC,
			from: explicit,
			interval: { value: 1, unit: 'min' }
		});
		const match = requestedUrl.match(/startTime=(\d+)/);
		assert.ok(match);
		assert.equal(Number(match[1]), explicit.getTime(), 'explicit from must not be clamped');
	} finally { globalThis.fetch = original; }
});

test('toBinanceInterval: rejects values Binance does not support', () => {
	assert.throws(() => toBinanceInterval({ value: 2, unit: 'min' }));
	assert.throws(() => toBinanceInterval({ value: 7, unit: 'min' }));
	assert.throws(() => toBinanceInterval({ value: 3, unit: 'hour' }));
	assert.throws(() => toBinanceInterval({ value: 5, unit: 'hour' }));
	assert.throws(() => toBinanceInterval({ value: 2, unit: 'day' }));
});

test('toBinanceInterval: accepts the full valid set', () => {
	// A representative sample of the whitelist.
	assert.equal(toBinanceInterval({ value: 1, unit: 'min' }), '1m');
	assert.equal(toBinanceInterval({ value: 3, unit: 'min' }), '3m');
	assert.equal(toBinanceInterval({ value: 30, unit: 'min' }), '30m');
	assert.equal(toBinanceInterval({ value: 2, unit: 'hour' }), '2h');
	assert.equal(toBinanceInterval({ value: 4, unit: 'hour' }), '4h');
	assert.equal(toBinanceInterval({ value: 12, unit: 'hour' }), '12h');
	assert.equal(toBinanceInterval({ value: 1, unit: 'day' }), '1d');
	assert.equal(toBinanceInterval({ value: 3, unit: 'day' }), '3d');
});

test('BinanceHistory: throws when the request exceeds MAX_PAGES', async () => {
	const original = globalThis.fetch;
	// Return a full page of 1000 consecutive 1-minute klines starting at the
	// requested `startTime`. This mirrors how Binance actually advances: each
	// page begins where the previous one ended.
	globalThis.fetch = (async (url: string) => {
		const match = url.match(/startTime=(\d+)/);
		const start = match ? Number(match[1]) : 0;
		const page = Array.from({ length: 1000 }, (_, i) => [
			start + i * 60_000,
			'100', '101', '99', '100', '1', 0
		]);
		return new Response(JSON.stringify(page), { status: 200 });
	}) as typeof fetch;

	try {
		await assert.rejects(
			new BinanceHistory().fetchBars({
				asset: BTC,
				from: new Date(0),
				to: new Date(Date.now() + 10 * 365 * 86_400_000),
				interval: { value: 1, unit: 'min' }
			}),
			/exceeded \d+ pages/
		);
	} finally {
		globalThis.fetch = original;
	}
});