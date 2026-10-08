/** history.ts — on-demand historical bars, one provider per data source. */

import {
	normalizeSymbol,
	type Asset,
	type Bar,
	type Duration,
	type HistoryRequest
} from './types';

export interface IHistoryProvider {
	fetchBars(req: HistoryRequest): Promise<Bar[]>;
}

/** Hard deadline for every outbound request. */
const FETCH_TIMEOUT_MS = 15_000;

/** Upper bound on pages per `fetchBars` call. 50 × 1000 = 50 000 bars. */
const MAX_PAGES = 50;

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Reads at most `maxBytes` of an error body so the provider's own explanation
 * ("symbol may be delisted", "Invalid symbol") reaches the caller without
 * buffering a potentially huge response.
 */
async function readErrorBody(res: Response, maxBytes = 512): Promise<string> {
	if (!res.body) return '';
	const reader = res.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		while (total < maxBytes) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = Buffer.from(value);
			chunks.push(chunk);
			total += chunk.byteLength;
		}
	} finally {
		reader.cancel().catch(() => { /* ignore */ });
	}
	if (chunks.length === 0) return '';
	const text = Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
	const trimmed = text.replace(/\s+/g, ' ').trim();
	return trimmed ? ` — ${trimmed}` : '';
}

// ─── Yahoo (us / global / forex) ──────────────────────────────────────────

const YAHOO_ENDPOINT = 'https://query1.finance.yahoo.com/v8/finance/chart';
const DEFAULT_INTERVAL: Duration = { value: 1, unit: 'day' };
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; GeoTrade/1.0)';

interface YahooChartResponse {
	chart: {
		result?: Array<{
			timestamp: number[];
			indicators: {
				quote: Array<{
					open?: (number | null)[];
					high?: (number | null)[];
					low?: (number | null)[];
					close?: (number | null)[];
					volume?: (number | null)[];
				}>;
				adjclose?: Array<{ adjclose?: (number | null)[] }>;
			};
		}>;
		error?: { code: string; description: string } | null;
	};
}

/**
 * Yahoo's public chart endpoint. One symbol per request; no batch API.
 * Undocumented — the response shape has been stable for years but can change
 * without notice.
 *
 * Depth limits: 1m → 7d, 5m/15m/30m → 60d, 1h → 730d, 1d → full history.
 * Requesting beyond these returns fewer bars silently.
 */
export class YahooHistory implements IHistoryProvider {
	constructor(private readonly userAgent = DEFAULT_USER_AGENT) {}

	async fetchBars(req: HistoryRequest): Promise<Bar[]> {
		const interval = req.interval ?? DEFAULT_INTERVAL;
		const symbol = toYahooSymbol(req.asset);
		const period1 = req.from ? Math.floor(req.from.getTime() / 1000) : 0;
		const period2 = req.to ? Math.floor(req.to.getTime() / 1000) : Math.floor(Date.now() / 1000);

		// `adjClose` is only meaningful for equities. Crypto, FX, and metals
		// have no corporate actions, so the field stays null even when Yahoo
		// sends an `adjclose` array for those symbols.
		const isDaily = interval.unit === 'day';
		const isEquity = req.asset.type === 'us' || req.asset.type === 'global';
		const wantsAdjClose = isDaily && isEquity;

		const url =
			`${YAHOO_ENDPOINT}/${encodeURIComponent(symbol)}` +
			`?period1=${period1}&period2=${period2}&interval=${toYahooInterval(interval)}` +
			(wantsAdjClose ? '&events=div,splits' : '');

		const res = await fetchWithTimeout(url, { headers: { 'User-Agent': this.userAgent } });
		if (!res.ok) {
			const detail = await readErrorBody(res);
			throw new Error(`Yahoo ${symbol}: HTTP ${res.status} ${res.statusText}${detail}`);
		}

		const json = (await res.json()) as YahooChartResponse;
		const result = json.chart?.result?.[0];
		if (!result) {
			const err = json.chart?.error;
			throw new Error(`Yahoo ${symbol}: ${err?.description ?? 'no result'}`);
		}

		const ts = result.timestamp ?? [];
		const q = result.indicators.quote[0] ?? {};
		const adj = result.indicators.adjclose?.[0]?.adjclose ?? [];

		const bars: Bar[] = [];
		for (let i = 0; i < ts.length; i++) {
			const open = q.open?.[i];
			const high = q.high?.[i];
			const low = q.low?.[i];
			const close = q.close?.[i];
			// Yahoo emits nulls for holidays and the current in-progress bar.
			if (open == null || high == null || low == null || close == null) continue;

			bars.push({
				timestamp: new Date(ts[i] * 1000),
				open, high, low, close,
				adjClose: wantsAdjClose ? (adj[i] ?? null) : null,
				volume: q.volume?.[i] ?? null
			});
		}
		return bars;
	}
}

/**
 * Yahoo no longer serves spot-metal symbols (XAUUSD=X, ...) — those
 * endpoints return HTTP 404. The remaining series are the COMEX / NYMEX
 * front-month futures, which carry a basis over spot and roll between
 * contract months. Usable for EOD event studies; not a substitute for spot.
 *
 * Not for live use: Yahoo's WebSocket does not carry futures. Live metals
 * come from BiQuote.
 */
const YAHOO_METAL_FUTURES: Record<string, string> = {
	XAUUSD: 'GC=F', // Gold      (COMEX)
	XAGUSD: 'SI=F', // Silver    (COMEX)
	XPTUSD: 'PL=F', // Platinum  (NYMEX)
	XPDUSD: 'PA=F'  // Palladium (NYMEX)
};

/**
 * Translates our canonical symbol to what Yahoo expects.
 *
 *   - Forex spot pairs:  "EURUSD=X"
 *   - Metals:            futures ("GC=F", "SI=F", ...)
 *   - Everything else:   as-is (".TO", ".L", ".DE" suffixes preserved)
 *
 * Idempotent: "EURUSD", "EUR/USD", "EUR_USD", and "EURUSD=X" all map to
 * "EURUSD=X". Crypto is routed to Binance and never reaches here.
 */
export function toYahooSymbol(asset: Asset): string {
	if (asset.type === 'forex') {
		const base = normalizeSymbol('forex', asset.symbol).replace(/=X$/, '');
		return YAHOO_METAL_FUTURES[base] ?? `${base}=X`;
	}
	return normalizeSymbol(asset.type, asset.symbol);
}

/** Unsupported intervals throw — better than silently returning the wrong resolution. */
export function toYahooInterval(d: Duration): string {
	if (d.unit === 'day' && d.value === 1) return '1d';
	if (d.unit === 'hour' && d.value === 1) return '1h';
	if (d.unit === 'min' && [1, 2, 5, 15, 30, 60, 90].includes(d.value)) return `${d.value}m`;
	throw new Error(`Yahoo does not support interval ${d.value}${d.unit}`);
}

// ─── Binance (crypto) ─────────────────────────────────────────────────────

const BINANCE_ENDPOINT = 'https://api.binance.com/api/v3/klines';

/**
 *   [ openTime, open, high, low, close, volume, closeTime, ... ]
 * All numeric fields are strings; we convert them.
 */
type BinanceKline = [number, string, string, string, string, string, number, ...unknown[]];

/**
 * Binance's supported kline intervals. Binance rejects anything outside this
 * set with a generic error, so we reject it up front with a specific one.
 */
const BINANCE_INTERVALS = new Set([
	'1m', '3m', '5m', '15m', '30m',
	'1h', '2h', '4h', '6h', '8h', '12h',
	'1d', '3d'
]);

/**
 * When `from` is omitted, the earliest reasonable start per interval unit.
 * Without this bound, an intraday request walks from epoch 0 — millions of
 * 1m candles and thousands of HTTP calls.
 */
const DEFAULT_LOOKBACK_MS: Record<Duration['unit'], number> = {
	min: 30 * 86_400_000,   // 30 days
	hour: 730 * 86_400_000, // ~2 years
	day: Number.POSITIVE_INFINITY
};

/**
 * Binance klines. One symbol per request, capped at `maxLimit` candles;
 * we page until the requested range is covered or `MAX_PAGES` is reached.
 * Crypto has no splits or dividends, so `adjClose` is always null.
 */
export class BinanceHistory implements IHistoryProvider {
	constructor(private readonly maxLimit = 1000) {
		if (!Number.isInteger(maxLimit) || maxLimit < 1 || maxLimit > 1000) {
			throw new Error('Binance maxLimit must be an integer from 1 to 1000');
		}
	}

	async fetchBars(req: HistoryRequest): Promise<Bar[]> {
		const interval = req.interval ?? DEFAULT_INTERVAL;
		// Same rule as `assetKey` and the live feeds.
		const symbol = normalizeSymbol('crypto', req.asset.symbol);

		const lookback = DEFAULT_LOOKBACK_MS[interval.unit];
		const startTime = req.from
			? req.from.getTime()
			: Number.isFinite(lookback) ? Date.now() - lookback : 0;
		const endTime = req.to ? req.to.getTime() : Date.now();

		const bars: Bar[] = [];
		let cursor = startTime;
		let pages = 0;

		while (cursor < endTime) {
			if (pages >= MAX_PAGES) {
				throw new Error(
					`Binance ${symbol}: request exceeded ${MAX_PAGES} pages; ` +
					`narrow the time range or use a coarser interval`
				);
			}
			pages++;

			const url =
				`${BINANCE_ENDPOINT}?symbol=${encodeURIComponent(symbol)}` +
				`&interval=${toBinanceInterval(interval)}&startTime=${cursor}&endTime=${endTime}` +
				`&limit=${this.maxLimit}`;

			const res = await fetchWithTimeout(url);
			if (!res.ok) {
				const detail = await readErrorBody(res);
				throw new Error(`Binance ${symbol}: HTTP ${res.status} ${res.statusText}${detail}`);
			}

			const page = (await res.json()) as BinanceKline[];
			if (page.length === 0) break;

			for (const k of page) {
				bars.push({
					timestamp: new Date(k[0]),
					open: Number(k[1]),
					high: Number(k[2]),
					low: Number(k[3]),
					close: Number(k[4]),
					adjClose: null,
					volume: Number(k[5])
				});
			}

			const last = page[page.length - 1][0];
			if (last <= cursor) break; // defensive: no progress
			cursor = last + 1;
			if (page.length < this.maxLimit) break;
		}

		return bars;
	}
}

export function toBinanceInterval(d: Duration): string {
	let s: string;
	if (d.unit === 'min') s = `${d.value}m`;
	else if (d.unit === 'hour') s = `${d.value}h`;
	else if (d.unit === 'day') s = `${d.value}d`;
	else throw new Error(`Binance does not support unit ${d.unit}`);

	if (!BINANCE_INTERVALS.has(s)) {
		throw new Error(`Binance does not support interval ${s}`);
	}
	return s;
}

// ─── Router ───────────────────────────────────────────────────────────────

/**
 *   crypto              →  Binance
 *   us / global / forex →  Yahoo
 *
 * Metals (`XAUUSD`, `XAGUSD`, ...) are `forex` and go to Yahoo, where
 * `toYahooSymbol` maps them to futures. Live metals still come from BiQuote.
 */
export class HistoryRouter implements IHistoryProvider {
	constructor(
		private readonly yahoo: IHistoryProvider = new YahooHistory(),
		private readonly binance: IHistoryProvider = new BinanceHistory()
	) {}

	fetchBars(req: HistoryRequest): Promise<Bar[]> {
		return req.asset.type === 'crypto'
			? this.binance.fetchBars(req)
			: this.yahoo.fetchBars(req);
	}
}

export const createHistoryProvider = (): IHistoryProvider => new HistoryRouter();