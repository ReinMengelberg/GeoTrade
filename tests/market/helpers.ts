/**
 * Shared test utilities: a local WebSocket server, a fake feed, a CSV
 * reader, and timing helpers. Nothing here touches the network beyond
 * localhost.
 */

import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import {
	normalizeSymbol,
	type Asset,
	type AssetType,
	type ConnectionStatus
} from '../../src/lib/server/services/market/types';
import type { IFeed } from '../../src/lib/server/services/market/live';

// ─── Local WebSocket server ─────────────────────────────────────────────────

export interface TestServer {
	url: string;
	/** Sockets connected since the server started, in connection order. */
	clients: WebSocket[];
	/** Frames received per client, in order. */
	frames: string[][];
	/** Push a frame to every connected client. */
	broadcast(data: string): void;
	/** Close all clients and stop listening. */
	close(): Promise<void>;
}

/**
 * Start a WebSocket server on an OS-assigned port. The caller gets a URL
 * and helpers to observe what clients sent and push frames back.
 */
export async function startTestServer(
	onConnection?: (socket: WebSocket, index: number) => void
): Promise<TestServer> {
	const server = new WebSocketServer({ port: 0 });
	await new Promise<void>((resolve) => server.once('listening', () => resolve()));
	const port = (server.address() as AddressInfo).port;

	const clients: WebSocket[] = [];
	const frames: string[][] = [];

	server.on('connection', (socket) => {
		const index = clients.length;
		clients.push(socket);
		frames.push([]);
		socket.on('message', (data) => frames[index].push(data.toString()));
		onConnection?.(socket, index);
	});

	return {
		url: `ws://127.0.0.1:${port}`,
		clients,
		frames,
		broadcast(data): void {
			for (const socket of clients) {
				if (socket.readyState === socket.OPEN) socket.send(data);
			}
		},
		async close(): Promise<void> {
			for (const socket of clients) socket.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	};
}

// ─── Fake feed ──────────────────────────────────────────────────────────────

/**
 * Minimal `IFeed` that records every subscribe/unsubscribe and lets tests
 * emit ticks by hand. Used to drive `MarketData` without touching providers.
 */
export class FakeFeed extends EventEmitter implements IFeed {
	readonly subscribed = new Set<string>();
	readonly subscribeCalls: Asset[][] = [];
	readonly unsubscribeCalls: Asset[][] = [];
	closed = false;
	/** When true, `subscribe()` rejects. */
	failOnSubscribe = false;

	async subscribe(assets: Asset[]): Promise<void> {
		if (this.failOnSubscribe) throw new Error('fake feed: subscribe failed');
		this.subscribeCalls.push([...assets]);
		for (const a of assets) this.subscribed.add(`${a.type}:${a.symbol}`);
		this.emit('status', 'open' as ConnectionStatus);
	}

	async unsubscribe(assets: Asset[]): Promise<void> {
		this.unsubscribeCalls.push([...assets]);
		for (const a of assets) this.subscribed.delete(`${a.type}:${a.symbol}`);
	}

	async close(): Promise<void> {
		this.closed = true;
		this.emit('status', 'closed' as ConnectionStatus);
	}

	/** Test helper: emit a tick from this feed. */
	emitTick(asset: Asset, price: number, time: Date = new Date()): void {
		this.emit('tick', asset, price, time);
	}

	// Narrow the inherited `on` to match IFeed's overloads. The implementation
	// signature uses `any[]` because parameter types are contravariant — a
	// narrower `unknown[]` would reject the specific overloads above.
	override on(event: 'tick', listener: (asset: Asset, price: number, marketTime: Date) => void): this;
	override on(event: 'status', listener: (status: ConnectionStatus) => void): this;
	override on(event: 'error', listener: (error: Error) => void): this;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	override on(event: string | symbol, listener: (...args: any[]) => void): this {
		return super.on(event, listener);
	}
}

// ─── CSV reader ─────────────────────────────────────────────────────────────

const ASSET_TYPES: AssetType[] = ['us', 'global', 'forex', 'crypto'];

const isAssetType = (s: string): s is AssetType => (ASSET_TYPES as string[]).includes(s);

/**
 * Reads a CSV of `name,symbol,type`. Tolerates comments (`#`), blank lines,
 * and CRLF. Rejects duplicate `(type, normalized-symbol)` pairs so an input
 * mistake surfaces at load time rather than as a silently missing row.
 */
export function readAssetsFromCsv(filename: string): Asset[] {
	const lines = readFileSync(filename, 'utf8')
		.split(/\r?\n/)
		.map((l) => l.replace(/#.*$/, '').trim())
		.filter((l) => l.length > 0);

	if (lines.length === 0) throw new Error(`${filename} is empty`);
	if (lines[0].toLowerCase() !== 'name,symbol,type') {
		throw new Error(`${filename}: expected header "name,symbol,type"`);
	}

	const seen = new Set<string>();
	const assets: Asset[] = [];

	for (let i = 1; i < lines.length; i++) {
		const cells = lines[i].split(',').map((c) => c.trim());
		if (cells.length !== 3) {
			throw new Error(`${filename}:${i + 1}: expected 3 columns, got "${lines[i]}"`);
		}
		const [name, symbol, type] = cells;
		if (!name || !symbol || !type) {
			throw new Error(`${filename}:${i + 1}: empty field in "${lines[i]}"`);
		}
		if (!isAssetType(type)) {
			throw new Error(`${filename}:${i + 1}: unknown type "${type}"`);
		}
		const key = `${type}:${normalizeSymbol(type, symbol)}`;
		if (seen.has(key)) {
			throw new Error(`${filename}:${i + 1}: duplicate asset "${key}"`);
		}
		seen.add(key);
		assets.push({ name, symbol, type });
	}
	return assets;
}

// ─── Timing ─────────────────────────────────────────────────────────────────

export const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `predicate()` returns true, or fail after `timeoutMs`. */
export async function waitFor(
	predicate: () => boolean,
	timeoutMs = 2000,
	pollMs = 10
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('waitFor: timed out');
		await sleep(pollMs);
	}
}