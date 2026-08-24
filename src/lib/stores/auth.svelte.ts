import { goto, invalidateAll } from '$app/navigation';
import { page } from '$app/state';
import { createAuthClient } from 'better-auth/svelte';

const authClient = createAuthClient();

// Browser-only UI state; must never be written during SSR.
let pending = $state(false);

export const auth = {
	// Reads through to page.data on every access — never cache the user in
	// this module, or it would be shared across requests during SSR.
	get user() {
		return page.data.user ?? null;
	},

	get pending() {
		return pending;
	},

	async signIn(email: string, password: string) {
		pending = true;
		try {
			const { error } = await authClient.signIn.email({ email, password });
			if (error) return error;
			await invalidateAll();
			return null;
		} finally {
			pending = false;
		}
	},

	async signUp(name: string, email: string, password: string) {
		pending = true;
		try {
			const { error } = await authClient.signUp.email({ name, email, password });
			if (error) return error;
			await invalidateAll();
			return null;
		} finally {
			pending = false;
		}
	},

	async signOut() {
		await authClient.signOut();
		await invalidateAll();
		await goto('/login');
	}
};
