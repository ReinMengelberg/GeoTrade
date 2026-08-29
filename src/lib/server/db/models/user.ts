import { eq } from 'drizzle-orm';
import { Model, randomId } from '../model';
import { user } from '../schema/user';

// Better Auth owns the write lifecycle for this table — sign-up hashes the
// password and creates the matching `account` row. Use `auth.api.*` for that,
// not `User.create`, or you will end up with a user that cannot sign in.
// This model is for everything else: lookups, profile updates, admin views.
class UserModel extends Model<typeof user, 'name' | 'email' | 'image'> {
	protected readonly table = user;

	// `emailVerified` is deliberately absent: it is exactly the field an
	// over-posted request body would want to set.
	protected readonly fillable = ['name', 'email', 'image'] as const;

	// Empty because every column on `user` already arrives correctly typed from
	// the schema — `email_verified` is a real boolean, the timestamps are Dates.
	protected readonly casts = {};

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
