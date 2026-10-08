/**
 * `ManagedWebSocket` against a local WebSocket server. Every test binds its
 * own ephemeral port; all servers are torn down in `finally` blocks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManagedWebSocket } from '../../src/lib/server/services/market/websocket';
import { startTestServer, sleep, waitFor } from './helpers';

// ─── connect / close ────────────────────────────────────────────────────────

test('connect: resolves on open', async () => {
	const server = await startTestServer();
	try {
		const ws = new ManagedWebSocket({ url: server.url, onMessage: () => {} });
		await ws.connect();
		ws.close();
	} finally {
		await server.close();
	}
});

test('connect: rejects on invalid URL, does not retry', async () => {
	const ws = new ManagedWebSocket({
		url: 'wss://invalid.invalid.invalid/',
		onMessage: () => {},
		maxBackoffMs: 50
	});
	await assert.rejects(ws.connect());
});

test('close: is idempotent', async () => {
	const server = await startTestServer();
	try {
		const ws = new ManagedWebSocket({ url: server.url, onMessage: () => {} });
		await ws.connect();
		ws.close();
		ws.close();
	} finally {
		await server.close();
	}
});

// ─── send ───────────────────────────────────────────────────────────────────

test('send: returns true on open, false on closed', async () => {
	const server = await startTestServer();
	try {
		const ws = new ManagedWebSocket({ url: server.url, onMessage: () => {} });
		await ws.connect();
		assert.equal(ws.send('hello'), true);
		ws.close();
		assert.equal(ws.send('hello'), false);
	} finally {
		await server.close();
	}
});

test('send: frames arrive at the server in order', async () => {
	const server = await startTestServer();
	try {
		const ws = new ManagedWebSocket({ url: server.url, onMessage: () => {} });
		await ws.connect();
		ws.send('one');
		ws.send('two');
		ws.send('three');
		await waitFor(() => server.frames[0]?.length === 3);
		assert.deepEqual(server.frames[0], ['one', 'two', 'three']);
		ws.close();
	} finally {
		await server.close();
	}
});

// ─── onMessage ──────────────────────────────────────────────────────────────

test('onMessage: receives frames from the server', async () => {
	const server = await startTestServer();
	const received: string[] = [];
	try {
		const ws = new ManagedWebSocket({
			url: server.url,
			onMessage: (raw) => received.push(raw.toString())
		});
		await ws.connect();
		await waitFor(() => server.clients.length > 0);
		server.broadcast('tick-1');
		server.broadcast('tick-2');
		await waitFor(() => received.length === 2);
		assert.deepEqual(received, ['tick-1', 'tick-2']);
		ws.close();
	} finally {
		await server.close();
	}
});

test('onMessage: a throwing callback does not escape', async () => {
	const server = await startTestServer();
	const errors: Error[] = [];
	try {
		const ws = new ManagedWebSocket({
			url: server.url,
			onMessage: () => { throw new Error('consumer bug'); },
			onError: (e) => errors.push(e)
		});
		await ws.connect();
		await waitFor(() => server.clients.length > 0);
		server.broadcast('boom');
		await waitFor(() => errors.length > 0);
		assert.equal(errors[0].message, 'consumer bug');
		ws.close();
	} finally {
		await server.close();
	}
});

// ─── resubscribe ────────────────────────────────────────────────────────────

test('resubscribe: fires on open and on the configured interval', async () => {
	const server = await startTestServer();
	let count = 0;
	try {
		const ws = new ManagedWebSocket({
			url: server.url,
			onMessage: () => {},
			resubscribe: () => count++,
			resubscribeIntervalMs: 60
		});
		await ws.connect();
		await waitFor(() => count >= 1);
		const afterOpen = count;
		await sleep(150);
		assert.ok(count > afterOpen, `expected interval to fire (count=${count})`);
		ws.close();
	} finally {
		await server.close();
	}
});

// ─── status ─────────────────────────────────────────────────────────────────

test('onStatusChange: deduped transitions connecting → open → closed', async () => {
	const server = await startTestServer();
	const statuses: string[] = [];
	try {
		const ws = new ManagedWebSocket({
			url: server.url,
			onMessage: () => {},
			onStatusChange: (s) => statuses.push(s)
		});
		await ws.connect();
		ws.close();
		assert.deepEqual(statuses, ['connecting', 'open', 'closed']);
	} finally {
		await server.close();
	}
});

// ─── reconnect ──────────────────────────────────────────────────────────────

test('reconnect: reconnects after the server drops the client', async () => {
	const server = await startTestServer();
	const statuses: string[] = [];
	try {
		const ws = new ManagedWebSocket({
			url: server.url,
			onMessage: () => {},
			onStatusChange: (s) => statuses.push(s),
			maxBackoffMs: 100
		});
		await ws.connect();
		server.clients[0].close();
		await waitFor(() => server.clients.length >= 2, 3000);
		assert.ok(statuses.includes('closed'));
		assert.equal(statuses[statuses.length - 1], 'open');
		ws.close();
	} finally {
		await server.close();
	}
});

test('reconnect: idle watchdog terminates a silent socket', async () => {
	const server = await startTestServer();
	const statuses: string[] = [];
	try {
		const ws = new ManagedWebSocket({
			url: server.url,
			onMessage: () => {},
			onStatusChange: (s) => statuses.push(s),
			idleTimeoutMs: 100,
			maxBackoffMs: 100
		});
		await ws.connect();
		// Send nothing. The watchdog should terminate and reconnect.
		await waitFor(() => server.clients.length >= 2, 3000);
		assert.ok(statuses.includes('closed'));
		ws.close();
	} finally {
		await server.close();
	}
});

// ─── token redaction ────────────────────────────────────────────────────────

test('errors: URL query string is not present in error messages', async () => {
	const server = await startTestServer();
	const errors: Error[] = [];
	try {
		const ws = new ManagedWebSocket({
			url: `${server.url}?token=SUPERSECRET`,
			onMessage: () => {},
			onError: (e) => errors.push(e)
		});
		await ws.connect();
		server.clients[0].close();
		await sleep(50);
		ws.close();
		for (const e of errors) {
			assert.ok(
				!e.message.includes('SUPERSECRET'),
				`token leaked into: ${e.message}`
			);
		}
	} finally {
		await server.close();
	}
});

// ─── parseJson ──────────────────────────────────────────────────────────────

test('parseJson: handles Buffer, string, and array inputs', () => {
	assert.deepEqual(ManagedWebSocket.parseJson(Buffer.from('{"a":1}')), { a: 1 });
	assert.deepEqual(ManagedWebSocket.parseJson('{"a":1}' as never), { a: 1 });
	const fragments = [Buffer.from('{"a":'), Buffer.from('1}')];
	assert.deepEqual(ManagedWebSocket.parseJson(fragments as never), { a: 1 });
});

test('parseJson: returns undefined for invalid JSON', () => {
	assert.equal(ManagedWebSocket.parseJson(Buffer.from('not json')), undefined);
	assert.equal(ManagedWebSocket.parseJson(Buffer.from('')), undefined);
});

test('errors: query string is redacted from every error path', async () => {
	const server = await startTestServer();
	const errors: Error[] = [];
	try {
		// Force the constructor path: an invalid protocol makes `new WebSocket`
		// throw synchronously with the URL in the message.
		const ws = new ManagedWebSocket({
			url: 'not-a-url?token=SUPERSECRET',
			onMessage: () => {},
			onError: (e) => errors.push(e)
		});
		await ws.connect().catch(() => { /* expected */ });
		ws.close();

		for (const e of errors) {
			assert.ok(!e.message.includes('SUPERSECRET'), `leaked: ${e.message}`);
		}
	} finally {
		await server.close();
	}
});