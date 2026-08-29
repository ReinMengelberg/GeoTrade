import { error, json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { user } from '$lib/server/db/schema';
import type { RequestHandler } from './$types';

// No role field on the user table yet, so only self-service is enforced here.
// Extend to `|| locals.user.role === 'admin'` once that lands.
function assertSelf(locals: App.Locals, id: string) {
	if (!locals.user) error(401, 'Unauthorized');
	if (locals.user.id !== id) error(403, 'Forbidden');
}

export const GET: RequestHandler = async ({ locals, params }) => {
	assertSelf(locals, params.id);

	const [found] = await db.select().from(user).where(eq(user.id, params.id));
	if (!found) error(404, 'User not found');

	return json(found);
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	assertSelf(locals, params.id);

	const input: { name?: string; email?: string } = await request.json();

	const [updated] = await db
		.update(user)
		.set({ ...input, updatedAt: new Date() })
		.where(eq(user.id, params.id))
		.returning();

	if (!updated) error(404, 'User not found');

	return json(updated);
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	assertSelf(locals, params.id);

	const [deleted] = await db.delete(user).where(eq(user.id, params.id)).returning();
	if (!deleted) error(404, 'User not found');

	return new Response(null, { status: 204 });
};
