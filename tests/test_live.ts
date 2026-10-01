import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	PriceFetcher,
	type Asset,
	type AssetType,
	type AssetPrice,
} from '../src/lib/server/services/FinancialDataService';

// ── Environment ──────────────────────────────────────────────────────

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY_1 ?? '';
const WAIT_MS = Number(process.env.WAIT_MS ?? 15_000);

console.log(`[smoke] FINNHUB_API_KEY_1 = ${FINNHUB_API_KEY ? 'set' : 'NOT SET'}`);
console.log(`[smoke] WAIT_MS            = ${WAIT_MS}`);

// ── The list: one symbol per feed type, plus a second forex pair ─────
// Chosen for reliable delivery during market hours so the test proves
// the pipeline, not the provider's coverage of a long tail.

const ASSETS: Asset[] = [
	{ name: 'Apple',       symbol: 'AAPL',    type: 'us'     },
	{ name: 'Shopify TSX', symbol: 'SHOP.TO', type: 'global' },
	{ name: 'EUR/USD',     symbol: 'EURUSD',  type: 'forex'  },
	{ name: 'Gold',        symbol: 'XAUUSD',  type: 'forex'  },
	{ name: 'Bitcoin',     symbol: 'BTCUSDT', type: 'crypto' },
];

const TYPES: AssetType[] = ['us', 'global', 'forex', 'crypto'];

// ── Market hours ─────────────────────────────────────────────────────

/** US and Canadian regular session: Mon–Fri, 13:30–20:00 UTC. */
function isNorthAmericaOpen(now = new Date()): boolean {
	const day = now.getUTCDay();
	if (day === 0 || day === 6) return false;
	const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
	return minutes >= 13 * 60 + 30 && minutes < 20 * 60;
}

/** Forex closes from Friday ~22:00 UTC to Sunday ~22:00 UTC. */
function isForexOpen(now = new Date()): boolean {
	const day = now.getUTCDay();
	const hour = now.getUTCHours();
	return !(day === 6 || (day === 5 && hour >= 22) || (day === 0 && hour < 22));
}

function marketOpen(type: AssetType): boolean {
	switch (type) {
		case 'us':     return isNorthAmericaOpen();
		case 'global': return isNorthAmericaOpen(); // SHOP.TO trades on TSX
		case 'forex':  return isForexOpen();
		case 'crypto': return true;
	}
}

// ── Helpers ──────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const keyOf = (a: Asset): string => `${a.type}:${a.symbol.toUpperCase()}`;

async function waitUntil(pred: () => boolean, timeoutMs: number, pollMs = 250): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!pred() && Date.now() < deadline) await sleep(pollMs);
	return pred();
}

// ── Test ─────────────────────────────────────────────────────────────

test('smoke: one symbol per feed type, full pipeline', { timeout: WAIT_MS + 15_000 }, async (t) => {
	if (!FINNHUB_API_KEY) {
		t.skip('FINNHUB_API_KEY_1 is not set');
		return;
	}

	console.log(`\nAssets (${ASSETS.length}):`);
	for (const a of ASSETS) console.log(`  ${a.symbol} (${a.type})`);

	console.log('\nMarket status:');
	for (const type of TYPES) {
		console.log(`  ${type.padEnd(7)} ${marketOpen(type) ? 'open' : 'closed'}`);
	}

	const fetcher = new PriceFetcher(FINNHUB_API_KEY);

	const ticks = new Map<string, AssetPrice[]>();
	for (const a of ASSETS) ticks.set(keyOf(a), []);

	const lastStatus = new Map<AssetType, string>();
	const errors: Array<{ type: AssetType; error: Error }> = [];

	fetcher.on('price', (p: AssetPrice) => ticks.get(keyOf(p.asset))?.push(p));
	fetcher.on('feedStatus', (type, status) => {
		lastStatus.set(type, status);
		console.log(`  [${type}] ${status}`);
	});
	fetcher.on('feedError', (type, error) => {
		errors.push({ type, error });
		console.warn(`  [${type}] error: ${error.message}`);
	});

	try {
		// ── 1. Connect ──────────────────────────────────────────────
		console.log('\nConnecting...');
		await fetcher.subscribe(ASSETS);

		// ── 2. Every feed reached 'open' ────────────────────────────
		const expectedTypes = new Set(ASSETS.map((a) => a.type));
		for (const type of expectedTypes) {
			assert.equal(lastStatus.get(type), 'open', `${type} feed should be open`);
		}
		console.log('All feeds open.');

		// ── 3. Wait for at least one tick in each open market ───────
		console.log(`\nWaiting up to ${WAIT_MS / 1000}s for ticks...`);
		await waitUntil(() => {
			for (const a of ASSETS) {
				if (!marketOpen(a.type)) continue;
				if ((ticks.get(keyOf(a)) ?? []).length === 0) return false;
			}
			return true;
		}, WAIT_MS);

		// ── 4. Tick counts and shape validation ─────────────────────
		console.log('\nTicks received:');
		for (const a of ASSETS) {
			const got = ticks.get(keyOf(a)) ?? [];
			const open = marketOpen(a.type);
			console.log(`  ${a.symbol.padEnd(8)} ${String(got.length).padStart(4)} ticks  (market ${open ? 'open' : 'closed'})`);

			if (open) {
				assert.ok(got.length > 0,
					`${a.symbol} (${a.type}): market open but no tick within ${WAIT_MS}ms`);
			}

			for (const tick of got) {
				assert.ok(Number.isFinite(tick.point.price) && tick.point.price > 0,
					`${a.symbol}: invalid price ${tick.point.price}`);
				assert.ok(tick.point.timestamp instanceof Date && Number.isFinite(tick.point.timestamp.getTime()),
					`${a.symbol}: invalid timestamp`);
				assert.ok(tick.point.timestamp.getTime() <= Date.now() + 60_000,
					`${a.symbol}: timestamp is in the future`);
			}
		}

		// ── 5. Snapshot agrees with what arrived ────────────────────
		const snap = fetcher.snapshot();
		const snapByKey = new Map(snap.map((s) => [keyOf(s.asset), s]));

		for (const a of ASSETS) {
			const latest = (ticks.get(keyOf(a)) ?? []).at(-1);
			const inSnap = snapByKey.get(keyOf(a));

			if (latest) {
				assert.ok(inSnap, `${a.symbol}: ticked but missing from snapshot`);
				assert.deepEqual(inSnap.point, latest.point,
					`${a.symbol}: snapshot point differs from latest tick`);
				assert.ok(Number.isFinite(inSnap.ageMs) && inSnap.ageMs >= 0,
					`${a.symbol}: ageMs must be a non-negative number`);
			} else {
				assert.equal(inSnap, undefined,
					`${a.symbol}: appeared in snapshot without a tick`);
			}
		}
		console.log(`\nSnapshot: ${snap.length} entries, all consistent with received ticks.`);

	} finally {
		// ── 6. Clean shutdown ───────────────────────────────────────
		console.log('\nStopping...');
		await fetcher.stop();
		await assert.doesNotReject(() => fetcher.stop(), 'stop() must be idempotent');
		console.log('Stopped.');
	}

	// ── 7. Post-stop state ──────────────────────────────────────────
	for (const type of new Set(ASSETS.map((a) => a.type))) {
		assert.equal(lastStatus.get(type), 'closed', `${type} should report 'closed' after stop`);
	}
	assert.deepEqual(fetcher.snapshot(), [], 'snapshot must be empty after stop');

	if (errors.length > 0) {
		console.warn(`\n${errors.length} transient feed error(s) during the run:`);
		for (const e of errors) console.warn(`  [${e.type}] ${e.error.message}`);
	}
});