import { EventEmitter } from 'node:events';
import * as protobuf from 'protobufjs';
import * as signalR from '@microsoft/signalr';
import { ManagedWebSocket, type ManagedWsOptions, type WsStatus } from './WebSocketService';

// ============================================================================
// Types
// ============================================================================

export type AssetType = 'us' | 'global' | 'forex' | 'crypto';

export interface Asset {
	name: string;
	symbol: string;
	type: AssetType;
}

/** Stable identifier of an asset, e.g. for caches. */
export const assetKey = (asset: Asset): string => `${asset.type}:${asset.symbol.toUpperCase()}`;

/** A single parsed price observation, provider-agnostic. */
export interface ParsedTick {
	symbol: string;
	price: number;
	time: Date;
}

export interface IFeed extends EventEmitter {
	subscribe(assets: Asset[]): Promise<void>;
	unsubscribe(assets: Asset[]): Promise<void>;
	close(): Promise<void>;
	on(event: 'tick', listener: (asset: Asset, price: number, marketTime: Date) => void): this;
	on(event: 'status', listener: (status: WsStatus) => void): this;
	on(event: 'error', listener: (error: Error) => void): this;
}

// ============================================================================
// Helpers
// ============================================================================

type RawData = Parameters<ManagedWsOptions['onMessage']>[0];

const noop = () => {};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const upper = (symbol: string): string => symbol.toUpperCase();
const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/** Strips the OANDA prefix and separators, so "OANDA:EUR_USD", "EUR/USD" and "EURUSD" all match. */
const normalizePair = (symbol: string): string =>
	symbol.toUpperCase().replace('OANDA:', '').replace(/[/_-]/g, '');

// ============================================================================
// Parsers (pure — no side effects, no asset lookup, no emit)
// ============================================================================

interface FinnhubTrade {
	type?: string;
	data?: Array<{ s?: string; p?: number; t?: number }>;
}

export function parseFinnhub(raw: RawData): ParsedTick[] {
	const msg = ManagedWebSocket.parseJson<FinnhubTrade>(raw);
	if (msg?.type !== 'trade' || !Array.isArray(msg.data)) return [];
	const ticks: ParsedTick[] = [];
	for (const { s, p, t } of msg.data) {
		if (typeof s !== 'string' || typeof p !== 'number' || typeof t !== 'number') continue;
		ticks.push({ symbol: s, price: p, time: new Date(t) }); // t is epoch milliseconds
	}
	return ticks;
}

interface YahooEnvelope {
	message?: string;
}
interface YahooTick {
	id?: string;
	price?: number;
	time?: number;
}

/** Minimal schema of Yahoo's message; unknown fields are ignored on decode. */
const YAHOO_PROTO = new protobuf.Type('PricingData')
	.add(new protobuf.Field('id', 1, 'string'))
	.add(new protobuf.Field('price', 2, 'float'))
	.add(new protobuf.Field('time', 3, 'sint64'));

export function parseYahoo(raw: RawData): ParsedTick[] {
	// Each frame is JSON: { message: <base64 protobuf> }.
	const envelope = ManagedWebSocket.parseJson<YahooEnvelope>(raw);
	if (typeof envelope?.message !== 'string') return [];

	let tick: YahooTick;
	try {
		// longs: Number turns the sint64 timestamp into a plain number.
		tick = YAHOO_PROTO.toObject(YAHOO_PROTO.decode(Buffer.from(envelope.message, 'base64')), {
			longs: Number
		});
	} catch {
		return []; // malformed frame
	}

	if (typeof tick.id !== 'string' || typeof tick.price !== 'number' || typeof tick.time !== 'number') {
		return [];
	}

	// The price is a 32-bit float; 7 significant digits removes the binary noise.
	const price = Number(tick.price.toPrecision(7));
	// Yahoo sends epoch milliseconds; values below 1e11 are treated as seconds.
	const ms = tick.time < 1e11 ? tick.time * 1000 : tick.time;
	return [{ symbol: tick.id, price, time: new Date(ms) }];
}

interface BinanceEnvelope {
	data?: { e?: string; s?: string; p?: string; T?: number };
}

export function parseBinance(raw: RawData): ParsedTick[] {
	const trade = ManagedWebSocket.parseJson<BinanceEnvelope>(raw)?.data;
	if (trade?.e !== 'trade' || typeof trade.s !== 'string') return [];
	if (typeof trade.p !== 'string' || typeof trade.T !== 'number') return [];
	return [{ symbol: trade.s, price: Number(trade.p), time: new Date(trade.T) }]; // T is epoch ms
}

export interface BiQuoteTick {
	symbol?: string;
	mid?: number;
	timestamp?: string;
}

export function parseBiQuote(tick: BiQuoteTick): ParsedTick[] {
	if (typeof tick?.symbol !== 'string' || typeof tick.mid !== 'number') return [];
	const time = tick.timestamp ? new Date(tick.timestamp) : new Date();
	return [{ symbol: tick.symbol, price: tick.mid, time }];
}

// ============================================================================
// BaseFeed
// ============================================================================

abstract class BaseFeed extends EventEmitter implements IFeed {
	/** Subscribed assets, keyed by the normalized symbol (= how the provider spells it). */
	protected readonly assets = new Map<string, Asset>();
	protected closed = false;
	private status: WsStatus = 'closed';

	protected constructor(private readonly normalize: (symbol: string) => string = upper) {
		super();
	}

	async subscribe(assets: Asset[]): Promise<void> {
		if (this.closed) throw new Error('Feed is closed');
		const added: Asset[] = [];
		for (const asset of assets) {
			const key = this.normalize(asset.symbol);
			if (this.assets.has(key)) continue;
			this.assets.set(key, asset);
			added.push(asset);
		}
		if (added.length > 0) await this.onAdded(added);
	}

	async unsubscribe(assets: Asset[]): Promise<void> {
		const removed = assets.filter((asset) => this.assets.delete(this.normalize(asset.symbol)));
		if (removed.length > 0) await this.onRemoved(removed);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.shutdown();
		this.setStatus('closed');
	}

	protected abstract onAdded(added: Asset[]): Promise<void>;
	protected async onRemoved(_removed: Asset[]): Promise<void> {}
	protected abstract shutdown(): Promise<void>;

	protected lookup(symbol: string): Asset | undefined {
		return this.assets.get(this.normalize(symbol));
	}

	/** Validates a tick and emits it. Invalid ticks are dropped silently. */
	protected emitTick(asset: Asset, price: number, time: Date): void {
		if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(time.getTime())) return;
		this.emit('tick', asset, price, time);
	}

	protected setStatus(next: WsStatus): void {
		if (this.status === next || (this.closed && next !== 'closed')) return;
		this.status = next;
		this.emit('status', next);
	}

	protected emitError(error: unknown): void {
		if (this.listenerCount('error') > 0) this.emit('error', toError(error));
	}

	protected createSocket(
		opts: Omit<ManagedWsOptions, 'onStatusChange' | 'onError'>
	): ManagedWebSocket {
		return new ManagedWebSocket({
			...opts,
			onStatusChange: (status) => this.setStatus(status),
			onError: (error) => this.emitError(error)
		});
	}

	/** Dispatch a batch of parsed ticks through the feed's lookup + emit pipeline. */
	protected dispatch(ticks: ParsedTick[]): void {
		for (const { symbol, price, time } of ticks) {
			const asset = this.lookup(symbol);
			if (asset) this.emitTick(asset, price, time);
		}
	}
}

// ============================================================================
// Finnhub (us stocks, WebSocket)
// ============================================================================

export class FinnhubFeed extends BaseFeed {
	private readonly ws: ManagedWebSocket;
	private started = false;

	constructor(apiKey: string) {
		super();
		if (!apiKey) throw new Error('FINNHUB_API_KEY required');
		this.ws = this.createSocket({
			url: `wss://ws.finnhub.io?token=${apiKey}`,
			onMessage: (raw) => this.dispatch(parseFinnhub(raw)),
			resubscribe: () => this.send('subscribe', this.assets.values())
		});
	}

	protected async onAdded(added: Asset[]): Promise<void> {
		if (!this.started) {
			this.started = true;
			await this.ws.connect();
			return;
		}
		this.send('subscribe', added);
	}

	protected async onRemoved(removed: Asset[]): Promise<void> {
		this.send('unsubscribe', removed);
	}

	protected async shutdown(): Promise<void> {
		this.ws.close();
	}

	private send(type: 'subscribe' | 'unsubscribe', assets: Iterable<Asset>): void {
		for (const { symbol } of assets) this.ws.send(JSON.stringify({ type, symbol }));
	}
}

// ============================================================================
// Yahoo (global stocks, WebSocket + protobuf)
// ============================================================================

export class YahooFeed extends BaseFeed {
	private static readonly RESUBSCRIBE_INTERVAL_MS = 15_000;

	private readonly ws: ManagedWebSocket;
	private started = false;

	constructor() {
		super();
		this.ws = this.createSocket({
			url: 'wss://streamer.finance.yahoo.com/?version=2',
			resubscribeIntervalMs: YahooFeed.RESUBSCRIBE_INTERVAL_MS,
			onMessage: (raw) => this.dispatch(parseYahoo(raw)),
			resubscribe: () => this.send('subscribe', this.assets.values())
		});
	}

	protected async onAdded(added: Asset[]): Promise<void> {
		if (!this.started) {
			this.started = true;
			await this.ws.connect();
			return;
		}
		this.send('subscribe', added);
	}

	protected async onRemoved(removed: Asset[]): Promise<void> {
		this.send('unsubscribe', removed);
	}

	protected async shutdown(): Promise<void> {
		this.ws.close();
	}

	private send(action: 'subscribe' | 'unsubscribe', assets: Iterable<Asset>): void {
		const symbols = [...assets].map((asset) => asset.symbol);
		if (symbols.length > 0) this.ws.send(JSON.stringify({ [action]: symbols }));
	}
}

// ============================================================================
// Binance (crypto, WebSocket)
// ============================================================================

export class BinanceFeed extends BaseFeed {
	private ws?: ManagedWebSocket;

	constructor() {
		super(normalizePair);
	}

	protected onAdded(): Promise<void> {
		return this.reopen();
	}

	protected onRemoved(): Promise<void> {
		return this.reopen();
	}

	protected async shutdown(): Promise<void> {
		this.ws?.close();
		this.ws = undefined;
	}

	private async reopen(): Promise<void> {
		this.ws?.close();
		this.ws = undefined;
		if (this.assets.size === 0) return;

		const streams = [...this.assets.keys()].map((s) => `${s.toLowerCase()}@trade`).join('/');
		const ws = this.createSocket({
			url: `wss://stream.binance.com:9443/stream?streams=${streams}`,
			onMessage: (raw) => this.dispatch(parseBinance(raw))
		});
		this.ws = ws;

		try {
			await ws.connect();
		} catch (error) {
			if (this.ws === ws) throw error;
		}
	}
}

// ============================================================================
// BiQuote (forex/metals, SignalR)
// ============================================================================

export class BiQuoteFeed extends BaseFeed {
	private static readonly URL = 'https://biquote.io/hubs/tick';
	private static readonly MAX_BACKOFF_MS = 30_000;
	private static readonly START_ATTEMPTS = 3;
	private static readonly RETRY_DELAY_MS = 1000;

	private conn?: signalR.HubConnection;

	constructor() {
		super(normalizePair);
	}

	protected async onAdded(): Promise<void> {
		if (!this.conn) return this.open();
		await this.sendSubscriptions();
	}

	protected async shutdown(): Promise<void> {
		const conn = this.conn;
		this.conn = undefined;
		await conn?.stop().catch(noop);
	}

	private async open(): Promise<void> {
		const conn = new signalR.HubConnectionBuilder()
			.withUrl(BiQuoteFeed.URL)
			.withAutomaticReconnect({
				nextRetryDelayInMilliseconds: ({ previousRetryCount }) =>
					Math.min(BiQuoteFeed.MAX_BACKOFF_MS, 1000 * 2 ** previousRetryCount)
			})
			.configureLogging(signalR.LogLevel.Warning)
			.build();
		this.conn = conn;

		conn.on('ReceiveSubscriptionState', noop);
		conn.on('ReceiveTick', (tick: BiQuoteTick) => this.dispatch(parseBiQuote(tick)));
		conn.onreconnecting(() => this.setStatus('connecting'));
		conn.onreconnected(() => {
			this.setStatus('open');
			this.sendSubscriptions().catch((error) => this.emitError(error));
		});
		conn.onclose((error) => {
			this.setStatus('closed');
			if (error) this.emitError(error);
		});

		for (let attempt = 1; !this.closed; attempt++) {
			this.setStatus('connecting');
			try {
				await conn.start();
				await this.sendSubscriptions();
				this.setStatus('open');
				return;
			} catch (error) {
				if (this.closed) break;
				this.emitError(error);
				await conn.stop().catch(noop);

				if (attempt >= BiQuoteFeed.START_ATTEMPTS) {
					this.conn = undefined;
					this.setStatus('closed');
					throw error;
				}
				await sleep(BiQuoteFeed.RETRY_DELAY_MS * attempt);
			}
		}
		throw new Error('BiQuote feed closed during startup');
	}

	private async sendSubscriptions(): Promise<void> {
		const conn = this.conn;
		if (conn?.state !== signalR.HubConnectionState.Connected || this.assets.size === 0) return;
		await conn.invoke('Subscribe', [...this.assets.keys()]);
	}
}

// ============================================================================
// Factory
// ============================================================================

/** 'us-yahoo-overflow' serves "us" assets from Yahoo (e.g. past Finnhub's symbol limit). */
export type FeedProvider = 'primary' | 'us-yahoo-overflow';

export const createFeed = (
	type: AssetType,
	finnhubApiKey: string,
	provider: FeedProvider = 'primary'
): IFeed => {
	if (type === 'us') {
		return provider === 'us-yahoo-overflow' ? new YahooFeed() : new FinnhubFeed(finnhubApiKey);
	}
	switch (type) {
		case 'global':
			return new YahooFeed();
		case 'forex':
			return new BiQuoteFeed();
		case 'crypto':
			return new BinanceFeed();
	}
};