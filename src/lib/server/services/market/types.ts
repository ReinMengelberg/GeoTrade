/**
 * types.ts — domain shapes and symbol normalization.
 *
 * Bottom of the dependency graph. Everything imports from here; nothing here
 * imports from anything else. If you need to add an import, the type probably
 * belongs one layer up.
 */

export type AssetType = 'us' | 'global' | 'forex' | 'crypto';
export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface Asset {
	name: string;
	symbol: string;
	type: AssetType;
}

export interface Duration {
	value: number;
	unit: 'min' | 'hour' | 'day';
}

export interface PricePoint {
	timestamp: Date;
	price: number;
}

export interface AssetPrice {
	asset: Asset;
	point: PricePoint;
	/**
	 * Milliseconds since this process received the tick. Not the market age —
	 * that's `point.timestamp`. Always 0 on `'price'` events (the tick just
	 * landed); only meaningful in `snapshot()` results, where it grows.
	 */
	ageMs: number;
}

/** One OHLCV bar. `adjClose` applies only to daily equity bars. */
export interface Bar {
	timestamp: Date;
	open: number;
	high: number;
	low: number;
	close: number;
	/** Null for crypto, FX, and metals. */
	adjClose: number | null;
	/** Null for FX and metals; sometimes 0 for indices. */
	volume: number | null;
}

export interface HistoryRequest {
	asset: Asset;
	/** Default: earliest available. */
	from?: Date;
	/** Default: now. */
	to?: Date;
	/** Default: `{ value: 1, unit: 'day' }`. */
	interval?: Duration;
}

/** Strips every "OANDA:" prefix plus "/", "_", "-", and uppercases. Idempotent. */
export const normalizePair = (symbol: string): string =>
	symbol.toUpperCase().replace(/OANDA:/g, '').replace(/[/_-]/g, '');

/**
 * Canonical symbol for an asset type. Every feed, every history provider,
 * and `assetKey` must agree on this or the same asset looks like two
 * different assets to different layers.
 *
 *   us, global   →  uppercase (AAPL, SAP.DE)
 *   forex, crypto  →  separators stripped (EURUSD, BTCUSDT)
 */
export const normalizeSymbol = (type: AssetType, symbol: string): string =>
	type === 'forex' || type === 'crypto' ? normalizePair(symbol) : symbol.toUpperCase();

/** Stable identifier of an asset, e.g. for caches. */
export const assetKey = (asset: Asset): string =>
	`${asset.type}:${normalizeSymbol(asset.type, asset.symbol)}`;