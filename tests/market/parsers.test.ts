/**
 * Pure functions: symbol normalization, asset keys, and the four parsers.
 * No I/O. Every test in this file runs in under a millisecond.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as protobuf from 'protobufjs';
import {
	assetKey,
	normalizePair,
	normalizeSymbol,
	type Asset
} from '../../src/lib/server/services/market/types';
import {
	parseBinance,
	parseBiQuote,
	parseFinnhub,
	parseYahoo
} from '../../src/lib/server/services/market/live';

// ─── normalizePair ──────────────────────────────────────────────────────────

test('normalizePair: strips OANDA prefix and separators, uppercases', () => {
	const cases: Array<[string, string]> = [
		['EURUSD', 'EURUSD'],
		['eurusd', 'EURUSD'],
		['eur/usd', 'EURUSD'],
		['EUR_USD', 'EURUSD'],
		['EUR-USD', 'EURUSD'],
		['OANDA:EUR_USD', 'EURUSD'],
		['OANDA:eur/usd', 'EURUSD'],
		['BTCUSDT', 'BTCUSDT'],
		['btc/usdt', 'BTCUSDT']
	];
	for (const [input, expected] of cases) {
		assert.equal(normalizePair(input), expected, `normalizePair(${JSON.stringify(input)})`);
	}
});

test('normalizePair: idempotent', () => {
	for (const input of ['EURUSD', 'eur/usd', 'OANDA:EUR_USD']) {
		const once = normalizePair(input);
		assert.equal(normalizePair(once), once, `not idempotent for ${input}`);
	}
});

// ─── normalizeSymbol ────────────────────────────────────────────────────────

test('normalizeSymbol: us and global are case-folded only', () => {
	assert.equal(normalizeSymbol('us', 'aapl'), 'AAPL');
	assert.equal(normalizeSymbol('us', 'AAPL'), 'AAPL');
	assert.equal(normalizeSymbol('global', 'sap.de'), 'SAP.DE');
	assert.equal(normalizeSymbol('global', 'SHOP.TO'), 'SHOP.TO');
	// Separators are NOT stripped for stocks.
	assert.equal(normalizeSymbol('us', 'BRK.B'), 'BRK.B');
});

test('normalizeSymbol: forex and crypto strip separators', () => {
	assert.equal(normalizeSymbol('forex', 'eur/usd'), 'EURUSD');
	assert.equal(normalizeSymbol('forex', 'EUR_USD'), 'EURUSD');
	assert.equal(normalizeSymbol('forex', 'OANDA:EUR_USD'), 'EURUSD');
	assert.equal(normalizeSymbol('crypto', 'btc/usdt'), 'BTCUSDT');
	assert.equal(normalizeSymbol('crypto', 'BTC-USDT'), 'BTCUSDT');
});

// ─── assetKey ───────────────────────────────────────────────────────────────

test('assetKey: equivalent spellings collapse to one key', () => {
	const variants = ['btc/usdt', 'BTCUSDT', 'btc_usdt', 'BTC-USDT'];
	for (const symbol of variants) {
		const key = assetKey({ name: '', symbol, type: 'crypto' });
		assert.equal(key, 'crypto:BTCUSDT', `assetKey(${symbol})`);
	}
});

test('assetKey: different types with same symbol are distinct', () => {
	const us = assetKey({ name: '', symbol: 'AAPL', type: 'us' });
	const global = assetKey({ name: '', symbol: 'AAPL', type: 'global' });
	assert.notEqual(us, global);
});

// ─── parseFinnhub ───────────────────────────────────────────────────────────

test('parseFinnhub: extracts trades from a well-formed frame', () => {
	const raw = Buffer.from(JSON.stringify({
		type: 'trade',
		data: [
			{ s: 'AAPL', p: 150.25, t: 1_700_000_000_000 },
			{ s: 'MSFT', p: 380.5, t: 1_700_000_000_100 }
		]
	}));
	const ticks = parseFinnhub(raw);
	assert.equal(ticks.length, 2);
	assert.equal(ticks[0].symbol, 'AAPL');
	assert.equal(ticks[0].price, 150.25);
	assert.equal(ticks[0].time.getTime(), 1_700_000_000_000);
});

test('parseFinnhub: returns [] for malformed frames', () => {
	assert.deepEqual(parseFinnhub(Buffer.from('not json')), []);
	assert.deepEqual(parseFinnhub(Buffer.from('{}')), []);
	assert.deepEqual(parseFinnhub(Buffer.from('{"type":"ping"}')), []);
	assert.deepEqual(parseFinnhub(Buffer.from('{"type":"trade","data":"nope"}')), []);
});

test('parseFinnhub: drops entries with wrong field types', () => {
	const raw = Buffer.from(JSON.stringify({
		type: 'trade',
		data: [
			{ s: 'AAPL', p: 150, t: 1 },      // ok
			{ s: 123, p: 150, t: 1 },         // bad symbol
			{ s: 'MSFT', p: '150', t: 1 },    // bad price
			{ s: 'GOOG', p: 150, t: 'x' },    // bad time
			{ s: 'TSLA', p: 200, t: 2 }       // ok
		]
	}));
	const ticks = parseFinnhub(raw);
	assert.deepEqual(ticks.map((t) => t.symbol), ['AAPL', 'TSLA']);
});

// ─── parseBinance ───────────────────────────────────────────────────────────

test('parseBinance: extracts trade from combined-stream envelope', () => {
	const raw = Buffer.from(JSON.stringify({
		data: { e: 'trade', s: 'BTCUSDT', p: '42000.50', T: 1_700_000_000_000 }
	}));
	const [tick] = parseBinance(raw);
	assert.ok(tick);
	assert.equal(tick.symbol, 'BTCUSDT');
	assert.equal(tick.price, 42000.5);
	assert.equal(tick.time.getTime(), 1_700_000_000_000);
});

test('parseBinance: rejects non-trade events and malformed frames', () => {
	assert.deepEqual(parseBinance(Buffer.from('{}')), []);
	assert.deepEqual(parseBinance(Buffer.from('{"data":{"e":"depthUpdate"}}')), []);
	assert.deepEqual(
		parseBinance(Buffer.from('{"data":{"e":"trade","s":1,"p":"1","T":1}}')),
		[]
	);
});

// ─── parseBiQuote ───────────────────────────────────────────────────────────

test('parseBiQuote: extracts mid and timestamp', () => {
	const [tick] = parseBiQuote({
		symbol: 'EURUSD',
		mid: 1.08,
		timestamp: '2026-01-15T10:00:00.000Z'
	});
	assert.ok(tick);
	assert.equal(tick.symbol, 'EURUSD');
	assert.equal(tick.price, 1.08);
	assert.equal(tick.time.toISOString(), '2026-01-15T10:00:00.000Z');
});

test('parseBiQuote: uses now() when timestamp is absent', () => {
	const before = Date.now();
	const [tick] = parseBiQuote({ symbol: 'EURUSD', mid: 1.08 });
	const after = Date.now();
	assert.ok(tick);
	assert.ok(tick.time.getTime() >= before && tick.time.getTime() <= after);
});

test('parseBiQuote: rejects malformed ticks', () => {
	assert.deepEqual(parseBiQuote({}), []);
	// Cast through `never` so TypeScript allows deliberately-malformed input.
	assert.deepEqual(parseBiQuote({ symbol: 123, mid: 1.08 } as never), []);
	assert.deepEqual(parseBiQuote({ symbol: 'EURUSD', mid: '1.08' as never }), []);
});

// ─── parseYahoo ─────────────────────────────────────────────────────────────

/** Build a Yahoo frame the way the real provider does: base64 protobuf in JSON. */
function makeYahooFrame(id: string, price: number, timeMs: number): Buffer {
	const proto = new protobuf.Type('PricingData')
		.add(new protobuf.Field('id', 1, 'string'))
		.add(new protobuf.Field('price', 2, 'float'))
		.add(new protobuf.Field('time', 3, 'sint64'));
	const message = proto.encode(proto.create({ id, price, time: timeMs })).finish();
	const base64 = Buffer.from(message).toString('base64');
	return Buffer.from(JSON.stringify({ message: base64 }));
}

test('parseYahoo: decodes a base64 protobuf frame', () => {
	const raw = makeYahooFrame('AAPL', 150.25, 1_700_000_000_000);
	const [tick] = parseYahoo(raw);
	assert.ok(tick);
	assert.equal(tick.symbol, 'AAPL');
	assert.equal(tick.price, 150.25);
	assert.equal(tick.time.getTime(), 1_700_000_000_000);
});

test('parseYahoo: treats values < 1e11 as seconds', () => {
	const raw = makeYahooFrame('AAPL', 150, 1_700_000);
	const [tick] = parseYahoo(raw);
	assert.ok(tick);
	assert.equal(tick.time.getTime(), 1_700_000_000);
});

test('parseYahoo: rejects malformed envelopes', () => {
	assert.deepEqual(parseYahoo(Buffer.from('not json')), []);
	assert.deepEqual(parseYahoo(Buffer.from('{}')), []);
	assert.deepEqual(parseYahoo(Buffer.from('{"message":123}')), []);
	assert.deepEqual(parseYahoo(Buffer.from('{"message":"!!!"}')), []);
});