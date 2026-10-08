/**
 * index.ts
 * Public surface of the market data layer. Import from here, not from the
 * individual modules — the submodule exports are internal API and may change.
 */

// Domain types and the one helper a caller needs to build valid assets.
export type {
	Asset,
	AssetPrice,
	AssetType,
	Bar,
	ConnectionStatus,
	Duration,
	HistoryRequest,
	PricePoint
} from './types';
export { normalizeSymbol } from './types';

// The application's entry point.
export { MarketData } from './marketdata';
export type {
	FeedErrorEvent,
	FeedStatusEvent,
	IMarketData,
	SubscribeFailure,
	SubscribeResult
} from './marketdata';

// Provider interfaces, for callers who want to type their own implementations.
export type { FeedProvider, IFeed } from './live';
export type { IHistoryProvider } from './history';