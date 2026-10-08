/**
 * Historical demo against real providers. Reads demos/assets.csv and calls
 * `fetchBars` twice per asset: once for EOD bars over the last 30 days,
 * once for hourly bars over the last 5 days.
 *
 * No API key required — Yahoo and Binance history endpoints are keyless.
 *
 *   pnpm history-demo
 */

import { createHistoryProvider } from '../../../src/lib/server/services/market/history';
import type { Asset, Bar } from '../../../src/lib/server/services/market/types';
import { readAssetsFromCsv } from '../helpers';

const CSV = process.env.ASSETS_CSV ?? 'tests/market/demos/assets.csv';

const history = createHistoryProvider();

const pad = (s: string, n: number) => s.padEnd(n);
const rpad = (s: string, n: number) => s.padStart(n);

function fmtPrice(n: number): string {
	if (n >= 100) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
	if (n >= 1) return n.toFixed(4);
	return n.toFixed(6);
}
const fmtVolume = (v: number | null): string =>
	v === null ? '—' : Math.round(v).toLocaleString('en-US');
const fmtDate = (d: Date): string => d.toISOString().slice(0, 10);
const fmtDateTime = (d: Date): string => d.toISOString().slice(5, 16).replace('T', ' ');

const tail = <T>(arr: T[], n: number): T[] => arr.slice(Math.max(0, arr.length - n));

function header(title: string): void {
	console.log('\n══════════════════════════════════════════════════════════════════════');
	console.log(` ${title}`);
	console.log('══════════════════════════════════════════════════════════════════════');
}

function printEod(bars: Bar[]): void {
	console.log(
		`  ${pad('Date', 12)}${rpad('Open', 12)}${rpad('High', 12)}` +
		`${rpad('Low', 12)}${rpad('Close', 12)}${rpad('AdjClose', 12)}${rpad('Volume', 12)}`
	);
	console.log('  ' + '─'.repeat(84));
	for (const bar of bars) {
		const adj = bar.adjClose === null ? '—' : fmtPrice(bar.adjClose);
		console.log(
			`  ${pad(fmtDate(bar.timestamp), 12)}` +
			`${rpad(fmtPrice(bar.open), 12)}${rpad(fmtPrice(bar.high), 12)}` +
			`${rpad(fmtPrice(bar.low), 12)}${rpad(fmtPrice(bar.close), 12)}` +
			`${rpad(adj, 12)}${rpad(fmtVolume(bar.volume), 12)}`
		);
	}
}

function printIntraday(bars: Bar[]): void {
	console.log(
		`  ${pad('Time (UTC)', 18)}${rpad('Open', 12)}${rpad('High', 12)}` +
		`${rpad('Low', 12)}${rpad('Close', 12)}${rpad('Volume', 14)}`
	);
	console.log('  ' + '─'.repeat(80));
	for (const bar of bars) {
		console.log(
			`  ${pad(fmtDateTime(bar.timestamp), 18)}` +
			`${rpad(fmtPrice(bar.open), 12)}${rpad(fmtPrice(bar.high), 12)}` +
			`${rpad(fmtPrice(bar.low), 12)}${rpad(fmtPrice(bar.close), 12)}` +
			`${rpad(fmtVolume(bar.volume), 14)}`
		);
	}
}

async function main(): Promise<void> {
	const assets = readAssetsFromCsv(CSV);

	header('HISTORICAL DATA DEMO');
	console.log(`Input:  ${CSV}`);
	console.log(`Assets: ${assets.length}`);
	console.log(`Time:   ${new Date().toISOString()}`);

	const now = new Date();
	const eodFrom = new Date(now.getTime() - 30 * 86_400_000);
	const intradayFrom = new Date(now.getTime() - 5 * 86_400_000);

	header('EOD BARS — last 30 days, interval = 1 day');
	console.log(`Range: ${fmtDate(eodFrom)} → ${fmtDate(now)}\n`);

	for (const asset of assets) {
		console.log(`── ${asset.symbol} (${asset.type}) — ${asset.name} ${'─'.repeat(Math.max(0, 40 - asset.symbol.length))}`);
		try {
			const bars = await history.fetchBars({ asset, from: eodFrom, to: now });
			if (bars.length === 0) {
				console.log('  (no bars)');
			} else {
				console.log(`  ${bars.length} bars returned`);
				printEod(tail(bars, 7));
			}
		} catch (error) {
			console.log(`  ERROR: ${error instanceof Error ? error.message : String(error)}`);
		}
		console.log('');
	}

	header('INTRADAY BARS — last 5 days, interval = 1 hour');
	console.log(`Range: ${fmtDateTime(intradayFrom)} → ${fmtDateTime(now)}\n`);

	for (const asset of assets) {
		console.log(`── ${asset.symbol} (${asset.type}) — ${asset.name} ${'─'.repeat(Math.max(0, 40 - asset.symbol.length))}`);
		try {
			const bars = await history.fetchBars({
				asset,
				from: intradayFrom,
				to: now,
				interval: { value: 1, unit: 'hour' }
			});
			if (bars.length === 0) {
				console.log('  (no bars)');
			} else {
				console.log(`  ${bars.length} hourly bars returned`);
				printIntraday(tail(bars, 6));
			}
		} catch (error) {
			console.log(`  ERROR: ${error instanceof Error ? error.message : String(error)}`);
		}
		console.log('');
	}

	header('SUMMARY');
	console.log(`  ${pad('Symbol', 12)}${pad('Type', 10)}${rpad('EOD bars', 12)}${rpad('1h bars', 12)}`);
	console.log('  ' + '─'.repeat(44));

	for (const asset of assets) {
		let eodCount = 0;
		let hourlyCount = 0;
		try { eodCount = (await history.fetchBars({ asset, from: eodFrom, to: now })).length; } catch { /* reported above */ }
		try {
			hourlyCount = (
				await history.fetchBars({
					asset, from: intradayFrom, to: now, interval: { value: 1, unit: 'hour' }
				})
			).length;
		} catch { /* reported above */ }
		console.log(
			`  ${pad(asset.symbol, 12)}${pad(asset.type, 10)}${rpad(String(eodCount), 12)}${rpad(String(hourlyCount), 12)}`
		);
	}
	console.log('');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});