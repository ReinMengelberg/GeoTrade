import { eq } from 'drizzle-orm';
import { Model, randomId, type AssertTrue, type Equals, type Row } from '../model';
import { user } from '../schema/user';

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

	// `user.id` is a text primary key with no database default — Better Auth
	// assigns it in application code, so this model must too.
	protected override generateId() {
		return randomId();
	}

	findByEmail(email: string) {
		return this.first(eq(user.email, email));
	}
}

export const User = new UserModel();
