import { eq } from 'drizzle-orm';
import { user } from '../db/schema/user';
import { Model, type AssertTrue, type Equals, type Row } from './model';

/**
 * A row of the `user` table. Declared explicitly so it can be named in return
 * types and imported like any other domain type, rather than spelling out
 * `typeof user.$inferSelect` at every call site.
 *
 * Shares its name with the `User` model below on purpose: TypeScript keeps types
 * and values in separate namespaces, so `User` is the model in value position and
 * the row shape in type position.
 */
export interface User {
	id: string;
	name: string;
	email: string;
	emailVerified: boolean;
	image: string | null;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * Fails to compile if `User` and the `user` table ever drift apart — add a column
 * to the schema without adding it here and the build breaks instead of silently
 * handing back a row that does not match its declared type.
 */
export type UserMatchesSchema = AssertTrue<Equals<User, Row<typeof user>>>;

// Better Auth owns the write lifecycle for this table — sign-up hashes the
// password and creates the matching `account` row. Use `auth.api.*` for that,
// not `User.create`, or you will end up with a user that cannot sign in.
// This model is for everything else: lookups, profile updates, admin views.
class UserModel extends Model<typeof user, 'name' | 'email' | 'image', User> {
	protected readonly table = user;

	// `emailVerified` is deliberately absent: it is exactly the field an
	// over-posted request body would want to set.
	protected readonly fillable = ['name', 'email', 'image'] as const;

	findByEmail(email: string) {
		return this.first(eq(user.email, email));
	}

	// Self-service only for now — the `user` table has no `role` column yet, so
	// there is no admin override to check. Extend this once one lands.
	canAccess(requester: { id: string } | null, id: string): boolean {
		return requester?.id === id;
	}
}

export const User = new UserModel();
