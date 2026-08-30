import { error, json } from '@sveltejs/kit';
import { User } from '$lib/server/db/models';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!User.canAccess(locals.user, params.id)) error(403, 'Forbidden');

	const found = await User.find(params.id);
	if (!found) error(404, 'User not found');

	return json(found);
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!User.canAccess(locals.user, params.id)) error(403, 'Forbidden');

	const updated = await User.update(params.id, await request.json());
	if (!updated) error(404, 'User not found');

	return json(updated);
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!User.canAccess(locals.user, params.id)) error(403, 'Forbidden');

	const deleted = await User.destroy(params.id);
	if (!deleted) error(404, 'User not found');

	return new Response(null, { status: 204 });
};
