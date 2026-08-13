// import { building } from '$app/environment';
// import { auth } from '$lib/server/auth';
// import type { Handle } from '@sveltejs/kit';
// import { svelteKitHandler } from 'better-auth/svelte-kit';

// export const handle: Handle = async ({ event, resolve }) => {
// 	const session = await auth.api.getSession({ headers: event.request.headers });

// 	event.locals.user = session?.user ?? null;
// 	event.locals.session = session?.session ?? null;

// 	return svelteKitHandler({ auth, event, resolve, building });
// };

// temp code for testing
import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
    return resolve(event);
};