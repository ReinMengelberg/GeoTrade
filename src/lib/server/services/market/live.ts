/**
 * live.ts — long-running price feeds, one class per provider.
 *
 * Four protocols behind one interface. `BaseFeed` handles lifecycle;
 * `WebSocketFeed` adds the connect-sharing pattern that Finnhub and Yahoo
 * share. Binance and BiQuote extend `BaseFeed` directly — their connection
 * models don't fit the WebSocket shape.
 */

import { EventEmitter } from 'node:events';
import * as protobuf from 'protobufjs';
import * as signalR from '@microsoft/signalr';
import { ManagedWebSocket, toError, type ManagedWebSocketOptions } from './websocket';
import { normalizeSymbol, type Asset, type AssetType, type ConnectionStatus } from './types';

/** A single parsed price observation, provider-agnostic. */
export interface ParsedTick {
	symbol: string;
	price: number;
	time: Date;
}

/**
 * A live price source.
 *
 * Deliberately not an `EventEmitter` subclass — that would leak a specific
 * implementation into the contract. The `on` overloads are all a consumer
 * needs; emitters are the implementer's choice.
 */
export interface IFeed {
	subscribe(assets: Asset[]): Promise<void>;
	unsubscribe(assets: Asset[]): Promise<void>;
	close(): Promise<void>;
	/**
	 * Positional, not an object payload like the events below — this runs on
	 * every tick, and destructuring per call costs measurable time at crypto
	 * tick rates (Binance can push thousands per second). `status` and `error`
	 * fire only on transitions, so they can afford object payloads.
	 */
	on(event: 'tick', listener: (asset: Asset, price: number, marketTime: Date) => void): this;
	on(event: 'status', listener: (status: ConnectionStatus) => void): this;
	on(event: 'error', listener: (error: Error) => void): this;
}

type RawData = Parameters<ManagedWebSocketOptions['onMessage']>[0];

const noop = () => {};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ─── Parsers (pure) ───────────────────────────────────────────────────────

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
		ticks.push({ symbol: s, price: p, time: new Date(t) }); // t is epoch ms
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

/** Unknown fields are ignored on decode. */
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

	// The wire is a 32-bit float, already the provider's intended precision.
	// JS `number` holds it exactly, so no rounding is applied.
	const price = tick.price;
	// Epoch milliseconds; values below 1e11 are treated as seconds.
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
	return [{ symbol: trade.s, price: Number(trade.p), time: new Date(trade.T) }];
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

// ─── BaseFeed ─────────────────────────────────────────────────────────────

export abstract class BaseFeed extends EventEmitter implements IFeed {
	/** Subscribed assets, keyed by the provider's spelling of the symbol. */
	protected readonly assets = new Map<string, Asset>();
	protected closed = false;
	private status: ConnectionStatus = 'closed';

	/** `normalize` is protected so subclasses can normalize when sending frames. */
	protected constructor(protected readonly normalize: (symbol: string) => string) {
		super();
	}

	async subscribe(assets: Asset[]): Promise<void> {
		if (this.closed) throw new Error('Feed is closed and cannot be reused; create a new feed');

		const added: Asset[] = [];
		const addedKeys: string[] = [];
		for (const asset of assets) {
			const key = this.normalize(asset.symbol);
			if (this.assets.has(key)) continue;
			this.assets.set(key, asset);
			added.push(asset);
			addedKeys.push(key);
		}
		if (added.length === 0) return;

		try {
			await this.onAdded(added);
		} catch (error) {
			// Roll back so a later subscribe retries. Without this the feed is
			// a zombie: assets stay marked subscribed, `onAdded` never fires
			// again, and the caller's rejection can't be repaired.
			for (const key of addedKeys) this.assets.delete(key);
			if (this.assets.size === 0) this.onRollbackToEmpty();
			throw error;
		}
	}

	async unsubscribe(assets: Asset[]): Promise<void> {
		const removed = assets.filter((asset) => this.assets.delete(this.normalize(asset.symbol)));
		if (removed.length > 0) await this.onRemoved(removed);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			await this.shutdown();
		} finally {
			// Status must reflect reality even if shutdown threw — a feed
			// that failed to close is still, from the caller's view, closed.
			this.setStatus('closed');
		}
	}

	protected abstract onAdded(added: Asset[]): Promise<void>;
	/** Default: nothing to tell the provider. Override where unsubscribe exists. */
	protected async onRemoved(_removed: Asset[]): Promise<void> {}
	protected abstract shutdown(): Promise<void>;

	/**
	 * Called after a failed `onAdded` rolls back to zero assets. Subclasses
	 * close any in-flight connection so the next subscribe starts fresh.
	 */
	protected onRollbackToEmpty(): void {}

	/** Resolves a provider-spelled symbol to its `Asset`. */
	protected lookup(symbol: string): Asset | undefined {
		return this.assets.get(this.normalize(symbol));
	}

	protected emitTick(asset: Asset, price: number, time: Date): void {
		if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(time.getTime())) return;
		this.emit('tick', asset, price, time);
	}

	protected setStatus(next: ConnectionStatus): void {
		if (this.status === next || (this.closed && next !== 'closed')) return;
		this.status = next;
		this.emit('status', next);
	}

	/** Node throws on unhandled `'error'`. Emit only if someone is listening. */
	protected emitError(error: unknown): void {
		if (this.listenerCount('error') > 0) this.emit('error', toError(error));
	}

	protected createSocket(
		opts: Omit<ManagedWebSocketOptions, 'onStatusChange' | 'onError'>
	): ManagedWebSocket {
		return new ManagedWebSocket({
			...opts,
			onStatusChange: (status) => this.setStatus(status),
			onError: (error) => this.emitError(error)
		});
	}

	/** Resolves each parsed tick to its asset and emits it. */
	protected dispatch(ticks: ParsedTick[]): void {
		for (const { symbol, price, time } of ticks) {
			const asset = this.lookup(symbol);
			if (asset) this.emitTick(asset, price, time);
		}
	}
}

// ─── WebSocketFeed ────────────────────────────────────────────────────────

/**
 * A feed backed by a single `ManagedWebSocket`. Subclasses supply the URL,
 * the parser, and how to send subscription frames.
 *
 * Frame-sending rule, in one place:
 *   - On the first subscribe, `ensureConnected` opens a fresh socket and
 *     `ManagedWebSocket` fires `resubscribe`, which sends the full set from
 *     `this.assets`. `onAdded` skips its own send on that call.
 *   - On later subscribes, the socket is already open, `resubscribe` doesn't
 *     fire, and `sendUpdate` sends only the delta.
 *
 * Without the `hasOpened` check, the first subscribe would send every frame
 * twice — once from `resubscribe`, once from `onAdded`.
 */
abstract class WebSocketFeed extends BaseFeed {
	protected readonly ws: ManagedWebSocket;
	private connectPromise?: Promise<void>;

	/**
	 * True once we've seen a successful open. Not synced to readyState — a
	 * drop-and-reconnect leaves this true, and the `resubscribe` callback is
	 * what re-establishes state. That's why `onAdded` after `hasOpened` doesn't
	 * need to connect: frames sent on a closed socket are dropped by `send()`,
	 * and the next `ws.on('open')` re-sends the full set.
	 */
	private hasOpened = false;

	protected constructor(
		normalize: (s: string) => string,
		url: string,
		parser: (raw: RawData) => ParsedTick[],
		opts: Omit<
			ManagedWebSocketOptions,
			'url' | 'onMessage' | 'resubscribe' | 'onStatusChange' | 'onError'
		> = {}
	) {
		super(normalize);
		this.ws = new ManagedWebSocket({
			...opts,
			url,
			onMessage: (raw) => this.dispatch(parser(raw)),
			resubscribe: () => this.sendFullSubscription(),
			onStatusChange: (s) => this.setStatus(s),
			onError: (e) => this.emitError(e)
		});
	}

	protected async onAdded(added: Asset[]): Promise<void> {
		const wasOpen = this.hasOpened;
		await this.ensureConnected();
		if (wasOpen) this.sendUpdate(added);
	}

	/** Shares the in-flight connect across concurrent callers. */
	private async ensureConnected(): Promise<void> {
		if (this.hasOpened) return;

		let p = this.connectPromise;
		if (!p) {
			p = this.ws.connect();
			this.connectPromise = p;
		}
		try {
			await p;
			this.hasOpened = true;
		} finally {
			if (this.connectPromise === p) this.connectPromise = undefined;
		}
	}

	protected onRollbackToEmpty(): void {
		this.ws.close();
		this.hasOpened = false;
	}

	protected async shutdown(): Promise<void> {
		this.ws.close();
	}

	/** Called only when the socket was already open before this subscribe. */
	protected abstract sendUpdate(added: Asset[]): void;

	/** Called by `ManagedWebSocket` on every (re)open and heartbeat tick. */
	protected abstract sendFullSubscription(): void;
}

// ─── Finnhub (us stocks) ──────────────────────────────────────────────────

export class FinnhubFeed extends WebSocketFeed {
	constructor(apiKey: string, url: string = `wss://ws.finnhub.io?token=${apiKey}`) {
		if (!apiKey) throw new Error('FINNHUB_API_KEY required');
		super((s) => normalizeSymbol('us', s), url, parseFinnhub);
	}

	protected sendUpdate(added: Asset[]): void {
		this.send('subscribe', added);
	}

	protected sendFullSubscription(): void {
		this.send('subscribe', this.assets.values());
	}

	protected async onRemoved(removed: Asset[]): Promise<void> {
		this.send('unsubscribe', removed);
	}

	private send(type: 'subscribe' | 'unsubscribe', assets: Iterable<Asset>): void {
		for (const { symbol } of assets) {
			this.ws.send(JSON.stringify({ type, symbol: this.normalize(symbol) }));
		}
	}
}

// ─── Yahoo (global stocks and US overflow) ────────────────────────────────

/**
 * Yahoo's streamer has no partial-subscribe protocol. Sending a symbol list
 * replaces or extends the server-side set, but the semantics are undocumented.
 * We therefore always send the full desired set on every change, and never
 * send an unsubscribe — there is no safe frame for it. Late ticks for removed
 * symbols are dropped by `lookup`.
 */
export class YahooFeed extends WebSocketFeed {
	private static readonly RESUBSCRIBE_INTERVAL_MS = 15_000;

	constructor(url: string = 'wss://streamer.finance.yahoo.com/?version=2') {
		// Yahoo serves both "global" and "us-yahoo-overflow" assets under the
		// same uppercased spelling.
		super((s) => normalizeSymbol('global', s), url, parseYahoo, {
			resubscribeIntervalMs: YahooFeed.RESUBSCRIBE_INTERVAL_MS
		});
	}

	protected sendUpdate(): void {
		this.sendFullSubscription();
	}

	protected sendFullSubscription(): void {
		const symbols = [...this.assets.values()].map((a) => this.normalize(a.symbol));
		if (symbols.length === 0) return;
		this.ws.send(JSON.stringify({ subscribe: symbols }));
	}
}

// ─── Binance (crypto) ─────────────────────────────────────────────────────

/**
 * Binance streams are baked into the URL — any subscription change requires
 * a full reconnect. That asymmetry is why this doesn't extend `WebSocketFeed`.
 *
 * Known transient gap: `reopen` closes the old socket before the new one
 * connects. If the new connect fails, existing assets are briefly unserved
 * while `ManagedWebSocket` retries in the background. The retry's URL may
 * include a rolled-back symbol; those ticks are dropped by `lookup`, so
 * the waste is bandwidth, not correctness.
 */
export class BinanceFeed extends BaseFeed {
	private ws?: ManagedWebSocket;

	constructor(private readonly baseUrl = 'wss://stream.binance.com:9443') {
		super((s) => normalizeSymbol('crypto', s));
	}

	protected onAdded(): Promise<void> {
		return this.reopen();
	}

	protected onRemoved(): Promise<void> {
		return this.reopen();
	}

	protected onRollbackToEmpty(): void {
		this.ws?.close();
		this.ws = undefined;
	}

	protected async shutdown(): Promise<void> {
		this.ws?.close();
		this.ws = undefined;
	}

	private async reopen(): Promise<void> {
		this.ws?.close(); // may emit a transient 'closed' before the new socket opens
		this.ws = undefined;
		if (this.assets.size === 0) return;

		const streams = [...this.assets.keys()].map((s) => `${s.toLowerCase()}@trade`).join('/');
		const ws = this.createSocket({
			url: `${this.baseUrl}/stream?streams=${streams}`,
			onMessage: (raw) => this.dispatch(parseBinance(raw))
		});
		this.ws = ws;

		try {
			await ws.connect();
		} catch (error) {
			// A newer reopen() or close() may have replaced this socket; its
			// rejection is expected. Only propagate if we're still current.
			if (this.ws === ws) throw error;
		}
	}
}

// ─── BiQuote (forex / metals, SignalR) ────────────────────────────────────

export class BiQuoteFeed extends BaseFeed {
	private static readonly DEFAULT_URL = 'https://biquote.io/hubs/tick';
	private static readonly MAX_BACKOFF_MS = 30_000;
	private static readonly START_ATTEMPTS = 3;
	private static readonly RETRY_DELAY_MS = 1000;

	private conn?: signalR.HubConnection;
	private readonly url: string;
	private readonly logLevel: signalR.LogLevel;

	/**
	 * Promise for the in-flight `open()`. Shared across concurrent subscribes
	 * so they await the same connect and see the same outcome — same pattern
	 * as `WebSocketFeed.ensureConnected`.
	 */
	private connectPromise?: Promise<void>;

	/**
	 * @param url       Hub URL. Override for tests that need an unreachable host.
	 * @param logLevel  SignalR's own logger. Default `Warning`; tests pass
	 *                  `None` to keep stdout clean.
	 */
	constructor(
		url: string = BiQuoteFeed.DEFAULT_URL,
		logLevel: signalR.LogLevel = signalR.LogLevel.Warning
	) {
		super((s) => normalizeSymbol('forex', s));
		this.url = url;
		this.logLevel = logLevel;
	}

	protected async onAdded(): Promise<void> {
		if (this.conn?.state === signalR.HubConnectionState.Connected) {
			await this.sendSubscriptions();
			return;
		}
		if (this.connectPromise) {
			await this.connectPromise;
			return;
		}
		// `conn` exists but isn't Connected, and no connect is in flight:
		// SignalR is reconnecting. Its `onreconnected` handler will resubscribe.
		//
		// Known limitation: if SignalR gives up, this caller's subscribe already
		// resolved and never learns. Documented in MarketData's limitations.
		if (this.conn) return;

		const p = this.open();
		this.connectPromise = p;
		try {
			await p;
		} finally {
			if (this.connectPromise === p) this.connectPromise = undefined;
		}
	}

	// No onRollbackToEmpty: `open()` clears `this.conn` before throwing, so
	// no connection is left retrying in the background.

	protected async shutdown(): Promise<void> {
		const conn = this.conn;
		this.conn = undefined;
		await conn?.stop().catch(noop);
	}

	private async open(): Promise<void> {
		const conn = new signalR.HubConnectionBuilder()
			.withUrl(this.url)
			.withAutomaticReconnect({
				nextRetryDelayInMilliseconds: ({ previousRetryCount }) =>
					Math.min(BiQuoteFeed.MAX_BACKOFF_MS, 1000 * 2 ** previousRetryCount)
			})
			.configureLogging(this.logLevel)
			.build();
		this.conn = conn;

		conn.on('ReceiveSubscriptionState', noop); // silences a SignalR warning
		conn.on('ReceiveTick', (tick: BiQuoteTick) => this.dispatch(parseBiQuote(tick)));
		conn.onreconnecting(() => this.setStatus('connecting'));
		conn.onreconnected(() => {
			this.setStatus('open');
			// Server-side subscriptions are lost when the connection drops.
			this.sendSubscriptions().catch((error) => this.emitError(error));
		});
		conn.onclose((error) => {
			// Clear the field so a later onAdded() can open a fresh connection.
			if (this.conn === conn) this.conn = undefined;
			this.setStatus('closed');
			if (error) this.emitError(error);
		});

		// `withAutomaticReconnect` only kicks in after a successful first connect.
		// The initial connect is retried here. `this.conn` is reattached on every
		// attempt because `conn.stop()` fires `onclose`, which clears the field.
		for (let attempt = 1; !this.closed; attempt++) {
			this.conn = conn;
			this.setStatus('connecting');
			try {
				await conn.start();
				await this.sendSubscriptions();
				this.setStatus('open');
				return;
			} catch (error) {
				if (this.closed) break;
				this.emitError(error);
				await conn.stop().catch(noop); // never retry start() on a half-started connection

				if (attempt >= BiQuoteFeed.START_ATTEMPTS) {
					if (this.conn === conn) this.conn = undefined;
					this.setStatus('closed');
					throw error;
				}
				// Linear backoff with jitter, so a fleet doesn't retry in lockstep.
				const delay = BiQuoteFeed.RETRY_DELAY_MS * attempt * (0.5 + Math.random() * 0.5);
				await sleep(delay);
			}
		}
		throw new Error('BiQuote feed closed during startup');
	}

	/** Sends the complete symbol set. No-op while the connection is not up. */
	private async sendSubscriptions(): Promise<void> {
		const conn = this.conn;
		if (conn?.state !== signalR.HubConnectionState.Connected || this.assets.size === 0) return;
		await conn.invoke('Subscribe', [...this.assets.keys()]);
	}
}

// ─── Factory ──────────────────────────────────────────────────────────────

/** 'us-yahoo-overflow' serves "us" assets from Yahoo past the Finnhub limit. */
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