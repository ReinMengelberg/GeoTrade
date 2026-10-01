import WebSocket from 'ws';

export type WsStatus = 'connecting' | 'open' | 'closed';

export interface ManagedWsOptions {
	/** WebSocket endpoint (ws:// or wss://). */
	url: string;
	/** Called for every incoming frame. Exceptions are routed to `onError`. */
	onMessage: (data: WebSocket.RawData) => void;
	/** Called on every (re)open, and periodically if `resubscribeIntervalMs` is set. */
	resubscribe?: (ws: WebSocket) => void;
	/** If > 0, calls `resubscribe` on this interval while the socket is open. */
	resubscribeIntervalMs?: number;
	/**
	 * If > 0, terminate the socket when no message arrives within this window.
	 * Recovers from connections that die without a TCP close (NAT timeout,
	 * Wi-Fi drop). Off by default — set generously for feeds that go quiet
	 * legitimately (equities outside market hours).
	 */
	idleTimeoutMs?: number;
	/** Fires only on real transitions, never twice in a row with the same value. */
	onStatusChange?: (status: WsStatus) => void;
	/** Sink for socket errors and consumer-callback exceptions. Never throws asynchronously. */
	onError?: (error: Error) => void;
	/** Upper bound for the reconnect delay. Default: 30 000 ms. */
	maxBackoffMs?: number;
}

/**
 * A single WebSocket connection with automatic reconnection.
 *
 * Lifecycle:
 *   - `connect()` resolves on the first successful open and rejects if that first
 *     attempt fails (or if `close()` / another `connect()` interrupts it).
 *     After a failed first attempt, retries continue in the background until
 *     `close()` is called.
 *   - `close()` is final until the next `connect()`.
 *
 * Behavioural guarantees:
 *   1. At most one live socket. A second `connect()` retires the previous one.
 *   2. The `connect()` promise settles exactly once per call.
 *   3. Consumer callbacks (`onMessage`, `resubscribe`) may throw; the class survives.
 *   4. Stale sockets cannot fire handlers — identity-checked on every event.
 *   5. `onStatusChange` fires only on real transitions.
 *   6. Reconnection is scheduled from exactly one place: the `close` handler.
 *   7. An invalid URL is fatal: `active` is cleared, the promise rejects, no retry.
 *   8. `send()` never throws. Returns false when the socket isn't open.
 *   9. Query strings in URLs (which carry API tokens) never appear in error messages.
 *  10. The backoff counter resets only after the connection has been stable for
 *      a while — a flapping server keeps growing the delay instead of hammering.
 *  11. Teardown force-terminates a socket that doesn't close promptly.
 */
export class ManagedWebSocket {
	/** How long a connection must stay up before the backoff counter is forgiven. */
	private static readonly STABLE_WINDOW_MS = 30_000;
	/** How long `teardown()` waits for a graceful close before force-terminating. */
	private static readonly CLOSE_GRACE_MS = 2_000;

	private readonly opts: ManagedWsOptions;
	private socket?: WebSocket;
	private status: WsStatus = 'closed';
	private active = false;
	private attempts = 0;
	private retryTimer?: NodeJS.Timeout;
	private resubTimer?: NodeJS.Timeout;
	private stableTimer?: NodeJS.Timeout;
	private idleTimer?: NodeJS.Timeout;
	private pending?: { resolve: () => void; reject: (error: Error) => void };

	constructor(opts: ManagedWsOptions) {
		this.opts = opts;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Public API
	// ─────────────────────────────────────────────────────────────────────────

	connect(): Promise<void> {
		this.teardown(new Error('connect() superseded by a new call'));
		this.active = true;
		this.attempts = 0;
		return new Promise<void>((resolve, reject) => {
			this.pending = { resolve, reject };
			this.open();
		});
	}

	close(): void {
		this.active = false;
		this.teardown(new Error('close() called by user'));
		this.setStatus('closed');
	}

	/**
	 * Sends one frame on the open socket. Returns false (never throws) if the
	 * socket isn't open; the frame is dropped, not queued. The `resubscribe`
	 * callback on the next open is expected to restore whatever state was lost.
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

	// ─────────────────────────────────────────────────────────────────────────
	// Connection lifecycle
	// ─────────────────────────────────────────────────────────────────────────

	private open(): void {
		if (!this.active) return;
		this.setStatus('connecting');

		let ws: WebSocket;
		try {
			ws = new WebSocket(this.opts.url);
		} catch (error) {
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
			this.safeResubscribe(ws);
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
		const cap = this.opts.maxBackoffMs ?? 30_000;
		const base = Math.min(cap, 1000 * 2 ** this.attempts);
		this.attempts += 1;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			if (this.active) this.open();
		}, base * (0.5 + Math.random() * 0.5));
	}

	/**
	 * Retires the current socket. Graceful close first; force-terminate if the
	 * server doesn't close the handshake within CLOSE_GRACE_MS. This makes
	 * `stop()` bounded even against an unresponsive server.
	 */
	private teardown(reason: Error): void {
		this.clearTimers();
		const ws = this.socket;
		this.socket = undefined;

		if (ws) {
			try {
				ws.close();
			} catch {
				// ignore — we're terminating below
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

	// ─────────────────────────────────────────────────────────────────────────
	// Timers
	// ─────────────────────────────────────────────────────────────────────────

	private startResubTimer(ws: WebSocket): void {
		if (!this.opts.resubscribeIntervalMs) return;
		this.resubTimer = setInterval(() => {
			if (this.socket === ws && ws.readyState === WebSocket.OPEN) {
				this.safeResubscribe(ws);
			}
		}, this.opts.resubscribeIntervalMs);
	}

	/**
	 * Resets the backoff counter only after the connection has been stable for
	 * STABLE_WINDOW_MS. A server that accepts and immediately drops therefore
	 * keeps growing the retry delay instead of being hammered once per second.
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
	 * Restarts the idle watchdog. Fires when no message has arrived within
	 * `idleTimeoutMs`, terminating the socket so the close handler can reconnect.
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

	// ─────────────────────────────────────────────────────────────────────────
	// connect() promise plumbing
	// ─────────────────────────────────────────────────────────────────────────

	private settle(error?: Error): void {
		const pending = this.pending;
		this.pending = undefined;
		if (!pending) return;
		if (error) pending.reject(error);
		else pending.resolve();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Safe invocation of consumer callbacks
	// ─────────────────────────────────────────────────────────────────────────

	private safeResubscribe(ws: WebSocket): void {
		try {
			this.opts.resubscribe?.(ws);
		} catch (error) {
			this.notifyError(toError(error));
		}
	}

	private notifyError(error: Error): void {
		this.opts.onError?.(error);
	}

	private setStatus(next: WsStatus): void {
		if (this.status === next) return;
		this.status = next;
		this.opts.onStatusChange?.(next);
	}

	/** Strips the query string, so API tokens never land in error messages. */
	private static redactUrl(url: string): string {
		const q = url.indexOf('?');
		return q >= 0 ? url.slice(0, q) : url;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level helpers
// ─────────────────────────────────────────────────────────────────────────────

const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));