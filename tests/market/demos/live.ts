/**
 * Live demo against real providers. Reads demos/assets.csv, subscribes
 * every asset, prints ticks as they arrive, then demonstrates snapshot,
 * unsubscribe, and stop.
 *
 * Run during market hours for the fullest picture. Crypto ticks 24/7; forex
 * Sunday evening through Friday evening; US and TSX 13:30–20:00 UTC on
 * weekdays. Symbols whose market is closed simply don't appear.
 *
 *   pnpm live-demo
 */

import { MarketData } from '../../../src/lib/server/services/market/marketdata';
import type {
	Asset,
	AssetType,
	AssetPrice
} from '../../../src/lib/server/services/market/types';
import { readAssetsFromCsv, sleep, waitFor } from '../helpers';

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY_1 ?? '';
const CSV = process.env.ASSETS_CSV ?? 'tests/market/demos/assets.csv';
const WAIT_MS = Number(process.env.WAIT_MS ?? 15_000);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 5_000);

function isNorthAmericaOpen(now = new Date()): boolean {
	const d = now.getUTCDay();
	if (d === 0 || d === 6) return false;
	const m = now.getUTCHours() * 60 + now.getUTCMinutes();
	return m >= 13 * 60 + 30 && m < 20 * 60;
}
function isForexOpen(now = new Date()): boolean {
	const d = now.getUTCDay();
	const h = now.getUTCHours();
	return !(d === 6 || (d === 5 && h >= 22) || (d === 0 && h < 22));
}
function marketOpen(type: AssetType): boolean {
	switch (type) {
		case 'crypto': return true;
		case 'us':
		case 'global': return isNorthAmericaOpen();
		case 'forex':  return isForexOpen();
	}
}

const pad = (s: string, n: number) => s.padEnd(n);
const rpad = (s: string, n: number) => s.padStart(n);

function fmtPrice(n: number): string {
	if (n >= 100) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
	if (n >= 1) return n.toFixed(4);
	return n.toFixed(6);
}

function header(title: string): void {
	console.log('\n══════════════════════════════════════════════════════════════════════');
	console.log(` ${title}`);
	console.log('══════════════════════════════════════════════════════════════════════');
}

function printSnapshot(
	assets: Asset[],
	snapshot: AssetPrice[],
	tickCounts: Map<string, AssetPrice[]>
): void {
	const byKey = new Map(snapshot.map((s) => [`${s.asset.type}:${s.asset.symbol}`, s]));

	console.log(
		'  ' + pad('Symbol', 10) + pad('Type', 8) + pad('Market', 8) +
		rpad('Price', 14) + '  ' + rpad('Age', 8) + '  ' + rpad('Ticks', 6)
	);
	console.log('  ' + '─'.repeat(62));

	for (const asset of assets) {
		const key = `${asset.type}:${asset.symbol}`;
		const entry = byKey.get(key);
		const count = tickCounts.get(key)?.length ?? 0;
		const market = marketOpen(asset.type) ? 'open' : 'closed';

		if (entry) {
			console.log(
				'  ' + pad(asset.symbol, 10) + pad(asset.type, 8) + pad(market, 8) +
				rpad(fmtPrice(entry.point.price), 14) + '  ' +
				rpad(`${entry.ageMs}ms`, 8) + '  ' + rpad(String(count), 6)
			);
		} else {
			console.log(
				'  ' + pad(asset.symbol, 10) + pad(asset.type, 8) + pad(market, 8) +
				rpad('—', 14) + '  ' + rpad('—', 8) + '  ' + rpad(String(count), 6) +
				(market === 'open' ? '  (no tick)' : '')
			);
		}
	}
}

async function main(): Promise<void> {
	if (!FINNHUB_API_KEY) {
		console.log('FINNHUB_API_KEY_1 is not set — add it to .env to run this demo.');
		process.exit(0);
	}

	const assets = readAssetsFromCsv(CSV);

	header('LIVE DEMO');
	console.log(`Input:        ${CSV}`);
	console.log(`Assets:       ${assets.length}`);
	console.log(`Time:         ${new Date().toISOString()}`);
	console.log(`US/TSX:       ${isNorthAmericaOpen() ? 'open' : 'closed'}`);
	console.log(`Forex/Metals: ${isForexOpen() ? 'open' : 'closed'}`);
	console.log(`Crypto:       always open\n`);

	console.log('Assets loaded from CSV:');
	for (const a of assets) {
		const open = marketOpen(a.type) ? '●' : '○';
		console.log(`  ${open} ${pad(a.symbol, 10)} ${pad(a.type, 7)} ${a.name}`);
	}

	const fetcher = new MarketData(FINNHUB_API_KEY);
	const ticks = new Map<string, AssetPrice[]>();

	fetcher.on('feedStatus', (e) => console.log(`  [${e.type}:${e.provider}] ${e.status}`));
	fetcher.on('feedError', (feed, error) => console.warn(`  [${feed}] ERROR: ${error.message}`));
	fetcher.on('price', (p) => {
		const key = `${p.asset.type}:${p.asset.symbol}`;
		const list = ticks.get(key) ?? [];
		const isFirst = list.length === 0;
		list.push(p);
		ticks.set(key, list);
		if (isFirst) {
			const t = p.point.timestamp.toISOString().slice(11, 19);
			console.log(`  ↑ ${pad(p.asset.symbol, 10)} ${rpad(fmtPrice(p.point.price), 14)}   ${t} UTC`);
		}
	});

	try {
		console.log('\nSubscribing...');
		await fetcher.subscribe(assets);

		console.log(`\nWaiting up to ${WAIT_MS / 1000}s for first ticks...`);
		await waitFor(
			() => assets.every((a) => !marketOpen(a.type) || (ticks.get(`${a.type}:${a.symbol}`)?.length ?? 0) > 0),
			WAIT_MS
		).catch(() => console.log('  (timed out waiting for all open-market ticks — continuing)'));

		console.log(`\nSampling for ${SAMPLE_MS / 1000}s...\n`);
		await sleep(SAMPLE_MS);

		const snapshot = fetcher.snapshot(assets);
		console.log('Snapshot after sampling:');
		printSnapshot(assets, snapshot, ticks);

		const victim = assets.find((a) => a.type === 'crypto');
		if (victim) {
			console.log(`\nUnsubscribing ${victim.symbol} (${victim.type})...`);
			await fetcher.unsubscribe([victim]);

			const before = ticks.get(`${victim.type}:${victim.symbol}`)?.length ?? 0;
			await sleep(3_000);
			const after = ticks.get(`${victim.type}:${victim.symbol}`)?.length ?? 0;

			console.log(`  Ticks before unsubscribe: ${before}`);
			console.log(`  Ticks after unsubscribe:  ${after}`);
			console.log(
				after > before
					? `  ⚠ ${victim.symbol} still received ticks`
					: `  ✓ ${victim.symbol} stopped ticking`
			);
			console.log(`  snapshot([${victim.symbol}]) → ${fetcher.snapshot([victim]).length} entries`);
		}

		const remaining = assets.filter((a) => a.symbol !== victim?.symbol);
		console.log('\nFinal snapshot:');
		printSnapshot(remaining, fetcher.snapshot(remaining), ticks);
	} finally {
		console.log('\nStopping...');
		await fetcher.stop();
		await fetcher.stop();
		const after = fetcher.snapshot();
		console.log(`  ✓ stop() idempotent`);
		console.log(`  ✓ snapshot() after stop: ${after.length} entries`);
		if (after.length !== 0) console.error('  ✗ cache not cleared by stop()');
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});