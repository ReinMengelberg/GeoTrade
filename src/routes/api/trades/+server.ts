import { error, json } from '@sveltejs/kit';
import type { NewTrade, Trade } from '$lib/types';
import type { RequestHandler } from './$types';

// In-memory placeholder until trades get a database table — resets on server
// restart and is shared between users.
let nextId = 3;
const trades: Trade[] = [
	{ id: 1, symbol: 'EUR/USD', quantity: 1000, price: 1.09 },
	{ id: 2, symbol: 'XAU/USD', quantity: 5, price: 2412.5 }
];

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	return json(trades);
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const input: NewTrade = await request.json();
	const trade: Trade = { id: nextId++, ...input };
	trades.push(trade);

	return json(trade, { status: 201 });
};
