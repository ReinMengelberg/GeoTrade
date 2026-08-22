// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { Session, User } from '$lib/server/auth';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			user: User | null;
			session: Session | null;
		}
		interface PageData {
			// Populated by routes whose layout load returns the user (currently (app)).
			user?: User | null;
		}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
