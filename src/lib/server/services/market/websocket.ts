/**
 * websocket.ts — one WebSocket with automatic reconnection.
 *
 * Knows nothing about assets or protocols. Delivers raw frames, reports
 * transport state, keeps the connection alive. Everything above treats it
 * as a black box.
 */

import WebSocket from 'ws';
import type { ConnectionStatus } from './types';

/** Normalizes a thrown value into an `Error`. JS allows throwing anything. */
export const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/**
 * Invokes a notification callback, swallowing anything it throws. These run
 * inside socket event handlers — a throw there is an uncaught exception.
 */
const safeCall = <T>(fn: ((arg: T) => void) | undefined, arg: T): void => {
	try {
		fn?.(arg);
	} catch {
		// A notification callback can't meaningfully fail.
	}
};

export interface ManagedWebSocketOptions {
	/** WebSocket endpoint (ws:// or wss://). */
	url: string;
	/** Called for every incoming frame. Exceptions route to `onError`. */
	onMessage: (data: WebSocket.RawData) => void;
	/**
	 * Called on every (re)open, and periodically if `resubscribeIntervalMs`
	 * is set. Takes no arguments — the caller sends its own subscription
	 * state via `send()`.
	 */
	resubscribe?: () => void;
	/** If > 0, calls `resubscribe` on this interval while the socket is open. */
	resubscribeIntervalMs?: number;
	/**
	 * If > 0, terminate the socket when no message arrives within this window.
	 * Recovers from connections that die without a TCP close (NAT timeout,
	 * Wi-Fi drop). Off by default — set generously for feeds that go quiet
	 * legitimately (equities outside market hours).
	 */
	idleTimeoutMs?: number;
	/** Fires only on real transitions. */
	onStatusChange?: (status: ConnectionStatus) => void;
	/** Sink for socket errors and callback exceptions. Never throws asynchronously. */
	onError?: (error: Error) => void;
	/** Upper bound for the reconnect delay. Default: 30 000 ms. */
	maxBackoffMs?: number;
}

/**
 * A single WebSocket with automatic reconnection.
 *
 *   - `connect()` resolves on the first open, rejects if that first attempt
 *     fails (or if `close()` / another `connect()` supersedes it). After a
 *     failed first attempt, retries continue in the background until `close()`.
 *   - `close()` is final until the next `connect()`.
 *
 * Contract:
 *   1. At most one live socket. A second `connect()` retires the previous one.
 *   2. `connect()` settles exactly once per call.
 *   3. Consumer callbacks may throw; the process does not crash.
 *   4. Stale sockets cannot fire handlers — identity-checked on every event.
 *      `teardown()` clears `this.socket` before `ws.close()`, so late events
 *      from a retired socket fail the check.
 *   5. `onStatusChange` fires only on real transitions.
 *   6. Reconnection is scheduled from exactly one place — the `close` handler.
 *      `ws` always follows `error` with `close`; scheduling in both double-
 *      reconnects.
 *   7. An invalid URL is fatal — `active` clears, promise rejects, no retry.
 *   8. `send()` never throws. Returns false when the socket isn't open.
 *   9. Query strings are stripped from every error message that reaches
 *      `onError` or rejects the `connect()` promise, so API tokens cannot
 *      leak into logs.
 *  10. Backoff resets only after 30s of stability, so a flapping server keeps
 *      growing the delay instead of hammering.
 *  11. Teardown force-terminates a socket that doesn't close within 2s.
 */
export class ManagedWebSocket {
	private static readonly STABLE_WINDOW_MS = 30_000;
	private static readonly CLOSE_GRACE_MS = 2_000;

	private readonly opts: ManagedWebSocketOptions;
	private socket?: WebSocket;
	private status: ConnectionStatus = 'closed';
	/**
	 * User intent. True between `connect()` and `close()`. Persists across
	 * reconnects — this is what distinguishes "closed because we're retrying"
	 * from "closed because the caller is done".
	 */
	private active = false;
	/** Consecutive failed attempts since the last stable connection. */
	private attempts = 0;
	private retryTimer?: NodeJS.Timeout;
	private resubTimer?: NodeJS.Timeout;
	private stableTimer?: NodeJS.Timeout;
	private idleTimer?: NodeJS.Timeout;
	private pending?: { resolve: () => void; reject: (error: Error) => void };

	constructor(opts: ManagedWebSocketOptions) {
		this.opts = opts;
	}

	/** Resolves on the first open; rejects on the first failure or if superseded. */
	connect(): Promise<void> {
		this.teardown(new Error('connect() superseded by a new call'));
		this.active = true;
		this.attempts = 0;
		return new Promise<void>((resolve, reject) => {
			this.pending = { resolve, reject };
			this.open();
		});
	}

	/** Final until the next `connect()`. */
	close(): void {
		this.active = false;
		this.teardown(new Error('close() called by user'));
		this.setStatus('closed');
	}

	/**
	 * Sends one frame. Returns false — without throwing — if the socket isn't
	 * open. The frame is dropped, not queued; the `resubscribe` callback on
	 * the next open is expected to restore whatever was lost.
	 */
	send(data: string | Buffer): boolean {
		const ws = this.socket;
		if (!ws || ws.readyState !== WebSocket.OPEN) return false;
		try {
			ws.send(data);
			return true;
		} catch (error) {
			this.notifyError(toError(error));
			return false;
		}
	}

	/**
	 * Parses a raw message as JSON, or returns `undefined`.
	 *
	 * `RawData` is `Buffer | ArrayBuffer | Buffer[]`. Fragments must be
	 * concatenated — `toString()` on the array inserts commas.
	 */
	static parseJson<T>(raw: WebSocket.RawData): T | undefined {
		try {
			const buf = Array.isArray(raw)
				? Buffer.concat(raw)
				: Buffer.isBuffer(raw)
					? raw
					: Buffer.from(raw);
			return JSON.parse(buf.toString('utf8')) as T;
		} catch {
			return undefined;
		}
	}

	// ─── Connection lifecycle ───────────────────────────────────────────────

	private open(): void {
		if (!this.active) return;
		this.setStatus('connecting');

		let ws: WebSocket;
		try {
			ws = new WebSocket(this.opts.url);
		} catch (error) {
			// Invalid URL / protocol — retrying can't fix it.
			this.active = false;
			this.setStatus('closed');
			this.notifyError(toError(error));
			this.settle(toError(error));
			return;
		}

		this.socket = ws;
		this.attachListeners(ws);
	}

	private attachListeners(ws: WebSocket): void {
		ws.on('open', () => {
			if (this.socket !== ws) return;
			this.setStatus('open');
			this.safeResubscribe();
			this.startResubTimer(ws);
			this.startStableTimer();
			this.resetIdleTimer(ws);
			this.settle();
		});

		ws.on('message', data => {
			if (this.socket !== ws) return;
			this.resetIdleTimer(ws);
			try {
				this.opts.onMessage(data);
			} catch (error) {
				this.notifyError(toError(error));
			}
		});

		ws.on('error', error => {
			if (this.socket !== ws) return;
			// `ws` always emits 'close' after 'error'. Only the close handler
			// schedules a reconnect — scheduling here double-reconnects.
			this.notifyError(error);
			this.settle(error);
		});

		ws.on('close', () => {
			if (this.socket !== ws) return;
			this.clearTimers();
			this.socket = undefined;
			this.setStatus('closed');
			const redacted = ManagedWebSocket.redactUrl(this.opts.url);
			this.settle(new Error(`WebSocket closed before opening: ${redacted}`));
			if (this.active) this.scheduleReconnect();
		});
	}

	private scheduleReconnect(): void {
		if (!this.active || this.retryTimer) return;
		// Exponential backoff (1s, 2s, 4s, ...), capped, multiplied by jitter
		// in [0.5, 1.0) — the standard "equal jitter".
		const cap = this.opts.maxBackoffMs ?? 30_000;
		const base = Math.min(cap, 1000 * 2 ** this.attempts);
		this.attempts += 1;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			if (this.active) this.open();
		}, base * (0.5 + Math.random() * 0.5));
		this.retryTimer.unref?.();
	}

	/**
	 * Retires the current socket. Graceful close first; force-terminate if
	 * the server doesn't close the handshake within `CLOSE_GRACE_MS`. Bounds
	 * `stop()` even against an unresponsive server.
	 */
	private teardown(reason: Error): void {
		this.clearTimers();
		const ws = this.socket;
		this.socket = undefined; // before close: see attachListeners

		if (ws) {
			try {
				ws.close();
			} catch {
				// terminating below
			}
			const killTimer = setTimeout(() => {
				try {
					ws.terminate();
				} catch {
					// already closed
				}
			}, ManagedWebSocket.CLOSE_GRACE_MS);
			killTimer.unref?.();
		}

		this.settle(reason);
	}

	// ─── Timers ─────────────────────────────────────────────────────────────

	private startResubTimer(ws: WebSocket): void {
		if (!this.opts.resubscribeIntervalMs) return;
		this.resubTimer = setInterval(() => {
			// Guard against the window where readyState is CLOSING but 'close'
			// hasn't fired.
			if (this.socket === ws && ws.readyState === WebSocket.OPEN) {
				this.safeResubscribe();
			}
		}, this.opts.resubscribeIntervalMs);
	}

	/**
	 * Resets `attempts` only after the connection has been stable for
	 * `STABLE_WINDOW_MS`. A server that accepts and immediately drops keeps
	 * growing the retry delay instead of being hammered.
	 */
	private startStableTimer(): void {
		clearTimeout(this.stableTimer);
		this.stableTimer = setTimeout(() => {
			this.stableTimer = undefined;
			this.attempts = 0;
		}, ManagedWebSocket.STABLE_WINDOW_MS);
		this.stableTimer.unref?.();
	}

	/**
	 * Restarts the idle watchdog. Fires when no message arrives within
	 * `idleTimeoutMs`, terminating the socket so the close handler reconnects.
	 */
	private resetIdleTimer(ws: WebSocket): void {
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		const timeout = this.opts.idleTimeoutMs;
		if (!timeout || timeout <= 0) return;
		this.idleTimer = setTimeout(() => {
			if (this.socket !== ws) return;
			try {
				ws.terminate();
			} catch {
				// already gone
			}
		}, timeout);
		this.idleTimer.unref?.();
	}

	private clearTimers(): void {
		clearInterval(this.resubTimer);
		clearTimeout(this.retryTimer);
		clearTimeout(this.stableTimer);
		clearTimeout(this.idleTimer);
		this.resubTimer = undefined;
		this.retryTimer = undefined;
		this.stableTimer = undefined;
		this.idleTimer = undefined;
	}

	// ─── Plumbing ───────────────────────────────────────────────────────────

	/** Settles the pending `connect()` at most once, with the error redacted. */
	private settle(error?: Error): void {
		const pending = this.pending;
		this.pending = undefined;
		if (!pending) return;
		if (error) pending.reject(ManagedWebSocket.redactError(error));
		else pending.resolve();
	}

	private safeResubscribe(): void {
		try {
			this.opts.resubscribe?.();
		} catch (error) {
			this.notifyError(toError(error));
		}
	}

	private notifyError(error: Error): void {
		safeCall(this.opts.onError, ManagedWebSocket.redactError(error));
	}

	private setStatus(next: ConnectionStatus): void {
		if (this.status === next) return;
		this.status = next;
		safeCall(this.opts.onStatusChange, next);
	}

	/** Strips the query string, so API tokens never land in error messages. */
	private static redactUrl(url: string): string {
		return url.split('?', 1)[0];
	}

	/**
	 * Removes query strings from any URL that appears in an error message.
	 * Applied to every error that reaches `onError` or rejects `connect()`.
	 */
	private static redactError(error: Error): Error {
		// `?` followed by anything up to whitespace or a quote is treated as
		// a query string and dropped.
		const message = error.message.replace(/\?[^\s"']*/g, '');
		return new Error(message);
	}
}